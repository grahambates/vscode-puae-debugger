import * as vscode from "vscode";
import * as path from "path";
import { VamigaDebugAdapter } from "./vAmigaDebugAdapter";
import { ProfilerManager, ProfilerRpcClient, FrameCapture } from "./profilerManager";
import { encodeCapture } from "./vamigaProfile";
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
  public static readonly viewType = "vamiga-debugger.profilerViewer";

  private panel?: vscode.WebviewPanel;
  private readonly manager: ProfilerManager;
  // Last successful capture, kept extension-side so a webview reload re-shows it
  // without advancing the emulator (a reload resets webview state, not the extension host).
  private lastFrames: FrameCapture[] = [];
  private lastBulkUris: string[] = [];
  // Everything Save needs, grabbed at capture time while the debug session is live.
  private lastSaveData?: { elf: Uint8Array; programName: string; segmentOffsets: number[]; baseDir: string; kickstart: { sha1: string; name: string } };
  private lastSaveAdapter?: VamigaDebugAdapter;
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
        return VamigaDebugAdapter.getActiveAdapter()?.getSourceMap();
      } catch {
        return undefined;
      }
    });
  }

  public dispose(): void {
    this.panel?.dispose();
  }

  private resetCapture(): void {
    for (let i = 0; i < this.lastBulkUris.length; i++) {
      void vscode.workspace.fs.delete(this.bulkFileUri(i)).then(undefined, () => undefined);
    }
    this.lastFrames = [];
    this.lastBulkUris = [];
    this.symbolsSent = false;
    this.lastSaveData = undefined;
    this.lastSaveAdapter = undefined;
    this.codeLens?.clear();
    this.lineDecorations?.clear();
  }

  private bulkFileUri(index: number): vscode.Uri {
    return vscode.Uri.joinPath(this.storageUri, `profiler-live-bulk-${index}.bin`);
  }

  private async writeAllBulks(frames: FrameCapture[]): Promise<string[]> {
    if (!this.panel) return [];
    await vscode.workspace.fs.createDirectory(this.storageUri);
    const v = Date.now();
    const uris: string[] = [];
    for (let i = 0; i < frames.length; i++) {
      const bytes = packBulk(frames[i].raw);
      if (!bytes) { uris.push(""); continue; }
      const fileUri = this.bulkFileUri(i);
      await vscode.workspace.fs.writeFile(fileUri, bytes);
      uris.push(`${this.panel.webview.asWebviewUri(fileUri)}?v=${v}`);
    }
    return uris;
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
        try {
          const data = await vscode.workspace.fs.readFile(vscode.Uri.file(message.file));
          const lines = Buffer.from(data).toString("utf8").split(/\r?\n/);
          this.post({ command: "sourceFile", file: message.file, lines });
        } catch {
          this.post({ command: "sourceFile", file: message.file, lines: [] });
        }
      }
    });
  }

  private post(message: ProfilerOutboundMessage): void {
    this.panel?.webview.postMessage(message);
  }

  private postResult(frames: FrameCapture[], bulkUris: string[]): void {
    const result: CaptureFrameInfo[] = frames.map((f, i) => {
      const stripped: IProfileModel = { ...f.model, dma: undefined, dmaSnapshot: undefined, registers: undefined };
      // Symbols are session-constant — include only on the first post per webview mount.
      if (i === 0 && !this.symbolsSent) {
        if (f.model.symbols) this.symbolsSent = true;
      } else {
        stripped.symbols = undefined;
      }
      return { model: stripped, bulkUri: bulkUris[i] || undefined };
    });
    // Include the combined model when present (multi-frame captures only).
    // Strip per-frame data (DMA/copper/registers) — combined view shows CPU/time data only.
    let combinedModel: IProfileModel | undefined;
    if (frames[0]?.combined) {
      const c = frames[0].combined;
      combinedModel = { ...c, dma: undefined, dmaSnapshot: undefined, registers: undefined };
      // Symbols are already on the combined model (copied from frame 0 in profilerManager);
      // suppress them if we already sent them this session to avoid a redundant transfer.
      if (this.symbolsSent) combinedModel.symbols = undefined;
    }
    this.post({ command: "captureResult", frames: result, combinedModel });
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
      this.lastBulkUris = await this.writeAllBulks(frames);
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
    const adapter = VamigaDebugAdapter.getActiveAdapter();
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
    const raw = this.manager.getLastRaw();
    if (!raw) {
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
    const base = save.programName.replace(/\.[^.]+$/, "") + ".vamigaprofile";
    const target = await vscode.window.showSaveDialog({
      defaultUri: folder ? vscode.Uri.joinPath(folder.uri, base) : undefined,
      filters: { "vAmiga Profile": ["vamigaprofile"] },
      saveLabel: "Save Profile",
    });
    if (!target) return;

    try {
      const buf = encodeCapture(raw, {
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

// Ctrl/Cmd+click in the flame graph: open the function's source at `line` (1-based, as
// carried in the model). Absolute paths open directly; relative paths resolve against the
// first workspace folder. Shared by the live panel and the .vamigaprofile editor.
export async function openProfilerSource(file: string, line: number, toSide?: boolean): Promise<void> {
  try {
    let uri: vscode.Uri | undefined;
    if (path.isAbsolute(file)) {
      uri = vscode.Uri.file(file);
    } else {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (folder) uri = vscode.Uri.joinPath(folder.uri, file);
    }
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
