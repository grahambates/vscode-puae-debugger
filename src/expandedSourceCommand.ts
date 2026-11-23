import { isAbsolute } from "node:path";
import * as vscode from "vscode";
import type { ExpandedSource } from "./macroListing";

export function registerExpandedSourceCommand(): vscode.Disposable {
  const openExpansions = new Map<string, ExpandedSource>();
  return vscode.Disposable.from(
    vscode.languages.registerDocumentLinkProvider({ scheme: "debug" }, {
      provideDocumentLinks(document) {
        const expansion = openExpansions.get(document.uri.toString());
        if (!expansion) return [];
        return [expansion.callSite, expansion.template].flatMap((location, line) => {
          if (!location || !isAbsolute(location.path)) return [];
          const target = vscode.Uri.file(location.path).with({ fragment: `L${location.line}` });
          const range = new vscode.Range(line, 2, line, document.lineAt(line).text.length);
          return [new vscode.DocumentLink(range, target)];
        });
      },
    }),
    vscode.workspace.onDidCloseTextDocument(document => {
      openExpansions.delete(document.uri.toString());
    }),
    vscode.commands.registerCommand("puae-debugger.showExpandedSource", async () => {
      const session = vscode.debug.activeDebugSession;
      if (session?.type !== "puae") return;
      try {
        const expansion: ExpandedSource = await session.customRequest("showExpandedSource");
        const uri = vscode.debug.asDebugSourceUri(
          { ...expansion.source, path: `/${expansion.source.name}` },
          session,
        );
        const key = uri.toString();
        openExpansions.set(key, expansion);
        try {
          const document = await vscode.workspace.openTextDocument(uri);
          const line = expansion.line - 1;
          const selection = new vscode.Range(line, 0, line, document.lineAt(line).text.length);
          const editor = await vscode.window.showTextDocument(document, {
            viewColumn: vscode.ViewColumn.Beside,
            selection,
          });
          editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        } catch (error) {
          openExpansions.delete(key);
          throw error;
        }
      } catch (error) {
        void vscode.window.showInformationMessage(
          error instanceof Error ? error.message : String(error),
        );
      }
    }),
  );
}
