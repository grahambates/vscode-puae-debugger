import { fileURLToPath } from "node:url";
import createPuaeModule from "../../puae/puae.js";
import { setupRpcDispatcher } from "../../out/puaeRpc.mjs";
import { parseHunksFromFile } from "./test_g4_hunkparser.mjs";
import { loadAmigaProgram } from "./test_g4_hunkloader.mjs";
import { AmigaMemoryMapper } from "./test_g4_memmapper.mjs";
import { readFixture } from "./fixtures.mjs";

const kickRom = readFixture("kick34005.A500");

const M = await createPuaeModule();

M.FS.mkdir("/uae_system");
M.FS.writeFile("/uae_system/kick34005.A500", kickRom);

// Boot with no disk inserted, matching index.html's fastLoad boot sequence.
const ok = M.ccall("wasm_boot", "number", ["string"], [""]);
console.log("wasm_boot ->", ok);

// Mirror index.html's boot-readiness warm-up.
const WARMUP_TICKS = process.env.WARMUP_TICKS ? Number(process.env.WARMUP_TICKS) : 200;
console.log(`Warming up (${WARMUP_TICKS} ticks)...`);
for (let i = 0; i < WARMUP_TICKS; i++) M._wasm_tick();

// --- RPC harness (same pattern as test_g3.mjs) ---
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

function hex(value, digits = 8) {
  return "0x" + (value >>> 0).toString(16).padStart(digits, "0");
}

// Pause before injection, mirroring index.html's new boot-readiness sequence.
send("pause");
console.log("paused:", M._wasm_is_paused() === 1);

// --- Emulator-shim implementing just the methods AmigaHunkLoader/AmigaMemoryMapper use ---
const emu = {
  async getCpuInfo() {
    return await request("getCpuInfo");
  },
  async setRegister(name, value) {
    const r = await request("setRegister", { name, value });
    if (r && r.error) throw new Error(r.error);
    return r;
  },
  async jump(address) {
    const r = await request("jump", { address });
    if (r && r.error) throw new Error(r.error);
  },
  async readMemory(address, count) {
    const r = await request("readMemory", { address, count });
    return Buffer.from(r.data);
  },
  async writeMemory(address, data) {
    await request("writeMemory", { address, data: new Uint8Array(data) });
  },
  async peek32(address) {
    return await request("peek32", { address });
  },
  async peek16(address) {
    return await request("peek16", { address });
  },
  async peek8(address) {
    return await request("peek8", { address });
  },
  async poke32(address, value) {
    await request("poke32", { address, value });
  },
  async poke16(address, value) {
    await request("poke16", { address, value });
  },
  async poke8(address, value) {
    await request("poke8", { address, value });
  },
};

// --- Dump initial state ---
const cpuInfoBefore = await emu.getCpuInfo();
console.log("Before load: pc=", cpuInfoBefore.pc, "sr=", cpuInfoBefore.sr, "usp=", cpuInfoBefore.usp, "a7=", cpuInfoBefore.a7);

const memMapper = new AmigaMemoryMapper(emu);
const memInfoBefore = await memMapper.getMemoryInfo();
console.log("execBase:", hex(memInfoBefore.execBase));
console.log("regions:", memInfoBefore.regions.map(r => `${hex(r.lower)}-${hex(r.upper)} attr=${hex(r.attributes,4)}`));
console.log("free blocks:", memInfoBefore.blocks.filter(b => b.free).map(b => `${hex(b.address)} size=${hex(b.size)}`));

// --- Walk ExecBase->LibList to check whether dos.library is resident ---
async function readCString(addr, maxLen = 32) {
  const buf = await emu.readMemory(addr, maxLen);
  let end = buf.indexOf(0);
  if (end === -1) end = buf.length;
  return buf.slice(0, end).toString("ascii");
}

const libListAddr = (memInfoBefore.execBase + 0x17a) >>> 0;
let node = await emu.peek32(libListAddr); // lh_Head
console.log("LibList @", hex(libListAddr), "head=", hex(node));
const libNames = [];
for (let i = 0; i < 64; i++) {
  const succ = await emu.peek32(node);
  if (succ === 0) break;
  const namePtr = await emu.peek32(node + 10);
  const name = namePtr ? await readCString(namePtr) : "";
  libNames.push(name);
  node = succ;
}
console.log("Resident libraries:", libNames);

// --- Parse and load fixture ---
const hunks = await parseHunksFromFile(fileURLToPath(new URL("../hunk.exe", import.meta.url)));
console.log("hunks:", hunks.map(h => `${h.index} ${h.hunkType} ${h.allocSize} (${h.memType})`));

const program = await loadAmigaProgram(emu, hunks);
console.log("entryPoint:", hex(program.entryPoint));

const cpuInfoAfter = await emu.getCpuInfo();
console.log("After load: pc=", cpuInfoAfter.pc, "sr=", cpuInfoAfter.sr, "usp=", cpuInfoAfter.usp, "a7=", cpuInfoAfter.a7);

// --- Single-step from the entry point, dumping regs on PC jumps ---
console.log("\n--- single-stepping from entry ---");
let lastPc = (await emu.getCpuInfo()).pc;
let lastA7 = (await emu.getCpuInfo()).a7;
for (let i = 0; i < 1500; i++) {
  send("stepInto");
  const info = await emu.getCpuInfo();
  const pcDelta = (parseInt(info.pc, 16) - parseInt(lastPc, 16)) >>> 0;
  if (pcDelta > 8 && pcDelta < 0xfffffff0) {
    console.log(
      `step ${i}: pc ${lastPc} -> ${info.pc} (jump)  sr=${info.sr} a7=${info.a7} usp=${info.usp}`
    );
  }
  if (info.a7 !== lastA7) {
    console.log(`step ${i}: a7 ${lastA7} -> ${info.a7}`);
  }
  lastPc = info.pc;
  lastA7 = info.a7;
  if (info.pc.startsWith("0x00fc05")) {
    console.log(`*** appears to be in/near reset vector at step ${i} ***`);
    break;
  }
}
const cpuInfoFinal = await emu.getCpuInfo();
console.log("Final: pc=", cpuInfoFinal.pc, "sr=", cpuInfoFinal.sr, "a7=", cpuInfoFinal.a7, "usp=", cpuInfoFinal.usp);

// --- Free-run for a while to confirm the program keeps executing without a reset ---
console.log("\n--- free-running for 2000 ticks ---");
M._wasm_resume();
for (let i = 0; i < 2000; i++) M._wasm_tick();
M._wasm_pause();
const cpuInfoFreeRun = await emu.getCpuInfo();
console.log("After free-run: pc=", cpuInfoFreeRun.pc, "sr=", cpuInfoFreeRun.sr, "a7=", cpuInfoFreeRun.a7, "usp=", cpuInfoFreeRun.usp);

console.log("");
console.log("done");
process.exit(0);
