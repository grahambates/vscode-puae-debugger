import { SourceMap } from "./sourceMap";
import { buildUnwindTable } from "./unwindTable";
import {
  ProfileFrame,
  CallTreeNode,
  ProfileResult,
  IProfileModel,
  IComputedNode,
  ILocation,
  Category,
} from "./shared/profilerTypes";

export type { ProfileFrame, CallTreeNode, ProfileResult, IProfileModel };

// Minimal RPC surface (VAmiga.sendRpcCommand) — kept as an interface so the manager
// is unit-testable with a mock and doesn't pull in the whole VAmiga/webview module.
export interface ProfilerRpcClient {
  sendRpcCommand<T = unknown, A = unknown>(command: string, args?: A, timeoutMs?: number): Promise<T>;
}

// One captured instruction: the reconstructed call stack (leaf-first, as the
// emulator emits it) and the cycles attributed to that instruction.
export interface InstructionSample {
  stack: number[]; // absolute PCs, innermost (leaf) first
  cycles: number;
}

// Hard cap mirroring the emulator's kMaxDepth; guards against a corrupt stream.
const MAX_DEPTH = 64;

// Decode the flat u32 stream the emulator produces. Record layout, repeated:
//   [depth, pc0, pc1, ... pc(depth-1), cycleDelta]
// pc0 is the leaf. Returns one InstructionSample per record; stops cleanly on a
// truncated/!plausible record rather than throwing.
export function decodeProfileStream(words: Uint32Array): InstructionSample[] {
  const samples: InstructionSample[] = [];
  let i = 0;
  while (i < words.length) {
    const depth = words[i++];
    if (depth === 0 || depth > MAX_DEPTH) break; // implausible -> stop
    if (i + depth + 1 > words.length) break; // truncated -> stop
    const stack: number[] = [];
    for (let d = 0; d < depth; d++) stack.push(words[i++]);
    const cycles = words[i++];
    samples.push({ stack, cycles });
  }
  return samples;
}

// Symbolicate a PC into a ProfileFrame using the DWARF/symbol source map. Function
// name comes from the nearest preceding symbol; file/line from the line table.
function symbolicate(pc: number, sourceMap: SourceMap): ProfileFrame {
  const sym = sourceMap.findSymbolOffset(pc);
  const loc = sourceMap.lookupAddress(pc);
  return {
    func: sym ? sym.symbol : `0x${pc.toString(16)}`,
    file: loc?.path,
    line: loc?.line,
    address: pc,
  };
}

// Aggregate per-instruction samples into a call tree. Each distinct PC is
// symbolicated exactly once (memoized) and interned into uniqueFrames; tree nodes
// reference frames by index. Stacks are walked root-first (outermost -> leaf), so
// the synthetic root's children are the top-level functions.
export function buildCallTree(samples: InstructionSample[], sourceMap: SourceMap): ProfileResult {
  const uniqueFrames: ProfileFrame[] = [];
  const frameIndexByPc = new Map<number, number>();
  const internFrame = (pc: number): number => {
    let idx = frameIndexByPc.get(pc);
    if (idx === undefined) {
      idx = uniqueFrames.length;
      uniqueFrames.push(symbolicate(pc, sourceMap));
      frameIndexByPc.set(pc, idx);
    }
    return idx;
  };

  const root: CallTreeNode = { frame: -1, self: 0, total: 0, children: [] };
  // Per-node child lookup keyed by frame index — keeps tree building near-linear
  // instead of O(children) per step.
  const childMaps = new WeakMap<CallTreeNode, Map<number, CallTreeNode>>();
  const childOf = (node: CallTreeNode, frame: number): CallTreeNode => {
    let map = childMaps.get(node);
    if (!map) { map = new Map(); childMaps.set(node, map); }
    let child = map.get(frame);
    if (!child) {
      child = { frame, self: 0, total: 0, children: [] };
      map.set(frame, child);
      node.children.push(child);
    }
    return child;
  };

  let totalCycles = 0;
  for (const s of samples) {
    totalCycles += s.cycles;
    root.total += s.cycles;
    let node = root;
    for (let i = s.stack.length - 1; i >= 0; i--) {
      node = childOf(node, internFrame(s.stack[i]));
      node.total += s.cycles;
    }
    node.self += s.cycles; // leaf accrues self time
  }

  return { uniqueFrames, root, totalCycles, sampleCount: samples.length };
}

// Build the time-ordered IProfileModel the flame chart renders, from the per-
// instruction samples. Ports the structure of the old vscode-amiga-debug
// `buildModel` but sources it from our stacks instead of a CDP profile:
//   - locations[] interned per PC (symbolicated once),
//   - nodes[] a call tree (synthetic root = node 0, real frames hang below it),
//   - samples[] the leaf node id per instruction in execution order (samples[0] is
//     a dummy paired with timeDeltas — matches the offset buildColumns expects),
//   - timeDeltas[] the per-instruction cycle cost; duration = total cycles.
export function buildProfileModel(samples: InstructionSample[], sourceMap: SourceMap, cyclesPerMicroSecond = 7.09379): IProfileModel {
  const locations: ILocation[] = [];
  const locByPc = new Map<number, number>();
  // Key: "functionName:url" — all instructions within the same function share one location.
  // This matches the V8/CDP convention where callFrame.lineNumber = function declaration line,
  // not the current instruction's source line.
  const locByFunc = new Map<string, number>();

  // Synthetic root location (node 0). Never rendered — buildColumns stops before it.
  locations.push({
    id: 0,
    selfTime: 0,
    aggregateTime: 0,
    ticks: 0,
    category: Category.System,
    callFrame: { functionName: "(all)", url: "", scriptId: "root", lineNumber: -1, columnNumber: 0 },
    address: 0,
  });

  const internLocation = (pc: number): number => {
    let idx = locByPc.get(pc);
    if (idx === undefined) {
      const f = symbolicate(pc, sourceMap);
      const funcKey = `${f.func}:${f.file ?? ""}`;
      idx = locByFunc.get(funcKey);
      if (idx === undefined) {
        idx = locations.length;
        locations.push({
          id: idx,
          selfTime: 0,
          aggregateTime: 0,
          ticks: 0,
          // No source file ⇒ treat as system/OS (renders gray); program code is User.
          category: f.file ? Category.User : Category.System,
          callFrame: {
            functionName: f.func,
            url: f.file ?? "",
            scriptId: "0",
            lineNumber: f.line !== undefined ? f.line : -1,
            columnNumber: 0,
          },
          address: pc,
        });
        locByFunc.set(funcKey, idx);
      }
      locByPc.set(pc, idx);
    }
    return idx;
  };

  // Call tree: synthetic root node 0, then a child per distinct (parent, location).
  const nodes: IComputedNode[] = [
    { id: 0, selfTime: 0, aggregateTime: 0, children: [], locationId: 0 },
  ];
  const childByNode = new Map<number, Map<number, number>>();
  const childNode = (parentId: number, locId: number): number => {
    let m = childByNode.get(parentId);
    if (!m) { m = new Map(); childByNode.set(parentId, m); }
    let cid = m.get(locId);
    if (cid === undefined) {
      cid = nodes.length;
      nodes.push({ id: cid, selfTime: 0, aggregateTime: 0, children: [], parent: parentId, locationId: locId });
      nodes[parentId].children.push(cid);
      m.set(locId, cid);
    }
    return cid;
  };

  const sampleIds: number[] = [0]; // samples[0] dummy; pairs with timeDeltas[i-1]
  const timeDeltas: number[] = [];
  let duration = 0;
  for (const s of samples) {
    // Stacks are leaf-first; descend outermost→leaf so the path hangs off the root.
    let nodeId = 0;
    for (let i = s.stack.length - 1; i >= 0; i--) {
      nodeId = childNode(nodeId, internLocation(s.stack[i]));
    }
    nodes[nodeId].selfTime += s.cycles;
    sampleIds.push(nodeId);
    timeDeltas.push(s.cycles);
    duration += s.cycles;
  }

  // Aggregate (inclusive) time per node, folded back into the shared locations.
  const computeAgg = (id: number): number => {
    const n = nodes[id];
    if (n.aggregateTime) return n.aggregateTime;
    let total = n.selfTime;
    for (const c of n.children) total += computeAgg(c);
    return (n.aggregateTime = total);
  };
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const loc = locations[n.locationId];
    loc.aggregateTime += computeAgg(i);
    loc.selfTime += n.selfTime;
  }

  return {
    nodes,
    locations,
    samples: sampleIds,
    timeDeltas,
    duration,
    cyclesPerMicroSecond,
  };
}

// Orchestrates a capture: upload the unwind table, run the profiled frame(s),
// read back the binary stream, decode + aggregate into a call tree. All heavy
// work (symbolication, aggregation) happens here, once, so the webview only ever
// receives the compact tree.
export class ProfilerManager {
  constructor(
    private readonly rpc: ProfilerRpcClient,
    private readonly getSourceMap: () => SourceMap | undefined,
  ) {}

  // Per-instruction samples from the last capture, retained as a first-class
  // artifact for the later coverage / disassembly-tracing phases (they need
  // per-instruction PC+cycle data, not just the aggregated chart).
  private lastSamples: InstructionSample[] = [];
  public getSamples(): readonly InstructionSample[] {
    return this.lastSamples;
  }

  public async capture(numFrames = 1): Promise<IProfileModel> {
    const sourceMap = this.getSourceMap();
    if (!sourceMap) throw new Error("Profiler: no source map (is a program loaded with DWARF info?)");

    const rows = sourceMap.getUnwindRows();
    const table = buildUnwindTable(rows);
    if (!table) throw new Error("Profiler: no DWARF .debug_frame unwind info for this program");

    await this.rpc.sendRpcCommand("profileSetUnwind", {
      data: table.buffer,
      startAddr: table.startAddr,
      endAddr: table.endAddr,
    });

    // Capture runs N frames synchronously in the emulator; allow generous time.
    await this.rpc.sendRpcCommand("startProfiling", { numFrames }, 30000);

    const res = await this.rpc.sendRpcCommand<{
      data: Uint8Array;
      start: number;
      end: number;
      total: number;
      inRange: number;
      frameCycles?: number; // CPU-clock cycles in the profiled frame (for time units)
      isPAL?: boolean;      // true = PAL (50 Hz), false = NTSC (60 Hz)
    }>("getProfileData");
    const bytes = res.data instanceof Uint8Array ? res.data : new Uint8Array(res.data);
    const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 2);

    const samples = decodeProfileStream(words);
    this.lastSamples = samples;
    console.log(
      `[profiler] captured: total=${res.total} instr, inRange=${res.inRange}, ` +
        `samples=${samples.length}, range=[0x${(res.start >>> 0).toString(16)},0x${(res.end >>> 0).toString(16)})`,
    );
    if (samples.length === 0) {
      const range = `[0x${(res.start >>> 0).toString(16)}, 0x${(res.end >>> 0).toString(16)})`;
      const hint =
        res.total === 0
          ? "The emulator executed no instructions in the captured frame."
          : res.inRange === 0
            ? `None of the ${res.total} executed instructions were inside your program ${range} — it may be idle/finished or running OS code. Try capturing while the program is actively running.`
            : "Instructions ran in range but produced no stack samples (unwind issue).";
      throw new Error(`No profile samples captured. ${hint}`);
    }

    // Derive the CPU clock from the emulator's measured frame cycles and PAL/NTSC flag.
    // PAL = 50 Hz (20000 µs/frame), NTSC = 60 Hz (16666.67 µs/frame). Falls back to
    // the standard PAL 68000 constant if the emulator doesn't report a frame length.
    const isPAL = res.isPAL ?? true;
    const frameUs = isPAL ? 20000 : 1_000_000 / 60;
    const cyclesPerMicroSecond = res.frameCycles ? res.frameCycles / frameUs : 7.09379;

    const model = buildProfileModel(samples, sourceMap, cyclesPerMicroSecond);
    console.log(
      `[profiler] model: ${model.locations.length} locations, ${model.nodes.length} nodes, ` +
        `${model.samples.length - 1} samples, ${model.duration} captured cycles` +
        (res.frameCycles ? ` (frame=${res.frameCycles} cy, ${cyclesPerMicroSecond.toFixed(4)} cy/µs, ${isPAL ? "PAL" : "NTSC"})` : ""),
    );
    return model;
  }
}
