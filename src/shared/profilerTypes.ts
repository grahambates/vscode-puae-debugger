// Shared data + message contract between the extension (profilerViewerProvider /
// profilerManager) and the profiler webview. Keep this free of node/vscode imports.

// --- aggregated merged call tree (kept for a possible function-table view) ------

// A symbolicated code location, interned and referenced by index from the tree.
export interface ProfileFrame {
  func: string;
  file?: string;
  line?: number;
  address: number;
}

// A node in the aggregated call tree. `frame` indexes ProfileResult.uniqueFrames
// (-1 for the synthetic root). `self` = cycles where this node was the leaf;
// `total` = cycles for all samples passing through it.
export interface CallTreeNode {
  frame: number;
  self: number;
  total: number;
  children: CallTreeNode[];
}

export interface ProfileResult {
  uniqueFrames: ProfileFrame[];
  root: CallTreeNode;
  totalCycles: number;
  sampleCount: number;
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

// Capture-start RAM baseline for memory reconstruction (replay the grid's WRITE cells
// over this). Retained extension-side this phase; shipped to the webview when a
// reconstruction consumer (memory/screen/blitter view) is built.
export interface DmaSnapshot {
  chip: Uint8Array; // chip RAM at capture start
  slow: Uint8Array; // slow/bogo RAM at capture start (may be empty)
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

// The time-ordered model. `samples[i]` is the leaf node id of the i-th captured
// instruction (samples[0] is a dummy; pairs with timeDeltas[i-1], matching the old
// CDP convention buildColumns expects). `timeDeltas[k]` is that instruction's cycle
// cost. `duration` = total cycles (≈ one frame).
export interface IProfileModel {
  nodes: IComputedNode[];
  locations: ILocation[];
  samples: number[];
  timeDeltas: number[];
  duration: number;
  // CPU clock for the display-unit conversions (a property of the running machine,
  // PAL only for now). The old WinUAE baseClock analog.
  cyclesPerMicroSecond: number; // CPU clock /1e6 (PAL 7.09379)
  // Per-DMA-cycle grid (same captured frame). Absent if DMA capture produced nothing.
  dma?: IDmaModel;
  // Capture-start chip/slow RAM baseline; with `dma` it lets the webview reconstruct memory
  // at any cycle (see webview/profilerViewer/reconstruct.ts). Absent if DMA capture failed.
  dmaSnapshot?: DmaSnapshot;
  // Program + Kickstart symbols (sorted by address) for webview-side symbolization.
  symbols?: ISymbol[];
}

// --- messages: extension -> webview ---
export interface CaptureResultMessage {
  command: "captureResult";
  model: IProfileModel;
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
// Ctrl/Cmd+click on a box: jump to its source (line is 1-based as carried in the
// model's CallFrame). `toSide` opens beside (Alt held).
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
