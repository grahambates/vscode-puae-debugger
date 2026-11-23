import type { DebugProtocol } from "@vscode/debugprotocol";
import * as vscode from "vscode";
import type { ExpandedSource } from "./macroListing";

const resumeCommands = new Set([
  "continue", "next", "stepIn", "stepOut", "stepBack", "reverseContinue",
  "restartFrame", "goto", "restart", "disconnect", "terminate",
]);

function commentColumn(text: string): number {
  for (const token of text.matchAll(/"(?:""|\\.|[^"\\])*"|'(?:''|\\.|[^'\\])*'|;/g)) {
    if (token[0] === ";") return token.index;
  }
  return text.length;
}

function compactHintCode(code: string, sharedLabel?: string): string {
  const text = code.trim();
  const explicit = /^([\w.$@]+)\s*::?\s*/.exec(text);
  const first = explicit ?? /^([\w.$@]+)(?:\s+|$)/.exec(text);
  const label = first && first[1] === sharedLabel ? first : explicit;
  const instruction = text.slice(label?.[0].length ?? 0).replace(/^(\S+)\s+(?=\S)/, "$1 ");
  if (explicit && explicit[1] !== sharedLabel) {
    return (explicit[0].trimEnd() + " " + instruction).trimEnd();
  }
  return instruction;
}

export function registerInlineExpansion(
  onExpansionChanged?: (sessionId: string, inactive?: ExpandedSource["inactive"]) => void,
): vscode.Disposable {
  const onDidChangeInlayHints = new vscode.EventEmitter<void>();
  type Stop = {
    expansion?: ExpandedSource;
    tooltip?: () => Promise<vscode.MarkdownString | undefined>;
  };
  const stopped = new Map<string, Stop>();
  const hintTooltips = new WeakMap<vscode.InlayHint, () => Promise<vscode.MarkdownString | undefined>>();

  return vscode.Disposable.from(
    onDidChangeInlayHints,
    vscode.languages.registerInlayHintsProvider({ scheme: "file" }, {
      onDidChangeInlayHints: onDidChangeInlayHints.event,
      provideInlayHints(document, range) {
        const session = vscode.debug.activeDebugSession;
        const stop = session && stopped.get(session.id);
        const expansion = stop?.expansion;
        if (!expansion?.annotations) return [];
        const uri = document.uri.toString();
        return expansion.annotations.flatMap(({ path, line, instruction }) => {
          if (line < 1 || line > document.lineCount || vscode.Uri.file(path).toString() !== uri) return [];
          const source = document.lineAt(line - 1);
          const comment = commentColumn(source.text);
          const code = source.text.slice(0, comment).trimEnd();
          // Motorola syntax allows a colon-free label in the first column.
          const label = /^\s*([\w.$@]+)\s*::?/.exec(code)?.[1] ?? /^([\w.$@]+)(?=\s)/.exec(code)?.[1];
          const expanded = compactHintCode(instruction.slice(0, commentColumn(instruction)), label);
          if (!expanded || compactHintCode(code, label) === expanded) return [];
          const hasComment = comment < source.text.length;
          const position = hasComment ? new vscode.Position(line - 1, code.length) : source.range.end;
          if (!range.contains(position)) return [];
          const hint = new vscode.InlayHint(position, `→ ${expanded}`);
          hint.paddingLeft = true;
          hint.paddingRight = hasComment && code.length === comment;
          const tooltip = stop?.tooltip;
          if (tooltip) hintTooltips.set(hint, tooltip);
          return [hint];
        });
      },
      async resolveInlayHint(hint) {
        hint.tooltip = await hintTooltips.get(hint)?.();
        return hint;
      },
    }),
    vscode.debug.onDidChangeActiveDebugSession(() => onDidChangeInlayHints.fire()),
    vscode.debug.registerDebugAdapterTrackerFactory("puae", {
      createDebugAdapterTracker(session) {
        if (!session.configuration.macroListing) return;
        function clear() {
          if (stopped.delete(session.id)) {
            onExpansionChanged?.(session.id);
            onDidChangeInlayHints.fire();
          }
        }
        return {
          onWillReceiveMessage(message: DebugProtocol.ProtocolMessage) {
            if (message.type === "request" && resumeCommands.has((message as DebugProtocol.Request).command)) {
              clear();
            }
          },
          onDidSendMessage(message: DebugProtocol.ProtocolMessage) {
            if (message.type !== "event") return;
            const { event } = message as DebugProtocol.Event;
            if (event === "continued" || event === "terminated" || event === "exited") clear();
            if (event !== "stopped") return;
            const stop: Stop = {};
            stopped.set(session.id, stop);
            onExpansionChanged?.(session.id);
            onDidChangeInlayHints.fire();
            // Let the adapter finish dispatching the stopped event before requesting its PC.
            void Promise.resolve().then(async () => {
              if (stopped.get(session.id) !== stop) return;
              try {
                const expansion: ExpandedSource = await session.customRequest("showExpandedSource");
                if (stopped.get(session.id) !== stop) return;
                let tooltip: Promise<vscode.MarkdownString | undefined> | undefined;
                stop.tooltip = async () => {
                  if (stopped.get(session.id) !== stop) return;
                  tooltip ??= Promise.resolve(session.customRequest("source", {
                    sourceReference: expansion.source.sourceReference,
                    source: expansion.source,
                  })).then((result: DebugProtocol.SourceResponse["body"]) => {
                    const lines = result.content.split("\n");
                    const index = expansion.line - 1;
                    if (lines[index] !== undefined) lines[index] += "  ; ← stopped here";
                    return new vscode.MarkdownString().appendCodeblock(lines.join("\n"), "m68k");
                  }).catch(() => undefined);
                  const resolved = await tooltip;
                  return stopped.get(session.id) === stop ? resolved : undefined;
                };
                stop.expansion = expansion;
                onExpansionChanged?.(session.id, expansion.inactive);
                onDidChangeInlayHints.fire();
              } catch {
                // Stops outside an expansion and stops superseded by stepping need no annotation.
              }
            });
          },
          onWillStopSession: clear,
        };
      },
    }),
  );
}
