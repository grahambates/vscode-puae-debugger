import { mkdirSync, unlink, writeFileSync } from "fs";
import { join } from "path";
import type WebSocket from "ws";
import { packBulk } from "../profilerBulk";
import { FrameCapture, ProfilerRpcClient } from "../profilerManager";
import { ProfilerSurface, ProfilerViewerProvider } from "../profilerViewerProvider";
import { BrowserWebviewHost } from "./browserWebviewHost";

/**
 * The standalone-server-hosted `ProfilerViewerProvider`: UI lives in a plain
 * browser tab (a separate page/WebSocket from the emulator's — see
 * `src/standalone/server.ts`'s `/profiler` and `/profiler/rpc` routes),
 * bulk binary blobs are written under a scratch directory served via the
 * `/profiler-bulk/*` static route, and "Save Profile" sends the encoded
 * bytes to the browser to trigger a normal download — there's no native
 * save dialog outside vscode.
 */
export class StandaloneProfilerViewerProvider extends ProfilerViewerProvider {
  private currentHtml?: string;
  private bulkSeq = 0;

  constructor(
    private readonly bulkDir: string,
    getClient: () => ProfilerRpcClient | undefined,
  ) {
    super(getClient);
    mkdirSync(bulkDir, { recursive: true });
  }

  protected createSurface(): ProfilerSurface {
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

  /** The current templated HTML, once `show()` has run at least once — served by the standalone HTTP server's `/profiler` route. */
  getHtml(): string | undefined {
    return this.currentHtml;
  }

  /** Wires up a newly connected browser tab's WebSocket, called from the standalone server's `/profiler/rpc` upgrade handler. */
  attachBrowser(socket: WebSocket): void {
    const host = this.currentBrowserHost();
    if (!host) {
      socket.close();
      return;
    }
    host.attachSocket(socket);
  }

  private currentBrowserHost(): BrowserWebviewHost | undefined {
    return this.host as BrowserWebviewHost | undefined;
  }

  protected async writeBulkFiles(frames: FrameCapture[]): Promise<{ uris: string[]; cleanupHandles: string[] }> {
    const v = Date.now();
    const mySeq = this.bulkSeq++;
    const uris: string[] = [];
    const cleanupHandles: string[] = [];
    for (let i = 0; i < frames.length; i++) {
      const bytes = packBulk(frames[i].raw);
      if (!bytes) {
        uris.push("");
        continue;
      }
      const fileName = `profiler-live-bulk-${mySeq}-${i}.bin`;
      const filePath = join(this.bulkDir, fileName);
      writeFileSync(filePath, bytes);
      cleanupHandles.push(filePath);
      uris.push(`/profiler-bulk/${fileName}?v=${v}`);
    }
    return { uris, cleanupHandles };
  }

  protected deleteBulkFile(handle: string): void {
    unlink(handle, () => undefined);
  }

  protected async saveProfile(bytes: Uint8Array, suggestedFileName: string): Promise<void> {
    this.host?.postMessage({
      command: "downloadProfile",
      dataBase64: Buffer.from(bytes).toString("base64"),
      fileName: suggestedFileName,
    });
  }

  protected notifyWarning(message: string): void {
    this.host?.postMessage({ command: "showError", error: message });
  }

  protected notifyError(message: string): void {
    this.host?.postMessage({ command: "showError", error: message });
  }
}
