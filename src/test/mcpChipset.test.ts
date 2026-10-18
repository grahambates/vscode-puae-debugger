// Tests for the MCP chipset dump and copper-list walker — pure functions, run against a fake
// register set and a fake chip RAM rather than a booted machine.

import { formatChipset, walkCopperList } from "../mcp/chipset";

/** A sparse chip RAM: copper instructions placed at addresses, zeroes elsewhere. */
function chipRam(lists: Record<number, number[][]>) {
  const mem = Buffer.alloc(0x10000);
  for (const [base, instructions] of Object.entries(lists)) {
    instructions.forEach(([w1, w2], i) => {
      mem.writeUInt16BE(w1, Number(base) + i * 4);
      mem.writeUInt16BE(w2, Number(base) + i * 4 + 2);
    });
  }
  return async (address: number, bytes: number) => {
    const out = Buffer.alloc(bytes);
    mem.copy(out, 0, address, Math.min(address + bytes, mem.length));
    return out;
  };
}

const END = [0xffff, 0xfffe];

describe("walkCopperList", () => {
  it("decodes MOVEs and WAITs up to the end marker", async () => {
    const read = chipRam({ 0x1000: [[0x0180, 0x0f00], [0x2c07, 0xfffe], [0x0180, 0x000f], END] });
    const listing = await walkCopperList(read, { start: 0x1000, cop2lc: 0, maxInstructions: 100 });
    const lines = listing.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^\$001000\s+0180 0F00\s+MOVE #\$F00,COLOR00/);
    expect(lines[1]).toMatch(/WAIT 44,6/);
    expect(lines[3]).toMatch(/WAIT end/);
  });

  it("follows a COPJMP2 to the COP2LC the list itself set", async () => {
    const read = chipRam({
      0x1000: [[0x0084, 0x0000], [0x0086, 0x2000], [0x008a, 0x0000], [0x0180, 0x0bad]],
      0x2000: [[0x0180, 0x0abc], END],
    });
    const listing = await walkCopperList(read, { start: 0x1000, cop2lc: 0xdead, maxInstructions: 100 });
    expect(listing).toMatch(/COPJMP2\s+; jump to \$002000/);
    expect(listing).toMatch(/\$002000 .*#\$ABC,COLOR00/);
    // Straight-line reading past the jump would have shown this; the copper never runs it.
    expect(listing).not.toMatch(/BAD/);
  });

  it("spells out lines past 255 after the usual WAIT $FFDF wrap", async () => {
    const read = chipRam({ 0x1000: [[0xf007, 0xfffe], [0xffdf, 0xfffe], [0x2c07, 0xfffe], END] });
    const listing = await walkCopperList(read, { start: 0x1000, cop2lc: 0, maxInstructions: 100 });
    expect(listing).toMatch(/WAIT 44,6\s+; line 300/);
    expect(listing.split("\n")[0]).not.toMatch(/line/);
  });

  it("stops on a loop instead of listing it forever", async () => {
    const read = chipRam({ 0x1000: [[0x0080, 0x0000], [0x0082, 0x1000], [0x0088, 0x0000]] });
    const listing = await walkCopperList(read, { start: 0x1000, cop2lc: 0, maxInstructions: 100 });
    expect(listing).toMatch(/jumps back to \$001000/);
  });

  it("says so when the budget runs out before an end marker", async () => {
    const read = chipRam({});
    const listing = await walkCopperList(read, { start: 0x1000, cop2lc: 0, maxInstructions: 3 });
    expect(listing.split("\n")).toHaveLength(4);
    expect(listing).toMatch(/stopped after 3 instructions/);
  });
});

describe("formatChipset", () => {
  const regs = (values: Record<string, number>) =>
    Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: "0x" + v.toString(16) }]));
  const describePointer = (a: number) => `0x${a.toString(16).padStart(8, "0")}`;

  it("decodes the beam position from VPOSR and VHPOSR together", () => {
    // V8 set in VPOSR plus $2C in VHPOSR's high byte is line 300, not 44.
    const out = formatChipset(regs({ VPOS: 0x0001, VHPOS: 0x2c38 }), describePointer);
    expect(out).toMatch(/Beam: line 300, hpos \$38/);
  });

  it("decodes DMACON and warns when DMAEN is off", () => {
    const out = formatChipset(regs({ DMACON: 0x01c0 }), describePointer);
    expect(out).toMatch(/DMACON=\$01C0 \[BITPLANES COPPER BLITTER\]/);
    expect(out).toMatch(/ENABLE_ALL \(DMAEN\) is off/);
  });

  it("lists only the bitplane pointers BPLCON0 enables", () => {
    const out = formatChipset(regs({ BPLCON0: 0x2200, BPL1PT: 0x1a000, BPL2PT: 0x1c000, BPL3PT: 0x1e000 }), describePointer);
    expect(out).toMatch(/BPLCON0=\$2200 \[BITPLANES=2 COLOR\]/);
    expect(out).toMatch(/BPL2PT=0x0001c000/);
    expect(out).not.toMatch(/BPL3PT/);
  });
});
