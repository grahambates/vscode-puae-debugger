import { decodeDmaGrid, decodeCustomRegs, decodeDmaEvents } from "../dma";
import { createSymbolizer } from "../webview/profilerViewer/symbols";
import {
  reconstructMemoryAt,
  reconstructCustomRegs,
  resolveMemoryRegion,
  findPrevMemWrite,
  findNextMemWrite,
  SLOW_BASE,
} from "../webview/profilerViewer/reconstruct";
import { createTopDownGraph } from "../webview/profilerViewer/topDownGraph";
import {
  channelStyle,
  dmaconChannels,
  ownerRegister,
  DMACON_REG_INDEX,
  dmaEventNames,
  DMA_EVENT_COPPERWAKE,
  DMA_EVENT_BLITIRQ,
  DMA_EVENT_CPUINS,
  DMA_EVENT_VB,
  DMA_EVENT_VS,
} from "../webview/profilerViewer/dma";
import { customRegisterName, CUSTOM_REGISTER_OFFSETS } from "../webview/shared/customRegisters";
import { getCustomRegDoc } from "../webview/shared/customRegisterDocs";
import { buildProfileModel, InstructionSample } from "../profilerManager";
import { SourceMap } from "../sourceMap";
import {
  IDmaModel,
  ISymbol,
  DmaSnapshot,
  BusOwner,
  DMA_WRITE,
  DMA_BYTE,
  DMA_CODE,
  DMA_SUB_SHIFT,
  COP_SUB_WAIT,
} from "../shared/profilerTypes";

// One enriched grid cell, matching the emulator's DmaProfiler::Cell layout.
interface Cell {
  owner: number;
  flags: number;
  data: number;
  addr: number;
}

// Pack cells into the little-endian Cell[8] byte stream the emulator emits:
// { u8 owner; u8 flags; u16 data; u32 addr }.
function packCells(cells: Cell[]): Uint8Array {
  const bytes = new Uint8Array(cells.length * 8);
  const view = new DataView(bytes.buffer);
  cells.forEach((c, i) => {
    const o = i * 8;
    view.setUint8(o, c.owner);
    view.setUint8(o + 1, c.flags);
    view.setUint16(o + 2, c.data, true);
    view.setUint32(o + 4, c.addr, true);
  });
  return bytes;
}

// Build an IDmaModel directly from a cell list (bypassing the byte stream).
function makeModel(cells: Cell[]): IDmaModel {
  return {
    owner: Uint8Array.from(cells, (c) => c.owner),
    flags: Uint8Array.from(cells, (c) => c.flags),
    addr: Uint32Array.from(cells, (c) => c.addr),
    value: Uint16Array.from(cells, (c) => c.data),
  };
}

describe("decodeDmaGrid", () => {
  it("round-trips the packed Cell stream into parallel typed arrays", () => {
    const cells: Cell[] = [
      { owner: BusOwner.CPU, flags: DMA_CODE, data: 0x1234, addr: 0x0000abcd },
      { owner: BusOwner.BLITTER, flags: DMA_WRITE, data: 0xbeef, addr: 0x00012340 },
      { owner: BusOwner.NONE, flags: 0, data: 0, addr: 0 },
    ];
    const dma = decodeDmaGrid(packCells(cells))!;
    expect(dma).toBeDefined();
    expect(Array.from(dma.owner)).toEqual([BusOwner.CPU, BusOwner.BLITTER, BusOwner.NONE]);
    expect(Array.from(dma.flags)).toEqual([DMA_CODE, DMA_WRITE, 0]);
    expect(Array.from(dma.value)).toEqual([0x1234, 0xbeef, 0]);
    expect(Array.from(dma.addr)).toEqual([0xabcd, 0x12340, 0]);
  });

  it("preserves a full 32-bit address (no sign-extension)", () => {
    const dma = decodeDmaGrid(packCells([{ owner: 1, flags: 0, data: 0, addr: 0xfff00000 }]))!;
    expect(dma.addr[0]).toBe(0xfff00000);
  });

  it("returns undefined for an empty/too-small buffer", () => {
    expect(decodeDmaGrid(new Uint8Array(0))).toBeUndefined();
    expect(decodeDmaGrid(new Uint8Array(4))).toBeUndefined();
  });
});

describe("decodeDmaEvents", () => {
  // Pack a u32[] into the little-endian 4-byte-per-slot stream puae_dma_serialize_events emits.
  function packEvents(values: number[]): Uint8Array {
    const bytes = new Uint8Array(values.length * 4);
    const view = new DataView(bytes.buffer);
    values.forEach((v, i) => view.setUint32(i * 4, v, true));
    return bytes;
  }

  it("round-trips the packed u32 stream, including the bit-31 (CPUINS) case", () => {
    const events = decodeDmaEvents(packEvents([0, 0x80000000, 0x12345678]))!;
    expect(events).toBeDefined();
    expect(Array.from(events)).toEqual([0, 0x80000000, 0x12345678]);
  });

  it("returns undefined for an empty/too-small buffer", () => {
    expect(decodeDmaEvents(new Uint8Array(0))).toBeUndefined();
    expect(decodeDmaEvents(new Uint8Array(2))).toBeUndefined();
  });
});

describe("createSymbolizer", () => {
  const symbols: ISymbol[] = [
    { address: 0x200, name: "fib", size: 0x3a }, // out of order on purpose
    { address: 0x100, name: "_start", size: 0x40 },
  ];
  const symbolize = createSymbolizer(symbols);

  it("resolves an exact symbol address to the bare name", () => {
    expect(symbolize(0x100)).toBe("_start");
    expect(symbolize(0x200)).toBe("fib");
  });

  it("resolves an interior address to name+offset", () => {
    expect(symbolize(0x110)).toBe("_start+$10");
    expect(symbolize(0x239)).toBe("fib+$39");
  });

  it("returns undefined past a symbol's size and before the first symbol", () => {
    expect(symbolize(0x140)).toBeUndefined(); // 0x100 + size 0x40 (exclusive)
    expect(symbolize(0x23a)).toBeUndefined(); // 0x200 + size 0x3a (exclusive)
    expect(symbolize(0x50)).toBeUndefined(); // before _start
  });

  it("treats a zero-size symbol as exact-match only (never claims trailing addresses)", () => {
    const s = createSymbolizer([{ address: 0x10, name: "x", size: 0 }]);
    expect(s(0x10)).toBe("x");
    expect(s(0x14)).toBeUndefined();
  });

  it("an empty symbol table resolves nothing", () => {
    const s = createSymbolizer([]);
    expect(s(0x100)).toBeUndefined();
  });
});

describe("channelStyle", () => {
  it("splits CPU into Code/Data on the CODE flag", () => {
    expect(channelStyle(BusOwner.CPU, DMA_CODE)?.key).toBe("cpu-code");
    expect(channelStyle(BusOwner.CPU, 0)?.key).toBe("cpu-data");
    expect(channelStyle(BusOwner.CPU, DMA_WRITE)?.key).toBe("cpu-data"); // a write is data
  });

  it("splits Copper on the sub-state bits", () => {
    expect(channelStyle(BusOwner.COPPER, 0)?.key).toBe("cop-move");
    expect(channelStyle(BusOwner.COPPER, COP_SUB_WAIT << DMA_SUB_SHIFT)?.key).toBe("cop-wait");
  });

  it("identifies owner-level channels and gives idle/blocked the dark '-' style", () => {
    expect(channelStyle(BusOwner.BPL1, 0)?.key).toBe("bpl1");
    expect(channelStyle(BusOwner.SPRITE7, 0)?.key).toBe("spr7");
    // Idle/blocked are now drawn (continuous band, like the old extension), not skipped.
    expect(channelStyle(BusOwner.NONE, 0)?.key).toBe("idle");
    expect(channelStyle(BusOwner.NONE, 0)?.label).toBe("-");
    expect(channelStyle(BusOwner.BLOCKED, 0)?.key).toBe("idle");
  });

  it("extracts color channels in 0xAABBGGRR order (R=low byte — red/blue not swapped)", () => {
    // Copper MOVE constant 0xff00eeee → R=0xee, G=0xee, B=0x00.
    expect(channelStyle(BusOwner.COPPER, 0)?.color).toBe("rgb(238,238,0)");
    // CPU Code constant 0xff4253a2 → R=0xa2, G=0x53, B=0x42.
    expect(channelStyle(BusOwner.CPU, DMA_CODE)?.color).toBe("rgb(162,83,66)");
  });
});

describe("decodeCustomRegs", () => {
  it("decodes little-endian u16 into a 256-entry register file", () => {
    // DMACONR (0x002) = 0x83e0, COLOR00 (0x180) word at index 0xc0.
    const bytes = new Uint8Array(512);
    bytes[0x002] = 0xe0;
    bytes[0x003] = 0x83;
    const regs = decodeCustomRegs(bytes);
    expect(regs.length).toBe(256);
    expect(regs[0x002 >> 1]).toBe(0x83e0);
  });

  it("returns a zeroed 256-entry array for empty/short input", () => {
    expect(Array.from(decodeCustomRegs(undefined))).toEqual(new Array(256).fill(0));
    expect(decodeCustomRegs(new Uint8Array(0)).length).toBe(256);
  });
});

describe("custom-register offsets (canonical)", () => {
  it("maps the control-register span to the correct hardware offsets", () => {
    // Regression guard for the old -2 shift bug in this span (DMACON had been at 0x094 etc.).
    expect(customRegisterName(0x096)).toBe("DMACON");
    expect(customRegisterName(0x09a)).toBe("INTENA");
    expect(customRegisterName(0x09c)).toBe("INTREQ");
    expect(customRegisterName(0x09e)).toBe("ADKCON");
    expect(customRegisterName(0x080)).toBe("COP1LCH");
    expect(customRegisterName(0x08e)).toBe("DIWSTRT");
    expect(CUSTOM_REGISTER_OFFSETS.DMACON).toBe(0x096);
    expect(DMACON_REG_INDEX).toBe(0x096 >> 1);
  });
});

describe("getCustomRegDoc", () => {
  it("expands family docs from one shared body (heading varies by index)", () => {
    // COLOR / BPL / SPR / AUD families are generated in code: per-member heading + shared body.
    expect(getCustomRegDoc(CUSTOM_REGISTER_OFFSETS.COLOR05)).toMatch(/^\*\*Color 5\*\*/);
    expect(getCustomRegDoc(CUSTOM_REGISTER_OFFSETS.SPR3DATB)).toMatch(/^\*\*Sprite 3 image data register B\*\*/);
    expect(getCustomRegDoc(CUSTOM_REGISTER_OFFSETS.BPL2DAT)).toMatch(/^\*\*Bit plane 2 data/);
    // AUD headings were normalized to a single casing ("Audio Channel N Period").
    expect(getCustomRegDoc(CUSTOM_REGISTER_OFFSETS.AUD2PER)).toMatch(/^\*\*Audio Channel 2 Period\*\*/);
    // Same family, same body — only the heading line differs.
    const c5 = getCustomRegDoc(CUSTOM_REGISTER_OFFSETS.COLOR05)!.split("\n").slice(1).join("\n");
    const c20 = getCustomRegDoc(CUSTOM_REGISTER_OFFSETS.COLOR20)!.split("\n").slice(1).join("\n");
    expect(c5).toBe(c20);
  });

  it("returns inline one-off docs and masks odd offsets", () => {
    expect(getCustomRegDoc(CUSTOM_REGISTER_OFFSETS.DMACON)).toMatch(/DMA Control/);
    expect(getCustomRegDoc(CUSTOM_REGISTER_OFFSETS.DMACON + 1)).toBe(getCustomRegDoc(CUSTOM_REGISTER_OFFSETS.DMACON));
    expect(getCustomRegDoc(0x1f0)).toBeUndefined(); // documented gap
  });
});

describe("ownerRegister", () => {
  it("maps channel bus owners to their data registers", () => {
    expect(ownerRegister(BusOwner.BPL1)).toBe(0x110); // BPL1DAT
    expect(ownerRegister(BusOwner.BPL6)).toBe(0x11a); // BPL6DAT
    expect(ownerRegister(BusOwner.AUD0)).toBe(0x0aa); // AUD0DAT
    expect(ownerRegister(BusOwner.AUD3)).toBe(0x0da); // AUD3DAT
    expect(ownerRegister(BusOwner.SPRITE0)).toBe(0x144); // SPR0DATA
    expect(ownerRegister(BusOwner.DISK)).toBe(0x026); // DSKDAT
  });

  it("returns undefined where the register can't be determined", () => {
    expect(ownerRegister(BusOwner.BLITTER)).toBeUndefined(); // channel (A/B/C/D) not recorded
    expect(ownerRegister(BusOwner.REFRESH)).toBeUndefined();
    expect(ownerRegister(BusOwner.NONE)).toBeUndefined();
  });
});

describe("dmaconChannels", () => {
  it("lists only Master (off) when DMAEN is clear", () => {
    const ch = dmaconChannels(0x0040); // BLTEN set but master clear
    expect(ch).toEqual([{ name: "Master", on: false }]);
  });

  it("reflects the enabled channel bits when DMAEN is set", () => {
    // DMAEN(0x200) | BPLEN(0x100) | COPEN(0x080) | BLTEN(0x040) | AUD0(0x001)
    const ch = dmaconChannels(0x0200 | 0x0100 | 0x0080 | 0x0040 | 0x0001);
    const on = Object.fromEntries(ch.map((c) => [c.name, c.on]));
    expect(on.Master).toBe(true);
    expect(on.Raster).toBe(true);
    expect(on.Copper).toBe(true);
    expect(on.Blitter).toBe(true);
    expect(on.Sprite).toBe(false);
    expect(on.Aud0).toBe(true);
    expect(on.Aud1).toBe(false);
  });
});

describe("dmaEventNames", () => {
  it("returns an empty list for the (overwhelmingly common) no-event cycle", () => {
    expect(dmaEventNames(0)).toEqual([]);
  });

  it("names every set bit, including bit 31 (CPUINS)", () => {
    expect(dmaEventNames(DMA_EVENT_COPPERWAKE | DMA_EVENT_BLITIRQ)).toEqual(["BLITIRQ", "COPPERWAKE"]);
    expect(dmaEventNames(DMA_EVENT_CPUINS)).toEqual(["CPUINS"]);
  });

  it("doesn't cross-match adjacent bits", () => {
    expect(dmaEventNames(DMA_EVENT_VB)).toEqual(["VB"]);
    expect(dmaEventNames(DMA_EVENT_VS)).toEqual(["VS"]);
  });
});

describe("reconstructMemoryAt", () => {
  const snapshot = (): DmaSnapshot => ({
    chip: new Uint8Array(0x1000),
    slow: new Uint8Array(0),
    custom: new Uint16Array(256),
  });

  it("applies word writes big-endian and byte writes to the exact address", () => {
    const dma = makeModel([
      { owner: BusOwner.BLITTER, flags: DMA_WRITE, data: 0xabcd, addr: 0x10 },
      { owner: BusOwner.CPU, flags: DMA_WRITE | DMA_BYTE, data: 0x00ef, addr: 0x21 },
    ]);
    const { chip } = reconstructMemoryAt(dma, snapshot(), dma.owner.length);
    expect(chip[0x10]).toBe(0xab);
    expect(chip[0x11]).toBe(0xcd);
    expect(chip[0x21]).toBe(0xef);
    expect(chip[0x20]).toBe(0x00); // untouched neighbour of the byte write
  });

  it("ignores reads and only replays cells before sliceEnd", () => {
    const dma = makeModel([
      { owner: BusOwner.BLITTER, flags: 0, data: 0x1111, addr: 0x10 }, // read: no WRITE
      { owner: BusOwner.BLITTER, flags: DMA_WRITE, data: 0x2222, addr: 0x12 }, // after sliceEnd
    ]);
    const { chip } = reconstructMemoryAt(dma, snapshot(), 1); // only cell 0 (a read)
    expect(chip[0x10]).toBe(0);
    expect(chip[0x12]).toBe(0);
  });

  it("routes a Copper register write (bare offset) to registers, not chip RAM", () => {
    // owner=COPPER + WRITE ⇒ custom register even though addr (0x180) looks like chip RAM.
    const dma = makeModel([{ owner: BusOwner.COPPER, flags: DMA_WRITE, data: 0x0f00, addr: 0x180 }]);
    const { chip } = reconstructMemoryAt(dma, snapshot(), dma.owner.length);
    expect(chip[0x180]).toBe(0);
    expect(chip[0x181]).toBe(0);
  });
});

describe("resolveMemoryRegion", () => {
  const snapshot = { chip: new Uint8Array(0x1000), slow: new Uint8Array(0x800) };

  it("maps a chip address to the chip buffer", () => {
    const r = resolveMemoryRegion(0x10, snapshot);
    expect(r).toEqual({ region: "chip", buf: snapshot.chip, offset: 0x10 });
  });

  it("doesn't recognize an address past the chip buffer's own size (documented limitation)", () => {
    expect(resolveMemoryRegion(0x1010, snapshot)).toBeUndefined(); // 0x1010 >= chip.length (0x1000)
  });

  it("maps a slow-RAM address (SLOW_BASE-relative) to the slow buffer", () => {
    const r = resolveMemoryRegion(SLOW_BASE + 0x20, snapshot);
    expect(r).toEqual({ region: "slow", buf: snapshot.slow, offset: 0x20 });
  });

  it("returns undefined for an address outside both buffers (e.g. an empty slow RAM)", () => {
    const noSlow = { chip: new Uint8Array(0x1000), slow: new Uint8Array(0) };
    expect(resolveMemoryRegion(SLOW_BASE + 0x20, noSlow)).toBeUndefined();
  });
});

describe("findPrevMemWrite / findNextMemWrite", () => {
  const dma = makeModel([
    { owner: BusOwner.CPU, flags: 0, data: 0, addr: 0 },
    { owner: BusOwner.CPU, flags: DMA_WRITE, data: 0x1234, addr: 0x100 }, // slot 1
    { owner: BusOwner.CPU, flags: 0, data: 0, addr: 0 },
    { owner: BusOwner.COPPER, flags: DMA_WRITE, data: 0x0f00, addr: 0x180 }, // register write, not RAM
    { owner: BusOwner.CPU, flags: DMA_WRITE, data: 0x5678, addr: 0x100 }, // slot 4
  ]);

  it("finds the nearest write to the exact address, ignoring register writes", () => {
    expect(findPrevMemWrite(dma, 0x100, 3)).toBe(1);
    expect(findNextMemWrite(dma, 0x100, 1)).toBe(4);
    expect(findPrevMemWrite(dma, 0x100, 1)).toBeUndefined(); // strictly before slot 1: none
    expect(findNextMemWrite(dma, 0x100, 4)).toBeUndefined(); // strictly after slot 4: none
  });

  it("doesn't match an unrelated address", () => {
    expect(findPrevMemWrite(dma, 0x200, 5)).toBeUndefined();
  });
});

describe("reconstructCustomRegs", () => {
  it("applies a Copper MOVE (bare offset) to the register file", () => {
    const dma = makeModel([{ owner: BusOwner.COPPER, flags: DMA_WRITE, data: 0x0f00, addr: 0x180 }]);
    const regs = reconstructCustomRegs(dma, new Uint16Array(256), dma.owner.length);
    expect(regs[0x180 >> 1]).toBe(0x0f00); // COLOR00
  });

  it("honors the DMACON SETCLR semantic for set and clear", () => {
    // DMACON is 0xdff096 (CPU full address). SETCLR (0x8000) set ⇒ OR the low 15 bits.
    const set = makeModel([{ owner: BusOwner.CPU, flags: DMA_WRITE, data: 0x8200, addr: 0xdff096 }]);
    let regs = reconstructCustomRegs(set, new Uint16Array(256), 1);
    expect(regs[0x096 >> 1]).toBe(0x0200);

    // SETCLR clear ⇒ AND-NOT.
    const base = new Uint16Array(256);
    base[0x096 >> 1] = 0x0300;
    const clr = makeModel([{ owner: BusOwner.CPU, flags: DMA_WRITE, data: 0x0200, addr: 0xdff096 }]);
    regs = reconstructCustomRegs(clr, base, 1);
    expect(regs[0x096 >> 1]).toBe(0x0100);
  });

  it("ignores non-register writes", () => {
    const dma = makeModel([{ owner: BusOwner.BLITTER, flags: DMA_WRITE, data: 0xffff, addr: 0x40 }]);
    const regs = reconstructCustomRegs(dma, new Uint16Array(256), dma.owner.length);
    expect(regs.every((r) => r === 0)).toBe(true);
  });
});

describe("createTopDownGraph DMA grouping", () => {
  function stubSourceMap(): SourceMap {
    return {
      findSymbolOffset: (pc: number) => (pc === 0x100 ? { symbol: "_start", offset: 0 } : undefined),
      lookupAddress: (pc: number) => (pc === 0x100 ? { path: "a.c", line: 1 } : undefined),
      findSegmentForAddress: () => ({}), // all test PCs are "in program"
      getCfaForPc: () => ({ reg: 15, offset: 0 }), // all test PCs have CFI (not no-debug blobs)
      getUnwindRows: () => [{}], // non-empty -> a DWARF program (blob-nesting enabled)
    } as unknown as SourceMap;
  }
  const samples: InstructionSample[] = [{ stack: [0x100], cycles: 10 }];

  it("keeps CPU functions flat at the root when there's no DMA", () => {
    const model = buildProfileModel(samples, stubSourceMap());
    const top = Object.values(createTopDownGraph(model).children);
    expect(top.map((n) => n.callFrame.functionName)).toEqual(["_start"]);
  });

  it("groups under top-level CPU and DMA nodes, with per-type DMA subgroups", () => {
    const model = buildProfileModel(samples, stubSourceMap());
    model.dma = makeModel([
      { owner: BusOwner.CPU, flags: DMA_CODE, data: 0, addr: 0x100 }, // CPU Code
      { owner: BusOwner.CPU, flags: 0, data: 0, addr: 0x2000 }, // CPU Data
      { owner: BusOwner.COPPER, flags: 0, data: 0, addr: 0x500 }, // Copper (MOVE)
      { owner: BusOwner.BPL1, flags: 0, data: 0, addr: 0x600 }, // Bitplane 1
      { owner: BusOwner.BLITTER, flags: DMA_WRITE, data: 0, addr: 0x700 }, // Blitter
    ]);

    const top = Object.values(createTopDownGraph(model).children);
    expect(top.map((n) => n.callFrame.functionName)).toEqual(["CPU", "DMA"]);

    const cpu = top[0];
    expect(Object.values(cpu.children).map((n) => n.callFrame.functionName)).toContain("_start");

    const dma = top[1];
    const groups = Object.values(dma.children).map((n) => n.callFrame.functionName);
    expect(groups).toEqual(expect.arrayContaining(["CPU", "Copper", "Bitplane", "Blitter"]));

    // Multi-channel types are expandable parents; single-channel types are direct leaves.
    const cpuGroup = Object.values(dma.children).find((n) => n.callFrame.functionName === "CPU")!;
    expect(Object.values(cpuGroup.children).map((n) => n.callFrame.functionName).sort()).toEqual([
      "Code",
      "Data",
    ]);
    const blitter = Object.values(dma.children).find((n) => n.callFrame.functionName === "Blitter")!;
    expect(blitter.childrenSize).toBe(0); // single-channel ⇒ leaf
    expect(blitter.dmaColor).toBeDefined();
  });
});
