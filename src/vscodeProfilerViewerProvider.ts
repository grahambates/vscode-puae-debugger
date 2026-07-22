import * as vscode from "vscode";
import { isAbsolute } from "path";
import { ProfilerCodeLensProvider } from "./profilerCodeLensProvider";
import { ProfilerLineDecorationProvider } from "./profilerLineDecorationProvider";
import { ProfileEditorProvider } from "./profileEditorProvider";
import { FrameCapture, ProfilerRpcClient } from "./profilerManager";
import { buildProfilerHtml, ProfilerSurface, ProfilerViewerProvider } from "./profilerViewerProvider";
import { packBulk } from "./profilerBulk";
import { VscodeWebviewHost } from "./vscodeWebviewHost";

/**
 * The vscode-hosted `ProfilerViewerProvider`: UI lives in a
 * `vscode.WebviewPanel`, bulk binary blobs are written under `storageUri`
 * and served via `webview.asWebviewUri`, "Save Profile" uses a native save
 * dialog and reopens the result in `ProfileEditorProvider`. This is the only
 * host implementation used by the extension (`extension.ts`); the standalone
 * DAP server uses `StandaloneProfilerViewerProvider` instead (see
 * `src/standalone/`).
 */
export class VscodeProfilerViewerProvider extends ProfilerViewerProvider {
  public static readonly viewType = "puae-debugger.profilerViewer";

  // Tracks the current panel's webview so writeBulkFiles() (called once per
  // capture, not just once at surface-creation time) can keep resolving
  // asWebviewUri() against it. Kept in lockstep with the base class's own
  // `host` field via the onDidDispose hook in createSurface() below.
  private panel?: vscode.WebviewPanel;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly storageUri: vscode.Uri,
    getClient: () => ProfilerRpcClient | undefined,
    codeLens?: ProfilerCodeLensProvider,
    lineDecorations?: ProfilerLineDecorationProvider,
  ) {
    super(getClient, codeLens, lineDecorations);
  }

  protected createSurface(): ProfilerSurface {
    const panel = vscode.window.createWebviewPanel(
      VscodeProfilerViewerProvider.viewType,
      "Profiler",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.extensionUri, this.storageUri] },
    );
    this.panel = panel;
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
    });

    // CSP: scripts/styles/fonts from the webview resource scheme, connect for fetches
    // (bulk blob URLs), img-src blob: for the flame graph's canvas-derived thumbnails.
    const csp = [
      `default-src 'none'`,
      `style-src ${panel.webview.cspSource} 'unsafe-inline'`,
      `font-src ${panel.webview.cspSource}`,
      `script-src ${panel.webview.cspSource}`,
      `connect-src ${panel.webview.cspSource}`,
      `img-src blob:`,
    ].join("; ");

    return {
      resolveUri: (file) => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, file)).toString(),
      cspMeta: `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
      extraHeadHtml: "",
      host: new VscodeWebviewHost(panel),
      setHtml: (html) => {
        panel.webview.html = html;
      },
    };
  }

  protected async writeBulkFiles(frames: FrameCapture[]): Promise<{ uris: string[]; cleanupHandles: string[] }> {
    if (!this.panel) throw new Error("Profiler panel is not open");
    const { uris, fileUris } = await writeBulkFiles(this.storageUri, this.panel.webview, frames, (i) => `profiler-live-bulk-${i}.bin`);
    return { uris, cleanupHandles: fileUris.map((u) => u.toString()) };
  }

  protected deleteBulkFile(handle: string): void {
    void vscode.workspace.fs.delete(vscode.Uri.parse(handle)).then(undefined, () => undefined);
  }

  protected async saveProfile(bytes: Uint8Array, suggestedFileName: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const target = await vscode.window.showSaveDialog({
      defaultUri: folder ? vscode.Uri.joinPath(folder.uri, suggestedFileName) : undefined,
      filters: { "PUAE Profile": ["puaeprofile"] },
      saveLabel: "Save Profile",
    });
    if (!target) return;

    await vscode.workspace.fs.writeFile(target, bytes);
    await vscode.commands.executeCommand("vscode.openWith", target, ProfileEditorProvider.viewType);
    this.dispose();
  }

  protected notifyWarning(message: string): void {
    vscode.window.showWarningMessage(message);
  }

  protected notifyError(message: string): void {
    vscode.window.showErrorMessage(message);
  }

  protected openSource(file: string, line: number, toSide?: boolean): void {
    void openProfilerSource(file, line, toSide);
  }

  protected workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  protected async readSourceFile(file: string): Promise<string[]> {
    return readProfilerSourceFile(file);
  }
}

// Writes one bulk blob (DMA grid + snapshot + JPEGs, see profilerBulk.ts) per frame to
// `storageUri`, named by the caller-supplied `fileName` (so the live panel and the .puaeprofile
// editor — which can have several tabs open at once — don't collide with each other's files).
// Returns both the webview-fetchable URIs (for the captureResult/ready postMessage) and the
// underlying file URIs (so the caller can delete them later, e.g. on panel/tab dispose).
// Shared by the live panel and the .puaeprofile editor.
export async function writeBulkFiles(
  storageUri: vscode.Uri,
  webview: vscode.Webview,
  frames: FrameCapture[],
  fileName: (frameIndex: number) => string,
): Promise<{ uris: string[]; fileUris: vscode.Uri[] }> {
  await vscode.workspace.fs.createDirectory(storageUri);
  const v = Date.now();
  const uris: string[] = [];
  const fileUris: vscode.Uri[] = [];
  for (let i = 0; i < frames.length; i++) {
    const bytes = packBulk(frames[i].raw);
    if (!bytes) { uris.push(""); continue; }
    const fileUri = vscode.Uri.joinPath(storageUri, fileName(i));
    await vscode.workspace.fs.writeFile(fileUri, bytes);
    fileUris.push(fileUri);
    uris.push(`${webview.asWebviewUri(fileUri)}?v=${v}`);
  }
  return { uris, fileUris };
}

// Resolve a model-carried `file` path (as seen in ins.file / node.callFrame.url) to a URI:
// absolute paths open directly; relative paths (e.g. a loaded .puaeprofile whose SourceMap was
// rebuilt against a baseDir that isn't this machine's absolute layout) resolve against the first
// workspace folder. Shared by jump-to-source and the "Show source" preview text fetch below, and
// by both the live panel and the .puaeprofile editor.
function resolveSourceUri(file: string): vscode.Uri | undefined {
  if (isAbsolute(file)) return vscode.Uri.file(file);
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? vscode.Uri.joinPath(folder.uri, file) : undefined;
}

// Ctrl/Cmd+click in the flame graph: open the function's source at `line` (1-based, as
// carried in the model). Shared by the live panel and the .puaeprofile editor.
export async function openProfilerSource(file: string, line: number, toSide?: boolean): Promise<void> {
  try {
    const uri = resolveSourceUri(file);
    if (!uri) return;
    const doc = await vscode.workspace.openTextDocument(uri);
    const l = Math.max(0, line - 1);
    const existing = findOpenColumn(uri);
    await vscode.window.showTextDocument(doc, {
      selection: new vscode.Range(l, 0, l + 1, 0),
      viewColumn: existing ?? (toSide ? vscode.ViewColumn.Beside : undefined),
      preserveFocus: true,
    });
  } catch (error) {
    vscode.window.showWarningMessage(
      `Profiler: couldn't open ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Backs the DisassemblyView "Show source" preview's readSourceFile RPC: literal line-by-line
// text for `file`, resolved the same way jump-to-source is (see resolveSourceUri) — an empty
// array (rather than throwing) means "not found", which the webview renders as a placeholder.
// Shared by the live panel and the .puaeprofile editor.
export async function readProfilerSourceFile(file: string): Promise<string[]> {
  try {
    const uri = resolveSourceUri(file);
    if (!uri) return [];
    const data = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(data).toString("utf8").split(/\r?\n/);
  } catch {
    return [];
  }
}

function findOpenColumn(uri: vscode.Uri): vscode.ViewColumn | undefined {
  const target = uri.toString();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === target) {
        return group.viewColumn;
      }
    }
  }
  return undefined;
}

export function getProfilerHtml(webview: vscode.Webview, extensionUri: vscode.Uri, mode: "live" | "file"): string {
  const resolveUri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, file)).toString();

  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src ${webview.cspSource}`,
    `connect-src ${webview.cspSource}`,
    `img-src blob:`,
  ].join("; ");

  return buildProfilerHtml(resolveUri, `<meta http-equiv="Content-Security-Policy" content="${csp}">`, mode);
}
