import { readFileSync } from "fs";
import { basename, isAbsolute } from "path";
import { DebugAdapter } from "./debugAdapter";
import { ProfilerManager, ProfilerRpcClient, FrameCapture } from "./profilerManager";
import { encodeCapture } from "./profileFormat";
import { ProfilerCodeLensProvider } from "./profilerCodeLensProvider";
import { ProfilerLineDecorationProvider } from "./profilerLineDecorationProvider";
import { ProfilerInboundMessage, ProfilerOutboundMessage, IProfileModel, CaptureFrameInfo, ComputeRangeMessage } from "./shared/profilerTypes";
import { WebviewHost } from "./webviewHost";

/** A concrete host's UI surface for one `show()` — mirrors `PuaeSurface` (puaeEmulator.ts). */
export interface ProfilerSurface {
  resolveUri(file: string): string;
  cspMeta: string;
  /** See buildProfilerHtml's extraHeadHtml param. "" for vscode. */
  extraHeadHtml: string;
  host: WebviewHost;
  setHtml(html: string): void;
}

/**
 * Webview panel for the CPU profiler: captures N frames of CPU execution, builds
 * symbolicated call trees, and renders a flame graph with a per-frame filmstrip.
 * Capture is user-triggered (it advances the emulator), not automatic.
 *
 * Host-agnostic: creating/attaching the actual `WebviewHost`, writing the
 * per-frame "bulk" binary blobs (DMA grid/snapshot/JPEGs — shipped via a
 * fetched URL rather than postMessage, which is slow for large binary — see
 * `uint8ToBase64`'s comment in `shared/base64.ts`), saving a captured profile,
 * and opening source/showing notifications are all delegated to a concrete
 * subclass (`VscodeProfilerViewerProvider`, `StandaloneProfilerViewerProvider`).
 */
export abstract class ProfilerViewerProvider {
  protected host?: WebviewHost;
  protected readonly manager: ProfilerManager;
  // Last successful capture, kept here so a webview reload re-shows it
  // without advancing the emulator (a reload resets webview state, not this).
  protected lastFrames: FrameCapture[] = [];
  protected lastBulkUris: string[] = [];
  // Opaque per-host handles for cleanup (e.g. a file path) — parallel to lastBulkUris.
  protected lastBulkCleanupHandles: string[] = [];
  // Everything Save needs, grabbed at capture time while the debug session is live.
  private lastSaveData?: { elf: Uint8Array; programName: string; segmentOffsets: number[]; baseDir: string; kickstart: { sha1: string; name: string } };
  private lastSaveAdapter?: DebugAdapter;
  protected symbolsSent = false; // symbols are session-constant — send them only once per webview mount
  private capturing = false;     // a frame capture is in flight (drops re-entrant requests)
  private numFrames = 1;         // updated by "setNumFrames" from the webview toolbar

  constructor(
    getClient: () => ProfilerRpcClient | undefined,
    private readonly codeLens?: ProfilerCodeLensProvider,
    private readonly lineDecorations?: ProfilerLineDecorationProvider,
  ) {
    this.manager = new ProfilerManager(getClient, () => {
      try {
        return DebugAdapter.getActiveAdapter()?.getSourceMap();
      } catch {
        return undefined;
      }
    });
  }

  public dispose(): void {
    this.host?.dispose();
  }

  private resetCapture(): void {
    for (const handle of this.lastBulkCleanupHandles) this.deleteBulkFile(handle);
    this.lastFrames = [];
    this.lastBulkUris = [];
    this.lastBulkCleanupHandles = [];
    this.symbolsSent = false;
    this.lastSaveData = undefined;
    this.lastSaveAdapter = undefined;
    this.codeLens?.clear();
    this.lineDecorations?.clear();
  }

  // Reveals the panel/tab and asks the webview to jump to the next execution of a source
  // line, opening the CPU tab — see puae-debugger.jumpToProfilerExecution in extension.ts.
  // Unlike show(), this deliberately does NOT trigger a fresh capture: the line decorations
  // the command originates from reflect whatever model is ALREADY loaded, and starting a new
  // capture would jump into different (unrelated) execution data. Returns false if no host is
  // attached yet, so the caller can tell the user to open it first rather than the jump
  // silently no-oping.
  public jumpToLine(file: string, line: number): boolean {
    if (!this.host) return false;
    this.host.reveal();
    this.post({ command: "jumpToExecutionAtLine", file, line });
    return true;
  }

  public async show(): Promise<void> {
    if (this.host) {
      this.host.reveal();
      await this.capture();
      return;
    }

    this.resetCapture();

    const surface = this.createSurface();
    surface.setHtml(buildProfilerHtml(surface.resolveUri, surface.cspMeta, "live", surface.extraHeadHtml));
    this.attachHost(surface.host);
  }

  private attachHost(host: WebviewHost): void {
    this.host = host;
    host.onDidDispose(() => {
      if (this.host === host) {
        this.host = undefined;
      }
      this.resetCapture();
    });
    host.onDidReceiveMessage((message) => void this.handleMessage(message as ProfilerInboundMessage));
  }

  private async handleMessage(message: ProfilerInboundMessage): Promise<void> {
    if (message.command === "ready") {
      this.symbolsSent = false;
      this.numFrames = 1; // webview always resets its UI to 1 on mount — keep provider in sync
      if (this.lastFrames.length > 0) this.postResult(this.lastFrames, this.lastBulkUris);
      else await this.capture();
    } else if (message.command === "capture") {
      await this.capture();
    } else if (message.command === "setNumFrames") {
      const n = message.numFrames;
      if (Number.isInteger(n) && n >= 1 && n <= 500) this.numFrames = n;
    } else if (message.command === "computeRange") {
      this.computeRange(message as ComputeRangeMessage);
    } else if (message.command === "saveProfile") {
      await this.saveProfileRequest();
    } else if (message.command === "openDocument") {
      this.openSource(message.file, message.line, message.toSide);
    } else if (message.command === "readSourceFile") {
      const lines = await this.readSourceFile(message.file);
      this.post({ command: "sourceFile", file: message.file, lines });
    } else if (message.command === "setGlobalHeat") {
      this.lineDecorations?.setGlobalHeat(message.enabled);
    }
  }

  private post(message: ProfilerOutboundMessage): void {
    this.host?.postMessage(message);
  }

  private postResult(frames: FrameCapture[], bulkUris: string[]): void {
    const { frames: result, combinedModel, symbolsNowSent } = stripFramesForPost(frames, this.symbolsSent, bulkUris);
    this.symbolsSent = symbolsNowSent;
    this.post({ command: "captureResult", frames: result, combinedModel, workspaceRoot: this.workspaceRoot() });
  }

  private computeRange(message: ComputeRangeMessage): void {
    const model = this.manager.buildRangeModel(message.range);
    if (!model) return;
    const stripped: IProfileModel = { ...model, dma: undefined, dmaSnapshot: undefined, registers: undefined };
    if (this.symbolsSent) stripped.symbols = undefined;
    this.post({ command: "rangeResult", model: stripped });
  }

  private async capture(): Promise<void> {
    if (this.capturing) return;
    this.capturing = true;
    this.post({ command: "capturing" });
    try {
      const frames = await this.manager.capture(this.numFrames);
      this.lastFrames = frames;
      this.codeLens?.update(frames[0].model);
      this.lineDecorations?.update(frames[0].model);
      this.cacheSaveData();
      if (this.host) {
        const { uris, cleanupHandles } = await this.writeBulkFiles(frames);
        this.lastBulkUris = uris;
        this.lastBulkCleanupHandles = cleanupHandles;
      } else {
        this.lastBulkUris = [];
        this.lastBulkCleanupHandles = [];
      }
      this.postResult(frames, this.lastBulkUris);
    } catch (error) {
      this.post({
        command: "showError",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.capturing = false;
    }
  }

  private cacheSaveData(): void {
    const adapter = DebugAdapter.getActiveAdapter();
    const elfPath = adapter?.getDebugProgramPath();
    if (!adapter || !elfPath) return;
    if (adapter === this.lastSaveAdapter && this.lastSaveData) return;
    try {
      const elf = readFileSync(elfPath);
      const reloc = adapter.getRelocation();
      this.lastSaveData = {
        elf,
        programName: basename(elfPath),
        segmentOffsets: reloc.segmentOffsets,
        baseDir: reloc.baseDir,
        kickstart: adapter.getKickstartInfo(),
      };
      this.lastSaveAdapter = adapter;
    } catch (error) {
      console.warn("[profiler] couldn't read program ELF for save:", error);
    }
  }

  private async saveProfileRequest(): Promise<void> {
    const raws = this.manager.getAllRaw();
    if (!raws) {
      this.notifyWarning("Profiler: nothing to save yet — capture a frame first.");
      return;
    }
    const save = this.lastSaveData;
    if (!save) {
      this.notifyError(
        "Profiler: can't save — the program couldn't be read when this frame was captured. Re-capture with the debug session active.",
      );
      return;
    }
    try {
      const buf = encodeCapture(raws, {
        elf: save.elf,
        programName: save.programName,
        capturedAt: Date.now(),
        segmentOffsets: save.segmentOffsets,
        baseDir: save.baseDir,
        kickstart: save.kickstart,
      });
      const suggestedFileName = save.programName.replace(/\.[^.]+$/, "") + ".puaeprofile";
      await this.saveProfile(buf, suggestedFileName);
    } catch (error) {
      this.notifyError(`Profiler: couldn't save profile: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // --- Host-specific hooks ---

  protected abstract createSurface(): ProfilerSurface;
  protected abstract writeBulkFiles(frames: FrameCapture[]): Promise<{ uris: string[]; cleanupHandles: string[] }>;
  protected abstract deleteBulkFile(handle: string): void;
  /** Persist `bytes` (an encoded .puaeprofile) somewhere the user can get it — a native save
   * dialog + "open in the profile editor" (vscode), or a browser download (standalone). */
  protected abstract saveProfile(bytes: Uint8Array, suggestedFileName: string): Promise<void>;
  protected abstract notifyWarning(message: string): void;
  protected abstract notifyError(message: string): void;

  /** Opens a source location in whatever the host's "editor" concept is. No-op by default. */
  protected openSource(_file: string, _line: number, _toSide?: boolean): void {}

  /** A workspace/project root for shortening displayed paths. None by default. */
  protected workspaceRoot(): string | undefined {
    return undefined;
  }

  /** Literal line-by-line text for `file`, for the DisassemblyView "Show source" preview.
   * Absolute paths only by default (no workspace-folder concept) — an empty array (rather
   * than throwing) means "not found", which the webview renders as a placeholder. */
  protected async readSourceFile(file: string): Promise<string[]> {
    try {
      if (!isAbsolute(file)) return [];
      return readFileSync(file, "utf8").split(/\r?\n/);
    } catch {
      return [];
    }
  }
}

// Strips per-frame data (DMA/copper/registers — fetched separately via bulkUri instead) from
// every frame's model for the captureResult postMessage, and builds the combined-model payload
// (multi-frame captures only). Symbols are session-constant, so they're included only once per
// webview mount: `symbolsAlreadySent` gates that, and the caller should persist the returned
// `symbolsNowSent` for the next call. Shared by the live panel and the .puaeprofile editor.
export function stripFramesForPost(
  frames: FrameCapture[],
  symbolsAlreadySent: boolean,
  bulkUris: string[],
): { frames: CaptureFrameInfo[]; combinedModel?: IProfileModel; symbolsNowSent: boolean } {
  let symbolsNowSent = symbolsAlreadySent;
  const result: CaptureFrameInfo[] = frames.map((f, i) => {
    const stripped: IProfileModel = { ...f.model, dma: undefined, dmaSnapshot: undefined, registers: undefined };
    // Symbols are session-constant — include only on the first post per webview mount.
    if (i === 0 && !symbolsAlreadySent) {
      if (f.model.symbols) symbolsNowSent = true;
    } else {
      stripped.symbols = undefined;
    }
    return { model: stripped, bulkUri: bulkUris[i] || undefined, duplicateOfPrevious: f.raw.duplicateOfPrevious };
  });
  // Include the combined model when present (multi-frame captures only).
  // Strip per-frame data (DMA/copper/registers) — combined view shows CPU/time data only.
  let combinedModel: IProfileModel | undefined;
  if (frames[0]?.combined) {
    const c = frames[0].combined;
    combinedModel = { ...c, dma: undefined, dmaSnapshot: undefined, registers: undefined };
    // Symbols are already on the combined model (copied from frame 0 in profilerManager);
    // suppress them if we already sent them this session to avoid a redundant transfer.
    if (symbolsNowSent) combinedModel.symbols = undefined;
  }
  return { frames: result, combinedModel, symbolsNowSent };
}

// Pure HTML templating, parameterized the same way PuaeEmulator.buildHtml is: `resolveUri` maps
// a path relative to the repo/extension root to a loadable URL (a webview.asWebviewUri() result
// in the vscode host, or a plain server-relative path in the standalone host); `cspMeta` is a
// complete <meta http-equiv="Content-Security-Policy" ...> tag, or "" to omit one entirely.
// `extraHeadHtml` is arbitrary extra <head> content — the standalone host uses it to link
// puae/vscodeDefaultTheme.css (vscode injects the user's real theme as --vscode-* CSS variables
// into every webview automatically; nothing does that for a plain browser tab), "" elsewhere.
export function buildProfilerHtml(
  resolveUri: (file: string) => string,
  cspMeta: string,
  mode: "live" | "file",
  extraHeadHtml: string = "",
): string {
  const scriptUri = resolveUri("out/profilerViewer.js");
  const styleUri = resolveUri("out/profilerViewer.css");
  const codiconsUri = resolveUri("node_modules/@vscode/codicons/dist/codicon.css");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${cspMeta}
  ${extraHeadHtml}
  <link href="${codiconsUri}" rel="stylesheet" id="vscode-codicon-stylesheet" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Profiler</title>
</head>
<body>
  <div id="root" data-mode="${mode}"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
