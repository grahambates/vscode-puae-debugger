import * as vscode from "vscode";
import { VAmiga } from "./vAmiga";
import { VamigaDebugAdapter } from "./vAmigaDebugAdapter";
import { ProfilerManager } from "./profilerManager";
import { ProfilerInboundMessage, ProfilerOutboundMessage } from "./shared/profilerTypes";

/**
 * Webview panel for the CPU profiler: captures one frame of CPU execution, builds
 * a symbolicated call tree, and renders a flame graph. Capture is user-triggered
 * (it advances the emulator a frame), not automatic.
 */
export class ProfilerViewerProvider {
  public static readonly viewType = "vamiga-debugger.profilerViewer";

  private panel?: vscode.WebviewPanel;
  private readonly manager: ProfilerManager;

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

    this.panel.webview.html = this.getHtmlContent(this.panel.webview);
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.panel.webview.onDidReceiveMessage(async (message: ProfilerInboundMessage) => {
      // Auto-capture on first open: "ready" fires once when the webview mounts (the
      // panel is retained across hide/reveal), so there's no profile yet — capture
      // one frame immediately. Subsequent captures are user-triggered ("capture").
      if (message.command === "ready" || message.command === "capture") {
        await this.capture();
      }
    });
  }

  private post(message: ProfilerOutboundMessage): void {
    this.panel?.webview.postMessage(message);
  }

  private async capture(): Promise<void> {
    this.post({ command: "capturing" });
    try {
      const result = await this.manager.capture(1);
      this.post({ command: "captureResult", result });
    } catch (error) {
      this.post({
        command: "showError",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private getHtmlContent(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "out", "profilerViewer.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "out", "profilerViewer.css"),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src ${webview.cspSource};">
  <link href="${styleUri}" rel="stylesheet" />
  <title>CPU Profiler</title>
</head>
<body>
  <div id="root"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
