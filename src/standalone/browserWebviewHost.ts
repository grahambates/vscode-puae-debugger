import type WebSocket from "ws";
import { Disposable } from "../emulator";
import { decodeWsMessage, encodeWsMessage } from "../shared/wsRpcCodec";
import { WebviewHost } from "../webviewHost";

/**
 * A `WebviewHost` for a browser tab talking to the standalone server over a
 * WebSocket. Created (in a detached state, no socket yet) synchronously when
 * `PuaeEmulator.open()` templates the HTML for the standalone HTTP server to
 * serve; `attachSocket()` is called later, once a browser tab actually
 * connects — `WebviewEmulator` already tolerates a host attaching after
 * listeners are registered (see `onDidReceiveMessage`/`onDidDispose`'s doc
 * comments), so nothing upstream needs to know about this delay.
 *
 * A page reload/reconnect calls `attachSocket()` again with a fresh socket;
 * the *previous* socket's `close` event is suppressed (see the `this.socket
 * === socket` check below) so that doesn't look like the user closing the
 * tab. An unreplaced socket closing — the actual "tab closed" signal — does
 * dispose this host, mirroring `vscode.WebviewPanel`'s `onDidDispose` when
 * its tab is closed — but only after CLOSE_GRACE_MS with nothing having
 * superseded it: a `location.reload()` (app.ts's reconnect handling) closes
 * *this* socket itself as part of the page's own navigation, and the
 * replacement socket only arrives once the reloaded page reboots wasm and
 * reconnects — which can take many seconds — so disposing immediately on
 * close would permanently reject that page's own reconnection attempt via
 * the `disposed` check below, breaking the RPC channel for good.
 */
// Generous on purpose: covers a full wasm reboot (loading puae.js/puae.wasm,
// booting the emulated machine) on the reloading page before its fresh
// WebSocket reconnects — observed to take anywhere from a couple of seconds
// up to 20+ under real system load, not just the network round-trip.
const CLOSE_GRACE_MS = 30000;

export class BrowserWebviewHost implements WebviewHost {
  private socket?: WebSocket;
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly disposeListeners = new Set<() => void>();
  private readonly attachListeners = new Set<() => void>();
  private disposed = false;

  /**
   * Fires every time a browser tab attaches, including a reconnect — an
   * event rather than a point-in-time `isAttached` getter deliberately: a
   * reconnecting tab reloads itself once attached (see app.ts), which tears
   * this same socket back down as part of the reload's own navigation, so a
   * snapshot check taken slightly later could see "not attached" even
   * though a tab genuinely did reclaim this session moments before.
   */
  onAttach(callback: () => void): Disposable {
    this.attachListeners.add(callback);
    return { dispose: () => this.attachListeners.delete(callback) };
  }

  attachSocket(socket: WebSocket): void {
    if (this.disposed) {
      socket.close();
      return;
    }
    const previous = this.socket;
    this.socket = socket;
    previous?.close();
    for (const listener of this.attachListeners) listener();

    socket.on("message", (data) => {
      let message: unknown;
      try {
        message = decodeWsMessage(data.toString());
      } catch (error) {
        console.error("Failed to parse message from browser tab:", error);
        return;
      }
      for (const listener of this.messageListeners) {
        listener(message);
      }
    });
    socket.on("close", () => {
      if (this.socket !== socket) return; // already superseded by a newer attach
      setTimeout(() => {
        // Re-check rather than unconditionally disposing: if a replacement
        // attached during the grace window, this.socket now points to it,
        // not the closed socket captured above.
        if (this.socket === socket) this.dispose();
      }, CLOSE_GRACE_MS);
    });
  }

  postMessage(message: unknown): void {
    // Dropped if no tab is currently connected — matches vscode's
    // WebviewPanel silently dropping postMessage calls before the page has
    // loaded; nothing calls sendRpcCommand before the exec-ready handshake.
    if (this.socket && this.socket.readyState === this.socket.OPEN) {
      this.socket.send(encodeWsMessage(message));
    }
  }

  onDidReceiveMessage(callback: (message: unknown) => void): Disposable {
    this.messageListeners.add(callback);
    return { dispose: () => this.messageListeners.delete(callback) };
  }

  onDidDispose(callback: () => void): Disposable {
    this.disposeListeners.add(callback);
    return { dispose: () => this.disposeListeners.delete(callback) };
  }

  reveal(): void {
    // No cross-process way to focus a browser tab; the standalone server
    // logs the URL instead when there's nothing connected yet.
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.socket?.close();
    this.socket = undefined;
    for (const listener of this.disposeListeners) {
      try {
        listener();
      } catch (error) {
        console.error("Error in dispose listener:", error);
      }
    }
  }
}
