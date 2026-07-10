// Extension-side DMA grid decode: turn the emulator's binary grid into an IDmaModel.
// (Reconstruction lives webview-side in src/webview/profilerViewer/reconstruct.ts.)
//
// The grid is the emulator's DmaProfiler::Cell[] — one 8-byte record per dma-cycle,
// little-endian: { u8 owner; u8 flags; u16 data; u32 addr } — matching the layout of
// the vAmiga emulator project's own DmaProfiler::Cell (Core/Profiler/DmaProfiler.h).

import { IDmaModel, ICopperModel } from "./shared/profilerTypes";

const CELL_BYTES = 8;
const COPPER_RECORD_BYTES = 12;
const EVENT_BYTES = 4;

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
//
// WAIT and SKIP instructions are recorded TWICE by the emulator (custom.c's record_copper):
// once when the copper first decodes the instruction (COP_wait_in2), and once when the wait
// condition is satisfied / skip comparison done (COP_wait/COP_skip). We want each instruction
// shown once, at the position the copper first encountered it, so we drop consecutive duplicate
// records — same addr+w1+w2 where bit 0 of w1 is set (identifies WAIT/SKIP, not MOVE).
export function decodeCopperRecords(bytes: Uint8Array): ICopperModel | undefined {
  if (!bytes || bytes.byteLength < COPPER_RECORD_BYTES) return undefined;
  const count = (bytes.byteLength / COPPER_RECORD_BYTES) | 0;
  if (count === 0) return undefined;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // First pass: decode all records, then filter
  const rawAddr = new Uint32Array(count);
  const rawW1 = new Uint16Array(count);
  const rawW2 = new Uint16Array(count);
  const rawHpos = new Uint16Array(count);
  const rawVpos = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    const o = i * COPPER_RECORD_BYTES;
    rawAddr[i] = view.getUint32(o, true);
    rawW1[i] = view.getUint16(o + 4, true);
    rawW2[i] = view.getUint16(o + 6, true);
    rawHpos[i] = view.getUint16(o + 8, true);
    rawVpos[i] = view.getUint16(o + 10, true);
  }

  // Second pass: drop duplicate WAIT/SKIP records (keep first encounter, drop wake-up copy)
  const keep: boolean[] = new Array(count).fill(true);
  for (let i = 1; i < count; i++) {
    if ((rawW1[i] & 0x0001) !== 0                // WAIT or SKIP (not MOVE)
      && rawAddr[i] === rawAddr[i - 1]
      && rawW1[i] === rawW1[i - 1]
      && rawW2[i] === rawW2[i - 1]) {
      keep[i] = false;
    }
  }
  const kept = keep.reduce((n, k) => n + (k ? 1 : 0), 0);

  const addr = new Uint32Array(kept);
  const w1 = new Uint16Array(kept);
  const w2 = new Uint16Array(kept);
  const hpos = new Uint16Array(kept);
  const vpos = new Uint16Array(kept);
  let j = 0;
  for (let i = 0; i < count; i++) {
    if (!keep[i]) continue;
    addr[j] = rawAddr[i];
    w1[j] = rawW1[i];
    w2[j] = rawW2[i];
    hpos[j] = rawHpos[i];
    vpos[j] = rawVpos[i];
    j++;
  }
  return { addr, w1, w2, hpos, vpos };
}

// Decode the per-cycle DMA event bitfield (puae_dma_serialize_events): one little-endian u32 per
// slot, same index/order as decodeDmaGrid's grid. Returns undefined for an empty/too-small buffer
// (callers treat that as "no event data" — older captures / a backend without it).
export function decodeDmaEvents(bytes: Uint8Array): Uint32Array | undefined {
  if (!bytes || bytes.byteLength < EVENT_BYTES) return undefined;
  const count = (bytes.byteLength / EVENT_BYTES) | 0;
  if (count === 0) return undefined;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const events = new Uint32Array(count);
  for (let i = 0; i < count; i++) events[i] = view.getUint32(i * EVENT_BYTES, true);
  return events;
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

// AGA's full 256-entry palette (0x00RRGGBB per entry, native little-endian — see
// wasm_read_aga_colors's doc comment, no byte-swap needed unlike decodeCustomRegs above).
// Returns undefined (rather than an all-zero array) when absent or all-zero — the emulator
// zero-fills this buffer outside AGA mode, and "no AGA palette" should read as "fall back to
// the OCS/ECS COLOR00-31 reconstruction", not "a real 256-entry black palette".
export function decodeAgaColors(bytes: Uint8Array | undefined): Uint32Array | undefined {
  if (!bytes || bytes.byteLength < 256 * 4) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const colors = new Uint32Array(256);
  let anyNonZero = false;
  for (let i = 0; i < 256; i++) {
    const v = view.getUint32(i * 4, true);
    if (v !== 0) anyNonZero = true;
    colors[i] = v;
  }
  return anyNonZero ? colors : undefined;
}

// Decode the per-sample CPU register trace (getProfileRegs): REG_COUNT little-endian u32 per
// sample (D0-D7, A0-A7, SR, PC, USP — see REG_* in shared/profilerTypes.ts), in the same
// strictly sequential order decodeProfileStream (profilerManager.ts) parses its own buffer —
// both are written in lockstep by the same wasm_profile_instrHook call per recorded instruction.
// DataView (not a Uint32Array view) because `bytes` isn't guaranteed 4-byte aligned within its
// backing buffer. Shared (not profilerManager.ts-only) so profilerBulk.ts's webview-side
// unpackBulk can decode it without pulling in profilerManager's Node-only dependencies.
export function decodeRegisterTrace(bytes: Uint8Array): Uint32Array {
  const count = (bytes.byteLength / 4) | 0;
  const out = new Uint32Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i++) out[i] = view.getUint32(i * 4, true);
  return out;
}
