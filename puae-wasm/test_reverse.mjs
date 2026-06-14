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

console.log("");
console.log(failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
