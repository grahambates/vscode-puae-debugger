import { SourceMap } from "./sourceMap";
import { buildUnwindTable } from "./unwindTable";
import {
  ProfileFrame,
  CallTreeNode,
  ProfileResult,
  IProfileModel,
  IComputedNode,
  ILocation,
  ISymbol,
  Category,
} from "./shared/profilerTypes";
import { decodeDmaGrid } from "./dma";

export type { ProfileFrame, CallTreeNode, ProfileResult, IProfileModel };

// Flatten the source map's symbols into the address-sorted {address,name,size} list the
// webview symbolizer consumes. Sizes come from getSymbolLengths (clamped to segment end).
function buildSymbolList(sourceMap: SourceMap): ISymbol[] {
  const addrs = sourceMap.getSymbols(); // name -> address
  const sizes = sourceMap.getSymbolLengths() ?? {}; // name -> size
  const out: ISymbol[] = [];
  for (const name in addrs) {
    out.push({ address: addrs[name], name, size: sizes[name] ?? 0 });
  }
  out.sort((a, b) => a.address - b.address);
  return out;
}

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

// Expand a PC into its logical call frames, outermost-first: the physical (concrete)
// function that contains the code, followed by one frame per inlined function (DWARF
// DW_TAG_inlined_subroutine). Inlined functions have no runtime stack frame, so the
// unwinder never sees them — they only exist in the line/inline tables and must be
// reconstructed here, or the flame graph/time view shows the caller and silently
// skips every inlined callee.
//
// Line attribution follows addr2line --inlines (and the old vscode-amiga-debug): each
// frame is shown at the *call site* of the next-inner frame (the line where the inline
// call appears in the caller), and only the innermost frame gets the instruction's own
// source line. `getInlineFramesForPc` returns frames innermost-first.
function expandPc(pc: number, sourceMap: SourceMap): ProfileFrame[] {
  const sym = sourceMap.findSymbolOffset(pc);
  const loc = sourceMap.lookupAddress(pc);
  const funcName = sym ? sym.symbol : `0x${pc.toString(16)}`;
  const inlines = sourceMap.getInlineFramesForPc?.(pc) ?? []; // innermost-first
  if (inlines.length === 0) {
    return [{ func: funcName, file: loc?.path, line: loc?.line, address: pc }];
  }
  const n = inlines.length;
  // Inlined frames are suffixed " (inlined)" (matching the old vscode-amiga-debug) so the
  // flame graph / time view distinguish them from the physical function they live in.
  const frames: ProfileFrame[] = [
    // Physical function: rendered at the line where the outermost inline was called.
    { func: funcName, file: inlines[n - 1].callPath || undefined, line: inlines[n - 1].callLine || undefined, address: pc },
  ];
  // Each inline (outer→inner) is shown at the call site of the next-inner inline...
  for (let k = n - 1; k >= 1; k--) {
    frames.push({ func: inlines[k].name + " (inlined)", file: inlines[k - 1].callPath || undefined, line: inlines[k - 1].callLine || undefined, address: pc });
  }
  // ...and the innermost inline gets the instruction's own source location.
  frames.push({ func: inlines[0].name + " (inlined)", file: loc?.path, line: loc?.line, address: pc });
  return frames;
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

  const internLocation = (f: ProfileFrame): number => {
    const funcKey = `${f.func}:${f.file ?? ""}`;
    let idx = locByFunc.get(funcKey);
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
        address: f.address,
      });
      locByFunc.set(funcKey, idx);
    }
    return idx;
  };

  // Expand each PC into its logical frames (physical + inlines) once, caching the
  // resulting location-id chain (outermost→innermost) so hot PCs aren't re-symbolicated.
  const locIdsByPc = new Map<number, number[]>();
  const locIdsFor = (pc: number): number[] => {
    let ids = locIdsByPc.get(pc);
    if (!ids) {
      ids = expandPc(pc, sourceMap).map(internLocation);
      locIdsByPc.set(pc, ids);
    }
    return ids;
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
    // Each physical PC expands to physical + inlined frames (outermost→innermost), so
    // inlined callees appear as their own boxes stacked above the caller.
    let nodeId = 0;
    for (let i = s.stack.length - 1; i >= 0; i--) {
      for (const locId of locIdsFor(s.stack[i])) {
        nodeId = childNode(nodeId, locId);
      }
    }
    nodes[nodeId].selfTime += s.cycles; // innermost (inlined) frame accrues self time
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

// The raw, serializable result of one capture — everything the post-emulator pipeline
// consumes, before any decoding or symbolication. This is the seam shared by live capture
// and a loaded .vamigaprofile: both produce a RawCapture, then buildModelFromCapture turns
// it into the IProfileModel. Kept to plain typed arrays + scalars so it serializes directly.
export interface RawCapture {
  profile: {
    data: Uint8Array; // the raw [depth,…pcs,cycles] stream from wasm_profile_get_data
    start: number;
    end: number;
    total: number;
    inRange: number;
    frameCycles: number; // CPU-clock cycles in the profiled frame (0 = emulator didn't report)
    isPAL: boolean; // normalized at the RPC boundary (defaults true)
  };
  dma?: Uint8Array; // raw enriched DMA grid bytes (absent if DMA capture produced nothing)
  snapshot?: { chip: Uint8Array; slow: Uint8Array }; // reconstruction baseline
}

// Pure transform: RawCapture + SourceMap → IProfileModel (+ the decoded samples, retained
// as a first-class artifact). No I/O, no emulator — the single model-building path for both
// live captures and loaded .vamigaprofile files, and the unit-test entry point. An empty
// capture yields an empty model here; the live "nothing captured" diagnostic lives in
// ProfilerManager.capture() where the emulator-state hint makes sense.
export function buildModelFromCapture(
  raw: RawCapture,
  sourceMap: SourceMap,
): { model: IProfileModel; samples: InstructionSample[] } {
  const pb = raw.profile;
  const words = new Uint32Array(pb.data.buffer, pb.data.byteOffset, pb.data.byteLength >>> 2);
  const samples = decodeProfileStream(words);

  // Derive the CPU clock from the measured frame cycles + PAL/NTSC (PAL = 50 Hz/20000 µs,
  // NTSC = 60 Hz). frameCycles == 0 means the emulator didn't report one → standard PAL constant.
  const frameUs = pb.isPAL ? 20000 : 1_000_000 / 60;
  const cyclesPerMicroSecond = pb.frameCycles > 0 ? pb.frameCycles / frameUs : 7.09379;

  const model = buildProfileModel(samples, sourceMap, cyclesPerMicroSecond);
  model.symbols = buildSymbolList(sourceMap);

  if (raw.dma) {
    const dma = decodeDmaGrid(raw.dma);
    if (dma) {
      model.dma = dma;
      if (raw.snapshot) {
        model.dmaSnapshot = { chip: raw.snapshot.chip, slow: raw.snapshot.slow };
      }
    }
  }
  return { model, samples };
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

  // Raw bytes of the last capture, retained so the webview "Save" button can serialize it
  // to a .vamigaprofile without re-running the emulator.
  private lastRaw?: RawCapture;
  public getLastRaw(): RawCapture | undefined {
    return this.lastRaw;
  }

  public async capture(numFrames = 1): Promise<IProfileModel> {
    const sourceMap = this.getSourceMap();
    if (!sourceMap) throw new Error("Profiler: no source map (is a program loaded with DWARF info?)");

    const rows = sourceMap.getUnwindRows();
    const table = buildUnwindTable(rows);
    if (table) {
      // C/C++ with DWARF .debug_frame: the emulator unwinds A5/A7 with this table.
      await this.rpc.sendRpcCommand("profileSetUnwind", {
        data: table.buffer,
        startAddr: table.startAddr,
        endAddr: table.endAddr,
      });
    } else {
      // Assembly / hunk with no DWARF: upload an EMPTY table (which makes the emulator
      // fall back to runtime branch-stack unwinding — JSR/BSR/RTS/RTE tracking) plus the
      // code range, derived from the loaded CODE segment(s), for the in-range sample gate
      // and the branch-stack seeding scan. Segment names are like "0: CODE CHIP".
      const segs = sourceMap.getSegmentsInfo();
      const code = segs.filter((s) => /code/i.test(s.name));
      const ranges = code.length ? code : segs.slice(0, 1);
      if (ranges.length === 0) throw new Error("Profiler: no loaded code segment");
      const startAddr = Math.min(...ranges.map((s) => s.address));
      const endAddr = Math.max(...ranges.map((s) => s.address + s.size));
      await this.rpc.sendRpcCommand("profileSetUnwind", {
        data: new Uint8Array(0),
        startAddr,
        endAddr,
      });
    }

    // Capture runs N frames synchronously in the emulator; allow generous time.
    await this.rpc.sendRpcCommand("startProfiling", { numFrames }, 30000);

    const u8 = (d: unknown): Uint8Array => (d instanceof Uint8Array ? d : new Uint8Array((d as ArrayLike<number>) ?? 0));

    const res = await this.rpc.sendRpcCommand<{
      data: Uint8Array;
      start: number;
      end: number;
      total: number;
      inRange: number;
      frameCycles?: number;
      isPAL?: boolean;
    }>("getProfileData");

    const raw: RawCapture = {
      profile: {
        data: u8(res.data),
        start: res.start,
        end: res.end,
        total: res.total,
        inRange: res.inRange,
        frameCycles: res.frameCycles ?? 0, // normalize the optional RPC fields here, once
        isPAL: res.isPAL ?? true,
      },
    };

    // Fetch the DMA grid (captured in the same frame) + the reconstruction snapshot into the
    // RawCapture. Failure here must not break the CPU profile, so it's best-effort.
    try {
      const dmaRes = await this.rpc.sendRpcCommand<{ data: Uint8Array }>("getDmaData");
      const dmaBytes = u8(dmaRes.data);
      if (dmaBytes.length) {
        raw.dma = dmaBytes;
        const snap = await this.rpc.sendRpcCommand<{ chip: Uint8Array; slow: Uint8Array }>("getDmaSnapshot");
        raw.snapshot = { chip: u8(snap.chip), slow: u8(snap.slow) };
      }
    } catch (e) {
      console.warn("[profiler] DMA capture failed (CPU profile unaffected):", e);
    }

    const { model, samples } = buildModelFromCapture(raw, sourceMap);

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

    this.lastSamples = samples;
    this.lastRaw = raw;

    if (model.dma) {
      const writes = model.dma.flags.reduce((n, f) => n + (f & 1), 0);
      console.log(
        `[profiler] dma: ${model.dma.owner.length} slots, ${writes} writes, ` +
          `snapshot chip=${model.dmaSnapshot?.chip.length ?? 0}B slow=${model.dmaSnapshot?.slow.length ?? 0}B`,
      );
    }
    console.log(
      `[profiler] model: ${model.locations.length} locations, ${model.nodes.length} nodes, ` +
        `${model.samples.length - 1} samples, ${model.duration} captured cycles` +
        (raw.profile.frameCycles ? ` (frame=${raw.profile.frameCycles} cy, ${model.cyclesPerMicroSecond.toFixed(4)} cy/µs, ${raw.profile.isPAL ? "PAL" : "NTSC"})` : ""),
    );
    return model;
  }
}
