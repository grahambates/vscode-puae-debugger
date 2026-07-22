import type WebSocket from "ws";
import { Emulator } from "../emulator";
import { MemoryPanelSurface, MemoryViewerProvider } from "../memoryViewerProvider";
import { BrowserWebviewHost } from "./browserWebviewHost";

/**
 * The standalone-server-hosted `MemoryViewerProvider`: each panel lives in
 * its own browser tab (its own `/memory/:panelId` page + `/memory/:panelId/rpc`
 * WebSocket — see `src/standalone/server.ts`), "Export" sends the read bytes
 * to that specific tab to trigger a normal download instead of a native save
 * dialog, and there's no live-configurable `colorCodeHexBytes` setting (no
 * settings.json outside vscode) or "go to source" (no editor to open).
 */
export class StandaloneMemoryViewerProvider extends MemoryViewerProvider {
  private readonly panelHtml = new Map<string, string>();
  private readonly panelHosts = new Map<string, BrowserWebviewHost>();

  constructor(
    puaeEmulator: Emulator,
    private readonly httpPort: number,
    private readonly onPanelOpened: (url: string) => void,
  ) {
    super(puaeEmulator);
  }

  protected createPanelSurface(panelId: string): MemoryPanelSurface {
    const host = new BrowserWebviewHost();
    this.panelHosts.set(panelId, host);
    this.onPanelOpened(`http://127.0.0.1:${this.httpPort}/memory/${panelId}`);

    const resolveUri = (file: string) => `/${file}`;
    return {
      resolveUri,
      cspMeta: "",
      extraHeadHtml: `<link rel="stylesheet" href="${resolveUri("puae/vscodeDefaultTheme.css")}">`,
      host,
      setHtml: (html) => {
        this.panelHtml.set(panelId, html);
      },
    };
  }

  /** The current templated HTML for `panelId` — served by the standalone HTTP server's `/memory/:panelId` route. */
  getHtml(panelId: string): string | undefined {
    return this.panelHtml.get(panelId);
  }

  /** Wires up a newly connected browser tab's WebSocket, called from the standalone server's `/memory/:panelId/rpc` upgrade handler. */
  attachBrowser(panelId: string, socket: WebSocket): void {
    const host = this.panelHosts.get(panelId);
    if (!host) {
      socket.close();
      return;
    }
    host.attachSocket(socket);
  }

  protected setPanelTitle(): void {
    // No native window title outside a browser — every updateState message
    // already carries `windowTitle` (see memoryViewerProvider.ts's
    // updateContent), which the webview turns into document.title itself.
  }

  protected async exportMemory(panelId: string, address: number, size: number): Promise<void> {
    const host = this.panelHosts.get(panelId);
    const byteCount = size > 0 ? size : 256;
    try {
      const data = await this.emulator.readMemory(address, byteCount);
      host?.postMessage({
        command: "downloadMemory",
        dataBase64: data.toString("base64"),
        fileName: `memory_${address.toString(16).padStart(8, "0")}.bin`,
      });
    } catch (err) {
      host?.postMessage({
        command: "updateState",
        error: `Failed to export memory: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  protected notifyError(message: string): void {
    console.error("[memory viewer]", message);
  }
}
