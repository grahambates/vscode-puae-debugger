import createPuaeModule from "../../puae/puae.js";
import { readFixture } from "./fixtures.mjs";

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`OK   ${label}`);
  } else {
    failures++;
    console.log(`FAIL ${label}${detail ? " — " + detail : ""}`);
  }
}

// MemSrc enum values (src/emulatorProtocol.ts).
const MEM_SRC_FAST = 5;

const kickRom = readFixture("kick34005.A500");

// Boots a fresh module, optionally writing /uae_system/puae_libretro_global.uae
// (PuaeEmulator.buildExtraConfig's mechanism) before wasm_boot(), and returns
// { chipMemSize, cpuMemSrc }.
async function boot(extraConfig) {
  const M = await createPuaeModule();
  M.FS.mkdir("/uae_system");
  M.FS.writeFile("/uae_system/kick34005.A500", kickRom);
  if (extraConfig) {
    M.FS.writeFile("/uae_system/puae_libretro_global.uae", extraConfig);
  }

  const ok = M.ccall("wasm_boot", "number", ["string"], [""]);
  if (!ok) throw new Error("wasm_boot failed");

  // Run enough frames to get past reset and the Kickstart ROM overlay (CIA
  // OVL bit) — see test_g1.mjs for details.
  for (let i = 0; i < 150; i++) M._wasm_tick();

  const chipMemSize = M._wasm_get_chip_mem_size();

  M._wasm_read_memory_map();
  const ptr = M._wasm_get_memory_map_buf();
  const cpuMemSrc = Array.from(new Uint8Array(M.HEAPU8.buffer, ptr, 256));

  return { chipMemSize, cpuMemSrc };
}

// --- 1. Default boot: 512K chip RAM, no fast RAM ---
{
  const { chipMemSize, cpuMemSrc } = await boot(null);
  check("default boot: chipmem.size is 512K", chipMemSize === 0x80000,
    `0x${chipMemSize.toString(16)}`);
  check("default boot: no FAST RAM bank", !cpuMemSrc.includes(MEM_SRC_FAST),
    JSON.stringify(cpuMemSrc.slice(0, 0x30)));
}

// --- 2. puae_libretro_global.uae override: 1MB chip RAM + 1MB fast RAM ---
{
  const { chipMemSize, cpuMemSrc } = await boot("chipmem_size=2\nfastmem_size=1\n");
  check("chipmem_size=2: chipmem.size is 1MB", chipMemSize === 0x100000,
    `0x${chipMemSize.toString(16)}`);
  check("fastmem_size=1: a FAST RAM bank is present", cpuMemSrc.includes(MEM_SRC_FAST),
    JSON.stringify(cpuMemSrc.slice(0, 0x30)));
}

// --- 3. Layering: base config (256K chip) + override (1MB chip) -> override wins ---
{
  const base = "# base config (configFilePath)\nchipmem_size=0\n";
  const override = "chipmem_size=2\n";
  const { chipMemSize } = await boot(base + override);
  check("layered config: override (1MB) wins over base (256K)", chipMemSize === 0x100000,
    `0x${chipMemSize.toString(16)}`);
}

console.log("");
console.log(failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
