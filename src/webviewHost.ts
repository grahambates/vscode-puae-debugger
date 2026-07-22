import { Disposable } from "./emulator";

/**
 * What `WebviewEmulator` needs from wherever its UI actually lives — a real
 * `vscode.WebviewPanel` (`VscodeWebviewHost`), or a WebSocket connection to a
 * page served by the standalone server's HTTP server (`BrowserWebviewHost`).
 * Deliberately narrow: everything else `WebviewEmulator` does (RPC
 * correlation, message-listener fan-out, the `Emulator` command wrappers) is
 * host-agnostic already and lives in `webviewEmulator.ts` unchanged.
 */
export interface WebviewHost {
  postMessage(message: unknown): void;
  onDidReceiveMessage(callback: (message: unknown) => void): Disposable;
  onDidDispose(callback: () => void): Disposable;
  /** Bring the UI to the foreground. No-op where that concept doesn't apply (e.g. a browser tab). */
  reveal(): void;
  dispose(): void;
}
