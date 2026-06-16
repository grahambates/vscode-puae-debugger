import fs from "node:fs";
import createPuaeModule from "../../puae/puae.js";

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

  for (let i = 0; i < 400; i++) M._wasm_tick();
  M._wasm_pause();

  let lastVpos = M._wasm_get_dma_diag(4, 0);
  console.log(`  initial vpos=${lastVpos}, hpos=${M._wasm_get_dma_diag(3, 0)}`);
  let targetVpos = -1;
  const rows = [];

  for (let i = 0; i < 12000; i++) {
    M._wasm_step_instr();
    for (let j = 0; j < 8; j++) {
      M._wasm_tick();
      if (M._wasm_is_paused()) break;
    }

    const vpos = M._wasm_get_dma_diag(4, 0);
    const hpos = M._wasm_get_dma_diag(3, 0);

    if (i % 500 === 0) console.log(`  i=${i} vpos=${vpos} hpos=${hpos}`);

    if (targetVpos === -1 && vpos !== lastVpos && vpos >= 65) {
      targetVpos = vpos; // lock onto the first full line after vpos 65
    }
    lastVpos = vpos;

    if (targetVpos !== -1) {
      if (vpos === targetVpos) {
        const bprun = M._wasm_get_estimate_diag(5, 0);
        const ec = M._wasm_get_estimate_diag(0, hpos);
        const cls = M._wasm_get_dma_diag(9, hpos);
        const ddfEnableOn = M._wasm_get_estimate_diag(11, 0);
        const ddfLimit = M._wasm_get_estimate_diag(12, 0);
        const hwiOld = M._wasm_get_estimate_diag(13, 0);
        const harddisH = M._wasm_get_estimate_diag(14, 0);
        const plfstrt = M._wasm_get_estimate_diag(15, 0);
        const plfstop = M._wasm_get_estimate_diag(16, 0);
        const bplHstart = M._wasm_get_estimate_diag(17, 0);
        const fetchCycle = M._wasm_get_estimate_diag(18, 0);
        const ddfstrtHpos = M._wasm_get_estimate_diag(19, 0);
        const ecsAgnus = M._wasm_get_estimate_diag(20, 0);
        const lastDecideLineHpos = M._wasm_get_estimate_diag(21, 0);
        const ddfstrtMatch = M._wasm_get_estimate_diag(22, 0);
        const plfstopPrev = M._wasm_get_estimate_diag(23, 0);
        const ddfstopHpos = M._wasm_get_estimate_diag(24, 0);
        const dmaconBpl = M._wasm_get_estimate_diag(7, 0);
        const vdiwstateBpl = M._wasm_get_estimate_diag(8, 0);
        rows.push({ hpos, bprun, ec, cls: cls & CYCLE_MASK, ddfEnableOn, ddfLimit, hwiOld, harddisH, plfstrt, plfstop, bplHstart, fetchCycle, ddfstrtHpos, ecsAgnus, lastDecideLineHpos, ddfstrtMatch, plfstopPrev, ddfstopHpos, dmaconBpl, vdiwstateBpl });
      } else if (vpos === targetVpos + 1) {
        break; // line complete
      }
    }
  }

  console.log(`  tracking vpos=${targetVpos}, ${rows.length} samples`);
  if (rows.length > 0) {
    const r0 = rows[0];
    console.log(`  ecs_agnus=${r0.ecsAgnus} ddfstrt_hpos=${r0.ddfstrtHpos} plfstrt=${r0.plfstrt} plfstop=${r0.plfstop} harddis_h=${r0.harddisH}`);
  }
  console.log("  hpos  bprun  est_cycles  cyc_slot  ddf_limit  ddfstrt_match  dma  diw  plfstop_prev  ddfstop_hpos");
  for (const r of rows) {
    if (r.hpos < 44 || r.hpos > 68) continue;
    console.log(`  ${String(r.hpos).padStart(4)}  ${String(r.bprun).padStart(5)}  ${String(r.ec).padStart(10)}  ${String(r.cls).padStart(8)}  ${String(r.ddfLimit).padStart(9)}  ${String(r.ddfstrtMatch).padStart(13)}  ${String(r.dmaconBpl).padStart(3)}  ${String(r.vdiwstateBpl).padStart(3)}  ${String(r.plfstopPrev).padStart(12)}  ${String(r.ddfstopHpos).padStart(12)}`);
  }
}

await diag("cycle-exact requested", "cpu_compatible=true\ncpu_cycle_exact=true\ncpu_memory_cycle_exact=true\nblitter_cycle_exact=true\n");
