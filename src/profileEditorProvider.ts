import * as vscode from "vscode";
import { loadProfile } from "./profileLoader";
import { packBulk } from "./profilerBulk";
import { getProfilerHtml, openProfilerSource } from "./profilerViewerProvider";
import { ProfilerCodeLensProvider } from "./profilerCodeLensProvider";
import { ProfilerInboundMessage, IProfileModel } from "./shared/profilerTypes";

/**
 * Read-only custom editor for .vamigaprofile files: decodes the bundle, rebuilds the model
 * via loadProfile (same buildModelFromCapture path as a live capture), and hosts the
 * profiler webview in "file" mode (no Capture/Save). Registered as the default editor for
 * *.vamigaprofile, so opening the file in the Explorer shows the profiler directly.
 *
 * Like the live panel, the bulk binary (DMA grid + snapshot) is shipped via a fetched temp
 * blob rather than postMessage (which is slow for large binary); only the small symbolicated
 * model crosses via postMessage.
 */
export class ProfileEditorProvider implements vscode.CustomReadonlyEditorProvider {
  public static readonly viewType = "vamiga-debugger.profileEditor";
  private seq = 0; // unique temp-blob name per opened editor

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly storageUri: vscode.Uri,
    private readonly codeLens?: ProfilerCodeLensProvider,
  ) {}

  public openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  public async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri, this.storageUri],
    };
    webviewPanel.webview.html = getProfilerHtml(webviewPanel.webview, this.extensionUri, "file");

    // Build the model + write the bulk blob eagerly so both are ready when the webview signals
    // "ready". Symbolication (DWARF) is Node-side, so the model is built here, not in the webview.
    let model: IProfileModel | undefined;
    let bulkUri: string | undefined;
    let loadError: string | undefined;
    try {
      const bytes = await vscode.workspace.fs.readFile(document.uri);
      const loaded = loadProfile(bytes);
      model = loaded.model;
      this.codeLens?.update(model);
      const blob = packBulk(loaded.raw);
      if (blob) {
        await vscode.workspace.fs.createDirectory(this.storageUri);
        const fileUri = vscode.Uri.joinPath(this.storageUri, `profiler-editor-bulk-${this.seq++}.bin`);
        await vscode.workspace.fs.writeFile(fileUri, blob);
        webviewPanel.onDidDispose(() => {
          void vscode.workspace.fs.delete(fileUri).then(undefined, () => undefined);
        });
        bulkUri = `${webviewPanel.webview.asWebviewUri(fileUri)}?v=${this.seq}`;
      }
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    }

    webviewPanel.webview.onDidReceiveMessage((message: ProfilerInboundMessage) => {
      if (message.command === "ready") {
        // Strip the big arrays — the webview fetches them via bulkUri.
        if (model) {
          webviewPanel.webview.postMessage({
            command: "captureResult",
            model: { ...model, dma: undefined, dmaSnapshot: undefined, registers: undefined },
            bulkUri,
          });
        } else {
          webviewPanel.webview.postMessage({ command: "showError", error: loadError ?? "Failed to load profile" });
        }
      } else if (message.command === "openDocument") {
        void openProfilerSource(message.file, message.line, message.toSide);
      }
      // "capture"/"saveProfile" don't apply to a loaded file and are ignored.
    });
  }
}
