// Tests for the MCP watchpoint helpers: exact range coverage and hit reporting.

import { alignedBlocks, conditionMet, customRegisterRange, describeHit } from "../mcp/watchpoints";

describe("alignedBlocks", () => {
  const covered = (blocks: { address: number; size: number }[]) => blocks.reduce((n, b) => n + b.size, 0);

  it("uses one block for an aligned power-of-two range", () => {
    expect(alignedBlocks(0x1000, 256)).toEqual([{ address: 0x1000, size: 256 }]);
  });

  it("covers a misaligned range exactly, with every block aligned to its own size", () => {
    const blocks = alignedBlocks(0x1003, 13);
    expect(covered(blocks)).toBe(13);
    expect(blocks[0].address).toBe(0x1003);
    for (const b of blocks) expect(b.address % b.size).toBe(0);
    expect(blocks.map((b) => b.size)).toEqual([1, 4, 8]);
  });

  it("stays within a handful of slots for a large odd range", () => {
    const blocks = alignedBlocks(0x20001, 40000);
    expect(covered(blocks)).toBe(40000);
    expect(blocks.length).toBeLessThanOrEqual(32);
  });
});

describe("customRegisterRange", () => {
  it("resolves a word register and a pointer pair", () => {
    expect(customRegisterRange("color00")).toEqual({ address: 0xdff180, size: 2 });
    expect(customRegisterRange("COP1LC")).toEqual({ address: 0xdff080, size: 4 });
    expect(customRegisterRange("player_x")).toBeUndefined();
  });
});

describe("describeHit", () => {
  it("attributes a copper write to the copper, not the CPU", () => {
    const text = describeHit({
      watchAddress: 0xdff180, addr: 0xdff180, accessKind: 2, sizeBits: 16,
      value: 0x0f00, oldValue: 0x0349, source: 1, cpuPc: 0xc022b8, copperPc: 0xc94,
    });
    expect(text).toMatch(/^write\.w \$0f00 to 0x00dff180 \(COLOR00\), was \$0349 — by the copper \(list pointer at 0x00000c94\)/);
    expect(text).toMatch(/CPU was meanwhile at 0x00c022b8, which is not the cause/);
  });

  it("names the CPU's PC for a CPU write to RAM", () => {
    const text = describeHit({ watchAddress: 0x100, addr: 0x102, accessKind: 2, sizeBits: 8, value: 7, source: 0, cpuPc: 0xc02140 });
    expect(text).toBe("write.b $07 to 0x00000102 — by the CPU at 0x00c02140");
  });

  it("blames DMA, not the CPU, for a DMA write to chip RAM", () => {
    expect(describeHit({ watchAddress: 0x40000, addr: 0x40010, accessKind: 2, sizeBits: 16, value: 0, source: 1 }))
      .toMatch(/by DMA \(blitter or disk\), not the CPU/);
  });
});

describe("describeHit with a confirmed copper instruction", () => {
  it("names the MOVE itself rather than the advanced list pointer", () => {
    const text = describeHit({ watchAddress: 0xdff180, addr: 0xdff180, accessKind: 2, sizeBits: 16, value: 1, source: 1, copperPc: 0xc8c, copperInstruction: 0xc88 });
    expect(text).toMatch(/by the copper MOVE at 0x00000c88/);
  });
});

describe("conditionMet", () => {
  const word = (hi: number, lo: number) => Uint8Array.from([hi, lo]);

  it("judges a word variable by its whole value after a byte write into it", () => {
    // Word at $100 holds $1200; a byte write of $00 to its low byte leaves $1200 — not 0.
    const hit = { addr: 0x101, sizeBits: 8, value: 0x00, oldValue: 0x00 };
    expect(conditionMet({ equals: 0 }, 0x100, 2, word(0x12, 0x00), hit)).toBe(false);
    // ...and a byte write of $07 into a word that is otherwise 0 makes it $0007.
    expect(conditionMet({ equals: 7 }, 0x100, 2, word(0, 0), { addr: 0x101, sizeBits: 8, value: 7, oldValue: 0 })).toBe(true);
  });

  it("matches a long write that covers the watched word", () => {
    // move.l #$00050009,$FE: the word at $100 is the long's low half.
    const hit = { addr: 0xfe, sizeBits: 32, value: 0x00050009, oldValue: 0 };
    expect(conditionMet({ equals: 9 }, 0x100, 2, word(0, 0), hit)).toBe(true);
  });

  it("gives the same answer whether memory already holds the new value or the old one", () => {
    const hit = { addr: 0x100, sizeBits: 16, value: 5, oldValue: 4 };
    expect(conditionMet({ equals: 5 }, 0x100, 2, word(0, 4), hit)).toBe(true);
    expect(conditionMet({ equals: 5 }, 0x100, 2, word(0, 5), hit)).toBe(true);
  });

  it("counts a write of the value already there as no change", () => {
    expect(conditionMet({ changes: true }, 0x100, 2, word(0, 0), { addr: 0x101, sizeBits: 8, value: 0, oldValue: 0 })).toBe(false);
    expect(conditionMet({ changes: true }, 0x100, 2, word(0, 0), { addr: 0x101, sizeBits: 8, value: 1, oldValue: 0 })).toBe(true);
    // No old value recorded: can't rule a change out, so stop.
    expect(conditionMet({ changes: true }, 0x100, 2, word(0, 0), { addr: 0x101, sizeBits: 8, value: 0 })).toBe(true);
  });

  it("takes a custom register's value from the write, and masks negatives to the width", () => {
    expect(conditionMet({ equals: 0x0f00 }, 0xdff180, 2, undefined, { value: 0x0f00, sizeBits: 16 })).toBe(true);
    expect(conditionMet({ equals: -1 }, 0x100, 2, word(0, 0), { addr: 0x100, sizeBits: 16, value: 0xffff, oldValue: 0 })).toBe(true);
  });
});
