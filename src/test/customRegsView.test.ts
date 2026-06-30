import { findPrevRegWrite, findNextRegWrite, reconstructCustomRegs } from "../webview/profilerViewer/reconstruct";
import { WRITEABLE_REG_OFFSETS, PTR_HIGH_OFFSETS, isColorReg, formatRegValue } from "../webview/profilerViewer/customRegsTable";
import { customRegisterName } from "../webview/shared/customRegisters";
import { IDmaModel, BusOwner, DMA_WRITE } from "../shared/profilerTypes";

interface Cell {
  owner: number;
  flags: number;
  data: number;
  addr: number;
}

function makeModel(cells: Cell[]): IDmaModel {
  return {
    owner: Uint8Array.from(cells, (c) => c.owner),
    flags: Uint8Array.from(cells, (c) => c.flags),
    addr: Uint32Array.from(cells, (c) => c.addr),
    value: Uint16Array.from(cells, (c) => c.data),
  };
}

describe("customRegsTable", () => {
  it("every PTR_HIGH offset is also in WRITEABLE_REG_OFFSETS (pth implies writeable)", () => {
    const writeable = new Set(WRITEABLE_REG_OFFSETS);
    for (const off of PTR_HIGH_OFFSETS) expect(writeable.has(off)).toBe(true);
  });

  it("contains no duplicate or ptl (odd-numbered-pair-low) offsets, all even and in range", () => {
    const seen = new Set<number>();
    for (const off of WRITEABLE_REG_OFFSETS) {
      expect(off % 2).toBe(0);
      expect(off).toBeGreaterThanOrEqual(0);
      expect(off).toBeLessThanOrEqual(0x1fe);
      expect(seen.has(off)).toBe(false);
      seen.add(off);
    }
  });

  it("resolves a name for every writeable offset", () => {
    for (const off of WRITEABLE_REG_OFFSETS) expect(customRegisterName(off)).toBeDefined();
  });

  it("isColorReg matches only COLOR00-31", () => {
    expect(isColorReg(0x180)).toBe(true);
    expect(isColorReg(0x1be)).toBe(true);
    expect(isColorReg(0x17e)).toBe(false);
    expect(isColorReg(0x1c0)).toBe(false);
  });

  it("formats BPLxMOD as signed decimal, everything else as hex", () => {
    expect(formatRegValue("BPL1MOD", 4)).toBe("4");
    expect(formatRegValue("BPL1MOD", 0xfffc)).toBe("-4"); // -4 as u16
    expect(formatRegValue("DMACON", 0x8200)).toBe("$8200");
    expect(formatRegValue("COLOR00", 0xfff)).toBe("$0fff");
  });
});

describe("findPrevRegWrite / findNextRegWrite", () => {
  // DMACON written at slot 2 and slot 7 (by the CPU); BPLCON0 written at slot 4.
  const dma = makeModel([
    { owner: BusOwner.CPU, flags: 0, data: 0, addr: 0xdff000 },
    { owner: BusOwner.CPU, flags: 0, data: 0, addr: 0xdff000 },
    { owner: BusOwner.CPU, flags: DMA_WRITE, data: 0x8200, addr: 0xdff096 }, // DMACON
    { owner: BusOwner.CPU, flags: 0, data: 0, addr: 0xdff000 },
    { owner: BusOwner.CPU, flags: DMA_WRITE, data: 0x1200, addr: 0xdff100 }, // BPLCON0
    { owner: BusOwner.CPU, flags: 0, data: 0, addr: 0xdff000 },
    { owner: BusOwner.CPU, flags: 0, data: 0, addr: 0xdff000 },
    { owner: BusOwner.CPU, flags: DMA_WRITE, data: 0x0200, addr: 0xdff096 }, // DMACON
  ]);

  it("finds the nearest DMACON write strictly before/after a slot", () => {
    expect(findPrevRegWrite(dma, 0x096, 5)).toBe(2);
    expect(findNextRegWrite(dma, 0x096, 5)).toBe(7);
    expect(findPrevRegWrite(dma, 0x096, 2)).toBeUndefined(); // strictly before slot 2: none
    expect(findNextRegWrite(dma, 0x096, 7)).toBeUndefined(); // strictly after slot 7: none
  });

  it("doesn't confuse different registers", () => {
    expect(findPrevRegWrite(dma, 0x100, 5)).toBe(4);
    expect(findNextRegWrite(dma, 0x100, 0)).toBe(4);
    expect(findPrevRegWrite(dma, 0x100, 4)).toBeUndefined();
  });

  it("reconstructCustomRegs at the found write slot includes that write (sliceEnd = slot+1)", () => {
    const base = new Uint16Array(256);
    // slot 2 sets bit 0x0200 (SETCLR=1), slot 7 clears it (SETCLR=0) — DMACON ends at 0.
    const afterSet = reconstructCustomRegs(dma, base, 2 + 1);
    expect(afterSet[0x096 >> 1]).toBe(0x0200);
    const afterClear = reconstructCustomRegs(dma, base, 7 + 1);
    expect(afterClear[0x096 >> 1]).toBe(0x0000);
  });
});
