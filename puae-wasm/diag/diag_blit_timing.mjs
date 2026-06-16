// diag_blit_timing.mjs
// Measures when the blitter finishes relative to frame boundaries.
//
// Loads blit-test.exe, runs several frames, then for each frame scans the
// framebuffer for the COLOR00 transition row that marks blit completion:
//   - Before completion: CPU is polling BLTBUSY → COLOR00 = idle color
//   - After completion:  CPU sets COLOR00 = active color
// The transition row / total rows gives the fraction of the frame consumed
// by the blit. Compare this across configurations (with/without bitplane DMA,
// with/without blit hog) to observe whether PUAE models bus contention.
//
// Usage:
//   node puae-wasm/diag/diag_blit_timing.mjs

import fs from "node:fs";
import createPuaeModule from "../../puae/puae.js";
import { setupRpcDispatcher } from "../../puae/puae_rpc.js";
import { parseHunksFromFile } from "../test/test_g4_hunkparser.mjs";
import { loadAmigaProgram } from "../test/test_g4_hunkloader.mjs";
import { AmigaMemoryMapper } from "../test/test_g4_memmapper.mjs";

// ── Boot ────────────────────────────────────────────────────────────────────

const M = await createPuaeModule();

const CE_MODE = process.argv.includes("--ce");

M.FS.mkdir("/uae_system");
M.FS.writeFile(
  "/uae_system/kick34005.A500",
  fs.readFileSync(new URL("../../puae/kick34005.A500", import.meta.url).pathname),
);
if (CE_MODE) {
  M.FS.writeFile(
    "/uae_system/puae_libretro_global.uae",
    "cpu_compatible=true\ncpu_cycle_exact=true\ncpu_memory_cycle_exact=true\nblitter_cycle_exact=true\n",
  );
  console.log("Mode: cycle-exact (cpu_cycle_exact + blitter_cycle_exact)");
} else {
  console.log("Mode: compatible (non-CE, default)");
}

const ok = M.ccall("wasm_boot", "number", ["string"], [""]);
console.log("wasm_boot ->", ok);

for (let i = 0; i < 200; i++) M._wasm_tick();

// ── RPC harness ──────────────────────────────────────────────────────────────

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

send("pause");

const emu = {
  async getCpuInfo() { return request("getCpuInfo"); },
  async setRegister(name, value) {
    const r = await request("setRegister", { name, value });
    if (r?.error) throw new Error(r.error);
    return r;
  },
  async jump(address) {
    const r = await request("jump", { address });
    if (r?.error) throw new Error(r.error);
  },
  async readMemory(address, count) {
    const r = await request("readMemory", { address, count });
    return Buffer.from(r.data);
  },
  async writeMemory(address, data) {
    await request("writeMemory", { address, data: new Uint8Array(data) });
  },
  async peek32(address) { return request("peek32", { address }); },
  async peek16(address) { return request("peek16", { address }); },
  async peek8(address) { return request("peek8", { address }); },
  async poke32(address, value) { await request("poke32", { address, value }); },
  async poke16(address, value) { await request("poke16", { address, value }); },
  async poke8(address, value) { await request("poke8", { address, value }); },
};

// ── Load blit-test.exe ───────────────────────────────────────────────────────

const hunks = await parseHunksFromFile(new URL("../blit-test.exe", import.meta.url).pathname);
console.log("hunks:", hunks.map((h) => `[${h.index}] ${h.hunkType} ${h.allocSize}B ${h.memType}`).join("  "));

const program = await loadAmigaProgram(emu, hunks);
console.log("entryPoint: 0x" + program.entryPoint.toString(16).padStart(8, "0"));

// ── Framebuffer transition scanner ───────────────────────────────────────────

// Finds the first row where COLOR00 changes from the idle color at row 0.
// Returns { transitionRow, height, idleRgb, activeRgb } where transitionRow is
// -1 if the screen is a solid colour (blit completed before display start).
function findTransition() {
  const ptr = M._wasm_get_fb_rgba();
  const width = M._wasm_get_fb_width();
  const height = M._wasm_get_fb_height();
  const fb = new Uint8Array(M.HEAPU8.buffer, ptr, width * height * 4);

  // Use the leftmost pixel of each row as the COLOR00 sample.
  const baseR = fb[0], baseG = fb[1], baseB = fb[2];

  for (let row = 1; row < height; row++) {
    const i = row * width * 4;
    const r = fb[i], g = fb[i + 1], b = fb[i + 2];
    if (Math.abs(r - baseR) + Math.abs(g - baseG) + Math.abs(b - baseB) > 24) {
      return { transitionRow: row, height, width, idleRgb: [baseR, baseG, baseB], activeRgb: [r, g, b] };
    }
  }
  return { transitionRow: -1, height, width, idleRgb: [baseR, baseG, baseB], activeRgb: null };
}

// ── Run and measure ───────────────────────────────────────────────────────────

await emu.jump(program.entryPoint);
M._wasm_resume();

// Allow the program to initialise (call exec, set up hardware) before measuring.
const INIT_FRAMES = 5;
const MEASURE_FRAMES = 10;
let fc = M._wasm_get_frame_count();

function tickOneFrame() {
  let ticks = 0;
  while (M._wasm_get_frame_count() === fc && ticks < 1000) {
    M._wasm_tick();
    ticks++;
  }
  fc = M._wasm_get_frame_count();
}

console.log(`\nInit (${INIT_FRAMES} frames)...`);
for (let i = 0; i < INIT_FRAMES; i++) tickOneFrame();

console.log(`Measuring (${MEASURE_FRAMES} frames):\n`);
const results = [];
for (let f = 0; f < MEASURE_FRAMES; f++) {
  tickOneFrame();
  const { transitionRow, height, width, idleRgb, activeRgb } = findTransition();
  results.push({ transitionRow, height });

  if (transitionRow < 0) {
    console.log(
      `frame ${f + 1}: fb=${width}x${height}  ` +
      `no transition — entire display is rgb(${idleRgb.join(",")})` +
      ` [blit may have finished before display or all-same-color screen]`,
    );
  } else {
    const pct = ((transitionRow / height) * 100).toFixed(1);
    console.log(
      `frame ${f + 1}: fb=${width}x${height}  ` +
      `blit done at row ${transitionRow}/${height} (${pct}%)  ` +
      `idle=rgb(${idleRgb.join(",")}) → active=rgb(${activeRgb.join(",")})`,
    );
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────

const valid = results.filter((r) => r.transitionRow >= 0);
if (valid.length > 0) {
  const avg = valid.reduce((s, r) => s + r.transitionRow / r.height, 0) / valid.length;
  const min = Math.min(...valid.map((r) => r.transitionRow));
  const max = Math.max(...valid.map((r) => r.transitionRow));
  console.log(
    `\nSummary over ${valid.length} frames: avg ${(avg * 100).toFixed(1)}% of frame  min=${min} max=${max} rows`,
  );
  console.log(
    `On real hw (no blit hog, blitter-only DMA): expect ~2× longer blit → completion ≈${(avg * 2 * 100).toFixed(1)}% of frame`,
  );
} else {
  console.log("\nNo transitions detected — check that the program is running correctly.");
}
