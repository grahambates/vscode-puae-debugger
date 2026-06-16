import fs from "node:fs";
import createPuaeModule from "../../puae/puae.js";
import { tryExec, getCurrentProcess } from "../../puae/puae_rpc.js";

// Phase 3 validation: wasm_replay_scan_frame(count) should behave like
// wasm_replay_instructions(count) (landing exactly on instrCount0 + count),
// but additionally report the instrCount of the *latest* (most recent in
// forward time) frame boundary (vblank) crossed within the scanned range, or
// the UINT64_MAX sentinel if none was crossed. Used by stepBackFrame.

const M = await createPuaeModule();
M.FS.mkdir("/uae_system");
M.FS.writeFile("/uae_system/kick34005.A500", fs.readFileSync(new URL("../../puae/kick34005.A500", import.meta.url).pathname));
M.FS.writeFile(
  "/uae_system/puae_libretro_global.uae",
  "filesystem=rw,dh0:/uae_system/dh0\nnr_floppies=0\nfloppy0type=-1\nchipmem_size=4\nfastmem_size=2\n",
);
M.FS.mkdir("/uae_system/dh0");
M.FS.writeFile("/uae_system/dh0/file", fs.readFileSync(new URL("../hunk.exe", import.meta.url).pathname));
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

const UINT64_MAX = (1n << 64n) - 1n;

function readInstrCount() {
  M._wasm_read_instr_count();
  const lo = M._wasm_get_instr_count_lo();
  const hi = M._wasm_get_instr_count_hi();
  return (BigInt(hi) << 32n) | BigInt(lo >>> 0);
}

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

function replayScanFrame(count) {
  M._wasm_replay_scan_frame(count);
  const lo = M._wasm_get_replay_scan_match_lo();
  const hi = M._wasm_get_replay_scan_match_hi();
  return (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
}

function hex(value) {
  return "0x" + (value >>> 0).toString(16).padStart(8, "0");
}

// --- Settle, then capture a baseline snapshot. ---
for (let i = 0; i < 10; i++) M._wasm_tick();

const instrCount0 = readInstrCount();
const snapshot0 = captureSnapshot();

// --- Free-run ~1 emulated second (~50 vblanks), recording the "future"
// instrCount/regs covering the replayed range. ---
const FRAMES = 50;
for (let i = 0; i < FRAMES; i++) M._wasm_tick();

const instrCount1 = readInstrCount();
const regs1 = readRegs();
const delta = instrCount1 - instrCount0;
console.log(`instrCount delta over ${FRAMES} frames: ${delta}`);

// --- Scan [instrCount0, instrCount1) for the latest frame boundary. ---
restoreSnapshot(snapshot0);
writeInstrCount(instrCount0);
const match = replayScanFrame(Number(delta));
console.log(`match=${match} (instrCount0=${instrCount0}, instrCount1=${instrCount1})`);

check("a frame boundary was found within ~50 frames", match !== UINT64_MAX, `match=${match}`);
check(
  "match is within [instrCount0, instrCount1)",
  match >= instrCount0 && match < instrCount1,
  `match=${match} range=[${instrCount0},${instrCount1})`,
);
check(
  "scan still advances instrCount exactly like replay_instructions",
  readInstrCount() === instrCount1,
  `instrCount=${readInstrCount()} expected=${instrCount1}`,
);

// --- Determinism: re-running the same scan from the same checkpoint finds
// the same boundary. ---
restoreSnapshot(snapshot0);
writeInstrCount(instrCount0);
const match2 = replayScanFrame(Number(delta));
check("re-scanning the same range finds the same boundary", match2 === match, `match=${match} match2=${match2}`);

// --- Restoring + replaying to `match` lands exactly on the same state both
// times (deterministic landing). ---
restoreSnapshot(snapshot0);
writeInstrCount(instrCount0);
M._wasm_replay_instructions(Number(match - instrCount0));
const landedRegs = readRegs();

restoreSnapshot(snapshot0);
writeInstrCount(instrCount0);
M._wasm_replay_instructions(Number(match - instrCount0));
const landedRegs2 = readRegs();

check(
  "restore+replay to match lands on the same state both times",
  JSON.stringify(landedRegs) === JSON.stringify(landedRegs2),
  `pc=${hex(landedRegs[17])} pc2=${hex(landedRegs2[17])}`,
);
check(
  "restore+replay to match leaves instrCount == match",
  readInstrCount() === match,
  `instrCount=${readInstrCount()} match=${match}`,
);

// --- Sanity: forward replay of the full range still lands exactly on regs1
// afterwards (scan mode doesn't leave any stray state behind). ---
restoreSnapshot(snapshot0);
writeInstrCount(instrCount0);
M._wasm_replay_instructions(Number(delta));
const regs2 = readRegs();
check(
  "replay after scan still lands exactly on regs1 (exact)",
  JSON.stringify(regs2) === JSON.stringify(regs1),
  `pc replayed=${hex(regs2[17])} expected=${hex(regs1[17])}`,
);

console.log("");
console.log(failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
