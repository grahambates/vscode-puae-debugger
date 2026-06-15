import fs from "node:fs";
import createPuaeModule from "../puae/puae.js";
import { tryExec, getCurrentProcess } from "../puae/puae_rpc.js";

// Exploratory/throwaway: measure raw cost of single-instruction stepping
// (wasm_step_instr + tick-until-paused), to ground Phase 2 feasibility
// (replay-N-instructions-from-checkpoint for exact stepBack across a
// periodic-checkpoint boundary).
const M = await createPuaeModule();
M.FS.mkdir("/uae_system");
M.FS.writeFile("/uae_system/kick34005.A500", fs.readFileSync("../puae/kick34005.A500"));
M.FS.writeFile(
  "/uae_system/puae_libretro_global.uae",
  "filesystem=rw,dh0:/uae_system/dh0\nnr_floppies=0\nfloppy0type=-1\nchipmem_size=4\nfastmem_size=2\n",
);
M.FS.mkdir("/uae_system/dh0");
M.FS.writeFile("/uae_system/dh0/file", fs.readFileSync("./hunk.exe"));
M.FS.mkdir("/uae_system/dh0/s");
M.FS.writeFile("/uae_system/dh0/s/startup-sequence", "file");

M.ccall("wasm_boot", "number", ["string"], [""]);

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

M._wasm_pause();

function stepInstr() {
  M._wasm_step_instr();
  for (let i = 0; i < 4; i++) {
    M._wasm_tick();
    if (M._wasm_is_paused()) break;
  }
}

// Warm up.
for (let i = 0; i < 1000; i++) stepInstr();

const N = 20000;
const t0 = Date.now();
for (let i = 0; i < N; i++) stepInstr();
const t1 = Date.now();
const msPerInstr = (t1 - t0) / N;

console.log(`stepInstr: ${msPerInstr.toFixed(4)} ms/instruction (${N} instructions in ${t1 - t0}ms)`);
console.log(`-> replaying 1 emulated second of instructions at this rate would take roughly:`);
// Rough instruction-rate estimate: report for a few plausible avg cycles/instr
// at 7.09 MHz (PAL OCS clock).
for (const cyclesPerInstr of [4, 8, 12]) {
  const instrPerSec = 7_090_000 / cyclesPerInstr;
  const replayMs = instrPerSec * msPerInstr;
  console.log(`   ~${cyclesPerInstr} cycles/instr -> ~${instrPerSec.toFixed(0)} instr/s -> replay ${replayMs.toFixed(0)}ms`);
}
