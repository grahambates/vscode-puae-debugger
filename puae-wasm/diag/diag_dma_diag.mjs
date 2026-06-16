import fs from "node:fs";
import createPuaeModule from "../../puae/puae.js";

const CODE_ADDR = 0x20000;

async function diag(label, extraConfig) {
  const M = await createPuaeModule();

  M.FS.mkdir("/uae_system");
  M.FS.writeFile("/uae_system/kick34005.A500", fs.readFileSync(new URL("../../puae/kick34005.A500", import.meta.url).pathname));
  M.FS.writeFile(
    "/uae_system/puae_libretro_global.uae",
    "nr_floppies=0\nfloppy0type=-1\nchipmem_size=4\nfastmem_size=2\n" + extraConfig,
  );

  const ok = M.ccall("wasm_boot", "number", ["string"], [""]);

  function peekWord(addr) {
    M._wasm_peek_memory(addr, 2);
    const buf = M._wasm_get_mem_buf();
    return (M.HEAPU8[buf] << 8) | M.HEAPU8[buf + 1];
  }

  let ticks = 0;
  for (; ticks < 500; ticks++) {
    M._wasm_tick();
    const dmacon = peekWord(0xdff002);
    const bplcon0 = peekWord(0xdff100);
    if ((dmacon & 0x0300) === 0x0300 && (bplcon0 & 0x7000) !== 0) break;
  }

  const dmacon = peekWord(0xdff002);
  const bplcon0 = peekWord(0xdff100);

  console.log(`=== ${label} === wasm_boot -> ${ok} (after ${ticks} ticks)`);
  console.log(`  dmacon=0x${dmacon.toString(16)} bplcon0=0x${bplcon0.toString(16)} (BPU=${(bplcon0 >> 12) & 7})`);
  console.log(`  ce_banktype[0x20000>>16] = ${M._wasm_get_dma_diag(0, CODE_ADDR)}  (1=CHIP16 2=CHIP32 4=FAST16 0=FAST32)`);
  console.log(`  ce_banktype[0xdff000>>16] = ${M._wasm_get_dma_diag(0, 0xdff000)}`);
  console.log(`  cpu_tracer = ${M._wasm_get_dma_diag(1, 0)}`);
  console.log(`  cpu_memory_cycle_exact = ${M._wasm_get_dma_diag(2, 0)}`);
  console.log(`  current_hpos = ${M._wasm_get_dma_diag(3, 0)}`);
  console.log(`  vpos = ${M._wasm_get_dma_diag(4, 0)}`);
  console.log(`  cycle_line_slot[hpos] = ${M._wasm_get_dma_diag(5, 0)}`);
  console.log(`  #slots with CYCLE_MASK set this line = ${M._wasm_get_dma_diag(6, 0)}`);

  // Sample across several ticks/frames to see if the allocated-slot count
  // ever becomes non-zero.
  let maxSlots = 0;
  let maxTracer = -999;
  for (let i = 0; i < 50; i++) {
    M._wasm_tick();
    const slots = M._wasm_get_dma_diag(6, 0);
    const tracer = M._wasm_get_dma_diag(1, 0);
    if (slots > maxSlots) maxSlots = slots;
    if (tracer > maxTracer) maxTracer = tracer;
  }
  console.log(`  over next 50 ticks: max #slots-with-CYCLE_MASK = ${maxSlots}, max cpu_tracer = ${maxTracer}`);
}

await diag("default", "");
await diag("cycle-exact requested", "cpu_compatible=true\ncpu_cycle_exact=true\ncpu_memory_cycle_exact=true\nblitter_cycle_exact=true\n");
