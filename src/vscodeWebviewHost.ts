import * as vscode from "vscode";
import { Disposable } from "./emulator";
import { WebviewHost } from "./webviewHost";

/**
 * Wraps a `vscode.WebviewPanel` to satisfy `WebviewHost`. Shared by every
 * vscode-hosted panel built on the host-agnostic `WebviewHost` abstraction
 * (`VscodePuaeEmulator`, `VscodeProfilerViewerProvider`).
 */
export class VscodeWebviewHost implements WebviewHost {
  constructor(private readonly panel: vscode.WebviewPanel) {}

  postMessage(message: unknown): void {
    this.panel.webview.postMessage(message);
  }

  onDidReceiveMessage(callback: (message: unknown) => void): Disposable {
    return this.panel.webview.onDidReceiveMessage(callback);
  }

  onDidDispose(callback: () => void): Disposable {
    return this.panel.onDidDispose(callback);
  }

  reveal(): void {
    this.panel.reveal();
  }

  dispose(): void {
    this.panel.dispose();
  }
}
