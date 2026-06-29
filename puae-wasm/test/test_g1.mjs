import fs from "node:fs";
import { fileURLToPath } from "node:url";
import createPuaeModule from "../../puae/puae.js";

const M = await createPuaeModule();

M.FS.mkdir("/uae_system");
M.FS.writeFile("/uae_system/kick34005.A500", fs.readFileSync(fileURLToPath(new URL("../../puae/kick34005.A500", import.meta.url))));
M.FS.writeFile("/uae_system/game.adf", fs.readFileSync(fileURLToPath(new URL("../../puae/demo.adf", import.meta.url))));

const ok = M.ccall("wasm_boot", "number", ["string"], ["/uae_system/game.adf"]);
console.log("wasm_boot ->", ok);

// Run enough frames to get past reset and the Kickstart ROM overlay
// (CIA OVL bit) — until then, low RAM addresses (and their 0x80000-aligned
// mirrors) are mapped to ROM and writes are silently dropped.
for (let i = 0; i < 150; i++) M._wasm_tick();

function readRegs(label) {
  const n = M._wasm_read_regs();
  const ptr = M._wasm_get_reg_buf();
  const buf = new Uint32Array(M.HEAPU32.buffer, ptr, n);
  const pc = buf[17];
  console.log(`${label}: PC=0x${pc.toString(16)} A7=0x${buf[15].toString(16)} SR=0x${buf[16].toString(16)}`);
  return pc;
}

const pc0 = readRegs("after boot");

// --- Memory read at 0x4 (exec base pointer) ---
const memN = M._wasm_read_memory(4, 16);
const memPtr = M._wasm_get_mem_buf();
const memBuf = new Uint8Array(M.HEAPU8.buffer, memPtr, memN);
console.log("mem[0x4..0x14) =", Array.from(memBuf, b => b.toString(16).padStart(2, "0")).join(" "));

// --- Memory write round-trip (use an address well within chip RAM, away
// from any ROM-overlay mirroring) ---
const ok2 = M._wasm_write_memory(0x20000, 0xdeadbeef, 4);
const memN2 = M._wasm_read_memory(0x20000, 4);
const memPtr2 = M._wasm_get_mem_buf();
const memBuf2 = new Uint8Array(M.HEAPU8.buffer, memPtr2, memN2);
console.log("write_memory ok=", ok2, "readback =", Array.from(memBuf2, b => b.toString(16).padStart(2, "0")).join(" "));

// --- Disassemble at PC ---
const len = M._wasm_disassemble(pc0);
const text = M.UTF8ToString(M._wasm_get_disasm_buf());
console.log(`disasm @0x${pc0.toString(16)}: "${text}" (len ${len})`);

// --- Cycle count ---
M._wasm_read_cycle_count();
const lo1 = M._wasm_get_cycle_count_lo() >>> 0;
const hi1 = M._wasm_get_cycle_count_hi() >>> 0;
const cycles1 = (BigInt(hi1) << 32n) | BigInt(lo1);
console.log("cycles before step:", cycles1.toString());

// --- Step instr ---
M._wasm_step_instr();
let paused = false;
for (let i = 0; i < 4; i++) {
  M._wasm_tick();
  if (M._wasm_is_paused()) { paused = true; break; }
}
console.log("step_instr paused:", paused);
const pc1 = readRegs("after step_instr");
console.log("PC advanced by", pc1 - pc0, "bytes (expected", len, ")");

M._wasm_read_cycle_count();
const lo2 = M._wasm_get_cycle_count_lo() >>> 0;
const hi2 = M._wasm_get_cycle_count_hi() >>> 0;
const cycles2 = (BigInt(hi2) << 32n) | BigInt(lo2);
console.log("cycles after step:", cycles2.toString(), "delta:", (cycles2 - cycles1).toString());

// --- Resume and run until a JSR/BSR populates the callstack ---
M._wasm_resume();
let csN = 0;
for (let i = 0; i < 200 && csN === 0; i++) {
  M._wasm_tick();
  csN = M._wasm_read_callstack();
}
console.log("callstack depth:", csN);
if (csN > 0) {
  const csPtr = M._wasm_get_callstack_buf();
  const csBuf = new Uint32Array(M.HEAPU32.buffer, csPtr, csN);
  console.log("callstack:", Array.from(csBuf, a => "0x" + a.toString(16)).join(", "));
}

// --- Temp breakpoint ---
const targetPc = readRegs("before temp bp");
M._wasm_add_temp_breakpoint(targetPc);
console.log("temp breakpoint added at 0x" + targetPc.toString(16));
