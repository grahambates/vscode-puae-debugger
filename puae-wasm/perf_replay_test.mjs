import fs from "node:fs";
import createPuaeModule from "../puae/puae.js";
import { tryExec, getCurrentProcess } from "../puae/puae_rpc.js";

// Stage 2a validation for Phase 2 (exact-instruction rewind via checkpoint +
// replay): capture a snapshot, free-run ~1 emulated second (50 frames)
// recording the instrCount delta and resulting regs, restore the snapshot,
// then call wasm_replay_instructions(delta) and confirm the resulting regs
// and instrCount exactly match the pre-restore "future" state. Also reports
// replay throughput against the ~17ms estimate from the feasibility analysis.

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
for (let i = 0; i < 2000 && !attached; i++) {
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

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`OK   ${label}`);
  } else {
    failures++;
    console.log(`FAIL ${label}${detail ? " — " + detail : ""}`);
  }
}

function readInstrCount() {
  M._wasm_read_instr_count();
  const lo = M._wasm_get_instr_count_lo();
  const hi = M._wasm_get_instr_count_hi();
  return (BigInt(hi) << 32n) | BigInt(lo >>> 0);
}

// instrCount is not part of the libretro savestate; must be restored
// explicitly after wasm_unserialize.
function writeInstrCount(value) {
  const lo = Number(value & 0xFFFFFFFFn);
  const hi = Number((value >> 32n) & 0xFFFFFFFFn);
  M._wasm_write_instr_count(lo, hi);
}

function readRegs() {
  const n = M._wasm_read_regs();
  const ptr = M._wasm_get_reg_buf();
  return Array.from(new Uint32Array(M.HEAPU32.buffer, ptr, n));
}

function captureSnapshot() {
  const size = M._wasm_serialize_size();
  const ptr = M._malloc(size);
  try {
    if (!M._wasm_serialize(ptr, size)) throw new Error("wasm_serialize failed");
    return new Uint8Array(M.HEAPU8.buffer, ptr, size).slice();
  } finally {
    M._free(ptr);
  }
}

function restoreSnapshot(bytes) {
  const ptr = M._malloc(bytes.length);
  try {
    M.HEAPU8.set(bytes, ptr);
    if (!M._wasm_unserialize(ptr, bytes.length)) throw new Error("wasm_unserialize failed");
  } finally {
    M._free(ptr);
  }
}

function hex(value) {
  return "0x" + (value >>> 0).toString(16).padStart(8, "0");
}

// --- Run a few frames to settle into the program proper, then capture a
// baseline snapshot. ---
for (let i = 0; i < 10; i++) M._wasm_tick();

const instrCount0 = readInstrCount();
const regs0 = readRegs();
const snapshot0 = captureSnapshot();

// --- Free-run ~1 emulated second (50 frames at PAL_FPS), recording the
// "future" state. ---
const FRAMES = 50;
for (let i = 0; i < FRAMES; i++) M._wasm_tick();

const instrCount1 = readInstrCount();
const regs1 = readRegs();

check(
  "instrCount advanced during free-run",
  instrCount1 > instrCount0,
  `instrCount0=${instrCount0} instrCount1=${instrCount1}`,
);

const delta = instrCount1 - instrCount0;
console.log(`instrCount delta over ${FRAMES} frames: ${delta}`);
check("delta fits in uint32", delta > 0n && delta <= 0xFFFFFFFFn, `delta=${delta}`);

// --- Restore the baseline snapshot, confirm we're back at instrCount0/regs0. ---
restoreSnapshot(snapshot0);
writeInstrCount(instrCount0);

const instrCountRestored = readInstrCount();
const regsRestored = readRegs();
check(
  "restore lands back at instrCount0",
  instrCountRestored === instrCount0,
  `instrCountRestored=${instrCountRestored} instrCount0=${instrCount0}`,
);
check(
  "restore lands back at regs0 (exact)",
  JSON.stringify(regsRestored) === JSON.stringify(regs0),
  `pc restored=${hex(regsRestored[17])} expected=${hex(regs0[17])}`,
);

// --- Replay forward exactly `delta` instructions; should land exactly on
// the recorded "future" state (instrCount1/regs1). ---
const t0 = Date.now();
M._wasm_replay_instructions(Number(delta));
const t1 = Date.now();
const replayMs = t1 - t0;

const instrCount2 = readInstrCount();
const regs2 = readRegs();

check(
  "replay lands exactly on instrCount1",
  instrCount2 === instrCount1,
  `instrCount2=${instrCount2} instrCount1=${instrCount1}`,
);
check(
  "replay lands exactly on regs1 (exact)",
  JSON.stringify(regs2) === JSON.stringify(regs1),
  `pc replayed=${hex(regs2[17])} expected=${hex(regs1[17])}`,
);

console.log(`replay of ${delta} instructions took ${replayMs}ms`);

console.log("");
console.log(failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
