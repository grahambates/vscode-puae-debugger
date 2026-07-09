import { computeBeamPosition, DMA_HPOS, DMA_VPOS, IScreen } from "../webview/profilerViewer/gfxResources";

const baseScreen: IScreen = {
  numPlanes: 4,
  width: 320,
  height: 200,
  firstLine: 50,
  hires: false,
  ham: false,
  dpf: false,
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
    const screen: IScreen = { ...baseScreen, hires: true };
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
