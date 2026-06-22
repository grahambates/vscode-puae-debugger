// Shared boot/render-loop logic for the PUAE wasm backend, used by both
// index.html (the clean webview UI) and debug.html (manual test/debug UI).
// Anything that touches the debug-only DOM (#debug, #debugG1, #debugG2 etc.)
// lives in debug.html instead — main() only assumes #screen exists;
// #status is optional (used for boot/fps diagnostics if present).

import { setupRpcDispatcher, getCurrentStopMessage, tryExec, getCurrentProcess, isExecReady } from './puae_rpc.js';

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

// In warp mode, run as many ticks as fit in this time budget per tick-worker
// callback (which itself fires every 1000/PAL_FPS ms), leaving headroom in
// each callback for rendering/audio/RPC handling.
const WARP_TICK_BUDGET_MS = 15;

// How often to take a periodic full-state checkpoint (rpc.pushSnapshot())
// during a free-run, for stepBack/continueReverse — one per second of
// emulated time. Rounded; doesn't need PAL_FPS's precision.
const CHECKPOINT_INTERVAL_FRAMES = Math.round(PAL_FPS);

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
  // Use the main thread's performance.now() rather than the Worker's timestamp.
  // When VS Code delays the main thread, Worker messages queue up with stale
  // Worker-clock timestamps 20ms apart; processing them with those timestamps
  // causes back-to-back ticks (burst renders). Using the main-thread clock
  // means queued messages all see nearly the same real time, so the dueFrames
  // guard skips duplicates instead of firing them all.
  worker.onmessage = () => onTick(performance.now());
  worker.postMessage({ command: 'start', intervalMs });
  return worker;
}

// createPuaeModule is a global set by puae.js (Emscripten MODULARIZE=1 UMD output)
export async function main(config = {}) {
  const {
    wasmLocateFile,
    romUrl = './kick34005.A500',
    extraConfigB64 = '',
    programB64 = '',
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
  // Hoisted alongside vscode so frame() can take periodic checkpoints via
  // rpc.pushSnapshot() — also only set inside the VS Code webview.
  let rpc;

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

  M.FS.mkdir('/uae_system');
  // Write Kickstart ROM into the virtual filesystem.
  // When romUrl is empty, skip this — frontend_shim detects the missing file
  // and tells PUAE to use its built-in AROS ROM instead.
  if (romUrl) {
    const romData = await fetchBytes(romUrl);
    M.FS.writeFile('/uae_system/kick34005.A500', romData);
    log(`ROM: ${romData.length} bytes → /uae_system/kick34005.A500`);
  } else {
    log('No ROM provided — using built-in AROS ROM');
  }

  // Extra PUAE config (.uae key=value lines), built by
  // PuaeEmulator.getHtmlForWebview from OpenOptions.configFilePath,
  // chipRam/slowRam/fastRam/cpuRevision and emulatorOptions.puae. Empty by
  // default — retro_create_config() only reads this file if it exists.
  if (extraConfigB64) {
    const extraConfig = atob(extraConfigB64);
    M.FS.writeFile('/uae_system/puae_libretro_global.uae', extraConfig);
    log(`Config: ${extraConfig.length} bytes → /uae_system/puae_libretro_global.uae`);
  }

  // Non-fastLoad program (OpenOptions.programPath): write it + a minimal
  // startup-sequence into a MEMFS directory that the "filesystem=rw,dh0:..."
  // line above (buildExtraConfig) mounts as a bootable DH0: hard disk.
  // AmigaOS's uaehf.device autoconfigures this — no ADF/bootblock/OFS image
  // needed. The render loop below polls for the resulting CLI process.
  if (programB64) {
    const programData = Uint8Array.from(atob(programB64), c => c.charCodeAt(0));
    M.FS.mkdir('/uae_system/dh0');
    M.FS.writeFile('/uae_system/dh0/file', programData);
    M.FS.mkdir('/uae_system/dh0/s');
    M.FS.writeFile('/uae_system/dh0/s/startup-sequence', 'file');
    log(`Program: ${programData.length} bytes → /uae_system/dh0/file`);
  }

  // Boot the core with no disk inserted. fastLoad injects a standalone
  // program directly into memory once Kickstart has booted far enough to
  // allocate it (see the warm-up below) — there's no DOS process to load
  // a disk-based program from, and a disk would only race fastLoad's memory
  // injection with the disk's own boot code. Non-fastLoad programs (above)
  // are loaded via DH0:, not a disk image, so this is still '' either way.
  const wasm_boot = M.cwrap('wasm_boot', 'number', ['string']);
  log('Calling wasm_boot…');
  const ok = wasm_boot('');
  if (!ok) { log('wasm_boot FAILED — check console'); return; }

  if (!programB64) {
    // Warm-up: tick until AmigaOS is ready for fastLoad memory injection —
    // mirrors vAmiga_ui.js's tryExec condition (AllocMem LVO is jmp, GfxBase
    // set, CPU out of supervisor mode). 1000 ticks is a generous safety
    // ceiling. Kickstart needs ~150 ticks to clear CIA-A OVL and initialise
    // exec.library's allocator (see puae-wasm/test_g1.mjs). Stopping exactly
    // when ready is faster and more robust than a fixed count.
    //
    // For non-fastLoad (programB64 set), this warm-up is skipped — the render
    // loop runs from frame 0 so tryExec/getCurrentProcess polling (below) can
    // observe AmigaOS booting from DH0: and running the startup-sequence.
    log('Waiting for exec.library to initialise…');
    for (let i = 0; !isExecReady(M) && i < 1000; i++) M._wasm_tick();
    // Start the memory-protection AllocMem/FreeMem watch now, independent of
    // whether enforcement is ever enabled — see ami_debug.c's
    // e9k_debug_memprotect_start_tracking.
    M._wasm_memprotect_start_tracking();
  }

  // -------- audio setup --------
  let workletNode = null;
  let audioCtx = null;
  let gain = null; // hoisted so the speed/warp controls can mute audio
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
  let audioPuaeRate  = 44100;
  let audioCtxRate   = 44100;
  let audioResampleFrac = 0;            // fractional distance past audioPrevL/R, in [0,1)
  let audioPrevL = 0, audioPrevR = 0;   // last source sample of the previous chunk

  function resetResampler() {
    audioResampleFrac = 0;
    audioPrevL = 0;
    audioPrevR = 0;
  }

  function resampleChunk(srcL, srcR, srcN) {
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

  function pushAccumToWorklet() {
    if (!workletNode) return;
    const n = M._wasm_get_audio_accum_count();
    if (n <= 0) return;
    if (audioCtx.state !== 'running') {
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

  async function startAudio() {
    // Discard any audio that built up before now — we don't want to hear a
    // burst of old audio when the worklet starts.
    M._wasm_reset_audio_accum();

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtxRate = audioCtx.sampleRate;
    console.log('[audio] sampleRate=' + audioCtxRate + ' (PUAE=' + audioPuaeRate + ')' +
                (audioCtxRate !== audioPuaeRate ? ' — resampling active' : ' — pass-through'));

    // If the context gets re-suspended (e.g. tab hidden), resume it
    // automatically when the user next clicks the audio button — no blanket
    // document listeners needed since the button is the explicit gesture.
    let audioWasRunning = audioCtx.state === 'running';
    audioCtx.onstatechange = () => {
      const running = audioCtx.state === 'running';
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
      }
      audioWasRunning = running;
      if (!running && !audioMuted) audioCtx.resume();
    };
    await audioCtx.audioWorklet.addModule(audioWorkletUrl);
    workletNode = new AudioWorkletNode(audioCtx, 'puae-audio-processor', {
      outputChannelCount: [2], numberOfInputs: 0, numberOfOutputs: 1
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

  // RPC bridge (Stage G3) — only present inside the VS Code webview.
  if (typeof acquireVsCodeApi === 'function') {
    vscode = acquireVsCodeApi();
    rpc = setupRpcDispatcher(M, (msg) => vscode.postMessage(msg));
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
  let lastAudioClockS = null;
  let lastCheckpointFrame = 0; // emuFrames at the last periodic rpc.pushSnapshot()
  let frames    = 0;
  let fpsTime   = 0;
  let fpsCnt    = 0;
  let imgData   = null; // cached ImageData — owns its own ArrayBuffer
  // wasm_get_frame_count() as of the last canvas redraw — lets us notice the
  // framebuffer changed while paused (e.g. stepBack/continueReverse/
  // stepBackFrame's landing replay renders a frame via
  // wasm_replay_instructions_video) and redraw even though emulation isn't
  // advancing.
  let lastFbFrameCount = -1;

  // Called by puae_rpc.js's async continueReverse to paint the current wasm
  // framebuffer to the canvas between checkpoint intervals.
  globalThis.drawCurrentFrame = () => {
    const w = M._wasm_get_fb_width();
    const h = M._wasm_get_fb_height();
    if (!w || !h) return;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h; imgData = null;
    }
    if (!imgData) imgData = ctx.createImageData(w, h);
    imgData.data.set(new Uint8ClampedArray(M.HEAPU8.buffer, M._wasm_get_fb_rgba(), w * h * 4));
    ctx.putImageData(imgData, 0, 0);
    lastFbFrameCount = M._wasm_get_frame_count();
  };

  // Non-fastLoad (programB64) process-attach state: tryExec() arms an
  // AllocMem breakpoint once exec/graphics libraries are ready (execReady),
  // then getCurrentProcess() is checked on each hit until it identifies our
  // "file" CLI process (attached) — see puae_rpc.js. fastLoad
  // (programB64==='') has no separate attach step.
  let execReady = !programB64;
  let attached  = !programB64;
  let allocMemAddr = 0;

  // Playback speed control (#speed dropdown, optional — debug.html omits it).
  // 1 = normal (100%) speed; values < 1 slow emulated time down relative to
  // wall-clock time, for slow-motion debugging.
  let speedFactor = 1;
  let emuClockMs  = 0;    // accumulated emulated time, scaled by speedFactor
  let lastTs      = null;
  // Warp mode (#warp checkbox, optional): runs as many ticks as fit in
  // WARP_TICK_BUDGET_MS per tick-worker callback, ignoring speedFactor.
  // Mutually exclusive with the speed dropdown (disabled while warp is on).
  let warpMode = false;

  // Audio can't play correctly at non-1x speed or in warp mode (pitch/rate
  // would need to change too), so mute it whenever either is active.
  function applyAudioMute() {
    if (gain) gain.gain.value = (audioMuted || warpMode || speedFactor !== 1) ? 0 : 0.5;
  }

  const speedSelect = document.getElementById('speed');
  if (speedSelect) {
    speedFactor = parseFloat(speedSelect.value) || 1;
    speedSelect.addEventListener('change', () => {
      speedFactor = parseFloat(speedSelect.value) || 1;
      applyAudioMute();
    });
  }

  const warpButton = document.getElementById('warp');
  if (warpButton) {
    warpButton.addEventListener('click', () => {
      warpMode = !warpMode;
      warpButton.classList.toggle('active', warpMode);
      if (speedSelect) speedSelect.disabled = warpMode;
      applyAudioMute();
    });
  }

  const audioToggle = document.getElementById('audio-toggle');
  const audioToggleIcon = audioToggle?.querySelector('.codicon');
  if (audioToggle) {
    audioToggle.addEventListener('click', () => {
      audioMuted = !audioMuted;
      audioToggleIcon.classList.toggle('codicon-mute', audioMuted);
      audioToggleIcon.classList.toggle('codicon-unmute', !audioMuted);
      audioToggle.title = audioMuted ? 'Unmute audio' : 'Mute audio';
      if (!audioMuted) audioCtx?.resume(); // satisfies autoplay policy on first click
      applyAudioMute();
    });
  }

  // Builds a labelled group of small numbered toggle squares (toolbar-style,
  // replacing the previous checkbox lists). `items` is [{ key, text, color? }];
  // onToggle(item, active) is called whenever a square is clicked.
  function makeToggleGroup(label, items, onToggle) {
    const group = document.createElement('div');
    group.className = 'chan-group';
    const lbl = document.createElement('span');
    lbl.className = 'chan-group-label';
    lbl.textContent = label;
    group.appendChild(lbl);
    const grid = document.createElement('div');
    grid.className = 'chan-grid';
    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chan-btn active';
      btn.textContent = item.text;
      btn.title = item.title || item.text;
      if (item.color) btn.style.setProperty('--chan-color', item.color);
      btn.addEventListener('click', () => {
        const active = !btn.classList.contains('active');
        btn.classList.toggle('active', active);
        onToggle(item, active);
      });
      grid.appendChild(btn);
    }
    group.appendChild(grid);
    return group;
  }

  // DMA overlay panel (#dma-overlay, optional).
  // Controls: an "ALL" toggle, per-channel toggle squares, opacity slider.
  // There's no separate overlay-enable flag in the UI — the overlay is simply
  // enabled whenever at least one channel is active, and disabled when all
  // are off. All wired directly to the WASM overlay functions (no RPC
  // round-trip needed).
  const DMA_CHANNELS = [
    { type: 1, label: 'Refresh', abbr: 'REF', color: '#444444' },
    { type: 2, label: 'CPU',     abbr: 'CPU', color: '#a25342' },
    { type: 3, label: 'Copper',  abbr: 'COP', color: '#eeee00' },
    { type: 4, label: 'Audio',   abbr: 'AUD', color: '#ff0000' },
    { type: 5, label: 'Blitter', abbr: 'BLT', color: '#008888' },
    { type: 6, label: 'Bitplane',abbr: 'BPL', color: '#0000ff' },
    { type: 7, label: 'Sprite',  abbr: 'SPR', color: '#ff00ff' },
    { type: 8, label: 'Disk',    abbr: 'DSK', color: '#ffffff' },
    { type: 9, label: 'Conflict',abbr: 'CON', color: '#ffb840' },
  ];

  const dmaOverlayPanel = document.getElementById('dma-overlay');
  if (dmaOverlayPanel) {
    const channelGroup = document.createElement('div');
    channelGroup.className = 'chan-group';
    const channelLbl = document.createElement('span');
    channelLbl.className = 'chan-group-label';
    channelLbl.textContent = 'DMA';
    channelGroup.appendChild(channelLbl);

    const grid = document.createElement('div');
    grid.className = 'chan-grid';

    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = 'chan-btn all-btn';
    allBtn.textContent = 'ALL';
    allBtn.title = 'Toggle all DMA channels';
    grid.appendChild(allBtn);

    function setChannel(idx, active) {
      const ch = DMA_CHANNELS[idx];
      channelBtns[idx].classList.toggle('active', active);
      M._wasm_dma_overlay_set_channel(ch.type, active ? 1 : 0);
      const anyActive = channelBtns.some(b => b.classList.contains('active'));
      M._wasm_dma_overlay_enable(anyActive ? 1 : 0);
      dmaOverlayPanel.classList.toggle('disabled', !anyActive);
    }

    function syncAllBtn() {
      allBtn.classList.toggle('active', channelBtns.every(b => b.classList.contains('active')));
    }

    // Start with every channel off — the overlay is opt-in.
    const channelBtns = DMA_CHANNELS.map((ch, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chan-btn';
      btn.textContent = ch.abbr;
      btn.title = ch.label;
      btn.style.setProperty('--chan-color', ch.color);
      btn.addEventListener('click', () => {
        setChannel(idx, !btn.classList.contains('active'));
        syncAllBtn();
      });
      grid.appendChild(btn);
      return btn;
    });

    allBtn.addEventListener('click', () => {
      const turnOn = !channelBtns.every(b => b.classList.contains('active'));
      DMA_CHANNELS.forEach((_, idx) => setChannel(idx, turnOn));
      syncAllBtn();
    });

    channelGroup.appendChild(grid);
    dmaOverlayPanel.appendChild(channelGroup);
    dmaOverlayPanel.classList.add('disabled');

    // Opacity slider
    const opacityRow = document.createElement('div');
    opacityRow.className = 'opacity-row';
    const opacityLbl = document.createElement('span');
    opacityLbl.className = 'chan-group-label';
    opacityLbl.textContent = 'Opacity';
    const opacitySlider = document.createElement('input');
    opacitySlider.type = 'range';
    opacitySlider.min = 0;
    opacitySlider.max = 255;
    opacitySlider.value = 128;
    opacitySlider.addEventListener('input', () => {
      M._wasm_dma_overlay_set_opacity(parseInt(opacitySlider.value, 10));
    });
    opacityRow.appendChild(opacityLbl);
    opacityRow.appendChild(opacitySlider);
    dmaOverlayPanel.appendChild(opacityRow);
  }

  // Channel visibility panel (#channel-visibility, optional).
  // Numbered toggle squares to disable individual bitplanes, sprites, and
  // audio channels.
  const channelVisPanel = document.getElementById('channel-visibility');
  if (channelVisPanel) {
    function makeIndexedGroup(label, count, textFn, setter) {
      const items = [];
      for (let i = 0; i < count; i++) items.push({ key: i, text: textFn(i) });
      return makeToggleGroup(label, items, (item, active) => setter(item.key, active ? 1 : 0));
    }

    channelVisPanel.appendChild(makeIndexedGroup(
      'Bitplanes', 8,
      i => String(i + 1),
      (i, v) => M._wasm_set_bitplane_enabled(i, v)
    ));
    channelVisPanel.appendChild(makeIndexedGroup(
      'Sprites', 8,
      i => String(i),
      (i, v) => M._wasm_set_sprite_enabled(i, v)
    ));
    channelVisPanel.appendChild(makeIndexedGroup(
      'Audio', 4,
      i => String(i),
      (i, v) => M._wasm_set_audio_channel_enabled(i, v)
    ));
  }

  // Set up the audio graph now — this doesn't itself need a user gesture.
  // No "enable audio" button needed: the unlock listeners registered above
  // (via audioCtx.onstatechange) resume playback on the first click/keypress.
  startAudio().catch(e => console.error('[audio] init failed', e));

  function frame(ts) {
    if (lastTs === null) { lastTs = ts; fpsTime = ts; }

    // Accumulate emulated time scaled by speedFactor, so changing speed
    // mid-session doesn't cause a discontinuous jump in dueFrames. Use the
    // AudioContext clock as the source while it's actually driving audio
    // (see lastAudioClockS above) so production can't drift from consumption;
    // otherwise fall back to the system clock.
    const useAudioClock = !!audioCtx && audioCtx.state === 'running' && speedFactor === 1 && !warpMode;
    if (useAudioClock) {
      const audioNowS = audioCtx.currentTime;
      if (lastAudioClockS === null) lastAudioClockS = audioNowS; // avoid a jump when (re-)entering this mode
      emuClockMs += (audioNowS - lastAudioClockS) * 1000;
      lastAudioClockS = audioNowS;
    } else {
      emuClockMs += (ts - lastTs) * speedFactor;
      lastAudioClockS = null; // re-sync without a jump next time we enter audio-clock mode
    }
    lastTs = ts;

    // How many PAL frames should have elapsed (in emulated time) so far?
    const dueFrames = Math.floor(emuClockMs * PAL_FPS / 1000);
    const wasPaused = M._wasm_is_paused();
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
      if (imgData && !fbDirty) return;
    } else if (!warpMode && dueFrames <= emuFrames) {
      return; // display is faster than 50 Hz — nothing to do yet
    }

    const tTickStart = performance.now();
    let hitBreakpoint = false;
    let ranCount = 0;
    if (wasPaused) {
      // no ticks to run
    } else if (warpMode) {
      // Run flat-out for a time budget, ignoring speedFactor/dueFrames.
      while (performance.now() - tTickStart < WARP_TICK_BUDGET_MS) {
        M._wasm_tick();
        ranCount++;
        if (M._wasm_is_paused()) { hitBreakpoint = true; break; }
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
      while (emuFrames + ranCount < dueFrames &&
             performance.now() - tTickStart < WARP_TICK_BUDGET_MS) {
        M._wasm_tick();
        ranCount++;
        if (M._wasm_is_paused()) { hitBreakpoint = true; break; }
      }
    }
    const tTickEnd = performance.now();
    emuFrames += ranCount;
    // Warp mode can run emuFrames ahead of the wall-clock schedule — pull
    // emuClockMs forward to match so playback doesn't "freeze" waiting for
    // real time to catch up once warp mode is turned off. Never moves
    // emuClockMs backward (normal-speed catch-up after falling behind still
    // works as before).
    emuClockMs = Math.max(emuClockMs, emuFrames * 1000 / PAL_FPS);

    // Periodic full-state checkpoint during a free-run, so stepBack/
    // continueReverse can rewind into the middle of a long `continue`, not
    // just back to its start (see puae_rpc.js's pushSnapshot). rpc is only
    // set inside the VS Code webview — debug.html has no RPC bridge.
    if (rpc && !wasPaused && ranCount > 0 && emuFrames - lastCheckpointFrame >= CHECKPOINT_INTERVAL_FRAMES) {
      lastCheckpointFrame = emuFrames;
      setTimeout(() => rpc.pushSnapshot(), 0);
    }

    // Non-fastLoad (programB64) boot: poll for exec/graphics libraries being
    // ready, then arm the AllocMem breakpoint (tryExec) so the next hit can
    // be checked against getCurrentProcess() below.
    if (programB64 && !execReady) {
      const r = tryExec(M);
      if (r.ready) {
        execReady = true;
        allocMemAddr = r.allocMemAddr;
        // Non-fastLoad: by the time exec is ready here, nothing's been
        // loaded yet (the CLI runs the program later via the startup-
        // sequence), so starting the watch now means LoadSeg's own AllocMem
        // call for the program's hunks gets tracked like any other.
        M._wasm_memprotect_start_tracking();
      }
    }

    if (hitBreakpoint) {
      if (programB64 && execReady && !attached) {
        // AllocMem breakpoint hit while waiting for our "file" CLI process
        // (s/startup-sequence) to start — check whether this is it yet.
        const proc = getCurrentProcess(M);
        if (proc) {
          M._wasm_remove_breakpoint(allocMemAddr);
          attached = true;
          log(`Attached to process "${proc.command}" (${proc.segments.length} segment(s))`);
          if (vscode) {
            vscode.postMessage({ type: 'attached', segments: proc.segments });
          }
        } else {
          // Not our process yet (e.g. AmigaOS's own startup tasks) — keep
          // the breakpoint armed and resume.
          M._wasm_resume();
        }
      } else {
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
    }

    if (ranCount > 0) pushAccumToWorklet(); // push this tick's samples to the ring-buffer worklet

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
    // Re-read rather than reuse fbFrameCount (captured before this frame()
    // call's own tick loop, if any) so the comparison next time is accurate.
    lastFbFrameCount = M._wasm_get_frame_count();

    if (ranCount > 0) {
      frames += ranCount;
      fpsCnt += ranCount;
      if (ts - fpsTime >= 1000) {
        const fps    = (fpsCnt * 1000 / (ts - fpsTime)).toFixed(1);
        const msWasm = ((tTickEnd - tTickStart) / ranCount).toFixed(1);
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
