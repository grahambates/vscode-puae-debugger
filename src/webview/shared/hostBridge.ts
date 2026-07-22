import { decodeWsMessage, encodeWsMessage } from "../../shared/wsRpcCodec";

/**
 * Uniform postMessage/onMessage transport for a webview, regardless of which
 * host it's actually running in. `onMessage`/`onConnectionChange` return an
 * unsubscribe function, matching the shape React's `useEffect` cleanup
 * expects.
 */
export interface HostBridge {
  postMessage(message: unknown): void;
  onMessage(callback: (message: unknown) => void): () => void;
  /**
   * Reports transport connectivity — always fires once immediately with the
   * current state, then again on every change. A vscode webview is always
   * "connected" (its lifecycle is panel disposal, not a droppable
   * connection); a standalone WebSocket bridge auto-reconnects on close and
   * reports false/true around each drop, e.g. when the standalone --stdio
   * server process that opened this tab has exited and a later debug
   * session's process comes back up on the same port.
   */
  onConnectionChange(callback: (connected: boolean) => void): () => void;
}

/**
 * Detects which host this webview is running in and returns a `HostBridge`
 * for it — a real vscode webview (`acquireVsCodeApi()`), or a plain browser
 * tab talking to the standalone server's WebSocket endpoint at `wsPath` (see
 * src/standalone/server.ts). Returns `undefined` for neither — e.g.
 * puae/debug.html opened directly off disk (file://), which has no server
 * behind it to connect to.
 *
 * `postMessage` calls made before a WebSocket bridge's socket has finished
 * connecting are queued and flushed on open, so callers don't need to
 * special-case "not connected yet" themselves.
 */
export function createHostBridge(wsPath: string): HostBridge | undefined {
  if (typeof acquireVsCodeApi === "function") {
    const vscodeApi = acquireVsCodeApi();
    const listeners = new Set<(message: unknown) => void>();
    window.addEventListener("message", (event) => {
      for (const listener of listeners) listener(event.data);
    });
    return {
      postMessage: (message) => vscodeApi.postMessage(message),
      onMessage: (callback) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
      onConnectionChange: (callback) => {
        callback(true);
        return () => {};
      },
    };
  }

  if (typeof WebSocket !== "undefined" && location.protocol.startsWith("http")) {
    // Reconnects with a fixed retry delay on every drop — including the
    // standalone --stdio server exiting when its debug session disconnects
    // (see debugAdapter.ts's shutdown()) and a later session's fresh process
    // coming back up on the same --http-port. Messages sent while
    // disconnected are queued and flushed in order once the new socket opens,
    // same as the pre-reconnect behavior for the initial connect.
    const RECONNECT_DELAY_MS = 2000;
    const messageListeners = new Set<(message: unknown) => void>();
    const connectionListeners = new Set<(connected: boolean) => void>();
    let connected = false;
    let pending: unknown[] = [];

    const setConnected = (isConnected: boolean) => {
      if (connected === isConnected) return;
      connected = isConnected;
      for (const listener of connectionListeners) listener(connected);
    };

    const connect = (): WebSocket => {
      const socket = new WebSocket(`ws://${location.host}${wsPath}`);
      socket.addEventListener("open", () => {
        setConnected(true);
        const toSend = pending;
        pending = [];
        for (const message of toSend) socket.send(encodeWsMessage(message));
      });
      socket.addEventListener("message", (event) => {
        const message = decodeWsMessage(event.data);
        for (const listener of messageListeners) listener(message);
      });
      socket.addEventListener("close", () => {
        setConnected(false);
        setTimeout(() => {
          ws = connect();
        }, RECONNECT_DELAY_MS);
      });
      return socket;
    };
    let ws = connect();

    return {
      postMessage: (message) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(encodeWsMessage(message));
        } else {
          pending.push(message);
        }
      },
      onMessage: (callback) => {
        messageListeners.add(callback);
        return () => messageListeners.delete(callback);
      },
      onConnectionChange: (callback) => {
        connectionListeners.add(callback);
        callback(connected);
        return () => connectionListeners.delete(callback);
      },
    };
  }

  return undefined;
}
