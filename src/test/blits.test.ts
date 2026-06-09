import { getBlits, blitTooltip, blitChannels, BlitMode } from "../webview/profilerViewer/blits";
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
});
