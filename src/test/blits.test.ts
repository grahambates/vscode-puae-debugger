import { getBlits, blitTooltip, blitLabel, blitChannels, BlitMode } from "../webview/profilerViewer/blits";
import { IDmaModel, BusOwner, DMA_WRITE } from "../shared/profilerTypes";

// Build an IDmaModel of `n` idle slots, then let the caller stamp cells.
function grid(n: number): IDmaModel & { set: (i: number, c: Partial<{ owner: number; flags: number; addr: number; value: number }>) => void } {
  const m = {
    owner: new Uint8Array(n),
    flags: new Uint8Array(n),
    addr: new Uint32Array(n),
    value: new Uint16Array(n),
  };
  return {
    ...m,
    set(i, c) {
      if (c.owner !== undefined) m.owner[i] = c.owner;
      if (c.flags !== undefined) m.flags[i] = c.flags;
      if (c.addr !== undefined) m.addr[i] = c.addr;
      if (c.value !== undefined) m.value[i] = c.value;
    },
  };
}

// A CPU write to a custom register $DFF000+off.
const regWrite = (g: ReturnType<typeof grid>, i: number, off: number, value: number) =>
  g.set(i, { owner: BusOwner.CPU, flags: DMA_WRITE, addr: 0xdff000 + off, value });

const BLTCON0 = 0x040, BLTCON1 = 0x042, BLTAPTH = 0x050, BLTAPTL = 0x052;
const BLTDPTH = 0x054, BLTDPTL = 0x056, BLTSIZE = 0x058;

describe("getBlits", () => {
  it("reconstructs a cookie-cut ABCD copy blit (size, channels, mode, end = final D write)", () => {
    const g = grid(64);
    let i = 0;
    regWrite(g, i++, BLTCON0, 0x0fca); // USEA|USEB|USEC|USED (bits 11-8) + minterm $CA
    regWrite(g, i++, BLTCON1, 0x0000); // copy mode
    regWrite(g, i++, BLTAPTH, 0x0002); // A ptr = $21000
    regWrite(g, i++, BLTAPTL, 0x1000);
    regWrite(g, i++, BLTDPTH, 0x0000); // D ptr = $C000
    regWrite(g, i++, BLTDPTL, 0xc000);
    regWrite(g, i++, BLTSIZE, (3 << 6) | 2); // width=2 words, height=3 lines

    // 2x3 = 6 words; each word = A read, B read, C read, D write (owner=BLITTER).
    let lastD = -1;
    for (let w = 0; w < 6; w++) {
      g.set(i++, { owner: BusOwner.BLITTER, flags: 0 }); // A read
      g.set(i++, { owner: BusOwner.BLITTER, flags: 0 }); // B read
      g.set(i++, { owner: BusOwner.BLITTER, flags: 0 }); // C read
      lastD = i;
      g.set(i++, { owner: BusOwner.BLITTER, flags: DMA_WRITE }); // D write
    }

    const { blits, fastBlitter } = getBlits(g);
    expect(fastBlitter).toBe(false);
    expect(blits).toHaveLength(1);
    const b = blits[0];
    expect(b.width).toBe(2);
    expect(b.height).toBe(3);
    expect(b.con0).toBe(0x0fca);
    expect(b.mode).toBe(BlitMode.Copy);
    expect(blitChannels(b.con0)).toBe("ABCD");
    expect(b.ptr[0]).toBe(0x21000); // A
    expect(b.ptr[3]).toBe(0xc000); // D
    expect(b.finished).toBe(true);
    expect(b.endSlot).toBe(lastD); // final D write, not BLITIRQ+8
  });

  it("does NOT invent a phantom blit from a stale BLTSIZE address on an idle cell", () => {
    const g = grid(32);
    regWrite(g, 0, BLTSIZE, (1 << 6) | 1); // one real BLTSIZE write
    g.set(1, { owner: BusOwner.BLITTER, flags: DMA_WRITE });
    // Idle cell carrying a stale $DFF058 address but NO write flag — must be ignored.
    g.set(5, { owner: BusOwner.NONE, flags: 0, addr: 0xdff000 + BLTSIZE, value: 0x1234 });
    expect(getBlits(g).blits).toHaveLength(1);
  });

  it("flags a fast-blitter capture (BLTSIZE writes but no blitter cells)", () => {
    const g = grid(16);
    regWrite(g, 0, BLTSIZE, (2 << 6) | 2);
    const { blits, fastBlitter } = getBlits(g);
    expect(fastBlitter).toBe(true);
    expect(blits[0].finished).toBe(false);
  });

  it("detects line and fill modes from BLTCON1", () => {
    const line = grid(8);
    regWrite(line, 0, BLTCON1, 0x0001); // LINE
    regWrite(line, 1, BLTSIZE, (1 << 6) | 1);
    expect(getBlits(line).blits[0].mode).toBe(BlitMode.Line);

    const fill = grid(8);
    regWrite(fill, 0, BLTCON1, 0x0008); // IFE
    regWrite(fill, 1, BLTSIZE, (1 << 6) | 1);
    expect(getBlits(fill).blits[0].mode).toBe(BlitMode.Fill);
  });
});

describe("blitTooltip", () => {
  it("derives minterm hex/expression and channel rows", () => {
    const g = grid(8);
    regWrite(g, 0, BLTCON0, 0x0fca);
    regWrite(g, 1, BLTSIZE, (1 << 6) | 1);
    const tip = blitTooltip(getBlits(g).blits[0]);
    expect(tip.mintermHex).toBe("$ca");
    expect(tip.mintermExpr.length).toBeGreaterThan(0);
    expect(tip.mintermBits).toHaveLength(8);
    // ABCD all enabled -> four channel rows (Source A/B/C + Destination).
    expect(tip.channels.map((c) => c.label)).toEqual(["Source A", "Source B", "Source C", "Destination"]);
  });

  it("shows the real pixel length for a line blit instead of a bogus width x height", () => {
    // BLTSIZE's width field is hardwired to 2 words for line mode, regardless of the line's
    // actual geometry — so a naive `width*16 x height` label always reads a constant, meaningless
    // "32px" wide. The height field is what actually holds the line's pixel length in this mode.
    const g = grid(8);
    regWrite(g, 0, BLTCON1, 0x0001); // LINE
    regWrite(g, 1, BLTSIZE, (100 << 6) | 2); // width=2 (fixed), height=100 (the line's real length)
    const blit = getBlits(g).blits[0];
    expect(blit.mode).toBe(BlitMode.Line);

    expect(blitLabel(blit)).toContain("100px");
    expect(blitLabel(blit)).not.toContain("32px");
    expect(blitTooltip(blit).size).toBe("100px");
  });

  it("still shows width x height for an area (Copy/Fill) blit", () => {
    const g = grid(8);
    regWrite(g, 0, BLTCON0, 0x0fca);
    regWrite(g, 1, BLTSIZE, (3 << 6) | 2); // width=2 words (32px), height=3 rows
    const blit = getBlits(g).blits[0];
    expect(blitTooltip(blit).size).toBe("32x3px");
  });
});

describe("getBlits: registers set before the capture", () => {
  it("lists the registers a blit uses that weren't written in the frame", () => {
    const g = grid(16);
    regWrite(g, 0, BLTCON0, 0x0100); // D only, minterm 0: a clear
    regWrite(g, 1, BLTDPTH, 0x0001);
    regWrite(g, 2, BLTDPTL, 0x0000);
    regWrite(g, 3, BLTSIZE, (1 << 6) | 1);
    const [b] = getBlits(g).blits;
    // Only D is enabled, so A/B/C's registers don't count; BLTCON1 and BLTDMOD were never written.
    expect(b.unseen).toEqual(["BLTCON1", "BLTDMOD"]);
  });

  it("treats every channel as unknown when BLTCON0 itself was never written", () => {
    const g = grid(8);
    regWrite(g, 0, BLTDPTH, 0x0001);
    regWrite(g, 1, BLTDPTL, 0x0000);
    regWrite(g, 2, BLTSIZE, (1 << 6) | 1);
    const [b] = getBlits(g).blits;
    expect(b.unseen).toContain("BLTCON0");
    expect(b.unseen).toContain("BLTAPTH");
    expect(b.unseen).not.toContain("BLTDPTH");
  });
});

describe("getBlits: frame-start register baseline", () => {
  const baseline = () => {
    const regs = new Uint16Array(256);
    regs[BLTCON0 >> 1] = 0x0100; // D only, clear
    regs[0x066 >> 1] = 40; // BLTDMOD
    regs[BLTAPTH >> 1] = 0x0002; // a stale A pointer — the blitter advances these, so never seeded
    return regs;
  };

  it("fills in registers the CPU set before the frame", () => {
    const g = grid(8);
    regWrite(g, 0, BLTDPTH, 0x0001);
    regWrite(g, 1, BLTDPTL, 0x0000);
    regWrite(g, 2, BLTSIZE, (1 << 6) | 1);
    const [b] = getBlits(g, baseline()).blits;
    expect(b.con0).toBe(0x0100);
    expect(b.mod[3]).toBe(40);
    expect(blitLabel(b)).toBe("Clear ---D 16x1px");
    expect(b.unseen).toEqual([]);
  });

  it("does not seed pointers, which the blitter itself moves", () => {
    const g = grid(8);
    regWrite(g, 0, BLTCON0, 0x0900); // A and D
    regWrite(g, 1, BLTSIZE, (1 << 6) | 1);
    const [b] = getBlits(g, baseline()).blits;
    expect(b.ptr[0]).toBe(0);
    expect(b.unseen).toEqual(expect.arrayContaining(["BLTAPTH", "BLTDPTH"]));
  });

  it("shows a blit already running when the frame began, from the frame's start", () => {
    const g = grid(16);
    for (let i = 2; i < 6; i++) g.set(i, { owner: BusOwner.BLITTER, flags: i % 2 ? DMA_WRITE : 0 });
    regWrite(g, 8, BLTSIZE, (1 << 6) | 1); // the next blit, started in this frame
    g.set(10, { owner: BusOwner.BLITTER, flags: DMA_WRITE });
    const regs = baseline();
    regs[0x05c >> 1] = 200; // BLTSIZV
    regs[0x05e >> 1] = 20; // BLTSIZH
    regs[BLTDPTH >> 1] = 0x0001;
    regs[BLTDPTL >> 1] = 0x2340; // where the D pointer had got to

    const { blits } = getBlits(g, regs);
    expect(blits).toHaveLength(2);
    const [carried, next] = blits;
    expect(carried).toMatchObject({ startedBefore: true, startSlot: 0, endSlot: 5, finished: true, width: 20, height: 200, con0: 0x0100 });
    expect(carried.ptr[3]).toBe(0x12340);
    expect(carried.unseen).toEqual(["BLTDPTH", "BLTDPTL"]);
    expect(blitLabel(carried)).toBe("… Clear ---D 320x200px");
    expect(blitTooltip(carried).startedBefore).toBe(true);
    expect(next).toMatchObject({ startedBefore: false, startSlot: 8, endSlot: 10 });
  });

  it("still shows a carried-over blit's span without a frame-start snapshot", () => {
    const g = grid(8);
    g.set(3, { owner: BusOwner.BLITTER, flags: DMA_WRITE });
    const [b] = getBlits(g).blits;
    expect(b).toMatchObject({ startedBefore: true, startSlot: 0, endSlot: 3, finished: true });
    expect(blitLabel(b)).toBe("… Blit from an earlier frame");
  });

  it("lets a write in the frame override the baseline", () => {
    const g = grid(8);
    regWrite(g, 0, BLTCON0, 0x09f0);
    regWrite(g, 1, BLTSIZE, (1 << 6) | 1);
    expect(getBlits(g, baseline()).blits[0].con0).toBe(0x09f0);
  });
});
