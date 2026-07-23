// Shared boot/render-loop logic for the PUAE wasm backend, used by both
// index.html (the clean webview UI) and debug.html (manual test/debug UI).
// Anything that touches the debug-only DOM (#debug, #debugG1, #debugG2 etc.)
// lives in debug.html instead — main() only assumes #screen exists;
// #status is optional (used for boot/fps diagnostics if present).

import { setupRpcDispatcher, getCurrentStopMessage, tryExec, getCurrentProcess, isExecReady } from "./rpc";
import { installDmaHoverTooltip, handleDmaHoverMessage } from "./dmaHover";
import { installScreenHoverTooltip } from "./screenHover";
import { installMouseCapture } from "./mouseCapture";
import { installKeyboardCapture } from "./keyboardCapture";
import { DmaRecordType } from "../../shared/profilerTypes";
import { createHostBridge } from "../shared/hostBridge";
import type { PuaeModule } from "./types";

// The Amiga's PAL frame rate — both the render loop's due-frames accounting
// and its driving tick-worker interval are derived from this. Not exactly 50:
// the core's own retro_get_system_av_info() reports 49.92041015625 (PAL's
// true vertical refresh rate, from the chipset's line/cycle timing — this
// codebase only ever runs PAL, no NTSC option exists). Using a rounded 50
// here made the JS-side scheduler tick ~0.16% faster than the audio the core
// actually generates per real second, with no feedback to correct it — audio
// production slowly outran consumption, filling the worklet's ring buffer
// until it overflowed (an audible click), no matter how big the buffer was.
const PAL_FPS = 49.92041015625;

// The nominal wall-clock interval between tick-worker callbacks at 1x speed
// (~20.03ms) — both the interval startTickWorker is started with below and the
// budget frame()'s overrun diagnostics (see FRAME_BUDGET_MS's uses) compare
// against.
const FRAME_BUDGET_MS = 1000 / PAL_FPS;

// In warp mode, run as many ticks as fit in this time budget per tick-worker
// callback (which itself fires every 1000/PAL_FPS ms), leaving headroom in
// each callback for rendering/audio/RPC handling.
const WARP_TICK_BUDGET_MS = 15;

// Caps how many emulated frames of "due" backlog frame()'s catch-up loop will
// ever try to replay after a long main-thread stall (e.g. a profiler capture's
// synchronous wasm_profile_start(), which can legitimately take tens of
// seconds for CPU/workload combinations where a lot of instructions retire
// per profiled frame — see the CPU profiler "purely fast RAM"/68020 hang
// investigation). emuClockMs keeps accumulating real elapsed time during such
// a stall with no ticks actually running, so the very next frame() call can
// see a backlog of 1000+ "due" frames. Without a cap, the catch-up loop's
// per-callback time budget (WARP_TICK_BUDGET_MS) means repaying that backlog
// takes as long in real time as it took to accrue — and if a single tick ever
// costs as much or more than one callback interval (1000/PAL_FPS, ~20ms; true
// for the same slow combinations that created the backlog), the backlog can
// never be repaid at all, permanently monopolizing the main thread and
// starving the RPC message queue that a profiler capture's own follow-up
// calls (getFramebuffer, getProfileData, ...) are waiting in. Beyond this
// many frames, excess backlog is simply dropped (same "snap forward, don't
// replay" behavior frame() already uses while paused) rather than replayed —
// a handful of skipped video frames after a long stall is imperceptible.
const MAX_CATCHUP_FRAMES = 10;

// A "due" backlog at or below this many frames is treated as ordinary tick-worker
// timer/clock jitter, not a genuine stall (see the jitterMultiTickCallbacks
// diagnostic that identified this: real captures consistently showed exactly a
// 2-frame backlog, at a per-tick cost well under budget — i.e. individual ticks
// were fine, but dueFrames occasionally read one whole frame further ahead than
// emuFrames purely from accumulated ~20.03ms-callback-interval imprecision, not
// from anything actually running slow). Within this tolerance, frame()'s normal-
// mode catch-up loop below runs at most ONE tick this callback and lets the
// remainder carry over to a later one, instead of immediately running a second
// tick back-to-back — which both costs ~2x a single tick (a real, avoidable
// overrun) and silently drops a frame of displayed motion, since only the last
// tick's framebuffer ever gets drawn. A backlog ABOVE this — a genuine stall,
// e.g. real main-thread contention or a GC pause — still gets the existing fast,
// uncapped catch-up via MAX_CATCHUP_FRAMES below: falling further behind there
// would shrink the audio cushion and risk an audible underrun, which matters far
// more than the few imperceptible milliseconds of extra display lag this
// tolerance introduces for routine jitter.
const JITTER_TOLERANT_BACKLOG_FRAMES = 2;

// How often to take a periodic full-state checkpoint (rpc.pushSnapshot())
// during a free-run, for stepBack/continueReverse — one per second of
// emulated time. Rounded; doesn't need PAL_FPS's precision.
const CHECKPOINT_INTERVAL_FRAMES = Math.round(PAL_FPS);

// Register names: D0-D7, A0-A7, SR, PC — order matches e9k_debug_read_regs().
export const REG_NAMES = [
  "D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7",
  "A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7(SP)",
  "SR", "PC",
];

async function fetchBytes(url: string): Promise<Uint8Array> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch ${url} → ${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer());
}

// Starts a Worker whose only job is to call back at a steady interval, even
// when the page is in a hidden/background tab (where requestAnimationFrame
// and main-thread setInterval/setTimeout get throttled). Built from an
// inline blob so it works under the webview's CSP without a separate file.
function startTickWorker(onTick: (ts: number) => void, intervalMs: number): Worker {
  const workerScript = `
    let intervalId;
    self.onmessage = (event) => {
      if (event.data.command === 'start' && !intervalId) {
        intervalId = setInterval(
          () => postMessage(performance.now()),
          event.data.intervalMs,
        );
      }
    };
  `;
  const blob = new Blob([workerScript], { type: "application/javascript" });
  const worker = new Worker(URL.createObjectURL(blob));
  // Use the main thread's performance.now() rather than the Worker's timestamp.
  // When VS Code delays the main thread, Worker messages queue up with stale
  // Worker-clock timestamps 20ms apart; processing them with those timestamps
  // causes back-to-back ticks (burst renders). Using the main-thread clock
  // means queued messages all see nearly the same real time, so the dueFrames
  // guard skips duplicates instead of firing them all.
  worker.onmessage = () => onTick(performance.now());
  worker.postMessage({ command: "start", intervalMs });
  return worker;
}

export interface MainConfig {
  wasmLocateFile?: (path: string) => string;
  romUrl?: string;
  extraConfigB64?: string;
  programB64?: string;
  // Base64-encoded JSON array of HardDriveEntry (see puaeEmulator.ts's walkHardDrive) —
  // a walked host directory to replay into DH0:'s MEMFS mount verbatim, taking over from
  // programB64's auto-generated single-exe disk when set (PuaeEmulator never sets both).
  hardDriveManifestB64?: string;
  // Basename of the launch config's `program` — what getCurrentProcess() polling matches
  // the eventual CLI process against, regardless of whether DH0: came from programB64 or
  // hardDriveManifestB64. Falls back to "file" (the legacy hardcoded name) if unset, for
  // debug.html and any other caller that doesn't pass it.
  expectedProcessName?: string;
  audioWorkletUrl?: string;
  // Launch-config-only "smooth/buffered playback" mode (no runtime UI toggle — see
  // bufferedPlaybackEnabled's declaration below for why): runs the emulator this
  // many frames ahead of what's displayed. Unset/0 disables it (the default) — see
  // videoQueueCapacity's declaration below for the memory/audio-sync tradeoffs of a
  // larger value. puaeEmulator.ts's getHtmlForWebview already clamps this to a sane
  // range before it reaches here.
  bufferedPlaybackFrames?: number;
  // Called once with the wasm module after boot+warm-up, before the RPC
  // bridge is wired up — debug.html uses this to install its debug UI.
  onModuleReady?: (M: PuaeModule) => void;
  // Called with the wasm module whenever the render loop's free-run hits a
  // breakpoint/watchpoint — debug.html uses this to refresh its register/
  // disassembly/callstack views.
  onBreakpoint?: (M: PuaeModule) => void;
}

declare global {
  var drawCurrentFrame: (() => void) | undefined;
}

// createPuaeModule is a global set by puae.js (Emscripten MODULARIZE=1 UMD output)
export async function main(config: MainConfig = {}): Promise<void> {
  const {
    wasmLocateFile,
    romUrl = "./kick34005.A500",
    extraConfigB64 = "",
    programB64 = "",
    hardDriveManifestB64 = "",
    expectedProcessName = "file",
    audioWorkletUrl = "./puae_audioprocessor.js",
    bufferedPlaybackFrames = 0,
    onModuleReady,
    onBreakpoint,
  } = config;

  // Derived once from the single bufferedPlaybackFrames config value — kept as
  // separate names below since they're each checked/used for a different reason
  // (a plain boolean gate vs. the actual queue size).
  const bufferedPlaybackEnabled = bufferedPlaybackFrames > 0;

  // True for any non-fastLoad boot that mounts DH0: — either the single-exe disk
  // (programB64) or a mounted host directory (hardDriveManifestB64), whichever
  // PuaeEmulator's getHtmlForWebview set (never both — hardDrivePath takes over
  // entirely when set). Used below wherever the code previously gated purely on
  // "is this a non-fastLoad/DH0: boot" via programB64 alone.
  const usesDh0 = !!(programB64 || hardDriveManifestB64);

  // Hoisted so the render loop's frame() (defined later in this scope) can
  // post 'stopped' emulator-state messages on a breakpoint/watchpoint hit
  // during free-run — only set inside the VS Code webview, see below.
  let vscode: { postMessage: (msg: unknown) => void } | undefined;
  // Hoisted alongside vscode so frame() can take periodic checkpoints via
  // rpc.pushSnapshot() — also only set inside the VS Code webview.
  let rpc: ReturnType<typeof setupRpcDispatcher> | undefined;

  // #status is optional — index.html (the panel view) omits it; debug.html
  // keeps it for boot/fps diagnostics.
  const status = document.getElementById("status");
  function log(msg: string): void {
    if (status) status.textContent = msg;
  }

  log("Initialising wasm module…");
  const M = await createPuaeModule(wasmLocateFile ? { locateFile: wasmLocateFile } : undefined);
  log("Module ready — fetching ROM…");

  M.FS.mkdir("/uae_system");
  // Write Kickstart ROM into the virtual filesystem.
  // When romUrl is empty, skip this — frontend_shim detects the missing file
  // and tells PUAE to use its built-in AROS ROM instead.
  if (romUrl) {
    const romData = await fetchBytes(romUrl);
    M.FS.writeFile("/uae_system/kick34005.A500", romData);
    log(`ROM: ${romData.length} bytes → /uae_system/kick34005.A500`);
  } else {
    log("No ROM provided — using built-in AROS ROM");
  }

  // Extra PUAE config (.uae key=value lines), built by
  // PuaeEmulator.getHtmlForWebview from OpenOptions.configFilePath,
  // chipRam/slowRam/fastRam/cpuRevision and emulatorOptions.puae. Empty by
  // default — retro_create_config() only reads this file if it exists.
  if (extraConfigB64) {
    const extraConfig = atob(extraConfigB64);
    M.FS.writeFile("/uae_system/puae_libretro_global.uae", extraConfig);
    log(`Config: ${extraConfig.length} bytes → /uae_system/puae_libretro_global.uae`);
  }

  // Non-fastLoad boot: populate a MEMFS directory that the "filesystem=rw,dh0:..."
  // line above (buildExtraConfig) mounts as a bootable DH0: hard disk. AmigaOS's
  // uaehf.device autoconfigures this — no ADF/bootblock/OFS image needed. The
  // render loop below polls for the resulting CLI process (expectedProcessName).
  if (hardDriveManifestB64) {
    // OpenOptions.hardDrivePath: a walked host directory (puaeEmulator.ts's
    // walkHardDrive), replayed verbatim — the directory is authoritative, so
    // unlike the programB64 branch below, nothing is synthesized here (no
    // auto-generated startup-sequence; the directory must already have one).
    const manifest = JSON.parse(atob(hardDriveManifestB64)) as
      { path: string; dir: boolean; dataB64?: string }[];
    M.FS.mkdir("/uae_system/dh0");
    let fileCount = 0, byteCount = 0;
    for (const entry of manifest) {
      const target = `/uae_system/dh0/${entry.path}`;
      if (entry.dir) {
        M.FS.mkdir(target);
      } else {
        const data = Uint8Array.from(atob(entry.dataB64 ?? ""), c => c.charCodeAt(0));
        M.FS.writeFile(target, data);
        fileCount++;
        byteCount += data.length;
      }
    }
    log(`Hard drive: ${fileCount} file(s), ${byteCount} bytes → /uae_system/dh0`);
  } else if (programB64) {
    // OpenOptions.programPath (auto-generated single-exe disk, the default when
    // hardDrivePath isn't set): write the exe under its own basename
    // (expectedProcessName) plus a minimal startup-sequence that runs it.
    const programData = Uint8Array.from(atob(programB64), c => c.charCodeAt(0));
    M.FS.mkdir("/uae_system/dh0");
    M.FS.writeFile(`/uae_system/dh0/${expectedProcessName}`, programData);
    M.FS.mkdir("/uae_system/dh0/s");
    M.FS.writeFile("/uae_system/dh0/s/startup-sequence", expectedProcessName);
    log(`Program: ${programData.length} bytes → /uae_system/dh0/${expectedProcessName}`);
  }

  // Boot the core with no disk inserted. fastLoad injects a standalone
  // program directly into memory once Kickstart has booted far enough to
  // allocate it (see the warm-up below) — there's no DOS process to load
  // a disk-based program from, and a disk would only race fastLoad's memory
  // injection with the disk's own boot code. Non-fastLoad programs (above)
  // are loaded via DH0:, not a disk image, so this is still '' either way.
  const wasm_boot = M.cwrap("wasm_boot", "number", ["string"]) as (s: string) => number;
  log("Calling wasm_boot…");
  const ok = wasm_boot("");
  if (!ok) { log("wasm_boot FAILED — check console"); return; }

  // [vscode-puae-debugger mem protect] fastLoad starts this in the
  // warm-up loop just below, before frame() ever runs; non-fastLoad starts
  // it from frame() instead, polling from frame 0 — see both below.
  let memProtectTrackingStarted = false;

  if (!usesDh0) {
    // Warm-up: tick until AmigaOS is ready for fastLoad memory injection —
    // mirrors vAmiga_ui.js's tryExec condition (AllocMem LVO is jmp, GfxBase
    // set, CPU out of supervisor mode). 1000 ticks is a generous safety
    // ceiling. Kickstart needs ~150 ticks to clear CIA-A OVL and initialise
    // exec.library's allocator (see puae-wasm/test_g1.mjs). Stopping exactly
    // when ready is faster and more robust than a fixed count.
    //
    // For non-fastLoad (usesDh0), this warm-up is skipped — the render
    // loop runs from frame 0 so tryExec/getCurrentProcess polling (below) can
    // observe AmigaOS booting from DH0: and running the startup-sequence.
    log("Waiting for exec.library to initialise…");
    // [vscode-puae-debugger mem protect] Poll every tick, not just once at
    // the end — the C side validates execBase itself and no-ops until ready,
    // so this starts the AllocMem/FreeMem watch as soon as exec.library
    // initializes (well before isExecReady's GfxBase+signature heuristic),
    // catching Kickstart's own boot-time allocations too.
    for (let i = 0; !isExecReady(M) && i < 1000; i++) {
      M._wasm_tick();
      if (!memProtectTrackingStarted) {
        memProtectTrackingStarted = !!M._wasm_memprotect_start_tracking();
      }
    }
    // Pause right here, synchronously, in the same tick that just validated
    // isExecReady() — not after sending exec-ready and waiting for the
    // server's own "pause" RPC to round-trip back. That round trip isn't
    // free: once this function returns, the render loop's frame() starts
    // calling _wasm_tick() every frame regardless of pause state (there's
    // no gate there for the fastLoad case), so the CPU keeps advancing
    // during the round trip and can drift into an interrupt or otherwise
    // leave the exact state isExecReady() just confirmed — by the time
    // injectProgram() (debugAdapter.ts) actually writes the program into
    // memory, the CPU may no longer be where/what it validated. Pausing
    // immediately here closes that window entirely: no tick can occur
    // between the check and the freeze because nothing else runs in
    // between (single-threaded, still the same synchronous call). The
    // server's own pause(true) call in injectProgram() becomes a harmless,
    // redundant re-confirmation once its round trip does land.
    M._wasm_pause();
    if (!memProtectTrackingStarted) {
      memProtectTrackingStarted = !!M._wasm_memprotect_start_tracking();
    }
    // [vscode-puae-debugger mem protect] GfxBase is confirmed set here
    // (isExecReady checked it), so its own library list is guaranteed to be
    // populated — safe to walk now, unlike at the earlier raw-execBase
    // tracking-start point above (see ami_debug.c's
    // e9k_debug_memprotect_seed_libraries).
    if (isExecReady(M)) M._wasm_memprotect_seed_libraries();
  }

  // -------- audio setup --------
  let workletNode: AudioWorkletNode | null = null;
  let audioCtx: AudioContext | null = null;
  let gain: GainNode | null = null; // hoisted so the speed/warp controls can mute audio
  let audioMuted = true; // starts muted — the toggle button is the explicit opt-in

  // PUAE always outputs at 44100 Hz; AudioContext may be at a different rate (e.g. 48000).
  // Resample with linear interpolation so the worklet's ring buffer stays balanced —
  // without this, a 48000 Hz context drains faster than we'd otherwise push, emptying
  // the buffer every cycle.
  //
  // The resampler is *stateful*: it carries a fractional read position and the last
  // source sample across chunks. Resampling each tick's chunk (~883 samples, one PAL
  // frame at 44100/49.92041015625) in isolation (mapping it to [0, dstN-1] on its own)
  // put a one-sample spacing discontinuity at every chunk boundary — an audible buzz/
  // jitter on any context whose rate isn't exactly 44100. Walking one continuous phase
  // across chunks removes it.
  const audioPuaeRate = 44100;
  let audioCtxRate = 44100;
  let audioResampleFrac = 0; // fractional distance past audioPrevL/R, in [0,1)
  let audioPrevL = 0, audioPrevR = 0; // last source sample of the previous chunk

  function resetResampler(): void {
    audioResampleFrac = 0;
    audioPrevL = 0;
    audioPrevR = 0;
  }

  function resampleChunk(srcL: Float32Array, srcR: Float32Array, srcN: number): { l: Float32Array; r: Float32Array } {
    // Pass-through when rates match: copy out (callers transfer the buffer).
    if (audioCtxRate === audioPuaeRate) {
      return { l: srcL.slice(0, srcN), r: srcR.slice(0, srcN) };
    }
    const step = audioPuaeRate / audioCtxRate; // source samples advanced per output sample
    const l = new Float32Array(Math.ceil(srcN / step) + 2);
    const r = new Float32Array(l.length);
    let frac = audioResampleFrac;
    let prevL = audioPrevL, prevR = audioPrevR;
    let o = 0;
    for (let i = 0; i < srcN; i++) {
      const curL = srcL[i], curR = srcR[i];
      // Emit every output sample falling between prevSample and curSample.
      while (frac < 1) {
        l[o] = prevL + frac * (curL - prevL);
        r[o] = prevR + frac * (curR - prevR);
        o++;
        frac += step;
      }
      frac -= 1;
      prevL = curL; prevR = curR;
    }
    audioResampleFrac = frac;
    audioPrevL = prevL; audioPrevR = prevR;
    return { l: l.subarray(0, o), r: r.subarray(0, o) };
  }

  function pushAccumToWorklet(): void {
    if (!workletNode) return;
    const n = M._wasm_get_audio_accum_count();
    if (n <= 0) return;
    if (!audioCtx || audioCtx.state !== "running") {
      // Nothing is draining the worklet right now (context suspended — e.g.
      // autoplay policy before the user unmutes) — discard instead of
      // building a backlog that would otherwise dump out as a stale,
      // overflow-glitched burst the moment playback resumes.
      M._wasm_reset_audio_accum();
      return;
    }
    const ptrL = M._wasm_get_audio_accum_L();
    const ptrR = M._wasm_get_audio_accum_R();
    // Views into wasm memory — read before resetting accumulator.
    const rawL = new Float32Array(M.HEAPF32.buffer, ptrL, n);
    const rawR = new Float32Array(M.HEAPF32.buffer, ptrR, n);
    const { l, r } = resampleChunk(rawL, rawR, n);
    M._wasm_reset_audio_accum();
    workletNode.port.postMessage({ l, r }, [l.buffer, r.buffer]);
  }

  async function startAudio(): Promise<void> {
    // Discard any audio that built up before now — we don't want to hear a
    // burst of old audio when the worklet starts.
    M._wasm_reset_audio_accum();

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtxRate = audioCtx.sampleRate;
    // If the context gets re-suspended (e.g. tab hidden), resume it
    // automatically when the user next clicks the audio button — no blanket
    // document listeners needed since the button is the explicit gesture.
    let audioWasRunning = audioCtx.state === "running";
    audioCtx.onstatechange = () => {
      const running = audioCtx!.state === "running";
      if (running && !audioWasRunning) {
        // Just started draining again after being suspended (e.g. autoplay
        // policy before the first unmute, or a tab-hidden re-suspend) —
        // discard whatever piled up in both the wasm accumulator and the
        // worklet's ring buffer while nothing was consuming it. Without
        // this, resuming dumps a backlog of stale, overflow-truncated audio
        // all at once — an audible jump.
        M._wasm_reset_audio_accum();
        resetResampler();
        workletNode?.port.postMessage({ reset: true });
        // Otherwise buffered playback (if active) would be left up to videoQueueCapacity
        // frames ahead of a freshly-reset (empty) audio stream — a second AV-desync
        // source distinct from the one flushBuffered() itself guards against.
        flushVideoQueue();
      }
      audioWasRunning = running;
      if (!running && !audioMuted) audioCtx!.resume();
    };
    await audioCtx.audioWorklet.addModule(audioWorkletUrl);
    workletNode = new AudioWorkletNode(audioCtx, "puae-audio-processor", {
      outputChannelCount: [2], numberOfInputs: 0, numberOfOutputs: 1,
    });
    gain = audioCtx.createGain();
    applyAudioMute();
    workletNode.connect(gain);
    gain.connect(audioCtx.destination);

    // Pre-fill the ring buffer with ~200ms of audio before the worklet starts
    // draining it, so initial message-delivery latency and scheduling jitter
    // don't immediately underrun. This cushion is what the catch-up logic in
    // frame() (uncapped, time-budgeted tick recovery) restores after a
    // main-thread stall — see the comment there.
    resetResampler();
    const PREFILL_FRAMES = 10;
    for (let i = 0; i < PREFILL_FRAMES; i++) M._wasm_tick();
    emuFrames += PREFILL_FRAMES;
    pushAccumToWorklet();
  }
  // -------------------------------------------------------

  if (onModuleReady) onModuleReady(M);

  // RPC bridge (Stage G3) — present inside the VS Code webview, or a plain
  // browser tab talking to the standalone server's WebSocket endpoint (see
  // src/standalone/server.ts and StandalonePuaeEmulator). undefined for
  // neither (e.g. puae/debug.html opened directly off disk, file://, with no
  // server behind it to connect to).
  const bridge = createHostBridge("/rpc");
  if (bridge) {
    vscode = bridge;
    rpc = setupRpcDispatcher(M, (msg) => bridge.postMessage(msg));
    bridge.onMessage((message) => {
      // Matches the old raw JSON.parse's implicit `any` return.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anyMessage = message as any;
      rpc!.handleMessage(anyMessage);
      // Handles symbolizeAddress replies for the DMA hover tooltip's
      // source-location lookup (see installDmaHoverTooltip below) — not a
      // {command,args}-shaped RPC message, just ignored by rpc.handleMessage.
      handleDmaHoverMessage(anyMessage);
    });
    // Tells PuaeEmulator the wasm module is ready, so it can fetch and cache
    // getMemoryInfo() — mirrors the vAmiga emulator project's own webview-ready
    // handshake. Safe to call immediately even before a WebSocket bridge's
    // socket has finished connecting — postMessage queues until open.
    bridge.postMessage({ type: "exec-ready" });
  }

  // "Open Amiga State" / "Open Memory Viewer" / "Open CPU Profiler" toolbar
  // buttons — standalone (non-vscode) host only. vscode already has these as
  // debug toolbar commands (puae-debugger.openStateViewer/openMemoryViewer/
  // openProfiler); outside vscode there's no command palette to put them in,
  // so they live here instead.
  if (typeof acquireVsCodeApi !== "function") {
    // Same origin as this page, so a plain window.open is enough for the
    // state viewer — no server round-trip needed (its panel always exists
    // at the same fixed URL, same as the profiler's).
    const openStateViewerBtn = document.getElementById("open-state-viewer");
    if (openStateViewerBtn) {
      openStateViewerBtn.style.display = "";
      openStateViewerBtn.addEventListener("click", () => {
        window.open("/state", "_blank");
      });
    }

    const openMemoryViewerBtn = document.getElementById("open-memory-viewer");
    if (openMemoryViewerBtn) {
      openMemoryViewerBtn.style.display = "";
      openMemoryViewerBtn.addEventListener("click", () => {
        // Unlike the profiler's fixed /profiler URL, a memory viewer panel
        // doesn't exist until the server creates one — this asks it to (it
        // opens the resulting tab itself), rather than routing the request
        // through this page's own emulator RPC/WebSocket channel.
        fetch("/open-memory-viewer").catch((error) => {
          console.error("Failed to open memory viewer:", error);
        });
      });
    }

    // Same origin as this page, so a plain window.open is enough for the
    // profiler — no server round-trip needed (unlike the memory viewer,
    // its panel always exists at the same fixed URL).
    const openProfilerBtn = document.getElementById("open-profiler");
    if (openProfilerBtn) {
      openProfilerBtn.style.display = "";
      openProfilerBtn.addEventListener("click", () => {
        window.open("/profiler", "_blank");
      });
    }

    // A tab left open across debug sessions otherwise just goes silently
    // stale once its --stdio server process exits — this makes that state
    // visible. On reconnect (as opposed to the initial connect) this
    // reloads the page rather than resuming in place: the already-booted
    // wasm module in this tab has no idea a *different* debug session is
    // now running, and would otherwise just keep rendering whatever the
    // previous session left on screen while silently receiving RPC calls
    // meant for the new one. A reload re-fetches "/" for the current
    // session's HTML/config and boots wasm fresh against it. See also
    // standalonePuaeEmulator.ts's REOPEN_GRACE_MS, which holds off opening a
    // *second* tab for a new session long enough for this reconnect to
    // reclaim this one first.
    const disconnectedOverlay = document.getElementById("disconnected-overlay");
    if (disconnectedOverlay && bridge) {
      // onConnectionChange fires synchronously at subscription time with
      // whatever the state is *right now* — always false here, since the
      // WebSocket handshake is inherently async and hasn't resolved yet even
      // on localhost. hasEverConnected distinguishes that normal "still
      // connecting for the first time" false from a *real* drop (a previous
      // true having flipped back to false), so the overlay/reload logic
      // below doesn't misfire on every ordinary page load.
      let hasEverConnected = false;
      // A brief drop-and-reconnect (e.g. the WebSocket's heartbeat briefly
      // starved by a long synchronous stretch of wasm/CPU emulation work,
      // not the server actually dying) shouldn't reload the page — only a
      // disconnect that's still down after this debounce is treated as
      // real. Without this, a transient blip during heavy emulation would
      // immediately satisfy the "was connected, now reconnecting" check
      // below and force an unwanted reload.
      const DISCONNECT_DEBOUNCE_MS = 1000;
      let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
      bridge.onConnectionChange((connected) => {
        if (connected) {
          if (disconnectTimer !== undefined) {
            clearTimeout(disconnectTimer);
            disconnectTimer = undefined;
            return; // reconnected before the debounce fired — treat as a non-event
          }
          if (hasEverConnected) {
            location.reload();
          } else {
            hasEverConnected = true;
            disconnectedOverlay.style.display = "none";
          }
        } else if (hasEverConnected && disconnectTimer === undefined) {
          disconnectTimer = setTimeout(() => {
            disconnectTimer = undefined;
            disconnectedOverlay.style.display = "flex";
          }, DISCONNECT_DEBOUNCE_MS);
        }
      });
    }
  }

  log("Boot OK — starting render loop");

  // ---------- render loop ----------
  const canvas = document.getElementById("screen") as HTMLCanvasElement;

  // "Auto" (the pre-existing behavior) stretches the canvas to the
  // container's width via the #screen CSS rule, letting the browser scale
  // (and smooth) it to whatever size that ends up being — cleared here by
  // resetting the inline style, since a fixed scale below sets one. A fixed
  // multiplier instead sizes it to an exact integer multiple of its
  // *current* intrinsic pixel dimensions (canvas.width/height — these
  // change at runtime with the emulated video mode: PAL/NTSC, lores/hires/
  // AGA), with image-rendering: pixelated so upscaling stays crisp/blocky
  // instead of CSS's default bilinear blur — the whole point of choosing an
  // exact multiple over "auto" is pixel-for-pixel fidelity. Called again
  // from uploadAndDraw() whenever canvas.width/height actually change, so a
  // mode switch while a fixed scale is selected doesn't leave the CSS size
  // matching the old resolution.
  //
  // CSS pixels aren't device pixels: on a devicePixelRatio=2 (Retina-style)
  // display, setting the CSS size to exactly canvas.width*multiplier CSS
  // pixels renders each emulated pixel as a 2x2 block of actual screen
  // pixels — "100%" would look like 200%. Dividing by devicePixelRatio here
  // maps a multiplier to that many *physical* pixels per emulated pixel
  // instead. watchDevicePixelRatio below re-applies this if the ratio
  // itself changes at runtime (e.g. the window is dragged to a monitor with
  // different DPI) — nothing else here would otherwise notice that.
  const scaleSelect = document.getElementById("scale") as HTMLSelectElement | null;
  function applyScale(): void {
    const value = scaleSelect?.value ?? "auto";
    if (value === "auto") {
      canvas.style.width = "";
      canvas.style.height = "";
      canvas.style.imageRendering = "";
    } else {
      const multiplier = parseInt(value, 10) || 1;
      const dpr = window.devicePixelRatio || 1;
      canvas.style.width = `${(canvas.width * multiplier) / dpr}px`;
      canvas.style.height = `${(canvas.height * multiplier) / dpr}px`;
      canvas.style.imageRendering = "pixelated";
    }
  }
  scaleSelect?.addEventListener("change", applyScale);

  // matchMedia's `resolution` query only fires once, for the ratio active
  // when it was created — re-subscribing on every change is the standard
  // way to keep tracking devicePixelRatio as it keeps changing.
  function watchDevicePixelRatio(onChange: () => void): void {
    const subscribe = () => {
      matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
        "change",
        () => { onChange(); subscribe(); },
        { once: true },
      );
    };
    subscribe();
  }
  watchDevicePixelRatio(applyScale);

  // WebGL, not a 2D context: putImageData needs a JS-owned ImageData (Chrome 117+
  // rejects one backed directly by wasm memory — see getFbView's comment below), so
  // getting a wasm-composited RGBA frame on screen via the 2D canvas costs two
  // full-framebuffer copies every tick: wasm heap -> ImageData, then ImageData ->
  // the canvas's own backing store inside putImageData. texSubImage2D instead
  // uploads straight from a view into wasm memory (the same pattern Emscripten's own
  // GL bindings use — the source ArrayBufferView isn't required to be JS-owned the
  // way ImageData's constructor requires) directly into the GPU texture, then a
  // single draw call blits it: one copy instead of two.
  const gl = canvas.getContext("webgl", {
    alpha: false, antialias: false, depth: false, stencil: false,
  })!;
  let glProgram: WebGLProgram;
  let aPos = -1, aUv = -1;
  let glTex: WebGLTexture | null = null;
  // The texture's currently-allocated size (-1 = not yet allocated) — texImage2D
  // (re)allocates storage and is only needed on the first upload or a resize;
  // every other frame reuses the same storage via the cheaper texSubImage2D.
  let glTexW = -1, glTexH = -1;
  // Whether uploadAndDraw has painted at least one frame yet — mirrors the old
  // ImageData-based "imgData !== null" check the paused-frame path below used.
  let hasDrawnFrame = false;
  // True from 'webglcontextlost' until 'webglcontextrestored' fires — a context
  // loss (driver reset, GPU memory pressure; more reachable on the weak/software-
  // rendered GPUs this project also has to run on) invalidates every WebGL object
  // created below, so uploadAndDraw must not touch them until initGl() has
  // rebuilt everything.
  let glContextLost = false;

  // (Re)compiles the shader program, uploads the static quad, and (re)creates the
  // texture. Called once at startup and again from 'webglcontextrestored' below.
  function initGl(): void {
    glProgram = gl.createProgram()!;
    const vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vs, `
      attribute vec2 aPos;
      attribute vec2 aUv;
      varying vec2 vUv;
      void main() {
        vUv = aUv;
        gl_Position = vec4(aPos, 0.0, 1.0);
      }
    `);
    gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(fs, `
      precision mediump float;
      varying vec2 vUv;
      uniform sampler2D uTex;
      void main() {
        gl_FragColor = texture2D(uTex, vUv);
      }
    `);
    gl.compileShader(fs);
    gl.attachShader(glProgram, vs);
    gl.attachShader(glProgram, fs);
    gl.linkProgram(glProgram);
    gl.useProgram(glProgram);

    // One static quad covering the whole clip space, with the screen-top vertices
    // sampling v=0 — confirmed by a pixel-for-pixel comparison against the boot
    // screen the old 2D-canvas putImageData path rendered (both show row 0 of the
    // RGBA buffer as the texture's v=0 row); don't "fix" this into a flip without
    // re-running that comparison, it looked wrong at a glance but wasn't.
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      /* x   y   u  v */
      -1, -1,  0, 1,
       1, -1,  1, 1,
      -1,  1,  0, 0,
       1,  1,  1, 0,
    ]), gl.STATIC_DRAW);
    aPos = gl.getAttribLocation(glProgram, "aPos");
    aUv = gl.getAttribLocation(glProgram, "aUv");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aUv);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);

    glTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, glTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    glTexW = -1; // force the next uploadAndDraw to reallocate storage
    glTexH = -1;
  }
  initGl();

  // preventDefault() is required for the browser to ever attempt restoration —
  // without it, a lost context stays lost for the rest of the session. Once
  // 'webglcontextrestored' fires, initGl() rebuilds the program/buffer/texture
  // from scratch (everything from before the loss is invalid) and hasDrawnFrame
  // is cleared so the paused-frame path below doesn't skip redrawing the first
  // frame after restoration.
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    glContextLost = true;
  });
  canvas.addEventListener("webglcontextrestored", () => {
    initGl();
    glContextLost = false;
    hasDrawnFrame = false;
  });

  // Frame-budget overrun diagnostics (jerky-playback triage): counts + peak lateness for
  // both signals frame() below checks, flushed to the console at most once a second — and
  // only when something actually overran, so a healthy session stays silent. Logging each
  // overrun individually was tried first and made things WORSE: console output while devtools
  // is open is itself expensive enough to visibly stutter playback, and once overruns start
  // (each slow tick logging more) that cost compounds. Aggregating keeps this useful without
  // it becoming part of the jank it's meant to diagnose.
  let overrunLogWindowStart = 0;
  let callbackGapOverruns = 0, callbackGapOverrunMaxMs = 0;
  let frameOverruns = 0, frameOverrunMaxMs = 0;
  // Summed (not maxed) wasm-tick and GPU-draw time across just the overrun frames, so the
  // flush below can report an average breakdown of where an overrun frame's time actually
  // went — cheap running sums, no per-frame allocation.
  let frameOverrunWasmSumMs = 0, frameOverrunGpuSumMs = 0;
  // Total ticks (ranCount, could be >1 per overrun callback) across just the overrun
  // frames — lets the flush below report cost PER TICK, not just per overrun callback.
  // These are different numbers whenever an overrun callback ran more than one tick
  // (see jitterMultiTickCallbacks below): a callback that ran 2 fast ~14ms ticks back to
  // back totals ~28ms (over budget, counted as one overrun) despite no single tick ever
  // being slow — dividing frameOverrunWasmSumMs by frameOverruns alone can't tell that
  // apart from a callback that ran one genuinely ~28ms tick, which is exactly the
  // ambiguity that made the earlier "avg wasm=27-29ms" readings potentially misleading.
  let frameOverrunTicksSum = 0;
  // Normal mode's dueFrames-driven catch-up is capped to one tick per callback for
  // small backlogs (see JITTER_TOLERANT_BACKLOG_FRAMES) specifically so ordinary
  // timer/clock jitter can't force a back-to-back multi-tick catch-up. If this ever
  // fires now, it means the backlog exceeded that tolerance — a genuine stall, not
  // routine jitter — which is worth surfacing distinctly from a single slow tick
  // (frameOverruns above already covers that case).
  let jitterMultiTickCallbacks = 0, jitterMultiTickMaxRan = 0;
  function flushOverrunLogIfDue(ts: number): void {
    if (ts - overrunLogWindowStart < 1000) return;
    if (callbackGapOverruns > 0 || frameOverruns > 0 || jitterMultiTickCallbacks > 0) {
      const avgWasmMs = frameOverruns > 0 ? frameOverrunWasmSumMs / frameOverruns : 0;
      const avgGpuMs = frameOverruns > 0 ? frameOverrunGpuSumMs / frameOverruns : 0;
      const avgWasmPerTickMs = frameOverrunTicksSum > 0 ? frameOverrunWasmSumMs / frameOverrunTicksSum : 0;
      console.warn(
        `[puae] budget overruns in the last ~1s (budget ${FRAME_BUDGET_MS.toFixed(1)}ms): ` +
        `${callbackGapOverruns} late tick callback(s) (max ${callbackGapOverrunMaxMs.toFixed(1)}ms since previous), ` +
        `${frameOverruns} slow frame() call(s) (max ${frameOverrunMaxMs.toFixed(1)}ms, ` +
        `avg wasm=${avgWasmMs.toFixed(1)}ms [${avgWasmPerTickMs.toFixed(1)}ms/tick x ${(frameOverruns > 0 ? frameOverrunTicksSum / frameOverruns : 0).toFixed(1)} ticks avg] ` +
        `avg gpu=${avgGpuMs.toFixed(1)}ms of that)` +
        (jitterMultiTickCallbacks > 0
          ? `, ${jitterMultiTickCallbacks} multi-tick callback(s) despite on-time arrival ` +
            `(max ${jitterMultiTickMaxRan} ticks — backlog exceeded the jitter tolerance)`
          : ""),
      );
      // Also report to the extension host's "PUAE Performance" output channel (see
      // webviewEmulator.ts's handlePanelMessage) — unlike the console.warn above, this is
      // visible WITHOUT opening the webview's DevTools, which itself measurably slows down
      // JS/wasm execution (confirmed directly: overruns are far more frequent and severe with
      // DevTools attached than without), confounding exactly the measurement this diagnostic
      // exists to take. Only available inside the real VS Code webview — vscode is undefined
      // in debug.html standalone.
      if (vscode) {
        vscode.postMessage({
          type: "perf-overrun",
          budgetMs: FRAME_BUDGET_MS,
          callbackGapOverruns,
          callbackGapOverrunMaxMs,
          frameOverruns,
          frameOverrunMaxMs,
          avgWasmMs,
          avgGpuMs,
          avgWasmPerTickMs,
          frameOverrunTicksSum,
          jitterMultiTickCallbacks,
          jitterMultiTickMaxRan,
        });
      }
    }
    overrunLogWindowStart = ts;
    callbackGapOverruns = 0;
    callbackGapOverrunMaxMs = 0;
    frameOverruns = 0;
    frameOverrunMaxMs = 0;
    frameOverrunTicksSum = 0;
    jitterMultiTickCallbacks = 0;
    jitterMultiTickMaxRan = 0;
    frameOverrunWasmSumMs = 0;
    frameOverrunGpuSumMs = 0;
  }

  // Drive at exactly 50 Hz PAL using a cumulative due-frames counter so the tick
  // fires at the right wall-clock time regardless of the display refresh rate.
  let emuFrames = 0; // total emulation frames run so far
  // When audio is running at normal speed, pace emulation off the AudioContext's
  // own clock instead of the system clock (performance.now()). The two clocks
  // run at very slightly different rates (ordinary audio-hardware clock drift),
  // so pacing off the system clock while the worklet drains at the hardware
  // rate makes production slowly outrun consumption until the ring buffer
  // fills and starts dropping samples — an audible click each time it
  // overflows. Tying production to the same clock that drives consumption
  // removes the drift instead of just buffering around it. null means "not
  // currently using the audio clock" (audio not yet running, or warp/non-1x
  // speed, which mute audio and must stay on the system clock).
  let lastAudioClockS: number | null = null;
  let lastCheckpointFrame = 0; // emuFrames at the last periodic rpc.pushSnapshot()
  let fpsTime = 0;
  let fpsCnt = 0;
  // wasm_get_frame_count() as of the last canvas redraw — lets us notice the
  // framebuffer changed while paused (e.g. stepBack/continueReverse/
  // stepBackFrame's landing replay renders a frame via
  // wasm_replay_instructions_video) and redraw even though emulation isn't
  // advancing.
  let lastFbFrameCount = -1;

  // Cached view over the wasm framebuffer, reused every frame instead of
  // allocating a new Uint8ClampedArray wrapper 50x/sec. Only recreated when
  // the pointer/length change (canvas resize) or the wasm memory buffer
  // itself is replaced (ALLOW_MEMORY_GROWTH growing the heap detaches any
  // view still pointing at the old ArrayBuffer).
  let fbView: Uint8ClampedArray | null = null;
  let fbViewBuffer: ArrayBufferLike | null = null;
  let fbViewPtr = -1;
  let fbViewLen = -1;
  function getFbView(ptr: number, len: number): Uint8ClampedArray {
    if (!fbView || fbViewBuffer !== M.HEAPU8.buffer || fbViewPtr !== ptr || fbViewLen !== len) {
      fbView = new Uint8ClampedArray(M.HEAPU8.buffer, ptr, len);
      fbViewBuffer = M.HEAPU8.buffer;
      fbViewPtr = ptr;
      fbViewLen = len;
    }
    return fbView;
  }

  // Uploads an RGBA frame straight from wasm memory into the GL texture and draws
  // it to fill the canvas — shared by frame()'s normal tick draw below and
  // drawCurrentFrame (paused/replay redraw).
  function uploadAndDraw(rgba: Uint8ClampedArray, w: number, h: number): void {
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      applyScale(); // keep a fixed-scale CSS size in sync with the new resolution
    }
    // Wait for 'webglcontextrestored' (see above) to rebuild GL state before
    // drawing again — canvas.width/height above still gets updated either way, so
    // hover/mouse-capture pixel mapping (which reads those, not GL state) stays
    // correct even while nothing is actually being painted.
    if (glContextLost) return;
    gl.viewport(0, 0, w, h);
    gl.bindTexture(gl.TEXTURE_2D, glTex);
    if (glTexW !== w || glTexH !== h) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      glTexW = w;
      glTexH = h;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    hasDrawnFrame = true;
  }

  // ---------- buffered/smooth playback (launch-config only — see MainConfig's
  // bufferedPlaybackEnabled doc comment; no runtime UI toggle) ----------
  // While active, frame()'s tick loop runs flat-out (like warp) but capped by this
  // queue instead of by dueFrames, capturing EVERY tick's framebuffer (not just
  // the last one, unlike the warp/normal branches) so a later slow-tick burst can
  // be smoothed over by draining already-computed frames instead of stalling on a
  // slow one. Forced off (see effectiveBuffered in frame()) the instant the
  // debugger pauses, hits a breakpoint, or warp mode engages — interactive
  // debugging must never show stale buffered frames.
  const videoQueueCapacity = Math.max(1, Math.min(128, Math.floor(bufferedPlaybackFrames)));
  interface VideoQueueSlot { data: Uint8ClampedArray; w: number; h: number; }
  const videoQueue: (VideoQueueSlot | null)[] = bufferedPlaybackEnabled
    ? new Array(videoQueueCapacity).fill(null)
    : [];
  let vqHead = 0; // index of the oldest queued frame
  let vqCount = 0;
  // False from startup (and after any flush) until the queue has filled to capacity
  // at least once. While false, effectiveBuffered (in frame()) stays false too and the
  // consumer draws the live framebuffer instead of dequeuing — otherwise the consumer
  // would start dequeuing from callback #1, draining each frame about as fast as the
  // producer can add it (given a callback only fits ~1-2 ticks in its time budget),
  // so the queue would never actually build a cushion — the exact "jerky while
  // filling" symptom this flag exists to fix. Once primed, playback is smooth for the
  // reason bufferedPlaybackFrames exists at all: the queue was given a chance to
  // build a real lead before anything started draining it.
  let bufferedPrimed = false;

  // Captures the CURRENT wasm framebuffer into the next free queue slot, reusing
  // a slot's buffer across calls when the size hasn't changed (canvas geometry is
  // stable almost all the time) instead of allocating fresh every tick.
  function enqueueVideoFrame(): void {
    const w = M._wasm_get_fb_width();
    const h = M._wasm_get_fb_height();
    if (!w || !h) return;
    const len = w * h * 4;
    const tail = (vqHead + vqCount) % videoQueueCapacity;
    let slot = videoQueue[tail];
    if (!slot || slot.data.length !== len) {
      slot = { data: new Uint8ClampedArray(len), w, h };
      videoQueue[tail] = slot;
    } else {
      slot.w = w;
      slot.h = h;
    }
    slot.data.set(getFbView(M._wasm_get_fb_rgba(), len));
    vqCount++; // caller (frame()'s producer loop) already checked vqCount < videoQueueCapacity
    if (vqCount >= videoQueueCapacity) bufferedPrimed = true;
  }

  // Pops the oldest queued frame, or null if the queue is empty (startup
  // ramp-up, or a burst deeper than videoQueueCapacity).
  function dequeueVideoFrame(): VideoQueueSlot | null {
    if (vqCount === 0) return null;
    const slot = videoQueue[vqHead];
    vqHead = (vqHead + 1) % videoQueueCapacity;
    vqCount--;
    return slot;
  }

  function flushVideoQueue(): void {
    vqHead = 0;
    vqCount = 0;
    // Re-prime from scratch next time buffered playback resumes — otherwise the very
    // first frame after a pause/breakpoint/warp interruption would immediately start
    // dequeuing from an empty queue, reintroducing the same jerky-while-filling
    // symptom bufferedPrimed exists to avoid.
    bufferedPrimed = false;
  }

  // Discards any queued-but-undisplayed video, and the audio worklet's own
  // backlog with it — called whenever buffered playback is interrupted (pause,
  // breakpoint, warp engaging) so leftover buffered content never delays or
  // outlives the interactive state the user actually cares about.
  function flushBuffered(): void {
    flushVideoQueue();
    workletNode?.port.postMessage({ reset: true });
    resetResampler();
    M._wasm_reset_audio_accum();
  }

  // Called by rpc.ts's async continueReverse to paint the current wasm
  // framebuffer to the canvas between checkpoint intervals.
  globalThis.drawCurrentFrame = () => {
    const w = M._wasm_get_fb_width();
    const h = M._wasm_get_fb_height();
    if (!w || !h) return;
    uploadAndDraw(getFbView(M._wasm_get_fb_rgba(), w * h * 4), w, h);
    lastFbFrameCount = M._wasm_get_frame_count();
  };

  // Non-fastLoad (usesDh0) process-attach state: tryExec() arms an
  // AllocMem breakpoint once exec/graphics libraries are ready (execReady),
  // then getCurrentProcess() is checked on each hit until it identifies our
  // expectedProcessName CLI process (attached) — see rpc.ts. fastLoad
  // (usesDh0===false) has no separate attach step.
  let execReady = !usesDh0;
  let attached = !usesDh0;
  let allocMemAddr = 0;

  // Playback speed control (#speed dropdown, optional — debug.html omits it).
  // 1 = normal (100%) speed; values < 1 slow emulated time down relative to
  // wall-clock time, for slow-motion debugging.
  let speedFactor = 1;
  let emuClockMs = 0; // accumulated emulated time, scaled by speedFactor
  let lastTs: number | null = null;
  // Warp mode (#warp checkbox, optional): runs as many ticks as fit in
  // WARP_TICK_BUDGET_MS per tick-worker callback, ignoring speedFactor.
  // Mutually exclusive with the speed dropdown (disabled while warp is on).
  let warpMode = false;
  // Automatically forces warp mode for non-fastLoad (usesDh0) boots, for as long as
  // AmigaOS is still booting/running its startup-sequence (execReady/attached false) —
  // there's nothing meaningful to watch at normal speed until the program itself starts,
  // and DH0:-booting can otherwise take many real seconds. Tracked separately from the
  // user's own warpMode toggle (frame() ORs the two — see effectiveWarp) so the warp
  // button's own on/off state isn't clobbered by this automatic phase, and so it can
  // drive applyAudioMute() (which only re-runs on UI events, not every frame) exactly
  // when this phase starts/ends, not just when the user clicks the button.
  let bootWarpActive = false;
  // Tracks whether cycle-exact mode is currently disabled for warp, so frame()'s
  // effectiveWarp-transition block (below) only calls wasm_set_cycle_exact on an
  // actual change, not every frame. Cycle-exact bus/DMA-contention modeling is the
  // dominant per-instruction cost for compute-bound code (confirmed directly: a tight
  // register-bound loop profiled ~2x faster with it disabled) — disabling it while
  // warp is active (manual or bootWarpActive) is a big further speedup on top of
  // warp's own tick-budget-per-callback mechanism. Not preserved for accuracy-critical
  // work (profiling, DMA-precise debugging) — restored the instant warp ends.
  let cycleExactDisabledForWarp = false;

  // Audio can't play correctly at non-1x speed or in warp mode (pitch/rate
  // would need to change too), so mute it whenever either is active.
  function applyAudioMute(): void {
    if (gain) gain.gain.value = (audioMuted || warpMode || bootWarpActive || speedFactor !== 1) ? 0 : 0.5;
  }

  const speedSelect = document.getElementById("speed") as HTMLSelectElement | null;
  if (speedSelect) {
    speedFactor = parseFloat(speedSelect.value) || 1;
    speedSelect.addEventListener("change", () => {
      speedFactor = parseFloat(speedSelect.value) || 1;
      applyAudioMute();
    });
  }

  const warpButton = document.getElementById("warp");
  // Reflects effectiveWarp (warpMode || bootWarpActive), not just warpMode — so the
  // button visibly lights up during the automatic boot-warp phase too, not only when
  // the user has clicked it themselves. Called from both the click handler and
  // frame()'s bootWarpActive transition (see below) so the two stay consistent; the
  // speed dropdown is disabled under either source, since dueFrames-based pacing is
  // bypassed either way.
  function updateWarpButtonUI(): void {
    if (!warpButton) return;
    const active = warpMode || bootWarpActive;
    warpButton.classList.toggle("active", active);
    if (speedSelect) speedSelect.disabled = active;
  }
  if (warpButton) {
    warpButton.addEventListener("click", () => {
      warpMode = !warpMode;
      updateWarpButtonUI();
      applyAudioMute();
    });
  }

  const audioToggle = document.getElementById("audio-toggle");
  const audioToggleIcon = audioToggle?.querySelector(".codicon");
  function setAudioMuted(muted: boolean): void {
    audioMuted = muted;
    audioToggleIcon?.classList.toggle("codicon-mute", audioMuted);
    audioToggleIcon?.classList.toggle("codicon-unmute", !audioMuted);
    if (audioToggle) audioToggle.title = audioMuted ? "Unmute audio" : "Mute audio";
    if (!audioMuted) audioCtx?.resume(); // satisfies autoplay policy on first user gesture
    applyAudioMute();
  }
  if (audioToggle) {
    audioToggle.addEventListener("click", () => setAudioMuted(!audioMuted));
  }

  interface ToggleItem {
    key: number;
    text: string;
    title?: string;
    color?: string;
  }

  // Forces a real re-render of the currently-paused frame under whatever debug settings just
  // changed (bitplane/sprite/blitter mute — see makeToggleGroup below). Unlike
  // redrawOverlayIfPaused's wasm_redraw_frame() (a cheap recomposite of already-rendered pixels,
  // fine for the DMA overlay tint/blit-vis highlight, which are pure post-process overlays),
  // channel muting changes what Denise/Agnus actually draw *into* the framebuffer in the first
  // place (drawing.c's debug_bpl_mask, custom.c's debug_sprite_mask) — there's nothing cached to
  // recomposite from, so nothing visibly changes without this.
  //
  // wasm_tick() while paused turns out to already do exactly what's needed here, verified
  // directly against the real wasm module: the CPU's PC/registers/SR come back byte-for-byte
  // identical before and after (confirmed across repeated calls) — while paused, the 68000 stays
  // halted at its breakpoint exactly like on real hardware if you assert its HALT line, but Agnus/
  // Denise/Paula keep running on their own independent clock (the cycle counter *does* advance,
  // by exactly one frame's worth) and redraw the same already-fetched chip-RAM content with
  // whatever debug masks are current right now. The one real side effect is a frame's worth of
  // audio Paula generates along the way that nothing will ever consume (the normal frame() loop's
  // pushAccumToWorklet isn't in this call path) — discarded via wasm_reset_audio_accum so it can't
  // cause a glitch on resume.
  function forceRedrawWhilePaused(): void {
    if (!M._wasm_is_paused()) return;
    M._wasm_tick();
    M._wasm_reset_audio_accum();
  }

  // Builds a labelled group of small numbered toggle squares (toolbar-style,
  // replacing the previous checkbox lists). `items` is [{ key, text, color? }];
  // onToggle(item, active) is called whenever a square is clicked.
  //
  // Groups with more than one item get an "ALL" toggle (mirroring the DMA overlay panel's
  // hand-rolled one below: state is derived, not stored — its `active` class is just "are all
  // items currently active", recomputed after every change, and clicking it drives every item
  // through the same per-item setter a normal click uses). Shift-clicking an item isolates it:
  // that item turns on and every other item in the group turns off.
  function makeToggleGroup(label: string, items: ToggleItem[], onToggle: (item: ToggleItem, active: boolean) => void): HTMLDivElement {
    const group = document.createElement("div");
    group.className = "chan-group";
    const lbl = document.createElement("span");
    lbl.className = "chan-group-label";
    lbl.textContent = label;
    group.appendChild(lbl);
    const grid = document.createElement("div");
    grid.className = "chan-grid";

    const btns: HTMLButtonElement[] = [];
    const setItem = (idx: number, active: boolean): void => {
      btns[idx].classList.toggle("active", active);
      onToggle(items[idx], active);
      forceRedrawWhilePaused();
    };

    let allBtn: HTMLButtonElement | undefined;
    const syncAllBtn = (): void => {
      allBtn?.classList.toggle("active", btns.every(b => b.classList.contains("active")));
    };

    if (items.length > 1) {
      allBtn = document.createElement("button");
      allBtn.type = "button";
      allBtn.className = "chan-btn all-btn active";
      allBtn.textContent = "ALL";
      allBtn.title = `Toggle all ${label.toLowerCase()}`;
      allBtn.addEventListener("click", () => {
        const turnOn = !btns.every(b => b.classList.contains("active"));
        items.forEach((_, idx) => setItem(idx, turnOn));
        syncAllBtn();
      });
      grid.appendChild(allBtn);
    }

    items.forEach((item, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chan-btn active";
      btn.textContent = item.text;
      btn.title = items.length > 1
        ? `${item.title || item.text} (Shift-click to isolate)`
        : item.title || item.text;
      if (item.color) btn.style.setProperty("--chan-color", item.color);
      btn.addEventListener("click", (e) => {
        if (e.shiftKey && items.length > 1) {
          items.forEach((_, i) => setItem(i, i === idx));
        } else {
          setItem(idx, !btn.classList.contains("active"));
        }
        syncAllBtn();
      });
      grid.appendChild(btn);
      btns.push(btn);
    });

    group.appendChild(grid);
    return group;
  }

  // DMA overlay panel (#dma-overlay, optional).
  // Controls: an "ALL" toggle, per-channel toggle squares, opacity slider.
  // There's no separate overlay-enable flag in the UI — the overlay is simply
  // enabled whenever at least one channel is active, and disabled when all
  // are off. All wired directly to the WASM overlay functions (no RPC
  // round-trip needed).
  //
  // No "Conflict" (DmaRecordType.CONFLICT) entry: verified unreachable in
  // practice — every known hardware DMA-priority quirk this emulator models
  // computes its merged result and logs it as an ordinary BITPLANE/REFRESH
  // record instead of ever triggering the generic conflict-detection path
  // (see dmaHover.ts's channelLabelFor comment). The toggle never
  // highlighted anything.
  const DMA_CHANNELS = [
    { type: DmaRecordType.REFRESH, label: "Refresh", abbr: "REF", color: "#444444" },
    { type: DmaRecordType.CPU, label: "CPU", abbr: "CPU", color: "#a25342" },
    { type: DmaRecordType.COPPER, label: "Copper", abbr: "COP", color: "#eeee00" },
    { type: DmaRecordType.AUDIO, label: "Audio", abbr: "AUD", color: "#ff0000" },
    { type: DmaRecordType.BLITTER, label: "Blitter", abbr: "BLT", color: "#008888" },
    { type: DmaRecordType.BITPLANE, label: "Bitplane", abbr: "BPL", color: "#0000ff" },
    { type: DmaRecordType.SPRITE, label: "Sprite", abbr: "SPR", color: "#ff00ff" },
    { type: DmaRecordType.DISK, label: "Disk", abbr: "DSK", color: "#ffffff" },
  ];

  // Whether any DMA overlay channel is on — gates the hover tooltip itself
  // (see installDmaHoverTooltip below): copper hovers additionally need
  // copperChannelActive, but other channels' (e.g. blitter) per-cycle info
  // only needs debug_dma, already on whenever any channel is enabled.
  let dmaOverlayActive = false;
  // DMARECORD_* types (DMA_CHANNELS' `type` values match these 1:1) whose
  // overlay toggle is currently on — the hover tooltip must only show info
  // for cells the overlay is actually drawing, not every DMA cycle that
  // happens to be recorded (debug_dma records every channel regardless of
  // which ones are toggled for the visual overlay).
  const enabledChannelTypes = new Set<number>();

  // Auto-enabled DMA/copper *recording* (not the DMA overlay panel's geometry — see
  // wasm_dma_tracking_enable's own comment in puae_debug.c for why these are independent) for
  // screenHover.ts's paused-screen tooltip, so it works without the user ever touching the DMA
  // overlay panel. Reasserted on every pause transition (not just the first) — cheap (just an
  // int set), and robust against the DMA overlay panel independently turning debug_dma back off
  // via its own toggle (both write the same underlying flag; whichever call happens later wins).
  // Critically NOT turned back off on resume: DMA/copper records only exist for cycles that ran
  // *while* tracking was on, not retroactively, so tracking has to stay on through the *next*
  // running interval for the following pause to have anything to show. Still sparse right after
  // this first fires (this same pause's own frame was already rendered before tracking turned
  // on), but every pause after the next run resolves. No visual side effect (unlike the DMA
  // overlay panel's own toggle): this never touches crop/overscan/geometry.
  let wasPausedPrev = false;

  // Blit-region highlight. The actual pixel-accurate highlight is drawn C-side:
  // wasm_blit_vis_update() (called each frame below) stamps blitter-written
  // chip-RAM words; the emulator's render marks the on-screen pixels whose
  // source was recently blitted and blends a fading tint straight into the
  // framebuffer (see puae_debug.c / drawing.c / frontend_shim.c). JS only drives
  // the per-frame tag update and the enable toggle.
  let blitTrackingEnabled = false;

  const dmaOverlayPanel = document.getElementById("dma-overlay");
  if (dmaOverlayPanel) {
    const channelGroup = document.createElement("div");
    channelGroup.className = "chan-group";
    const channelLbl = document.createElement("span");
    channelLbl.className = "chan-group-label";
    channelLbl.textContent = "DMA";
    channelGroup.appendChild(channelLbl);

    const grid = document.createElement("div");
    grid.className = "chan-grid";

    const allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.className = "chan-btn all-btn";
    allBtn.textContent = "ALL";
    allBtn.title = "Toggle all DMA channels";
    grid.appendChild(allBtn);

    // wasm_dma_overlay_set_channel/enable/set_opacity only flip C-side
    // state — the actual RGBA recompositing normally only happens inside
    // shim_video_refresh, which needs a real wasm_tick() to run. While
    // paused, no ticks happen, so without this the overlay wouldn't visibly
    // update until the next step/resume. wasm_redraw_frame() re-applies the
    // current settings to the already-rendered frame and bumps the frame
    // counter, which frame()'s existing "redraw if framebuffer changed while
    // paused" path (below) then picks up on its next scheduled callback.
    function redrawOverlayIfPaused(): void {
      if (M._wasm_is_paused()) M._wasm_redraw_frame();
    }

    function setChannel(idx: number, active: boolean): void {
      const ch = DMA_CHANNELS[idx];
      channelBtns[idx].classList.toggle("active", active);
      M._wasm_dma_overlay_set_channel(ch.type, active ? 1 : 0);
      if (active) enabledChannelTypes.add(ch.type);
      else enabledChannelTypes.delete(ch.type);
      if (ch.type === DmaRecordType.COPPER) {
        M._wasm_copper_tracking_enable(active ? 1 : 0);
      }
      const anyActive = channelBtns.some(b => b.classList.contains("active"));
      dmaOverlayActive = anyActive;
      M._wasm_dma_overlay_enable(anyActive ? 1 : 0);
      dmaOverlayPanel!.classList.toggle("disabled", !anyActive);
      redrawOverlayIfPaused();
    }

    function syncAllBtn(): void {
      allBtn.classList.toggle("active", channelBtns.every(b => b.classList.contains("active")));
    }

    // Start with every channel off — the overlay is opt-in.
    const channelBtns = DMA_CHANNELS.map((ch, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chan-btn";
      btn.textContent = ch.abbr;
      btn.title = ch.label;
      btn.style.setProperty("--chan-color", ch.color);
      btn.addEventListener("click", () => {
        setChannel(idx, !btn.classList.contains("active"));
        syncAllBtn();
      });
      grid.appendChild(btn);
      return btn;
    });

    allBtn.addEventListener("click", () => {
      const turnOn = !channelBtns.every(b => b.classList.contains("active"));
      DMA_CHANNELS.forEach((_, idx) => setChannel(idx, turnOn));
      syncAllBtn();
    });

    channelGroup.appendChild(grid);
    dmaOverlayPanel.appendChild(channelGroup);
    dmaOverlayPanel.classList.add("disabled");

    // Opacity slider
    const opacityRow = document.createElement("div");
    opacityRow.className = "opacity-row";
    const opacityLbl = document.createElement("span");
    opacityLbl.className = "chan-group-label";
    opacityLbl.textContent = "Opacity";
    const opacitySlider = document.createElement("input");
    opacitySlider.type = "range";
    opacitySlider.min = "0";
    opacitySlider.max = "255";
    opacitySlider.value = "128";
    opacitySlider.addEventListener("input", () => {
      M._wasm_dma_overlay_set_opacity(parseInt(opacitySlider.value, 10));
      redrawOverlayIfPaused();
    });
    opacityRow.appendChild(opacityLbl);
    opacityRow.appendChild(opacitySlider);
    dmaOverlayPanel.appendChild(opacityRow);
  }

  // Browsers block audio autoplay until a user gesture; clicking the canvas
  // (like the explicit unmute button) satisfies that, so unmute automatically
  // rather than requiring a separate click on the toolbar button. Only
  // unmutes (never re-mutes) — a click elsewhere already muted stays muted.
  // Registered before installDmaHoverTooltip/installMouseCapture below so
  // their stopImmediatePropagation (DMA-hover's click-to-open-source path)
  // can't suppress this — it should fire on every canvas click regardless.
  canvas.addEventListener("click", () => {
    if (audioMuted) setAudioMuted(false);
  });

  // DMA overlay hover tooltip: shows brief info (disassembly for copper,
  // channel/data for blitter) under the cursor while any DMA channel is
  // active, restricted to cells whose channel is actually toggled on (see
  // enabledChannelTypes — debug_dma records every channel regardless of
  // which ones the overlay is drawing). Passing `vscode` (undefined outside
  // the real webview, e.g. debug.html) enables copper's and CPU instruction
  // fetches' source-location lookup and click-to-open. Suppressed while paused — the
  // screen-reconstruction tooltip below takes over at that point instead.
  installDmaHoverTooltip(canvas, M, () => dmaOverlayActive && !M._wasm_is_paused(), (type) => enabledChannelTypes.has(type), vscode);

  // Screen-reconstruction hover tooltip: the profiler's Screen view (Colour/Planes/Addrs/
  // BPLCON0/Palette/Copper), decoded live for whatever pixel the cursor is over — only while
  // paused. Unlike the DMA overlay's own per-cell tooltip above, this one does NOT need the
  // overlay panel or its full-raster geometry at all: it reconstructs its own screen from the
  // DMA/copper trace (same as the profiler's Screen view), independent of the live framebuffer's
  // own crop/geometry — see screenHover.ts's header comment. The DMA/copper *recording* it needs
  // is instead driven directly by the wasPaused transition above (wasm_dma_tracking_enable),
  // with no visual side effect.
  installScreenHoverTooltip(canvas, M, () => M._wasm_is_paused());

  // Mouse capture (pointer lock) for the emulated Amiga mouse: left click
  // captures, middle click releases. Installed after the tooltip above so
  // its click listener runs second — the tooltip suppresses this one (via
  // stopImmediatePropagation) when a click instead opens a source file.
  installMouseCapture(canvas, M);

  // Keyboard capture for the emulated Amiga keyboard: click the canvas to
  // focus it, then keys are forwarded until focus moves elsewhere (e.g. to
  // one of this toolbar's own <select>/<input> controls).
  installKeyboardCapture(canvas, M);

  // Channel visibility panel (#channel-visibility, optional).
  // Numbered toggle squares to disable individual bitplanes, sprites, and
  // audio channels, plus a single toggle for the blitter (one channel, no
  // index — see wasm_set_blitter_enabled's comment for what "disable" means
  // for it specifically).
  const channelVisPanel = document.getElementById("channel-visibility");
  if (channelVisPanel) {
    function makeIndexedGroup(
      label: string,
      count: number,
      textFn: (i: number) => string,
      setter: (key: number, value: number) => void,
    ): HTMLDivElement {
      const items: ToggleItem[] = [];
      for (let i = 0; i < count; i++) items.push({ key: i, text: textFn(i) });
      return makeToggleGroup(label, items, (item, active) => setter(item.key, active ? 1 : 0));
    }

    channelVisPanel.appendChild(makeIndexedGroup(
      "Bitplanes", 8,
      i => String(i + 1),
      (i, v) => M._wasm_set_bitplane_enabled(i, v),
    ));
    channelVisPanel.appendChild(makeIndexedGroup(
      "Sprites", 8,
      i => String(i),
      (i, v) => M._wasm_set_sprite_enabled(i, v),
    ));
    channelVisPanel.appendChild(makeIndexedGroup(
      "Audio", 4,
      i => String(i),
      (i, v) => M._wasm_set_audio_channel_enabled(i, v),
    ));
    // Single channel, unlike the indexed groups above — one toggle square.
    channelVisPanel.appendChild(makeToggleGroup(
      "Blitter", [{ key: 0, text: "BLT" }],
      (_item, active) => M._wasm_set_blitter_enabled(active ? 1 : 0),
    ));
  }

  // Blit-region highlight toggle (#blit-vis, optional). The highlight itself is
  // rendered C-side (pixel-accurate tint blended into the framebuffer); here we
  // just flip tracking on/off. Force a redraw while paused so the change (in
  // particular clearing the tint on disable) shows immediately.
  const blitVisBtn = document.getElementById("blit-vis");
  const blitDecayRow = document.getElementById("blit-decay-row");
  const blitDecaySlider = document.getElementById("blit-decay") as HTMLInputElement | null;
  const blitDecayVal = document.getElementById("blit-decay-val");
  if (blitVisBtn) {
    blitVisBtn.addEventListener("click", () => {
      blitTrackingEnabled = !blitTrackingEnabled;
      blitVisBtn.classList.toggle("active", blitTrackingEnabled);
      blitDecayRow?.classList.toggle("disabled", !blitTrackingEnabled);
      M._wasm_blit_tracking_enable(blitTrackingEnabled ? 1 : 0);
      if (M._wasm_is_paused()) M._wasm_redraw_frame();
    });
  }
  // Decay slider: how many frames a blit stays highlighted (C-side fade).
  if (blitDecaySlider) {
    const applyDecay = (): void => {
      const frames = parseInt(blitDecaySlider.value, 10);
      M._wasm_blit_set_decay(frames);
      if (blitDecayVal) blitDecayVal.textContent = `${frames}f`;
      if (blitTrackingEnabled && M._wasm_is_paused()) M._wasm_redraw_frame();
    };
    blitDecaySlider.addEventListener("input", applyDecay);
    applyDecay(); // push the initial value to wasm
  }

  // Per-frame tag update: stamps the chip-RAM words the blitter wrote this frame
  // so the NEXT frame's render can highlight the pixels that read them. The
  // highlight is blended into the framebuffer C-side, so there is nothing to
  // draw here.
  function updateBlitVis(): void {
    M._wasm_blit_vis_update();
  }

  // Set up the audio graph now — this doesn't itself need a user gesture.
  // No "enable audio" button needed: the unlock listeners registered above
  // (via audioCtx.onstatechange) resume playback on the first click/keypress.
  startAudio().catch(e => console.error("[audio] init failed", e));

  function frame(ts: number): void {
    if (lastTs === null) { lastTs = ts; fpsTime = ts; }

    // Force warp mode while a non-fastLoad boot is still waiting for the program to
    // start (see bootWarpActive's declaration) — apply the mute/button-highlight side
    // effects only on the false->true/true->false transition, not every frame.
    const shouldBootWarp = usesDh0 && !attached;
    if (shouldBootWarp !== bootWarpActive) {
      bootWarpActive = shouldBootWarp;
      updateWarpButtonUI();
      applyAudioMute();
    }
    const effectiveWarp = warpMode || bootWarpActive;
    if (effectiveWarp !== cycleExactDisabledForWarp) {
      cycleExactDisabledForWarp = effectiveWarp;
      M._wasm_set_cycle_exact(effectiveWarp ? 0 : 1);
    }

    // Diagnostic: did this tick-worker callback itself arrive late — i.e. was the
    // main thread busy elsewhere (GC, another webview task, VS Code's own UI
    // thread) between the previous frame() call and this one? Distinct from
    // frame() itself running long (checked near the end of this function, after
    // the tick/draw work) — this instead flags a stall that happened BEFORE
    // frame() even started. Skipped in warp mode, which intentionally uses most/
    // all of each callback's interval by design (see WARP_TICK_BUDGET_MS) —
    // logging there would just be noise. NOT skipped when bufferedPlaybackEnabled:
    // unlike warp, its producer branch below only eats extra budget while topping
    // the queue back up, not as standing behavior — so this staying live is exactly
    // what lets us see whether the underlying per-tick cost is still a problem while
    // buffered mode is masking it from the user (the whole reason it can mask it is
    // that the queue absorbs an occasional slow tick without ever visibly stalling).
    // Threshold is 150% of FRAME_BUDGET_MS to allow for ordinary timer jitter. See
    // flushOverrunLogIfDue's comment above for why this aggregates instead of
    // logging immediately.
    const callbackGapMs = ts - lastTs;
    if (!effectiveWarp && callbackGapMs > FRAME_BUDGET_MS * 1.5) {
      callbackGapOverruns++;
      if (callbackGapMs > callbackGapOverrunMaxMs) callbackGapOverrunMaxMs = callbackGapMs;
    }
    flushOverrunLogIfDue(ts);

    // Accumulate emulated time scaled by speedFactor, so changing speed
    // mid-session doesn't cause a discontinuous jump in dueFrames. Use the
    // AudioContext clock as the source while it's actually driving audio
    // (see lastAudioClockS above) so production can't drift from consumption;
    // otherwise fall back to the system clock.
    const useAudioClock = !!audioCtx && audioCtx.state === "running" && speedFactor === 1 && !effectiveWarp;
    // Recorded (not just added to emuClockMs) so jitterMultiTickCallbacks below can report
    // which clock source and how large a delta was actually behind a flagged event, rather
    // than just how many ticks it produced — see that diagnostic's own comment for why.
    let emuClockDeltaMs: number;
    if (useAudioClock) {
      const audioNowS = audioCtx!.currentTime;
      if (lastAudioClockS === null) lastAudioClockS = audioNowS; // avoid a jump when (re-)entering this mode
      emuClockDeltaMs = (audioNowS - lastAudioClockS) * 1000;
      emuClockMs += emuClockDeltaMs;
      lastAudioClockS = audioNowS;
    } else {
      emuClockDeltaMs = (ts - lastTs) * speedFactor;
      emuClockMs += emuClockDeltaMs;
      lastAudioClockS = null; // re-sync without a jump next time we enter audio-clock mode
    }
    lastTs = ts;

    // How many PAL frames should have elapsed (in emulated time) so far?
    let dueFrames = Math.floor(emuClockMs * PAL_FPS / 1000);
    // Drop backlog beyond MAX_CATCHUP_FRAMES instead of letting the catch-up loop below try to
    // replay it — see MAX_CATCHUP_FRAMES' comment. Pulls emuClockMs forward to match so this
    // dropped time doesn't resurface as backlog again on the next call.
    if (dueFrames - emuFrames > MAX_CATCHUP_FRAMES) {
      dueFrames = emuFrames + MAX_CATCHUP_FRAMES;
      emuClockMs = dueFrames * 1000 / PAL_FPS;
    }
    const wasPaused = M._wasm_is_paused();
    if (wasPaused && !wasPausedPrev) {
      M._wasm_dma_tracking_enable(1);
      M._wasm_copper_tracking_enable(1);
    } else if (!wasPaused && wasPausedPrev) {
      // Just resumed: fpsCnt/fpsTime's window (below) would otherwise still include
      // however long the debugger sat paused with zero ticks running, understating
      // achieved fps for one bogus window right after any breakpoint/step/pause —
      // restart the window here instead of carrying that stall into a real measurement.
      fpsCnt = 0;
      fpsTime = ts;
    }
    wasPausedPrev = wasPaused;
    const fbFrameCount = M._wasm_get_frame_count();
    const fbDirty = fbFrameCount !== lastFbFrameCount;

    if (wasPaused) {
      // Don't try to "catch up" once resumed.
      emuFrames = dueFrames;
      // The framebuffer doesn't normally change while paused, so only draw
      // once — e.g. right after fastLoad injection pauses the CPU before
      // stopOnEntry, so the canvas isn't left blank for the whole time the
      // debugger is stopped. But if a reverse-stepping command (stepBack/
      // continueReverse/stepBackFrame) landed on a different point in time,
      // its replay re-renders the framebuffer (fbDirty) and we must redraw.
      if (hasDrawnFrame && !fbDirty) return;
    } else if (!effectiveWarp && !bufferedPlaybackEnabled && dueFrames <= emuFrames) {
      return; // display is faster than 50 Hz — nothing to do yet
    }

    const tTickStart = performance.now();
    let hitBreakpoint = false;
    let ranCount = 0;
    if (wasPaused) {
      // no ticks to run
    } else if (effectiveWarp) {
      // Run flat-out for a time budget, ignoring speedFactor/dueFrames.
      while (performance.now() - tTickStart < WARP_TICK_BUDGET_MS) {
        M._wasm_tick();
        ranCount++;
        if (M._wasm_is_paused()) { hitBreakpoint = true; break; }
      }
    } else if (bufferedPlaybackEnabled) {
      // Run flat-out like warp, but capped by the video queue's free space instead
      // of a bare time budget — production races ahead of dueFrames up to
      // videoQueueCapacity frames, then waits here for the consumer (frame()'s draw
      // section below) to free a slot on a later callback. Captures EVERY tick's
      // frame (enqueueVideoFrame), not just whichever one is current when the loop
      // ends like the warp/normal branches do — that's what lets a later slow-tick
      // burst draw from already-computed frames instead of stalling on one.
      while (vqCount < videoQueueCapacity &&
             performance.now() - tTickStart < WARP_TICK_BUDGET_MS) {
        M._wasm_tick();
        ranCount++;
        if (M._wasm_is_paused()) { hitBreakpoint = true; break; }
        enqueueVideoFrame();
      }
    } else {
      // Run ticks until caught up to dueFrames, within a time budget. A flat
      // cap on ticks-per-callback (the previous approach) limits how fast a
      // frame debt incurred during a main-thread stall can be paid back —
      // any stall longer than the cap permanently shrinks the audio cushion
      // until the worklet's ring buffer underruns (the dominant cause of
      // jittery/crackly audio). Budgeting by time instead lets a single
      // callback fully repay an arbitrarily large debt, at the cost of an
      // occasional dropped video frame while catching up, which is
      // imperceptible.
      //
      // catchUpLimit (not dueFrames directly): see JITTER_TOLERANT_BACKLOG_FRAMES —
      // a small backlog only ever runs one tick this callback regardless of how
      // many are nominally "due", so ordinary timer/clock jitter can't force an
      // immediate back-to-back multi-tick catch-up; a genuinely larger backlog
      // still catches up in full, same as always.
      const backlog = dueFrames - emuFrames;
      const catchUpLimit = backlog <= JITTER_TOLERANT_BACKLOG_FRAMES ? emuFrames + 1 : dueFrames;
      while (emuFrames + ranCount < catchUpLimit &&
             performance.now() - tTickStart < WARP_TICK_BUDGET_MS) {
        M._wasm_tick();
        ranCount++;
        if (M._wasm_is_paused()) { hitBreakpoint = true; break; }
      }
    }
    const tTickEnd = performance.now();
    // See jitterMultiTickCallbacks's declaration above. callbackGapMs was computed
    // earlier in this same call, before the tick loop ran.
    if (!effectiveWarp && !bufferedPlaybackEnabled && ranCount > 1 && callbackGapMs <= FRAME_BUDGET_MS * 1.5) {
      jitterMultiTickCallbacks++;
      jitterMultiTickMaxRan = Math.max(jitterMultiTickMaxRan, ranCount);
    }
    emuFrames += ranCount;
    // Warp mode can run emuFrames ahead of the wall-clock schedule — pull
    // emuClockMs forward to match so playback doesn't "freeze" waiting for
    // real time to catch up once warp mode is turned off. Never moves
    // emuClockMs backward (normal-speed catch-up after falling behind still
    // works as before).
    emuClockMs = Math.max(emuClockMs, emuFrames * 1000 / PAL_FPS);

    // Periodic full-state checkpoint during a free-run, so stepBack/
    // continueReverse can rewind into the middle of a long `continue`, not
    // just back to its start (see rpc.ts's pushSnapshot). rpc is only
    // set inside the VS Code webview — debug.html has no RPC bridge.
    if (rpc && !wasPaused && ranCount > 0 && emuFrames - lastCheckpointFrame >= CHECKPOINT_INTERVAL_FRAMES) {
      lastCheckpointFrame = emuFrames;
      setTimeout(() => rpc!.pushSnapshot(), 0);
    }

    // [vscode-puae-debugger mem protect] Starts the AllocMem/FreeMem watch
    // as early as possible — well before tryExec's "user task started"
    // heuristic below, so Kickstart's own boot-time allocations (graphics.
    // library's default View/copper lists, etc.) get tracked too. The C side
    // validates execBase itself and no-ops until it's actually ready, so
    // it's safe to poll every frame; stop once it succeeds (calling it again
    // later would discard any AllocMem call currently in-flight).
    if (!memProtectTrackingStarted) {
      memProtectTrackingStarted = !!M._wasm_memprotect_start_tracking();
    }

    // Non-fastLoad (usesDh0) boot: poll for exec/graphics libraries being
    // ready, then arm the AllocMem breakpoint (tryExec) so the next hit can
    // be checked against getCurrentProcess() below.
    if (usesDh0 && !execReady) {
      const r = tryExec(M);
      if (r.ready) {
        execReady = true;
        allocMemAddr = r.allocMemAddr!;
        // [vscode-puae-debugger mem protect] GfxBase is confirmed set here
        // (tryExec/isExecReady checked it) — safe to walk the library list
        // now, unlike at the earlier raw-execBase tracking-start point above.
        M._wasm_memprotect_seed_libraries();
      }
    }

    if (hitBreakpoint) {
      if (usesDh0 && execReady && !attached) {
        // AllocMem breakpoint hit while waiting for our expectedProcessName CLI
        // process (s/startup-sequence) to start — check whether this is it yet.
        const proc = getCurrentProcess(M, expectedProcessName);
        if (proc) {
          M._wasm_remove_breakpoint(allocMemAddr);
          attached = true;
          log(`Attached to process "${proc.command}" (${proc.segments.length} segment(s))`);
          if (vscode) {
            vscode.postMessage({ type: "attached", segments: proc.segments });
          }
        } else {
          // Not our process yet (e.g. AmigaOS's own startup tasks) — keep
          // the breakpoint armed and resume.
          M._wasm_resume();
        }
      } else {
        log("BREAKPOINT HIT — emulator paused");
        if (onBreakpoint) onBreakpoint(M);

        // Tells the DAP adapter a breakpoint/watchpoint was hit during
        // continue, so it can send a StoppedEvent (handleStop,
        // debugAdapter.ts) — mirrors vAmiga_ui.js's handleStop.
        if (vscode) {
          vscode.postMessage({ type: "emulator-state", state: "stopped", message: getCurrentStopMessage(M) });
        }
      }
    }

    if (ranCount > 0) pushAccumToWorklet(); // push this tick's samples to the ring-buffer worklet

    // Buffered/smooth playback consumer: draw the OLDEST queued frame instead of the
    // live wasm framebuffer, decoupled from this callback's own tick timing — see the
    // producer branch above and MainConfig's bufferedPlaybackEnabled doc comment.
    // Flushed (discarding any queued video and the audio worklet's backlog) the
    // instant warp engages or the debugger pauses/hits a breakpoint, so buffered
    // content can never delay interactive feedback — but NOT just because the queue
    // hasn't finished priming yet (see bufferedPrimed's declaration): that's a normal,
    // temporary condition, not an interruption, and flushing on it would just re-empty
    // the queue every callback and prevent it from ever finishing.
    const bufferedInterrupted = bufferedPlaybackEnabled && (effectiveWarp || wasPaused || hitBreakpoint);
    if (bufferedInterrupted && vqCount > 0) flushBuffered();
    const effectiveBuffered = bufferedPlaybackEnabled && !effectiveWarp && !wasPaused && !hitBreakpoint && bufferedPrimed;

    const tGpuStart = performance.now();
    if (effectiveBuffered) {
      const slot = dequeueVideoFrame();
      // null in principle means a burst deep enough to drain the already-primed queue
      // entirely (startup ramp-up is handled separately, by bufferedPrimed gating
      // effectiveBuffered above) — in practice this shouldn't happen: the producer
      // above always completes at least one tick per callback (even a slow one) before
      // its own time budget can stop it, so production can't actually fall behind
      // consumption's fixed one-frame-per-callback rate. Left as a defensive no-op
      // (skip the draw, canvas keeps its last frame) rather than assumed impossible.
      if (slot) uploadAndDraw(slot.data, slot.w, slot.h);
    } else {
      const w = M._wasm_get_fb_width();
      const h = M._wasm_get_fb_height();
      if (!w || !h) return;
      uploadAndDraw(getFbView(M._wasm_get_fb_rgba(), w * h * 4), w, h);
    }
    if (blitTrackingEnabled) updateBlitVis();
    const tGpuEnd = performance.now();
    // Re-read rather than reuse fbFrameCount (captured before this frame()
    // call's own tick loop, if any) so the comparison next time is accurate.
    lastFbFrameCount = M._wasm_get_frame_count();

    // Diagnostic: how long did frame() itself take this callback (tick loop +
    // breakpoint/attach handling + GPU upload/draw + bookkeeping above)? Distinct
    // from the callback-gap check above (which flags a stall BEFORE frame()
    // started) — this instead flags frame()'s own work eating into (or past) the
    // next callback's budget, which is what actually causes a skipped/late tick.
    // Skipped in warp mode, same reasoning as the callback-gap check. NOT skipped
    // for bufferedPlaybackEnabled (see that check's own comment for why), nor while
    // catching up a backlog (ranCount > 1) — that's a real, useful signal ("overran
    // while paying back frames dropped during an earlier stall"), not noise to
    // suppress.
    const frameWallMs = performance.now() - ts;
    if (!effectiveWarp && frameWallMs > FRAME_BUDGET_MS) {
      frameOverruns++;
      if (frameWallMs > frameOverrunMaxMs) frameOverrunMaxMs = frameWallMs;
      frameOverrunWasmSumMs += tTickEnd - tTickStart;
      frameOverrunGpuSumMs += tGpuEnd - tGpuStart;
      frameOverrunTicksSum += ranCount;
    }
    flushOverrunLogIfDue(ts);

    if (ranCount > 0) {
      fpsCnt += ranCount;
      if (ts - fpsTime >= 1000) {
        const fps = fpsCnt * 1000 / (ts - fpsTime);
        const msWasm = ((tTickEnd - tTickStart) / ranCount).toFixed(1);
        const msGpu = (tGpuEnd - tGpuStart).toFixed(1);
        if (status) status.textContent = `${fps.toFixed(1)} fps | wasm=${msWasm}ms gpu=${msGpu}ms`;
        // Diagnostic: is the emulator actually falling behind real time in aggregate —
        // producing fewer than PAL_FPS ticks per real second — regardless of whether any
        // single tick/callback looked fine on its own? Distinct from the overrun checks
        // above (which flag individual slow ticks/callbacks): a system that's only
        // slightly slow on average could still pass those, and — this is the case that
        // actually motivated adding this — bufferedPlaybackEnabled's queue can keep every
        // individual callback looking clean by design while still not producing PAL_FPS
        // worth of frames per second overall, if the underlying per-tick cost is
        // consistently (not just occasionally) too high for the queue to keep pulling
        // ahead. Skipped in warp mode, which is expected to run faster OR slower than
        // PAL_FPS by design, not a "falling behind" signal there. ~5% tolerance for
        // ordinary timer jitter; already a once/sec figure, no further aggregation needed.
        if (!effectiveWarp && vscode && fps < PAL_FPS * 0.95) {
          vscode.postMessage({ type: "perf-fps", fps, targetFps: PAL_FPS });
        }
        fpsCnt = 0;
        fpsTime = ts;
      }
    }
  }

  // Drive frame() from a Worker timer instead of requestAnimationFrame:
  // rAF is throttled to ~1Hz (or suspended entirely) when the webview tab
  // isn't visible, which would pause emulation whenever the user switches to
  // another VS Code panel. A dedicated Worker's setInterval keeps ticking at
  // a steady rate regardless of tab visibility (mirrors vAmiga_ui.js's
  // initEmulationWorker). frame()'s due-frames accounting already works off
  // wall-clock timestamps, so it doesn't care that ticks now come from a
  // timer instead of the display's refresh rate — tying the tick rate to
  // PAL_FPS just means one tick is due per call in the steady state.
  startTickWorker(frame, FRAME_BUDGET_MS);
}
