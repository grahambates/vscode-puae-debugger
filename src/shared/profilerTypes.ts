// Shared data + message contract between the extension (profilerViewerProvider /
// profilerManager) and the profiler webview. Keep this free of node/vscode imports.

// A symbolicated code location returned by expandPc, one per logical call frame
// (physical function + any DWARF inlines) for a given PC.
export interface ProfileFrame {
  func: string;
  file?: string;
  line?: number;
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

// A symbolicated frame. Mirrors the subset of CDP's Runtime.CallFrame the old
// renderer reads, so the ported column/flame code needs no shape changes.
export interface CallFrame {
  functionName: string;
  url: string; // source file path, "" if unknown
  scriptId: string;
  lineNumber: number; // 0-based; -1 if unknown
  columnNumber: number;
}

// One source location. Multiple call-tree nodes can share a location (same PC
// reached via different call paths). `address` is the leaf PC — retained for the
// later coverage / disassembly-tracing phases.
export interface ILocation {
  id: number;
  selfTime: number;
  aggregateTime: number;
  ticks: number;
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

// vAmiga bus owners — mirrors the ordinals of `BusOwner` in
// vamigaweb_fork/Core/Components/Agnus/BusTypes.h. Indexes IDmaModel.owner.
export enum BusOwner {
  NONE = 0, CPU = 1, REFRESH = 2, DISK = 3,
  AUD0 = 4, AUD1 = 5, AUD2 = 6, AUD3 = 7,
  BPL1 = 8, BPL2 = 9, BPL3 = 10, BPL4 = 11, BPL5 = 12, BPL6 = 13,
  SPRITE0 = 14, SPRITE1 = 15, SPRITE2 = 16, SPRITE3 = 17,
  SPRITE4 = 18, SPRITE5 = 19, SPRITE6 = 20, SPRITE7 = 21,
  COPPER = 22, BLITTER = 23, BLOCKED = 24,
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
}

// A program symbol shipped to the webview for on-demand address symbolization (the
// reusable primitive future disassembly/copper/memory views will also use). `size` is
// clamped to the segment end (from SourceMap.getSymbolLengths), so [address, address+size)
// bounds the symbol's range.
export interface ISymbol {
  address: number;
  name: string;
  size: number;
}

// One disassembled instruction, annotated with exact per-PC execution stats (this profiler
// traces every retired instruction, not statistical sampling — `hits`/`cycles` are exact counts
// for the captured frame, not estimates) and source location. `file`/`line` follow the same
// (quirky but established) convention as ILocation.callFrame — see openProfilerSource's `line - 1`
// adjustment when opening from the webview.
export interface IDisassembledInstruction {
  address: number;
  hex: string; // raw instruction bytes, space-separated hex pairs
  text: string; // mnemonic + operands (no address/hex prefix)
  length: number; // byte length, so address+length is the next instruction's address
  hits: number; // times this exact PC was the executing instruction this frame
  cycles: number; // total cycles attributed to this PC this frame
  file?: string;
  line?: number;
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
export interface CaptureResultMessage {
  command: "captureResult";
  model: IProfileModel;
  // Webview-fetchable URI of the bulk binary blob (DMA grid + chip/slow snapshot), packed by
  // packBulk. The big arrays go via the resource loader (fast) instead of postMessage (slow for
  // binary); the webview fetches + decodes them and attaches dma/dmaSnapshot to the model.
  bulkUri?: string;
}
export interface ProfilerErrorMessage {
  command: "showError";
  error: string;
}
export interface CaptureBusyMessage {
  command: "capturing";
}
export type ProfilerOutboundMessage =
  | CaptureResultMessage
  | ProfilerErrorMessage
  | CaptureBusyMessage;

// --- messages: webview -> extension ---
export interface ReadyMessage {
  command: "ready";
}
export interface CaptureMessage {
  command: "capture";
}
// Ctrl/Cmd+click on a box: jump to its source. `line` here is 1-based — the model's
// CallFrame.lineNumber is 0-based, and the webview adds 1 before sending this message.
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
export type ProfilerInboundMessage =
  | ReadyMessage
  | CaptureMessage
  | OpenDocumentMessage
  | SaveProfileMessage;
