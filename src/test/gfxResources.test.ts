import {
  buildScreenFromModel, computeBeamPosition, decodeBplcon0, DMA_HPOS, DMA_VPOS, IScreen,
} from "../webview/profilerViewer/gfxResources";
import { BusOwner, ICopperModel, IDmaModel, IProfileModel } from "../shared/profilerTypes";
import { CUSTOM_REGISTER_OFFSETS as R } from "../webview/shared/customRegisters";

const baseScreen: IScreen = {
  numPlanes: 4,
  width: 320,
  height: 200,
  firstLine: 50,
  hires: false,
  ham: false,
  dpf: false,
  staticPlanes: false,
  canvasHires: false,
  modeChanges: false,
  displayLeft: 64,
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

describe("decodeBplcon0", () => {
  it("reads BPU/hires/ham/dpf straight off the register bits", () => {
    const val = (5 << 12) | (1 << 15) | (1 << 11) | (1 << 10); // 5 planes, hires, ham, dpf
    expect(decodeBplcon0(val, false)).toEqual({
      numPlanes: 5, hires: true, ham: true, dpf: true, staticPlanes: false,
    });
  });

  it("detects the OCS/ECS 7-plane trick (BPU==7, non-AGA) and forces numPlanes to 6", () => {
    const val = 7 << 12;
    expect(decodeBplcon0(val, false)).toEqual({
      numPlanes: 6, hires: false, ham: false, dpf: false, staticPlanes: true,
    });
  });

  it("treats BPU==7 as a literal 7-plane mode on AGA (isAga=true), not the trick", () => {
    const val = 7 << 12;
    expect(decodeBplcon0(val, true)).toEqual({
      numPlanes: 7, hires: false, ham: false, dpf: false, staticPlanes: false,
    });
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
  copperWrites?: { vpos: number; reg: number; val: number }[];
}): IProfileModel {
  const custom = new Uint16Array(256);
  custom[R.BPLCON0 >> 1] = opts.bplcon0;
  custom[R.DDFSTRT >> 1] = opts.ddfstrt;
  custom[R.DDFSTOP >> 1] = opts.ddfstop;
  return {
    nodes: [], locations: [], samples: [], timeDeltas: [], pcs: [],
    duration: 0, cyclesPerMicroSecond: 7.09379,
    dma: makeDma(opts.firstLine, opts.lastLine, opts.planes),
    dmaSnapshot: { chip: new Uint8Array(0), slow: new Uint8Array(0), custom },
    copper: makeCopper(opts.copperWrites ?? []),
  };
}

describe("buildScreenFromModel", () => {
  it("stays lores-sized when hires never appears in the display area", () => {
    const model = makeModel({
      firstLine: 100, lastLine: 150, planes: 4,
      bplcon0: 4 << 12, ddfstrt: 0x38, ddfstop: 0xd0,
    });
    const screen = buildScreenFromModel(model)!;
    expect(screen.hires).toBe(false);
    expect(screen.canvasHires).toBe(false);
    expect(screen.modeChanges).toBe(false);
    expect(screen.width).toBe(screen.width & ~0xf); // sanity: lores (<<4) sizing, not <<5
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
    expect(screen.width).toBe(lores.width * 2); // hires sizing is exactly double lores sizing
  });
});
