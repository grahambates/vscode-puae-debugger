import * as vscode from "vscode";
import { isAbsolute } from "path";

/**
 * Opens `file` (absolute, or resolved against the first workspace folder)
 * and reveals `line` (1-based). Used for "jump to source" actions triggered
 * from a webview click (e.g. the PUAE DMA overlay's copper/CPU hover tooltip
 * resolving an address to file:line via WebviewEmulator's symbolizeAddress
 * handling).
 */
export async function openSourceLocation(file: string, line: number): Promise<void> {
  try {
    let uri: vscode.Uri | undefined;
    if (isAbsolute(file)) {
      uri = vscode.Uri.file(file);
    } else {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (folder) uri = vscode.Uri.joinPath(folder.uri, file);
    }
    if (!uri) return;
    const doc = await vscode.workspace.openTextDocument(uri);
    const l = Math.max(0, line - 1);
    await vscode.window.showTextDocument(doc, {
      selection: new vscode.Range(l, 0, l + 1, 0),
      preserveFocus: true,
    });
  } catch (error) {
    vscode.window.showWarningMessage(
      `Couldn't open ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
