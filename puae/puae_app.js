// Shared boot/render-loop logic for the PUAE wasm backend, used by both
// index.html (the clean webview UI) and debug.html (manual test/debug UI).
// Anything that touches the debug-only DOM (#debug, #debugG1, #debugG2 etc.)
// lives in debug.html instead — main() only assumes #screen exists;
// #status is optional (used for boot/fps diagnostics if present).

import { setupRpcDispatcher, getCurrentStopMessage, WARM_UP_TICKS } from './puae_rpc.js';

// The Amiga's PAL frame rate — both the render loop's due-frames accounting
// and its driving tick-worker interval are derived from this.
const PAL_FPS = 50;

// Register names: D0-D7, A0-A7, SR, PC — order matches e9k_debug_read_regs().
export const REG_NAMES = [
  'D0','D1','D2','D3','D4','D5','D6','D7',
  'A0','A1','A2','A3','A4','A5','A6','A7(SP)',
  'SR','PC'
];

async function fetchBytes(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch ${url} → ${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer());
}

// Starts a Worker whose only job is to call back at a steady interval, even
// when the page is in a hidden/background tab (where requestAnimationFrame
// and main-thread setInterval/setTimeout get throttled). Built from an
// inline blob so it works under the webview's CSP without a separate file.
function startTickWorker(onTick, intervalMs) {
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
  const blob = new Blob([workerScript], { type: 'application/javascript' });
  const worker = new Worker(URL.createObjectURL(blob));
  worker.onmessage = (event) => onTick(event.data);
  worker.postMessage({ command: 'start', intervalMs });
  return worker;
}

// createPuaeModule is a global set by puae.js (Emscripten MODULARIZE=1 UMD output)
export async function main(config = {}) {
  const {
    wasmLocateFile,
    romUrl = './kick34005.A500',
    extraConfigB64 = '',
    audioWorkletUrl = './puae_audioprocessor.js',
    // Called once with the wasm module after boot+warm-up, before the RPC
    // bridge is wired up — debug.html uses this to install its debug UI.
    onModuleReady,
    // Called with the wasm module whenever the render loop's free-run hits a
    // breakpoint/watchpoint — debug.html uses this to refresh its register/
    // disassembly/callstack views.
    onBreakpoint,
  } = config;

  // Hoisted so the render loop's frame() (defined later in this scope) can
  // post 'stopped' emulator-state messages on a breakpoint/watchpoint hit
  // during free-run — only set inside the VS Code webview, see below.
  let vscode;

  // #status is optional — index.html (the panel view) omits it; debug.html
  // keeps it for boot/fps diagnostics.
  const status = document.getElementById('status');
  function log(msg) {
    console.log(msg);
    if (status) status.textContent = msg;
  }

  log('Initialising wasm module…');
  const M = await createPuaeModule(wasmLocateFile ? { locateFile: wasmLocateFile } : undefined);
  log('Module ready — fetching ROM…');

  // Write Kickstart ROM into the virtual filesystem.
  const romData = await fetchBytes(romUrl);
  M.FS.mkdir('/uae_system');
  M.FS.writeFile('/uae_system/kick34005.A500', romData);
  log(`ROM: ${romData.length} bytes → /uae_system/kick34005.A500`);

  // Extra PUAE config (.uae key=value lines), built by
  // PuaeEmulator.getHtmlForWebview from OpenOptions.configFilePath,
  // chipRam/slowRam/fastRam/cpuRevision and emulatorOptions.puae. Empty by
  // default — retro_create_config() only reads this file if it exists.
  if (extraConfigB64) {
    const extraConfig = atob(extraConfigB64);
    M.FS.writeFile('/uae_system/puae_libretro_global.uae', extraConfig);
    log(`Config: ${extraConfig.length} bytes → /uae_system/puae_libretro_global.uae`);
  }

  // Boot the core with no disk inserted. fastLoad injects a standalone
  // program directly into memory once Kickstart has booted far enough to
  // allocate it (see the warm-up below) — there's no DOS process to load
  // a disk-based program from, and a disk would only race fastLoad's memory
  // injection with the disk's own boot code.
  const wasm_boot = M.cwrap('wasm_boot', 'number', ['string']);
  log('Calling wasm_boot…');
  const ok = wasm_boot('');
  if (!ok) { log('wasm_boot FAILED — check console'); return; }

  // Warm-up: run enough frames for Kickstart to clear the CIA-A OVL bit
  // (chip-RAM writes via e9k_debug_write_memory don't persist before this —
  // proven to need ~150 ticks, see puae-wasm/test_g1.mjs) and for
  // exec.library to finish initialising its memory-list allocator (needed
  // by AmigaMemoryMapper for fastLoad program injection). WARM_UP_TICKS
  // (200) gives margin over the 150-tick threshold. This redefines
  // `exec-ready` for PUAE from "wasm module + RPC bridge ready" to "AmigaOS
  // booted enough for fastLoad memory injection" — the PUAE equivalent of
  // VAmiga's pre-booted-snapshot fastLoad path. puae_rpc.js's "load" command
  // re-runs this same warm-up after a wasm_reset() to reuse this module +
  // webview for a new debug session.
  log(`Warming up (${WARM_UP_TICKS} frames)…`);
  for (let i = 0; i < WARM_UP_TICKS; i++) M._wasm_tick();

  // -------- audio setup --------
  let workletNode = null;
  let audioCtx = null;

  // Browsers' autoplay policy suspends new AudioContexts until a user
  // gesture. Resume on the first click/keypress in the panel, and re-arm
  // these listeners (via audioCtx.onstatechange, set in startAudio) if the
  // context ever drops out of 'running' again (e.g. after the webview tab
  // is hidden) — mirrors vAmiga_ui.js's add/remove_unlock_user_action.
  const resumeAudio = () => audioCtx?.resume();
  function addUnlockListeners() {
    document.addEventListener('pointerdown', resumeAudio);
    document.addEventListener('keydown', resumeAudio);
  }
  function removeUnlockListeners() {
    document.removeEventListener('pointerdown', resumeAudio);
    document.removeEventListener('keydown', resumeAudio);
  }

  // PUAE always outputs at 44100 Hz; AudioContext may be at a different rate (e.g. 48000).
  // Resample each chunk with linear interpolation so the worklet's ring buffer
  // stays balanced — without this, a 48000 Hz context drains 960 samples per 20ms
  // while we only push 882, emptying the buffer every cycle.
  let audioPuaeRate  = 44100;
  let audioCtxRate   = 44100;

  function resampleChunk(srcL, srcR, srcN) {
    const dstN = Math.round(srcN * audioCtxRate / audioPuaeRate);
    if (dstN === srcN) { return { l: srcL.slice(), r: srcR.slice() }; }
    const l = new Float32Array(dstN);
    const r = new Float32Array(dstN);
    const scale = (srcN - 1) / Math.max(dstN - 1, 1);
    for (let i = 0; i < dstN; i++) {
      const pos  = i * scale;
      const idx  = pos | 0;
      const frac = pos - idx;
      const idx2 = idx + 1 < srcN ? idx + 1 : idx;
      l[i] = srcL[idx] + frac * (srcL[idx2] - srcL[idx]);
      r[i] = srcR[idx] + frac * (srcR[idx2] - srcR[idx]);
    }
    return { l, r };
  }

  let _pushCount = 0;
  function pushAccumToWorklet() {
    if (!workletNode) return;
    const n = M._wasm_get_audio_accum_count();
    if (_pushCount < 5) console.log('[audio] push #' + _pushCount + ': n=' + n);
    _pushCount++;
    if (n <= 0) return;
    const ptrL = M._wasm_get_audio_accum_L();
    const ptrR = M._wasm_get_audio_accum_R();
    // Views into wasm memory — read before resetting accumulator.
    const rawL = new Float32Array(M.HEAPF32.buffer, ptrL, n);
    const rawR = new Float32Array(M.HEAPF32.buffer, ptrR, n);
    const { l, r } = resampleChunk(rawL, rawR, n);
    M._wasm_reset_audio_accum();
    workletNode.port.postMessage({ l, r }, [l.buffer, r.buffer]);
  }

  async function startAudio() {
    // Discard any audio that built up before now — we don't want to hear a
    // burst of old audio when the worklet starts.
    M._wasm_reset_audio_accum();

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtxRate = audioCtx.sampleRate;
    console.log('[audio] sampleRate=' + audioCtxRate + ' (PUAE=' + audioPuaeRate + ')' +
                (audioCtxRate !== audioPuaeRate ? ' — resampling active' : ' — pass-through'));

    // Re-arm (or clear) the unlock listeners whenever the context's running
    // state changes — e.g. autoplay-suspended at creation, or re-suspended
    // after the webview tab is hidden.
    audioCtx.onstatechange = () => {
      if (audioCtx.state === 'running') removeUnlockListeners();
      else addUnlockListeners();
    };
    if (audioCtx.state !== 'running') addUnlockListeners();
    await audioCtx.audioWorklet.addModule(audioWorkletUrl);
    workletNode = new AudioWorkletNode(audioCtx, 'puae-audio-processor', {
      outputChannelCount: [2], numberOfInputs: 0, numberOfOutputs: 1
    });
    const gain = audioCtx.createGain();
    gain.gain.value = 0.5;
    workletNode.connect(gain);
    gain.connect(audioCtx.destination);

    workletNode.port.onmessage = ({ data }) => {
      if (data && data.type === 'diag') {
        console.log('[worklet] fill=' + data.count + '/' + data.cap +
                    ' (' + (data.count * 100 / data.cap | 0) + '%)' +
                    ' proc#' + data.proc);
      }
    };

    // Pre-fill the ring buffer with ~60ms of audio before the worklet starts
    // draining it, so initial message-delivery latency doesn't cause underruns.
    for (let i = 0; i < 3; i++) M._wasm_tick();
    emuFrames += 3;
    pushAccumToWorklet();
  }
  // -------------------------------------------------------

  if (onModuleReady) onModuleReady(M);

  // RPC bridge (Stage G3) — only present inside the VS Code webview.
  if (typeof acquireVsCodeApi === 'function') {
    vscode = acquireVsCodeApi();
    const rpc = setupRpcDispatcher(M, (msg) => vscode.postMessage(msg));
    window.addEventListener('message', (event) => rpc.handleMessage(event.data));
    // Tells PuaeEmulator the wasm module is ready, so it can fetch and cache
    // getMemoryInfo() — mirrors VAmiga's webview-ready handshake.
    vscode.postMessage({ type: 'exec-ready' });
  }

  log('Boot OK — starting render loop');

  // ---------- render loop ----------
  const canvas = document.getElementById('screen');
  const ctx    = canvas.getContext('2d');

  // Drive at exactly 50 Hz PAL using a cumulative due-frames counter so the tick
  // fires at the right wall-clock time regardless of the display refresh rate.
  let emuFrames = 0;  // total emulation frames run so far
  let startTs   = null;
  let frames    = 0;
  let fpsTime   = 0;
  let fpsCnt    = 0;
  let imgData   = null; // cached ImageData — owns its own ArrayBuffer

  // Set up the audio graph now — this doesn't itself need a user gesture.
  // No "enable audio" button needed: the unlock listeners registered above
  // (via audioCtx.onstatechange) resume playback on the first click/keypress.
  startAudio().catch(e => console.error('[audio] init failed', e));

  function frame(ts) {
    if (startTs === null) { startTs = ts; fpsTime = ts; }

    // How many PAL frames should have elapsed since we started?
    const dueFrames = Math.floor((ts - startTs) * PAL_FPS / 1000);
    const wasPaused = M._wasm_is_paused();

    if (wasPaused) {
      // Don't try to "catch up" once resumed.
      emuFrames = dueFrames;
      // The framebuffer doesn't change while paused, so only draw once — e.g.
      // right after fastLoad injection pauses the CPU before stopOnEntry, so
      // the canvas isn't left blank for the whole time the debugger is stopped.
      if (imgData) return;
    } else {
      if (dueFrames <= emuFrames) return; // display is faster than 50 Hz — nothing to do yet
    }

    // Run ticks to catch up (cap at 2 to avoid spiral-of-death if we fall behind).
    const toRun = wasPaused ? 0 : Math.min(dueFrames - emuFrames, 2);

    const tTickStart = performance.now();
    let hitBreakpoint = false;
    for (let i = 0; i < toRun; i++) {
      M._wasm_tick();
      if (M._wasm_is_paused()) { hitBreakpoint = true; break; }
    }
    const tTickEnd = performance.now();
    emuFrames += toRun;

    if (hitBreakpoint) {
      log('BREAKPOINT HIT — emulator paused');
      const n = M._wasm_read_regs();
      const ptr = M._wasm_get_reg_buf();
      const buf = new Uint32Array(M.HEAPU32.buffer, ptr, n);
      const pcHex = n >= 18 ? '0x' + buf[17].toString(16).toUpperCase() : '?';
      console.log('[debug] halt at PC=' + pcHex);

      if (onBreakpoint) onBreakpoint(M);

      // Tells the DAP adapter a breakpoint/watchpoint was hit during
      // continue, so it can send a StoppedEvent (handleStop,
      // vAmigaDebugAdapter.ts) — mirrors vAmiga_ui.js's handleStop.
      if (vscode) {
        vscode.postMessage({ type: 'emulator-state', state: 'stopped', message: getCurrentStopMessage(M) });
      }
    }

    if (toRun > 0) pushAccumToWorklet(); // push this tick's samples to the ring-buffer worklet

    const w = M._wasm_get_fb_width();
    const h = M._wasm_get_fb_height();
    if (!w || !h) return;

    // Resize canvas if the core reported a new geometry.
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width  = w;
      canvas.height = h;
      imgData = null; // invalidate cached ImageData on resize
    }

    // Chrome 117+ rejects new ImageData(wasmBackedView, w, h) with a TypeError,
    // so we own the ImageData's buffer and copy from wasm memory each frame.
    if (!imgData) imgData = ctx.createImageData(w, h);
    const ptr = M._wasm_get_fb_rgba();
    const tSetStart = performance.now();
    imgData.data.set(new Uint8ClampedArray(M.HEAPU8.buffer, ptr, w * h * 4));
    const tBlitStart = performance.now();
    ctx.putImageData(imgData, 0, 0);
    const tBlitEnd = performance.now();

    if (toRun > 0) {
      frames += toRun;
      fpsCnt += toRun;
      if (ts - fpsTime >= 1000) {
        const fps    = (fpsCnt * 1000 / (ts - fpsTime)).toFixed(1);
        const msWasm = ((tTickEnd - tTickStart) / toRun).toFixed(1);
        const msSet  = (tBlitStart - tSetStart ).toFixed(1);
        const msBlit = (tBlitEnd   - tBlitStart).toFixed(1);
        if (status) status.textContent = `${fps} fps | wasm=${msWasm}ms set=${msSet}ms blit=${msBlit}ms`;
        fpsCnt  = 0;
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
  startTickWorker(frame, 1000 / PAL_FPS);
}
