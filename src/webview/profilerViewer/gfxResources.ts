import { BusOwner, IProfileModel } from "../../shared/profilerTypes";
import { CUSTOM_REGISTER_OFFSETS as R } from "../shared/customRegisters";

export interface IScreen {
  numPlanes: number;   // max BPL owner index seen in the DMA grid + 1
  width: number;       // fetch width in pixels at display start (from DDF)
  height: number;      // number of scan lines with BPL DMA activity
  firstLine: number;   // vpos of first BPL-active scan line
  hires: boolean;      // BPLCON0 at display start — may not hold for the whole frame
  ham: boolean;        // BPLCON0 at display start — may not hold for the whole frame
  dpf: boolean;        // BPLCON0[10] — dual playfield at display start
  // True when the copper writes BPLCON0 during the display area. When set the
  // info label should say "variable" rather than reporting a single mode, because
  // numPlanes / hires / ham may be different in different parts of the screen.
  modeChanges: boolean;
  // Lores pixel position of canvas x=0 within the full horizontal line.
  // Used to map sprite HSTRT register values (lores pixel units) to canvas coords:
  //   canvas_x = (hstart - displayLeft) * (hires ? 2 : 1)
  displayLeft: number;
}

export const DMA_HPOS = 227; // slots per scan line in the DMA grid

/**
 * Derive screen geometry from the DMA grid + copper trace.
 *
 * - Display bounds (firstLine / lastLine / height): always from the DMA grid.
 * - numPlanes: highest BPL owner seen anywhere in the DMA grid, so copper splits
 *   that add planes later in the frame don't cause us to allocate too few arrays.
 * - hires / ham / width: copper state at firstLine (the initial display setup).
 *   modeChanges is set when the copper writes BPLCON0 inside the display area so
 *   callers can flag that these values aren't globally accurate.
 */
export function buildScreenFromModel(model: IProfileModel): IScreen | undefined {
  const custom = model.dmaSnapshot?.custom;
  const copper = model.copper;
  const dma    = model.dma;
  if (!custom || !copper || !dma) return undefined;

  // ── Step 1: display bounds + numPlanes from DMA grid ─────────────────────
  // numPlanes comes from the grid rather than BPLCON0 so copper splits that
  // enable more planes mid-frame are handled correctly by the render loop.

  let firstLine    = -1;
  let lastLine     = -1;
  let maxPlaneIdx  = -1;
  const ownerLen   = dma.owner.length;

  for (let i = 0; i < ownerLen; i++) {
    const o = dma.owner[i];
    if (o < BusOwner.BPL1 || o > BusOwner.BPL6) continue;
    const pIdx = o - BusOwner.BPL1; // 0-5
    const vpos = (i / DMA_HPOS) | 0;
    if (firstLine < 0) firstLine = vpos;
    lastLine   = vpos;
    if (pIdx > maxPlaneIdx) maxPlaneIdx = pIdx;
  }

  if (firstLine < 0) return undefined; // no bitplane DMA — display was off

  const height    = lastLine - firstLine + 1;
  const numPlanes = maxPlaneIdx + 1;

  // ── Step 2: copper state at display start ─────────────────────────────────
  // Apply only copper MOVEs that execute before firstLine so we get the register
  // values in effect when the display area begins.

  let BPLCON0 = custom[R.BPLCON0 >> 1];
  let DDFSTRT = custom[R.DDFSTRT >> 1];
  let DDFSTOP = custom[R.DDFSTOP >> 1];

  const count = copper.addr.length;
  for (let i = 0; i < count; i++) {
    const w1 = copper.w1[i];
    if (w1 & 1) continue;
    if (copper.vpos[i] >= firstLine) break; // copper records are time-ordered
    const da = w1 & 0x1fe;
    const rd = copper.w2[i];
    switch (da) {
      case R.BPLCON0: if ((rd >>> 12) & 7) BPLCON0 = rd; break;
      case R.DDFSTRT: DDFSTRT = rd; break;
      case R.DDFSTOP: DDFSTOP = rd; break;
    }
  }

  const hires = (BPLCON0 & (1 << 15)) !== 0;
  const ham   = (BPLCON0 & (1 << 11)) !== 0;
  const dpf   = (BPLCON0 & (1 << 10)) !== 0;

  const ddfStart = DDFSTRT & 0xfc;
  const ddfStop  = DDFSTOP & 0xfc;
  if (ddfStart >= ddfStop) return undefined;
  const blocks = Math.floor((ddfStop - ddfStart + 7) / 8) + 1;
  const width  = blocks << (hires ? 5 : 4);

  // ── Step 3: detect mid-display BPLCON0 changes ───────────────────────────
  // If the copper writes BPLCON0 during the display area, the mode (hires/ham/
  // numPlanes) isn't constant and the info label should say so.

  let modeChanges = false;
  for (let i = 0; i < count; i++) {
    const w1 = copper.w1[i];
    if (w1 & 1) continue;
    const vp = copper.vpos[i];
    if (vp < firstLine) continue;
    if (vp > lastLine)  break;
    if ((w1 & 0x1fe) === R.BPLCON0) { modeChanges = true; break; }
  }

  return { numPlanes, width, height, firstLine, hires, ham, dpf, modeChanges, displayLeft: ddfStart * 2 };
}
