// Extension-side DMA grid decode: turn the emulator's binary grid into an IDmaModel.
// (Reconstruction lives webview-side in src/webview/profilerViewer/reconstruct.ts.)
//
// The grid is the emulator's DmaProfiler::Cell[] — one 8-byte record per dma-cycle,
// little-endian: { u8 owner; u8 flags; u16 data; u32 addr }. See
// vamigaweb_fork/Core/Profiler/DmaProfiler.h.

import { IDmaModel, ICopperModel } from "./shared/profilerTypes";

const CELL_BYTES = 8;
const COPPER_RECORD_BYTES = 12;

// Decode the interleaved Cell[8] byte stream into the four parallel typed arrays.
// Grid geometry is the fixed PAL DMA_HPOS×DMA_VPOS (no runtime dimension). Returns
// undefined for an empty/!plausible buffer.
export function decodeDmaGrid(bytes: Uint8Array): IDmaModel | undefined {
  if (!bytes || bytes.byteLength < CELL_BYTES) return undefined;
  const count = (bytes.byteLength / CELL_BYTES) | 0;
  if (count === 0) return undefined;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const owner = new Uint8Array(count);
  const flags = new Uint8Array(count);
  const addr = new Uint32Array(count);
  const value = new Uint16Array(count);

  for (let i = 0; i < count; i++) {
    const o = i * CELL_BYTES;
    owner[i] = view.getUint8(o);
    flags[i] = view.getUint8(o + 1);
    value[i] = view.getUint16(o + 2, true);
    addr[i] = view.getUint32(o + 4, true);
  }
  return { owner, flags, addr, value };
}

// Decode the emulator's copper-instruction trace (puae_copper_serialize): 12-byte
// little-endian records { u32 addr; u16 w1; u16 w2; u16 hpos; u16 vpos }, one per executed
// instruction. Returns undefined for an empty/too-small buffer.
export function decodeCopperRecords(bytes: Uint8Array): ICopperModel | undefined {
  if (!bytes || bytes.byteLength < COPPER_RECORD_BYTES) return undefined;
  const count = (bytes.byteLength / COPPER_RECORD_BYTES) | 0;
  if (count === 0) return undefined;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const addr = new Uint32Array(count);
  const w1 = new Uint16Array(count);
  const w2 = new Uint16Array(count);
  const hpos = new Uint16Array(count);
  const vpos = new Uint16Array(count);

  for (let i = 0; i < count; i++) {
    const o = i * COPPER_RECORD_BYTES;
    addr[i] = view.getUint32(o, true);
    w1[i] = view.getUint16(o + 4, true);
    w2[i] = view.getUint16(o + 6, true);
    hpos[i] = view.getUint16(o + 8, true);
    vpos[i] = view.getUint16(o + 10, true);
  }
  return { addr, w1, w2, hpos, vpos };
}

// Decode the custom-register baseline (the DmaProfiler spypeek snapshot) — 256 u16,
// little-endian, indexed by register-offset/2. Always returns a 256-entry array; missing
// or short input yields zeros so the register/DMACON lookups stay in-bounds.
export function decodeCustomRegs(bytes: Uint8Array | undefined): Uint16Array {
  const regs = new Uint16Array(256);
  if (!bytes || bytes.byteLength < 2) return regs;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = Math.min(256, bytes.byteLength >>> 1);
  for (let i = 0; i < n; i++) regs[i] = view.getUint16(i * 2, true);
  return regs;
}
