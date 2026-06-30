import { packBulk, unpackBulk } from "../profilerBulk";
import { encodeCapture, decodeCapture } from "../vamigaProfile";
import { buildModelFromCapture } from "../profilerManager";
import { REG_COUNT, REG_D0 } from "../shared/profilerTypes";
import { SourceMap } from "../sourceMap";
import type { RawCapture } from "../profilerManager";

// Pack a flat u32[] (REG_COUNT words per sample) into the little-endian byte stream
// getProfileRegs emits.
function packRegs(values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((v, i) => view.setUint32(i * 4, v, true));
  return bytes;
}

const baseRaw = (): RawCapture => ({
  profile: { data: new Uint8Array(0), start: 0, end: 0, total: 0, inRange: 0, frameCycles: 0, isPAL: true },
  dma: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]), // one DMA cell — packBulk requires raw.dma
});

describe("packBulk/unpackBulk with a register trace", () => {
  it("decodes the register trace alongside the DMA grid", () => {
    const raw = baseRaw();
    const sample = new Array(REG_COUNT).fill(0).map((_, i) => i + 1);
    raw.registers = packRegs(sample);
    const packed = packBulk(raw)!;
    const { registers } = unpackBulk(packed.slice().buffer);
    expect(registers).toBeDefined();
    expect(Array.from(registers!)).toEqual(sample);
  });

  it("omits registers cleanly when the capture had none", () => {
    const packed = packBulk(baseRaw())!;
    const { registers } = unpackBulk(packed.slice().buffer);
    expect(registers).toBeUndefined();
  });
});

describe("vamigaProfile codec with a register trace", () => {
  it("round-trips raw.registers through encode/decode", () => {
    const raw: RawCapture = {
      profile: { data: new Uint8Array([1, 0, 0, 0]), start: 0, end: 0, total: 0, inRange: 0, frameCycles: 0, isPAL: true },
      registers: packRegs(new Array(REG_COUNT).fill(0).map((_, i) => i + 1)),
    };
    const { raw: out } = decodeCapture(encodeCapture(raw));
    expect(Array.from(out.registers!)).toEqual(Array.from(raw.registers!));
  });

  it("leaves registers undefined for a pre-register-trace document", () => {
    const raw: RawCapture = {
      profile: { data: new Uint8Array([1, 0, 0, 0]), start: 0, end: 0, total: 0, inRange: 0, frameCycles: 0, isPAL: true },
    };
    const { raw: out } = decodeCapture(encodeCapture(raw));
    expect(out.registers).toBeUndefined();
  });
});

describe("buildModelFromCapture: register-trace alignment with model.pcs", () => {
  function stubSourceMap(): SourceMap {
    return {
      findSymbolOffset: (pc: number) => (pc === 0x100 ? { symbol: "_start", offset: 0 } : undefined),
      lookupAddress: (pc: number) => (pc === 0x100 ? { path: "a.c", line: 1 } : undefined),
      findSegmentForAddress: () => ({}),
      getCfaForPc: () => ({ reg: 15, offset: 0 }),
      getUnwindRows: () => [{}],
      getSymbols: () => ({ _start: 0x100 }),
      getSymbolLengths: () => ({ _start: 0x10 }),
    } as unknown as SourceMap;
  }

  // 2 samples => profile.data is [depth=1,pc=0x100,cycles][depth=1,pc=0x100,cycles].
  function profileBytes(): Uint8Array {
    const words = [1, 0x100, 5, 1, 0x100, 3];
    const bytes = new Uint8Array(words.length * 4);
    const view = new DataView(bytes.buffer);
    words.forEach((w, i) => view.setUint32(i * 4, w, true));
    return bytes;
  }

  it("attaches a correctly-sized register trace, aligned with pcs", () => {
    const raw: RawCapture = {
      profile: { data: profileBytes(), start: 0, end: 0, total: 2, inRange: 2, frameCycles: 0, isPAL: true },
      registers: packRegs([...new Array(REG_COUNT).fill(1), ...new Array(REG_COUNT).fill(2)]),
    };
    const { model } = buildModelFromCapture(raw, stubSourceMap());
    expect(model.pcs).toEqual([0x100, 0x100]);
    expect(model.registers).toBeDefined();
    expect(model.registers!.length).toBe(2 * REG_COUNT);
    expect(model.registers![REG_D0]).toBe(1); // sample 0
    expect(model.registers![REG_COUNT + REG_D0]).toBe(2); // sample 1
  });

  it("clips an oversized register trace rather than letting it outrun model.pcs", () => {
    const raw: RawCapture = {
      profile: { data: profileBytes(), start: 0, end: 0, total: 2, inRange: 2, frameCycles: 0, isPAL: true },
      // 3 samples' worth of registers for only 2 decoded InstructionSamples.
      registers: packRegs([...new Array(REG_COUNT).fill(1), ...new Array(REG_COUNT).fill(2), ...new Array(REG_COUNT).fill(3)]),
    };
    const { model } = buildModelFromCapture(raw, stubSourceMap());
    expect(model.registers!.length).toBe(2 * REG_COUNT); // clipped to pcs.length, not 3
    expect(model.registers![REG_D0]).toBe(1); // sample 0 — present
    expect(model.registers![REG_COUNT + REG_D0]).toBe(2); // sample 1 — present
    // The 3rd sample's registers (D0=3) were clipped off entirely, not just left unindexed.
    expect(Array.from(model.registers!)).not.toContain(3);
  });
});
