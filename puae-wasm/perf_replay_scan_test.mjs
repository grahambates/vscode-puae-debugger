import fs from "node:fs";
import createPuaeModule from "../puae/puae.js";
import { tryExec, getCurrentProcess } from "../puae/puae_rpc.js";

// Stage 2b validation: wasm_replay_scan(count) should behave like
// wasm_replay_instructions(count) (landing exactly on instrCount0 + count),
// but additionally report the instrCount of the *latest* (most recent in
// forward time) instruction within the scanned range whose PC has a
// breakpoint set, or the UINT64_MAX sentinel if none matched.

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

function replayScan(count) {
  M._wasm_replay_scan(count);
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

// --- Free-run ~1 emulated second, recording the "future" instrCount/regs and
// the CPU trace covering the replayed range. ---
const FRAMES = 50;
for (let i = 0; i < FRAMES; i++) M._wasm_tick();

const instrCount1 = readInstrCount();
const regs1 = readRegs();
const delta = instrCount1 - instrCount0;
console.log(`instrCount delta over ${FRAMES} frames: ${delta}`);

const E9K_CPU_TRACE_CAP = 256;
M._wasm_read_cpu_trace(E9K_CPU_TRACE_CAP);
{
  const ptr = M._wasm_get_cpu_trace_buf();
  const words = new Uint32Array(M.HEAPU32.buffer, ptr, E9K_CPU_TRACE_CAP * 2);
  // trace[0] = most recently retired instruction, i.e. instrCount1 - 1.
  const TRACE_INDEX = 5;
  const targetPc = words[TRACE_INDEX * 2] >>> 0;
  const targetInstrCount = instrCount1 - 1n - BigInt(TRACE_INDEX);

  console.log(`target: pc=${hex(targetPc)} instrCount=${targetInstrCount}`);

  // --- Sentinel case: a breakpoint that never matches anywhere in range. ---
  restoreSnapshot(snapshot0);
  writeInstrCount(instrCount0);
  M._wasm_add_breakpoint(0x00f80000); // unused address, never executed
  const noMatch = replayScan(Number(delta));
  check("no-match scan returns UINT64_MAX sentinel", noMatch === UINT64_MAX, `noMatch=${noMatch}`);
  check(
    "no-match scan still advances instrCount exactly like replay_instructions",
    readInstrCount() === instrCount1,
    `instrCount=${readInstrCount()} expected=${instrCount1}`,
  );
  M._wasm_remove_breakpoint(0x00f80000);

  // --- Real match case: breakpoint at a PC visited mid-range. ---
  restoreSnapshot(snapshot0);
  writeInstrCount(instrCount0);
  M._wasm_add_breakpoint(targetPc);
  const match = replayScan(Number(delta));
  console.log(`match=${match} (targetInstrCount=${targetInstrCount}, instrCount0=${instrCount0}, instrCount1=${instrCount1})`);
  check("match found within scanned range", match !== UINT64_MAX, `match=${match}`);
  check(
    "match is within [instrCount0, instrCount1)",
    match >= instrCount0 && match < instrCount1,
    `match=${match} range=[${instrCount0},${instrCount1})`,
  );
  check(
    "match is the LATEST occurrence (>= the trace-derived target)",
    match >= targetInstrCount,
    `match=${match} targetInstrCount=${targetInstrCount}`,
  );

  // --- Restoring + replaying to `match` should land exactly on a PC with the
  // breakpoint set (continueReverse's actual usage pattern). ---
  restoreSnapshot(snapshot0);
  writeInstrCount(instrCount0);
  M._wasm_replay_instructions(Number(match - instrCount0));
  const landedPc = readRegs()[17] >>> 0;
  check(
    "restore+replay to match lands exactly on the breakpointed PC",
    landedPc === targetPc,
    `landedPc=${hex(landedPc)} targetPc=${hex(targetPc)}`,
  );
  check(
    "restore+replay to match leaves instrCount == match",
    readInstrCount() === match,
    `instrCount=${readInstrCount()} match=${match}`,
  );
  M._wasm_remove_breakpoint(targetPc);
}

// --- Sanity: forward replay still lands exactly on regs1 afterwards (scan
// mode doesn't leave any stray state behind). ---
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
