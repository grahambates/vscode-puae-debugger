// Shared data + message contract between the extension (profilerViewerProvider /
// profilerManager) and the profiler webview. Keep this free of node/vscode imports.

// A symbolicated code location returned by expandPc, one per logical call frame
// (physical function + any DWARF inlines) for a given PC.
export interface ProfileFrame {
  func: string;
  file?: string;
  line?: number; // 1-based, straight from SourceMap.lookupAddress().line — pass directly to
  // openProfilerSource's `line` param, no +1 (despite ILocation.callFrame.lineNumber's name,
  // this is NOT the 0-based V8/CDP convention — a past mix-up here caused an off-by-one bug)
  address: number;
}

// --- time-ordered profile model (what the flame chart renders) ------------------
// A trimmed, serializable port of the old vscode-amiga-debug `IProfileModel`. Built
// in the extension (it needs symbolication from the SourceMap) and posted to the
// webview, where `buildColumns` turns it into the time-ordered column layout.

// Category of a call frame; drives box colouring (System frames render gray).
export enum Category {
  System = 0,
  User = 1,
  Module = 2,
}

// A symbolicated frame. Mirrors the SHAPE of CDP's Runtime.CallFrame the old renderer reads (so
// the ported column/flame code needs no shape changes) — but NOT real CDP's 0-based lineNumber:
// this is populated straight from SourceMap.lookupAddress().line, which is 1-based. Pass it
// directly to onOpenSource, no +1 (a past assumption that this was genuinely 0-based, requiring
// a +1 before calling onOpenSource — which itself does -1 — caused an off-by-one bug).
export interface CallFrame {
  functionName: string;
  url: string; // source file path, "" if unknown
  scriptId: string;
  lineNumber: number; // 1-based; -1 if unknown
  columnNumber: number;
}

// One source location. Multiple call-tree nodes can share a location (same PC
// reached via different call paths). `address` is the leaf PC — retained for the
// later coverage / disassembly-tracing phases.
export interface ILocation {
  id: number;
  selfTime: number;
  aggregateTime: number;
  category: Category;
  callFrame: CallFrame;
  address: number;
}

// One node in the call tree, addressed by id. `parent` is omitted for the
// synthetic root (node 0); `buildColumns` walks `parent` up to (not including) it.
export interface IComputedNode {
  id: number;
  selfTime: number;
  aggregateTime: number;
  children: number[];
  parent?: number;
  locationId: number;
}

// Bus owner ordinals for the profiler's Cell[] DMA grid. Originally mirrored vAmiga's
// (OCS/ECS-only, 6-plane) `BusOwner` in vamigaweb_fork/Core/Components/Agnus/BusTypes.h,
// but since this project moved to the PUAE backend — which supports AGA's 8 bitplanes —
// BPL7/BPL8 were added here (shifting SPRITE0-7/COPPER/BLITTER/BLOCKED up by 2), diverging
// from vAmiga's own enum. Indexes IDmaModel.owner. Keep in sync with the C-side encoder,
// puae_dma_serialize() in puae-wasm/libretro-uae/sources/src/debug.c.
export enum BusOwner {
  NONE = 0, CPU = 1, REFRESH = 2, DISK = 3,
  AUD0 = 4, AUD1 = 5, AUD2 = 6, AUD3 = 7,
  BPL1 = 8, BPL2 = 9, BPL3 = 10, BPL4 = 11, BPL5 = 12, BPL6 = 13, BPL7 = 14, BPL8 = 15,
  SPRITE0 = 16, SPRITE1 = 17, SPRITE2 = 18, SPRITE3 = 19,
  SPRITE4 = 20, SPRITE5 = 21, SPRITE6 = 22, SPRITE7 = 23,
  COPPER = 24, BLITTER = 25, BLOCKED = 26,
}

// PUAE's own DMA-record type tag — mirrors `DMARECORD_*` in
// puae-wasm/libretro-uae/sources/src/include/debug.h exactly (values, not just
// order: e9k_dma_get_cell_type() returns these directly). Distinct from
// BusOwner above, which is vAmiga's bus-owner ordinal used for the profiler's
// baked Cell[] grid format — DmaRecordType is what the PUAE webview's live
// DMA-overlay hover tooltip (dmaHover.ts) gets back from the single-cell
// getters. Keep in sync with debug.h if it ever changes.
export enum DmaRecordType {
  REFRESH = 1,
  CPU = 2,
  COPPER = 3,
  AUDIO = 4,
  BLITTER = 5,
  BITPLANE = 6,
  SPRITE = 7,
  DISK = 8,
  CONFLICT = 9,
}

// IDmaModel.flags bit layout (mirrors DmaProfiler::DMA_* / COP_SUB_*).
export const DMA_WRITE = 1 << 0;
export const DMA_BYTE = 1 << 1;
export const DMA_CODE = 1 << 2; // CPU instruction fetch (PROG space)
export const DMA_SUB_SHIFT = 3;
export const DMA_SUB_MASK = 0x3 << DMA_SUB_SHIFT;
export const COP_SUB_MOVE = 0;
export const COP_SUB_WAIT = 1;
export const COP_SUB_SKIP = 2;

// The per-DMA-cycle enriched grid, captured in the same frame as the CPU profile.
// Four parallel arrays, one entry per dma-cycle slot, line-major (= execution/time
// order); the slot count is `owner.length`. Decoded from the emulator's binary Cell[8]
// stream (see src/dma.ts). Drives the DMA "channel line" in the flame graph and the
// per-channel totals in the time view; the same grid is the reconstruction source.
export interface IDmaModel {
  owner: Uint8Array; // BusOwner ordinal per slot (0 = NONE/idle) — channel color
  flags: Uint8Array; // bits0-2 WRITE|BYTE|CODE; bits3-4 Copper sub-state (MOVE/WAIT/SKIP)
  addr: Uint32Array; // bus address (tooltips + reconstruction routing)
  value: Uint16Array; // bus data (tooltips + reconstruction)
  // Per-cycle hardware-event bitfield (DMA_EVENT_* — BLITIRQ/COPPERWAKE/VB/etc., see
  // webview/profilerViewer/dma.ts's DMA_EVENT_NAMES), parallel to the arrays above. Absent for
  // captures predating this field (older .vamigaprofile files) or a backend that doesn't supply
  // it (vAmiga) — tooltip Events row just doesn't render.
  events?: Uint32Array;
}

// Fixed PAL DMA-grid geometry (matches the emulator's DmaProfiler DMA_HPOS/VPOS and the old
// vscode-amiga-debug NR_DMA_REC_HPOS/VPOS). The grid is always DMA_HPOS*DMA_VPOS cells, so a
// flat slot index decodes as line = slot/DMA_HPOS, colorClock = slot%DMA_HPOS.
export const DMA_HPOS = 227;
export const DMA_VPOS = 313;

// Is this DMA cell a custom-register access? CPU custom reads/writes carry the full
// 0xDFFxxx bus address; a Copper MOVE's bus address is the bare register offset
// (0x000-0x1FE). Both are register accesses, not chip-RAM. The register offset is
// `addr & 0x1FE` in either case.
export function dmaIsCustomReg(owner: number, flags: number, addr: number): boolean {
  if (((addr >>> 0) & 0xfff000) === 0xdff000) return true;
  if (owner === BusOwner.COPPER && (flags & DMA_WRITE) !== 0) return true;
  return false;
}

// The executed copper-instruction trace for the captured frame (PUAE's cop_record[],
// puae_copper_serialize) — one entry per instruction the copper actually ran, in execution
// order. `addr` is the instruction's start address (both words); hpos/vpos are the DMA-grid
// coordinates of its second word fetch. Decoded webview-side via disassembleCopperInstruction
// (src/shared/copperDisassembler.ts) — this just carries the raw trace.
export interface ICopperModel {
  addr: Uint32Array;
  w1: Uint16Array;
  w2: Uint16Array;
  hpos: Uint16Array;
  vpos: Uint16Array;
}

// Capture-start RAM baseline for memory reconstruction (replay the grid's WRITE cells
// over this). Retained extension-side this phase; shipped to the webview when a
// reconstruction consumer (memory/screen/blitter view) is built.
export interface DmaSnapshot {
  chip: Uint8Array; // chip RAM at capture start
  slow: Uint8Array; // slow/bogo RAM at capture start (may be empty)
  custom: Uint16Array; // custom-register file at capture start (256 regs; for DMACON/reconstruction)
  // AGA's full 256-entry, 24-bit-per-channel palette (0x00RRGGBB) at capture start — absent
  // outside AGA mode. Already fully reconstructed C-side (BPLCON3 LOCT/bank-select applied),
  // unlike `custom`'s COLOR00-31 window, which only ever reflects one bank at 4-bit precision.
  agaColors?: Uint32Array;
}

// A program symbol shipped to the webview for on-demand address symbolization (the
// reusable primitive future disassembly/copper/memory views will also use). `size` is
// clamped to the segment end (from SourceMap.getSymbolLengths), so [address, address+size)
// bounds the symbol's range. (Source-location lookup for an arbitrary address — code or data —
// goes through `IProfileModel.lineTable` instead, not this list; see sourceLookup.ts.)
export interface ISymbol {
  address: number;
  name: string;
  size: number;
}

// One address->line entry from SourceMap.getLineTable() — every address transition the
// assembler/compiler's line info covers, code AND data (e.g. a copper list's `dc.w` lines).
// `line` is 1-based (see ProfileFrame.line) — pass directly to onOpenSource, no +1. Floor-searched
// by sourceLookup.ts's createSourceLookup, bounded by `segments` so a floor match doesn't cross
// into a different (or unloaded) segment.
export interface ILineTableEntry {
  address: number;
  file: string;
  line: number;
}

// A loaded segment's address range, for bounding the line-table floor-search above (mirrors
// SourceMap.findSegmentForAddress, minimally — just enough to replicate that check webview-side).
export interface ISegmentRange {
  address: number;
  size: number;
}

// One disassembled instruction, annotated with exact per-PC execution stats (this profiler
// traces every retired instruction, not statistical sampling — `hits`/`cycles` are exact counts
// for the captured frame, not estimates) and source location.
export interface IDisassembledInstruction {
  address: number;
  hex: string; // raw instruction bytes, space-separated hex pairs
  text: string; // mnemonic + operands (no address/hex prefix)
  length: number; // byte length, so address+length is the next instruction's address
  hits: number; // times this exact PC was the executing instruction this frame
  cycles: number; // total cycles attributed to this PC this frame
  file?: string;
  line?: number; // 1-based, straight from SourceMap.lookupAddress().line — see ProfileFrame.line
  jumpTarget?: number; // resolved branch/jump target address, for arrow-gutter visualization
}

// One executed function's full disassembly. Only functions that actually executed (per the
// captured samples) are included — disassembling the whole program isn't useful or necessary.
export interface IDisassembledFunction {
  address: number;
  name: string;
  instructions: IDisassembledInstruction[];
}

// The time-ordered model. `samples[i]` is the leaf node id of the i-th captured
// instruction (samples[0] is a dummy; pairs with timeDeltas[i-1], matching the old
// CDP convention buildColumns expects). `timeDeltas[k]` is that instruction's cycle
// cost. `duration` = total cycles (≈ one frame).
export interface IProfileModel {
  nodes: IComputedNode[];
  locations: ILocation[];
  samples: number[];
  timeDeltas: number[];
  // pcs[k] is timeDeltas[k]'s exact instruction PC — NOT the same as
  // locations[nodes[samples[k+1]].locationId].address, which is deduped per function (every
  // sample within the same function shares one location, frozen to whichever PC first created
  // it). buildColumns reads this to give each column's leaf cell its own real address.
  pcs: number[];
  duration: number;
  // CPU clock for the display-unit conversions (a property of the running machine,
  // PAL only for now). The old WinUAE baseClock analog.
  cyclesPerMicroSecond: number; // CPU clock /1e6 (PAL 7.09379)
  // Per-DMA-cycle grid (same captured frame). Absent if DMA capture produced nothing.
  dma?: IDmaModel;
  // Capture-start chip/slow RAM baseline; with `dma` it lets the webview reconstruct memory
  // at any cycle (see webview/profilerViewer/reconstruct.ts). Absent if DMA capture failed.
  dmaSnapshot?: DmaSnapshot;
  // Executed copper-instruction trace for the captured frame. Absent if copper tracking
  // wasn't supported/enabled or produced nothing.
  copper?: ICopperModel;
  // Program + Kickstart symbols (sorted by address) for webview-side symbolization.
  symbols?: ISymbol[];
  // Disassembly + per-instruction profiling stats for every function that executed this frame.
  // Absent if disassembly capture wasn't supported/failed (CPU profile is unaffected either way).
  disassembly?: IDisassembledFunction[];
  // Per-sample CPU register snapshot, flat and parallel to pcs/timeDeltas: registers[k*REG_COUNT
  // + r] is sample k's register r (see REG_* offsets below). Absent if unsupported/failed.
  registers?: Uint32Array;
  // The program's full address->line table (SourceMap.getLineTable()) + loaded segment ranges,
  // for general-purpose webview-side source-location lookup (see sourceLookup.ts) — covers code
  // AND data addresses (unlike `disassembly`, which only covers executed instructions), so any
  // view with an address (Memory, Copper, ...) can offer "jump to source" without a dedicated
  // per-feature resolution pass. Set in buildModelFromCapture (not buildProfileModel, which is
  // unit-tested with minimal SourceMap stubs that don't implement getLineTable/getSegmentsInfo) —
  // optional for that reason, but in practice always present once a model reaches the webview.
  lineTable?: ILineTableEntry[];
  segments?: ISegmentRange[];
}

// Layout of one IProfileModel.registers entry (19 × u32: D0-D7, A0-A7, SR, PC, USP) — matches
// puae_debug_read_regs/WASM_PROFILE_REG_COUNT exactly (puae-wasm/puae_debug.c).
export const REG_COUNT = 19;
export const REG_D0 = 0; // D0-D7 = REG_D0..REG_D0+7
export const REG_A0 = 8; // A0-A7 = REG_A0..REG_A0+7
export const REG_SR = 16;
export const REG_PC = 17;
export const REG_USP = 18;

// --- messages: extension -> webview ---

// One frame within a multi-frame captureResult. `bulkUri` is the webview-fetchable URI of the
// frame's bulk binary blob (DMA grid + chip/slow snapshot + JPEG thumbnail), packed by packBulk.
// The big arrays go via the resource loader (fast) instead of postMessage (slow for binary).
export interface CaptureFrameInfo {
  model: IProfileModel;
  bulkUri?: string;
}

export interface CaptureResultMessage {
  command: "captureResult";
  // All captured frames. Single-frame captures produce a one-element array; multi-frame produce N.
  frames: CaptureFrameInfo[];
  // Present when frames.length > 1: a model built from all N frames' instruction samples
  // concatenated (correct aggregate times + combined flame-graph timeline). DMA/copper/registers
  // are omitted (per-frame only). The webview uses this for the "All" filmstrip button.
  combinedModel?: IProfileModel;
}
export interface ProfilerErrorMessage {
  command: "showError";
  error: string;
}
export interface CaptureBusyMessage {
  command: "capturing";
}
// Result of a ComputeRangeMessage: a combined model for the requested sub-range.
export interface RangeResultMessage {
  command: "rangeResult";
  model: IProfileModel;
}
export interface SourceFileMessage {
  command: "sourceFile";
  file: string;
  lines: string[]; // full file content, 0-indexed; empty if unreadable
}
// Editor context-menu "Jump to Next Execution in Profiler" on a line carrying profiler line
// decorations (see profilerLineDecorationProvider.ts) — the webview finds the next execution of
// any instruction on this source line and switches to the CPU tab, the same as clicking a
// function/instruction elsewhere in the profiler. `line` is 1-based, matching
// IDisassembledInstruction.line/CallFrame.lineNumber's convention.
export interface JumpToLineMessage {
  command: "jumpToExecutionAtLine";
  file: string;
  line: number;
}
export type ProfilerOutboundMessage =
  | CaptureResultMessage
  | RangeResultMessage
  | ProfilerErrorMessage
  | CaptureBusyMessage
  | SourceFileMessage
  | JumpToLineMessage;

// --- messages: webview -> extension ---
export interface ReadyMessage {
  command: "ready";
}
export interface CaptureMessage {
  command: "capture";
}
// Ctrl/Cmd+click on a box: jump to its source. `line` here is 1-based, same as the model's
// CallFrame.lineNumber/IDisassembledInstruction.line/etc. — passed straight through, no +1.
// `toSide` opens beside (Alt held).
export interface OpenDocumentMessage {
  command: "openDocument";
  file: string;
  line: number;
  toSide?: boolean;
}
// Save the current capture to a .vamigaprofile (the extension owns the dialog + write).
export interface SaveProfileMessage {
  command: "saveProfile";
}
// Update the number of frames the next capture will record (live panel only).
export interface SetNumFramesMessage {
  command: "setNumFrames";
  numFrames: number;
}
// Request a combined model for a sub-range of captured frames (shift-click selection).
// The extension builds it server-side and replies with RangeResultMessage.
export interface ComputeRangeMessage {
  command: "computeRange";
  range: [number, number]; // [a, b] inclusive frame indices
}
export interface ReadSourceFileMessage {
  command: "readSourceFile";
  file: string; // absolute path
}
export type ProfilerInboundMessage =
  | ReadyMessage
  | CaptureMessage
  | ComputeRangeMessage
  | OpenDocumentMessage
  | SaveProfileMessage
  | SetNumFramesMessage
  | ReadSourceFileMessage;
