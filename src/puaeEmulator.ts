/* eslint-disable @typescript-eslint/no-explicit-any */
import * as vscode from "vscode";
import { existsSync, readFileSync, realpathSync } from "fs";
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
  OpenOptions,
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
 * `VAmiga`. Backed by `puae/`'s `index.html` + `puae_rpc.js`,
 * which expose the `e9k_debug` debugging layer grafted onto libretro-uae.
 *
 * `OpenOptions` support (Stage G4): only `kickstartRomPath` is honored —
 * if set, that ROM is embedded instead of the bundled Kickstart 1.3. This
 * backend is fastLoad-only: `programPath`/`kickstartExtPath` and all
 * hardware-configuration options (`chipRam`/`agnusRevision`/`cpuRevision`/
 * etc., `useArosRom`, display/input options) are ignored, with a
 * `console.warn` listing any that were set.
 *
 * Documented gaps vs. `VAmiga` (see `puae_rpc.js` for the implementation of
 * each):
 *  - `getCpuInfo()`'s isp/msp/vbr/irc/sfc/dfc/cacr/caar fields are always
 *    "0x00000000" — `e9k_debug_read_regs` doesn't expose them (usp is real).
 *  - `setRegister()`/`jump()` only support d0-d7/a0-a7/sr/pc/usp; other
 *    names reject with an error.
 *  - `getAllCustomRegisters()` covers the genuinely-readable "...R" registers
 *    (DMACON, INTENA, etc.) plus BPLCON0-3/DIWSTRT-STOP/DDFSTRT-STOP/
 *    COLOR00-31 (write-only on real hardware, exposed via a dedicated wasm
 *    export). Other write-only registers (sprite/bitplane/audio pointers,
 *    COP1LC/COP2LC, etc.) aren't catalogued yet (writes via
 *    `pokeCustom16/32` work).
 *  - `getCpuTrace()` always returns `[]`, and `enableCpuLogging()` is a
 *    no-op — instruction logging isn't implemented.
 *  - `stepBack()`/`continueReverse()` always resolve `false` (no execution
 *    history is recorded).
 *  - Breakpoint/watchpoint `ignores` counts are not supported; a non-zero
 *    count is logged as a warning and otherwise ignored.
 */
export class PuaeEmulator implements Emulator {
  public static readonly viewType = "vamiga-debugger.puaeWebview";
  private panel?: vscode.WebviewPanel;
  private openOptions?: OpenOptions;
  private pendingRpcs = new Map<string, PendingRpc>();
  private messageListeners: Set<(message: EmulatorMessage) => void> = new Set();

  memoryInfo?: MemoryInfo;
  cpuInfo?: CpuInfo;
  customRegisters?: CustomRegisters;

  constructor(private readonly extensionUri: vscode.Uri) {}

  /**
   * Opens the PUAE emulator webview panel.
   *
   * Of `OpenOptions`, only `kickstartRomPath` is honored (see class doc
   * comment) — everything else falls back to the bundled Kickstart 1.3 ROM
   * and demo ADF on a fixed A500/OCS/512K-chip configuration.
   */
  public open(options?: OpenOptions): void {
    this.openOptions = options;
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    this.initPanel();
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
   * No execution history is recorded by the PUAE backend, so there is
   * nothing to step back to.
   */
  public async stepBack(): Promise<boolean> {
    return false;
  }

  /**
   * No execution history is recorded by the PUAE backend, so there is
   * nothing to reverse-continue to.
   */
  public async continueReverse(): Promise<boolean> {
    return false;
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
   * Not implemented — the PUAE backend doesn't record an instruction trace.
   */
  public enableCpuLogging(enabled: boolean): void {
    this.sendCommand("enableCpuLogging", { enabled });
  }

  /**
   * Always returns an empty array — see `enableCpuLogging`.
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
      "vAmiga (PUAE)",
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

    this.panel.onDidDispose(() => {
      this.panel = undefined;
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
   * Logs a warning listing any `OpenOptions` fields that were set but are
   * ignored by this backend (everything except `kickstartRomPath`) — see
   * the class doc comment for the documented-gaps rationale.
   */
  private warnIgnoredOpenOptions(): void {
    if (!this.openOptions) {
      return;
    }
    const ignoredKeys: (keyof OpenOptions)[] = [
      "programPath",
      "kickstartExtPath",
      "useArosRom",
      "showNavBar",
      "wideScreen",
      "darkMode",
      "enableMouse",
      "displayZoom",
      "useGpu",
      "agnusRevision",
      "deniseRevision",
      "cpuRevision",
      "cpuSpeed",
      "chipRam",
      "slowRam",
      "fastRam",
      "blitterAccuracy",
      "floppyDriveCount",
      "driveSpeed",
    ];
    const set = ignoredKeys.filter((key) => this.openOptions?.[key] !== undefined);
    if (set.length > 0) {
      console.warn(
        `PuaeEmulator: ignoring unsupported emulatorOptions: ${set.join(", ")}`,
      );
    }
  }

  private getHtmlForWebview(webview: vscode.Webview, puaeDir: vscode.Uri): string {
    const puaeFsPath = join(this.extensionUri.fsPath, "puae");
    const uri = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(puaeDir, file)).toString();

    const puaeJsUri = uri("puae.js");
    const puaeWasmUri = uri("puae.wasm");
    const workletUri = uri("puae_audioprocessor.js");
    const rpcUri = uri("puae_rpc.js");

    this.warnIgnoredOpenOptions();

    let romData: Buffer;
    if (this.openOptions?.kickstartRomPath) {
      if (!existsSync(this.openOptions.kickstartRomPath)) {
        throw new Error(
          `Kickstart ROM file not found: ${this.openOptions.kickstartRomPath}`,
        );
      }
      romData = readFileSync(this.openOptions.kickstartRomPath);
    } else {
      // ROM is a symlink — read via resolved real path so fs.readFileSync can reach it.
      const romRealPath = realpathSync(join(puaeFsPath, "kick34005.A500"));
      romData = readFileSync(romRealPath);
    }
    const romDataUri = `data:application/octet-stream;base64,${romData.toString("base64")}`;

    // CSP: scripts from webview resource scheme, inline JS (incl. the page's
    // inline module), wasm-unsafe-eval for wasm execution, workers for
    // AudioWorklet, connect for fetches.
    const src = webview.cspSource;
    const csp = [
      `default-src 'none'`,
      `script-src ${src} 'unsafe-inline' 'wasm-unsafe-eval'`,
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

    // Patch the RPC dispatcher's module import to a webview URI.
    html = html.replace(
      "from './puae_rpc.js';",
      `from '${rpcUri}';`,
    );

    // Override locateFile so emscripten finds puae.wasm via webview URI,
    // not relative to window.location (which has no meaning in the webview).
    html = html.replace(
      "const M = await createPuaeModule();",
      `const M = await createPuaeModule({ locateFile: (p) => p.endsWith('.wasm') ? '${puaeWasmUri}' : p });`,
    );

    // Patch ROM fetch path to a webview-accessible URI.
    // ROM is a symlink — use the already-resolved data URI.
    html = html.replace("fetchBytes('./kick34005.A500')", `fetchBytes('${romDataUri}')`);

    // Patch AudioWorklet module path.
    html = html.replace(
      "addModule('./puae_audioprocessor.js')",
      `addModule('${workletUri}')`,
    );

    return html;
  }

  private invalidateCache(): void {
    this.cpuInfo = undefined;
    this.customRegisters = undefined;
  }
}
