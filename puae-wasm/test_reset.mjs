import fs from "node:fs";
import createPuaeModule from "../puae/puae.js";

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`OK   ${label}`);
  } else {
    failures++;
    console.log(`FAIL ${label}${detail ? " — " + detail : ""}`);
  }
}

function hex(value, digits = 8) {
  return "0x" + (value >>> 0).toString(16).padStart(digits, "0");
}

// wasm_peek_memory writes into g_mem_buf and returns the byte count, not the
// value — read the bytes back via wasm_get_mem_buf().
function peek32(addr) {
  M._wasm_peek_memory(addr, 4);
  const ptr = M._wasm_get_mem_buf();
  const buf = new Uint8Array(M.HEAPU8.buffer, ptr, 4);
  return ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
}

function peek8(addr) {
  M._wasm_peek_memory(addr, 1);
  const ptr = M._wasm_get_mem_buf();
  return M.HEAPU8[ptr];
}

// WARM_UP_TICKS mirrors index.html's post-boot warm-up (see comment there):
// enough frames for Kickstart to clear the CIA OVL bit and for exec.library's
// memory-list allocator to be ready for fastLoad injection.
const WARM_UP_TICKS = 200;
// Deep into chip RAM, away from the low-memory vectors/workspace Kickstart
// touches during the first few post-reset ticks.
const MARKER_ADDR = 0x40000;

const M = await createPuaeModule();
M.FS.mkdir("/uae_system");
M.FS.writeFile("/uae_system/kick34005.A500", fs.readFileSync("../puae/kick34005.A500"));

const ok = M.ccall("wasm_boot", "number", ["string"], [""]);
console.log("wasm_boot ->", ok);

for (let i = 0; i < WARM_UP_TICKS; i++) M._wasm_tick();

const execBase1 = peek32(4);
console.log("execBase (boot 1):", hex(execBase1));
check("boot 1: execBase is valid", execBase1 !== 0 && execBase1 !== 0xffffffff, hex(execBase1));

// Capture the booted content at MARKER_ADDR, then stomp it with a marker
// byte — simulating a previous fastLoad session having allocated/used this
// chip RAM. If reset+re-warm-up reproduces a fresh boot, this address should
// end up back at `clean1` once boot 2's warm-up completes.
const clean1 = peek32(MARKER_ADDR);
M._wasm_poke_memory(MARKER_ADDR, 0xa5a5a5a5, 4);
const marker1 = peek32(MARKER_ADDR);
check("marker written before reset", marker1 === 0xa5a5a5a5, hex(marker1));

// --- reset ---
M._wasm_reset();

// Process the hard reset: quit_program flips from negative -> UAE_RESET_HARD
// on the first tick (after run_func), then is actioned (custom_reset,
// m68k_reset2, memory_clear) at the top of the loop on the second.
for (let i = 0; i < 4; i++) M._wasm_tick();

const execBaseReset = peek32(4);
console.log("execBase (just after reset):", hex(execBaseReset));
check(
  "post-reset: execBase no longer the booted value",
  execBaseReset !== execBase1,
  hex(execBaseReset),
);

// --- re-warm-up ---
for (let i = 0; i < WARM_UP_TICKS; i++) M._wasm_tick();

const execBase2 = peek32(4);
console.log("execBase (boot 2):", hex(execBase2));
check("boot 2: execBase is valid again", execBase2 !== 0 && execBase2 !== 0xffffffff, hex(execBase2));
check("boot 2: execBase matches boot 1 (deterministic reboot)", execBase2 === execBase1, `${hex(execBase2)} vs ${hex(execBase1)}`);

const clean2 = peek32(MARKER_ADDR);
console.log("MARKER_ADDR content: boot1=" + hex(clean1) + " marker=" + hex(marker1) + " boot2=" + hex(clean2));
check(
  "boot 2: marker overwritten, content matches a fresh boot",
  clean2 === clean1,
  `boot1=${hex(clean1)} boot2=${hex(clean2)}`,
);

console.log("");
console.log(failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
