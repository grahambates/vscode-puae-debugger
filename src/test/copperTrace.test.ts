import { decodeCopperRecords } from "../dma";
import { packBulk, unpackBulk } from "../profilerBulk";
import { disassembleCopperInstruction } from "../shared/copperDisassembler";
import type { RawCapture } from "../profilerManager";

// Pack copper records into the little-endian 12-byte stream puae_copper_serialize emits:
// { u32 addr; u16 w1; u16 w2; u16 hpos; u16 vpos }.
function packCopperRecords(records: { addr: number; w1: number; w2: number; hpos: number; vpos: number }[]): Uint8Array {
  const bytes = new Uint8Array(records.length * 12);
  const view = new DataView(bytes.buffer);
  records.forEach((r, i) => {
    const o = i * 12;
    view.setUint32(o, r.addr, true);
    view.setUint16(o + 4, r.w1, true);
    view.setUint16(o + 6, r.w2, true);
    view.setUint16(o + 8, r.hpos, true);
    view.setUint16(o + 10, r.vpos, true);
  });
  return bytes;
}

describe("decodeCopperRecords", () => {
  it("round-trips the packed 12-byte stream into parallel typed arrays", () => {
    const records = [
      { addr: 0x1000, w1: 0x0096, w2: 0x8200, hpos: 10, vpos: 5 }, // MOVE #$8200,DMACON
      { addr: 0x1004, w1: 0x2c01, w2: 0xfffe, hpos: 12, vpos: 5 }, // WAIT 44,1
    ];
    const cop = decodeCopperRecords(packCopperRecords(records))!;
    expect(cop).toBeDefined();
    expect(Array.from(cop.addr)).toEqual([0x1000, 0x1004]);
    expect(Array.from(cop.w1)).toEqual([0x0096, 0x2c01]);
    expect(Array.from(cop.w2)).toEqual([0x8200, 0xfffe]);
    expect(Array.from(cop.hpos)).toEqual([10, 12]);
    expect(Array.from(cop.vpos)).toEqual([5, 5]);
  });

  it("deduplicates consecutive WAIT/SKIP records (emulator records them twice: once on encounter, once on wake-up)", () => {
    // Simulates the emulator recording a WAIT twice at the same addr/w1/w2, but different
    // hpos/vpos (first: when copper hits the WAIT; second: when the condition is met).
    const waitW1 = 0x2c01; // bit 0 = 1 → WAIT/SKIP
    const records = [
      { addr: 0x1000, w1: 0x0096, w2: 0x8200, hpos: 5, vpos: 1 },  // MOVE
      { addr: 0x1004, w1: waitW1, w2: 0xfffe, hpos: 10, vpos: 1 }, // WAIT — first encounter
      { addr: 0x1004, w1: waitW1, w2: 0xfffe, hpos: 3, vpos: 44 }, // WAIT — wake-up (kept by emitter, dropped here)
      { addr: 0x1008, w1: 0x0180, w2: 0x0f00, hpos: 5, vpos: 44 }, // MOVE COLOR00
    ];
    const cop = decodeCopperRecords(packCopperRecords(records))!;
    // Duplicate WAIT dropped; 3 unique instructions remain
    expect(cop.addr.length).toBe(3);
    expect(Array.from(cop.addr)).toEqual([0x1000, 0x1004, 0x1008]);
    // Kept hpos/vpos are from the FIRST (encounter) occurrence, not the wake-up
    expect(cop.hpos[1]).toBe(10);
    expect(cop.vpos[1]).toBe(1);
  });

  it("does not deduplicate a WAIT that genuinely appears twice in a copper loop", () => {
    // If the copper jumps back and re-executes the same WAIT instruction, there will be other
    // instructions between the two occurrences — so they are NOT consecutive, not dropped.
    const waitW1 = 0x2c01;
    const records = [
      { addr: 0x1004, w1: waitW1, w2: 0xfffe, hpos: 10, vpos: 1 }, // WAIT first loop
      { addr: 0x1004, w1: waitW1, w2: 0xfffe, hpos: 10, vpos: 1 }, // wake-up → dropped (consecutive dupe)
      { addr: 0x1008, w1: 0x0088, w2: 0x0000, hpos: 12, vpos: 1 }, // COP1JMP back to start
      { addr: 0x1004, w1: waitW1, w2: 0xfffe, hpos: 10, vpos: 2 }, // WAIT second loop — NOT a dupe of preceding COP1JMP
      { addr: 0x1004, w1: waitW1, w2: 0xfffe, hpos: 10, vpos: 2 }, // wake-up → dropped
    ];
    const cop = decodeCopperRecords(packCopperRecords(records))!;
    expect(cop.addr.length).toBe(3); // WAIT×2 + COP1JMP, each once
    expect(Array.from(cop.addr)).toEqual([0x1004, 0x1008, 0x1004]);
  });

  it("returns undefined for an empty/too-small buffer", () => {
    expect(decodeCopperRecords(new Uint8Array(0))).toBeUndefined();
    expect(decodeCopperRecords(new Uint8Array(4))).toBeUndefined();
  });

  it("each decoded record disassembles via disassembleCopperInstruction", () => {
    const cop = decodeCopperRecords(packCopperRecords([{ addr: 0x1000, w1: 0x0096, w2: 0x8200, hpos: 10, vpos: 5 }]))!;
    const insn = disassembleCopperInstruction(cop.addr[0], cop.w1[0], cop.w2[0]);
    expect(insn.mnemonic).toBe("MOVE");
    expect(insn.operands).toContain("DMACON");
  });
});

describe("packBulk/unpackBulk with a copper trace", () => {
  const baseRaw = (): RawCapture => ({
    profile: { data: new Uint8Array(0), start: 0, end: 0, total: 0, inRange: 0, frameCycles: 0, isPAL: true },
    dma: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]), // one DMA cell
  });

  it("carries the copper bytes through pack/unpack alongside the DMA grid", () => {
    const raw = baseRaw();
    raw.copper = packCopperRecords([{ addr: 0x1000, w1: 0x0096, w2: 0x8200, hpos: 10, vpos: 5 }]);
    const packed = packBulk(raw)!;
    const { dma, copper } = unpackBulk(packed.slice().buffer);
    expect(dma).toBeDefined();
    expect(copper).toBeDefined();
    expect(Array.from(copper!.addr)).toEqual([0x1000]);
    expect(Array.from(copper!.w2)).toEqual([0x8200]);
  });

  it("omits copper cleanly when the capture had none", () => {
    const packed = packBulk(baseRaw())!;
    const { copper } = unpackBulk(packed.slice().buffer);
    expect(copper).toBeUndefined();
  });
});
