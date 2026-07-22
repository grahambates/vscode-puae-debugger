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
 * its tab is closed.
 */
export class BrowserWebviewHost implements WebviewHost {
  private socket?: WebSocket;
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly disposeListeners = new Set<() => void>();
  private disposed = false;

  attachSocket(socket: WebSocket): void {
    if (this.disposed) {
      socket.close();
      return;
    }
    const previous = this.socket;
    this.socket = socket;
    previous?.close();

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
      if (this.socket === socket) {
        this.dispose();
      }
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
