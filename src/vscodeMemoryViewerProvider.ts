import * as vscode from "vscode";
import { DebugAdapter } from "./debugAdapter";
import { Emulator } from "./emulator";
import { formatHex } from "./numbers";
import { MemoryPanelSurface, MemoryViewerProvider } from "./memoryViewerProvider";
import { VscodeWebviewHost } from "./vscodeWebviewHost";

/**
 * The vscode-hosted `MemoryViewerProvider`: each panel lives in its own
 * `vscode.WebviewPanel`, "Export" uses a native byte-count prompt + save
 * dialog, "go to source" opens a real editor, and the
 * `memoryViewer.colorCodeHexBytes` setting is pushed live to every open
 * panel on change. This is the only host implementation used by the
 * extension (`extension.ts`); the standalone DAP server uses
 * `StandaloneMemoryViewerProvider` instead (see `src/standalone/`).
 */
export class VscodeMemoryViewerProvider extends MemoryViewerProvider {
  public static readonly viewType = "puae-debugger.memoryViewer";

  // Keyed the same as the base class's own `panels` map — tracked separately
  // since the base class only knows about the host-agnostic `WebviewHost`,
  // not the real vscode.WebviewPanel `setPanelTitle`/`createPanelSurface`
  // need underneath it.
  private readonly vscodePanels = new Map<string, vscode.WebviewPanel>();
  private readonly configurationListener: vscode.Disposable;

  constructor(
    private readonly extensionUri: vscode.Uri,
    puaeEmulator: Emulator,
  ) {
    super(puaeEmulator);

    // Push the new value to all open panels when the user changes the setting
    this.configurationListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("puae-debugger.memoryViewer.colorCodeHexBytes")) {
        const colorCodeHexBytes = this.getColorCodeHexBytes();
        for (const panel of this.panels.values()) {
          this.sendStateToWebview(panel, { colorCodeHexBytes });
        }
      }
    });
  }

  public dispose(): void {
    super.dispose();
    this.configurationListener.dispose();
    this.vscodePanels.clear();
  }

  protected createPanelSurface(panelId: string): MemoryPanelSurface {
    const panel = vscode.window.createWebviewPanel(
      VscodeMemoryViewerProvider.viewType,
      "Memory Viewer",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );
    this.vscodePanels.set(panelId, panel);
    panel.onDidDispose(() => {
      if (this.vscodePanels.get(panelId) === panel) this.vscodePanels.delete(panelId);
    });

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

  protected setPanelTitle(panelId: string, title: string): void {
    const panel = this.vscodePanels.get(panelId);
    if (panel) panel.title = title;
  }

  protected async exportMemory(_panelId: string, address: number, size: number): Promise<void> {
    const sizeInput = await vscode.window.showInputBox({
      title: "Save Memory to Disk",
      prompt: "Number of bytes to export",
      value: String(size > 0 ? size : 256),
      validateInput: (value) => {
        const parsed = Number(value);
        return Number.isInteger(parsed) && parsed > 0
          ? undefined
          : "Enter a positive integer";
      },
    });
    if (sizeInput === undefined) {
      return;
    }
    const byteCount = Number(sizeInput);

    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`memory_${formatHex(address)}.bin`),
      filters: { "Binary files": ["bin"], "All files": ["*"] },
    });
    if (!uri) {
      return;
    }

    try {
      const data = await this.emulator.readMemory(address, byteCount);
      await vscode.workspace.fs.writeFile(uri, data);
      vscode.window.showInformationMessage(
        `Saved ${byteCount} bytes from ${formatHex(address)} to ${uri.fsPath}`,
      );
    } catch (err) {
      vscode.window.showErrorMessage(
        `Failed to save memory: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  protected notifyError(message: string): void {
    vscode.window.showErrorMessage(message);
  }

  protected openSource(address: number): void {
    const sourceMap = DebugAdapter.getActiveAdapter()?.getSourceMap();
    const location = sourceMap?.lookupAddress(address);
    if (!location) return;
    void (async () => {
      const document = await vscode.workspace.openTextDocument(location.path);
      const editor = await vscode.window.showTextDocument(document, {
        preview: false,
      });
      const position = new vscode.Position(location.line - 1, 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(
        new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenter,
      );
    })();
  }

  protected getColorCodeHexBytes(): boolean {
    return vscode.workspace
      .getConfiguration("puae-debugger")
      .get<boolean>("memoryViewer.colorCodeHexBytes", true);
  }
}
