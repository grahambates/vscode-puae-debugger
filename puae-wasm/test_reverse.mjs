import fs from "node:fs";
import createPuaeModule from "../puae/puae.js";
import { setupRpcDispatcher } from "../puae/puae_rpc.js";

const M = await createPuaeModule();

M.FS.mkdir("/uae_system");
M.FS.writeFile("/uae_system/kick34005.A500", fs.readFileSync("../puae/kick34005.A500"));
M.FS.writeFile("/uae_system/game.adf", fs.readFileSync("../puae/demo.adf"));

const ok = M.ccall("wasm_boot", "number", ["string"], ["/uae_system/game.adf"]);
console.log("wasm_boot ->", ok);

// Run enough frames to get past reset and the Kickstart ROM overlay (CIA OVL
// bit) — see test_g1.mjs for details.
for (let i = 0; i < 150; i++) M._wasm_tick();

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`OK   ${label}`);
  } else {
    failures++;
    console.log(`FAIL ${label}${detail ? " — " + detail : ""}`);
  }
}

// --- RPC harness: drives setupRpcDispatcher with a mock postMessage ---
const pending = new Map();
let nextRpcId = 1;

function postMessage(msg) {
  if (msg.type === "rpcResponse" && pending.has(msg.id)) {
    const resolve = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg.result);
  }
}

const rpc = setupRpcDispatcher(M, postMessage);

function send(command, args = {}) {
  rpc.handleMessage({ command, args });
}

function request(command, args = {}) {
  const _rpcId = String(nextRpcId++);
  return new Promise((resolve) => {
    pending.set(_rpcId, resolve);
    rpc.handleMessage({ command, args: { ...args, _rpcId } });
  });
}

// Full register snapshot (D0-D7, A0-A7, SR, PC, USP), for comparing state
// before/after stepBack/continueReverse.
function regsSnapshot() {
  const n = M._wasm_read_regs();
  const ptr = M._wasm_get_reg_buf();
  return Array.from(new Uint32Array(M.HEAPU32.buffer, ptr, n));
}

function hex(value) {
  return "0x" + (value >>> 0).toString(16).padStart(8, "0");
}

function readInstrCount() {
  M._wasm_read_instr_count();
  const lo = M._wasm_get_instr_count_lo();
  const hi = M._wasm_get_instr_count_hi();
  return (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
}

// --- 1. stepInto N times, recording the regs *before* each step, then
// stepBack the same number of times and check we land back on each prior
// state exactly (PC + all other regs). ---
const N = 5;
const statesBefore = [];
for (let i = 0; i < N; i++) {
  statesBefore.push(regsSnapshot());
  send("stepInto");
  check(`stepInto #${i} re-pauses`, M._wasm_is_paused() === 1);
}

for (let i = N - 1; i >= 0; i--) {
  const res = await request("stepBack");
  check(`stepBack #${N - 1 - i} returns true`, res === true);
  const after = regsSnapshot();
  check(
    `stepBack #${N - 1 - i} restores regs from before step #${i}`,
    JSON.stringify(after) === JSON.stringify(statesBefore[i]),
    `pc after=${hex(after[17])} expected=${hex(statesBefore[i][17])}`,
  );
}

// History is now exhausted (all N snapshots consumed).
{
  const res = await request("stepBack");
  check("stepBack returns false once history is exhausted", res === false);
}

// --- 2. continueReverse: walk back to a snapshot whose PC matches a
// breakpoint ---
// We're back at statesBefore[0]. Step forward twice, capturing the
// intermediate state (statesBefore[1]-equivalent) so we can set a breakpoint
// on its PC and confirm continueReverse stops there.
const stateAfter0 = regsSnapshot(); // == statesBefore[0]
check("back at the original state after exhausting stepBack history",
  JSON.stringify(stateAfter0) === JSON.stringify(statesBefore[0]));

send("stepInto"); // snapshot(state0), advance -> state1
const state1 = regsSnapshot();
send("stepInto"); // snapshot(state1), advance -> state2
const state2 = regsSnapshot();

check("state0/state1/state2 PCs are distinct",
  new Set([stateAfter0[17], state1[17], state2[17]]).size === 3,
  `${hex(stateAfter0[17])} ${hex(state1[17])} ${hex(state2[17])}`);

send("setBreakpoint", { address: state1[17] });
{
  const res = await request("continueReverse");
  check("continueReverse returns true", res === true);
  const after = regsSnapshot();
  check(
    "continueReverse stops at the snapshot whose PC matches the breakpoint",
    JSON.stringify(after) === JSON.stringify(state1),
    `pc after=${hex(after[17])} expected=${hex(state1[17])}`,
  );
}
send("removeBreakpoint", { address: state1[17] });

// --- 3. continueReverse: no matching breakpoint -> lands at start of
// history (oldest remaining snapshot), then returns false once exhausted ---
{
  const res = await request("continueReverse");
  check("continueReverse (no breakpoint match) returns true", res === true);
  const after = regsSnapshot();
  check(
    "continueReverse (no breakpoint match) lands at the oldest remaining snapshot",
    JSON.stringify(after) === JSON.stringify(stateAfter0),
    `pc after=${hex(after[17])} expected=${hex(stateAfter0[17])}`,
  );
}
{
  const res = await request("continueReverse");
  check("continueReverse returns false once history is exhausted", res === false);
}

// --- 4. Mid-interval exact stepBack: spanning >=2 periodic checkpoints, then
// pausing partway through the following interval (not at a checkpoint
// boundary). stepBack must land exactly one instruction earlier — verified
// both via instrCount and via an exact round-trip (stepping forward again
// reproduces the pre-stepBack state exactly). ---
{
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 5; j++) M._wasm_tick();
    rpc.pushSnapshot();
  }
  const lastCheckpointRegs = regsSnapshot();
  const lastCheckpointInstrCount = readInstrCount();

  for (let j = 0; j < 7; j++) M._wasm_tick();

  const preRegs = regsSnapshot();
  const preInstrCount = readInstrCount();
  check(
    "mid-interval test position is past the last checkpoint",
    preInstrCount > lastCheckpointInstrCount + 1n,
    `preInstrCount=${preInstrCount} lastCheckpointInstrCount=${lastCheckpointInstrCount}`,
  );

  const res = await request("stepBack");
  check("stepBack (mid-interval) returns true", res === true);

  check(
    "stepBack (mid-interval) decrements instrCount by exactly 1",
    readInstrCount() === preInstrCount - 1n,
    `instrCount after=${readInstrCount()} expected=${preInstrCount - 1n}`,
  );
  check(
    "stepBack (mid-interval) does not land on the last checkpoint's own state",
    JSON.stringify(regsSnapshot()) !== JSON.stringify(lastCheckpointRegs),
  );

  // Step forward exactly one instruction and confirm it reproduces the
  // pre-stepBack state exactly (round-trip).
  M._wasm_step_instr();
  const MAX_TICKS = 4;
  for (let i = 0; i < MAX_TICKS; i++) {
    M._wasm_tick();
    if (M._wasm_is_paused()) break;
  }
  const after = regsSnapshot();
  check(
    "stepBack (mid-interval) is exactly reversible by one stepInto",
    JSON.stringify(after) === JSON.stringify(preRegs),
    `pc after=${hex(after[17])} expected=${hex(preRegs[17])}`,
  );
  check(
    "round-trip restores instrCount too",
    readInstrCount() === preInstrCount,
    `instrCount after=${readInstrCount()} expected=${preInstrCount}`,
  );
}

// --- 5. Mid-interval continueReverse: a breakpoint on a PC that occurs only
// once, strictly between two periodic checkpoints (not on either checkpoint's
// own captured state) — continueReverse must land exactly there, not snap to
// a checkpoint boundary. ---
{
  rpc.pushSnapshot(); // entry A
  const instrCountA = readInstrCount();

  for (let j = 0; j < 30; j++) M._wasm_tick();

  rpc.pushSnapshot(); // entry B
  const instrCountB = readInstrCount();

  check(
    "mid-interval breakpoint test spans more than one instruction",
    instrCountB - instrCountA > 1n,
    `delta=${instrCountB - instrCountA}`,
  );

  // The most recently retired instruction before entry B was captured: its pc
  // can't recur later in [instrCountA, instrCountB), so a breakpoint on it
  // matches exactly once, at exactly instrCountB - 1.
  const PUAE_DEBUG_CPU_TRACE_CAP = 256;
  M._wasm_read_cpu_trace(PUAE_DEBUG_CPU_TRACE_CAP);
  const tracePtr = M._wasm_get_cpu_trace_buf();
  const traceWords = new Uint32Array(M.HEAPU32.buffer, tracePtr, PUAE_DEBUG_CPU_TRACE_CAP * 2);
  const targetPc = traceWords[0] >>> 0;
  const targetInstrCount = instrCountB - 1n;

  send("setBreakpoint", { address: targetPc });
  {
    const res = await request("continueReverse");
    check("continueReverse (mid-interval) returns true", res === true);

    const after = regsSnapshot();
    check(
      "continueReverse (mid-interval) lands exactly on the mid-interval breakpoint pc",
      (after[17] >>> 0) === targetPc,
      `pc after=${hex(after[17])} expected=${hex(targetPc)}`,
    );
    check(
      "continueReverse (mid-interval) lands exactly on the breakpoint's instrCount",
      readInstrCount() === targetInstrCount,
      `instrCount after=${readInstrCount()} expected=${targetInstrCount}`,
    );
  }
  send("removeBreakpoint", { address: targetPc });
}

// --- 6. stepBackFrame: steps back to the start of the current frame (the
// most recent vblank boundary before the current position), making
// progressively earlier progress on repeated calls. ---
{
  rpc.pushSnapshot(); // checkpoint C
  const instrCountC = readInstrCount();

  const FRAMES = 10;
  for (let j = 0; j < FRAMES; j++) M._wasm_tick();

  const current1 = readInstrCount();
  check(
    "stepBackFrame test position is past the checkpoint",
    current1 > instrCountC,
    `current1=${current1} instrCountC=${instrCountC}`,
  );

  const frameCountBefore = M._wasm_get_frame_count();

  const res1 = await request("stepBackFrame");
  check("stepBackFrame returns true", res1 === true);

  const landed1 = readInstrCount();
  check(
    "stepBackFrame lands at an earlier instrCount",
    landed1 < current1,
    `landed1=${landed1} current1=${current1}`,
  );
  check(
    "stepBackFrame lands at or after the checkpoint",
    landed1 >= instrCountC,
    `landed1=${landed1} instrCountC=${instrCountC}`,
  );
  check(
    "stepBackFrame's landing replay refreshes the framebuffer/frame count",
    M._wasm_get_frame_count() !== frameCountBefore,
    `frameCount unchanged at ${frameCountBefore}`,
  );

  const res2 = await request("stepBackFrame");
  check("stepBackFrame (again) returns true", res2 === true);

  const landed2 = readInstrCount();
  check(
    "stepBackFrame (again) makes further backward progress",
    landed2 < landed1,
    `landed2=${landed2} landed1=${landed1}`,
  );
}

// --- 7. "load" (hard reset / panel reuse) clears snapshotHistory, since
// post-reset snapshots would reference the previous program's state. ---
{
  rpc.pushSnapshot();
  rpc.pushSnapshot();
  send("load");
  const res = await request("stepBack");
  check('"load" clears snapshotHistory', res === false);
  const resFrame = await request("stepBackFrame");
  check('"load" clears snapshotHistory (stepBackFrame)', resFrame === false);
}

console.log("");
console.log(failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
