import * as vscode from "vscode";
import { VamigaDebugAdapter } from "./vAmigaDebugAdapter";
import { MemoryViewerProvider } from "./memoryViewerProvider";
import { StateViewerProvider } from "./stateViewerProvider";
import { PuaeEmulator } from "./puaeEmulator";
import { ProfilerViewerProvider } from "./profilerViewerProvider";
import { ProfileEditorProvider } from "./profileEditorProvider";
import { ProfilerCodeLensProvider } from "./profilerCodeLensProvider";
import { ProfilerLineDecorationProvider } from "./profilerLineDecorationProvider";
import { expressionRangeAt } from "./cExpressionEvaluator";

export function activate(context: vscode.ExtensionContext) {
  const puaeEmulator = new PuaeEmulator(context.extensionUri);
  const memoryViewer = new MemoryViewerProvider(
    context.extensionUri,
    puaeEmulator,
  );
  const stateViewer = new StateViewerProvider(
    context.extensionUri,
    puaeEmulator,
  );
  const profilerStorage = context.globalStorageUri;
  const profilerCodeLens = new ProfilerCodeLensProvider();
  const profilerLineDecorations = new ProfilerLineDecorationProvider();
  const profilerViewer = new ProfilerViewerProvider(
    context.extensionUri,
    profilerStorage,
    () => VamigaDebugAdapter.getActiveAdapter()?.getProfilerClient(),
    profilerCodeLens,
    profilerLineDecorations,
  );

  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory("puae", {
      createDebugAdapterDescriptor(): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        return new vscode.DebugAdapterInlineImplementation(
          new VamigaDebugAdapter(puaeEmulator),
        );
      },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("vamiga-debugger.stepBackFrame", async () => {
      const adapter = VamigaDebugAdapter.getActiveAdapter();
      const emulator = adapter?.getEmulator() ?? puaeEmulator;
      const moved = await emulator.stepBackFrame();
      if (!moved) {
        vscode.window.setStatusBarMessage(
          "Cannot step back further: reached start of rewind history",
          3000,
        );
      } else {
        adapter?.notifySteppedBack();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("vamiga-debugger.eof", () => {
      const emulator = VamigaDebugAdapter.getActiveAdapter()?.getEmulator() ?? puaeEmulator;
      emulator.eof();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("vamiga-debugger.eol", () => {
      const emulator = VamigaDebugAdapter.getActiveAdapter()?.getEmulator() ?? puaeEmulator;
      emulator.eol();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vamiga-debugger.openMemoryViewer",
      async (uri?: vscode.Uri, address?: string) => {
        if (uri && !address) {
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            const selection = editor.selection;
            if (!selection.isEmpty) {
              address = editor.document.getText(selection);
            } else {
              const range = editor.document.getWordRangeAtPosition(
                selection.active,
              );
              if (range) {
                address = editor.document.getText(range);
              }
            }
          }
        }
        try {
          await memoryViewer.show(address || "");
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to open at address: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vamiga-debugger.viewVariableInMemory",
      async (item) => {
        if (item?.container?.name === "Symbols" || item?.container?.name === "Custom Registers") {
          await memoryViewer.show(item.variable.name);
        } else if (item?.variable?.memoryReference) {
          await memoryViewer.show(item.variable.memoryReference);
        } else {
          vscode.window.showInformationMessage(
            "This variable does not have a memory reference",
          );
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vamiga-debugger.setWatchpointLength",
      async (item) => {
        const name = item?.variable?.name;
        if (item?.container?.name !== "Symbols" || !name) {
          vscode.window.showInformationMessage(
            "Watchpoint length can only be set for symbols",
          );
          return;
        }
        const scope = "symbols";

        const session = vscode.debug.activeDebugSession;
        if (!session) return;
        const dataId = `${scope}:${name}`;

        let info: { override?: number; auto?: number } = {};
        try {
          info = await session.customRequest("getWatchpointLength", { dataId });
        } catch {
          // Older adapter or no info available.
        }
        const current = info.override ?? info.auto;
        const autoHint =
          info.auto !== undefined ? ` (auto-detected: ${info.auto})` : "";

        const input = await vscode.window.showInputBox({
          title: `Watchpoint length for "${name}"`,
          prompt: `Bytes to watch${autoHint} — leave blank to auto-detect`,
          value: current !== undefined ? String(current) : "",
          validateInput: (value) => {
            if (value.trim() === "") return undefined;
            const n = Number(value);
            return Number.isFinite(n) && n > 0
              ? undefined
              : "Enter a positive number of bytes, or leave blank to auto-detect";
          },
        });
        if (input === undefined) return;

        await session.customRequest("setWatchpointLength", {
          dataId,
          length: input.trim() === "" ? undefined : Number(input),
        });
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vamiga-debugger.openStateViewer",
      async () => {
        try {
          await stateViewer.show();
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to open state viewer: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("vamiga-debugger.openPuae", () => {
      puaeEmulator.open();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vamiga-debugger.openProfiler",
      async () => {
        try {
          await profilerViewer.show();
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to open CPU profiler: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      ProfileEditorProvider.viewType,
      new ProfileEditorProvider(context.extensionUri, profilerStorage, profilerCodeLens, profilerLineDecorations),
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false },
    ),
  );

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, profilerCodeLens),
  );

  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ scheme: "file" }, profilerLineDecorations),
  );

  context.subscriptions.push(profilerLineDecorations);

  context.subscriptions.push(
    vscode.commands.registerCommand("vamiga-debugger.toggleLineProfilerAnnotations", () => {
      profilerLineDecorations.setEnabled(!profilerLineDecorations.isEnabled());
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const editor of editors) profilerLineDecorations.refreshEditor(editor);
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) profilerLineDecorations.refreshEditor(editor);
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      profilerLineDecorations.handleDocumentChange(event);
    }),
  );

  context.subscriptions.push(
    vscode.languages.registerEvaluatableExpressionProvider(
      [{ language: "c" }, { language: "cpp" }],
      { provideEvaluatableExpression },
    ),
  );

  context.subscriptions.push({
    dispose: () => {
      memoryViewer.dispose();
      stateViewer.dispose();
      puaeEmulator.dispose();
      profilerViewer.dispose();
    },
  });
}

export function provideEvaluatableExpression(
  document: vscode.TextDocument,
  position: vscode.Position,
): vscode.EvaluatableExpression | undefined {
  const line = document.lineAt(position.line).text;
  const found = expressionRangeAt(line, position.character);
  if (!found) return undefined;
  const range = new vscode.Range(position.line, found.start, position.line, found.end);
  return new vscode.EvaluatableExpression(range, found.text);
}

export function deactivate() {}
