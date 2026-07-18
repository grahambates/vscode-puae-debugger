import { packBulk, unpackBulk } from "../profilerBulk";
import { encodeCapture, decodeCapture } from "../profileFormat";
import type { RawCapture } from "../profilerManager";

// Pack a u32[] into the little-endian 4-byte-per-slot stream puae_dma_serialize_events emits.
function packEvents(values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((v, i) => view.setUint32(i * 4, v, true));
  return bytes;
}

describe("packBulk/unpackBulk with DMA events", () => {
  // One DMA cell, so events must be exactly one u32 (4 bytes) to line up — unpackBulk drops a
  // length mismatch rather than risk desyncing events[slot] from owner[slot] elsewhere.
  const baseRaw = (): RawCapture => ({
    profile: { data: new Uint8Array(0), start: 0, end: 0, total: 0, inRange: 0, frameCycles: 0, isPAL: true },
    dma: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]), // one DMA cell
  });

  it("attaches events onto the decoded IDmaModel, aligned with the grid", () => {
    const raw = baseRaw();
    raw.dmaEvents = packEvents([0x80000010]); // CPUINS | COPPERWAKE
    const packed = packBulk(raw)!;
    const { dma } = unpackBulk(packed.slice().buffer);
    expect(dma).toBeDefined();
    expect(dma!.events).toBeDefined();
    expect(Array.from(dma!.events!)).toEqual([0x80000010]);
  });

  it("omits events cleanly when the capture had none", () => {
    const packed = packBulk(baseRaw())!;
    const { dma } = unpackBulk(packed.slice().buffer);
    expect(dma!.events).toBeUndefined();
  });

  it("drops a mismatched-length events buffer rather than misaligning the grid", () => {
    const raw = baseRaw();
    raw.dmaEvents = packEvents([1, 2, 3]); // 3 slots vs. the grid's 1 cell
    const packed = packBulk(raw)!;
    const { dma } = unpackBulk(packed.slice().buffer);
    expect(dma!.events).toBeUndefined();
  });
});

describe("profileFormat codec with DMA events", () => {
  it("round-trips raw.dmaEvents through encode/decode", () => {
    const raw: RawCapture = {
      profile: { data: new Uint8Array([1, 0, 0, 0]), start: 0, end: 0, total: 0, inRange: 0, frameCycles: 0, isPAL: true },
      dmaEvents: packEvents([0x20000000, 0]), // CPUSTOP, then nothing
    };
    const { raws: [out] } = decodeCapture(encodeCapture([raw]));
    expect(Array.from(out.dmaEvents!)).toEqual(Array.from(raw.dmaEvents!));
  });

  it("leaves dmaEvents undefined for a pre-events document", () => {
    const raw: RawCapture = {
      profile: { data: new Uint8Array([1, 0, 0, 0]), start: 0, end: 0, total: 0, inRange: 0, frameCycles: 0, isPAL: true },
    };
    const { raws: [out] } = decodeCapture(encodeCapture([raw]));
    expect(out.dmaEvents).toBeUndefined();
  });
});
