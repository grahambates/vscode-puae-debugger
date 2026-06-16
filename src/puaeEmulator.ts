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
 * `VAmiga`. Backed by `puae/`'s `index.html` (boot/render loop logic shared
 * via `puae_app.js`) + `puae_rpc.js`, which expose the `e9k_debug` debugging
 * layer grafted onto libretro-uae. `puae/debug.html` is a standalone variant
 * with manual breakpoint/memory/watchpoint/disassembly test UI, for
 * development outside the extension — not used by `getHtmlForWebview`.
 *
 * `OpenOptions` support: `kickstartRomPath` is REQUIRED — `getHtmlForWebview`
 * throws if it isn't set. No Kickstart ROM is bundled with this extension
 * (Kickstart ROMs are copyrighted by Cloanto/Amiga Inc.), and the embedded
 * AROS replacement ROM (`kickstart_rom_file=:AROS`) isn't currently usable as
 * a fastLoad target — `exec.library`'s memory list isn't initialized the way
 * `AmigaMemoryMapper` expects within any reasonable warm-up window.
 * `kickstartExtPath` and `emulatorOptions.vamiga` (vAmiga-only hardware/
 * display options — see `VamigaOptions`) are ignored, with a `console.warn`
 * listing any that were set.
 *
 * `chipRam`/`slowRam`/`fastRam`/`cpuRevision`, `configFilePath`,
 * `emulatorOptions.puae` and `programPath` ARE honored, via
 * `buildExtraConfig()` writing a `.uae`-format `puae_libretro_global.uae`
 * file into the wasm MEMFS before boot — `retro_create_config()` appends its
 * lines to the generated config with last-line-wins precedence, so:
 *  - `configFilePath` (if set) provides the base config (lowest precedence).
 *    This may itself be a full preset (e.g. a `quickstart=A1200,1` line),
 *    which `chipRam`/`slowRam`/`fastRam`/`cpuRevision` below can selectively
 *    override.
 *  - `emulatorOptions.puae` (raw `key=value` pairs) overrides the base
 *    config, but is itself overridden by `chipRam`/`slowRam`/`fastRam`/
 *    `cpuRevision` below.
 *  - `chipRam`/`slowRam`/`fastRam`/`cpuRevision` (highest precedence) map to
 *    `chipmem_size`/`bogomem_size`/`fastmem_size`/`cpu_model` and override
 *    everything above. `fastRam: "256k"`/`"512k"` round up to 1MB (PUAE's
 *    `fastmem_size` is in 1MB units). `cpuRevision` maps directly to
 *    `cpu_model` for `"68000"`/`"68010"`/`"68020"`/`"68030"`/`"68040"`/
 *    `"68060"` (a real CPU of that model, with MMU/FPU where applicable);
 *    `"fake_68030"` (vAmiga's pipeline-only approximation) is not supported
 *    and throws.
 *  - `programPath` (non-fastLoad/`dos.library`-dependent programs): the exe
 *    is read and base64-injected as `programB64`; `puae_app.js` writes it
 *    into `/uae_system/dh0/file` plus `/uae_system/dh0/s/startup-sequence`
 *    (containing `"file"`) in the MEMFS, and a `filesystem=rw,dh0:/uae_system/dh0`
 *    line mounts that directory as a bootable DH0: hard disk (AmigaOS's
 *    `uaehf.device` autoconfigures it — no ADF/bootblock/OFS image needed).
 *    The render loop then polls for the program's CLI process via an
 *    AllocMem breakpoint (`tryExec`/`getCurrentProcess` in `puae_rpc.js`,
 *    ported from `vAmiga_ui.js`) and posts `{type:'attached', segments}` once
 *    found.
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
 *  - `getCpuTrace()` returns up to 256 most-recently-executed instructions
 *    (pc/instruction/flags/length) from an always-on ring buffer;
 *    `enableCpuLogging(false)` pauses recording.
 *  - `stepBack()`/`continueReverse()` restore from an in-memory ring buffer
 *    of up to `MAX_SNAPSHOT_HISTORY` (puae_rpc.js) full-state snapshots
 *    (`retro_serialize`/`retro_unserialize`, the same mechanism RetroArch
 *    uses for "rewind"), captured before each run/stepInto/eof/eol. Once
 *    that history is exhausted, `stepBack()` resolves `false` and
 *    `continueReverse()` lands at the oldest retained snapshot. Stepping
 *    back through a long free-running `continue` to an arbitrary
 *    instruction (not just the pre-`continue` state) isn't supported.
 *  - Breakpoint/watchpoint `ignores` counts are not supported; a non-zero
 *    count is logged as a warning and otherwise ignored.
 *
 * Session restart / panel reuse: if `open()` is called while a panel from a
 * previous debug session is still open, it is reused as-is — `open()` sends
 * a "load" command (puae_rpc.js) which hard-resets the emulated machine
 * (`wasm_reset()`/`uae_reset(1,0)`, reboots Kickstart with RAM cleared) and
 * re-runs the boot warm-up, then re-signals exec-ready so the debug adapter
 * re-runs fastLoad injection for the new program. This is much cheaper than
 * re-instantiating the wasm module/webview, but it means ROM/config-affecting
 * `OpenOptions` (`kickstartRomPath`, `configFilePath`, `chipRam`/`slowRam`/
 * `fastRam`/`cpuRevision`, `emulatorOptions.puae`, `programPath`) from the
 * FIRST session remain in effect for reused panels — changing them requires
 * closing the panel first. For `programPath` specifically, "load" doesn't
 * rewrite `/uae_system/dh0` or re-run `retro_load_game`'s autoconfig, so a
 * new program won't be picked up by a reused panel even if the file at the
 * original `programPath` is overwritten on disk.
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
   * `OpenOptions.kickstartRomPath` is required (see class doc comment) —
   * `getHtmlForWebview` throws if it isn't set.
   */
  public open(options?: OpenOptions): void {
    this.openOptions = options;
    if (this.panel) {
      this.panel.reveal();
      // Reuse the already-booted webview for the new session: hard-reset the
      // emulated machine and re-run the boot warm-up (puae_rpc.js's "load"
      // command), which re-signals exec-ready so the debug adapter re-runs
      // fastLoad injection for the new program — avoids re-instantiating the
      // wasm module/webview, which is what made restart slow/broken before.
      this.invalidateCache();
      this.memoryInfo = undefined;
      this.sendCommand("load");
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
   * ignored by this backend — see the class doc comment for the
   * documented-gaps rationale.
   */
  private warnIgnoredOpenOptions(): void {
    if (!this.openOptions) {
      return;
    }
    const ignoredKeys: (keyof OpenOptions)[] = ["kickstartExtPath"];
    const set = ignoredKeys.filter((key) => this.openOptions?.[key] !== undefined);
    if (set.length > 0) {
      console.warn(
        `PuaeEmulator: ignoring unsupported emulatorOptions: ${set.join(", ")}`,
      );
    }
    const vamiga = this.openOptions.vamiga;
    if (vamiga && Object.values(vamiga).some((value) => value !== undefined)) {
      console.warn(
        "PuaeEmulator: ignoring vamiga options (vAmiga-specific options, not applicable to PUAE)",
      );
    }
  }

  // .uae `chipmem_size`/`bogomem_size`/`fastmem_size`/`cpu_model` values for
  // the corresponding OpenOptions enums. See class doc comment for caveats.
  private static readonly CHIP_RAM_CONFIG: Record<string, number> = {
    "256k": 0,
    "512k": 1,
    "1M": 2,
    "2M": 4,
  };
  private static readonly SLOW_RAM_CONFIG: Record<string, number> = {
    "0": 0,
    "256k": 1,
    "512k": 2,
  };
  private static readonly FAST_RAM_CONFIG: Record<string, number> = {
    "0": 0,
    "256k": 1,
    "512k": 1,
    "1M": 1,
    "2M": 2,
    "8M": 8,
  };
  private static readonly CPU_MODEL_CONFIG: Record<string, number> = {
    "68000": 68000,
    "68010": 68010,
    "68020": 68020,
    "68030": 68030,
    "68040": 68040,
    "68060": 68060,
  };

  /**
   * Builds the `.uae`-format config text to write to
   * `/uae_system/puae_libretro_global.uae` before boot, layering (in
   * increasing precedence, later lines win — see class doc comment):
   * `configFilePath` content, then mapped `chipRam`/`slowRam`/`fastRam`/
   * `cpuRevision`, then raw `emulatorOptions.puae` overrides. Returns ""
   * if there's nothing to write.
   */
  private buildExtraConfig(): string {
    const options = this.openOptions;
    const lines: string[] = [
      "cpu_compatible=true",
      "cpu_cycle_exact=true",
      "cpu_memory_cycle_exact=true",
      "blitter_cycle_exact=true",
    ];

    if (options?.configFilePath) {
      if (!existsSync(options.configFilePath)) {
        throw new Error(`Config file not found: ${options.configFilePath}`);
      }
      lines.push(readFileSync(options.configFilePath, "utf-8").trimEnd());
    }
    for (const [key, value] of Object.entries(options?.puae ?? {})) {
      lines.push(`${key}=${value}`);
    }
    if (options?.chipRam) {
      lines.push(`chipmem_size=${PuaeEmulator.CHIP_RAM_CONFIG[options.chipRam]}`);
    }
    if (options?.slowRam) {
      lines.push(`bogomem_size=${PuaeEmulator.SLOW_RAM_CONFIG[options.slowRam]}`);
    }
    if (options?.fastRam) {
      lines.push(`fastmem_size=${PuaeEmulator.FAST_RAM_CONFIG[options.fastRam]}`);
    }
    if (options?.cpuRevision) {
      if (options.cpuRevision === "fake_68030") {
        throw new Error(
          `PUAE doesn't support vAmiga's "fake_68030" CPU model — use "68030", ` +
            `"68040", or "68060" for a real 68030+ CPU, or emulatorBackend: "vamiga".`,
        );
      }
      lines.push(`cpu_model=${PuaeEmulator.CPU_MODEL_CONFIG[options.cpuRevision]}`);
    }
    if (options?.programPath) {
      // Mount the directory puae_app.js populates (program + s/startup-sequence)
      // as a bootable DH0: hard disk — see PuaeEmulator.getHtmlForWebview's
      // programB64 injection and the class doc comment.
      lines.push("filesystem=rw,dh0:/uae_system/dh0");
    }

    return lines.length > 0 ? lines.join("\n") + "\n" : "";
  }

  private getHtmlForWebview(webview: vscode.Webview, puaeDir: vscode.Uri): string {
    const puaeFsPath = join(this.extensionUri.fsPath, "puae");
    const uri = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(puaeDir, file)).toString();

    const puaeJsUri = uri("puae.js");
    const puaeWasmUri = uri("puae.wasm");
    const workletUri = uri("puae_audioprocessor.js");
    const appUri = uri("puae_app.js");

    this.warnIgnoredOpenOptions();

    if (!this.openOptions?.kickstartRomPath) {
      throw new Error(
        "PUAE requires emulatorOptions/OpenOptions.kickstartRomPath to be set " +
          "to a Kickstart ROM file — no ROM is bundled with this extension " +
          "(Kickstart ROMs are copyrighted by Cloanto/Amiga Inc.).",
      );
    }
    if (!existsSync(this.openOptions.kickstartRomPath)) {
      throw new Error(
        `Kickstart ROM file not found: ${this.openOptions.kickstartRomPath}`,
      );
    }
    const romData = readFileSync(this.openOptions.kickstartRomPath);
    const romDataUri = `data:application/octet-stream;base64,${romData.toString("base64")}`;

    const extraConfig = this.buildExtraConfig();
    const extraConfigB64 = extraConfig
      ? Buffer.from(extraConfig, "utf-8").toString("base64")
      : "";

    let programB64 = "";
    if (this.openOptions.programPath) {
      if (!existsSync(this.openOptions.programPath)) {
        throw new Error(`Program file not found: ${this.openOptions.programPath}`);
      }
      programB64 = readFileSync(this.openOptions.programPath).toString("base64");
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
