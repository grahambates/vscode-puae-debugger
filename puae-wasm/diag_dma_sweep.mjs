import fs from "node:fs";
import createPuaeModule from "../puae/puae.js";

async function diag(label, extraConfig) {
  const M = await createPuaeModule();

  M.FS.mkdir("/uae_system");
  M.FS.writeFile("/uae_system/kick34005.A500", fs.readFileSync("../puae/kick34005.A500"));
  M.FS.writeFile(
    "/uae_system/puae_libretro_global.uae",
    "nr_floppies=0\nfloppy0type=-1\nchipmem_size=4\nfastmem_size=2\n" + extraConfig,
  );

  const ok = M.ccall("wasm_boot", "number", ["string"], [""]);

  // Free-run for a while to get well into the boot screen with DMA active.
  for (let i = 0; i < 200; i++) M._wasm_tick();

  // Read the *internal* display registers (not the open-bus echo from a raw
  // peek of $DFF1xx), via the debugger's display-regs export.
  M._wasm_read_display_regs();
  const dispBuf = M._wasm_get_display_regs_buf();
  const bplcon0 = M.HEAPU16[dispBuf / 2];
  const diwstrt = M.HEAPU16[dispBuf / 2 + 4];
  const diwstop = M.HEAPU16[dispBuf / 2 + 5];
  const ddfstrt = M.HEAPU16[dispBuf / 2 + 6];
  const ddfstop = M.HEAPU16[dispBuf / 2 + 7];
  console.log(`  internal bplcon0=0x${bplcon0.toString(16)} (BPU=${(bplcon0 >> 12) & 7}, HIRES=${(bplcon0 >> 15) & 1})`);
  console.log(`  diwstrt=0x${diwstrt.toString(16)} diwstop=0x${diwstop.toString(16)} ddfstrt=0x${ddfstrt.toString(16)} ddfstop=0x${ddfstop.toString(16)}`);

  M._wasm_pause();

  const maxhpos = M._wasm_get_dma_diag(8, 0);

  let maxVpos = -1;
  let minVpos = 1 << 30;
  let everBitplaneSlot = false;
  let maxSlotsAny = 0;
  let maxSlotsBpl = 0;
  let samplesInDisplay = 0;
  let cpuTracerSeen = new Set();

  const STEPS = 4000;
  for (let i = 0; i < STEPS; i++) {
    M._wasm_step_instr();
    for (let j = 0; j < 8; j++) {
      M._wasm_tick();
      if (M._wasm_is_paused()) break;
    }

    const vpos = M._wasm_get_dma_diag(4, 0);
    const slotsAny = M._wasm_get_dma_diag(6, 0);
    const slotsBpl = M._wasm_get_dma_diag(7, 0);
    const tracer = M._wasm_get_dma_diag(1, 0);
    cpuTracerSeen.add(tracer);

    if (vpos > maxVpos) maxVpos = vpos;
    if (vpos < minVpos) minVpos = vpos;
    if (slotsBpl > 0) everBitplaneSlot = true;
    if (slotsAny > maxSlotsAny) maxSlotsAny = slotsAny;
    if (slotsBpl > maxSlotsBpl) maxSlotsBpl = slotsBpl;

    // "Display area" heuristic: PAL DIWSTRT is typically vpos ~0x2c=44.
    if (vpos >= 44 && vpos <= 300) {
      samplesInDisplay++;
    }
  }

  console.log(`=== ${label} === wasm_boot -> ${ok}`);
  console.log(`  maxhpos=${maxhpos}`);
  console.log(`  vpos range over ${STEPS} steps: [${minVpos}, ${maxVpos}], samples in display area (44..300): ${samplesInDisplay}`);
  console.log(`  max #slots with any CYCLE_MASK set = ${maxSlotsAny}`);
  console.log(`  max #slots with CYCLE_BITPLANE = ${maxSlotsBpl} (ever seen: ${everBitplaneSlot})`);
  console.log(`  cpu_tracer values seen: ${[...cpuTracerSeen].join(",")}`);
}

await diag("cycle-exact requested", "cpu_compatible=true\ncpu_cycle_exact=true\ncpu_memory_cycle_exact=true\nblitter_cycle_exact=true\n");
