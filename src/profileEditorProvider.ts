import * as vscode from "vscode";
import { loadProfile } from "./profileLoader";
import { getProfilerHtml, openProfilerSource } from "./profilerViewerProvider";
import { ProfilerInboundMessage, IProfileModel } from "./shared/profilerTypes";

/**
 * Read-only custom editor for .vamigaprofile files: decodes the bundle, rebuilds the model
 * via loadProfile (same buildModelFromCapture path as a live capture), and hosts the
 * profiler webview in "file" mode (no Capture/Save). Registered as the default editor for
 * *.vamigaprofile, so opening the file in the Explorer shows the profiler directly.
 */
export class ProfileEditorProvider implements vscode.CustomReadonlyEditorProvider {
  public static readonly viewType = "vamiga-debugger.profileEditor";

  constructor(private readonly extensionUri: vscode.Uri) {}

  public openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  public async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    webviewPanel.webview.options = { enableScripts: true };
    webviewPanel.webview.html = getProfilerHtml(webviewPanel.webview, this.extensionUri, "file");

    // Load eagerly so the model is ready by the time the webview signals "ready".
    let model: IProfileModel | undefined;
    let loadError: string | undefined;
    try {
      const bytes = await vscode.workspace.fs.readFile(document.uri);
      model = loadProfile(bytes).model;
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    }

    webviewPanel.webview.onDidReceiveMessage((message: ProfilerInboundMessage) => {
      if (message.command === "ready") {
        if (model) webviewPanel.webview.postMessage({ command: "captureResult", model });
        else webviewPanel.webview.postMessage({ command: "showError", error: loadError ?? "Failed to load profile" });
      } else if (message.command === "openDocument") {
        void openProfilerSource(message.file, message.line, message.toSide);
      }
      // "capture"/"saveProfile" don't apply to a loaded file and are ignored.
    });
  }
}
