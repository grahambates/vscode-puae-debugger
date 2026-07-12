import * as vscode from "vscode";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, relative, sep, basename } from "path";
import { WebviewEmulator } from "./webviewEmulator";

// One entry per file/directory under a `hardDrivePath` tree, relative to its root
// (forward-slash separated regardless of host OS) — see getHtmlForWebview's
// hardDriveManifestB64 and app.ts's reconstruction of it under /uae_system/dh0.
export interface HardDriveEntry {
  path: string;
  dir: boolean;
  dataB64?: string;
}

/** Serializes a string for insertion as a complete JavaScript string literal. */
export function toJavaScriptStringLiteral(value: string): string {
  return JSON.stringify(value);
}

// Recursively walks a host directory into a flat list the webview can replay into
// MEMFS (Emscripten's in-heap virtual filesystem — the only filesystem available in
// a browser/webview context, there's no NODEFS-style real host mount). Directories
// are listed before the files/subdirectories they contain, so app.ts can create them
// in emission order without needing to sort or pre-scan for parents. Exported for
// direct unit testing (fs-based but otherwise pure — no vscode dependency).
export function walkHardDrive(rootDir: string): HardDriveEntry[] {
  const entries: HardDriveEntry[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = relative(rootDir, full).split(sep).join("/");
      const stat = statSync(full);
      if (stat.isDirectory()) {
        entries.push({ path: rel, dir: true });
        walk(full);
      } else if (stat.isFile()) {
        entries.push({ path: rel, dir: false, dataB64: readFileSync(full).toString("base64") });
      }
    }
  };
  walk(rootDir);
  return entries;
}

/**
 * PUAE/ami9000 wasm backend, implementing the `Emulator` interface. Backed by
 * `puae/`'s `index.html` (boot/render loop logic shared
 * via `src/webview/puaeApp/app.ts`, bundled by esbuild.js to
 * `out/puaeApp.js`) + `src/webview/puaeApp/rpc.ts`, which expose the
 * `e9k_debug` debugging layer grafted onto libretro-uae. `puae/debug.html` is
 * a standalone variant with manual breakpoint/memory/watchpoint/disassembly
 * test UI, for development outside the extension — not used by
 * `getHtmlForWebview`.
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
 *    `app.ts` writes it into MEMFS as DH0:'s only file, alongside an
 *    auto-generated one-line `s/startup-sequence` that runs it, mounted as
 *    a bootable DH0: hard disk via `filesystem=rw,dh0:/uae_system/dh0`.
 *    Ignored (for DH0: purposes — see below) when `hardDrivePath` is set.
 *  - `hardDrivePath` (optional, non-fastLoad only): host path to a directory
 *    to mount as DH0: instead of the auto-generated single-exe disk above —
 *    lets a launch config give the running program access to other files
 *    (libraries, data) and/or supply its own custom `s/startup-sequence`
 *    (e.g. to raise the stack size before running the program). The
 *    directory is authoritative: it's walked and replayed into MEMFS
 *    verbatim (see `walkHardDrive`/`hardDriveManifestB64`) — nothing is
 *    overlaid or renamed, so it must already be self-contained (the program
 *    executable, under whatever name/path its own startup-sequence expects,
 *    plus that startup-sequence itself). `programPath` is still read in this
 *    mode, but only for `expectedProcessName` (see below), not written to
 *    DH0:.
 *
 * A third, always-derived value, `expectedProcessName` (the basename of
 * `programPath`), is what `app.ts`'s `getCurrentProcess()` polling matches
 * the eventual CLI process against to detect "the program has started" and
 * attach — this is what lets program-start detection work identically
 * whether DH0: came from the auto-generated single-exe disk or a mounted
 * `hardDrivePath` directory.
 *
 * All other keys are written to `puae_libretro_global.uae` (last-line-wins).
 * Four defaults are always prepended: `cpu_compatible`, `cpu_cycle_exact`,
 * `cpu_memory_cycle_exact`, `blitter_cycle_exact` (all `true`) — override
 * by specifying the same key in `emulatorOptions`.
 *
 * Known limitations (see `src/webview/puaeApp/rpc.ts` for the implementation):
 *  - `getCpuInfo()`'s isp/msp/vbr/irc/sfc/dfc/cacr/caar fields are always
 *    "0x00000000".
 *  - `setRegister()`/`jump()` only support d0-d7/a0-a7/sr/pc/usp.
 *  - `getCpuTrace()` returns up to 256 most-recently-executed instructions.
 *  - `stepBack()`/`continueReverse()` use a ring buffer of full-state
 *    snapshots (`retro_serialize`/`retro_unserialize`).
 *  - Breakpoint `ignores` counts are not honored by the wasm engine itself
 *    (`supportsHitCounts` is false) - BreakpointManager emulates hit
 *    counting in TS instead.
 *
 * Session restart / panel reuse: `open()` while a panel is already open sends
 * a "load" command (hard reset + warm-up) rather than re-instantiating the
 * wasm module. ROM/config options from the FIRST session remain in effect for
 * reused panels — changing them requires closing the panel first.
 */
export class PuaeEmulator extends WebviewEmulator {
  public static readonly viewType = "puae-debugger.puaeWebview";
  public readonly supportsHitCounts = false;
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
        void this.sendRpcCommand("load").catch((error) => {
          console.error("Failed to reload emulator panel:", error);
        });
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
          vscode.Uri.joinPath(this.extensionUri, "out"),
          vscode.Uri.joinPath(this.extensionUri, "node_modules", "@vscode/codicons"),
        ],
      },
    );

    this.panel.webview.html = this.getHtmlForWebview(this.panel.webview, puaeDir);
    this.panelOptions = this.openOptions;

    const panel = this.panel;
    panel.onDidDispose(() => {
      this.rejectPendingRpcs(new Error("Emulator panel disposed"));
      if (this.panel === panel) {
        this.panel = undefined;
        this.panelOptions = undefined;
      }
    });

    panel.webview.onDidReceiveMessage((message) =>
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
      if (key === "programPath" || key === "kickstartRom" || key === "emulatorConfigFile" || key === "hardDrivePath") {
        continue;
      }
      lines.push(`${key}=${value}`);
    }

    if (options?.programPath || options?.hardDrivePath) {
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
    // Bundled from src/webview/puaeApp/ (TypeScript) by esbuild.js, not
    // shipped from puae/ itself — see esbuild.js's puaeAppCtx/puaeAudioCtx.
    const workletUri = webview
      .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "out", "puaeAudioProcessor.js"))
      .toString();
    const appUri = webview
      .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "out", "puaeApp.js"))
      .toString();
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

    // hardDrivePath (a directory) takes over the DH0: payload entirely when set — see this
    // class's doc comment. programPath is still used for expectedProcessName (CLI process-name
    // matching in getCurrentProcess) and isn't itself written into DH0 in that case; the
    // directory is authoritative and must already contain whatever it needs to boot/run.
    let programB64 = "";
    let hardDriveManifestB64 = "";
    const programPath = this.openOptions?.programPath as string | undefined;
    const hardDrivePath = this.openOptions?.hardDrivePath as string | undefined;
    if (hardDrivePath) {
      if (!existsSync(hardDrivePath)) {
        throw new Error(`hardDrivePath not found: ${hardDrivePath}`);
      }
      if (!statSync(hardDrivePath).isDirectory()) {
        throw new Error(`hardDrivePath is not a directory: ${hardDrivePath}`);
      }
      hardDriveManifestB64 = Buffer.from(
        JSON.stringify(walkHardDrive(hardDrivePath)),
        "utf-8",
      ).toString("base64");
    } else if (programPath) {
      if (!existsSync(programPath)) {
        throw new Error(`Program file not found: ${programPath}`);
      }
      programB64 = readFileSync(programPath).toString("base64");
    }
    const expectedProcessName = programPath ? basename(programPath) : "";

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

    // Patch the bundled app module's import to a webview URI. The bundle
    // (out/puaeApp.js, see esbuild.js) already inlines rpc.ts/copperHover.ts/
    // shared code — no further import patching needed.
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
    // it, for non-fastLoad/dos.library-dependent programs. Empty when
    // hardDrivePath is set instead — see hardDriveManifestB64 below.
    html = html.replace(
      "programB64: '',",
      `programB64: '${programB64}',`,
    );

    // Inject the walked OpenOptions.hardDrivePath directory tree (see
    // walkHardDrive) — puae_app.js replays it into the same DH0: MEMFS mount
    // point programB64 would otherwise use, verbatim (no synthesized
    // startup-sequence — the directory must already be self-contained).
    html = html.replace(
      "hardDriveManifestB64: '',",
      `hardDriveManifestB64: '${hardDriveManifestB64}',`,
    );

    // The CLI process name app.ts's getCurrentProcess() polling looks for once
    // the DH0: startup-sequence launches the program — the basename of
    // OpenOptions.programPath, regardless of whether it was written to DH0:
    // directly (programB64) or is expected to already exist somewhere in a
    // mounted hardDrivePath.
    html = html.replace(
      "expectedProcessName: '',",
      `expectedProcessName: ${toJavaScriptStringLiteral(expectedProcessName)},`,
    );

    // Patch AudioWorklet module path.
    html = html.replace(
      "audioWorkletUrl: './puae_audioprocessor.js',",
      `audioWorkletUrl: '${workletUri}',`,
    );

    return html;
  }
}
