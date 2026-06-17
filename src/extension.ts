import * as vscode from "vscode";
import { VamigaDebugAdapter } from "./vAmigaDebugAdapter";
import { VAmiga } from "./vAmiga";
import { MemoryViewerProvider } from "./memoryViewerProvider";
import { StateViewerProvider } from "./stateViewerProvider";
import { PuaeEmulator } from "./puaeEmulator";

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

  // Clean up viewers on deactivation
  context.subscriptions.push({
    dispose: () => {
      memoryViewer.dispose();
      stateViewer.dispose();
      puaeEmulator.dispose();
    },
  });
}

/**
 * Deactivates the VAmiga debugger extension.
 *
 * Called when the extension is deactivated. Currently performs no cleanup
 * as resources are managed by VS Code's disposal mechanisms.
 */
export function deactivate() {}
