// A `WebviewEmulator` with no webview: the PUAE wasm module runs in this Node process and the
// RPC dispatcher is called directly, in-process, instead of over a vscode postMessage bridge or
// the standalone server's WebSocket.
//
// This is the third `WebviewHost` (after `VscodeWebviewHost` and `BrowserWebviewHost`), and it
// exists for the same reason those two do: everything `WebviewEmulator` does above the transport
// — RPC correlation, caching, the whole `Emulator` API, and `sendRpcCommand` itself, which is all
// `ProfilerRpcClient` needs — is already host-agnostic. Nothing here reimplements any of it.
//
// Two things genuinely differ from the browser hosts, both deliberate:
//
//   * There is no render loop. Ticks are driven explicitly (`runFrames`), so a capture taken here
//     is reproducible rather than dependent on how much wall-clock time a frame callback got.
//   * `setupRpcDispatcher` and the wasm module are loaded at runtime from the package, not
//     bundled: `src/webview/` is outside the extension host's tsconfig (it type-checks
//     separately), and `puae.js` is a 100KB Emscripten artifact that locates `puae.wasm` relative
//     to its own file. `puae-wasm/test/*.mjs` already drive the dispatcher this way under plain
//     Node; this is the same trick with types drawn around it.

import { readFile } from "fs/promises";
import { join } from "path";
import { Disposable } from "../emulator";
import { WebviewEmulator } from "../webviewEmulator";
import { WebviewHost } from "../webviewHost";

// The parts of the Emscripten module object used here. The full shape (loosely typed via an index
// signature) lives in src/webview/puaeApp/types.ts, which this side of the build can't import.
interface PuaeWasmModule {
  FS: {
    mkdir(path: string): void;
    writeFile(path: string, data: Uint8Array | string): void;
  };
  ccall(name: string, returnType: string, argTypes: string[], args: unknown[]): number;
  HEAPU8: Uint8Array;
  _wasm_get_fb_rgba(): number;
  _wasm_get_fb_width(): number;
  _wasm_get_fb_height(): number;
  _wasm_tick(): number;
  _wasm_pause(): void;
  _wasm_is_paused(): number;
  _wasm_memprotect_start_tracking(): number;
  _wasm_memprotect_seed_libraries(): void;
  [key: string]: unknown;
}

interface StopMessage {
  hasMessage: boolean;
  name: string;
  payload: { pc: number; vector?: number; [key: string]: unknown };
}

interface RpcDispatcherModule {
  setupRpcDispatcher(
    module: PuaeWasmModule,
    postMessage: (message: unknown) => void,
    options?: { usesDh0?: boolean },
  ): { handleMessage(message: unknown): void };
  isExecReady(module: PuaeWasmModule): boolean;
  getCurrentStopMessage(module: PuaeWasmModule): StopMessage;
}

/** Bridges `WebviewEmulator`'s message plumbing onto an in-process RPC dispatcher. */
class InProcessHost implements WebviewHost {
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly disposeListeners = new Set<() => void>();
  private dispatcher?: { handleMessage(message: unknown): void };
  private disposed = false;

  /** Called once the dispatcher exists — it needs this host's `deliver` to answer through. */
  attachDispatcher(dispatcher: { handleMessage(message: unknown): void }): void {
    this.dispatcher = dispatcher;
  }

  /** Extension side -> emulator. Straight into the dispatcher, no serialization in between. */
  postMessage(message: unknown): void {
    if (this.disposed) return;
    this.dispatcher?.handleMessage(message);
  }

  /**
   * Emulator -> extension side. Deferred by a microtask rather than delivered inline: a browser
   * host's messages always arrive on a later turn of the event loop, and code on the receiving
   * end (`handlePanelMessage`, and anything it triggers) is written against that. Answering
   * synchronously from inside `postMessage` would re-enter the caller mid-call.
   */
  deliver(message: unknown): void {
    if (this.disposed) return;
    queueMicrotask(() => {
      for (const listener of this.messageListeners) listener(message);
    });
  }

  onDidReceiveMessage(callback: (message: unknown) => void): Disposable {
    this.messageListeners.add(callback);
    return { dispose: () => this.messageListeners.delete(callback) };
  }

  onDidDispose(callback: () => void): Disposable {
    this.disposeListeners.add(callback);
    return { dispose: () => this.disposeListeners.delete(callback) };
  }

  reveal(): void {
    // Nothing to bring to the foreground; there is no UI.
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const listener of this.disposeListeners) listener();
  }
}

export interface HeadlessEmulatorOptions {
  /** Package root — the directory holding `puae/` and `out/`. */
  rootDir: string;
  /** Kickstart ROM to boot. Required: fastLoad injection needs a real ROM, not the AROS fallback. */
  kickstartRomPath: string;
  /** Extra `.uae` config lines, appended after the cycle-exact defaults below. */
  extraConfig?: string;
}

// Matches PuaeEmulator.buildExtraConfig's own prepended defaults, so a headless capture measures
// the same machine the debugger's webview would have.
const DEFAULT_CONFIG_LINES = [
  "cpu_compatible=true",
  "cpu_cycle_exact=true",
  "cpu_memory_cycle_exact=true",
  "blitter_cycle_exact=true",
];

// Ceiling on the boot warm-up, matching app.ts's own. Kickstart needs ~150 ticks to clear CIA-A
// OVL and initialise exec.library's allocator; 1000 is ~20 emulated seconds.
const MAX_WARMUP_TICKS = 1000;

export class HeadlessEmulator extends WebviewEmulator {
  private constructor(
    rootDir: string,
    private readonly module: PuaeWasmModule,
    private readonly inProcessHost: InProcessHost,
    private readonly rpcModule: RpcDispatcherModule,
  ) {
    super(rootDir);
    this.attachHost(inProcessHost);
  }

  /**
   * Boots a machine and warms it up to the same "exec.library is ready" point app.ts's fastLoad
   * boot stops at — paused, with memory-protection tracking armed — so a program can be injected
   * into it (see `AmigaHunkLoader`).
   */
  public static async boot(options: HeadlessEmulatorOptions): Promise<HeadlessEmulator> {
    const { rootDir, kickstartRomPath, extraConfig } = options;

    // Both loaded by path at runtime, not bundled — see this file's header.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const createPuaeModule = require(join(rootDir, "puae", "puae.js")) as
      (moduleArg?: Record<string, unknown>) => Promise<PuaeWasmModule>;
    const rpcModule = (await import(join(rootDir, "out", "puaeRpc.mjs"))) as unknown as RpcDispatcherModule;

    const rom = await readFile(kickstartRomPath);

    // Emscripten writes the core's own logging (`[puae] ...`, PUAE's write_log output) through
    // these; the default sends it to stdout, which in `puae-debugger mcp` is the JSON-RPC
    // protocol stream. frontend_shim.c's EM_ASM console.log calls bypass these entirely — see
    // the console.log redirect in mcp/server.ts, which catches those.
    const module = await createPuaeModule({
      print: (text: string) => process.stderr.write(text + "\n"),
      printErr: (text: string) => process.stderr.write(text + "\n"),
    });
    module.FS.mkdir("/uae_system");
    // The filename is fixed: frontend_shim.c looks for exactly this path, and falls back to
    // PUAE's built-in AROS ROM when it is missing.
    module.FS.writeFile("/uae_system/kick34005.A500", new Uint8Array(rom));
    const config = [...DEFAULT_CONFIG_LINES, ...(extraConfig ? [extraConfig] : [])].join("\n") + "\n";
    module.FS.writeFile("/uae_system/puae_libretro_global.uae", config);

    // Boot with no disk inserted, exactly as the fastLoad path does: there is no DOS process to
    // load a program from, and a disk would only race the injection with its own boot code.
    if (!module.ccall("wasm_boot", "number", ["string"], [""])) {
      throw new Error("wasm_boot failed");
    }

    // Warm-up, mirroring app.ts: tick until AmigaOS is ready for injection, polling the
    // memory-protection watch every tick (it validates execBase itself and no-ops until ready,
    // so this catches Kickstart's own boot-time allocations too).
    let trackingStarted = false;
    for (let i = 0; !rpcModule.isExecReady(module) && i < MAX_WARMUP_TICKS; i++) {
      module._wasm_tick();
      if (!trackingStarted) trackingStarted = !!module._wasm_memprotect_start_tracking();
    }
    if (!rpcModule.isExecReady(module)) {
      throw new Error(`exec.library did not become ready within ${MAX_WARMUP_TICKS} ticks`);
    }
    // Pause in the same tick that validated readiness, for the reason app.ts's warm-up documents
    // at length: nothing may advance the CPU between that check and the injection that follows.
    module._wasm_pause();
    if (!trackingStarted) module._wasm_memprotect_start_tracking();
    // GfxBase is confirmed set (isExecReady checked it), so its library list is safe to walk.
    module._wasm_memprotect_seed_libraries();

    const host = new InProcessHost();
    const emulator = new HeadlessEmulator(rootDir, module, host, rpcModule);
    host.attachDispatcher(rpcModule.setupRpcDispatcher(module, (message) => host.deliver(message)));
    return emulator;
  }

  /** No UI to open. Present because `WebviewEmulator` declares it abstract for the hosts that do. */
  public open(): void {}

  /**
   * Advances the machine by up to `frames` emulated frames, stopping early if it pauses itself
   * (a breakpoint, watchpoint or catchpoint). Returns how many frames actually ran.
   *
   * This is the headless stand-in for app.ts's render loop, minus the wall-clock scheduling: it
   * runs the emulator as fast as this process can, and every frame it is asked for.
   */
  public runFrames(frames: number): number {
    let ran = 0;
    for (let i = 0; i < frames; i++) {
      if (this.module._wasm_is_paused()) break;
      this.module._wasm_tick();
      ran++;
    }
    this.invalidateCache();
    return ran;
  }

  public isPaused(): boolean {
    return !!this.module._wasm_is_paused();
  }

  /**
   * Why the emulator stopped — a breakpoint, a watchpoint, a catchpoint, a memory-protection
   * violation — and where.
   *
   * Read from the module the same way app.ts reads it before posting a `stopped` state message;
   * there is no RPC for it because in a webview the render loop is the only thing that ever needs
   * to ask. **Consumes** the pending stop, exactly like that path does, so it answers once per
   * stop and the caller must hold on to what it returns.
   */
  public consumeStopMessage(): StopMessage {
    return this.rpcModule.getCurrentStopMessage(this.module);
  }

  /**
   * The current framebuffer as RGBA8888, copied out of the wasm heap.
   *
   * Read from the module directly rather than through the `getFramebuffer` RPC, which returns a
   * JPEG thumbnail encoded with OffscreenCanvas — a browser API that doesn't exist here. This is
   * the buffer that RPC starts from, at full resolution and uncompressed.
   *
   * `.slice()` because the returned view would otherwise point into a heap that can grow (and so
   * move) on the next tick, quietly invalidating it.
   */
  public readFramebuffer(): { rgba: Uint8Array; width: number; height: number } {
    const width = this.module._wasm_get_fb_width();
    const height = this.module._wasm_get_fb_height();
    if (width <= 0 || height <= 0) throw new Error(`No framebuffer yet (${width}x${height})`);
    const ptr = this.module._wasm_get_fb_rgba();
    const rgba = this.module.HEAPU8.slice(ptr, ptr + width * height * 4);
    return { rgba, width, height };
  }

  public dispose(): void {
    this.inProcessHost.dispose();
    super.dispose();
  }
}
