// Memory / custom-register reconstruction from the DMA grid (webview-side — this is
// where the future memory/screen/blitter views that consume it live). Memory at a point
// in the capture = the capture-start snapshot with every WRITE cell from slot 0..sliceEnd
// applied in order; the slot index IS the time cursor. Ports the old vscode-amiga-debug
// GetMemoryAfterDma / GetCustomRegsAfterDma, adapted to our enriched grid (flags-based
// write/size + owner-aware custom-register routing).
//
// The capture-start snapshot (chip/slow RAM + the custom-register baseline) IS shipped to
// the webview (model.dmaSnapshot); reconstructCustomRegs is wired into the DMA tooltip's
// "DMA Control" view. reconstructMemoryAt is still unwired (no memory/screen consumer yet).
//
// Known gaps: FAST-RAM writes bypass the chip bus (not recorded); copper colour-register
// writes (0x180..0x1BE) bypass doCopperDmaWrite in vAmiga (not in the grid); the custom-
// register baseline covers readable regs + DMACON exactly, other write-only regs start at 0.

import { IDmaModel, DmaSnapshot, DMA_WRITE, DMA_BYTE, dmaIsCustomReg } from "../../shared/profilerTypes";

const SLOW_BASE = 0xc00000;
const REG_DMACON = 0x096;
const DMACON_SETCLR = 0x8000;

// Reconstruct chip + slow RAM at slot `sliceEnd` (exclusive): fresh copies of the
// snapshot with all preceding non-register WRITE cells applied.
export function reconstructMemoryAt(
  dma: IDmaModel,
  snapshot: DmaSnapshot,
  sliceEnd: number,
): DmaSnapshot {
  const chip = new Uint8Array(snapshot.chip);
  const slow = new Uint8Array(snapshot.slow);
  const end = Math.min(sliceEnd, dma.owner.length);

  for (let i = 0; i < end; i++) {
    const flags = dma.flags[i];
    if (!(flags & DMA_WRITE)) continue;
    if (dmaIsCustomReg(dma.owner[i], flags, dma.addr[i])) continue; // register, not RAM

    const a = dma.addr[i] >>> 0;
    const isByte = (flags & DMA_BYTE) !== 0;
    const v = dma.value[i];

    let buf: Uint8Array | undefined;
    let off = 0;
    if (slow.length && a >= SLOW_BASE && a < SLOW_BASE + slow.length) {
      buf = slow;
      off = a - SLOW_BASE;
    } else if (a < chip.length) {
      buf = chip;
      off = a & (chip.length - 1); // chip mirrors
    }
    if (!buf) continue;

    if (isByte) {
      if (off < buf.length) buf[off] = v & 0xff; // byte value sits in the low half
    } else if (off + 1 < buf.length) {
      buf[off] = (v >> 8) & 0xff; // big-endian (m68k)
      buf[off + 1] = v & 0xff;
    }
  }
  // Custom registers aren't RAM; pass the baseline through unchanged so the result is a
  // complete DmaSnapshot (use reconstructCustomRegs for register state at a slot).
  return { chip, slow, custom: snapshot.custom };
}

// Reconstruct the 256-entry custom-register file (u16 each) at slot `sliceEnd`, starting
// from `base` and replaying register WRITE cells (DMACON SETCLR-aware). Owner-aware so a
// Copper MOVE (bus addr = bare offset) is treated as a register write, not chip RAM.
export function reconstructCustomRegs(
  dma: IDmaModel,
  base: Uint16Array,
  sliceEnd: number,
): Uint16Array {
  const regs = new Uint16Array(base);
  const end = Math.min(sliceEnd, dma.owner.length);

  for (let i = 0; i < end; i++) {
    const flags = dma.flags[i];
    if (!(flags & DMA_WRITE)) continue;
    if (!dmaIsCustomReg(dma.owner[i], flags, dma.addr[i])) continue;

    const reg = dma.addr[i] & 0x1fe;
    const v = dma.value[i];
    if (reg === REG_DMACON) {
      if (v & DMACON_SETCLR) regs[reg >> 1] |= v & 0x7fff;
      else regs[reg >> 1] &= ~v & 0x7fff;
    } else {
      regs[reg >> 1] = v;
    }
  }
  return regs;
}
