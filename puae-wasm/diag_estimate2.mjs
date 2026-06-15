import fs from "node:fs";
import createPuaeModule from "../puae/puae.js";

const CYCLE_BITPLANE = 1;
const CYCLE_MASK = 0x0f;

async function diag(label, extraConfig) {
  const M = await createPuaeModule();

  M.FS.mkdir("/uae_system");
  M.FS.writeFile("/uae_system/kick34005.A500", fs.readFileSync("/Users/BatesGW1/projects/spike-puae-wasm/kick34005.A500"));
  M.FS.writeFile(
    "/uae_system/puae_libretro_global.uae",
    "nr_floppies=0\nfloppy0type=-1\nchipmem_size=4\nfastmem_size=2\n" + extraConfig,
  );

  const ok = M.ccall("wasm_boot", "number", ["string"], [""]);
  console.log(`=== ${label} === wasm_boot -> ${ok}`);

  // Free-run for a while to get well into the boot screen with DMA active.
  for (let i = 0; i < 200; i++) M._wasm_tick();
  M._wasm_pause();

  const maxhpos = M._wasm_get_dma_diag(8, 0);
  console.log(`  maxhpos=${maxhpos}`);

  // Now free-run line-by-line: for each hsync (vpos change), dump
  // estimated_cycles[] vs cycle_line_slot[] across the WHOLE previous line
  // right after it completes (hpos wraps back to a small value).
  let lastVpos = M._wasm_get_dma_diag(4, 0);
  let dumped = 0;

  for (let i = 0; i < 200000 && dumped < 3; i++) {
    M._wasm_step_instr();
    for (let j = 0; j < 8; j++) {
      M._wasm_tick();
      if (M._wasm_is_paused()) break;
    }

    const vpos = M._wasm_get_dma_diag(4, 0);
    const hpos = M._wasm_get_dma_diag(3, 0);

    if (vpos !== lastVpos && vpos >= 60 && vpos <= 90) {
      // Just crossed into a new line - dump the full estimated vs actual
      // tables (covering the line we just left, hpos wrapped to ~0..a few).
      const est = [];
      const act = [];
      let mismatches = 0;
      for (let h = 0; h < maxhpos; h++) {
        const e = M._wasm_get_estimate_diag(0, h);
        const a = M._wasm_get_dma_diag(9, h);
        est.push(e);
        act.push(a & CYCLE_MASK);
        if (e === 1 && (a & CYCLE_MASK) !== CYCLE_BITPLANE) mismatches++;
      }
      const lineCyclebased = M._wasm_get_estimate_diag(4, 0);
      const bprun = M._wasm_get_estimate_diag(5, 0);
      const bprunEnd = M._wasm_get_estimate_diag(6, 0);
      const dmaconBpl = M._wasm_get_estimate_diag(7, 0);
      const vdiwstateBpl = M._wasm_get_estimate_diag(8, 0);
      const ddfStopping = M._wasm_get_estimate_diag(9, 0);
      const estimatedEmpty = M._wasm_get_estimate_diag(10, 0);
      console.log(`--- line transition: vpos ${lastVpos} -> ${vpos}, hpos now=${hpos} --- line_cyclebased=${lineCyclebased} bprun=${bprun} bprun_end=${bprunEnd} dmacon_bpl=${dmaconBpl} vdiwstate_bpl=${vdiwstateBpl} ddf_stopping=${ddfStopping} estimated_empty=${estimatedEmpty}`);
      console.log(`  estimated_cycles[]: ${est.join(",")}`);
      console.log(`  cycle_line_slot[] : ${act.join(",")}`);
      console.log(`  mismatches (estimated==1 but slot!=CYCLE_BITPLANE): ${mismatches} / ${est.filter(x=>x===1).length} predicted`);
      dumped++;
    }
    lastVpos = vpos;
  }
}

await diag("cycle-exact requested", "cpu_compatible=true\ncpu_cycle_exact=true\ncpu_memory_cycle_exact=true\nblitter_cycle_exact=true\n");
