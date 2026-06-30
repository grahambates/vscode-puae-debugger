import { SourceMap } from "./sourceMap";
import { buildUnwindTable } from "./unwindTable";
import {
  ProfileFrame,
  IProfileModel,
  IComputedNode,
  ILocation,
  ISymbol,
  Category,
} from "./shared/profilerTypes";
import { decodeDmaGrid, decodeCustomRegs, decodeCopperRecords, decodeDmaEvents } from "./dma";

export type { ProfileFrame, IProfileModel };

// Flatten the source map's symbols into the address-sorted {address,name,size} list the
// webview symbolizer consumes. Sizes come from getSymbolLengths (clamped to segment end).
// excludeLocal=true so this agrees with the flame graph's function attribution (symbolicate/
// expandPc also pass excludeLocal=true) — otherwise a vasm local label (e.g. a macro's `.\@`
// branch target) would split a routine's symbol-list entry at the label instead of the
// webview resolving addresses past it back to the enclosing routine.
function buildSymbolList(sourceMap: SourceMap): ISymbol[] {
  const addrs = sourceMap.getSymbols(true); // name -> address
  const sizes = sourceMap.getSymbolLengths(true) ?? {}; // name -> size
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

// Synthetic leaf-PC marker the emulator emits for an [IRQ] sample (the interrupt/
// exception dispatch "gap"). MUST match IRQ_MARKER in
// vamigaweb_fork/Core/Profiler/CpuProfiler.h.
const IRQ_MARKER = 0xfffffffe;

// Kickstart ROM address range (covers 256K and 512K ROMs), as in WinUAE.
const KICKSTART_ROM_START = 0xf80000;
const KICKSTART_ROM_END = 0x1000000;

// Classify a leaf PC into a synthetic bucket label, or undefined for normal in-program
// code. Precedence mirrors the old vscode-amiga-debug: [IRQ] (dispatch-gap marker) >
// Kickstart (ROM range) > program (a loaded segment → normal) > [External] (anything else).
// A ROM PC resolves to "[Kick] <name>" when Kickstart symbols are loaded (kickstartRomPath
// + a known ROM, merged into the SourceMap as the .kick module) — useful since demoscene/
// bare-metal code still calls ROM routines (WaitBlit, etc.) — or flat "[Kickstart]" otherwise.
// The symbol NAME only (no offset) so all PCs within one ROM routine aggregate into one node.
export function syntheticLabel(pc: number, sourceMap: SourceMap): string | undefined {
  if (pc === IRQ_MARKER) return "[IRQ]";
  if (pc >= KICKSTART_ROM_START && pc < KICKSTART_ROM_END) {
    const sym = sourceMap.findSymbolOffset(pc, true);
    return sym ? `[Kick] ${sym.symbol}` : "[Kickstart]";
  }
  if (sourceMap.findSegmentForAddress(pc)) return undefined;
  return "[External]";
}

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
  const synthetic = syntheticLabel(pc, sourceMap);
  if (synthetic) return [{ func: synthetic, file: undefined, line: undefined, address: pc }];
  const sym = sourceMap.findSymbolOffset(pc, true);
  const loc = sourceMap.lookupAddress(pc);
  const funcName = sym ? sym.symbol : `0x${pc.toString(16)}`;
  const inlines = sourceMap.getInlineFramesForPc?.(pc) ?? []; // innermost-first
  if (inlines.length === 0) {
    // No inlining (typical for assembly): resolve file/line at the symbol's own address,
    // not pc, so a function invoked via a macro carrying its own line-table entry (e.g. an
    // include) still resolves to one consistent location instead of splitting per call site.
    const declLoc = sym ? sourceMap.lookupAddress(pc - sym.offset) : loc;
    return [{ func: funcName, file: declLoc?.path, line: declLoc?.line, address: pc }];
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

// Nest "context-less" leaves under the program call stack, porting the old vscode-amiga-
// debug `lastCallstack` reuse: a depth-1 leaf the unwinder couldn't step out of inherits
// the previous in-program sample's stack as context, so it renders below its caller and
// its cycles roll up into the CPU total. Two kinds of context-less leaf:
//   * out-of-program ([Kickstart]/[External]) — DWARF can't unwind from ROM/elsewhere;
//   * a no-DWARF-CFI leaf *inside* the program — an #embed'd binary or hand-asm called via
//     jsr (e.g. ThePlayer in template.c, in .rodata): symbolized normally but with no CFI,
//     so the emulator emits it depth-1. `getCfaForPc` is the reliable signal — real C code
//     always has CFI, so a no-CFI leaf is a no-debug blob (the only other no-CFI code,
//     crt0/_start, is a genuine root and isn't sampled mid-frame).
// [IRQ] markers stay standalone (dispatch overhead, not attributable to a function), and
// branch-stack samples already carry real context (depth > 1) and pass through unchanged.
// Operates on raw PCs and returns a new array, leaving the input `samples` (the raw
// artifact returned by getSamples) untouched.
export function applyContextReuse(samples: InstructionSample[], sourceMap: SourceMap): InstructionSample[] {
  // The no-CFI-blob nesting only makes sense for a DWARF program: there, every real
  // function has CFI, so a no-CFI leaf is a no-debug blob. A pure-assembly (branch-stack)
  // capture has NO DWARF at all — getCfaForPc is always undefined and depth-1 leaves are
  // legitimate (the shadow stack), so blob-nesting must be disabled. getUnwindRows() is the
  // "has DWARF CFI" signal (empty for asm); compute it once.
  const hasCfi = sourceMap.getUnwindRows().length > 0;
  let lastProgramStack: number[] = [];
  return samples.map((s) => {
    const leaf = s.stack[0];
    const synthetic = syntheticLabel(leaf, sourceMap);
    if (synthetic === "[IRQ]") return s; // standalone, never nested or reused as context

    const depth1 = s.stack.length === 1;
    const outOfProgram = synthetic !== undefined; // [Kickstart]/[External]
    const noCfiBlob = hasCfi && !outOfProgram && depth1 && !sourceMap.getCfaForPc(leaf);

    // Nest a context-less leaf (out-of-program, or an in-program no-CFI blob) under the
    // last real program stack so it hangs off its caller instead of floating at the root.
    if (depth1 && (outOfProgram || noCfiBlob) && lastProgramStack.length > 0) {
      return { stack: [leaf, ...lastProgramStack], cycles: s.cycles };
    }

    // Genuine program code (resolvable C with a caller chain, or a real root like an
    // interrupt handler): remember it as context for subsequent context-less leaves.
    if (!outOfProgram && !noCfiBlob) lastProgramStack = s.stack;
    return s;
  });
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
  for (const s of applyContextReuse(samples, sourceMap)) {
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
  // Reconstruction baseline (raw bytes; `custom` is 256 little-endian u16 = the custom-register
  // file at capture start, used for DMACON / register reconstruction).
  snapshot?: { chip: Uint8Array; slow: Uint8Array; custom: Uint8Array };
  copper?: Uint8Array; // raw copper-instruction-trace bytes (absent if unsupported/empty)
  dmaEvents?: Uint8Array; // raw per-cycle event-bitfield bytes, parallel to `dma` (absent if unsupported/empty)
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
        model.dmaSnapshot = {
          chip: raw.snapshot.chip,
          slow: raw.snapshot.slow,
          custom: decodeCustomRegs(raw.snapshot.custom),
        };
      }
      // Only attach if it lines up with the grid — a mismatched length (stale/corrupt capture)
      // must not desync events[slot] from owner[slot] elsewhere.
      if (raw.dmaEvents) {
        const events = decodeDmaEvents(raw.dmaEvents);
        if (events && events.length === dma.owner.length) dma.events = events;
      }
    }
  }
  if (raw.copper) model.copper = decodeCopperRecords(raw.copper);
  return { model, samples };
}

// Orchestrates a capture: upload the unwind table, run the profiled frame(s),
// read back the binary stream, decode + aggregate into a call tree. All heavy
// work (symbolication, aggregation) happens here, once, so the webview only ever
// receives the compact tree.
export class ProfilerManager {
  constructor(
    private readonly getClient: () => ProfilerRpcClient | undefined,
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
    const rpc = this.getClient();
    if (!rpc) throw new Error("Profiler: no active emulator session — start a debug session first");
    const sourceMap = this.getSourceMap();
    if (!sourceMap) throw new Error("Profiler: no source map (is a program loaded with DWARF info?)");

    const rows = sourceMap.getUnwindRows();
    const table = buildUnwindTable(rows);
    if (table) {
      // C/C++ with DWARF .debug_frame: the emulator unwinds A5/A7 with this table.
      await rpc.sendRpcCommand("profileSetUnwind", {
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
      await rpc.sendRpcCommand("profileSetUnwind", {
        data: new Uint8Array(0),
        startAddr,
        endAddr,
      });
    }

    // Enable the copper-instruction trace for the captured frame(s) — best-effort, a backend
    // without it (e.g. an older PUAE build) just won't produce raw.copper below.
    try {
      await rpc.sendRpcCommand("copperTrackingEnable", { enabled: true });
    } catch {
      // unsupported — fine, the CPU/DMA profile doesn't depend on it
    }

    // Capture runs N frames synchronously in the emulator; allow generous time.
    await rpc.sendRpcCommand("startProfiling", { numFrames }, 30000);

    const u8 = (d: unknown): Uint8Array => (d instanceof Uint8Array ? d : new Uint8Array((d as ArrayLike<number>) ?? 0));

    const res = await rpc.sendRpcCommand<{
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
      const dmaRes = await rpc.sendRpcCommand<{ data: Uint8Array }>("getDmaData");
      const dmaBytes = u8(dmaRes.data);
      if (dmaBytes.length) {
        raw.dma = dmaBytes;
        const snap = await rpc.sendRpcCommand<{ chip: Uint8Array; slow: Uint8Array; custom: Uint8Array }>(
          "getDmaSnapshot",
        );
        raw.snapshot = { chip: u8(snap.chip), slow: u8(snap.slow), custom: u8(snap.custom) };
        const eventsRes = await rpc.sendRpcCommand<{ data: Uint8Array }>("getDmaEvents");
        const eventsBytes = u8(eventsRes.data);
        if (eventsBytes.length) raw.dmaEvents = eventsBytes;
      }
    } catch (e) {
      console.warn("[profiler] DMA capture failed (CPU profile unaffected):", e);
    }

    // Fetch the copper trace recorded over the same frame(s), then turn tracking back off —
    // it costs real per-cycle overhead in the live emulator, so it shouldn't stay on past
    // this capture. Best-effort, like the DMA grid above.
    try {
      const copperRes = await rpc.sendRpcCommand<{ data: Uint8Array }>("getCopperData");
      const copperBytes = u8(copperRes.data);
      if (copperBytes.length) raw.copper = copperBytes;
    } catch (e) {
      console.warn("[profiler] copper trace capture failed (CPU profile unaffected):", e);
    } finally {
      try {
        await rpc.sendRpcCommand("copperTrackingEnable", { enabled: false });
      } catch {
        // unsupported — already a no-op
      }
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
