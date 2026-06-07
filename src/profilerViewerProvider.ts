import * as vscode from "vscode";
import * as path from "path";
import { VAmiga } from "./vAmiga";
import { VamigaDebugAdapter } from "./vAmigaDebugAdapter";
import { ProfilerManager } from "./profilerManager";
import { encodeCapture } from "./vamigaProfile";
import { ProfileEditorProvider } from "./profileEditorProvider";
import { ProfilerInboundMessage, ProfilerOutboundMessage, IProfileModel } from "./shared/profilerTypes";

/**
 * Webview panel for the CPU profiler: captures one frame of CPU execution, builds
 * a symbolicated call tree, and renders a flame graph. Capture is user-triggered
 * (it advances the emulator a frame), not automatic.
 */
export class ProfilerViewerProvider {
  public static readonly viewType = "vamiga-debugger.profilerViewer";

  private panel?: vscode.WebviewPanel;
  private readonly manager: ProfilerManager;
  // Last successful capture, kept extension-side so a webview reload ("Developer: Reload
  // Webviews", which resets the webview's React state but not the extension host) re-shows
  // it instead of auto-capturing a fresh frame (which would advance the emulator).
  private lastModel?: IProfileModel;
  // Everything Save needs, grabbed at capture time while the debug session is live, so saving
  // still works after the emulator webview / session is closed (which clears the adapter).
  private lastSaveData?: { elf: Uint8Array; programName: string; segmentOffsets: number[]; baseDir: string };
  private lastSaveAdapter?: VamigaDebugAdapter; // which session lastSaveData came from (read ELF once per session)
  private symbolsSent = false; // symbols are session-constant — send them only once per webview mount

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly vAmiga: VAmiga,
  ) {
    this.manager = new ProfilerManager(this.vAmiga, () => {
      try {
        return VamigaDebugAdapter.getActiveAdapter()?.getSourceMap();
      } catch {
        return undefined;
      }
    });
  }

  public dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  public async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      ProfilerViewerProvider.viewType,
      "CPU Profiler",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.webview.html = getProfilerHtml(this.panel.webview, this.extensionUri, "live");
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.panel.webview.onDidReceiveMessage(async (message: ProfilerInboundMessage) => {
      // "ready" fires whenever the webview mounts — first open AND after a webview reload.
      // On the first open there's no capture yet, so grab one frame; on a reload, re-show
      // the cached capture so it survives (and we don't advance the emulator). "capture"
      // (the button) always grabs a fresh frame.
      if (message.command === "ready") {
        this.symbolsSent = false; // fresh webview (first mount or reload) — it needs symbols again
        if (this.lastModel) this.postResult(this.lastModel);
        else await this.capture();
      } else if (message.command === "capture") {
        await this.capture();
      } else if (message.command === "saveProfile") {
        await this.saveProfile();
      } else if (message.command === "openDocument") {
        await openProfilerSource(message.file, message.line, message.toSide);
      }
    });
  }

  private post(message: ProfilerOutboundMessage): void {
    this.panel?.webview.postMessage(message);
  }

  // Post a capture result, including the (session-constant) symbol table only on the first
  // post to this webview; later captures omit it and the webview reuses what it cached.
  private postResult(model: IProfileModel): void {
    if (model.symbols && !this.symbolsSent) {
      this.symbolsSent = true;
      this.post({ command: "captureResult", model });
    } else {
      const { symbols: _symbols, ...rest } = model;
      this.post({ command: "captureResult", model: rest });
    }
  }

  private async capture(): Promise<void> {
    this.post({ command: "capturing" });
    try {
      const model = await this.manager.capture(1);
      this.lastModel = model;
      await this.cacheSaveData();
      this.postResult(model);
    } catch (error) {
      this.post({
        command: "showError",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Capture the program ELF + relocation now, while the session is live, so Save doesn't
  // depend on the adapter still being around (closing the emulator webview ends the session).
  private async cacheSaveData(): Promise<void> {
    const adapter = VamigaDebugAdapter.getActiveAdapter();
    const elfPath = adapter?.getDebugProgramPath();
    if (!adapter || !elfPath) return;
    // ELF + relocation are constant within a session, so read them once per session (keyed by
    // the adapter instance); a relaunch yields a new adapter and re-reads.
    if (adapter === this.lastSaveAdapter && this.lastSaveData) return;
    try {
      const elf = await vscode.workspace.fs.readFile(vscode.Uri.file(elfPath));
      const reloc = adapter.getRelocation();
      this.lastSaveData = {
        elf,
        programName: path.basename(elfPath),
        segmentOffsets: reloc.segmentOffsets,
        baseDir: reloc.baseDir,
      };
      this.lastSaveAdapter = adapter;
    } catch (error) {
      console.warn("[profiler] couldn't read program ELF for save:", error);
    }
  }

  // Save the last capture to a .vamigaprofile. The ELF the source map was built from is
  // embedded so the document is self-contained and re-symbolicates on load — embedding is
  // required (loading by path isn't supported yet), so a failure to read it aborts the save
  // loudly rather than writing an unloadable file.
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
      });
      await vscode.workspace.fs.writeFile(target, buf);
      // Open the saved profile in its (read-only) editor, then close the live capture panel —
      // the saved file becomes the thing you're looking at.
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
    // Reveal an editor that already has this file open rather than opening a new one; only
    // fall back to a fresh editor (beside when Alt-clicked) otherwise.
    const existing = findOpenColumn(uri);
    await vscode.window.showTextDocument(doc, {
      // As in the old extension: select the whole line, and keep focus on the profiler so
      // you can keep clicking through functions.
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

// View column of a tab already showing `uri` (across all groups, incl. background tabs),
// or undefined if it isn't open anywhere.
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

// The profiler webview's HTML, shared by the live panel and the .vamigaprofile editor.
// `mode` is a property of which host created the webview, so it's baked into the markup
// (read by the webview at init) rather than carried per-message — that way it holds even
// if the model never arrives (e.g. a file that fails to load still hides Capture/Save).
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src ${webview.cspSource};">
  <link href="${codiconsUri}" rel="stylesheet" id="vscode-codicon-stylesheet" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>CPU Profiler</title>
</head>
<body>
  <div id="root" data-mode="${mode}"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
