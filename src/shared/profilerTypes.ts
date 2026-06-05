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
export type ProfilerInboundMessage = ReadyMessage | CaptureMessage | OpenDocumentMessage;
