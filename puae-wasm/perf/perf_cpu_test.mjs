import fs from "node:fs";
import createPuaeModule from "../../puae/puae.js";

async function run(label, cpuConfigLine, warmupTicks, measureTicks) {
  const M = await createPuaeModule();
  M.FS.mkdir("/uae_system");
  M.FS.writeFile("/uae_system/kick34005.A500", fs.readFileSync(new URL("../../puae/kick34005.A500", import.meta.url).pathname));
  M.FS.writeFile(
    "/uae_system/puae_libretro_global.uae",
    `nr_floppies=0\nfloppy0type=-1\nchipmem_size=4\nfastmem_size=2\n${cpuConfigLine}\n`,
  );
  M.ccall("wasm_boot", "number", ["string"], [""]);

  const t0 = Date.now();
  for (let i = 0; i < warmupTicks; i++) {
    M._wasm_tick();
    await new Promise((r) => setImmediate(r));
  }
  const t1 = Date.now();
  for (let i = 0; i < measureTicks; i++) {
    M._wasm_tick();
    await new Promise((r) => setImmediate(r));
  }
  const t2 = Date.now();
  console.log(`\n>>> ${label}: warmup(${warmupTicks})=${t1-t0}ms, measure(${measureTicks})=${t2-t1}ms => ${((t2-t1)/measureTicks).toFixed(2)}ms/tick\n`);
}

await run("68040+fpu", "cpu_model=68040\nfpu_model=68040", 50, 300);
await run("68060+fpu", "cpu_model=68060\nfpu_model=68060", 50, 300);
