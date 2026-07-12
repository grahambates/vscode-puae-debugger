import {
  buildLinePaletteTimeline, buildLineRegisterTimeline, eventThresholds,
} from "../webview/profilerViewer/gfxResources";
import { ICopperModel, IProfileModel } from "../shared/profilerTypes";
import { CUSTOM_REGISTER_OFFSETS as R } from "../webview/shared/customRegisters";

function makeCopper(writes: { vpos: number; hpos: number; reg: number; val: number }[]): NonNullable<IProfileModel["copper"]> {
  return {
    addr: new Uint32Array(writes.length),
    w1:   Uint16Array.from(writes, (w) => w.reg & 0x1fe),
    w2:   Uint16Array.from(writes, (w) => w.val),
    hpos: Uint16Array.from(writes, (w) => w.hpos),
    vpos: Uint16Array.from(writes, (w) => w.vpos),
  } satisfies ICopperModel;
}

describe("buildLineRegisterTimeline", () => {
  it("splits same-line writes into hpos-ordered events, distinct from the start-of-line value", () => {
    const baseRegs = new Uint16Array(256);
    baseRegs[R.BPLCON2 >> 1] = 0x11;
    const copper = makeCopper([
      { vpos: 10, hpos: 5,  reg: R.BPLCON2, val: 0x22 }, // before the display area (firstLine=20)
      { vpos: 20, hpos: 5,  reg: R.BPLCON2, val: 0x33 }, // same-line event #1
      { vpos: 20, hpos: 50, reg: R.BPLCON2, val: 0x44 }, // same-line event #2
      { vpos: 21, hpos: 3,  reg: R.BPLCON2, val: 0x55 }, // next line's own event
    ]);

    const { start, events } = buildLineRegisterTimeline(baseRegs, copper, 20, 3, R.BPLCON2);

    // Line 0 (vpos=20): starts from the pre-display-area write (0x22), not either same-line write.
    expect(start[0]).toBe(0x22);
    expect(events[0]).toEqual([{ hpos: 5, val: 0x33 }, { hpos: 50, val: 0x44 }]);

    // Line 1 (vpos=21): starts from the LAST of line 0's own writes (0x44), carried forward.
    expect(start[1]).toBe(0x44);
    expect(events[1]).toEqual([{ hpos: 3, val: 0x55 }]);

    // Line 2 (vpos=22): no further writes — carries the last value forward, no events.
    expect(start[2]).toBe(0x55);
    expect(events[2]).toEqual([]);
  });

  it("ignores WAIT/SKIP instructions (bit0 of w1 set) and writes to other registers", () => {
    const baseRegs = new Uint16Array(256);
    const copper: NonNullable<IProfileModel["copper"]> = {
      addr: new Uint32Array(2),
      w1:   Uint16Array.from([R.BPLCON1, R.BPLCON2 | 1]), // a real MOVE, then something WAIT-shaped
      w2:   Uint16Array.from([0x77, 0x88]),
      hpos: Uint16Array.from([10, 10]),
      vpos: Uint16Array.from([20, 20]),
    };
    const { start, events } = buildLineRegisterTimeline(baseRegs, copper, 20, 1, R.BPLCON1);
    expect(start[0]).toBe(0); // BPLCON1 write is same-line, so start-of-line is still the baseline
    expect(events[0]).toEqual([{ hpos: 10, val: 0x77 }]);
  });
});

describe("eventThresholds", () => {
  it("maps each event's hpos to the start of the next fetched word at or after it", () => {
    const wordHpos = [0, 8, 16, 24, 32, 40, 48, 56];
    // hpos=5: word0 (hpos=0) already fetched by then, word1 (hpos=8) isn't yet -> threshold=16 (word1 start).
    // hpos=50: words 0..6 (up to hpos=48) already fetched -> threshold=112 (7*16).
    expect(eventThresholds([{ hpos: 5 }, { hpos: 50 }], wordHpos)).toEqual([16, 112]);
  });

  it("thresholds to 0 when the event happens before any word was fetched", () => {
    expect(eventThresholds([{ hpos: -1 }], [10, 20, 30])).toEqual([0]);
  });

  it("thresholds past the end when the event happens after the last fetched word (never fires this line)", () => {
    expect(eventThresholds([{ hpos: 999 }], [10, 20, 30])).toEqual([3 * 16]);
  });
});

describe("buildLinePaletteTimeline (OCS/ECS)", () => {
  it("carries a mid-line COLORxx write as an event with the fully-resolved RGBA, not the start value", () => {
    const baseRegs = new Uint16Array(256);
    baseRegs[R.COLOR00 >> 1] = 0x000; // black
    const copper = makeCopper([
      { vpos: 50, hpos: 20, reg: R.COLOR00, val: 0xf00 }, // red, mid-line
    ]);
    const { start, events } = buildLinePaletteTimeline(baseRegs, copper, 50, 1, undefined);
    expect(start[0][0]).toBe(0xff000000); // still black at the start of the line
    expect(events[0]).toHaveLength(1);
    // 0xff0000ff via `|` (as the implementation computes it) is a signed int32, not the literal's
    // unsigned reading — match the implementation's own bitwise-OR chain to get the same sign.
    expect(events[0][0]).toMatchObject({ hpos: 20, colreg: 0, rgba: 0xff000000 | 0xff });
  });
});
