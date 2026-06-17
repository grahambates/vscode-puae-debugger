/* eslint-disable @typescript-eslint/no-explicit-any */
import * as vscode from "vscode";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { u32, u16, u8 } from "./numbers";
import { Emulator } from "./emulator";
import {
  CpuInfo,
  CpuTraceItem,
  CustomRegisters,
  Disassembly,
  EmulatorMessage,
  MemoryInfo,
  RegisterSetStatus,
  isValidMemoryAddress,
  getMemoryRegionForAddress,
} from "./vAmiga";

interface PendingRpc {
  resolve: (result: any) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

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
export class PuaeEmulator implements Emulator {
  public static readonly viewType = "vamiga-debugger.puaeWebview";
  private panel?: vscode.WebviewPanel;
  private openOptions?: Record<string, unknown>;
  // Options that were used to generate the current panel's HTML — used to
  // detect when a config change requires a full panel reinitialisation.
  private panelOptions?: Record<string, unknown>;
  private pendingRpcs = new Map<string, PendingRpc>();
  private messageListeners: Set<(message: EmulatorMessage) => void> = new Set();

  memoryInfo?: MemoryInfo;
  cpuInfo?: CpuInfo;
  customRegisters?: CustomRegisters;

  constructor(private readonly extensionUri: vscode.Uri) {}

  /**
   * Opens the PUAE emulator webview panel.
   *
   * If `kickstartRom` is not set, AROS is used as the default ROM for
   * non-fastLoad launches; fastLoad without an explicit ROM throws.
   */
  public open(options?: Record<string, unknown>): void {
    this.openOptions = options;
    if (this.panel) {
      if (this.optionsMatchPanel(options)) {
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

  private optionsMatchPanel(options?: Record<string, unknown>): boolean {
    const normalise = (o?: Record<string, unknown>) =>
      JSON.stringify(o, Object.keys(o ?? {}).sort());
    return normalise(options) === normalise(this.panelOptions);
  }

  /**
   * Brings the PUAE webview panel to the foreground
   */
  public reveal(): void {
    this.panel?.reveal();
  }

  /**
   * Registers a listener for emulator messages
   * @param callback Function to call when messages are received
   * @returns Disposable to unregister the listener
   */
  public onDidReceiveMessage(
    callback: (message: EmulatorMessage) => void,
  ): vscode.Disposable {
    this.messageListeners.add(callback);
    return {
      dispose: () => {
        this.messageListeners.delete(callback);
      },
    };
  }

  private notifyMessageListeners(message: EmulatorMessage): void {
    for (const listener of this.messageListeners) {
      try {
        listener(message);
      } catch (error) {
        console.error("Error in message listener:", error);
      }
    }
  }

  public onDidDispose(callback: () => void): vscode.Disposable | undefined {
    return this.panel?.onDidDispose(callback);
  }

  /**
   * Sends a one-way command to the PUAE emulator (no response expected)
   * @param command Command name to send
   * @param args Optional command arguments
   */
  public sendCommand<A = any>(command: string, args?: A): void {
    if (this.panel) {
      this.panel.webview.postMessage({ command, args });
    } else {
      vscode.window.showErrorMessage("Emulator panel is not open");
    }
  }

  /**
   * Atomically cleans up a pending RPC and returns its handlers if found.
   * Prevents race conditions between timeout and response handling.
   */
  private cleanupPendingRpc(rpcId: string): PendingRpc | null {
    const pending = this.pendingRpcs.get(rpcId);
    if (!pending) return null; // Already cleaned up

    this.pendingRpcs.delete(rpcId);
    clearTimeout(pending.timeout);
    return pending;
  }

  /**
   * Sends an RPC command to the PUAE emulator and waits for a response
   * @param command RPC command name
   * @param args Optional command arguments
   * @param timeoutMs Timeout in milliseconds (default: 5000)
   * @returns Promise that resolves with the command response
   * @throws Error on timeout or if webview is not open
   */
  public async sendRpcCommand<T = any, A = any>(
    command: string,
    args?: A,
    timeoutMs = 5000,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.panel) {
        reject(new Error("Emulator panel is not open"));
        return;
      }

      const id = Math.random().toString(36).substring(2, 15);
      const timeout = setTimeout(() => {
        const pending = this.cleanupPendingRpc(id);
        if (pending) {
          pending.reject(
            new Error(`RPC timeout after ${timeoutMs}ms: ${command}`),
          );
        }
      }, timeoutMs);

      this.pendingRpcs.set(id, { resolve, reject, timeout });
      this.panel.webview.postMessage({
        command,
        args: { ...args, _rpcId: id },
      });
    });
  }

  public dispose(): void {
    for (const [, pending] of this.pendingRpcs) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Webview disposed"));
    }
    this.pendingRpcs.clear();

    this.panel?.dispose();
  }

  // --- Execution control ---

  public pause(): void {
    this.invalidateCache();
    this.sendCommand("pause");
  }

  public run(): void {
    this.invalidateCache();
    this.sendCommand("run");
  }

  public stepInto(): void {
    this.invalidateCache();
    this.sendCommand("stepInto");
  }

  /**
   * Restores the most recently captured full-state snapshot (taken before
   * each run/stepInto/eof/eol), giving exact instruction-level step-back.
   * Returns `false` once the bounded snapshot history is exhausted.
   */
  public async stepBack(): Promise<boolean> {
    this.invalidateCache();
    const res = await this.sendRpcCommand("stepBack");
    return !!res;
  }

  /**
   * Walks back through the snapshot history, restoring each in turn, until
   * one whose PC is at a breakpoint, or history is exhausted (lands at the
   * oldest retained snapshot).
   */
  public async continueReverse(): Promise<boolean> {
    this.invalidateCache();
    const res = await this.sendRpcCommand("continueReverse");
    return !!res;
  }

  /**
   * Steps back to the start of the current frame (the most recent vblank
   * boundary before the current position), using the same checkpoint+replay
   * history as stepBack/continueReverse.
   */
  public async stepBackFrame(): Promise<boolean> {
    this.invalidateCache();
    const res = await this.sendRpcCommand("stepBackFrame");
    return !!res;
  }

  public eof(): void {
    this.invalidateCache();
    this.sendCommand("eof");
  }

  public eol(): void {
    this.invalidateCache();
    this.sendCommand("eol");
  }

  // --- Breakpoints, watchpoints, catchpoints ---

  public setBreakpoint(address: number, ignores = 0): void {
    this.sendCommand("setBreakpoint", { address, ignores });
  }

  public removeBreakpoint(address: number): void {
    this.sendCommand("removeBreakpoint", { address });
  }

  public setWatchpoint(address: number, ignores = 0): void {
    this.sendCommand("setWatchpoint", { address, ignores });
  }

  public removeWatchpoint(address: number): void {
    this.sendCommand("removeWatchpoint", { address });
  }

  public setCatchpoint(vector: number, ignores = 0): void {
    this.sendCommand("setCatchpoint", { vector, ignores });
  }

  public removeCatchpoint(vector: number): void {
    this.sendCommand("removeCatchpoint", { vector });
  }

  // --- CPU / registers ---

  /**
   * Enables/disables the CPU instruction trace ring buffer. Enabled by
   * default, since nothing currently calls this to turn logging on.
   */
  public enableCpuLogging(enabled: boolean): void {
    this.sendCommand("enableCpuLogging", { enabled });
  }

  /**
   * Returns the most recently executed instructions (most recent first),
   * up to `count` (capped at 256, the size of the trace ring buffer).
   */
  public async getCpuTrace(count = 256): Promise<CpuTraceItem[]> {
    return this.sendRpcCommand("getCpuTrace", { count });
  }

  public async getCpuInfo(): Promise<CpuInfo> {
    if (!this.cpuInfo) {
      this.cpuInfo = await this.sendRpcCommand("getCpuInfo");
    }
    return this.cpuInfo;
  }

  /**
   * Sets a CPU register to the specified value. Only d0-d7, a0-a7, sr and pc
   * are addressable via `e9k_debug_write_reg`; other register names reject.
   */
  public async setRegister(
    name: string,
    value: number,
  ): Promise<RegisterSetStatus> {
    this.cpuInfo = undefined; // Clear cache
    return this.sendRpcCommand("setRegister", { name, value });
  }

  public async jump(address: number): Promise<void> {
    this.invalidateCache();
    return this.sendRpcCommand("jump", { address });
  }

  // --- Custom (chipset) registers ---

  /**
   * Always returns `{}` — chip-register introspection isn't catalogued yet.
   */
  public async getAllCustomRegisters(): Promise<CustomRegisters> {
    if (!this.customRegisters) {
      this.customRegisters = await this.sendRpcCommand("getAllCustomRegisters");
    }
    return this.customRegisters;
  }

  public async pokeCustom16(
    address: number,
    value: number,
  ): Promise<RegisterSetStatus> {
    this.customRegisters = undefined; // Clear cache
    return this.sendRpcCommand("pokeCustom16", { address, value });
  }

  public async pokeCustom32(
    address: number,
    value: number,
  ): Promise<RegisterSetStatus> {
    this.customRegisters = undefined; // Clear cache
    return this.sendRpcCommand("pokeCustom32", { address, value });
  }

  // --- Memory access ---

  public async readMemory(address: number, count: number): Promise<Buffer> {
    const res = await this.sendRpcCommand("readMemory", { address, count });
    return Buffer.from(res.data);
  }

  public async writeMemory(address: number, data: Buffer): Promise<void> {
    return this.sendRpcCommand("writeMemory", {
      address,
      data: new Uint8Array(data),
    });
  }

  public async peek32(address: number): Promise<number> {
    const res = await this.sendRpcCommand("peek32", { address });
    // Use unsigned shift to preserve sign
    return res >>> 0;
  }

  public async peek16(address: number): Promise<number> {
    return this.sendRpcCommand("peek16", { address });
  }

  public async peek8(address: number): Promise<number> {
    return this.sendRpcCommand("peek8", { address });
  }

  public async poke32(address: number, value: number): Promise<void> {
    return this.sendRpcCommand("poke32", { address, value: u32(value) });
  }

  public async poke16(address: number, value: number): Promise<void> {
    return this.sendRpcCommand("poke16", { address, value: u16(value) });
  }

  public async poke8(address: number, value: number): Promise<void> {
    return this.sendRpcCommand("poke8", { address, value: u8(value) });
  }

  public async getMemoryInfo(): Promise<MemoryInfo> {
    return this.sendRpcCommand("getMemoryInfo");
  }

  public getCachedMemoryInfo(): MemoryInfo | undefined {
    return this.memoryInfo;
  }

  public isValidAddress(address: number): boolean {
    return isValidMemoryAddress(this.memoryInfo, address);
  }

  public getMemoryRegion(
    address: number,
  ): { start: number; end: number } | null {
    return getMemoryRegionForAddress(this.memoryInfo, address);
  }

  // --- Disassembly ---

  public async disassemble(
    address: number,
    count: number,
  ): Promise<Disassembly> {
    return this.sendRpcCommand("disassemble", { address, count });
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
        localResourceRoots: [puaeDir],
      },
    );

    this.panel.webview.html = this.getHtmlForWebview(this.panel.webview, puaeDir);
    this.panelOptions = this.openOptions;

    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.panelOptions = undefined;
    });

    this.panel.webview.onDidReceiveMessage((message) => {
      if (message.type === "rpcResponse") {
        const pending = this.cleanupPendingRpc(message.id);
        if (pending) {
          if (message.result?.error) {
            pending.reject(new Error(message.result.error));
          } else {
            pending.resolve(message.result);
          }
        }
      } else if (message.type === "exec-ready") {
        // Only need to fetch memory info once on load
        this.getMemoryInfo()
          .then((memoryInfo) => {
            this.memoryInfo = memoryInfo;
          })
          .catch((error) => {
            console.error("Failed to fetch memory info on exec-ready:", error);
          });
      }

      this.notifyMessageListeners(message);
    });
  }

  private getConfiguredViewColumn(): vscode.ViewColumn {
    const config = vscode.workspace.getConfiguration("vamiga-debugger");
    const setting = config.get<string>("defaultViewColumn", "beside");

    switch (setting) {
      case "one":
        return vscode.ViewColumn.One;
      case "two":
        return vscode.ViewColumn.Two;
      case "three":
        return vscode.ViewColumn.Three;
      case "beside":
        return vscode.ViewColumn.Beside;
      case "active":
        return (
          vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One
        );
      default:
        return vscode.ViewColumn.Beside;
    }
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
      `style-src 'unsafe-inline'`,
      `worker-src ${src} blob:`,
      `connect-src ${src} data:`,
      `img-src data:`,
    ].join("; ");

    let html = readFileSync(join(puaeFsPath, "index.html"), "utf8");

    // Inject CSP meta tag.
    html = html.replace(
      '<meta charset="utf-8">',
      `<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${csp}">`,
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

  private invalidateCache(): void {
    this.cpuInfo = undefined;
    this.customRegisters = undefined;
  }
}
