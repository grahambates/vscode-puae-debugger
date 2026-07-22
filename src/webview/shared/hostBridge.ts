import { decodeWsMessage, encodeWsMessage } from "../../shared/wsRpcCodec";

/**
 * Uniform postMessage/onMessage transport for a webview, regardless of which
 * host it's actually running in. `onMessage` returns an unsubscribe
 * function, matching the shape React's `useEffect` cleanup expects.
 */
export interface HostBridge {
  postMessage(message: unknown): void;
  onMessage(callback: (message: unknown) => void): () => void;
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
    };
  }

  if (typeof WebSocket !== "undefined" && location.protocol.startsWith("http")) {
    const ws = new WebSocket(`ws://${location.host}${wsPath}`);
    const listeners = new Set<(message: unknown) => void>();
    ws.addEventListener("message", (event) => {
      const message = decodeWsMessage(event.data);
      for (const listener of listeners) listener(message);
    });
    return {
      postMessage: (message) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(encodeWsMessage(message));
        } else {
          ws.addEventListener("open", () => ws.send(encodeWsMessage(message)), { once: true });
        }
      },
      onMessage: (callback) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    };
  }

  return undefined;
}
