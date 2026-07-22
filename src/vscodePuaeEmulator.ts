import * as vscode from "vscode";
import { PuaeEmulator, PuaeSurface } from "./puaeEmulator";
import { openSourceLocation } from "./sourceNav";
import { VscodeWebviewHost } from "./vscodeWebviewHost";

/**
 * The vscode-hosted `PuaeEmulator`: UI lives in a `vscode.WebviewPanel`,
 * created/recreated by `createSurface()`. This is the only host
 * implementation used by the extension (`extension.ts`); the standalone DAP
 * server uses `StandalonePuaeEmulator` instead (see `src/standalone/`).
 */
export class VscodePuaeEmulator extends PuaeEmulator {
  public static readonly viewType = "puae-debugger.puaeWebview";

  // Lazily created — used by the perf-overrun/perf-fps log() override
  // below. Most sessions never trigger it, so there's no reason to create
  // (and show up in VS Code's Output dropdown for) every session.
  private perfLog?: vscode.OutputChannel;

  constructor(private readonly extensionUri: vscode.Uri) {
    super(extensionUri.fsPath);
  }

  protected createSurface(): PuaeSurface {
    const column = this.getConfiguredViewColumn();
    const puaeDir = vscode.Uri.joinPath(this.extensionUri, "puae");

    const panel = vscode.window.createWebviewPanel(
      VscodePuaeEmulator.viewType,
      "PUAE",
      {
        viewColumn: column,
        preserveFocus: true,
      },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          puaeDir,
          vscode.Uri.joinPath(this.extensionUri, "out"),
          vscode.Uri.joinPath(this.extensionUri, "node_modules", "@vscode", "codicons"),
        ],
      },
    );

    const resolveUri = (file: string) =>
      panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, file)).toString();

    // CSP: scripts from webview resource scheme, inline JS (incl. the page's
    // inline module), wasm-unsafe-eval for wasm execution, workers for
    // AudioWorklet, connect for fetches, inline <style> in the page head.
    const src = panel.webview.cspSource;
    const csp = [
      `default-src 'none'`,
      `script-src ${src} 'unsafe-inline' 'wasm-unsafe-eval'`,
      `style-src ${src} 'unsafe-inline'`,
      `font-src ${src}`,
      `worker-src ${src} blob:`,
      `connect-src ${src} data:`,
      `img-src data:`,
    ].join("; ");

    return {
      resolveUri,
      cspMeta: `<meta http-equiv="Content-Security-Policy" content="${csp}">\n`,
      extraHeadHtml: "",
      host: new VscodeWebviewHost(panel),
      setHtml: (html: string) => {
        panel.webview.html = html;
      },
    };
  }

  protected shortenPath(path: string): string {
    return vscode.workspace.asRelativePath(path, false);
  }

  protected openSource(path: string, line?: number): void {
    void openSourceLocation(path, line ?? 1);
  }

  protected log(line: string): void {
    this.getPerfLog().appendLine(line);
  }

  public dispose(): void {
    super.dispose();
    this.perfLog?.dispose();
  }

  private getPerfLog(): vscode.OutputChannel {
    if (!this.perfLog) {
      this.perfLog = vscode.window.createOutputChannel("PUAE Performance");
    }
    return this.perfLog;
  }

  /**
   * Resolves the configured `defaultViewColumn` setting to a ViewColumn for
   * newly created panels.
   */
  private getConfiguredViewColumn(): vscode.ViewColumn {
    const config = vscode.workspace.getConfiguration("puae-debugger");
    const setting = config.get<string>("defaultViewColumn", "beside");

    switch (setting) {
      case "one":
        return vscode.ViewColumn.One;
      case "two":
        return vscode.ViewColumn.Two;
      case "three":
        return vscode.ViewColumn.Three;
      case "beside":
        return vscode.ViewColumn.Beside;
      case "active":
        return (
          vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One
        );
      default:
        return vscode.ViewColumn.Beside;
    }
  }
}
