import {
  buildScreenFromModel, computeBeamPosition, computeSlotFromBeamPosition, decodeBplcon0, DDF_FETCH_DELAY_CCK,
  DIW_DDF_OFFSET, DMA_HPOS, DMA_VPOS, IScreen,
} from "../webview/profilerViewer/gfxResources";
import { BusOwner, ICopperModel, IDmaModel, IProfileModel } from "../shared/profilerTypes";
import { CUSTOM_REGISTER_OFFSETS as R } from "../webview/shared/customRegisters";

const baseScreen: IScreen = {
  numPlanes: 4,
  width: 320,
  height: 200,
  firstLine: 50,
  hires: false,
  shres: false,
  ham: false,
  dpf: false,
  staticPlanes: false,
  canvasHires: false,
  modeChanges: false,
  displayLeft: 64,
  diwLeft: 0,
  diwRight: 320,
  diwTop: 50,
  diwBottom: 250,
  blocks: 20,
};

describe("computeBeamPosition", () => {
  it("maps a lores hpos/vpos to canvas coordinates via the displayLeft formula", () => {
    const slot = 60 * DMA_HPOS + 40; // vpos=60, hpos=40
    // loresX = 40*2 = 80; canvasX = (80-64)*1 = 16; canvasY = 60-50 = 10
    expect(computeBeamPosition(baseScreen, slot)).toEqual({ x: 16, y: 10 });
  });

  it("doubles the x scale in hires mode", () => {
    const screen: IScreen = { ...baseScreen, hires: true, canvasHires: true };
    const slot = 60 * DMA_HPOS + 40;
    // canvasX = (80-64)*2 = 32
    expect(computeBeamPosition(screen, slot)).toEqual({ x: 32, y: 10 });
  });

  it("clamps to the top-left edge when the beam is in vblank/left border", () => {
    const slot = 0; // vpos=0, hpos=0 — well before firstLine=50 and left of displayLeft=64
    expect(computeBeamPosition(baseScreen, slot)).toEqual({ x: 0, y: 0 });
  });

  it("clamps to the bottom-right edge when the beam is past the visible rect", () => {
    const screen: IScreen = { ...baseScreen, width: 320, height: 10, firstLine: 0, displayLeft: 0 };
    const slot = 312 * DMA_HPOS + 226; // last valid vpos/hpos in the DMA grid
    expect(computeBeamPosition(screen, slot)).toEqual({ x: screen.width - 1, y: screen.height - 1 });
  });

  it("wraps multi-frame combined-mode slots (slot >= one frame's worth) via modulo", () => {
    const frameSlots = DMA_HPOS * DMA_VPOS;
    const localSlot = 60 * DMA_HPOS + 40;
    expect(computeBeamPosition(baseScreen, frameSlots + localSlot)).toEqual(
      computeBeamPosition(baseScreen, localSlot),
    );
  });
});

describe("computeSlotFromBeamPosition", () => {
  it("is the inverse of computeBeamPosition — clicking the crosshair's spot returns to its slot", () => {
    const localSlot = 60 * DMA_HPOS + 40;
    const { x, y } = computeBeamPosition(baseScreen, localSlot);
    expect(computeSlotFromBeamPosition(baseScreen, x, y)).toBe(localSlot);
  });

  it("accounts for the doubled x scale in hires mode", () => {
    const screen: IScreen = { ...baseScreen, hires: true, canvasHires: true };
    const localSlot = 60 * DMA_HPOS + 40;
    const { x, y } = computeBeamPosition(screen, localSlot);
    expect(computeSlotFromBeamPosition(screen, x, y)).toBe(localSlot);
  });

  it("clamps a click above/left of the display area into the first valid line/column", () => {
    expect(computeSlotFromBeamPosition(baseScreen, -100, -100)).toBe(0 * DMA_HPOS + 0);
  });

  it("clamps a click below/right of the display area into the last valid line/column", () => {
    const screen: IScreen = { ...baseScreen, firstLine: 0, displayLeft: 0 };
    expect(computeSlotFromBeamPosition(screen, 1e6, 1e6)).toBe((DMA_VPOS - 1) * DMA_HPOS + (DMA_HPOS - 1));
  });
});

describe("decodeBplcon0", () => {
  it("reads BPU/hires/ham/dpf straight off the register bits", () => {
    const val = (5 << 12) | (1 << 15) | (1 << 11) | (1 << 10); // 5 planes, hires, ham, dpf
    expect(decodeBplcon0(val, false)).toEqual({
      numPlanes: 5, hires: true, shres: false, ham: true, dpf: true, staticPlanes: false,
    });
  });

  it("detects the OCS/ECS 7-plane trick (BPU==7, non-AGA) and forces numPlanes to 6", () => {
    const val = 7 << 12;
    expect(decodeBplcon0(val, false)).toEqual({
      numPlanes: 6, hires: false, shres: false, ham: false, dpf: false, staticPlanes: true,
    });
  });

  it("treats BPU==7 as a literal 7-plane mode on AGA (isAga=true), not the trick", () => {
    const val = 7 << 12;
    expect(decodeBplcon0(val, true)).toEqual({
      numPlanes: 7, hires: false, shres: false, ham: false, dpf: false, staticPlanes: false,
    });
  });

  it("decodes SHRES (bit 6) independently of HIRES", () => {
    const val = 1 << 6;
    expect(decodeBplcon0(val, true).shres).toBe(true);
    expect(decodeBplcon0(val, true).hires).toBe(false);
  });
});

// Minimal IProfileModel builder for buildScreenFromModel tests — only dma/dmaSnapshot/copper are
// read, so the other required IProfileModel fields are just empty/zeroed.
function makeDma(firstLine: number, lastLine: number, planes: number): IDmaModel {
  const owner = new Uint8Array(DMA_HPOS * DMA_VPOS);
  const flags = new Uint8Array(owner.length);
  const addr  = new Uint32Array(owner.length);
  const value = new Uint16Array(owner.length);
  for (let vpos = firstLine; vpos <= lastLine; vpos++) {
    for (let p = 0; p < planes; p++) owner[vpos * DMA_HPOS + 10 + p] = BusOwner.BPL1 + p;
  }
  return { owner, flags, addr, value };
}

function makeCopper(writes: { vpos: number; reg: number; val: number }[]): ICopperModel {
  return {
    addr: new Uint32Array(writes.length),
    w1:   Uint16Array.from(writes, (w) => w.reg & 0x1fe),
    w2:   Uint16Array.from(writes, (w) => w.val),
    hpos: new Uint16Array(writes.length),
    vpos: Uint16Array.from(writes, (w) => w.vpos),
  };
}

function makeModel(opts: {
  firstLine: number; lastLine: number; planes: number;
  bplcon0: number; ddfstrt: number; ddfstop: number;
  diwstrt?: number; diwstop?: number;
  copperWrites?: { vpos: number; reg: number; val: number }[];
}): IProfileModel {
  const custom = new Uint16Array(256);
  custom[R.BPLCON0 >> 1] = opts.bplcon0;
  custom[R.DDFSTRT >> 1] = opts.ddfstrt;
  custom[R.DDFSTOP >> 1] = opts.ddfstop;
  if (opts.diwstrt !== undefined) custom[R.DIWSTRT >> 1] = opts.diwstrt;
  if (opts.diwstop !== undefined) custom[R.DIWSTOP >> 1] = opts.diwstop;
  return {
    nodes: [], locations: [], samples: [], timeDeltas: [], pcs: [],
    duration: 0, cyclesPerMicroSecond: 7.09379,
    dma: makeDma(opts.firstLine, opts.lastLine, opts.planes),
    dmaSnapshot: { chip: new Uint8Array(0), slow: new Uint8Array(0), custom },
    copper: makeCopper(opts.copperWrites ?? []),
  };
}

describe("buildScreenFromModel", () => {
  it("sizes the canvas to the standard PAL preset (360 lores canvas-units wide) when hires never appears in the display area", () => {
    const model = makeModel({
      firstLine: 100, lastLine: 150, planes: 4,
      bplcon0: 4 << 12, ddfstrt: 0x38, ddfstop: 0xd0,
    });
    const screen = buildScreenFromModel(model)!;
    expect(screen.hires).toBe(false);
    expect(screen.canvasHires).toBe(false);
    expect(screen.modeChanges).toBe(false);
    expect(screen.width).toBe(360); // STANDARD_FB_WIDTH(720) halved for lores canvas-units
    expect(screen.height).toBe(287); // STANDARD_FB_HEIGHT(574) halved
  });

  it("sizes the canvas for hires when a mid-frame copper split enables it, even though the initial state is lores", () => {
    const model = makeModel({
      firstLine: 100, lastLine: 150, planes: 4,
      bplcon0: 4 << 12, ddfstrt: 0x38, ddfstop: 0xd0,
      copperWrites: [{ vpos: 120, reg: R.BPLCON0, val: (4 << 12) | (1 << 15) }],
    });
    const lores = buildScreenFromModel({
      ...model,
      copper: makeCopper([]), // same geometry, no split, for a width baseline
    })!;
    const screen = buildScreenFromModel(model)!;
    expect(screen.hires).toBe(false); // initial state at firstLine is still lores
    expect(screen.canvasHires).toBe(true); // but the canvas is sized for the hires split
    expect(screen.modeChanges).toBe(true);
    expect(screen.width).toBe(lores.width * 2); // hires standard canvas is exactly double lores's
    expect(screen.width).toBe(720); // STANDARD_FB_WIDTH used directly (1:1) for hires canvas-units
  });

  it("computes DIW bounds using real captured register values (verified against PUAE's own calcdiw())", () => {
    // Real register values from an actual capture (displayLeft/diwLeft/diwRight below are this
    // project's own independently-verified numbers for the same capture, adjusted for the
    // standard-canvas centering offset — see the "sizes the canvas..." tests above for that math).
    const model = makeModel({
      firstLine: 82, lastLine: 261, planes: 4,
      bplcon0: 4 << 12, ddfstrt: 0x38, ddfstop: 0xc8,
      diwstrt: 0x5291, diwstop: 0x06b1, // VSTART=0x52=82 HSTART=0x91=145, VSTOP byte=0x06(->+256=262) HSTOP=0xb1=177
    });
    const screen = buildScreenFromModel(model)!;
    expect(screen.width).toBe(360); // standard lores canvas, not the content-derived 304
    // contentWidth = 19 blocks << 4 = 304; offsetX = floor((360-304)/2) = 28;
    // contentDisplayLeft = (ddfStart(56) + DDF_FETCH_DELAY_CCK(8)) * 2 + DIW_DDF_OFFSET(1) = 129
    // (the real DDF-fetch-scheduling delay — see DDF_FETCH_DELAY_CCK's doc comment in
    // gfxResources.ts); displayLeft = 129 - 28 = 101.
    expect(screen.displayLeft).toBe(101);
    // Vertically, DIW happens to span exactly the DMA-active range here (the common case for a
    // single, non-split display) — still true against the taller standard-canvas height.
    expect(screen.diwTop).toBe(82);
    expect(screen.diwBottom).toBe(262);
    // Horizontally: HSTART (145) converts 1:1 to canvas-x-before-displayLeft-subtraction; HSTOP
    // (177) gets the unconditional "+256" DIWHIGH-not-written extension custom.c's calcdiw()
    // applies. Both relative to the shifted displayLeft(101) above, neither clamped (comfortably
    // inside [0, 360]) — i.e. this capture's DIW crops a small margin off the left and leaves a
    // wide margin on the right within the standard canvas.
    expect(screen.diwLeft).toBe(145 - 101);
    expect(screen.diwRight).toBe(177 + 256 - 101);
  });

  it("aligns the DDF content window with DIW for a real capture's default (unwidened) DDFSTRT/DIWSTRT pair", () => {
    // Real register values from an actual capture (hunk2.puaeprofile) whose default DDFSTRT/
    // DDFSTOP/DIWSTRT/DIWSTOP are all standard AmigaOS defaults. On real hardware, a normal
    // display's fetch and display windows are tuned by Commodore to overlap almost exactly, not
    // sit a full DDF block (16px) apart — this regression-guards the fetch-scheduling-delay fix:
    // without DDF_FETCH_DELAY_CCK, the DDF window used to land 16px short of DIWSTRT/DIWSTOP,
    // clipping legitimate content off the left edge of the display window (most visible on a
    // scroller's sharp text, but present, just imperceptible, in any capture using these defaults).
    const model = makeModel({
      firstLine: 44, lastLine: 299, planes: 4,
      bplcon0: 4 << 12, ddfstrt: 0x38, ddfstop: 0xd0,
      diwstrt: 0x2c81, diwstop: 0x2cc1, // HSTART=0x81=129, HSTOP=0xc1=193(+256=449)
    });
    const screen = buildScreenFromModel(model)!;
    const ddfStart = 0x38 & 0xfc; // 56
    const contentDisplayLeft = (ddfStart + DDF_FETCH_DELAY_CCK) * 2 + DIW_DDF_OFFSET;
    // The DDF window's own canvas-x position now lands exactly on DIWSTRT's (129) — confirming the
    // fetch-scheduling delay is what was missing, not some other unrelated centering/DIW bug.
    expect(contentDisplayLeft).toBe(129);
    // diwLeft/diwRight now measure a near-zero gap from the content's own start (not a full 16px
    // block short of it).
    const contentCanvasX = contentDisplayLeft - screen.displayLeft;
    expect(screen.diwLeft).toBe(contentCanvasX);
  });

  it("clamps a DIW VSTOP wraparound (byte's top bit clear -> +256) to the DMA-active range", () => {
    const model = makeModel({
      firstLine: 44, lastLine: 299, planes: 4,
      bplcon0: 4 << 12, ddfstrt: 0x30, ddfstop: 0xd0,
      diwstrt: 0x2c81, diwstop: 0x2cc1,
    });
    const screen = buildScreenFromModel(model)!;
    // VSTOP byte 0x2c has bit7 clear -> real VSTOP = 0x2c + 256 = 300, exactly firstLine+height
    // here (44+256) — proves the wraparound math, not just the clamp.
    expect(screen.diwBottom).toBe(44 + 256);
  });

  it("centers the fetched content within the standard-sized canvas rather than cropping to it", () => {
    const base = {
      firstLine: 100, lastLine: 150, planes: 4,
      bplcon0: 4 << 12, ddfstrt: 0x38, ddfstop: 0xd0,
      // DIW set to exactly match the content span (real hardware always configures DIW before
      // enabling display — DIWSTRT/DIWSTOP left at their unset default of 0/0 isn't a
      // configuration any real capture would have, and is exactly the degenerate case the
      // union-with-DIW centering below would otherwise (correctly) treat very differently — see
      // the dedicated DIW-wider-than-content test for that). diwstrt=0x6481 (VSTART=100=firstLine,
      // HSTART=0x81=129=contentDisplayLeft); diwstop=0x97c1 (VSTOP byte=0x97, bit7 set -> used
      // directly =151=firstLine+height; HSTOP=0xc1=193, +256=449=contentDisplayLeft+contentWidth).
      diwstrt: 0x6481, diwstop: 0x97c1,
    };
    const screen = buildScreenFromModel(makeModel(base))!;
    expect(screen.width).toBe(360);
    expect(screen.height).toBe(287);

    const ddfStart = 0x38 & 0xfc; // 56
    const ddfStop  = 0xd0 & 0xfc; // 208
    const blocks = Math.floor((ddfStop - ddfStart + 7) / 8) + 1; // 20
    const contentWidth  = blocks << 4; // 320
    const contentHeight = base.lastLine - base.firstLine + 1; // 51
    const offsetX = Math.floor((screen.width - contentWidth) / 2);
    const offsetY = Math.floor((screen.height - contentHeight) / 2);

    // The content's own x=0/y=0 now lands at the centering offset, not at the canvas's own (0,0)
    // — i.e. it's centered, not cropped to fit. Checked directly against displayLeft (rather than
    // computeBeamPosition at some hpos) since the real DDF-to-canvas-x conversion includes a
    // sub-hpos fetch-scheduling fudge (DIW_DDF_OFFSET) that doesn't correspond to any integer hpos.
    const contentDisplayLeft = (ddfStart + DDF_FETCH_DELAY_CCK) * 2 + DIW_DDF_OFFSET;
    expect(contentDisplayLeft - screen.displayLeft).toBe(offsetX);
    expect(computeBeamPosition(screen, base.firstLine * DMA_HPOS).y).toBe(offsetY);
  });

  it("reports DIW's true (unclamped) extent when DIW is wider than, and off-center relative to, a narrower DDF", () => {
    // DDF fetches a narrow 64-canvas-unit-wide strip (blocks=4); DIW is a full 320-wide window
    // that starts to the LEFT of that strip and extends well past its right edge — i.e. DIW is
    // neither centered on nor contained within what DDF fetches (the reported bug scenario).
    // Centering the canvas on content alone (the old behavior) put DIW's real right edge (410, in
    // "raw canvas-x" units) past the 360-wide canvas, silently clamped down to 360 — losing 85
    // units of DIW's true extent — and its left edge (90) similarly landed at the wrong offset.
    const base = {
      firstLine: 100, lastLine: 150, planes: 4,
      bplcon0: 4 << 12, ddfstrt: 0x30, ddfstop: 0x48, // ddfStart=48, ddfStop=72 -> blocks=4, contentWidth=64
      // diwstrt=0x645a (VSTART=100=firstLine, HSTART=0x5a=90); diwstop=0x979a (VSTOP byte=0x97,
      // bit7 set -> 151=firstLine+height; HSTOP=0x9a=154, +256=410). DIW span: [90, 410) — 320
      // wide, starting 23 units before content's own start (113) and ending 297 units after it,
      // nowhere near centered on or contained in content's own [113, 177) span.
      diwstrt: 0x645a, diwstop: 0x979a,
    };
    const screen = buildScreenFromModel(makeModel(base))!;
    expect(screen.width).toBe(360);

    // DIW's real span, reconstructed independently of the implementation's own internals: 320
    // wide, and (since the union of content+DIW is exactly DIW-sized here and centered in the
    // 360-wide canvas) starting (360-320)/2 = 20 in from the left edge.
    expect(screen.diwRight - screen.diwLeft).toBe(320); // full real DIW width, not clamped down
    expect(screen.diwLeft).toBe(20);
    expect(screen.diwRight).toBe(340);

    // Content itself (the narrow DDF-fetched strip) still lands fully on-canvas, unclamped.
    const contentDisplayLeft = (48 + DDF_FETCH_DELAY_CCK) * 2 + DIW_DDF_OFFSET; // 113
    const contentCanvasX = contentDisplayLeft - screen.displayLeft;
    expect(contentCanvasX).toBeGreaterThanOrEqual(0);
    expect(contentCanvasX + 64).toBeLessThanOrEqual(screen.width);
  });
});
