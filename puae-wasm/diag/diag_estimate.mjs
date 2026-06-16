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

  // Free-run for a while to get well into the boot screen with DMA active.
  for (let i = 0; i < 200; i++) M._wasm_tick();

  M._wasm_read_display_regs();
  const dispBuf = M._wasm_get_display_regs_buf();
  const bplcon0 = M.HEAPU16[dispBuf / 2];
  const ddfstrt = M.HEAPU16[dispBuf / 2 + 6];
  const ddfstop = M.HEAPU16[dispBuf / 2 + 7];
  console.log(`=== ${label} === wasm_boot -> ${ok}`);
  console.log(`  internal bplcon0=0x${bplcon0.toString(16)} (BPU=${(bplcon0 >> 12) & 7}) ddfstrt=0x${ddfstrt.toString(16)} ddfstop=0x${ddfstop.toString(16)}`);

  M._wasm_pause();

  const maxhpos = M._wasm_get_dma_diag(8, 0);

  let maxEC = 0, maxECN = 0;
  let lineCyclebasedSeen = new Set();
  let bprunSeen = new Set();
  let dmaconBplSeen = new Set();
  let vdiwstateBplSeen = new Set();
  let vposRange = [1 << 30, -1];

  const STEPS = 4000;
  for (let i = 0; i < STEPS; i++) {
    M._wasm_step_instr();
    for (let j = 0; j < 8; j++) {
      M._wasm_tick();
      if (M._wasm_is_paused()) break;
    }

    const vpos = M._wasm_get_dma_diag(4, 0);
    if (vpos < vposRange[0]) vposRange[0] = vpos;
    if (vpos > vposRange[1]) vposRange[1] = vpos;

    const ec = M._wasm_get_estimate_diag(2, 0);
    const ecn = M._wasm_get_estimate_diag(3, 0);
    if (ec > maxEC) maxEC = ec;
    if (ecn > maxECN) maxECN = ecn;

    lineCyclebasedSeen.add(M._wasm_get_estimate_diag(4, 0));
    bprunSeen.add(M._wasm_get_estimate_diag(5, 0));
    dmaconBplSeen.add(M._wasm_get_estimate_diag(7, 0));
    vdiwstateBplSeen.add(M._wasm_get_estimate_diag(8, 0));
  }

  console.log(`  maxhpos=${maxhpos}, vpos range over ${STEPS} steps: [${vposRange[0]}, ${vposRange[1]}]`);
  console.log(`  max #hpos with estimated_cycles[hpos]>0 = ${maxEC}`);
  console.log(`  max #hpos with estimated_cycles_next[hpos]>0 = ${maxECN}`);
  console.log(`  line_cyclebased values seen: ${[...lineCyclebasedSeen].join(",")}`);
  console.log(`  bprun values seen: ${[...bprunSeen].join(",")}`);
  console.log(`  dmacon_bpl values seen: ${[...dmaconBplSeen].join(",")}`);
  console.log(`  vdiwstate_bpl values seen: ${[...vdiwstateBplSeen].join(",")}`);

  // Dump estimated_cycles[] across all hpos at the final sample point.
  const ecVals = [];
  for (let h = 0; h < maxhpos; h++) ecVals.push(M._wasm_get_estimate_diag(0, h));
  console.log(`  estimated_cycles[] at final sample: ${ecVals.join(",")}`);
}

await diag("default", "");
await diag("cycle-exact requested", "cpu_compatible=true\ncpu_cycle_exact=true\ncpu_memory_cycle_exact=true\nblitter_cycle_exact=true\n");
