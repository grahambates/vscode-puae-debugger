import * as vscode from "vscode";
import * as path from "path";
import { DebugAdapter } from "./debugAdapter";
import { ProfilerManager, ProfilerRpcClient, FrameCapture } from "./profilerManager";
import { encodeCapture } from "./profileFormat";
import { packBulk } from "./profilerBulk";
import { ProfileEditorProvider } from "./profileEditorProvider";
import { ProfilerCodeLensProvider } from "./profilerCodeLensProvider";
import { ProfilerLineDecorationProvider } from "./profilerLineDecorationProvider";
import { ProfilerInboundMessage, ProfilerOutboundMessage, IProfileModel, CaptureFrameInfo, ComputeRangeMessage } from "./shared/profilerTypes";

/**
 * Webview panel for the CPU profiler: captures N frames of CPU execution, builds
 * symbolicated call trees, and renders a flame graph with a per-frame filmstrip.
 * Capture is user-triggered (it advances the emulator), not automatic.
 */
export class ProfilerViewerProvider {
  public static readonly viewType = "puae-debugger.profilerViewer";

  private panel?: vscode.WebviewPanel;
  private readonly manager: ProfilerManager;
  // Last successful capture, kept extension-side so a webview reload re-shows it
  // without advancing the emulator (a reload resets webview state, not the extension host).
  private lastFrames: FrameCapture[] = [];
  private lastBulkUris: string[] = [];
  private lastBulkFileUris: vscode.Uri[] = []; // parallel to lastBulkUris, for cleanup on reset
  // Everything Save needs, grabbed at capture time while the debug session is live.
  private lastSaveData?: { elf: Uint8Array; programName: string; segmentOffsets: number[]; baseDir: string; kickstart: { sha1: string; name: string } };
  private lastSaveAdapter?: DebugAdapter;
  private symbolsSent = false; // symbols are session-constant — send them only once per webview mount
  private capturing = false;   // a frame capture is in flight (drops re-entrant requests)
  private numFrames = 1;       // updated by "setNumFrames" from the webview toolbar

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly storageUri: vscode.Uri,
    private readonly getClient: () => ProfilerRpcClient | undefined,
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
    this.panel?.dispose();
  }

  private resetCapture(): void {
    for (const fileUri of this.lastBulkFileUris) {
      void vscode.workspace.fs.delete(fileUri).then(undefined, () => undefined);
    }
    this.lastFrames = [];
    this.lastBulkUris = [];
    this.lastBulkFileUris = [];
    this.symbolsSent = false;
    this.lastSaveData = undefined;
    this.lastSaveAdapter = undefined;
    this.codeLens?.clear();
    this.lineDecorations?.clear();
  }

  // Reveals the panel and asks the webview to jump to the next execution of a source line,
  // opening the CPU tab — see puae-debugger.jumpToProfilerExecution in extension.ts. Unlike
  // show(), this deliberately does NOT trigger a fresh capture: the line decorations the command
  // originates from reflect whatever model is ALREADY loaded, and starting a new capture would
  // jump into different (unrelated) execution data. Returns false if the panel isn't currently
  // open, so the caller can tell the user to open it first rather than the jump silently no-oping.
  public jumpToLine(file: string, line: number): boolean {
    if (!this.panel) return false;
    this.panel.reveal();
    this.post({ command: "jumpToExecutionAtLine", file, line });
    return true;
  }

  public async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      await this.capture();
      return;
    }

    this.resetCapture();

    this.panel = vscode.window.createWebviewPanel(
      ProfilerViewerProvider.viewType,
      "Profiler",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.extensionUri, this.storageUri] },
    );

    this.panel.webview.html = getProfilerHtml(this.panel.webview, this.extensionUri, "live");
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.resetCapture();
    });

    this.panel.webview.onDidReceiveMessage(async (message: ProfilerInboundMessage) => {
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
        await this.saveProfile();
      } else if (message.command === "openDocument") {
        await openProfilerSource(message.file, message.line, message.toSide);
      } else if (message.command === "readSourceFile") {
        const lines = await readProfilerSourceFile(message.file);
        this.post({ command: "sourceFile", file: message.file, lines });
      }
    });
  }

  private post(message: ProfilerOutboundMessage): void {
    this.panel?.webview.postMessage(message);
  }

  private postResult(frames: FrameCapture[], bulkUris: string[]): void {
    const { frames: result, combinedModel, symbolsNowSent } = stripFramesForPost(frames, this.symbolsSent, bulkUris);
    this.symbolsSent = symbolsNowSent;
    this.post({ command: "captureResult", frames: result, combinedModel, workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath });
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
      await this.cacheSaveData();
      if (this.panel) {
        const { uris, fileUris } = await writeBulkFiles(this.storageUri, this.panel.webview, frames, (i) => `profiler-live-bulk-${i}.bin`);
        this.lastBulkUris = uris;
        this.lastBulkFileUris = fileUris;
      } else {
        this.lastBulkUris = [];
        this.lastBulkFileUris = [];
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

  private async cacheSaveData(): Promise<void> {
    const adapter = DebugAdapter.getActiveAdapter();
    const elfPath = adapter?.getDebugProgramPath();
    if (!adapter || !elfPath) return;
    if (adapter === this.lastSaveAdapter && this.lastSaveData) return;
    try {
      const elf = await vscode.workspace.fs.readFile(vscode.Uri.file(elfPath));
      const reloc = adapter.getRelocation();
      this.lastSaveData = {
        elf,
        programName: path.basename(elfPath),
        segmentOffsets: reloc.segmentOffsets,
        baseDir: reloc.baseDir,
        kickstart: adapter.getKickstartInfo(),
      };
      this.lastSaveAdapter = adapter;
    } catch (error) {
      console.warn("[profiler] couldn't read program ELF for save:", error);
    }
  }

  private async saveProfile(): Promise<void> {
    const raws = this.manager.getAllRaw();
    if (!raws) {
      vscode.window.showWarningMessage("Profiler: nothing to save yet — capture a frame first.");
      return;
    }
    const save = this.lastSaveData;
    if (!save) {
      vscode.window.showErrorMessage(
        "Profiler: can't save — the program couldn't be read when this frame was captured. Re-capture with the debug session active.",
      );
      return;
    }

    const folder = vscode.workspace.workspaceFolders?.[0];
    const base = save.programName.replace(/\.[^.]+$/, "") + ".puaeprofile";
    const target = await vscode.window.showSaveDialog({
      defaultUri: folder ? vscode.Uri.joinPath(folder.uri, base) : undefined,
      filters: { "PUAE Profile": ["puaeprofile"] },
      saveLabel: "Save Profile",
    });
    if (!target) return;

    try {
      const buf = encodeCapture(raws, {
        elf: save.elf,
        programName: save.programName,
        capturedAt: Date.now(),
        segmentOffsets: save.segmentOffsets,
        baseDir: save.baseDir,
        kickstart: save.kickstart,
      });
      await vscode.workspace.fs.writeFile(target, buf);
      await vscode.commands.executeCommand("vscode.openWith", target, ProfileEditorProvider.viewType);
      this.dispose();
    } catch (error) {
      vscode.window.showErrorMessage(
        `Profiler: couldn't save profile: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

}

// Writes one bulk blob (DMA grid + snapshot + JPEGs, see profilerBulk.ts) per frame to
// `storageUri`, named by the caller-supplied `fileName` (so the live panel and the .puaeprofile
// editor — which can have several tabs open at once — don't collide with each other's files).
// Returns both the webview-fetchable URIs (for the captureResult/ready postMessage) and the
// underlying file URIs (so the caller can delete them later, e.g. on panel/tab dispose).
// Shared by the live panel and the .puaeprofile editor.
export async function writeBulkFiles(
  storageUri: vscode.Uri,
  webview: vscode.Webview,
  frames: FrameCapture[],
  fileName: (frameIndex: number) => string,
): Promise<{ uris: string[]; fileUris: vscode.Uri[] }> {
  await vscode.workspace.fs.createDirectory(storageUri);
  const v = Date.now();
  const uris: string[] = [];
  const fileUris: vscode.Uri[] = [];
  for (let i = 0; i < frames.length; i++) {
    const bytes = packBulk(frames[i].raw);
    if (!bytes) { uris.push(""); continue; }
    const fileUri = vscode.Uri.joinPath(storageUri, fileName(i));
    await vscode.workspace.fs.writeFile(fileUri, bytes);
    fileUris.push(fileUri);
    uris.push(`${webview.asWebviewUri(fileUri)}?v=${v}`);
  }
  return { uris, fileUris };
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

// Resolve a model-carried `file` path (as seen in ins.file / node.callFrame.url) to a URI:
// absolute paths open directly; relative paths (e.g. a loaded .puaeprofile whose SourceMap was
// rebuilt against a baseDir that isn't this machine's absolute layout) resolve against the first
// workspace folder. Shared by jump-to-source and the "Show source" preview text fetch below, and
// by both the live panel and the .puaeprofile editor.
function resolveSourceUri(file: string): vscode.Uri | undefined {
  if (path.isAbsolute(file)) return vscode.Uri.file(file);
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? vscode.Uri.joinPath(folder.uri, file) : undefined;
}

// Ctrl/Cmd+click in the flame graph: open the function's source at `line` (1-based, as
// carried in the model). Shared by the live panel and the .puaeprofile editor.
export async function openProfilerSource(file: string, line: number, toSide?: boolean): Promise<void> {
  try {
    const uri = resolveSourceUri(file);
    if (!uri) return;
    const doc = await vscode.workspace.openTextDocument(uri);
    const l = Math.max(0, line - 1);
    const existing = findOpenColumn(uri);
    await vscode.window.showTextDocument(doc, {
      selection: new vscode.Range(l, 0, l + 1, 0),
      viewColumn: existing ?? (toSide ? vscode.ViewColumn.Beside : undefined),
      preserveFocus: true,
    });
  } catch (error) {
    vscode.window.showWarningMessage(
      `Profiler: couldn't open ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Backs the DisassemblyView "Show source" preview's readSourceFile RPC: literal line-by-line
// text for `file`, resolved the same way jump-to-source is (see resolveSourceUri) — an empty
// array (rather than throwing) means "not found", which the webview renders as a placeholder.
// Shared by the live panel and the .puaeprofile editor.
export async function readProfilerSourceFile(file: string): Promise<string[]> {
  try {
    const uri = resolveSourceUri(file);
    if (!uri) return [];
    const data = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(data).toString("utf8").split(/\r?\n/);
  } catch {
    return [];
  }
}

function findOpenColumn(uri: vscode.Uri): vscode.ViewColumn | undefined {
  const target = uri.toString();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === target) {
        return group.viewColumn;
      }
    }
  }
  return undefined;
}

export function getProfilerHtml(webview: vscode.Webview, extensionUri: vscode.Uri, mode: "live" | "file"): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "out", "profilerViewer.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "out", "profilerViewer.css"));
  const codiconsUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "node_modules", "@vscode/codicons", "dist", "codicon.css"),
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src ${webview.cspSource}; connect-src ${webview.cspSource}; img-src blob:;">
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
