// The bulk binary of a capture (DMA grid + chip/slow snapshot) packed into one buffer for
// transfer to the webview via the resource loader (fetch), instead of postMessage — VS Code's
// extension-host→webview message serializer is slow for large binary (a 1MB array ~ 800ms),
// while a fetched resource streams efficiently. packBulk runs in the extension; unpackBulk in
// the webview. Both are dependency-light (only the pure decodeDmaGrid), so the webview bundle
// doesn't pull in the DWARF/sourcemap code.
//
// Layout (little-endian):
//   [u32 gridLen][u32 chipLen][u32 slowLen][u32 customLen][u32 copperLen]
//   [grid][chip][slow][custom][copper].
// `custom` is the raw custom-register baseline bytes (256 LE u16); decoded on unpack.
// `copper` is the raw copper-instruction-trace bytes (12-byte records); decoded on unpack.

import type { RawCapture } from "./profilerManager";
import { decodeDmaGrid, decodeCustomRegs, decodeCopperRecords } from "./dma";
import { IDmaModel, DmaSnapshot, ICopperModel } from "./shared/profilerTypes";

const HEADER = 20;
const EMPTY = new Uint8Array(0);

export function packBulk(raw: RawCapture): Uint8Array | undefined {
  if (!raw.dma) return undefined;
  const grid = raw.dma;
  const chip = raw.snapshot?.chip ?? EMPTY;
  const slow = raw.snapshot?.slow ?? EMPTY;
  const custom = raw.snapshot?.custom ?? EMPTY;
  const copper = raw.copper ?? EMPTY;
  const out = new Uint8Array(HEADER + grid.length + chip.length + slow.length + custom.length + copper.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, grid.length, true);
  dv.setUint32(4, chip.length, true);
  dv.setUint32(8, slow.length, true);
  dv.setUint32(12, custom.length, true);
  dv.setUint32(16, copper.length, true);
  let off = HEADER;
  out.set(grid, off); off += grid.length;
  out.set(chip, off); off += chip.length;
  out.set(slow, off); off += slow.length;
  out.set(custom, off); off += custom.length;
  out.set(copper, off);
  return out;
}

export function unpackBulk(buf: ArrayBuffer): { dma?: IDmaModel; dmaSnapshot?: DmaSnapshot; copper?: ICopperModel } {
  // Validate before slicing: a truncated/corrupt buffer must not throw a raw RangeError
  // (or read past the end) deeper in the typed-array constructors below.
  if (buf.byteLength < HEADER) throw new Error(`unpackBulk: buffer too small (${buf.byteLength} < ${HEADER} byte header)`);
  const dv = new DataView(buf);
  const gridLen = dv.getUint32(0, true);
  const chipLen = dv.getUint32(4, true);
  const slowLen = dv.getUint32(8, true);
  const customLen = dv.getUint32(12, true);
  const copperLen = dv.getUint32(16, true);
  const need = HEADER + gridLen + chipLen + slowLen + customLen + copperLen;
  if (need > buf.byteLength) throw new Error(`unpackBulk: section lengths (${need}) exceed buffer (${buf.byteLength})`);
  let off = HEADER;
  const grid = new Uint8Array(buf, off, gridLen); off += gridLen;
  const chip = new Uint8Array(buf, off, chipLen); off += chipLen;
  const slow = new Uint8Array(buf, off, slowLen); off += slowLen;
  const custom = new Uint8Array(buf, off, customLen); off += customLen;
  const copper = new Uint8Array(buf, off, copperLen);
  return {
    dma: decodeDmaGrid(grid),
    // Copy out of the fetched buffer so the arrays stand alone.
    dmaSnapshot: chipLen || slowLen ? { chip: new Uint8Array(chip), slow: new Uint8Array(slow), custom: decodeCustomRegs(custom) } : undefined,
    copper: decodeCopperRecords(copper),
  };
}
