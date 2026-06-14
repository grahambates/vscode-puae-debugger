import fs from "node:fs";
import createPuaeModule from "../puae/puae.js";
import { setupRpcDispatcher, getCurrentStopMessage } from "../puae/puae_rpc.js";

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

function hex(value, digits = 8) {
  return "0x" + (value >>> 0).toString(16).padStart(digits, "0");
}

// --- RPC harness: drives setupRpcDispatcher with a mock postMessage ---
const pending = new Map();
let nextRpcId = 1;
const broadcasts = [];

function postMessage(msg) {
  if (msg.type === "rpcResponse" && pending.has(msg.id)) {
    const resolve = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg.result);
  } else if (msg.type) {
    broadcasts.push(msg);
  }
}

const rpc = setupRpcDispatcher(M, postMessage);

// One-way command (no response expected).
function send(command, args = {}) {
  rpc.handleMessage({ command, args });
}

// RPC command — returns a Promise resolving to `result`.
function request(command, args = {}) {
  const _rpcId = String(nextRpcId++);
  return new Promise((resolve) => {
    pending.set(_rpcId, resolve);
    rpc.handleMessage({ command, args: { ...args, _rpcId } });
  });
}

// --- 1. pause / run one-way commands ---
send("pause");
check("pause -> wasm_is_paused()", M._wasm_is_paused() === 1);

send("run");
check("run -> !wasm_is_paused()", M._wasm_is_paused() === 0);

send("pause");
check("pause again -> wasm_is_paused()", M._wasm_is_paused() === 1);

// --- 2. getCpuInfo ---
const cpuInfo1 = await request("getCpuInfo");
const HEX32_RE = /^0x[0-9a-f]{8}$/;
check("getCpuInfo.pc is a hex32 string", HEX32_RE.test(cpuInfo1.pc), cpuInfo1.pc);
check("getCpuInfo.d0 is a hex32 string", HEX32_RE.test(cpuInfo1.d0), cpuInfo1.d0);
check("getCpuInfo.a7 is a hex32 string", HEX32_RE.test(cpuInfo1.a7), cpuInfo1.a7);
check("getCpuInfo.sr is a hex32 string", HEX32_RE.test(cpuInfo1.sr), cpuInfo1.sr);

{
  const ptr = M._wasm_get_reg_buf();
  const buf = new Uint32Array(M.HEAPU32.buffer, ptr, 18);
  check("getCpuInfo.pc matches wasm_get_reg_buf()[17]", cpuInfo1.pc === hex(buf[17]),
    `${cpuInfo1.pc} vs ${hex(buf[17])}`);
}

const pc0 = parseInt(cpuInfo1.pc, 16);
console.log(`pc0 = 0x${pc0.toString(16)}`);

// --- 3. setRegister ---
const setD0 = await request("setRegister", { name: "d0", value: 0x12345678 });
check("setRegister(d0) result", setD0.value === hex(0x12345678), JSON.stringify(setD0));

const cpuInfo2 = await request("getCpuInfo");
check("getCpuInfo.d0 reflects setRegister", cpuInfo2.d0 === hex(0x12345678), cpuInfo2.d0);

// --- 3b. getCpuInfo.usp is real (register index 18) ---
check("getCpuInfo.usp is a hex32 string after boot", HEX32_RE.test(cpuInfo1.usp), cpuInfo1.usp);
check("getCpuInfo.usp is non-zero after boot", cpuInfo1.usp !== hex(0), cpuInfo1.usp);

// --- 4. readMemory / writeMemory round trip (>4 bytes, exercises wasm_write_memory_buf) ---
const writeData = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c]);
await request("writeMemory", { address: 0x20000, data: writeData });
const readBack = await request("readMemory", { address: 0x20000, count: writeData.length });
check("readMemory round-trips writeMemory data",
  Buffer.from(readBack.data).equals(Buffer.from(writeData)),
  `${Buffer.from(readBack.data).toString("hex")} vs ${Buffer.from(writeData).toString("hex")}`);

// --- 5. readMemory chunking (>MEM_BUF_CAP) ---
const bigLen = 8192;
const bigPattern = new Uint8Array(bigLen);
for (let i = 0; i < bigLen; i++) bigPattern[i] = i & 0xff;
await request("writeMemory", { address: 0x30000, data: bigPattern });
const bigReadBack = await request("readMemory", { address: 0x30000, count: bigLen });
check("readMemory chunks reads larger than MEM_BUF_CAP",
  bigReadBack.data.length === bigLen && Buffer.from(bigReadBack.data).equals(Buffer.from(bigPattern)),
  `length=${bigReadBack.data.length}`);

// --- 6. peek32 / poke32 round trip ---
await request("poke32", { address: 0x20100, value: 0xcafebabe });
const peeked32 = await request("peek32", { address: 0x20100 });
check("peek32 round-trips poke32", peeked32 === 0xcafebabe, hex(peeked32));

// --- 7. pokeCustom16 (COLOR00 @ 0xdff180) ---
// COLOR00 is write-only on real hardware (reads return the floating data
// bus, not the written value), so this only checks the write doesn't error —
// it can't be verified via peek16 round-trip.
const pokeCustomResult = await request("pokeCustom16", { address: 0xdff180, value: 0x0fff });
check("pokeCustom16 does not error",
  pokeCustomResult === undefined || pokeCustomResult.error === undefined, JSON.stringify(pokeCustomResult));

// --- 8. getMemoryInfo ---
const memInfo = await request("getMemoryInfo");
check("getMemoryInfo.cpuMemSrc has 256 entries", memInfo.cpuMemSrc.length === 256, String(memInfo.cpuMemSrc.length));
check("getMemoryInfo.agnusMemSrc has 256 entries", memInfo.agnusMemSrc.length === 256, String(memInfo.agnusMemSrc.length));
check("getMemoryInfo.cpuMemSrc[0] is CHIP (1)", memInfo.cpuMemSrc[0] === 1, String(memInfo.cpuMemSrc[0]));
// 0xF80000-0xFFFFFF is the 512KB Kickstart ROM region; the 256KB ROM image is
// mirrored within it, so either bank may report ROM(13) or ROM_MIRROR(14)
// depending on which 64KB slice the bank-map scan visits first.
check("getMemoryInfo.cpuMemSrc[0xf8] is ROM or ROM_MIRROR", [13, 14].includes(memInfo.cpuMemSrc[0xf8]),
  String(memInfo.cpuMemSrc[0xf8]));
const pc0Bank = pc0 >>> 16;
check("getMemoryInfo.cpuMemSrc[bank(pc0)] is ROM or ROM_MIRROR", [13, 14].includes(memInfo.cpuMemSrc[pc0Bank]),
  `bank=0x${pc0Bank.toString(16)} src=${memInfo.cpuMemSrc[pc0Bank]}`);
check("getMemoryInfo.agnusMemSrc[0] is CHIP (1)", memInfo.agnusMemSrc[0] === 1, String(memInfo.agnusMemSrc[0]));
check("getMemoryInfo.agnusMemSrc[0xf8] is NONE (0)", memInfo.agnusMemSrc[0xf8] === 0, String(memInfo.agnusMemSrc[0xf8]));

// --- 9. disassemble(pc0, 4) ---
const disasm = await request("disassemble", { address: pc0, count: 4 });
check("disassemble returns 4 instructions", disasm.instructions.length === 4, String(disasm.instructions.length));
check("disassemble[0].addr matches pc0", disasm.instructions[0].addr === hex(pc0, 6),
  `${disasm.instructions[0].addr} vs ${hex(pc0, 6)}`);
{
  let addrsIncreasing = true;
  for (let i = 1; i < disasm.instructions.length; i++) {
    const prev = parseInt(disasm.instructions[i - 1].addr, 16);
    const cur = parseInt(disasm.instructions[i].addr, 16);
    if (cur <= prev) addrsIncreasing = false;
  }
  check("disassemble addresses strictly increase", addrsIncreasing,
    disasm.instructions.map((i) => i.addr).join(","));
}
check("disassemble[0].instruction is non-empty", disasm.instructions[0].instruction.length > 0);
check("disassemble[0].hex is non-empty", disasm.instructions[0].hex.length > 0);

// --- 10. setBreakpoint / removeBreakpoint (functional: re-fires at pc0) ---
send("setBreakpoint", { address: pc0 });
send("run");
let bpHit = false;
for (let i = 0; i < 4; i++) {
  M._wasm_tick();
  if (M._wasm_is_paused()) { bpHit = true; break; }
}
check("setBreakpoint at pc0 re-pauses after run", bpHit);
{
  const ptr = M._wasm_get_reg_buf();
  M._wasm_read_regs();
  const buf = new Uint32Array(M.HEAPU32.buffer, M._wasm_get_reg_buf(), 18);
  check("breakpoint fires before executing pc0", buf[17] === pc0, hex(buf[17]));
}
send("removeBreakpoint", { address: pc0 });

// --- 11. setWatchpoint / removeWatchpoint ---
function watchpointEnabledMask() {
  M._wasm_read_watchpoint_enabled_mask();
  const lo = M._wasm_get_watchpoint_enabled_mask_lo() >>> 0;
  const hi = M._wasm_get_watchpoint_enabled_mask_hi() >>> 0;
  return (BigInt(hi) << 32n) | BigInt(lo);
}

const maskBefore = watchpointEnabledMask();
send("setWatchpoint", { address: 0x40000 });
const maskAfterAdd = watchpointEnabledMask();
check("setWatchpoint adds an enabled watchpoint", maskAfterAdd !== maskBefore,
  `${maskBefore.toString(16)} -> ${maskAfterAdd.toString(16)}`);

send("removeWatchpoint", { address: 0x40000 });
const maskAfterRemove = watchpointEnabledMask();
check("removeWatchpoint restores the enabled mask", maskAfterRemove === maskBefore,
  `${maskBefore.toString(16)} -> ${maskAfterRemove.toString(16)}`);

// --- 12. jump (no-op back to pc0) ---
const jumpResult = await request("jump", { address: pc0 });
check("jump returns no error", jumpResult === undefined || jumpResult.error === undefined,
  JSON.stringify(jumpResult));
const cpuInfo3 = await request("getCpuInfo");
check("jump sets PC to target address", cpuInfo3.pc === hex(pc0), cpuInfo3.pc);

// --- 13. documented-gap commands ---
const customRegs = await request("getAllCustomRegisters");
check("getAllCustomRegisters returns the readable custom registers",
  typeof customRegs.INTENA?.value === "string" && /^0x[0-9a-f]{4}$/.test(customRegs.INTENA.value),
  JSON.stringify(customRegs));

const HEX16 = /^0x[0-9a-f]{4}$/;
const DISPLAY_REGS = [
  "BPLCON0", "BPLCON1", "BPLCON2", "BPLCON3",
  "DIWSTRT", "DIWSTOP", "DDFSTRT", "DDFSTOP",
  ...Array.from({ length: 32 }, (_, i) => `COLOR${String(i).padStart(2, "0")}`),
];
check("getAllCustomRegisters returns the write-only display/colour registers",
  DISPLAY_REGS.every((name) => HEX16.test(customRegs[name]?.value)),
  JSON.stringify(DISPLAY_REGS.filter((name) => !HEX16.test(customRegs[name]?.value))));
check("getAllCustomRegisters BPLCON0 has HOMOD/hires bits set after Kickstart boot screen",
  parseInt(customRegs.BPLCON0.value, 16) !== 0, customRegs.BPLCON0.value);

// --- 13b. raw custom-register image + audio registers (e9k_get_custom_regs_raw / e9k_get_audio_regs_raw) ---
const HEX32 = /^0x[0-9a-f]{8}$/;
const RAW_CUSTOM_REGS_16 = [
  "BLTDDAT", "DSKLEN", "COPCON", "SERDAT", "SERPER",
  "BLTCON0", "BLTCON1", "BLTAFWM", "BLTALWM", "BLTSIZE", "BLTSIZV", "BLTSIZH",
  "BLTCMOD", "BLTBMOD", "BLTAMOD", "BLTDMOD", "BLTCDAT", "BLTBDAT", "BLTADAT",
  "DENISEID", "DSKSYNC", "CLXCON",
  "BPL1MOD", "BPL2MOD", "BPLCON4", "CLXCON2",
  ...Array.from({ length: 6 }, (_, i) => `BPL${i + 1}DAT`),
  "HTOTAL", "HSSTOP", "HBSTRT", "HBSTOP", "VTOTAL", "VSSTOP", "VBSTRT", "VBSTOP",
  "SPRHSTRT", "SPRHSTOP", "BPLHSTRT", "BPLHSTOP", "HHPOSW", "HHPOSR", "BEAMCON0",
  "HSSTRT", "VSSTRT", "HCENTER", "DIWHIGH", "FMODE",
  ...Array.from({ length: 8 }, (_, i) => `SPR${i}POS`),
  ...Array.from({ length: 8 }, (_, i) => `SPR${i}CTL`),
  ...Array.from({ length: 8 }, (_, i) => `SPR${i}DATA`),
  ...Array.from({ length: 8 }, (_, i) => `SPR${i}DATB`),
];
const RAW_CUSTOM_REGS_32 = [
  "DSKPT", "BLTCPT", "BLTBPT", "BLTAPT", "BLTDPT", "COP1LC", "COP2LC",
  ...Array.from({ length: 6 }, (_, i) => `BPL${i + 1}PT`),
  ...Array.from({ length: 8 }, (_, i) => `SPR${i}PT`),
];
check("getAllCustomRegisters returns raw 16-bit custom registers",
  RAW_CUSTOM_REGS_16.every((name) => HEX16.test(customRegs[name]?.value)),
  JSON.stringify(RAW_CUSTOM_REGS_16.filter((name) => !HEX16.test(customRegs[name]?.value))));
check("getAllCustomRegisters returns raw 32-bit pointer registers",
  RAW_CUSTOM_REGS_32.every((name) => HEX32.test(customRegs[name]?.value)),
  JSON.stringify(RAW_CUSTOM_REGS_32.filter((name) => !HEX32.test(customRegs[name]?.value))));
check("getAllCustomRegisters COP1LC is a non-zero chip-RAM address after Kickstart boot",
  parseInt(customRegs.COP1LC.value, 16) !== 0, customRegs.COP1LC.value);

const AUDIO_REGS_16 = ["LEN", "PER", "VOL", "DAT"].flatMap((suffix) =>
  Array.from({ length: 4 }, (_, i) => `AUD${i}${suffix}`));
const AUDIO_REGS_32 = Array.from({ length: 4 }, (_, i) => `AUD${i}LC`);
check("getAllCustomRegisters returns AUD0-3 LEN/PER/VOL/DAT",
  AUDIO_REGS_16.every((name) => HEX16.test(customRegs[name]?.value)),
  JSON.stringify(AUDIO_REGS_16.filter((name) => !HEX16.test(customRegs[name]?.value))));
check("getAllCustomRegisters returns AUD0-3 LC as 32-bit pointers",
  AUDIO_REGS_32.every((name) => HEX32.test(customRegs[name]?.value)),
  JSON.stringify(AUDIO_REGS_32.filter((name) => !HEX32.test(customRegs[name]?.value))));

const copperDisasm = await request("disassembleCopper", { address: 0, count: 1 });
check("disassembleCopper reports documented gap as error",
  typeof copperDisasm.error === "string" && copperDisasm.error.includes("Copper"), JSON.stringify(copperDisasm));

const cpuTrace = await request("getCpuTrace", { count: 8 });
check("getCpuTrace returns up to `count` recent instructions",
  Array.isArray(cpuTrace) && cpuTrace.length === 8,
  JSON.stringify(cpuTrace));
check("getCpuTrace entries have pc/instruction/flags/length",
  cpuTrace.every((item) =>
    /^0x[0-9a-f]{6}$/.test(item.pc) &&
    typeof item.instruction === "string" && item.instruction.length > 0 &&
    /^[Tt]{2}[Ss][Mm]-[01]{3}---[XxNnZzVvCc]{5}$/.test(item.flags) &&
    item.length > 0),
  JSON.stringify(cpuTrace));

send("enableCpuLogging", { enabled: false });
send("stepInto");
for (let i = 0; i < 4 && !M._wasm_is_paused(); i++) M._wasm_tick();
const cpuTraceAfterDisable = await request("getCpuTrace", { count: 1 });
check("enableCpuLogging(false) stops recording new instructions",
  cpuTraceAfterDisable[0]?.pc === cpuTrace[0]?.pc,
  JSON.stringify({ before: cpuTrace[0], after: cpuTraceAfterDisable[0] }));

send("enableCpuLogging", { enabled: true });

// stepBack/continueReverse now do real snapshot-restore work (see
// test_reverse.mjs for thorough coverage) — by this point in the test,
// run/stepInto/eof/eol have all pushed snapshots, so history is non-empty
// and both calls succeed.
const stepBack = await request("stepBack");
check("stepBack returns true", stepBack === true, JSON.stringify(stepBack));

const continueReverse = await request("continueReverse");
check("continueReverse returns true", continueReverse === true, JSON.stringify(continueReverse));

// --- 14. stepInto ---
send("stepInto");
check("stepInto re-pauses", M._wasm_is_paused() === 1);
{
  M._wasm_read_regs();
  const buf = new Uint32Array(M.HEAPU32.buffer, M._wasm_get_reg_buf(), 18);
  check("stepInto advances PC past pc0", buf[17] !== pc0, hex(buf[17]));
}

// --- 15. eof (run to end of frame) ---
send("eof");
let eofHit = false;
for (let i = 0; i < 4; i++) {
  M._wasm_tick();
  if (M._wasm_is_paused()) { eofHit = true; break; }
}
check("eof pauses at end of frame", eofHit);

// --- 15b. eol (run to end of line / hblank stepping) ---
{
  const readCycles = () => {
    M._wasm_read_cycle_count();
    const lo = M._wasm_get_cycle_count_lo() >>> 0;
    const hi = M._wasm_get_cycle_count_hi() >>> 0;
    return (BigInt(hi) << 32n) | BigInt(lo);
  };

  const cyclesBefore = readCycles();

  send("eol");
  let eolHit = false;
  for (let i = 0; i < 8; i++) {
    M._wasm_tick();
    if (M._wasm_is_paused()) { eolHit = true; break; }
  }
  check("eol pauses at end of line", eolHit);

  const delta = readCycles() - cyclesBefore;
  // A PAL scanline is ~227 CCKs; a full frame is ~312 lines (~70800 CCKs).
  // Assert eol stops within roughly one line, not a whole frame -- proving
  // it's hooked to hsync, not vsync.
  check("eol advances by roughly one scanline, not a full frame",
    delta > 0n && delta < 1000n, delta.toString());
}

// --- 16. setRegister(usp) / register index 18 round-trip (both regs.s branches) ---
// Run last: toggling SR's S bit swaps the live A7 with the usp/isp shadow
// registers (UAE's MakeFromSR), and writing reg 18 mid-swap leaves those
// shadows holding our test values rather than valid stack pointers — fine
// at the end of the run, but it would corrupt the stack for later checks.
{
  const cpuInfoBefore = await request("getCpuInfo");
  const srBefore = parseInt(cpuInfoBefore.sr, 16);
  const sBitSet = (srBefore & 0x2000) !== 0;

  // Round-trip reg 18 (usp) in the current mode.
  const setUsp1 = await request("setRegister", { name: "usp", value: 0x11223344 });
  check("setRegister(usp) result", setUsp1.value === hex(0x11223344), JSON.stringify(setUsp1));
  let cpuInfoUsp = await request("getCpuInfo");
  check(`getCpuInfo.usp round-trips (S=${sBitSet ? 1 : 0})`,
    cpuInfoUsp.usp === hex(0x11223344), cpuInfoUsp.usp);

  // Toggle the S bit and round-trip reg 18 (usp) in the other mode.
  const srToggled = srBefore ^ 0x2000;
  await request("setRegister", { name: "sr", value: srToggled });
  cpuInfoUsp = await request("getCpuInfo");
  const sBitNowSet = (parseInt(cpuInfoUsp.sr, 16) & 0x2000) !== 0;
  check("setRegister(sr) toggles the S bit", sBitNowSet !== sBitSet, cpuInfoUsp.sr);

  const setUsp2 = await request("setRegister", { name: "usp", value: 0x55667788 });
  check("setRegister(usp) result after SR toggle", setUsp2.value === hex(0x55667788), JSON.stringify(setUsp2));
  cpuInfoUsp = await request("getCpuInfo");
  check(`getCpuInfo.usp round-trips (S=${sBitNowSet ? 1 : 0})`,
    cpuInfoUsp.usp === hex(0x55667788), cpuInfoUsp.usp);
}

// --- 17. setCatchpoint / removeCatchpoint (illegal instruction -> CATCHPOINT_REACHED) ---
// Run last: triggering a real 68k exception pushes a frame onto the
// supervisor stack and redirects PC to the exception vector handler, leaving
// CPU state in a "halted at Guru Meditation" shape not suitable for further
// checks.
{
  const ILLEGAL_ADDR = 0x20200;
  const ILLEGAL_VECTOR = 4; // Illegal instruction

  // 0x4AFC = "ILLEGAL", a guaranteed-illegal opcode that raises vector 4.
  await request("writeMemory", { address: ILLEGAL_ADDR, data: new Uint8Array([0x4a, 0xfc]) });

  send("setCatchpoint", { vector: ILLEGAL_VECTOR });
  await request("jump", { address: ILLEGAL_ADDR });
  send("run");

  let caught = false;
  for (let i = 0; i < 4; i++) {
    M._wasm_tick();
    if (M._wasm_is_paused()) { caught = true; break; }
  }
  check("setCatchpoint(4) pauses on illegal instruction", caught);

  const stopMessage = getCurrentStopMessage(M);
  check("getCurrentStopMessage reports CATCHPOINT_REACHED", stopMessage.name === "CATCHPOINT_REACHED",
    JSON.stringify(stopMessage));
  check("CATCHPOINT_REACHED.payload.pc is the faulting instruction address",
    stopMessage.payload.pc === ILLEGAL_ADDR, hex(stopMessage.payload.pc));
  check("CATCHPOINT_REACHED.payload.vector is 4",
    stopMessage.payload.vector === ILLEGAL_VECTOR, String(stopMessage.payload.vector));

  // Consuming the catchbreak clears it: a second call falls through to BREAKPOINT_REACHED.
  const stopMessage2 = getCurrentStopMessage(M);
  check("catchbreak is consumed (one-shot)", stopMessage2.name !== "CATCHPOINT_REACHED",
    JSON.stringify(stopMessage2));

  // removeCatchpoint disables the catch: re-trigger at a different address, run un-paused.
  send("removeCatchpoint", { vector: ILLEGAL_VECTOR });
  await request("writeMemory", { address: ILLEGAL_ADDR + 4, data: new Uint8Array([0x4a, 0xfc]) });
  await request("jump", { address: ILLEGAL_ADDR + 4 });
  send("run");
  let caughtAfterRemove = false;
  for (let i = 0; i < 4; i++) {
    M._wasm_tick();
    if (M._wasm_is_paused()) { caughtAfterRemove = true; break; }
  }
  check("removeCatchpoint(4) no longer pauses on illegal instruction", !caughtAfterRemove);
}

// --- 18. "load" (panel-reuse restart: hard reset + re-warm-up + exec-ready) ---
// Run last: the previous section leaves the CPU halted mid-exception with a
// corrupted supervisor stack — "load" should recover from this completely,
// since it's also what reuses an already-booted webview for a new debug
// session (PuaeEmulator.open()).
{
  broadcasts.length = 0;
  send("load");

  check("load: posts exec-ready", broadcasts.some((m) => m.type === "exec-ready"),
    JSON.stringify(broadcasts));
  check("load: machine is running again (not paused)", M._wasm_is_paused() === 0);

  const cpuInfoAfterLoad = await request("getCpuInfo");
  check("load: getCpuInfo.pc is a hex32 string after reset", HEX32_RE.test(cpuInfoAfterLoad.pc),
    cpuInfoAfterLoad.pc);
  check("load: getCpuInfo.sr is a hex32 string after reset", HEX32_RE.test(cpuInfoAfterLoad.sr),
    cpuInfoAfterLoad.sr);

  const memInfoAfterLoad = await request("getMemoryInfo");
  check("load: getMemoryInfo still resolves after reset", typeof memInfoAfterLoad.chipMask === "string",
    JSON.stringify(memInfoAfterLoad));
}

console.log("");
console.log(failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
