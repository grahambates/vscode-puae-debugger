/* eslint-disable @typescript-eslint/no-explicit-any */
import * as vscode from "vscode";
import { u32, u16, u8 } from "./numbers";
import { Emulator, WatchpointOptions } from "./emulator";
import {
  CpuInfo,
  CpuTraceItem,
  CustomRegisters,
  EmulatorMessage,
  MemoryInfo,
  RegisterSetStatus,
  isValidMemoryAddress,
  getMemoryRegionForAddress,
} from "./emulatorProtocol";
import { SourceMap } from "./sourceMap";
import { openSourceLocation } from "./sourceNav";
import { decodeAgaColors } from "./shared/dma";
import type {
  PuaeRpcArgs,
  PuaeRpcCommand,
  PuaeRpcResult,
} from "./shared/puaeRpcProtocol";

/**
 * A pending request/response RPC awaiting its reply from the webview.
 */
export interface PendingRpc {
  resolve: (result: any) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

/**
 * JSON serialization with object keys sorted at every nesting level.
 * Arrays retain their original order.
 */
export function stableStringify(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, nestedValue) => {
    if (
      nestedValue !== null &&
      typeof nestedValue === "object" &&
      !Array.isArray(nestedValue)
    ) {
      return Object.fromEntries(
        Object.entries(nestedValue).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return nestedValue;
  });
}

/**
 * Base class for a webview-backed Amiga emulator backend.
 *
 * Holds the generic plumbing: the postMessage RPC layer (request/response
 * correlation, timeouts, disposal), message-listener fan-out, the
 * register/memory-info caches, and all of the `Emulator` command/query
 * wrappers that simply forward to the webview.
 *
 * A subclass (`PuaeEmulator`) supplies only the backend-specific pieces:
 * `open()` (panel creation/reuse policy) and the panel/HTML wiring. A
 * subclass's `initPanel` implementation should call `handlePanelMessage` for
 * each received message to get the shared RPC-response / exec-ready /
 * listener handling.
 */
export abstract class WebviewEmulator implements Emulator {
  protected panel?: vscode.WebviewPanel;
  protected pendingRpcs = new Map<string, PendingRpc>();
  protected messageListeners = new Set<(message: EmulatorMessage) => void>();

  memoryInfo?: MemoryInfo;
  cpuInfo?: CpuInfo;
  customRegisters?: CustomRegisters;

  // Overridden to false by PuaeEmulator — the wasm engine doesn't honor
  // breakpoint ignore counts natively; BreakpointManager emulates hit
  // counting in TS instead.
  public readonly supportsHitCounts: boolean = true;

  // Set by DebugAdapter once the session's SourceMap is built, so
  // handlePanelMessage's `symbolizeAddress` handling below can answer
  // address->source-line queries from the webview (e.g. the PUAE copper
  // hover tooltip) without round-tripping through the adapter.
  protected sourceMap?: SourceMap;

  constructor(protected readonly extensionUri: vscode.Uri) {}

  public setSourceMap(sourceMap: SourceMap | undefined): void {
    this.sourceMap = sourceMap;
  }

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

  /** Rejects and removes every RPC associated with the current panel. */
  protected rejectPendingRpcs(reason: Error): void {
    for (const [, pending] of this.pendingRpcs) {
      clearTimeout(pending.timeout);
      pending.reject(reason);
    }
    this.pendingRpcs.clear();
  }

  /**
   * Sends an RPC command to the emulator and waits for a response.
   * @param command RPC command name
   * @param args Optional command arguments
   * @param timeoutMs Timeout in milliseconds (default: 5000)
   * @returns Promise that resolves with the command response
   * @throws Error on timeout or if webview is not open
   */
  public async sendRpcCommand<K extends PuaeRpcCommand>(
    command: K,
    ...params: undefined extends PuaeRpcArgs<K>
      ? [args?: PuaeRpcArgs<K>, timeoutMs?: number]
      : [args: PuaeRpcArgs<K>, timeoutMs?: number]
  ): Promise<PuaeRpcResult<K>> {
    const args = params[0];
    const timeoutMs = params[1] ?? 5000;
    return new Promise<PuaeRpcResult<K>>((resolve, reject) => {
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
        args: { ...(args ?? {}), _rpcId: id },
      });
    });
  }

  public dispose(): void {
    this.rejectPendingRpcs(new Error("Webview disposed"));
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
    } else if (message.type === "symbolizeAddress") {
      // Webview-initiated request (e.g. PUAE's copper hover tooltip, or the
      // blitter tooltip's channel pointers) for the source location and/or
      // enclosing-symbol label of an address — answered directly here
      // rather than bounced through the debug adapter, since setSourceMap
      // already gave us what we need. Path is relativized to the workspace
      // folder (when one is open) so the tooltip can stay short —
      // openSource resolves a relative path against the workspace folder
      // too, so the round trip still works.
      const loc = this.sourceMap?.lookupAddress(message.address);
      const symbolOffset = this.sourceMap?.findSymbolOffset(message.address);
      this.panel?.webview.postMessage({
        type: "symbolizeResult",
        requestId: message.requestId,
        location: loc
          ? { path: vscode.workspace.asRelativePath(loc.path, false), line: loc.line }
          : undefined,
        symbol: symbolOffset ? { name: symbolOffset.symbol, offset: symbolOffset.offset } : undefined,
      });
    } else if (message.type === "openSource") {
      void openSourceLocation(message.path, message.line);
    }

    // Notify all registered listeners about this message
    this.notifyMessageListeners(message);
  }

  /**
   * Resolves the configured `defaultViewColumn` setting to a ViewColumn for
   * newly created panels.
   */
  protected getConfiguredViewColumn(): vscode.ViewColumn {
    const config = vscode.workspace.getConfiguration("puae-debugger");
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
    return stableStringify(a) === stableStringify(b);
  }

  // --- Execution control ---

  public async pause(): Promise<void> {
    this.invalidateCache();
    await this.sendRpcCommand("pause");
  }

  public async run(): Promise<void> {
    this.invalidateCache();
    await this.sendRpcCommand("run");
  }

  public async stepInto(): Promise<void> {
    this.invalidateCache();
    await this.sendRpcCommand("stepInto");
  }

  public async stepBack(): Promise<boolean> {
    this.invalidateCache();
    const res = await this.sendRpcCommand("stepBack");
    return !!res;
  }

  public async continueReverse(): Promise<boolean> {
    this.invalidateCache();
    const res = await this.sendRpcCommand("continueReverse", undefined, 30000);
    return !!res;
  }

  public async stepBackFrame(): Promise<boolean> {
    this.invalidateCache();
    const res = await this.sendRpcCommand("stepBackFrame");
    return !!res;
  }

  public async eof(): Promise<void> {
    this.invalidateCache();
    await this.sendRpcCommand("eof");
  }

  public async eol(): Promise<void> {
    this.invalidateCache();
    await this.sendRpcCommand("eol");
  }

  // --- Breakpoints, watchpoints, catchpoints ---

  public async setBreakpoint(address: number, ignores = 0): Promise<void> {
    await this.sendRpcCommand("setBreakpoint", { address, ignores });
  }

  public async removeBreakpoint(address: number): Promise<void> {
    await this.sendRpcCommand("removeBreakpoint", { address });
  }

  public async setWatchpoint(
    address: number,
    ignores = 0,
    options?: WatchpointOptions,
  ): Promise<void> {
    await this.sendRpcCommand("setWatchpoint", { address, ignores, ...options });
  }

  public async removeWatchpoint(address: number): Promise<void> {
    await this.sendRpcCommand("removeWatchpoint", { address });
  }

  public async setRegisterWatch(regIndex: number): Promise<void> {
    await this.sendRpcCommand("setRegisterWatch", { regIndex });
  }

  public async removeRegisterWatch(regIndex: number): Promise<void> {
    await this.sendRpcCommand("removeRegisterWatch", { regIndex });
  }

  public async resetWatchpoints(): Promise<void> {
    await this.sendRpcCommand("resetWatchpoints");
  }

  public async setCatchpoint(vector: number, ignores = 0): Promise<void> {
    await this.sendRpcCommand("setCatchpoint", { vector, ignores });
  }

  public async removeCatchpoint(vector: number): Promise<void> {
    await this.sendRpcCommand("removeCatchpoint", { vector });
  }

  // --- Memory protection (breaks on writes to RAM outside an allow-list of
  // ranges, excluding the low-memory vector table) ---

  public async setMemoryProtectionEnabled(enabled: boolean): Promise<void> {
    await this.sendRpcCommand("setMemoryProtectionEnabled", { enabled });
  }

  public async resetMemoryProtectionRanges(): Promise<void> {
    await this.sendRpcCommand("resetMemoryProtectionRanges");
  }

  public async addMemoryProtectionRange(address: number, size: number): Promise<void> {
    await this.sendRpcCommand("addMemoryProtectionRange", { address, size });
  }

  public async seedResidentLibraries(): Promise<void> {
    await this.sendRpcCommand("seedMemoryProtectionLibraries");
  }

  // --- CPU / registers ---

  public async enableCpuLogging(enabled: boolean): Promise<void> {
    await this.sendRpcCommand("enableCpuLogging", { enabled });
  }

  /**
   * Returns the most recently executed instructions (most recent first), up to
   * `count`. The default unwraps the common `{ trace }` response shape;
   * backends with a different wire shape override this.
   */
  public async getCpuTrace(count = 256): Promise<CpuTraceItem[]> {
    return this.sendRpcCommand("getCpuTrace", { count });
  }

  public async getCallstack(): Promise<number[]> {
    return this.sendRpcCommand("getCallstack");
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

  public async getAgaColors(): Promise<Uint32Array | undefined> {
    const { data } = await this.sendRpcCommand("getAgaColors");
    // The webview<->extension-host postMessage bridge doesn't preserve a real Uint8Array across
    // the boundary (same reason profilerManager.ts's own `u8()` helper exists) — `data` arrives
    // without `.buffer`/`.byteLength`, which decodeAgaColors requires (its own `bytes.byteLength`
    // guard silently passes on a value where that's `undefined`, then `new DataView(bytes.buffer,
    // ...)` throws). Reconstruct a real Uint8Array first.
    const bytes = data instanceof Uint8Array ? data : new Uint8Array((data as ArrayLike<number>) ?? 0);
    return decodeAgaColors(bytes);
  }

  public async pokeCustom16(
    address: number,
    value: number,
  ): Promise<void> {
    this.customRegisters = undefined; // Clear cache
    return this.sendRpcCommand("pokeCustom16", { address, value });
  }

  public async pokeCustom32(
    address: number,
    value: number,
  ): Promise<void> {
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

  // --- Helpers ---

  protected invalidateCache(): void {
    this.cpuInfo = undefined;
    this.customRegisters = undefined;
  }
}
