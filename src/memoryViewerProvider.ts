import { readFileSync } from "fs";
import { isAbsolute } from "path";
import { EmulatorMessage, isEmulatorStateMessage, MemSrc } from "./emulatorProtocol";
import { Disposable, Emulator } from "./emulator";
import { DebugAdapter } from "./debugAdapter";
import { formatHex } from "./numbers";
import { EvaluateResultType } from "./evaluateManager";
import {
  ChangeAddressMessage,
  ExportMemoryMessage,
  GetSuggestionsMessage,
  GoToSourceMessage,
  MemoryDataMessage,
  MemoryRange,
  MemoryRegion,
  RequeestMemoryMessage,
  Suggestion,
  SuggestionsDataMessage,
  ToggleLiveUpdateMessage,
  ToggleWatchpointMessage,
  UpdateStateMessage,
  UpdateStateMessageProps,
  ViewMode,
} from "./shared/memoryViewerTypes";
import { parseLine } from "./sourceParsing";
import { WebviewHost } from "./webviewHost";

interface MemoryViewerPanel {
  id: string;
  target?: MemoryRange;
  host: WebviewHost;
  addressInput: string;
  liveUpdate: boolean;
  dereferencePointer: boolean;
  liveUpdateInterval?: NodeJS.Timeout;
  liveUpdateRefresh?: Promise<void>;
  fetchedChunks: Set<number>;
  watchedAddress?: number;
}

/** A concrete host's UI surface for one `show()` — mirrors `ProfilerSurface` (profilerViewerProvider.ts). */
export interface MemoryPanelSurface {
  resolveUri(file: string): string;
  cspMeta: string;
  extraHeadHtml: string;
  host: WebviewHost;
  setHtml(html: string): void;
}

const LIVE_UPDATE_RATE_MS = 1000 / 25;
const CHUNK_SIZE = 1024;
const SUGGESTIONS_LIMIT = 50;

const memTypeLabels: Record<MemSrc, string> = {
  [MemSrc.NONE]: "None",
  [MemSrc.CHIP]: "Chip RAM",
  [MemSrc.CHIP_MIRROR]: "Chip RAM (mirror)",
  [MemSrc.SLOW]: "Slow RAM",
  [MemSrc.SLOW_MIRROR]: "Slow RAM (mirror)",
  [MemSrc.FAST]: "Fast RAM",
  [MemSrc.CIA]: "CIA Registers",
  [MemSrc.CIA_MIRROR]: "CIA Registers (mirror)",
  [MemSrc.RTC]: "RTC",
  [MemSrc.CUSTOM]: "Custom Registers",
  [MemSrc.CUSTOM_MIRROR]: "Custom Registers (mirror)",
  [MemSrc.AUTOCONF]: "Autoconf",
  [MemSrc.ZOR]: "ZOR",
  [MemSrc.ROM]: "ROM",
  [MemSrc.ROM_MIRROR]: "ROM (mirror)",
  [MemSrc.WOM]: "WOM",
  [MemSrc.EXT]: "EXT",
};

/**
 * Provides a webview for viewing emulator memory in different formats.
 * Supports multiple instances (multiple simultaneous panels/tabs) for
 * viewing different memory regions at once.
 *
 * Host-agnostic: creating/attaching each panel's actual `WebviewHost`,
 * setting its native window title, "go to source", the
 * `memoryViewer.colorCodeHexBytes` setting, and exporting memory to disk are
 * all delegated to a concrete subclass (`VscodeMemoryViewerProvider`,
 * `StandaloneMemoryViewerProvider`).
 */
export abstract class MemoryViewerProvider {
  protected panels = new Map<string, MemoryViewerPanel>();
  private readonly emulatorMessageListeners: Disposable[];
  private isEmulatorRunning = false;
  private panelCounter = 0;

  constructor(private readonly puaeEmulator: Emulator) {
    const onMessage = (message: EmulatorMessage) => {
      if (!isEmulatorStateMessage(message)) {
        return;
      }
      const wasRunning = this.isEmulatorRunning;
      this.isEmulatorRunning = message.state === "running";

      for (const panel of this.panels.values()) {
        if (panel.liveUpdate) {
          if (this.isEmulatorRunning && !wasRunning) {
            this.startLiveUpdate(panel);
          } else if (!this.isEmulatorRunning && wasRunning) {
            this.stopLiveUpdate(panel);
          }
        } else if (
          message.state === "paused" ||
          message.state === "stopped"
        ) {
          this.updateContent(panel, false).then(() =>
            this.refreshChunks(panel),
          );
        }
      }
    };
    this.emulatorMessageListeners = [
      this.puaeEmulator.onDidReceiveMessage(onMessage),
    ];
  }

  protected get emulator(): Emulator {
    return DebugAdapter.getActiveAdapter()?.getEmulator() ?? this.puaeEmulator;
  }

  /**
   * Disposes all memory viewer panels
   */
  public dispose(): void {
    for (const panel of this.panels.values()) {
      this.stopLiveUpdate(panel);
      this.removeWatchpoint(panel);
      panel.host.dispose();
    }
    this.panels.clear();
    for (const listener of this.emulatorMessageListeners) {
      listener.dispose();
    }
  }

  /**
   * Opens a new memory viewer at a specific address
   * @param addressInput Memory address input
   */
  public async show(addressInput: string): Promise<void> {
    const panelId = `memory-viewer-${this.panelCounter++}`;
    const surface = this.createPanelSurface(panelId);
    surface.setHtml(buildMemoryViewerHtml(surface.resolveUri, surface.cspMeta, surface.extraHeadHtml));

    const panel: MemoryViewerPanel = {
      id: panelId,
      host: surface.host,
      addressInput,
      liveUpdate: false,
      dereferencePointer: false,
      fetchedChunks: new Set(),
    };
    this.panels.set(panelId, panel);

    surface.host.onDidDispose(() => {
      this.stopLiveUpdate(panel);
      this.removeWatchpoint(panel);
      this.panels.delete(panelId);
    });

    surface.host.onDidReceiveMessage((rawMessage) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void this.handlePanelMessage(panel, rawMessage as any);
    });
  }

  private async handlePanelMessage(panel: MemoryViewerPanel, message: { command: string }): Promise<void> {
    switch (message.command) {
      case "ready": {
        const adapter = DebugAdapter.getActiveAdapter();
        if (!adapter) {
          return;
        }
        const msg: UpdateStateMessage = {
          command: "updateState",
          addressInput: panel.addressInput,
          availableRegions: this.getAvailableRegions(adapter),
          symbols: adapter.getSourceMap().getSymbols(),
          symbolLengths: adapter.getSourceMap().getSymbolLengths(),
          colorCodeHexBytes: this.getColorCodeHexBytes(),
        };
        // Send initial state once
        panel.host.postMessage(msg);

        // Update initial content
        await this.updateContent(panel);
        break;
      }

      case "changeAddress": {
        const changeAddressMsg = message as ChangeAddressMessage;
        panel.addressInput = changeAddressMsg.addressInput;
        panel.dereferencePointer =
          changeAddressMsg.dereferencePointer ?? false;
        await this.updateContent(panel);
        break;
      }
      case "requestMemory": {
        const requestMemoryMsg = message as RequeestMemoryMessage;
        await this.fetchMemoryChunk(
          panel,
          requestMemoryMsg.address,
          requestMemoryMsg.size,
        );
        break;
      }
      case "toggleLiveUpdate":
        panel.liveUpdate = (message as ToggleLiveUpdateMessage).enabled;
        if (panel.liveUpdate && this.isEmulatorRunning) {
          this.startLiveUpdate(panel);
        } else {
          this.stopLiveUpdate(panel);
        }
        break;
      case "goToSource": {
        const goToSourceMsg = message as GoToSourceMessage;
        this.openSource(goToSourceMsg.address);
        break;
      }
      case "toggleWatchpoint": {
        const toggleWatchpointMsg = message as ToggleWatchpointMessage;
        await this.toggleWatchpoint(panel, toggleWatchpointMsg.address);
        break;
      }
      case "exportMemory": {
        const exportMemoryMsg = message as ExportMemoryMessage;
        await this.exportMemory(
          panel.id,
          exportMemoryMsg.address,
          exportMemoryMsg.size,
        );
        break;
      }
      case "getSuggestions": {
        const getSuggestionsMsg = message as GetSuggestionsMessage;
        const adapter = DebugAdapter.getActiveAdapter();
        if (adapter) {
          const suggestions = this.getSymbolSuggestions(
            adapter,
            getSuggestionsMsg.query || "",
            getSuggestionsMsg.showAll || false,
          );
          panel.host.postMessage({
            command: "suggestionsData",
            suggestions,
          } as SuggestionsDataMessage);
        }
        break;
      }
    }
  }

  private async guessViewMode(
    panel: MemoryViewerPanel,
  ): Promise<ViewMode | undefined> {
    // Check custom register names
    if (panel.addressInput.match(/^COP[1-2]LC/i)) {
      return "copper";
    }
    if (
      panel.addressInput.match(/^BPL[1-8]PT/i) ||
      panel.addressInput.match(/^SPR[1-8]PT/i) ||
      panel.addressInput.match(/screen/i)
    ) {
      return "visual";
    }
    // Try to guess from source code
    const sourceMap = DebugAdapter.getActiveAdapter()?.getSourceMap();
    if (!sourceMap) {
      return;
    }
    const range = await this.evaluateAddressInput(panel);
    if (!range) {
      return;
    }
    const location = sourceMap.lookupAddress(range?.address);
    if (!location) {
      return;
    }
    // Read lines until we find a mnemonic
    const lines = await this.readSourceLines(location.path);
    for (let i = location.line - 1; i < location.line + 2 && i < lines.length; i++) {
      const { mnemonic, operands } = parseLine(lines[i] ?? "");
      if (!mnemonic) {
        continue;
      }
      if (
        mnemonic.value.match(/incbin/i) &&
        operands?.[0].value.match(/(image|img|sprite|\.spr|\.bpl)/i)
      ) {
        // INCBIN something image-like
        return "visual";
      }
      if (!["dc", "ds", "dcb", "blk"].includes(mnemonic.value)) {
        // Any non-data mnemonic
        return "disassembly";
      }
    }
  }

  /**
   * Sends state update to webview
   */
  protected sendStateToWebview(
    panel: MemoryViewerPanel,
    params: UpdateStateMessageProps,
  ): void {
    panel.host.postMessage({
      command: "updateState",
      ...params,
      error: null,
    } as UpdateStateMessage);
  }

  /**
   * Sends error message to webview
   */
  private sendErrorToWebview(panel: MemoryViewerPanel, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    panel.host.postMessage({
      command: "updateState",
      error: errorMessage,
    } as UpdateStateMessage);
  }

  /**
   * Evaluates the address expression and optionally dereferences it as a 32-bit pointer
   * @returns Memory range resulting from expression
   * @throws Error if address is invalid or dereferencing fails
   */
  private async evaluateAddressInput(
    panel: MemoryViewerPanel,
  ): Promise<MemoryRange | undefined> {
    const adapter = DebugAdapter.getActiveAdapter();
    if (!adapter) {
      throw new Error("Debugger is not running");
    }

    const { value, memoryReference, type } = await adapter
      .getEvaluateManager()
      .evaluate(panel.addressInput);
    if (type === EvaluateResultType.EMPTY) {
      return;
    }
    let address = memoryReference ? Number(memoryReference) : value;
    let size = 0;

    if (typeof address !== "number") {
      throw new Error("Does not evaluate to a numeric value");
    }
    if (!this.emulator.isValidAddress(address)) {
      throw new Error(`Not a valid address: ${formatHex(address)}`);
    }

    // Get symbol length if the input is a symbol name
    const sourceMap = adapter.getSourceMap();
    const symbols = sourceMap.getSymbols();
    const symbolLengths = sourceMap.getSymbolLengths();

    // Check if input matches a symbol name
    if (symbols && symbolLengths) {
      const symbolAddress = symbols[panel.addressInput];
      if (symbolAddress === address) {
        size = symbolLengths[panel.addressInput];
      }
    }

    // If dereferencePointer is enabled, read 32-bit value at this address
    if (panel.dereferencePointer) {
      const targetAddress = await this.emulator.peek32(address);
      if (!this.emulator.isValidAddress(targetAddress)) {
        throw new Error(
          `Pointer at ${formatHex(address)} points to invalid address: ${formatHex(targetAddress)}`,
        );
      }
      address = targetAddress;
    }

    return { address, size };
  }

  /**
   * Updates the memory viewer content state
   * @param sendUnchanged When false, skips sending the target to the webview if the address hasn't changed,
   *   avoiding unwanted scroll resets during pause/step refreshes.
   */
  private async updateContent(
    panel: MemoryViewerPanel,
    sendUnchanged = true,
  ): Promise<void> {
    try {
      // Evaluate address input
      const target = await this.evaluateAddressInput(panel);
      const title = target?.address !== undefined ? `Memory: ${panel.addressInput}` : "Memory Viewer";
      this.setPanelTitle(panel.id, title);
      const stateProps: UpdateStateMessageProps = { windowTitle: title };
      if (target?.address !== undefined) {
        const addressChanged = target.address !== panel.target?.address;
        if (sendUnchanged || addressChanged) {
          stateProps.target = target;
        }
      }
      this.sendStateToWebview(panel, stateProps);

      // Clear fetched map on target change
      // This should match what App does
      if (target?.address !== panel.target?.address) {
        panel.fetchedChunks.clear();
        const viewMode = await this.guessViewMode(panel);
        if (viewMode) {
          this.sendStateToWebview(panel, { viewMode });
        }

        // A memory-viewer watchpoint only lives as long as the current view -
        // navigating elsewhere removes it so nothing is left behind to find.
        if (panel.watchedAddress !== undefined) {
          await this.emulator.removeWatchpoint(panel.watchedAddress);
          panel.watchedAddress = undefined;
          this.sendStateToWebview(panel, { watchedAddress: null });
        }
      }
      panel.target = target;
    } catch (err) {
      this.sendErrorToWebview(panel, err);
    }
  }

  private async fetchMemoryChunk(
    panel: MemoryViewerPanel,
    address: number,
    size: number,
  ): Promise<void> {
    try {
      const result = await this.emulator.readMemory(address, size);
      const data = new Uint8Array(result);

      // Track fetched chunk
      panel.fetchedChunks.add(address);

      // Send to webview
      panel.host.postMessage({
        command: "memoryData",
        address,
        data,
      } as MemoryDataMessage);
    } catch (err) {
      console.error(
        `Failed to fetch memory chunk at ${address.toString(16)}:`,
        err,
      );
    }
  }

  /**
   * Sets or clears the panel's watchpoint at the given address.
   *
   * A memory-viewer watchpoint only lives as long as the current view: there's
   * at most one per panel, and it's automatically removed when the user
   * navigates to a different address or closes the panel (see `updateContent`
   * and the panel dispose handlers). This keeps the feature self-cleaning -
   * nothing can be left behind for the user to hunt down.
   */
  private async toggleWatchpoint(
    panel: MemoryViewerPanel,
    address: number,
  ): Promise<void> {
    try {
      if (panel.watchedAddress === address) {
        await this.emulator.removeWatchpoint(address);
        panel.watchedAddress = undefined;
        this.sendStateToWebview(panel, { watchedAddress: null });
      } else {
        if (panel.watchedAddress !== undefined) {
          await this.emulator.removeWatchpoint(panel.watchedAddress);
        }
        await this.emulator.setWatchpoint(address);
        panel.watchedAddress = address;
        this.sendStateToWebview(panel, { watchedAddress: address });
      }
    } catch (err) {
      this.notifyError(`Failed to set watchpoint: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Removes the panel's watchpoint, if any (used when the panel is closed).
   */
  private removeWatchpoint(panel: MemoryViewerPanel): void {
    if (panel.watchedAddress !== undefined) {
      void this.emulator.removeWatchpoint(panel.watchedAddress).catch((error) => {
        console.error("Failed to remove memory viewer watchpoint:", error);
      });
      panel.watchedAddress = undefined;
    }
  }

  /**
   * Starts live updates at ~25fps when emulator is running
   */
  private startLiveUpdate(panel: MemoryViewerPanel): void {
    if (panel.liveUpdateInterval) {
      return; // Already running
    }

    panel.liveUpdateInterval = setInterval(() => {
      if (panel.liveUpdate && this.isEmulatorRunning) {
        this.refreshChunksSingleFlight(panel);
      }
    }, LIVE_UPDATE_RATE_MS);
  }

  /**
   * Stops live updates
   */
  private stopLiveUpdate(panel: MemoryViewerPanel): void {
    if (panel.liveUpdateInterval) {
      clearInterval(panel.liveUpdateInterval);
      panel.liveUpdateInterval = undefined;
    }
  }

  /** Starts a refresh only when this panel does not already have one in flight. */
  private refreshChunksSingleFlight(panel: MemoryViewerPanel): void {
    if (panel.liveUpdateRefresh) {
      return;
    }

    const refresh = this.refreshChunks(panel);
    panel.liveUpdateRefresh = refresh;
    const clearRefresh = () => {
      if (panel.liveUpdateRefresh === refresh) {
        panel.liveUpdateRefresh = undefined;
      }
    };
    void refresh.then(clearRefresh, (error) => {
      clearRefresh();
      console.error("Failed to refresh memory viewer:", error);
    });
  }

  // Re-send all previously fetched chunks
  // TODO: is it better to just send clear event? Set can grow large
  private async refreshChunks(panel: MemoryViewerPanel) {
    for (const address of panel.fetchedChunks.values()) {
      try {
        const result = await this.emulator.readMemory(address, CHUNK_SIZE);

        // Send updated chunk to webview
        panel.host.postMessage({
          command: "memoryData",
          address,
          data: new Uint8Array(result),
        });
      } catch (err) {
        console.error(
          `Failed to fetch memory chunk at ${address.toString(16)}:`,
          err,
        );
      }
    }
  }

  /**
   * Gets symbol name suggestions based on query string
   */
  private getSymbolSuggestions(
    adapter: DebugAdapter,
    query: string,
    showAll: boolean = false,
  ): Suggestion[] {
    const suggestions: Array<{
      label: string;
      address: string;
      description?: string;
    }> = [];
    const queryLower = query.toLowerCase();

    // Get symbols from source map
    const sourceMap = adapter.getSourceMap();
    const symbols = sourceMap.getSymbols();

    for (const symbolName in symbols) {
      const symbolAddress = symbols[symbolName];

      // Filter by query if provided
      if (
        !query ||
        symbolName.toLowerCase().includes(queryLower) ||
        symbolName.toLowerCase().startsWith(queryLower)
      ) {
        // Find which segment this symbol belongs to
        const segment = sourceMap.findSegmentForAddress(symbolAddress);

        suggestions.push({
          label: symbolName,
          address: formatHex(symbolAddress),
          description: segment?.name,
        });

        // Only apply limit when not showing all
        if (!showAll && suggestions.length >= SUGGESTIONS_LIMIT) break;
      }
    }

    // Sort by name
    suggestions.sort((a, b) => a.label.localeCompare(b.label));

    return suggestions;
  }

  private getAvailableRegions(adapter: DebugAdapter): MemoryRegion[] {
    // Add segments from source map
    const regions: MemoryRegion[] = adapter
      .getSourceMap()
      .getSegmentsInfo()
      .map((seg) => ({
        name: seg.name,
        range: {
          address: seg.address,
          size: seg.size,
        },
      }));

    // Add memory regions
    const memInfo = this.emulator.getCachedMemoryInfo();
    if (memInfo) {
      let currentType: MemSrc | null = null;
      let currentStart = 0;

      for (let bank = 0; bank <= 255; bank++) {
        const type: MemSrc = memInfo.cpuMemSrc[bank];

        if (type !== MemSrc.NONE && type !== currentType) {
          // Save previous region
          if (currentType !== null) {
            regions.push({
              name: memTypeLabels[currentType],
              range: {
                address: currentStart,
                size: (bank << 16) - currentStart,
              },
            });
          }
          currentType = type;
          currentStart = bank << 16;
        } else if (type === MemSrc.NONE && currentType !== null) {
          // End of region
          regions.push({
            name: memTypeLabels[currentType],
            range: {
              address: currentStart,
              size: (bank << 16) - currentStart,
            },
          });
          currentType = null;
        }
      }

      // Handle last region
      if (currentType !== null) {
        regions.push({
          name: memTypeLabels[currentType],
          range: {
            address: currentStart,
            size: (256 << 16) - currentStart,
          },
        });
      }
    }

    return regions;
  }

  // --- Host-specific hooks ---

  protected abstract createPanelSurface(panelId: string): MemoryPanelSurface;
  protected abstract setPanelTitle(panelId: string, title: string): void;
  /** `panelId` — which panel's postMessage channel to reply to (e.g. to trigger a download
   * in the standalone host); vscode's implementation ignores it, since a native save dialog
   * isn't tied to any particular panel. */
  protected abstract exportMemory(panelId: string, address: number, size: number): Promise<void>;
  protected abstract notifyError(message: string): void;

  /** Opens a source location in whatever the host's "editor" concept is. No-op by default. */
  protected openSource(_address: number): void {}

  /** Reads `path`'s lines for guessViewMode's mnemonic sniffing. Absolute paths only by
   * default (no workspace-folder concept); empty array means "not found". */
  protected async readSourceLines(path: string): Promise<string[]> {
    try {
      if (!isAbsolute(path)) return [];
      return readFileSync(path, "utf8").split(/\r?\n/);
    } catch {
      return [];
    }
  }

  /** Reads the configured "color-code hex bytes" preference. `true` by default (vscode
   * overrides via its own setting, defaulting to the same value). */
  protected getColorCodeHexBytes(): boolean {
    return true;
  }
}

export function buildMemoryViewerHtml(
  resolveUri: (file: string) => string,
  cspMeta: string,
  extraHeadHtml: string = "",
): string {
  const scriptUri = resolveUri("out/memoryViewer.js");
  const styleUri = resolveUri("out/memoryViewer.css");
  const codiconsUri = resolveUri("node_modules/@vscode/codicons/dist/codicon.css");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${cspMeta}
  ${extraHeadHtml}
  <title>Memory Viewer</title>
  <link rel="stylesheet" href="${codiconsUri}">
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div id="root"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
