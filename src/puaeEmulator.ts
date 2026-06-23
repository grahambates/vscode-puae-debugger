import * as vscode from "vscode";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { WebviewEmulator } from "./webviewEmulator";

/**
 * PUAE/ami9000 wasm backend, implementing the same `Emulator` interface as
 * `VAmiga`. Backed by `puae/`'s `index.html` (boot/render loop logic shared
 * via `puae_app.js`) + `puae_rpc.js`, which expose the `e9k_debug` debugging
 * layer grafted onto libretro-uae. `puae/debug.html` is a standalone variant
 * with manual breakpoint/memory/watchpoint/disassembly test UI, for
 * development outside the extension — not used by `getHtmlForWebview`.
 *
 * `emulatorOptions` is a flat object of raw WinUAE-format `.uae` key=value
 * pairs (e.g. `chipmem_size`, `cpu_model`, `chipset`). Two keys are handled
 * specially by this class rather than written verbatim to the UAE config:
 *  - `kickstartRom` (top-level, optional): host filesystem path to the
 *    Kickstart ROM. The file is read on the host and embedded as a data URI
 *    in the webview HTML. If omitted and `fastLoad` is false, the bundled
 *    AROS ROM is used. If omitted with `fastLoad: true`, an error is thrown
 *    (AROS is incompatible with fast loading).
 *  - `programPath` (internal, added by the debug adapter): host path to the
 *    Amiga executable. The file is base64-injected as `programB64` and
 *    `puae_app.js` writes it into MEMFS, mounted as a bootable DH0: hard
 *    disk via `filesystem=rw,dh0:/uae_system/dh0`.
 *
 * All other keys are written to `puae_libretro_global.uae` (last-line-wins).
 * Four defaults are always prepended: `cpu_compatible`, `cpu_cycle_exact`,
 * `cpu_memory_cycle_exact`, `blitter_cycle_exact` (all `true`) — override
 * by specifying the same key in `emulatorOptions`.
 *
 * Documented gaps vs. `VAmiga` (see `puae_rpc.js` for the implementation):
 *  - `getCpuInfo()`'s isp/msp/vbr/irc/sfc/dfc/cacr/caar fields are always
 *    "0x00000000".
 *  - `setRegister()`/`jump()` only support d0-d7/a0-a7/sr/pc/usp.
 *  - `getCpuTrace()` returns up to 256 most-recently-executed instructions.
 *  - `stepBack()`/`continueReverse()` use a ring buffer of full-state
 *    snapshots (`retro_serialize`/`retro_unserialize`).
 *  - Breakpoint `ignores` counts are not supported.
 *
 * Session restart / panel reuse: `open()` while a panel is already open sends
 * a "load" command (hard reset + warm-up) rather than re-instantiating the
 * wasm module. ROM/config options from the FIRST session remain in effect for
 * reused panels — changing them requires closing the panel first.
 */
export class PuaeEmulator extends WebviewEmulator {
  public static readonly viewType = "vamiga-debugger.puaeWebview";
  private openOptions?: Record<string, unknown>;
  // Options that were used to generate the current panel's HTML — used to
  // detect when a config change requires a full panel reinitialisation.
  private panelOptions?: Record<string, unknown>;

  /**
   * Opens the PUAE emulator webview panel.
   *
   * If `kickstartRom` is not set, AROS is used as the default ROM for
   * non-fastLoad launches; fastLoad without an explicit ROM throws.
   */
  public open(options?: Record<string, unknown>): void {
    this.openOptions = options;
    if (this.panel) {
      if (this.optionsMatch(options, this.panelOptions)) {
        // Same config as the running panel: fast path — hard-reset the emulated
        // machine and re-run the boot warm-up without reloading the webview.
        this.panel.reveal();
        this.invalidateCache();
        this.memoryInfo = undefined;
        this.sendCommand("load");
      } else {
        // Config changed: dispose the old panel and create a fresh one so the
        // new ROM / UAE config / program is picked up from the updated HTML.
        this.panel.dispose();
        this.initPanel();
      }
      return;
    }
    this.initPanel();
  }


  // --- Helper methods ---

  private initPanel(): void {
    const column = this.getConfiguredViewColumn();
    const puaeDir = vscode.Uri.joinPath(this.extensionUri, "puae");

    this.panel = vscode.window.createWebviewPanel(
      PuaeEmulator.viewType,
      "PUAE",
      {
        viewColumn: column,
        preserveFocus: true,
      },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          puaeDir,
          vscode.Uri.joinPath(this.extensionUri, "node_modules", "@vscode/codicons"),
        ],
      },
    );

    this.panel.webview.html = this.getHtmlForWebview(this.panel.webview, puaeDir);
    this.panelOptions = this.openOptions;

    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.panelOptions = undefined;
    });

    this.panel.webview.onDidReceiveMessage((message) =>
      this.handlePanelMessage(message),
    );
  }

  /**
   * Builds the `.uae`-format config text to inject before boot.
   * Layers in order (later lines win):
   *  1. Four cycle-exact defaults
   *  2. emulatorConfigFile contents (if set)
   *  3. emulatorOptions key=value pairs
   */
  private buildExtraConfig(): string {
    const options = this.openOptions;
    const lines: string[] = [
      "cpu_compatible=true",
      "cpu_cycle_exact=true",
      "cpu_memory_cycle_exact=true",
      "blitter_cycle_exact=true",
    ];

    const configFile = options?.emulatorConfigFile as string | undefined;
    if (configFile) {
      if (!existsSync(configFile)) {
        throw new Error(`emulatorConfigFile not found: ${configFile}`);
      }
      lines.push(readFileSync(configFile, "utf-8").trimEnd());
    }

    for (const [key, value] of Object.entries(options ?? {})) {
      if (key === "programPath" || key === "kickstartRom" || key === "emulatorConfigFile") {
        continue;
      }
      lines.push(`${key}=${value}`);
    }

    if (options?.programPath) {
      lines.push("filesystem=rw,dh0:/uae_system/dh0");
    }

    return lines.join("\n") + "\n";
  }

  private getHtmlForWebview(webview: vscode.Webview, puaeDir: vscode.Uri): string {
    const puaeFsPath = join(this.extensionUri.fsPath, "puae");
    const uri = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(puaeDir, file)).toString();

    const puaeJsUri = uri("puae.js");
    const puaeWasmUri = uri("puae.wasm");
    const workletUri = uri("puae_audioprocessor.js");
    const appUri = uri("puae_app.js");
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.extensionUri,
        "node_modules",
        "@vscode/codicons",
        "dist",
        "codicon.css",
      ),
    );

    const kickstartPath = this.openOptions?.kickstartRom as string | undefined;
    let romDataUri = "";
    if (kickstartPath) {
      if (!existsSync(kickstartPath)) {
        throw new Error(`Kickstart ROM file not found: ${kickstartPath}`);
      }
      const romData = readFileSync(kickstartPath);
      romDataUri = `data:application/octet-stream;base64,${romData.toString("base64")}`;
    } else if (!this.openOptions?.programPath) {
      throw new Error(
        "PUAE with fast loading requires an explicit kickstartRom — " +
          "AROS is not compatible with fast loading. " +
          "Set kickstartRom to a Kickstart ROM file path, or set fastLoad: false.",
      );
    }
    // romDataUri is empty when no kickstartRom is set — puae_app.js skips
    // writing the ROM file, and frontend_shim falls back to built-in AROS.

    const extraConfig = this.buildExtraConfig();
    const extraConfigB64 = extraConfig
      ? Buffer.from(extraConfig, "utf-8").toString("base64")
      : "";

    let programB64 = "";
    const programPath = this.openOptions?.programPath as string | undefined;
    if (programPath) {
      if (!existsSync(programPath)) {
        throw new Error(`Program file not found: ${programPath}`);
      }
      programB64 = readFileSync(programPath).toString("base64");
    }

    // CSP: scripts from webview resource scheme, inline JS (incl. the page's
    // inline module), wasm-unsafe-eval for wasm execution, workers for
    // AudioWorklet, connect for fetches, inline <style> in the page head.
    const src = webview.cspSource;
    const csp = [
      `default-src 'none'`,
      `script-src ${src} 'unsafe-inline' 'wasm-unsafe-eval'`,
      `style-src ${src} 'unsafe-inline'`,
      `font-src ${src}`,
      `worker-src ${src} blob:`,
      `connect-src ${src} data:`,
      `img-src data:`,
    ].join("; ");

    let html = readFileSync(join(puaeFsPath, "index.html"), "utf8");

    // Inject CSP meta tag + the codicon webfont stylesheet (gives the page
    // access to VS Code's built-in icon set via <i class="codicon codicon-*">).
    html = html.replace(
      '<meta charset="utf-8">',
      `<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${csp}">\n<link href="${codiconsUri}" rel="stylesheet">`,
    );

    // Patch external script src to webview URI.
    html = html.replace('src="puae.js"', `src="${puaeJsUri}"`);

    // Patch the shared app module's import to a webview URI — puae_app.js's
    // own relative import of puae_rpc.js then resolves correctly against
    // that URI without any further patching.
    html = html.replace(
      "from './puae_app.js';",
      `from '${appUri}';`,
    );

    // Override locateFile so emscripten finds puae.wasm via webview URI,
    // not relative to window.location (which has no meaning in the webview).
    html = html.replace(
      "wasmLocateFile: undefined,",
      `wasmLocateFile: (p) => p.endsWith('.wasm') ? '${puaeWasmUri}' : p,`,
    );

    // Patch ROM fetch path to a webview-accessible URI.
    // ROM is a symlink — use the already-resolved data URI.
    html = html.replace("romUrl: '[ROMPATH]',", `romUrl: '${romDataUri}',`);

    // Inject the .uae config blob built from configFilePath/chipRam/slowRam/
    // fastRam/cpuRevision/emulatorOptions.puae (see buildExtraConfig).
    html = html.replace(
      "extraConfigB64: '',",
      `extraConfigB64: '${extraConfigB64}',`,
    );

    // Inject the program executable (OpenOptions.programPath) — puae_app.js
    // writes it into a MEMFS directory mounted as DH0: (see buildExtraConfig's
    // "filesystem=rw,dh0:..." line) along with an s/startup-sequence that runs
    // it, for non-fastLoad/dos.library-dependent programs.
    html = html.replace(
      "programB64: '',",
      `programB64: '${programB64}',`,
    );

    // Patch AudioWorklet module path.
    html = html.replace(
      "audioWorkletUrl: './puae_audioprocessor.js',",
      `audioWorkletUrl: '${workletUri}',`,
    );

    return html;
  }
}
