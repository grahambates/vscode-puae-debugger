import type WebSocket from "ws";
import { PuaeEmulator, PuaeSurface } from "../puaeEmulator";
import { BrowserWebviewHost } from "./browserWebviewHost";

/**
 * The standalone-server-hosted `PuaeEmulator`: UI lives in a plain browser
 * tab talking to the standalone server's HTTP+WebSocket endpoints, instead
 * of a `vscode.WebviewPanel` (see `VscodePuaeEmulator` for that host).
 *
 * Unlike the vscode host, a `WebviewHost` here can exist before any browser
 * tab has actually connected — `createSurface()` returns a detached
 * `BrowserWebviewHost` immediately (`PuaeEmulator` already tolerates this;
 * see `WebviewEmulator`'s doc comments), and `attachBrowser()` wires up the
 * real connection once the server's WebSocket endpoint sees one.
 */
export class StandalonePuaeEmulator extends PuaeEmulator {
  private currentHtml?: string;
  private currentHost?: BrowserWebviewHost;

  constructor(
    rootDir: string,
    private readonly url: string,
    private readonly onSessionStart: (url: string) => void,
  ) {
    super(rootDir);
  }

  protected createSurface(): PuaeSurface {
    const host = new BrowserWebviewHost();
    this.currentHost = host;
    this.onSessionStart(this.url);
    const resolveUri = (file: string) => `/${file}`;
    return {
      resolveUri,
      cspMeta: "",
      extraHeadHtml: `<link href="${resolveUri("puae/vscodeDefaultTheme.css")}" rel="stylesheet">`,
      host,
      setHtml: (html) => {
        this.currentHtml = html;
      },
    };
  }

  /** The current templated HTML, once `open()` has run at least once — served by the HTTP server's `/` route. */
  getHtml(): string | undefined {
    return this.currentHtml;
  }

  /** Wires up a newly connected browser tab's WebSocket, called from the standalone server's WS upgrade handler. */
  attachBrowser(socket: WebSocket): void {
    if (!this.currentHost) {
      socket.close();
      return;
    }
    this.currentHost.attachSocket(socket);
  }
}
