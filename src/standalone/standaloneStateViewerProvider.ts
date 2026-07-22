import type WebSocket from "ws";
import { Emulator } from "../emulator";
import { StateViewerProvider, StateViewerSurface } from "../stateViewerProvider";
import { BrowserWebviewHost } from "./browserWebviewHost";
import { StandaloneMemoryViewerProvider } from "./standaloneMemoryViewerProvider";

/**
 * The standalone-server-hosted `StateViewerProvider`: UI lives in a plain
 * browser tab (its own `/state` page + `/state/rpc` WebSocket — see
 * `src/standalone/server.ts`), "open memory viewer" (clicking a palette
 * color/memory region) opens a new memory-viewer tab directly via the
 * shared `StandaloneMemoryViewerProvider` instead of vscode's command bus.
 */
export class StandaloneStateViewerProvider extends StateViewerProvider {
  private currentHtml?: string;

  constructor(
    puaeEmulator: Emulator,
    private readonly memoryViewerProvider: StandaloneMemoryViewerProvider,
  ) {
    super(puaeEmulator);
  }

  protected createSurface(): StateViewerSurface {
    const resolveUri = (file: string) => `/${file}`;
    return {
      resolveUri,
      cspMeta: "",
      extraHeadHtml: `<link rel="stylesheet" href="${resolveUri("puae/vscodeDefaultTheme.css")}">`,
      host: new BrowserWebviewHost(),
      setHtml: (html) => {
        this.currentHtml = html;
      },
    };
  }

  protected openMemoryViewer(addressHex: string): void {
    void this.memoryViewerProvider.show(addressHex);
  }

  /** The current templated HTML, once `show()` has run at least once — served by the standalone HTTP server's `/state` route. */
  getHtml(): string | undefined {
    return this.currentHtml;
  }

  /** Wires up a newly connected browser tab's WebSocket, called from the standalone server's `/state/rpc` upgrade handler. */
  attachBrowser(socket: WebSocket): void {
    const host = this.host as BrowserWebviewHost | undefined;
    if (!host) {
      socket.close();
      return;
    }
    host.attachSocket(socket);
  }
}
