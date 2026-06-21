// RPC dispatcher for the vAmiga wasm backend — ported from the
// `window.addEventListener('message', ...)` block in the original
// vAmiga_ui.js (jQuery/Bootstrap UI removed elsewhere; this dispatcher itself
// had no UI dependency). Mirrors puae_rpc.js's shape: requests
// `{ command, args: { _rpcId?, ...} }`, responses
// `{ type: 'rpcResponse', id, result }`.
//
// `state` is a small mutable object shared with vamiga_app.js's boot logic
// (execReady/attached/startSnapshot are set there during the fastLoad/
// AllocMem-breakpoint warm-up; callParams/breakpoints/snapshotHistory are
// owned here). `wasmRun`/`wasmHalt`/`renderCanvas` are callbacks supplied by
// vamiga_app.js because they also touch the emulation worker and post
// `emulator-state` messages — responsibilities that belong with the render
// loop, not the RPC layer.

const REPLAY_NO_MATCH = 0xffffffffffffffffn;

export function setupRpcDispatcher(M, postMessage, { state, wasmRun, wasmHalt, renderCanvas }) {
  const cwrap = (name, ret, args = []) => M.cwrap(name, ret, args);

  const wasm_set_breakpoint = cwrap('wasm_set_breakpoint', 'boolean', ['number', 'number']);
  const wasm_remove_breakpoint = cwrap('wasm_remove_breakpoint', 'boolean', ['number']);
  const wasm_set_watchpoint = cwrap('wasm_set_watchpoint', 'boolean', ['number', 'number']);
  const wasm_remove_watchpoint = cwrap('wasm_remove_watchpoint', 'boolean', ['number']);
  const wasm_set_catchpoint = cwrap('wasm_set_catchpoint', 'boolean', ['number', 'number']);
  const wasm_remove_catchpoint = cwrap('wasm_remove_catchpoint', 'boolean', ['number']);
  const wasm_enable_cpu_logging = cwrap('wasm_enable_cpu_logging', 'boolean', ['boolean']);
  const wasm_get_cpu_trace = cwrap('wasm_get_cpu_trace', 'string', ['number']);
  const wasm_step_into = cwrap('wasm_step_into', 'undefined');
  const wasm_get_cpu_info = cwrap('wasm_get_cpu_info', 'string');
  const wasm_get_memory_info = cwrap('wasm_get_memory_info', 'string');
  const wasm_get_all_custom_registers = cwrap('wasm_get_all_custom_registers', 'string');
  const wasm_set_register = cwrap('wasm_set_register', 'string', ['string', 'number']);
  const wasm_poke_custom16 = cwrap('wasm_poke_custom16', 'undefined', ['number', 'number']);
  const wasm_poke_custom32 = cwrap('wasm_poke_custom32', 'undefined', ['number', 'number']);
  const wasm_disassemble = cwrap('wasm_disassemble', 'string', ['number', 'number']);
  const wasm_disassemble_copper = cwrap('wasm_disassemble_copper', 'string', ['number', 'number']);
  const wasm_peek8 = cwrap('wasm_peek8', 'number', ['number']);
  const wasm_peek16 = cwrap('wasm_peek16', 'number', ['number']);
  const wasm_peek32 = cwrap('wasm_peek32', 'number', ['number']);
  const wasm_poke8 = cwrap('wasm_poke8', 'undefined', ['number']);
  const wasm_poke16 = cwrap('wasm_poke16', 'undefined', ['number']);
  const wasm_poke32 = cwrap('wasm_poke32', 'undefined', ['number']);
  const wasm_jump = cwrap('wasm_jump', 'string', ['number']);
  const wasm_configure = cwrap('wasm_configure', 'string', ['string', 'string']);
  const wasm_reset = cwrap('wasm_reset', 'undefined');
  const wasm_take_user_snapshot = cwrap('wasm_take_user_snapshot', 'string');
  const wasm_delete_user_snapshot = cwrap('wasm_delete_user_snapshot', 'undefined');
  const wasm_profile_start = cwrap('wasm_profile_start', 'number', ['number']);
  const wasm_profile_stop = cwrap('wasm_profile_stop', 'undefined');

  function wasm_loadfile(fileName, fileBuffer) {
    const ptr = M._malloc(fileBuffer.byteLength);
    try {
      M.HEAPU8.set(fileBuffer, ptr);
      return M.ccall('wasm_loadFile', 'string', ['string', 'number', 'number', 'number'], [fileName, ptr, fileBuffer.byteLength, 0]);
    } finally {
      M._free(ptr);
    }
  }

  function wasm_read_memory(address, count) {
    const dataPtr = M._wasm_read_memory(address, count);
    if (!dataPtr) throw new Error(`Error getting memory ptr for address 0x${address.toString(16)}`);
    const data = new Uint8Array(new Uint8Array(M.HEAPU8.buffer, dataPtr, count));
    M._free(dataPtr);
    return data;
  }

  function wasm_write_memory(address, dataToWrite) {
    const writePtr = M._malloc(dataToWrite.length);
    M.HEAPU8.set(dataToWrite, writePtr);
    const success = M._wasm_write_memory(address, writePtr, dataToWrite.length);
    M._free(writePtr);
    if (!success) throw new Error(`Error writing memory at address 0x${address.toString(16)}`);
  }

  function wasm_profile_set_unwind(buffer, startAddr, endAddr) {
    const ptr = M._malloc(buffer.length);
    let ok;
    try {
      M.HEAPU8.set(buffer, ptr);
      ok = M._wasm_profile_set_unwind(ptr, buffer.length, startAddr, endAddr);
    } finally {
      M._free(ptr);
    }
    if (!ok) throw new Error('wasm_profile_set_unwind failed');
  }

  function wasm_profile_get_data() {
    const obj = JSON.parse(M.ccall('wasm_profile_get_data', 'string', [], []));
    const view = new Uint8Array(M.HEAPU8.buffer, obj.address, obj.size);
    return { data: new Uint8Array(view), start: obj.start, end: obj.end, total: obj.total, inRange: obj.inRange, frameCycles: obj.frameCycles, isPAL: obj.isPAL };
  }

  function wasm_dma_get_data() {
    const obj = JSON.parse(M.ccall('wasm_dma_get_data', 'string', [], []));
    return { data: new Uint8Array(new Uint8Array(M.HEAPU8.buffer, obj.address, obj.size)) };
  }

  function wasm_dma_get_snapshot() {
    const obj = JSON.parse(M.ccall('wasm_dma_get_snapshot', 'string', [], []));
    const chip = obj.chipLen ? new Uint8Array(new Uint8Array(M.HEAPU8.buffer, obj.chipAddr, obj.chipLen)) : new Uint8Array(0);
    const slow = obj.slowLen ? new Uint8Array(new Uint8Array(M.HEAPU8.buffer, obj.slowAddr, obj.slowLen)) : new Uint8Array(0);
    return { chip, slow };
  }

  // --- Time-travel replay helpers ---

  function readInstrCount() {
    M._wasm_read_instr_count();
    const lo = M._wasm_get_instr_count_lo();
    const hi = M._wasm_get_instr_count_hi();
    return (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
  }

  function replayInstructionsVideo(count) {
    M._wasm_replay_instructions_video(Number(count));
    renderCanvas();
  }

  function replayScan(count) {
    if (count <= 0n) return null;
    M._wasm_replay_scan(Number(count));
    const lo = M._wasm_get_replay_scan_lo();
    const hi = M._wasm_get_replay_scan_hi();
    const match = (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
    return match === REPLAY_NO_MATCH ? null : match;
  }

  function replayScanFrame(count) {
    if (count <= 0n) return null;
    M._wasm_replay_scan_frame(Number(count));
    const lo = M._wasm_get_replay_scan_lo();
    const hi = M._wasm_get_replay_scan_hi();
    const match = (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
    return match === REPLAY_NO_MATCH ? null : match;
  }

  // Loading a snapshot wipes the framebuffer (PixelEngine::_didLoad ->
  // clearAll(), since pixel data isn't part of the serialized snapshot), so a
  // short replay only repaints the handful of scanlines it actually executes
  // and leaves the rest of the frame blank/transparent. When two history
  // entries (e.g. consecutive breakpoint hits) are close together, the
  // closest one isn't enough — walk back to an earlier entry so the replay
  // spans at least a full frame's worth of instructions before landing on
  // targetCount, purely for a complete repaint (CPU/memory state at
  // targetCount is identical regardless of which entry we replay from).
  const MIN_RENDER_REPLAY = 20000n;
  function renderAt(historyIndex, targetCount) {
    let renderIndex = historyIndex;
    while (renderIndex > 0 &&
           targetCount - state.snapshotHistory[renderIndex].instrCount < MIN_RENDER_REPLAY) {
      renderIndex--;
    }
    const renderEntry = state.snapshotHistory[renderIndex];
    wasm_loadfile('stepback.vAmiga', renderEntry.data);
    wasm_configure('WARP_MODE', 'NEVER');
    replayInstructionsVideo(targetCount - renderEntry.instrCount);
  }

  // Exported so vamiga_app.js's boot logic (periodic snapshots, handleStop)
  // can take a snapshot too without duplicating this logic.
  function pushSnapshot() {
    try {
      const snap = JSON.parse(wasm_take_user_snapshot());
      const data = new Uint8Array(new Uint8Array(M.HEAPU8.buffer, snap.address, snap.size));
      const instrCount = readInstrCount();

      if (state.snapshotIndex < state.snapshotHistory.length - 1) {
        state.snapshotHistory = state.snapshotHistory.slice(0, state.snapshotIndex + 1);
      }
      while (state.snapshotHistory.length > 0 &&
             state.snapshotHistory[state.snapshotHistory.length - 1].instrCount >= instrCount) {
        state.snapshotHistory.pop();
      }

      state.snapshotHistory.push({ data, instrCount });
      const MAX_SNAPSHOTS = 50;
      if (state.snapshotHistory.length > MAX_SNAPSHOTS) {
        state.snapshotHistory.shift();
      }
      state.snapshotIndex = state.snapshotHistory.length - 1;

      wasm_delete_user_snapshot();
    } catch (err) {
      console.error('Failed to take snapshot:', err);
    }
  }

  function handleMessage(message) {
    if (!message || !message.command) return;
    const args = message.args || {};

    const rpcRequest = async (resultCb) => {
      const res = { type: 'rpcResponse', id: args._rpcId };
      try {
        res.result = await resultCb();
      } catch (error) {
        res.result = { error: error.message };
      }
      postMessage(res);
    };

    switch (message.command) {
      case 'pause':
        wasmHalt();
        pushSnapshot();
        break;
      case 'run':
        wasmRun();
        break;
      case 'setBreakpoint':
        wasm_set_breakpoint(args.address, args.ignores);
        state.breakpoints.add(args.address);
        break;
      case 'removeBreakpoint':
        wasm_remove_breakpoint(args.address);
        state.breakpoints.delete(args.address);
        break;
      case 'setWatchpoint':
        wasm_set_watchpoint(args.address, args.ignores);
        break;
      case 'removeWatchpoint':
        wasm_remove_watchpoint(args.address);
        break;
      case 'setCatchpoint':
        wasm_set_catchpoint(args.vector);
        break;
      case 'removeCatchpoint':
        wasm_remove_catchpoint(args.vector);
        break;
      case 'eol':
        M._wasm_eol();
        wasmRun();
        break;
      case 'eof':
        M._wasm_eof();
        wasmRun();
        break;
      case 'stepInto':
        wasm_step_into();
        wasmRun();
        break;
      case 'enableCpuLogging':
        wasm_enable_cpu_logging(args.enabled);
        break;
      case 'getCpuTrace':
        rpcRequest(() => JSON.parse(wasm_get_cpu_trace(args.count)));
        break;
      case 'profileSetUnwind':
        rpcRequest(() => { wasm_profile_set_unwind(args.data, args.startAddr, args.endAddr); return { ok: true }; });
        break;
      case 'startProfiling':
        rpcRequest(() => ({ ok: !!wasm_profile_start(args.numFrames ?? 1) }));
        break;
      case 'stopProfiling':
        rpcRequest(() => { wasm_profile_stop(); return { ok: true }; });
        break;
      case 'getProfileData':
        rpcRequest(() => wasm_profile_get_data());
        break;
      case 'getDmaData':
        rpcRequest(() => wasm_dma_get_data());
        break;
      case 'getDmaSnapshot':
        rpcRequest(() => wasm_dma_get_snapshot());
        break;
      case 'stepBack':
        rpcRequest(() => {
          if (state.snapshotHistory.length === 0) return false;
          const current = readInstrCount();
          const target = current - 1n;
          if (target < state.snapshotHistory[0].instrCount) return false;
          let i = state.snapshotHistory.length - 1;
          while (state.snapshotHistory[i].instrCount > target) i--;
          renderAt(i, target);
          state.snapshotIndex = i;
          return true;
        });
        break;
      case 'continueReverse':
        rpcRequest(async () => {
          if (state.snapshotHistory.length === 0) return false;
          const current = readInstrCount();
          const target = current - 1n;
          if (target < state.snapshotHistory[0].instrCount) return false;
          let i = state.snapshotHistory.length - 1;
          while (i >= 0 && state.snapshotHistory[i].instrCount > target) i--;
          for (; i >= 0; i--) {
            const entry = state.snapshotHistory[i];
            const next = state.snapshotHistory[i + 1];
            const upper = (next && next.instrCount <= target) ? next.instrCount : target;
            wasm_loadfile('stepback.vAmiga', entry.data);
            wasm_configure('WARP_MODE', 'NEVER');
            // The scan below only checks positions reached by executing
            // forward from this snapshot, never the snapshot's own PC. Since
            // snapshots are taken at breakpoint stops, that PC is often
            // itself the match we're looking for (e.g. the oldest snapshot
            // in history, which no earlier chunk's scan covers).
            const ownPc = parseInt(JSON.parse(wasm_get_cpu_info()).pc, 16);
            const selfMatch = state.breakpoints.has(ownPc) ? entry.instrCount : null;
            const match = replayScan(upper - entry.instrCount) ?? selfMatch;
            await new Promise((r) => setTimeout(r, 0));
            if (match !== null) {
              renderAt(i, match);
              state.snapshotIndex = i;
              return true;
            }
          }
          renderAt(0, state.snapshotHistory[0].instrCount);
          state.snapshotIndex = 0;
          return false;
        });
        break;
      case 'stepBackFrame':
        rpcRequest(() => {
          if (state.snapshotHistory.length === 0) return false;
          const current = readInstrCount();
          const target = current - 1n;
          if (target < state.snapshotHistory[0].instrCount) return false;
          let i = state.snapshotHistory.length - 1;
          while (i >= 0 && state.snapshotHistory[i].instrCount > target) i--;
          for (; i >= 0; i--) {
            const entry = state.snapshotHistory[i];
            wasm_loadfile('stepback.vAmiga', entry.data);
            wasm_configure('WARP_MODE', 'NEVER');
            const match = replayScanFrame(target - entry.instrCount);
            if (match !== null) {
              renderAt(i, match);
              state.snapshotIndex = i;
              return true;
            }
          }
          return false;
        });
        break;
      case 'getCpuInfo':
        rpcRequest(() => JSON.parse(wasm_get_cpu_info()));
        break;
      case 'getMemoryInfo':
        rpcRequest(() => JSON.parse(wasm_get_memory_info()));
        break;
      case 'getAllCustomRegisters':
        rpcRequest(() => JSON.parse(wasm_get_all_custom_registers()));
        break;
      case 'setRegister':
        rpcRequest(() => JSON.parse(wasm_set_register(args.name, args.value)));
        break;
      case 'pokeCustom16':
        rpcRequest(() => wasm_poke_custom16(args.address, args.value));
        break;
      case 'pokeCustom32':
        rpcRequest(() => wasm_poke_custom32(args.address, args.value));
        break;
      case 'readMemory':
        rpcRequest(() => ({ data: wasm_read_memory(args.address, args.count) }));
        break;
      case 'writeMemory':
        rpcRequest(() => wasm_write_memory(args.address, args.data));
        break;
      case 'disassemble':
        rpcRequest(() => JSON.parse(wasm_disassemble(args.address, args.count)));
        break;
      case 'disassembleCopper':
        rpcRequest(() => JSON.parse(wasm_disassemble_copper(args.address, args.count)));
        break;
      case 'peek32':
        rpcRequest(() => wasm_peek32(args.address));
        break;
      case 'peek16':
        rpcRequest(() => wasm_peek16(args.address));
        break;
      case 'peek8':
        rpcRequest(() => wasm_peek8(args.address));
        break;
      case 'poke32':
        rpcRequest(() => wasm_poke32(args.address, args.value));
        break;
      case 'poke16':
        rpcRequest(() => wasm_poke16(args.address, args.value));
        break;
      case 'poke8':
        rpcRequest(() => wasm_poke8(args.address, args.value));
        break;
      case 'jump':
        rpcRequest(() => { wasm_jump(args.address); wasm_set_register('sr', 0); pushSnapshot(); });
        break;
      case 'load':
        rpcRequest(async () => {
          state.snapshotHistory = [];
          state.snapshotIndex = -1;
          state.callParams = args;
          if (args.url) {
            state.attached = false;
            state.execReady = false;
            const res = await fetch(args.url);
            const data = await res.arrayBuffer();
            const filename = args.url.split('/').pop();
            wasm_loadfile(filename, new Uint8Array(data));
            wasm_reset();
            wasm_configure('WARP_MODE', 'ALWAYS');
          } else if (state.startSnapshot) {
            wasm_loadfile('start.vAmiga', state.startSnapshot);
            wasmHalt(false);
            wasm_configure('WARP_MODE', 'NEVER');
            postMessage({ type: 'exec-ready' });
          }
        });
        break;
      default:
        postMessage({ type: 'error', text: `Unknown command: ${message.command}` });
    }
  }

  return { handleMessage, pushSnapshot, readInstrCount };
}
