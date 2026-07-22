import * as vscode from "vscode";
import { Emulator } from "./emulator";
import { StateViewerProvider, StateViewerSurface } from "./stateViewerProvider";
import { VscodeWebviewHost } from "./vscodeWebviewHost";

/**
 * The vscode-hosted `StateViewerProvider`: UI lives in a `vscode.WebviewPanel`,
 * "open memory viewer" (clicking a palette color/memory region) dispatches
 * the existing `puae-debugger.openMemoryViewer` command. This is the only
 * host implementation used by the extension (`extension.ts`); the standalone
 * DAP server uses `StandaloneStateViewerProvider` instead (see
 * `src/standalone/`).
 */
export class VscodeStateViewerProvider extends StateViewerProvider {
  public static readonly viewType = "puae-debugger.stateViewer";

  constructor(
    private readonly extensionUri: vscode.Uri,
    puaeEmulator: Emulator,
  ) {
    super(puaeEmulator);
  }

  protected createSurface(): StateViewerSurface {
    const panel = vscode.window.createWebviewPanel(
      VscodeStateViewerProvider.viewType,
      "Amiga State",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    const resolveUri = (file: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, file)).toString();
    const cspSource = panel.webview.cspSource;
    return {
      resolveUri,
      cspMeta: `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource}; script-src ${cspSource};">`,
      extraHeadHtml: "",
      host: new VscodeWebviewHost(panel),
      setHtml: (html) => {
        panel.webview.html = html;
      },
    };
  }

  protected openMemoryViewer(addressHex: string): void {
    void vscode.commands.executeCommand(
      "puae-debugger.openMemoryViewer",
      undefined,
      addressHex,
    );
  }
}
