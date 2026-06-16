import fs from "node:fs";
import createPuaeModule from "../../puae/puae.js";

async function diag(label, extraConfig) {
  const M = await createPuaeModule();

  M.FS.mkdir("/uae_system");
  M.FS.writeFile("/uae_system/kick34005.A500", fs.readFileSync("/Users/BatesGW1/projects/spike-puae-wasm/kick34005.A500"));

  M.FS.writeFile(
    "/uae_system/puae_libretro_global.uae",
    "nr_floppies=0\nfloppy0type=-1\nchipmem_size=4\nfastmem_size=2\n" + extraConfig,
  );

  const ok = M.ccall("wasm_boot", "number", ["string"], [""]);

  const cpuModel = M._wasm_get_cpu_model();
  const cpuFlags = M._wasm_get_cpu_flags();
  const m68kSpeed = M._wasm_get_m68k_speed();

  console.log(`=== ${label} ===`);
  console.log("wasm_boot ->", ok);
  console.log("cpu_model:", cpuModel);
  console.log(
    "cpu_flags:",
    cpuFlags,
    `(compatible=${!!(cpuFlags & 1)}, cycle_exact=${!!(cpuFlags & 2)}, memory_cycle_exact=${!!(cpuFlags & 4)}, blitter_cycle_exact=${!!(cpuFlags & 8)})`,
  );
  console.log("m68k_speed:", m68kSpeed);
}

await diag("default", "");
await diag("cycle-exact requested", "cpu_compatible=true\ncpu_cycle_exact=true\ncpu_memory_cycle_exact=true\nblitter_cycle_exact=true\n");
