import fs from "node:fs";
import createPuaeModule from "../puae/puae.js";
import { setupRpcDispatcher, tryExec, getCurrentProcess } from "../puae/puae_rpc.js";

// Matches puae_app.js's CHECKPOINT_INTERVAL_FRAMES (PAL_FPS = 50): one
// rpc.pushSnapshot() checkpoint per emulated second during a free-run.
const CHECKPOINT_INTERVAL_FRAMES = 50;
const STEADY_TICKS = 300;

async function run(label, memConfigLines) {
  const M = await createPuaeModule();
  M.FS.mkdir("/uae_system");
  M.FS.writeFile("/uae_system/kick34005.A500", fs.readFileSync("../puae/kick34005.A500"));
  M.FS.writeFile(
    "/uae_system/puae_libretro_global.uae",
    `filesystem=rw,dh0:/uae_system/dh0\nnr_floppies=0\nfloppy0type=-1\n${memConfigLines}\n`,
  );
  M.FS.mkdir("/uae_system/dh0");
  M.FS.writeFile("/uae_system/dh0/file", fs.readFileSync("./hunk.exe"));
  M.FS.mkdir("/uae_system/dh0/s");
  M.FS.writeFile("/uae_system/dh0/s/startup-sequence", "file");

  M.ccall("wasm_boot", "number", ["string"], [""]);

  // Boot + attach to the running program (see perf_cpu_test2.mjs).
  let execReady = false, attached = false, allocMemAddr = 0;
  for (let i = 0; i < 500 && !attached; i++) {
    M._wasm_tick();
    if (!execReady) {
      const r = tryExec(M);
      if (r.ready) { execReady = true; allocMemAddr = r.allocMemAddr; }
    }
    if (M._wasm_is_paused()) {
      if (execReady) {
        const proc = getCurrentProcess(M);
        if (proc) { M._wasm_remove_breakpoint(allocMemAddr); attached = true; }
        else M._wasm_resume();
      } else M._wasm_resume();
    }
  }

  const rpc = setupRpcDispatcher(M, () => {});

  // Warm up the JIT with an untimed pass before either measurement, so
  // ordering doesn't bias the comparison.
  for (let i = 0; i < STEADY_TICKS; i++) M._wasm_tick();

  // Baseline: steady-state ms/tick with no checkpoints.
  const t0 = Date.now();
  for (let i = 0; i < STEADY_TICKS; i++) M._wasm_tick();
  const t1 = Date.now();
  const baselineMsPerTick = (t1 - t0) / STEADY_TICKS;

  // Cost of a single rpc.pushSnapshot() checkpoint (retro_serialize +
  // _malloc/.slice()/_free), measured directly and averaged over several
  // samples — ticking between samples so each capture is over fresh state.
  const NUM_SAMPLES = 10;
  const t2 = Date.now();
  for (let i = 0; i < NUM_SAMPLES; i++) {
    for (let j = 0; j < CHECKPOINT_INTERVAL_FRAMES; j++) M._wasm_tick();
    rpc.pushSnapshot();
  }
  const t3 = Date.now();
  const msPerWindow = (t3 - t2) / NUM_SAMPLES;
  const msPerCheckpoint = msPerWindow - CHECKPOINT_INTERVAL_FRAMES * baselineMsPerTick;

  // The real-time deadline that matters is the per-frame budget at PAL_FPS
  // (50Hz = 20ms/frame): a checkpoint happens on one frame out of every
  // CHECKPOINT_INTERVAL_FRAMES, and frame()'s 2-frame catch-up cap absorbs an
  // occasional overrun of that single frame's budget.
  const FRAME_BUDGET_MS = 1000 / 50;
  const overheadPctOfFrame = (msPerCheckpoint / FRAME_BUDGET_MS) * 100;

  console.log(
    `${label}: baseline=${baselineMsPerTick.toFixed(3)}ms/tick, ` +
    `checkpoint capture=${msPerCheckpoint.toFixed(2)}ms ` +
    `(${overheadPctOfFrame.toFixed(0)}% of one ${FRAME_BUDGET_MS}ms frame budget, ` +
    `occurring once per ${CHECKPOINT_INTERVAL_FRAMES} frames)`,
  );
}

await run("default (2MB chip, 2MB fast)", "chipmem_size=4\nfastmem_size=2");
await run("larger (2MB chip, 8MB fast)", "chipmem_size=4\nfastmem_size=8");
