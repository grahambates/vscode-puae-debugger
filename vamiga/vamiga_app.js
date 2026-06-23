// Boot/render-loop/audio/input glue for the vAmiga wasm backend — the
// minimal replacement for vamigaweb's jQuery/Bootstrap-based vAmiga_ui.js.
// Mirrors puae_app.js's role for the PUAE backend, adapted to vAmiga's own
// (already-working, unrelated) audio architecture and its Module-global
// (non-MODULARIZE) Emscripten build, rather than puae.js's factory-function
// build — see the boot() comment below for why that changes the wiring.
//
// Unlike puae_app.js, this file doesn't create the Emscripten module itself:
// vAmiga.js (the compiled Emscripten loader) expects a pre-existing global
// `Module` config object with a `postRun` callback, set up by a small classic
// (non-module) <script> in index.html *before* vAmiga.js loads. That callback
// just calls `window.__vamigaBoot()`, which this file's `main()` sets — by
// the time postRun actually fires (after the wasm binary is fetched and
// instantiated), main() has long since run and installed it.
//
// Two functions are called by the wasm core via bare global lookups (EM_ASM
// in a non-module classic script resolves names against `window`), not via
// Module exports: `message_handler` (core status messages) and
// `js_set_display` (autocrop geometry changes). Both are assigned onto
// `window` here/in vamiga_canvas.js rather than just declared, since this
// file is an ES module and module-scope declarations aren't global.

import { setupRpcDispatcher } from './vamiga_rpc.js';
import { createCanvasRenderer } from './vamiga_canvas.js';
import { translateKey } from './vamiga_keyboard.js';

export async function main(config = {}) {
  const { callParams = {} } = config;

  const M = window.Module;
  const canvas = document.getElementById('canvas');
  const audioToggle = document.getElementById('audio-toggle');
  const speedSelect = document.getElementById('speed');
  const warpButton = document.getElementById('warp');
  const dmaOverlayPanel = document.getElementById('dma-overlay');
  const channelVisPanel = document.getElementById('channel-visibility');

  let vscode;
  if (typeof acquireVsCodeApi === 'function') {
    vscode = acquireVsCodeApi();
  }
  const postToHost = (msg) => vscode?.postMessage(msg);

  // Shared mutable state — see vamiga_rpc.js's header comment for why this
  // is passed by reference rather than each module owning its own copy.
  const state = {
    callParams,
    execReady: false,
    attached: false,
    allocMemAddr: 0,
    startSnapshot: null,
    breakpoints: new Set(),
    snapshotHistory: [],
    snapshotIndex: -1,
    // [vscode-vamiga-debugger mem protect] Set once wasm_memprotect_start_tracking
    // first succeeds (see tryStartMemProtectTracking below and vamiga_rpc.js's
    // 'load' handler, which both read/write this flag via the shared `state`).
    memProtectTrackingStarted: false,
  };

  // js_set_display is called by the wasm core (bare global, via EM_ASM) as
  // soon as its own C-side init runs — which can happen before our postRun
  // callback (boot(), below) fires. So the global must be registered here,
  // synchronously, before vAmiga.js (loaded async) can possibly reach that
  // call. But creating the real renderer needs M._wasm_get_render_width()/
  // M._wasm_pixel_buffer(), which only exist once the wasm instance itself
  // is up — exactly the instant such a call could happen, not any sooner.
  // Lazy-create on first actual use to satisfy both constraints at once.
  let canvasRenderer = null;
  function ensureCanvasRenderer() {
    if (!canvasRenderer) canvasRenderer = createCanvasRenderer(M, canvas);
    return canvasRenderer;
  }
  window.js_set_display = (...args) => ensureCanvasRenderer().setDisplay(...args);
  // The wasm core also calls scaleVMCanvas() directly (bare global) on
  // window resize. The original used it to drive jQuery-based responsive
  // CSS sizing/centering; CSS alone (max-width/height:auto on #canvas)
  // handles that here, so this is a no-op — it just needs to exist so the
  // core's call doesn't throw.
  window.scaleVMCanvas = () => {};

  // -------- hardware config --------
  // Applies the OpenOptions-derived hardware fields straight to the wasm
  // core. In the original vamigaweb UI this happened indirectly, through the
  // settings modal's dropdown-binding code (bind_config_choice), which
  // *always* applied these defaults — wasm_configure() ran for every one of
  // these keys unconditionally at UI setup, using callParams's value if
  // present or its own hardcoded default otherwise. These weren't just UI
  // presentation defaults: dropping them (applying wasm_configure only when
  // callParams explicitly sets a field, otherwise leaving the wasm core's
  // own bare-minimum internal default in place) leaves far less chip/fast
  // RAM than programs commonly assume, causing exactly the kind of
  // out-of-bounds memory corruption a memory-hungry demo would hit.
  function applyHardwareConfig(wasm_configure, wasm_power_on) {
    // [wasm_configure key, callParams value, default matching the old
    // modal's bind_config_choice(...) call for the same setting]
    const entries = [
      ['AGNUS_REVISION', callParams.agnus_revision, 'ECS_2MB'],
      ['DENISE_REVISION', callParams.denise_revision, 'OCS'],
      ['CPU_REVISION', callParams.cpu_revision, 0],
      ['CPU_OVERCLOCKING', callParams.cpu_overclocking, 0],
      ['CHIP_RAM', callParams.chip_ram, 2048],
      ['SLOW_RAM', callParams.slow_ram, 0],
      ['FAST_RAM', callParams.fast_ram, 2048],
      ['BLITTER_ACCURACY', callParams.blitter_accuracy, 2],
      ['floppy_drive_count', callParams.floppy_drive_count, 2],
      ['DRIVE_SPEED', callParams.drive_speed, 1],
    ];
    let needsPowerOn = false;
    for (const [key, value, fallback] of entries) {
      const effective = value === undefined ? fallback : value;
      const result = wasm_configure(key, `${effective}`);
      if (result && result.length > 0) {
        console.error(`[vamiga] wasm_configure(${key}) rejected: ${result}`);
        needsPowerOn = true;
      }
    }
    if (needsPowerOn) wasm_power_on(1);
  }

  // -------- boot --------
  window.__vamigaBoot = function boot() {
    // By now the wasm instance is certainly up (postRun fires near the end
    // of Emscripten's init sequence), so this is safe even if js_set_display
    // was never called early enough to have created it already.
    const canvasRenderer = ensureCanvasRenderer();

    const wasm_reset = M.cwrap('wasm_reset', 'undefined');
    const wasm_peek32 = M.cwrap('wasm_peek32', 'number', ['number']);
    const wasm_peek16 = M.cwrap('wasm_peek16', 'number', ['number']);
    const wasm_get_cpu_info = M.cwrap('wasm_get_cpu_info', 'string');
    const wasm_enable_cpu_logging = M.cwrap('wasm_enable_cpu_logging', 'boolean', ['boolean']);
    const wasm_poke_custom16 = M.cwrap('wasm_poke_custom16', 'undefined', ['number', 'number']);
    const wasm_set_breakpoint = M.cwrap('wasm_set_breakpoint', 'boolean', ['number', 'number']);
    const wasm_remove_breakpoint = M.cwrap('wasm_remove_breakpoint', 'boolean', ['number']);
    const wasm_get_current_process = M.cwrap('wasm_get_current_process', 'string');
    const wasm_configure = M.cwrap('wasm_configure', 'string', ['string', 'string']);
    const wasm_configure_key = M.cwrap('wasm_configure_key', 'string', ['string', 'string', 'string']);
    const wasm_power_on = M.cwrap('wasm_power_on', 'string', ['number']);
    const wasm_take_user_snapshot = M.cwrap('wasm_take_user_snapshot', 'string');
    const wasm_delete_user_snapshot = M.cwrap('wasm_delete_user_snapshot', 'undefined');
    const wasm_retro_shell = M.cwrap('wasm_retro_shell', 'undefined', ['string']);
    const wasm_get_current_message = M.cwrap('wasm_get_current_message', 'string');
    const wasm_set_sample_rate = M.cwrap('wasm_set_sample_rate', 'undefined', ['number']);
    const wasm_get_sound_buffer_address = M.cwrap('wasm_get_sound_buffer_address', 'number');
    const wasm_schedule_key = M.cwrap('wasm_schedule_key', 'undefined', ['number', 'number', 'number', 'number']);
    // [vscode-vamiga-debugger mem protect]
    const wasm_memprotect_start_tracking = M.cwrap('wasm_memprotect_start_tracking', 'boolean');
    const wasm_memprotect_seed_libraries = M.cwrap('wasm_memprotect_seed_libraries', 'boolean');

    function wasm_loadfile(fileName, fileBuffer) {
      const ptr = M._malloc(fileBuffer.byteLength);
      try {
        M.HEAPU8.set(fileBuffer, ptr);
        return M.ccall('wasm_loadFile', 'string', ['string', 'number', 'number', 'number'], [fileName, ptr, fileBuffer.byteLength, 0]);
      } finally {
        M._free(ptr);
      }
    }

    applyHardwareConfig(wasm_configure, wasm_power_on);

    let running = false;
    let queuedExecutes = 0;
    let doAnimationFrame = null;
    let emulationWorker = null;

    const wasmHalt = (pauseEvent = true) => {
      M._wasm_halt();
      running = false;
      emulationWorker?.postMessage({ command: 'stop' });
      if (pauseEvent) postToHost({ type: 'emulator-state', state: 'paused' });
    };

    // [vscode-vamiga-debugger mem protect] Starts the AllocMem/FreeMem watch
    // that builds the memory protection allow-list as early as possible —
    // much earlier than tryExec's "user task started" heuristic below, so
    // Kickstart's own boot-time allocations (graphics.library's default
    // View/copper lists, etc.) get tracked too. wasm_memprotect_start_tracking
    // validates execBase itself and no-ops until it's actually ready, so
    // this is safe to call every tick; stop once it succeeds (calling it
    // again later would discard any AllocMem call currently in-flight).
    const tryStartMemProtectTracking = () => {
      if (state.memProtectTrackingStarted) return;
      state.memProtectTrackingStarted = wasm_memprotect_start_tracking();
    };

    // Watch for the debuggee program starting: hook AllocMem (called early
    // and often during boot, but a reliable point to catch our program once
    // execbase is up) to install a breakpoint at, or — for fastLoad — to
    // snapshot from, so the program can be injected directly into RAM.
    const tryExec = () => {
      const execBase = wasm_peek32(4);
      state.allocMemAddr = execBase - 198; // _LV0_AllocMem
      const gfxBaseAddr = execBase + 156;
      const cpuInfo = wasm_get_cpu_info();
      const isSupervisor = (Number(cpuInfo.sr) & 0x2000) !== 0;
      if (state.allocMemAddr > 0 &&
          wasm_peek16(state.allocMemAddr) === 0x4ef9 &&
          wasm_peek32(gfxBaseAddr) &&
          !isSupervisor) {
        state.execReady = true;
        wasm_enable_cpu_logging(true);
        // [vscode-vamiga-debugger mem protect] GfxBase is confirmed set here
        // (checked just above), so its own library list is guaranteed to be
        // populated — safe to walk now, unlike at the earlier raw-execBase
        // tracking-start point (see MemProtect.h's seedResidentLibraries).
        wasm_memprotect_seed_libraries();
        const fastLoad = !state.callParams.url;
        if (fastLoad) {
          state.attached = true;
          wasm_poke_custom16(0xdff09a, 0x7fff); // disable interrupts
          wasm_configure('WARP_MODE', 'NEVER');
          wasmHalt(false);
          const snap = JSON.parse(wasm_take_user_snapshot());
          const buf = new Uint8Array(M.HEAPU8.buffer, snap.address, snap.size);
          state.startSnapshot = buf.slice(0, snap.size);
          wasm_delete_user_snapshot();
        } else {
          wasm_set_breakpoint(state.allocMemAddr, 0);
        }
        postToHost({ type: 'exec-ready' });
      }
    };

    const allocBpCheckProcess = () => {
      const proc = JSON.parse(wasm_get_current_process());
      if (proc.command === 'file' && proc.segments) {
        wasm_remove_breakpoint(state.allocMemAddr);
        state.attached = true;
        wasm_configure('WARP_MODE', 'NEVER');
        wasmHalt(false);
        postToHost({ type: 'attached', segments: proc.segments });
      }
      return state.attached;
    };

    const handleStop = (e) => {
      if (!state.attached) return allocBpCheckProcess();
      console.log('Execution stopped (breakpoint or exception):', e);
      wasmHalt(false);
      rpc.pushSnapshot();
      const message = JSON.parse(wasm_get_current_message());
      postToHost({ type: 'emulator-state', state: 'stopped', message });
    };

    // --- RPC bridge ---
    const wasmRun = () => {
      M._wasm_run();
      running = true;
      if (doAnimationFrame === null) {
        const executeAmigaFrame = () => {
          try {
            M._wasm_execute();
          } catch (err) {
            handleStop(err);
          } finally {
            queuedExecutes--;
          }
        };
        doAnimationFrame = (now) => {
          try {
            queryGamepads();
            const behind = M._wasm_draw_one_frame(now);
            if (behind < 0) return;
            canvasRenderer.render();
            while (behind > queuedExecutes) {
              queuedExecutes++;
              setTimeout(executeAmigaFrame);
            }
            periodicSnapshotCounter++;
            if (periodicSnapshotCounter >= SNAPSHOT_INTERVAL_FRAMES) {
              periodicSnapshotCounter = 0;
              rpc.pushSnapshot();
            }
          } catch (err) {
            handleStop(err);
          }
        };
      }
      emulationWorker?.postMessage({ command: 'start' });
      postToHost({ type: 'emulator-state', state: 'running' });
    };

    const SNAPSHOT_INTERVAL_FRAMES = 50; // ~1s at 50fps
    let periodicSnapshotCounter = 0;

    const rpc = setupRpcDispatcher(M, postToHost, {
      state,
      wasmRun,
      wasmHalt,
      renderCanvas: canvasRenderer.render,
    });
    window.addEventListener('message', (event) => rpc.handleMessage(event.data));

    // --- timing worker (keeps ticking when the webview tab is hidden) ---
    function initEmulationWorker() {
      const workerScript = `
        let intervalId;
        const PAL_FPS = 50;
        self.onmessage = (event) => {
          switch (event.data.command) {
            case 'start':
              if (!intervalId) {
                intervalId = setInterval(() => postMessage({ timestamp: performance.now() }), 1000 / PAL_FPS);
              }
              break;
            case 'stop':
              if (intervalId) { clearInterval(intervalId); intervalId = null; }
              break;
          }
        };
      `;
      const blob = new Blob([workerScript], { type: 'application/javascript' });
      emulationWorker = new Worker(URL.createObjectURL(blob));
      emulationWorker.onmessage = (event) => {
        if (doAnimationFrame) {
          doAnimationFrame(event.data.timestamp);
          if (!state.memProtectTrackingStarted) tryStartMemProtectTracking();
          if (!state.execReady) tryExec();
        }
      };
    }
    initEmulationWorker();

    // --- ROM loading (reactive: the core itself requests a ROM once it
    // discovers none is loaded, via the MSG_ROM_MISSING status message) ---
    window.message_handler = function messageHandler(msg) {
      queueMicrotask(() => messageHandlerImpl(msg));
    };
    async function messageHandlerImpl(msg) {
      if (msg === 'MSG_READY_TO_RUN') {
        setTimeout(() => { try { wasmRun(); } catch (e) { console.error(e); } }, 100);
      } else if (msg === 'MSG_ROM_MISSING') {
        const romUrl = state.callParams.kickstart_rom_url;
        if (!romUrl) return;
        const romData = new Uint8Array(await (await fetch(romUrl)).arrayBuffer());
        wasm_loadfile('kick.rom_file', romData);
        if (state.callParams.kickstart_ext_url) {
          const extData = new Uint8Array(await (await fetch(state.callParams.kickstart_ext_url)).arrayBuffer());
          wasm_loadfile('kick.rom_ext_file', extData);
        }
        wasm_reset();
      }
      // Other MSG_* (drive step/insert/eject, warp state, video format) drove
      // UI-only feedback (sound effects, status badges) that's out of scope.
    }

    // --- speed control ---
    // wasm_configure('OPT_AMIGA_SPEED_BOOST', percent) sets Opt::AMIGA_SPEED_BOOST
    // directly — the core's own slow-motion control (confirmed in
    // vamigaweb_fork/main.cpp's wasm_configure(): values >4 are treated as
    // a percentage, matching this dropdown's 100/50/25/10 options exactly).
    if (speedSelect) {
      speedSelect.addEventListener('change', () => {
        wasm_configure('OPT_AMIGA_SPEED_BOOST', speedSelect.value);
      });
    }

    // --- warp toggle ---
    // wasm_set_warp(1) sets Warp::AUTO (a passive mode that only kicks in
    // for the core's own built-in triggers, e.g. disk DMA), not a forced
    // continuous warp — wasm_configure('WARP_MODE', 'ALWAYS') is what
    // actually forces it on, matching every other WARP_MODE usage elsewhere
    // in this file (tryExec, the RPC 'load'/stepBack/continueReverse
    // handlers).
    if (warpButton) {
      let warping = false;
      warpButton.addEventListener('click', () => {
        warping = !warping;
        warpButton.classList.toggle('active', warping);
        wasm_configure('WARP_MODE', warping ? 'ALWAYS' : 'NEVER');
      });
    }

    // --- DMA channel toggles ---
    if (dmaOverlayPanel) {
      setupDmaOverlayPanel(dmaOverlayPanel, wasm_configure, wasm_configure_key, ensureCanvasRenderer);
    }

    // --- per-channel visibility (debugger feature, not vamigaweb UI) ---
    if (channelVisPanel) {
      setupChannelVisibilityPanel(channelVisPanel, wasm_retro_shell);
    }

    // --- mouse (pointer lock) ---
    setupMouse(canvas, M);

    // --- keyboard ---
    document.addEventListener('keydown', (e) => {
      e.preventDefault();
      const key = translateKey(e.code);
      if (!key) return;
      if (key.modifier) wasm_schedule_key(key.modifier[0], key.modifier[1], 1, 0);
      wasm_schedule_key(key.raw_key[0], key.raw_key[1], 1, 0);
    });
    document.addEventListener('keyup', (e) => {
      e.preventDefault();
      const key = translateKey(e.code);
      if (!key) return;
      wasm_schedule_key(key.raw_key[0], key.raw_key[1], 0, 1);
      if (key.modifier) wasm_schedule_key(key.modifier[0], key.modifier[1], 0, 1);
    });

    // --- audio ---
    setupAudio({ M, audioToggle, wasm_set_sample_rate, wasm_get_sound_buffer_address, canvas });
  };
}

// Gamepad polling is intentionally not ported — no extension-host config
// hook exists for joystick ports, and the original UI's port-selection
// dropdown is gone. Kept as a no-op call site so wiring it back in later
// (if ever needed) doesn't require touching the render loop.
function queryGamepads() {}

function setupMouse(canvas, M) {
  const wasm_mouse = M.cwrap('wasm_mouse', 'undefined', ['number', 'number', 'number']);
  const wasm_mouse_button = M.cwrap('wasm_mouse_button', 'undefined', ['number', 'number', 'number']);
  const mousePort = 1;

  canvas.requestPointerLock = canvas.requestPointerLock || canvas.mozRequestPointerLock;
  document.exitPointerLock = document.exitPointerLock || document.mozExitPointerLock;

  function updatePosition(e) {
    wasm_mouse(mousePort, e.movementX, e.movementY);
  }
  // The wasm core expects the legacy 1=left/2=middle/3=right numbering
  // (what MouseEvent.which used to report), not MouseEvent.button's
  // 0=left/1=middle/2=right — translate rather than pass button through.
  function mouseDown(e) {
    if (e.button === 1) { document.exitPointerLock?.(); return; } // middle button releases capture
    wasm_mouse_button(mousePort, e.button + 1, 1);
  }
  function mouseUp(e) {
    if (e.button === 1) return;
    wasm_mouse_button(mousePort, e.button + 1, 0);
  }
  function lockChangeAlert() {
    if (document.pointerLockElement === canvas) {
      document.addEventListener('mousemove', updatePosition, false);
      document.addEventListener('mousedown', mouseDown, false);
      document.addEventListener('mouseup', mouseUp, false);
    } else {
      document.removeEventListener('mousemove', updatePosition, false);
      document.removeEventListener('mousedown', mouseDown, false);
      document.removeEventListener('mouseup', mouseUp, false);
    }
  }
  document.addEventListener('pointerlockchange', lockChangeAlert, false);
  canvas.addEventListener('click', () => { canvas.requestPointerLock?.(); });
}

// Small message pill shown while audio is locked behind the browser's
// autoplay gesture requirement — vanilla DOM, ported from the (already
// jQuery-free) original.
function showAudioOverlay(visible) {
  let el = document.getElementById('audio_overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'audio_overlay';
    el.textContent = 'Click to enable audio';
    el.style.cssText = 'position:fixed;top:9px;left:50%;transform:translateX(-50%);' +
      'z-index:3000;padding:3px 12px;border-radius:10px;font-family:sans-serif;font-size:13px;' +
      'color:#fff;background:rgba(0,0,0,0.55);pointer-events:none;';
    document.body.appendChild(el);
  }
  el.style.display = visible ? 'block' : 'none';
}

function setupAudio({ M, audioToggle, wasm_set_sample_rate, wasm_get_sound_buffer_address }) {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AudioContextCtor();
  let audioConnected = false;
  let workletNode;
  let gainNode;
  let soundbufferSlots;

  function initSoundBuffer() {
    const address = wasm_get_sound_buffer_address();
    soundbufferSlots = [];
    for (let slot = 0; slot < 16; slot++) {
      soundbufferSlots.push(new Float32Array(M.HEAPF32.buffer, address + slot * 2048 * 4, 2048));
    }
  }

  // Tiny reusable-buffer ring, mirrors the original's RingBuffer helper.
  function makeRingBuffer(capacity) {
    const buf = new Array(capacity);
    let head = 0, tail = 0, count = 0;
    return {
      isEmpty: () => count === 0,
      write: (v) => { if (count < capacity) { buf[tail] = v; tail = (tail + 1) % capacity; count++; } },
      read: () => { if (count === 0) return undefined; const v = buf[head]; head = (head + 1) % capacity; count--; return v; },
    };
  }

  async function connectAudioProcessor() {
    if (audioContext.state !== 'running') {
      try { await audioContext.resume(); } catch (e) { console.error(e); }
    }
    if (audioConnected || audioContext.state === 'suspended') return;
    audioConnected = true;
    wasm_set_sample_rate(audioContext.sampleRate);
    await audioContext.audioWorklet.addModule('vAmiga_audioprocessor.js');
    workletNode = new AudioWorkletNode(audioContext, 'vAmiga_audioprocessor', {
      outputChannelCount: [2], numberOfInputs: 0, numberOfOutputs: 1,
    });
    gainNode = audioContext.createGain();
    gainNode.gain.value = 5; // matches original's default (0.5 volume * 10)
    workletNode.connect(gainNode);
    gainNode.connect(audioContext.destination);
    initSoundBuffer();

    const emptyShuttles = makeRingBuffer(16);
    workletNode.port.onmessage = (msg) => {
      let samples = M._wasm_copy_into_sound_buffer();
      let shuttle = msg.data;
      if (samples < 1024) {
        if (shuttle !== 'empty') emptyShuttles.write(shuttle);
        return;
      }
      let slot = 0;
      while (samples >= 1024) {
        if (shuttle == null || shuttle === 'empty') {
          if (emptyShuttles.isEmpty()) return;
          shuttle = emptyShuttles.read();
        }
        let wasmBufferSlot = soundbufferSlots[slot++];
        if (wasmBufferSlot.byteLength === 0) {
          initSoundBuffer();
          wasmBufferSlot = soundbufferSlots[slot - 1];
        }
        shuttle.set(wasmBufferSlot);
        workletNode.port.postMessage(shuttle, [shuttle.buffer]);
        shuttle = null;
        samples -= 1024;
      }
    };
  }

  let audioMuted = true;
  function applyMute() {
    if (gainNode) gainNode.gain.value = audioMuted ? 0 : 5;
  }

  audioContext.onstatechange = () => {
    if (audioContext.state !== 'running') showAudioOverlay(!audioMuted);
    else showAudioOverlay(false);
  };

  const unlock = async () => {
    try {
      await connectAudioProcessor();
      applyMute();
      if (audioContext.state === 'running') {
        document.removeEventListener('click', unlock);
        showAudioOverlay(false);
      }
    } catch (e) { console.error(e); }
  };
  document.addEventListener('click', unlock);

  if (audioToggle) {
    const icon = audioToggle.querySelector('.codicon');
    audioToggle.addEventListener('click', () => {
      audioMuted = !audioMuted;
      icon?.classList.toggle('codicon-mute', audioMuted);
      icon?.classList.toggle('codicon-unmute', !audioMuted);
      audioToggle.title = audioMuted ? 'Unmute audio' : 'Mute audio';
      if (!audioMuted) unlock();
      applyMute();
    });
  }
}

// Builds a labelled group of small toggle squares — same markup/behavior as
// puae_app.js's makeToggleGroup, so the two webviews share CSS verbatim.
// `items` is [{ key, text, color?, title? }]; onToggle(item, active) fires
// on every click.
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

// DMA channel toggles, styled like PUAE's #dma-overlay panel (colored
// squares + bold "ALL" toggle). vAmiga's core has no in-frame visual
// overlay to drive (PUAE's wasm_dma_overlay_* has no equivalent here), so
// these flip the DEBUG_CHANNELn/DEBUG_ENABLE/DMA.DEBUG_ENABLE config flags
// instead — no live meters or polling. Index order matches vAmiga's own
// DmaChannel enum exactly (confirmed against
// vamigaweb_fork/Core/Components/Agnus/DmaDebugger/DmaDebuggerTypes.h):
// COPPER=0, BLITTER=1, DISK=2, AUDIO=3, SPRITE=4, BITPLANE=5, CPU=6,
// REFRESH=7. Colors reused from puae_app.js's DMA_CHANNELS for the same
// channel types, so the two webviews look consistent.
const DMA_CHANNELS = [
  { id: 'copper', label: 'COP', color: '#eeee00' },
  { id: 'blitter', label: 'BLT', color: '#008888' },
  { id: 'disk', label: 'DSK', color: '#ffffff' },
  { id: 'audio', label: 'AUD', color: '#ff0000' },
  { id: 'sprite', label: 'SPR', color: '#ff00ff' },
  { id: 'bitplane', label: 'BPL', color: '#0000ff' },
  { id: 'CPU', label: 'CPU', color: '#a25342' },
  { id: 'refresh', label: 'REF', color: '#444444' },
];

function setupDmaOverlayPanel(panel, wasm_configure, wasm_configure_key, ensureCanvasRenderer) {
  // Explicitly zero every channel flag (0-7) up front — left at the core's
  // own default (apparently "visible"), an untouched channel shows up as
  // soon as DEBUG_ENABLE flips on for any other channel, until it's been
  // toggled at least once itself.
  for (let i = 0; i < DMA_CHANNELS.length; i++) wasm_configure_key(`DEBUG_CHANNEL${i}`, '0');

  function setEnabled(anyActive) {
    wasm_configure('DEBUG_ENABLE', anyActive ? '1' : '0');
    wasm_configure('DMA.DEBUG_ENABLE', anyActive ? '1' : '0');
    // Audio/sprite DMA fetch cycles the overlay colorizes happen outside the
    // normally-cropped view (in horizontal blanking) — extend the canvas to
    // full overscan while any channel is on so they're actually visible.
    ensureCanvasRenderer().setOverscan(anyActive);
  }

  const group = document.createElement('div');
  group.className = 'chan-group';
  const label = document.createElement('span');
  label.className = 'chan-group-label';
  label.textContent = 'DMA';
  group.appendChild(label);
  const grid = document.createElement('div');
  grid.className = 'chan-grid';

  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = 'chan-btn all-btn';
  allBtn.textContent = 'ALL';
  allBtn.title = 'Toggle all DMA channels';
  grid.appendChild(allBtn);

  function setChannel(idx, active) {
    channelBtns[idx].classList.toggle('active', active);
    wasm_configure_key(`DEBUG_CHANNEL${idx}`, active ? '1' : '0');
    const anyActive = channelBtns.some((b) => b.classList.contains('active'));
    setEnabled(anyActive);
  }

  function syncAllBtn() {
    allBtn.classList.toggle('active', channelBtns.every((b) => b.classList.contains('active')));
  }

  // Start with every channel off — the overlay is opt-in.
  const channelBtns = DMA_CHANNELS.map((ch, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chan-btn';
    btn.textContent = ch.label;
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
    const turnOn = !channelBtns.every((b) => b.classList.contains('active'));
    DMA_CHANNELS.forEach((_, idx) => setChannel(idx, turnOn));
    syncAllBtn();
  });

  group.appendChild(grid);
  panel.appendChild(group);
}

// Per-bitplane/sprite/audio-channel visibility toggles — a debugger feature
// (not part of vamigaweb's legacy UI). wasm_configure() can't take numeric
// bitmasks, so this goes through wasm_retro_shell() with the same commands
// RetroShell itself accepts:
//   denise set HIDDEN_BITPLANES <mask>   (bit N = BPL N+1 hidden)
//   denise set HIDDEN_SPRITES <mask>     (bit N = SPR N hidden)
//   audio set VOL<N> <0|100>             (mute/unmute one audio channel)
// Short numeric labels (matching puae_app.js's channel-visibility panel)
// rather than "BPL1"/"SPR0"/"AUD0" — the group label already says which
// kind of channel these are.
function setupChannelVisibilityPanel(panel, wasm_retro_shell) {
  let bpMask = 0, sprMask = 0;

  function makeIndexedGroup(label, count, textFn, setter) {
    const items = [];
    for (let i = 0; i < count; i++) items.push({ key: i, text: textFn(i) });
    return makeToggleGroup(label, items, (item, active) => setter(item.key, active));
  }

  panel.appendChild(makeIndexedGroup(
    'Bitplanes', 8,
    (i) => String(i + 1),
    (i, visible) => {
      if (visible) bpMask &= ~(1 << i); else bpMask |= (1 << i);
      wasm_retro_shell('denise set HIDDEN_BITPLANES ' + bpMask);
    },
  ));
  panel.appendChild(makeIndexedGroup(
    'Sprites', 8,
    (i) => String(i),
    (i, visible) => {
      if (visible) sprMask &= ~(1 << i); else sprMask |= (1 << i);
      wasm_retro_shell('denise set HIDDEN_SPRITES ' + sprMask);
    },
  ));
  panel.appendChild(makeIndexedGroup(
    'Audio', 4,
    (i) => String(i),
    (i, enabled) => wasm_retro_shell('audio set VOL' + i + ' ' + (enabled ? '100' : '0')),
  ));
}
