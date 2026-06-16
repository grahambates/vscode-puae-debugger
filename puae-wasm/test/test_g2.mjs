import fs from "node:fs";
import createPuaeModule from "../../puae/puae.js";

const M = await createPuaeModule();

M.FS.mkdir("/uae_system");
M.FS.writeFile("/uae_system/kick34005.A500", fs.readFileSync(new URL("../../puae/kick34005.A500", import.meta.url).pathname));
M.FS.writeFile("/uae_system/game.adf", fs.readFileSync(new URL("../../puae/demo.adf", import.meta.url).pathname));

const ok = M.ccall("wasm_boot", "number", ["string"], ["/uae_system/game.adf"]);
console.log("wasm_boot ->", ok);

// Run enough frames to get past reset and the Kickstart ROM overlay (CIA OVL
// bit) — see test_g1.mjs for details.
for (let i = 0; i < 150; i++) M._wasm_tick();

const E9K_WATCH_OP_READ = 1 << 0;
const E9K_WATCH_OP_WRITE = 1 << 1;
const E9K_WATCH_ACCESS_READ = 1;
const E9K_WATCH_ACCESS_WRITE = 2;
const E9K_PROTECT_MODE_BLOCK = 0;
const E9K_PROTECT_MODE_SET = 1;

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`OK   ${label}`);
  } else {
    failures++;
    console.log(`FAIL ${label}${detail ? " — " + detail : ""}`);
  }
}

function enabledMask(loFn, hiFn) {
  const lo = loFn() >>> 0;
  const hi = hiFn() >>> 0;
  return (BigInt(hi) << 32n) | BigInt(lo);
}

function peekByte(addr) {
  const n = M._wasm_peek_memory(addr >>> 0, 1);
  const ptr = M._wasm_get_mem_buf();
  const buf = new Uint8Array(M.HEAPU8.buffer, ptr, n);
  return buf[0];
}

function readWatchbreak() {
  const ptr = M._wasm_get_watchbreak_buf();
  const buf = new Uint32Array(M.HEAPU32.buffer, ptr, 14);
  const [index, watchAddr, opMask, diff, value, oldValue, size, addrMask,
         accessAddr, accessKind, accessSize, val, oldVal, oldValValid] = buf;
  return { index, watchAddr, opMask, diff, value, oldValue, size, addrMask,
           accessAddr, accessKind, accessSize, val, oldVal, oldValValid };
}

// --- 1. Add a write watchpoint at 0x20000 ---
const wpIndex = M._wasm_add_watchpoint(0x20000, E9K_WATCH_OP_WRITE, 0, 0, 0, 0, 0);
console.log("add_watchpoint(write @0x20000) -> index", wpIndex);
check("add_watchpoint returns valid index", wpIndex >= 0);

M._wasm_read_watchpoint_enabled_mask();
let wpMask = enabledMask(M._wasm_get_watchpoint_enabled_mask_lo, M._wasm_get_watchpoint_enabled_mask_hi);
check("watchpoint enabled mask has bit set", (wpMask & (1n << BigInt(wpIndex))) !== 0n, wpMask.toString(16));

// --- 2. Poke 0x20000, expect a write watchbreak ---
M._wasm_poke_memory(0x20000, 0x42, 1);
let gotBreak = M._wasm_consume_watchbreak();
check("watchbreak pending after write", gotBreak === 1);
if (gotBreak) {
  const wb = readWatchbreak();
  check("watchbreak.access_addr == 0x20000", wb.accessAddr === 0x20000, "0x" + wb.accessAddr.toString(16));
  check("watchbreak.access_kind == WRITE", wb.accessKind === E9K_WATCH_ACCESS_WRITE, String(wb.accessKind));
  check("watchbreak.value == 0x42", wb.val === 0x42, "0x" + wb.val.toString(16));
}
// A triggered watchbreak calls e9k_debug_requestBreak(), which sets the
// internal "paused" flag — watchpointRead/Write early-return while paused,
// so resume before continuing.
M._wasm_resume();

// --- 3. Remove the watchpoint, write again, expect no watchbreak ---
M._wasm_remove_watchpoint(wpIndex);
M._wasm_poke_memory(0x20000, 0x43, 1);
gotBreak = M._wasm_consume_watchbreak();
check("no watchbreak after removing watchpoint", gotBreak === 0);

// --- 4. Add a read watchpoint, exercise via peek_memory ---
const wpReadIndex = M._wasm_add_watchpoint(0x20004, E9K_WATCH_OP_READ, 0, 0, 0, 0, 0);
console.log("add_watchpoint(read @0x20004) -> index", wpReadIndex);
check("add read watchpoint returns valid index", wpReadIndex >= 0);

M._wasm_peek_memory(0x20004, 1);
gotBreak = M._wasm_consume_watchbreak();
check("watchbreak pending after read", gotBreak === 1);
if (gotBreak) {
  const wb = readWatchbreak();
  check("watchbreak.access_addr == 0x20004", wb.accessAddr === 0x20004, "0x" + wb.accessAddr.toString(16));
  check("watchbreak.access_kind == READ", wb.accessKind === E9K_WATCH_ACCESS_READ, String(wb.accessKind));
}
M._wasm_resume();
M._wasm_remove_watchpoint(wpReadIndex);

// --- 5. BLOCK protect ---
const before5 = peekByte(0x20100);
const prBlockIndex = M._wasm_add_protect(0x20100, 8, E9K_PROTECT_MODE_BLOCK, 0);
console.log("add_protect(BLOCK @0x20100) -> index", prBlockIndex);
check("add BLOCK protect returns valid index", prBlockIndex >= 0);

M._wasm_poke_memory(0x20100, 0xff, 1);
const after5 = peekByte(0x20100);
check("BLOCK protect prevents write", after5 === before5, `before=0x${before5.toString(16)} after=0x${after5.toString(16)}`);

// --- 6. SET protect ---
const prSetIndex = M._wasm_add_protect(0x20200, 8, E9K_PROTECT_MODE_SET, 0x55);
console.log("add_protect(SET @0x20200, value=0x55) -> index", prSetIndex);
check("add SET protect returns valid index", prSetIndex >= 0);

M._wasm_poke_memory(0x20200, 0x12, 1);
const after6 = peekByte(0x20200);
check("SET protect forces value to 0x55", after6 === 0x55, "0x" + after6.toString(16));

// --- 7. Remove protects, confirm normal writes work again ---
M._wasm_remove_protect(prBlockIndex);
M._wasm_remove_protect(prSetIndex);
M._wasm_poke_memory(0x20100, 0xaa, 1);
const after7 = peekByte(0x20100);
check("write succeeds after removing BLOCK protect", after7 === 0xaa, "0x" + after7.toString(16));

// --- 8. Read watchpoints/protects buffers and sanity-check fields ---
const wpCount = M._wasm_read_watchpoints();
check("read_watchpoints returns E9K_WATCHPOINT_COUNT", wpCount === 64, String(wpCount));
M._wasm_read_watchpoint_enabled_mask();
wpMask = enabledMask(M._wasm_get_watchpoint_enabled_mask_lo, M._wasm_get_watchpoint_enabled_mask_hi);
check("watchpoint enabled mask is 0 after removals", wpMask === 0n, wpMask.toString(16));

const prCount = M._wasm_read_protects();
check("read_protects returns E9K_PROTECT_COUNT", prCount === 64, String(prCount));
M._wasm_read_protect_enabled_mask();
const prMask = enabledMask(M._wasm_get_protect_enabled_mask_lo, M._wasm_get_protect_enabled_mask_hi);
check("protect enabled mask is 0 after removals", prMask === 0n, prMask.toString(16));

console.log("");
console.log(failures === 0 ? `All checks passed.` : `${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
