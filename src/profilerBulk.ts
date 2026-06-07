// The bulk binary of a capture (DMA grid + chip/slow snapshot) packed into one buffer for
// transfer to the webview via the resource loader (fetch), instead of postMessage — VS Code's
// extension-host→webview message serializer is slow for large binary (a 1MB array ~ 800ms),
// while a fetched resource streams efficiently. packBulk runs in the extension; unpackBulk in
// the webview. Both are dependency-light (only the pure decodeDmaGrid), so the webview bundle
// doesn't pull in the DWARF/sourcemap code.
//
// Layout (little-endian): [u32 gridLen][u32 chipLen][u32 slowLen][grid][chip][slow].

import type { RawCapture } from "./profilerManager";
import { decodeDmaGrid } from "./dma";
import { IDmaModel, DmaSnapshot } from "./shared/profilerTypes";

const HEADER = 12;
const EMPTY = new Uint8Array(0);

export function packBulk(raw: RawCapture): Uint8Array | undefined {
  if (!raw.dma) return undefined;
  const grid = raw.dma;
  const chip = raw.snapshot?.chip ?? EMPTY;
  const slow = raw.snapshot?.slow ?? EMPTY;
  const out = new Uint8Array(HEADER + grid.length + chip.length + slow.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, grid.length, true);
  dv.setUint32(4, chip.length, true);
  dv.setUint32(8, slow.length, true);
  out.set(grid, HEADER);
  out.set(chip, HEADER + grid.length);
  out.set(slow, HEADER + grid.length + chip.length);
  return out;
}

export function unpackBulk(buf: ArrayBuffer): { dma?: IDmaModel; dmaSnapshot?: DmaSnapshot } {
  const dv = new DataView(buf);
  const gridLen = dv.getUint32(0, true);
  const chipLen = dv.getUint32(4, true);
  const slowLen = dv.getUint32(8, true);
  let off = HEADER;
  const grid = new Uint8Array(buf, off, gridLen); off += gridLen;
  const chip = new Uint8Array(buf, off, chipLen); off += chipLen;
  const slow = new Uint8Array(buf, off, slowLen);
  return {
    dma: decodeDmaGrid(grid),
    // Copy out of the fetched buffer so the arrays stand alone.
    dmaSnapshot: chipLen || slowLen ? { chip: new Uint8Array(chip), slow: new Uint8Array(slow) } : undefined,
  };
}
