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
// Longer than the fixed 2000ms retry delay hostBridge.ts's WebSocket bridge
// waits before its first reconnect attempt after a drop — long enough that
// a tab left open from a previous session reliably reclaims this one before
// we decide to open a redundant new tab, even in the worst case where its
// retry timer is poorly phased against this session actually starting (a
// failed attempt just before this session's HTTP/WS server is reachable
// costs a full extra 2000ms cycle before the one that actually succeeds).
const REOPEN_GRACE_MS = 5000;

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
    // Only one browser tab can be attached to a session at a time (see
    // BrowserWebviewHost.attachSocket — a later connection evicts the
    // former), so unconditionally opening a new tab here would race a
    // leftover tab's own reconnect and could steal the socket back from
    // whichever tab actually wins, breaking it mid-boot. Give a leftover
    // tab a chance to reclaim this session first; only open a new one if
    // nothing did. Latches on the first attach *within* the grace window
    // rather than checking attachment state only once at the end — a
    // reclaiming tab reloads itself immediately after attaching (see
    // app.ts), which tears this same socket back down as part of that
    // reload's own navigation, so a one-shot check could land in that gap
    // and wrongly conclude nothing reclaimed it.
    let reclaimed = false;
    const attachSubscription = host.onAttach(() => {
      reclaimed = true;
    });
    setTimeout(() => {
      attachSubscription.dispose();
      if (!reclaimed) this.onSessionStart(this.url);
    }, REOPEN_GRACE_MS);
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
