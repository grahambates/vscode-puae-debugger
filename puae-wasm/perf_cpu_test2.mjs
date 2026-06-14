import fs from "node:fs";
import createPuaeModule from "../puae/puae.js";
import { tryExec, getCurrentProcess } from "../puae/puae_rpc.js";

async function run(label, cpuConfigLine) {
  const M = await createPuaeModule();
  M.FS.mkdir("/uae_system");
  M.FS.writeFile("/uae_system/kick34005.A500", fs.readFileSync("../puae/kick34005.A500"));
  M.FS.writeFile(
    "/uae_system/puae_libretro_global.uae",
    `filesystem=rw,dh0:/uae_system/dh0\nnr_floppies=0\nfloppy0type=-1\nchipmem_size=4\nfastmem_size=2\n${cpuConfigLine}\n`,
  );
  M.FS.mkdir("/uae_system/dh0");
  M.FS.writeFile("/uae_system/dh0/file", fs.readFileSync("./hunk.exe"));
  M.FS.mkdir("/uae_system/dh0/s");
  M.FS.writeFile("/uae_system/dh0/s/startup-sequence", "file");

  M.ccall("wasm_boot", "number", ["string"], [""]);

  let execReady = false, attached = false, allocMemAddr = 0, proc = null;
  const MAX_TICKS = 500;
  let i = 0;
  const tBootStart = Date.now();
  for (; i < MAX_TICKS && !attached; i++) {
    M._wasm_tick();
    await new Promise((r) => setImmediate(r));
    if (!execReady) {
      const r = tryExec(M);
      if (r.ready) { execReady = true; allocMemAddr = r.allocMemAddr; }
    }
    if (M._wasm_is_paused()) {
      if (execReady) {
        proc = getCurrentProcess(M);
        if (proc) { M._wasm_remove_breakpoint(allocMemAddr); attached = true; }
        else M._wasm_resume();
      } else M._wasm_resume();
    }
  }
  const tBootEnd = Date.now();
  console.log(`${label}: boot+attach after ${i} ticks in ${tBootEnd - tBootStart}ms (${((tBootEnd-tBootStart)/i).toFixed(2)}ms/tick), attached=${attached}`);

  // now run steady-state ticks (program executing)
  const STEADY = 100;
  const t0 = Date.now();
  for (let j = 0; j < STEADY; j++) {
    M._wasm_tick();
    await new Promise((r) => setImmediate(r));
  }
  const t1 = Date.now();
  console.log(`${label}: steady-state ${STEADY} ticks in ${t1-t0}ms => ${((t1-t0)/STEADY).toFixed(2)}ms/tick`);
}

await run("68020", "cpu_model=68020");
await run("68040 (default, fake prefetch)", "cpu_model=68040");
await run("68040 cpu_compatible=false", "cpu_model=68040\ncpu_compatible=false");
await run("68040 cpu_cycle_exact=true", "cpu_model=68040\ncpu_cycle_exact=true");
await run("68060 (default)", "cpu_model=68060");
await run("68060 cpu_compatible=false", "cpu_model=68060\ncpu_compatible=false");
