// The bulk binary of a capture (DMA grid + chip/slow snapshot) packed into one buffer for
// transfer to the webview via the resource loader (fetch), instead of postMessage — VS Code's
// extension-host→webview message serializer is slow for large binary (a 1MB array ~ 800ms),
// while a fetched resource streams efficiently. packBulk runs in the extension; unpackBulk in
// the webview. Both are dependency-light (only the pure decodeDmaGrid), so the webview bundle
// doesn't pull in the DWARF/sourcemap code.
//
// Layout (little-endian):
//   [u32 gridLen][u32 chipLen][u32 slowLen][u32 customLen][u32 copperLen][u32 eventsLen]
//   [u32 registersLen][u32 thumbnailLen][u32 thumbnailWidth][u32 thumbnailHeight]
//   [grid][chip][slow][custom][copper][events][registers][thumbnailJpeg].
// `custom` is the raw custom-register baseline bytes (256 LE u16); decoded on unpack.
// `copper` is the raw copper-instruction-trace bytes (12-byte records); decoded on unpack.
// `events` is the raw per-cycle event-bitfield bytes (4-byte LE u32, parallel to `grid`);
// decoded and attached onto the decoded IDmaModel as `.events` on unpack.
// `registers` is the raw per-sample CPU register trace bytes (19-word LE u32 records, parallel
// to the profile stream — see shared/profilerTypes.ts's REG_*); decoded on unpack.
// `thumbnailJpeg` is the JPEG bytes of a small screenshot (80px high) from the captured frame;
// thumbnailLen == 0 means no thumbnail was captured. Added in v2 of the format (7→10 header words).

import type { RawCapture } from "./profilerManager";
import { decodeDmaGrid, decodeCustomRegs, decodeCopperRecords, decodeDmaEvents, decodeRegisterTrace } from "./dma";
import { IDmaModel, DmaSnapshot, ICopperModel } from "./shared/profilerTypes";

// v1 header: 7 × u32 = 28 bytes. v2 header: 10 × u32 = 40 bytes (adds thumbnail).
// v3 header: 13 × u32 = 52 bytes (adds fullFrame: len + width + height).
const HEADER_V1 = 28;
const HEADER_V2 = 40;
const HEADER_V3 = 52;
const EMPTY = new Uint8Array(0);

export function packBulk(raw: RawCapture): Uint8Array | undefined {
  if (!raw.dma && !raw.thumbnail) return undefined;
  const grid      = raw.dma ?? EMPTY;
  const chip      = raw.snapshot?.chip ?? EMPTY;
  const slow      = raw.snapshot?.slow ?? EMPTY;
  const custom    = raw.snapshot?.custom ?? EMPTY;
  const copper    = raw.copper ?? EMPTY;
  const events    = raw.dmaEvents ?? EMPTY;
  const registers = raw.registers ?? EMPTY;
  const thumb     = raw.thumbnail?.data ?? EMPTY;
  const thumbW    = raw.thumbnail?.width ?? 0;
  const thumbH    = raw.thumbnail?.height ?? 0;
  const full      = raw.fullFrame?.data ?? EMPTY;
  const fullW     = raw.fullFrame?.width ?? 0;
  const fullH     = raw.fullFrame?.height ?? 0;
  const out = new Uint8Array(
    HEADER_V3 + grid.length + chip.length + slow.length + custom.length +
    copper.length + events.length + registers.length + thumb.length + full.length,
  );
  const dv = new DataView(out.buffer);
  dv.setUint32(0,  grid.length,      true);
  dv.setUint32(4,  chip.length,      true);
  dv.setUint32(8,  slow.length,      true);
  dv.setUint32(12, custom.length,    true);
  dv.setUint32(16, copper.length,    true);
  dv.setUint32(20, events.length,    true);
  dv.setUint32(24, registers.length, true);
  dv.setUint32(28, thumb.length,     true);
  dv.setUint32(32, thumbW,           true);
  dv.setUint32(36, thumbH,           true);
  dv.setUint32(40, full.length,      true);
  dv.setUint32(44, fullW,            true);
  dv.setUint32(48, fullH,            true);
  let off = HEADER_V3;
  out.set(grid,      off); off += grid.length;
  out.set(chip,      off); off += chip.length;
  out.set(slow,      off); off += slow.length;
  out.set(custom,    off); off += custom.length;
  out.set(copper,    off); off += copper.length;
  out.set(events,    off); off += events.length;
  out.set(registers, off); off += registers.length;
  out.set(thumb,     off); off += thumb.length;
  out.set(full,      off);
  return out;
}

export function unpackBulk(buf: ArrayBuffer): {
  dma?: IDmaModel;
  dmaSnapshot?: DmaSnapshot;
  copper?: ICopperModel;
  registers?: Uint32Array;
  thumbnail?: { data: Uint8Array; width: number; height: number };
  fullFrame?: { data: Uint8Array; width: number; height: number };
} {
  // Accept v1 (28 B), v2 (40 B, adds thumbnail), v3 (52 B, adds fullFrame).
  if (buf.byteLength < HEADER_V1) throw new Error(`unpackBulk: buffer too small (${buf.byteLength} < ${HEADER_V1} byte header)`);
  const dv = new DataView(buf);
  const gridLen      = dv.getUint32(0,  true);
  const chipLen      = dv.getUint32(4,  true);
  const slowLen      = dv.getUint32(8,  true);
  const customLen    = dv.getUint32(12, true);
  const copperLen    = dv.getUint32(16, true);
  const eventsLen    = dv.getUint32(20, true);
  const registersLen = dv.getUint32(24, true);

  const isV2 = buf.byteLength >= HEADER_V2;
  const thumbLen = isV2 ? dv.getUint32(28, true) : 0;
  const thumbW   = isV2 ? dv.getUint32(32, true) : 0;
  const thumbH   = isV2 ? dv.getUint32(36, true) : 0;

  const isV3 = buf.byteLength >= HEADER_V3;
  const fullLen  = isV3 ? dv.getUint32(40, true) : 0;
  const fullW    = isV3 ? dv.getUint32(44, true) : 0;
  const fullH    = isV3 ? dv.getUint32(48, true) : 0;

  const HEADER = isV3 ? HEADER_V3 : isV2 ? HEADER_V2 : HEADER_V1;

  const need = HEADER + gridLen + chipLen + slowLen + customLen + copperLen + eventsLen + registersLen + thumbLen + fullLen;
  if (need > buf.byteLength) throw new Error(`unpackBulk: section lengths (${need}) exceed buffer (${buf.byteLength})`);
  let off = HEADER;
  const grid      = new Uint8Array(buf, off, gridLen);      off += gridLen;
  const chip      = new Uint8Array(buf, off, chipLen);      off += chipLen;
  const slow      = new Uint8Array(buf, off, slowLen);      off += slowLen;
  const custom    = new Uint8Array(buf, off, customLen);    off += customLen;
  const copper    = new Uint8Array(buf, off, copperLen);    off += copperLen;
  const events    = new Uint8Array(buf, off, eventsLen);    off += eventsLen;
  const registers = new Uint8Array(buf, off, registersLen); off += registersLen;
  const thumbData = thumbLen > 0 ? new Uint8Array(buf, off, thumbLen) : undefined; off += thumbLen;
  const fullData  = fullLen  > 0 ? new Uint8Array(buf, off, fullLen)  : undefined;

  const dma = decodeDmaGrid(grid);
  if (dma) {
    const decodedEvents = decodeDmaEvents(events);
    if (decodedEvents && decodedEvents.length === dma.owner.length) dma.events = decodedEvents;
  }
  return {
    dma,
    dmaSnapshot: chipLen || slowLen ? { chip: new Uint8Array(chip), slow: new Uint8Array(slow), custom: decodeCustomRegs(custom) } : undefined,
    copper: decodeCopperRecords(copper),
    registers: registersLen > 0 ? decodeRegisterTrace(registers) : undefined,
    thumbnail: thumbData && thumbW > 0 && thumbH > 0
      ? { data: new Uint8Array(thumbData), width: thumbW, height: thumbH }
      : undefined,
    fullFrame: fullData && fullW > 0 && fullH > 0
      ? { data: new Uint8Array(fullData), width: fullW, height: fullH }
      : undefined,
  };
}
