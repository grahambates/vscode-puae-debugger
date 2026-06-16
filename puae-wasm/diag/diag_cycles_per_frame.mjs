import fs from "node:fs";
import createPuaeModule from "../../puae/puae.js";

function readCycleCount(M) {
  M._wasm_read_cycle_count();
  const lo = M._wasm_get_cycle_count_lo();
  const hi = M._wasm_get_cycle_count_hi();
  return BigInt(hi) * 0x100000000n + BigInt(lo);
}

async function diag(label, extraConfig) {
  const M = await createPuaeModule();

  M.FS.mkdir("/uae_system");
  M.FS.writeFile("/uae_system/kick34005.A500", fs.readFileSync(new URL("../../puae/kick34005.A500", import.meta.url).pathname));
  M.FS.writeFile(
    "/uae_system/puae_libretro_global.uae",
    "nr_floppies=0\nfloppy0type=-1\nchipmem_size=4\nfastmem_size=2\n" + extraConfig,
  );

  const ok = M.ccall("wasm_boot", "number", ["string"], [""]);
  console.log(`=== ${label} === wasm_boot -> ${ok}`);

  // Warm up.
  for (let i = 0; i < 20; i++) M._wasm_tick();

  const frame0 = M._wasm_get_frame_count();
  const c0 = readCycleCount(M);
  const N = 50;
  for (let i = 0; i < N; i++) M._wasm_tick();
  const c1 = readCycleCount(M);
  const frame1 = M._wasm_get_frame_count();

  const cycles = c1 - c0;
  const frames = frame1 - frame0;
  console.log(`  ticks=${N} frames advanced=${frames} cycles=${cycles}`);
  console.log(`  cycles/tick=${Number(cycles) / N}  cycles/frame=${frames > 0 ? Number(cycles) / frames : NaN}`);
  console.log(`  expected PAL cycles/frame ~142047, NTSC ~119431`);
}

await diag("default", "");
