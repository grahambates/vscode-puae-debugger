import type { DebugProtocol } from "@vscode/debugprotocol";
import * as vscode from "vscode";
import type { InactiveExpansionSource, InactiveSourceBlock } from "./conditionalListing";

export function registerInactiveSource() {
  const decoration = vscode.window.createTextEditorDecorationType({ opacity: "0.55" });
  const ready = new Map<string, Map<string, Promise<InactiveSourceBlock[]>>>();
  const expanded = new Map<string, Map<string, InactiveSourceBlock[]>>();
  let revision = 0;

  function render() {
    const ticket = ++revision;
    const session = vscode.debug.activeDebugSession;
    const files = session && ready.get(session.id);
    for (const editor of vscode.window.visibleTextEditors) {
      const document = editor.document;
      editor.setDecorations(decoration, []);
      if (!session || !files || document.uri.scheme !== "file" || document.isDirty) continue;
      const path = document.uri.fsPath;
      let pending = files.get(path);
      if (!pending) {
        pending = Promise.resolve(session.customRequest("inactiveSource", { path })).catch(() => []);
        files.set(path, pending);
      }
      void pending.then(blocks => {
        if (ticket !== revision || !vscode.window.visibleTextEditors.includes(editor)) return;
        const invocation = expanded.get(session.id)?.get(path) ?? [];
        const ranges = [...blocks, ...invocation].flatMap(({ startLine, lines, ranges }) => {
          if (startLine + lines.length - 1 > document.lineCount ||
            !lines.every((text, index) => text.trimEnd() === document.lineAt(startLine + index - 1).text.trimEnd())) {
            return [];
          }
          return ranges.map(({ start, end }) => new vscode.Range(
            document.lineAt(start - 1).range.start,
            document.lineAt(end - 1).range.end,
          ));
        });
        editor.setDecorations(decoration, ranges);
      });
    }
  }

  const disposable = vscode.Disposable.from(
    decoration,
    vscode.window.onDidChangeVisibleTextEditors(render),
    vscode.workspace.onDidChangeTextDocument(({ document }) => {
      if (vscode.window.visibleTextEditors.some(editor => editor.document === document)) render();
    }),
    vscode.workspace.onDidSaveTextDocument(render),
    vscode.debug.onDidChangeActiveDebugSession(render),
    vscode.debug.onDidTerminateDebugSession(session => {
      expanded.delete(session.id);
      if (ready.delete(session.id)) render();
    }),
    vscode.debug.registerDebugAdapterTrackerFactory("puae", {
      createDebugAdapterTracker(session) {
        if (!session.configuration.macroListing) return;
        return {
          onDidSendMessage(message: DebugProtocol.ProtocolMessage) {
            if (message.type !== "response") return;
            const response = message as DebugProtocol.Response;
            if (response.command === "launch" && response.success) {
              ready.set(session.id, new Map());
              render();
            }
          },
        };
      },
    }),
  );
  return {
    disposable,
    setExpansion(sessionId: string, sources?: InactiveExpansionSource[]) {
      if (sources?.length) {
        expanded.set(sessionId, new Map(sources.map(({ path, blocks }) => [
          vscode.Uri.file(path).fsPath,
          blocks,
        ])));
        render();
      } else if (expanded.delete(sessionId)) {
        render();
      }
    },
  };
}
