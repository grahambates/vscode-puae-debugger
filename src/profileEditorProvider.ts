import * as vscode from "vscode";
import { loadProfile } from "./profileLoader";
import { getProfilerHtml, openProfilerSource, readProfilerSourceFile, writeBulkFiles, stripFramesForPost } from "./profilerViewerProvider";
import { ProfilerCodeLensProvider } from "./profilerCodeLensProvider";
import { ProfilerLineDecorationProvider } from "./profilerLineDecorationProvider";
import { ProfilerInboundMessage, IProfileModel, ComputeRangeMessage } from "./shared/profilerTypes";
import { FrameCapture, InstructionSample, buildFrameRangeModel } from "./profilerManager";
import { SourceMap } from "./sourceMap";

/**
 * Read-only custom editor for .puaeprofile files: decodes the bundle, rebuilds every captured
 * frame's model via loadProfile (same buildFramesFromCaptures path as a live multi-frame
 * capture), and hosts the profiler webview in "file" mode (no Capture/Save) — including the
 * filmstrip when the saved document has more than one frame. Registered as the default editor
 * for *.puaeprofile, so opening the file in the Explorer shows the profiler directly.
 *
 * Like the live panel, each frame's bulk binary (DMA grid + snapshot + JPEGs) is shipped via a
 * fetched temp blob rather than postMessage (which is slow for large binary); only the small
 * symbolicated models cross via postMessage.
 */
export class ProfileEditorProvider implements vscode.CustomReadonlyEditorProvider {
  public static readonly viewType = "puae-debugger.profileEditor";
  private seq = 0; // unique temp-blob file prefix per opened editor (several tabs can be open at once)

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly storageUri: vscode.Uri,
    private readonly codeLens?: ProfilerCodeLensProvider,
    private readonly lineDecorations?: ProfilerLineDecorationProvider,
  ) {}

  public openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  public async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri, this.storageUri],
    };
    webviewPanel.webview.html = getProfilerHtml(webviewPanel.webview, this.extensionUri, "file");

    // Build every frame's model + write its bulk blob eagerly so both are ready when the
    // webview signals "ready". Symbolication (DWARF) is Node-side, so models are built here,
    // not in the webview. frameSamples/sourceMap are kept around (not just frames) so a
    // multi-frame document's filmstrip shift-click range selection ("computeRange") can be
    // answered the same way a live capture session answers it.
    let frames: FrameCapture[] | undefined;
    let frameSamples: InstructionSample[][] = [];
    let sourceMap: SourceMap | undefined;
    let bulkUris: string[] = [];
    let loadError: string | undefined;
    let symbolsSent = false; // symbols are session-constant — send them only in the first post
    try {
      const bytes = await vscode.workspace.fs.readFile(document.uri);
      const loaded = loadProfile(bytes);
      frames = loaded.frames;
      frameSamples = loaded.frameSamples;
      sourceMap = loaded.sourceMap;
      this.codeLens?.update(frames[0].model);
      this.lineDecorations?.update(frames[0].model);

      const mySeq = this.seq++;
      const { uris, fileUris } = await writeBulkFiles(
        this.storageUri,
        webviewPanel.webview,
        frames,
        (i) => `profiler-editor-bulk-${mySeq}-${i}.bin`,
      );
      bulkUris = uris;
      webviewPanel.onDidDispose(() => {
        for (const fileUri of fileUris) {
          void vscode.workspace.fs.delete(fileUri).then(undefined, () => undefined);
        }
      });
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    }

    webviewPanel.webview.onDidReceiveMessage((message: ProfilerInboundMessage) => {
      if (message.command === "ready") {
        if (frames) {
          const { frames: result, combinedModel, symbolsNowSent } = stripFramesForPost(frames, symbolsSent, bulkUris);
          symbolsSent = symbolsNowSent;
          webviewPanel.webview.postMessage({ command: "captureResult", frames: result, combinedModel });
        } else {
          webviewPanel.webview.postMessage({ command: "showError", error: loadError ?? "Failed to load profile" });
        }
      } else if (message.command === "computeRange") {
        if (!frames || !sourceMap) return;
        const model = buildFrameRangeModel(frames, frameSamples, sourceMap, (message as ComputeRangeMessage).range);
        if (!model) return;
        const stripped: IProfileModel = { ...model, dma: undefined, dmaSnapshot: undefined, registers: undefined };
        if (symbolsSent) stripped.symbols = undefined;
        webviewPanel.webview.postMessage({ command: "rangeResult", model: stripped });
      } else if (message.command === "openDocument") {
        void openProfilerSource(message.file, message.line, message.toSide);
      } else if (message.command === "readSourceFile") {
        void readProfilerSourceFile(message.file).then((lines) => {
          webviewPanel.webview.postMessage({ command: "sourceFile", file: message.file, lines });
        });
      }
      // "capture"/"saveProfile"/"setNumFrames" don't apply to a loaded file and are ignored.
    });
  }
}
