import * as vscode from "vscode";
import { VamigaDebugAdapter } from "./vAmigaDebugAdapter";
import { VAmiga } from "./vAmiga";
import { MemoryViewerProvider } from "./memoryViewerProvider";
import { StateViewerProvider } from "./stateViewerProvider";
import { PuaeEmulator } from "./puaeEmulator";
import { ProfilerViewerProvider } from "./profilerViewerProvider";
import { ProfileEditorProvider } from "./profileEditorProvider";
import { expressionRangeAt } from "./cExpressionEvaluator";

/**
 * Activates the VAmiga debugger VS Code extension.
 *
 * Initializes the VAmiga emulator interface and registers the debug adapter
 * factory with VS Code's debugging infrastructure. The debug adapter handles
 * Amiga program debugging through the Debug Adapter Protocol.
 *
 * @param context VS Code extension context for managing resources
 */
export function activate(context: vscode.ExtensionContext) {
  const vAmiga = new VAmiga(context.extensionUri);
  const puaeEmulator = new PuaeEmulator(context.extensionUri);
  const memoryViewer = new MemoryViewerProvider(
    context.extensionUri,
    vAmiga,
    puaeEmulator,
  );
  const stateViewer = new StateViewerProvider(
    context.extensionUri,
    vAmiga,
    puaeEmulator,
  );
  // Writable, webview-fetchable scratch dir for the profiler's bulk capture blobs.
  const profilerStorage = context.globalStorageUri;
  const profilerViewer = new ProfilerViewerProvider(
    context.extensionUri,
    profilerStorage,
    () => VamigaDebugAdapter.getActiveAdapter()?.getProfilerClient(),
  );

  // Register the debug adapters
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory("vamiga", {
      createDebugAdapterDescriptor(): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        return new vscode.DebugAdapterInlineImplementation(
          new VamigaDebugAdapter(vAmiga),
        );
      },
    }),
    vscode.debug.registerDebugAdapterDescriptorFactory("puae", {
      createDebugAdapterDescriptor(): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        return new vscode.DebugAdapterInlineImplementation(
          new VamigaDebugAdapter(puaeEmulator),
        );
      },
    }),
  );

  // Register "step back a frame" command
  context.subscriptions.push(
    vscode.commands.registerCommand("vamiga-debugger.stepBackFrame", async () => {
      const adapter = VamigaDebugAdapter.getActiveAdapter();
      const emulator = adapter?.getEmulator() ?? vAmiga;
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

  // Register EOF command
  context.subscriptions.push(
    vscode.commands.registerCommand("vamiga-debugger.eof", () => {
      const emulator = VamigaDebugAdapter.getActiveAdapter()?.getEmulator() ?? vAmiga;
      emulator.eof();
    }),
  );

  // Register EOL command
  context.subscriptions.push(
    vscode.commands.registerCommand("vamiga-debugger.eol", () => {
      const emulator = VamigaDebugAdapter.getActiveAdapter()?.getEmulator() ?? vAmiga;
      emulator.eol();
    }),
  );

  // Register memory viewer command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vamiga-debugger.openMemoryViewer",
      async (uri?: vscode.Uri, address?: string) => {
        // If called from editor context menu, uri will be set
        // Try to get the word under cursor or selection
        if (uri && !address) {
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            const selection = editor.selection;
            if (!selection.isEmpty) {
              // Use selected text
              address = editor.document.getText(selection);
            } else {
              // Get word under cursor
              const range = editor.document.getWordRangeAtPosition(
                selection.active,
              );
              if (range) {
                address = editor.document.getText(range);
              }
            }
          }
        }

        // Open panel directly with address (or empty if not provided)
        // The panel will have autocomplete so user can easily search for symbols
        try {
          await memoryViewer.show(address || "");
          return;
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to open at address: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    ),
  );

  // Register view variable in memory command
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

  // Register "Set Watchpoint Length..." command — an override for the
  // auto-derived watchpoint length (DWARF byte size, or assembly directive
  // parsing), applied via a custom DAP request since DAP has no native
  // field for this. Works alongside the normal "Break on Value..." menu:
  // can be set before or after the data breakpoint itself exists. Symbols
  // only — register watches break on the whole register changing, with no
  // partial-length concept.
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

        // Pre-fill with whatever's currently in effect — a previously set
        // override takes priority, otherwise the auto-detected guess — so
        // reopening the box shows what's actually being watched rather
        // than starting blank every time.
        let info: { override?: number; auto?: number } = {};
        try {
          info = await session.customRequest("getWatchpointLength", { dataId });
        } catch {
          // Older adapter or no info available — fall back to a blank box.
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
        if (input === undefined) return; // cancelled

        await session.customRequest("setWatchpointLength", {
          dataId,
          length: input.trim() === "" ? undefined : Number(input),
        });
      },
    ),
  );

  // Register state viewer command
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

  // Register PUAE/ami9000 emulator webview command
  context.subscriptions.push(
    vscode.commands.registerCommand("vamiga-debugger.openPuae", () => {
      puaeEmulator.open();
    }),
  );

  // Register CPU profiler command
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

  // Register the read-only editor for .vamigaprofile files (opens the profiler webview).
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      ProfileEditorProvider.viewType,
      new ProfileEditorProvider(context.extensionUri, profilerStorage),
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false },
    ),
  );

  // Widen the hover expression for C/C++ so compound navigation expressions evaluate. By default
  // VS Code only sends the single identifier under the cursor; this returns the member/arrow/index
  // chain truncated at the hovered token (matching VS Code's TypeScript behaviour) - hovering
  // `SysBase` in `SysBase->ColdCapture` evaluates `SysBase`, hovering `ColdCapture` evaluates the
  // whole `SysBase->ColdCapture`. See `expressionRangeAt` for the exact rule. Leading `*`/`&` are
  // intentionally not auto-captured to avoid surprising deref/address-of on hover - they still work
  // when typed in the Watch panel or REPL.
  context.subscriptions.push(
    vscode.languages.registerEvaluatableExpressionProvider(
      [{ language: "c" }, { language: "cpp" }],
      { provideEvaluatableExpression },
    ),
  );

  // Clean up viewers on deactivation
  context.subscriptions.push({
    dispose: () => {
      memoryViewer.dispose();
      stateViewer.dispose();
      puaeEmulator.dispose();
      profilerViewer.dispose();
    },
  });
}

/**
 * Returns the EvaluatableExpression for a hover position: the navigation chain truncated at the
 * token under the cursor (see `expressionRangeAt`), or undefined to let VS Code fall back to its
 * default word range.
 */
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

/**
 * Deactivates the VAmiga debugger extension.
 *
 * Called when the extension is deactivated. Currently performs no cleanup
 * as resources are managed by VS Code's disposal mechanisms.
 */
export function deactivate() {}
