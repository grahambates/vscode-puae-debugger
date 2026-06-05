// Shared data + message contract between the extension (profilerViewerProvider /
// profilerManager) and the profiler webview. Keep this free of node/vscode imports.

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

// --- messages: extension -> webview ---
export interface CaptureResultMessage {
  command: "captureResult";
  result: ProfileResult;
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
export type ProfilerInboundMessage = ReadyMessage | CaptureMessage;
