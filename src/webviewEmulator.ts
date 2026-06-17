/* eslint-disable @typescript-eslint/no-explicit-any */
import * as vscode from "vscode";
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

/**
 * A pending request/response RPC awaiting its reply from the webview.
 */
export interface PendingRpc {
  resolve: (result: any) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

/**
 * Shared base class for webview-backed Amiga emulator backends.
 *
 * Holds everything that is identical across the concrete backends: the
 * postMessage RPC layer (request/response correlation, timeouts, disposal),
 * message-listener fan-out, the register/memory-info caches, and all of the
 * `Emulator` command/query wrappers that simply forward to the webview.
 *
 * Subclasses (`VAmiga`, `PuaeEmulator`) supply only the backend-specific
 * pieces: `open()` (panel creation/reuse policy) and the panel/HTML wiring,
 * which differ between the vAmiga and PUAE webviews. Subclass `initPanel`
 * implementations should call `handlePanelMessage` for each received message
 * to get the shared RPC-response / exec-ready / listener handling.
 */
export abstract class WebviewEmulator implements Emulator {
  protected panel?: vscode.WebviewPanel;
  protected pendingRpcs = new Map<string, PendingRpc>();
  protected messageListeners = new Set<(message: EmulatorMessage) => void>();

  memoryInfo?: MemoryInfo;
  cpuInfo?: CpuInfo;
  customRegisters?: CustomRegisters;

  constructor(protected readonly extensionUri: vscode.Uri) {}

  // --- Lifecycle ---

  /**
   * Opens (or reuses) the emulator webview panel. Backend-specific: each
   * concrete emulator decides how a panel is created and when an existing
   * panel can be reused vs. recreated.
   */
  public abstract open(options?: Record<string, unknown>): void;

  /**
   * Brings the webview panel to the foreground.
   */
  public reveal(): void {
    this.panel?.reveal();
  }

  /**
   * Registers a listener for emulator messages.
   * Unlike the panel's onDidReceiveMessage, this works even when the panel is
   * not yet open.
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

  /**
   * Notifies all registered message listeners.
   * @param message The emulator message to broadcast
   */
  protected notifyMessageListeners(message: EmulatorMessage): void {
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

  // --- RPC plumbing ---

  /**
   * Sends a one-way command to the emulator (no response expected).
   * @param command Command name to send
   * @param args Optional command arguments
   */
  public sendCommand<A = any>(command: string, args?: A): void {
    this.panel?.webview.postMessage({ command, args });
  }

  /**
   * Atomically cleans up a pending RPC and returns its handlers if found.
   * Prevents race conditions between timeout and response handling.
   * @param rpcId The RPC ID to clean up
   * @returns The pending RPC handlers, or null if already cleaned up
   */
  protected cleanupPendingRpc(rpcId: string): PendingRpc | null {
    const pending = this.pendingRpcs.get(rpcId);
    if (!pending) return null; // Already cleaned up

    this.pendingRpcs.delete(rpcId);
    clearTimeout(pending.timeout);
    return pending;
  }

  /**
   * Sends an RPC command to the emulator and waits for a response.
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
    // Clean up any pending RPCs
    for (const [, pending] of this.pendingRpcs) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Webview disposed"));
    }
    this.pendingRpcs.clear();

    this.panel?.dispose();
  }

  /**
   * Shared handler for messages posted from the webview. Subclass `initPanel`
   * implementations should wire `panel.webview.onDidReceiveMessage` to this.
   * Resolves/rejects pending RPCs, refreshes the memory map on exec-ready, and
   * fans the message out to registered listeners.
   */
  protected handlePanelMessage(message: any): void {
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

    // Notify all registered listeners about this message
    this.notifyMessageListeners(message);
  }

  /**
   * Resolves the configured `defaultViewColumn` setting to a ViewColumn for
   * newly created panels.
   */
  protected getConfiguredViewColumn(): vscode.ViewColumn {
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
   * Order-independent structural comparison of two option records, used to
   * decide whether an already-open panel can be reused for new open options.
   */
  protected optionsMatch(a?: object, b?: object): boolean {
    const normalise = (o?: object) =>
      JSON.stringify(o, Object.keys(o ?? {}).sort());
    return normalise(a) === normalise(b);
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

  public async stepBack(): Promise<boolean> {
    this.invalidateCache();
    const res = await this.sendRpcCommand("stepBack");
    return !!res;
  }

  public async continueReverse(): Promise<boolean> {
    this.invalidateCache();
    const res = await this.sendRpcCommand("continueReverse");
    return !!res;
  }

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

  public enableCpuLogging(enabled: boolean): void {
    this.sendCommand("enableCpuLogging", { enabled });
  }

  /**
   * Returns the most recently executed instructions (most recent first), up to
   * `count`. The default unwraps the common `{ trace }` response shape;
   * backends with a different wire shape override this.
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

  // --- Helpers ---

  protected invalidateCache(): void {
    this.cpuInfo = undefined;
    this.customRegisters = undefined;
  }
}
