import fs from "node:fs";
import createPuaeModule from "../../puae/puae.js";

function readCycleCount(M) {
  M._wasm_read_cycle_count();
  const lo = M._wasm_get_cycle_count_lo();
  const hi = M._wasm_get_cycle_count_hi();
  return BigInt(hi) * 0x100000000n + BigInt(lo);
}

function readInstrCount(M) {
  M._wasm_read_instr_count();
  const lo = M._wasm_get_instr_count_lo();
  const hi = M._wasm_get_instr_count_hi();
  return BigInt(hi) * 0x100000000n + BigInt(lo);
}

const CODE_ADDR = 0x20000;
const NOP_COUNT = 30000;

async function diag(label, extraConfig, disableDma) {
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

  // Let the OS get going, until DMACON shows DMAEN+BPLEN and BPLCON0 shows
  // at least one bitplane active (i.e. the boot screen is actually being
  // displayed via bitplane DMA).
  let ticks = 0;
  for (; ticks < 500; ticks++) {
    M._wasm_tick();
    const dmacon = peekWord(0xdff002);
    const bplcon0 = peekWord(0xdff100);
    if ((dmacon & 0x0300) === 0x0300 && (bplcon0 & 0x7000) !== 0) break;
  }
  console.log(`  (reached active-display state after ${ticks} ticks)`);

  M._wasm_pause();

  // Write NOP_COUNT NOPs followed by an infinite self-branch (BRA $-2).
  for (let i = 0; i < NOP_COUNT; i++) {
    M._wasm_poke_memory(CODE_ADDR + i * 2, 0x4e71, 2);
  }
  M._wasm_poke_memory(CODE_ADDR + NOP_COUNT * 2, 0x60fe, 2);

  // Peek DMACONR ($DFF002) and BPLCON0 ($DFF100) before any DMACON write, to
  // see what's actually active at our sample point.
  function peekWord(addr) {
    M._wasm_peek_memory(addr, 2);
    const buf = M._wasm_get_mem_buf();
    return (M.HEAPU8[buf] << 8) | M.HEAPU8[buf + 1];
  }
  const dmaconBefore = peekWord(0xdff002);
  const bplcon0 = peekWord(0xdff100);

  if (disableDma) {
    // DMACON ($DFF096): bit15=0 means "clear" the bits set below.
    // 0x7FFF clears all DMA enable bits, including the master DMAEN (bit9).
    M._wasm_poke_memory(0xdff096, 0x7fff, 2);
  }
  const dmaconAfter = peekWord(0xdff002);
  console.log(
    `  dmacon before=0x${dmaconBefore.toString(16)} after=0x${dmaconAfter.toString(16)} bplcon0=0x${bplcon0.toString(16)} (BPU=${(bplcon0 >> 12) & 7})`,
  );

  // SR = supervisor, interrupt mask = 7 (all interrupts masked off), so we
  // don't get diverted into OS exception handlers mid-benchmark.
  M._wasm_set_reg(16, 0x2700);
  // PC -> our NOP run.
  M._wasm_set_reg(17, CODE_ADDR);

  M._wasm_resume();

  const c0 = readCycleCount(M);
  const i0 = readInstrCount(M);
  M._wasm_tick();
  const c1 = readCycleCount(M);
  const i1 = readInstrCount(M);

  const cycles = c1 - c0;
  const instrs = i1 - i0;
  console.log(`=== ${label} === wasm_boot -> ${ok}`);
  console.log(`  cycles=${cycles}  instrs=${instrs}  cycles/instr=${Number(cycles) / Number(instrs)}`);
}

await diag("DMA enabled (normal)", "", false);
await diag("DMA disabled (DMACON cleared)", "", true);
await diag("DMA enabled, cycle-exact", "cpu_compatible=true\ncpu_cycle_exact=true\ncpu_memory_cycle_exact=true\nblitter_cycle_exact=true\n", false);
await diag("DMA disabled, cycle-exact", "cpu_compatible=true\ncpu_cycle_exact=true\ncpu_memory_cycle_exact=true\nblitter_cycle_exact=true\n", true);
