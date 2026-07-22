export interface MemoryRange {
  address: number;
  size: number;
}
export interface MemoryRegion {
  name: string;
  range: MemoryRange;
}

export interface Suggestion {
  label: string;
  address: string;
  description?: string;
}

export type ViewMode =  "hex" | "visual" | "disassembly" | "copper";

// Backend messages

export interface UpdateStateMessageProps {
  viewMode?: ViewMode,
  addressInput?: string;
  target?: MemoryRange;
  symbols?: Record<string, number>;
  symbolLengths?: Record<string, number>;
  availableRegions?: MemoryRegion[];
  liveUpdate?: boolean;
  colorCodeHexBytes?: boolean;
  watchedAddress?: number | null;
  error?: string | null;
  // Sets document.title — a no-op inside vscode (its webview tab label comes
  // from the WebviewPanel.title API, not the iframe's own document.title),
  // but the standalone host's only way to give each of several simultaneous
  // memory-viewer browser tabs a distinguishing title.
  windowTitle?: string;
}

export interface UpdateStateMessage extends UpdateStateMessageProps {
  command: "updateState";
}

// Standalone host only (StandaloneMemoryViewerProvider) — there's no native
// save dialog outside vscode, so "Export" sends the encoded bytes here and
// the webview triggers a normal browser download instead. Mirrors
// profilerTypes.ts's DownloadProfileMessage.
export interface DownloadMemoryMessage {
  command: "downloadMemory";
  dataBase64: string;
  fileName: string;
}


export interface SuggestionsDataMessage {
  command: "suggestionsData";
  suggestions: Suggestion[];
}

export interface MemoryDataMessage {
  command: "memoryData";
  address: number;
  data: Uint8Array;
}

// Front end messages:

export interface ChangeAddressMessage {
  command: "changeAddress";
  addressInput: string;
  dereferencePointer: boolean;
}

export interface RequeestMemoryMessage {
  command: "requestMemory";
  address: number;
  size: number;
}

export interface GoToSourceMessage {
  command: "goToSource";
  address: number;
}

export interface ExportMemoryMessage {
  command: "exportMemory";
  address: number;
  size: number; // 0 means "unknown length — prompt the user"
}

export interface ToggleWatchpointMessage {
  command: "toggleWatchpoint";
  address: number;
}

export interface ToggleLiveUpdateMessage {
  command: "toggleLiveUpdate";
  enabled: boolean;
}

export interface GetSuggestionsMessage {
  command: "getSuggestions";
  query: string;
  showAll?: boolean; // If true, ignore limit and return all symbols
}
