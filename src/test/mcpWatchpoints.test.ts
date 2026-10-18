// Tests for the MCP watchpoint helpers: exact range coverage and hit reporting.

import { alignedBlocks, customRegisterRange, describeHit } from "../mcp/watchpoints";

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
