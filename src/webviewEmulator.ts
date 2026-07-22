/* eslint-disable @typescript-eslint/no-explicit-any */
import { u32, u16, u8 } from "./numbers";
import { Disposable, Emulator, WatchpointOptions } from "./emulator";
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
import { decodeAgaColors } from "./shared/dma";
import type {
  PuaeRpcArgs,
  PuaeRpcCommand,
  PuaeRpcResult,
} from "./shared/puaeRpcProtocol";
import { WebviewHost } from "./webviewHost";

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
 * wrappers that simply forward to the webview. Deliberately has no
 * dependency on `vscode` — how the UI is actually hosted (a
 * `vscode.WebviewPanel`, or a browser tab talking over a WebSocket to the
 * standalone server) is abstracted behind `WebviewHost`, attached via
 * `attachHost()`.
 *
 * A subclass (`PuaeEmulator`) supplies the backend-specific pieces: `open()`
 * (panel/tab creation-or-reuse policy) and the HTML/config templating. A
 * further per-host subclass (e.g. `VscodePuaeEmulator`) supplies how a
 * `WebviewHost` actually gets created and attached.
 */
export abstract class WebviewEmulator implements Emulator {
  protected host?: WebviewHost;
  protected pendingRpcs = new Map<string, PendingRpc>();
  protected messageListeners = new Set<(message: EmulatorMessage) => void>();
  protected disposeListeners = new Set<() => void>();

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

  // extensionUri/context.extensionUri's filesystem path in the vscode host;
  // the repo/package root in the standalone host. Used by subclasses to
  // locate `puae/index.html`, `out/puaeApp.js`, etc.
  constructor(protected readonly rootDir: string) {}

  public setSourceMap(sourceMap: SourceMap | undefined): void {
    this.sourceMap = sourceMap;
  }

  // --- Lifecycle ---

  /**
   * Opens (or reuses) the emulator UI. Backend-specific: each concrete
   * emulator decides how/when a host is (re)created.
   */
  public abstract open(options?: Record<string, unknown>): void;

  /**
   * Brings the emulator UI to the foreground.
   */
  public reveal(): void {
    this.host?.reveal();
  }

  /**
   * Registers a listener for emulator messages.
   * Unlike the host's own message event, this works even when no host is
   * attached yet.
   * @param callback Function to call when messages are received
   * @returns Disposable to unregister the listener
   */
  public onDidReceiveMessage(
    callback: (message: EmulatorMessage) => void,
  ): Disposable {
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

  /**
   * Registers a listener fired whenever the *current* host is disposed —
   * unlike delegating straight to a host's own dispose event, this also
   * fires for hosts attached *after* this call (e.g. a standalone-mode
   * browser tab that hasn't connected yet at registration time), matching
   * `onDidReceiveMessage`'s "works even when no host is attached yet"
   * contract.
   */
  public onDidDispose(callback: () => void): Disposable {
    this.disposeListeners.add(callback);
    return {
      dispose: () => {
        this.disposeListeners.delete(callback);
      },
    };
  }

  protected notifyDisposeListeners(): void {
    for (const listener of this.disposeListeners) {
      try {
        listener();
      } catch (error) {
        console.error("Error in dispose listener:", error);
      }
    }
  }

  /**
   * Wires a freshly created/connected `WebviewHost` up to this emulator's
   * shared RPC/message-listener plumbing. Concrete subclasses call this once
   * they have a host to attach — synchronously for vscode's WebviewPanel;
   * later, once a browser tab actually connects, for the standalone server.
   */
  protected attachHost(host: WebviewHost): void {
    this.host = host;
    host.onDidDispose(() => {
      this.rejectPendingRpcs(new Error("Emulator UI disposed"));
      if (this.host === host) {
        this.host = undefined;
      }
      this.notifyDisposeListeners();
    });
    host.onDidReceiveMessage((message) => this.handlePanelMessage(message));
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

  /** Rejects and removes every RPC associated with the current host. */
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
   * @throws Error on timeout or if no host is attached
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
      if (!this.host) {
        reject(new Error("Emulator UI is not open"));
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
      this.host.postMessage({
        command,
        args: { ...(args ?? {}), _rpcId: id },
      });
    });
  }

  public dispose(): void {
    this.rejectPendingRpcs(new Error("Webview disposed"));
    this.host?.dispose();
  }

  /**
   * Best-effort shortening of an absolute path for display in the
   * `symbolizeAddress` tooltip reply below (e.g. relative to a workspace
   * root). Identity by default; the vscode host overrides this via
   * `vscode.workspace.asRelativePath`.
   */
  protected shortenPath(path: string): string {
    return path;
  }

  /**
   * Opens a source location in whatever the host's "editor" concept is, in
   * response to an `openSource` message from the webview (e.g. clicking a
   * source link in the DMA hover tooltip). No-op by default; the vscode
   * host overrides this via `openSourceLocation`.
   */
  protected openSource(_path: string, _line?: number): void {}

  /**
   * Diagnostic logging for the perf-overrun/perf-fps handling below.
   * Defaults to stderr; the vscode host overrides this to route to an
   * Output channel instead.
   */
  protected log(line: string): void {
    console.error(line);
  }

  /**
   * Shared handler for messages posted from the webview. Subclasses attach
   * a `WebviewHost` via `attachHost()`, which wires the host's message
   * event to this. Resolves/rejects pending RPCs, refreshes the memory map
   * on exec-ready, and fans the message out to registered listeners.
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
      // already gave us what we need. Path is shortened via shortenPath()
      // (workspace-relative in the vscode host) so the tooltip can stay
      // short — openSource resolves a relative path the same way.
      const loc = this.sourceMap?.lookupAddress(message.address);
      const symbolOffset = this.sourceMap?.findSymbolOffset(message.address);
      this.host?.postMessage({
        type: "symbolizeResult",
        requestId: message.requestId,
        location: loc
          ? { path: this.shortenPath(loc.path), line: loc.line }
          : undefined,
        symbol: symbolOffset ? { name: symbolOffset.symbol, offset: symbolOffset.offset } : undefined,
      });
    } else if (message.type === "openSource") {
      this.openSource(message.path, message.line);
    } else if (message.type === "perf-overrun") {
      // app.ts's frame() aggregates frame-budget overruns (jerky-playback triage) and
      // reports them at most once a second, here as well as via the webview's own
      // console.warn. Routing a copy here matters specifically because the webview's
      // DevTools (needed to see console.warn at all) measurably slows down JS/wasm
      // execution on its own — confirmed directly, overruns were far more frequent and
      // severe with DevTools attached — so console.warn alone can't give a clean read on
      // how often this happens in ordinary use. log() has no such cost.
      const m = message as {
        budgetMs: number;
        callbackGapOverruns: number;
        callbackGapOverrunMaxMs: number;
        frameOverruns: number;
        frameOverrunMaxMs: number;
        avgWasmMs: number;
        avgGpuMs: number;
        avgWasmPerTickMs?: number;
        frameOverrunTicksSum?: number;
        jitterMultiTickCallbacks?: number;
        jitterMultiTickMaxRan?: number;
      };
      const avgTicksPerOverrun = m.frameOverruns > 0 ? (m.frameOverrunTicksSum ?? 0) / m.frameOverruns : 0;
      this.log(
        `[${new Date().toLocaleTimeString()}] budget overruns in the last ~1s (budget ${m.budgetMs.toFixed(1)}ms): ` +
        `${m.callbackGapOverruns} late tick callback(s) (max ${m.callbackGapOverrunMaxMs.toFixed(1)}ms since previous), ` +
        `${m.frameOverruns} slow frame() call(s) (max ${m.frameOverrunMaxMs.toFixed(1)}ms, ` +
        `avg wasm=${m.avgWasmMs.toFixed(1)}ms [${(m.avgWasmPerTickMs ?? 0).toFixed(1)}ms/tick x ${avgTicksPerOverrun.toFixed(1)} ticks avg] ` +
        `avg gpu=${m.avgGpuMs.toFixed(1)}ms of that)` +
        (m.jitterMultiTickCallbacks
          ? `, ${m.jitterMultiTickCallbacks} multi-tick callback(s) despite on-time arrival ` +
            `(max ${m.jitterMultiTickMaxRan} ticks — backlog exceeded the jitter tolerance)`
          : ""),
      );
    } else if (message.type === "perf-fps") {
      // app.ts's frame() reports this at most once a second, only when achieved
      // throughput falls meaningfully short of PAL's ~49.92fps — the "is the emulator
      // actually falling behind in aggregate" signal, distinct from perf-overrun's
      // per-tick/per-callback checks: it stays meaningful even when buffered playback
      // is successfully smoothing over individual slow ticks, since a real, sustained
      // throughput shortfall still shows up here regardless.
      const m = message as { fps: number; targetFps: number };
      this.log(
        `[${new Date().toLocaleTimeString()}] achieved ${m.fps.toFixed(1)}fps, below the ${m.targetFps.toFixed(1)}fps PAL target`,
      );
    }

    // Notify all registered listeners about this message
    this.notifyMessageListeners(message);
  }

  /**
   * Order-independent structural comparison of two option records, used to
   * decide whether an already-open host can be reused for new open options.
   */
  protected optionsMatch(a?: object, b?: object): boolean {
    return stableStringify(a) === stableStringify(b);
  }

  // --- Execution control ---

  public async pause(silent?: boolean): Promise<void> {
    this.invalidateCache();
    try {
      await this.sendRpcCommand("pause", { silent });
    } finally {
      this.invalidateCache();
    }
  }

  public async run(): Promise<void> {
    this.invalidateCache();
    try {
      await this.sendRpcCommand("run");
    } finally {
      this.invalidateCache();
    }
  }

  public async stepInto(): Promise<void> {
    this.invalidateCache();
    try {
      await this.sendRpcCommand("stepInto");
    } finally {
      this.invalidateCache();
    }
  }

  public async stepBack(): Promise<boolean> {
    this.invalidateCache();
    try {
      const res = await this.sendRpcCommand("stepBack");
      return !!res;
    } finally {
      this.invalidateCache();
    }
  }

  public async continueReverse(): Promise<boolean> {
    this.invalidateCache();
    try {
      const res = await this.sendRpcCommand("continueReverse", undefined, 30000);
      return !!res;
    } finally {
      this.invalidateCache();
    }
  }

  public async stepBackFrame(): Promise<boolean> {
    this.invalidateCache();
    try {
      const res = await this.sendRpcCommand("stepBackFrame");
      return !!res;
    } finally {
      this.invalidateCache();
    }
  }

  public async eof(): Promise<void> {
    this.invalidateCache();
    try {
      await this.sendRpcCommand("eof");
    } finally {
      this.invalidateCache();
    }
  }

  public async eol(): Promise<void> {
    this.invalidateCache();
    try {
      await this.sendRpcCommand("eol");
    } finally {
      this.invalidateCache();
    }
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
    try {
      return await this.sendRpcCommand("setRegister", { name, value });
    } finally {
      this.cpuInfo = undefined; // Clear cache
    }
  }

  public async jump(address: number): Promise<void> {
    this.invalidateCache();
    try {
      await this.sendRpcCommand("jump", { address });
    } finally {
      this.invalidateCache();
    }
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
    try {
      await this.sendRpcCommand("pokeCustom16", { address, value });
    } finally {
      this.customRegisters = undefined; // Clear cache
    }
  }

  public async pokeCustom32(
    address: number,
    value: number,
  ): Promise<void> {
    this.customRegisters = undefined; // Clear cache
    try {
      await this.sendRpcCommand("pokeCustom32", { address, value });
    } finally {
      this.customRegisters = undefined; // Clear cache
    }
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

  // Every mutating RPC (pause/run/step*/jump/setRegister/pokeCustom*) invalidates the relevant
  // cache field(s) both *before* sending the RPC and again in a `finally` once it resolves --
  // not just before, despite that looking redundant. A read (getCpuInfo/getAllCustomRegisters)
  // already in flight when a mutation starts can resolve *after* the pre-mutation invalidation,
  // repopulating the cache with pre-mutation data with nothing left to invalidate it again.
  // E.g.: caller A awaits getCpuInfo() (RPC in flight) while caller B calls stepInto()
  // (invalidates the now-empty cache, sends its own RPC); A's RPC resolves and sets
  // this.cpuInfo to the pre-step registers; B's RPC completes but (before this fix) never
  // re-invalidated, so every subsequent getCpuInfo() served stale data until some unrelated
  // mutation happened to race favorably.
  protected invalidateCache(): void {
    this.cpuInfo = undefined;
    this.customRegisters = undefined;
  }
}
