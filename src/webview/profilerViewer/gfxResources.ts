import { BusOwner, IProfileModel } from "../../shared/profilerTypes";
import { CUSTOM_REGISTER_OFFSETS as R } from "../shared/customRegisters";

export interface IScreen {
  numPlanes: number;
  width: number;              // fetch width in pixels (from DDF, 16-px granularity)
  height: number;             // number of scan lines with BPL DMA activity
  firstLine: number;          // vpos of first BPL-active scan line
  hires: boolean;             // BPLCON0 bit 15
  ham: boolean;               // BPLCON0 bit 11
}

const i16 = (v: number) => (v << 16) >> 16;

export const DMA_HPOS = 227; // slots per scan line in the DMA grid

/**
 * Derive the primary bitplane screen geometry from the DMA grid + copper trace.
 *
 * Algorithm:
 *  1. Scan the DMA grid to find the true display bounds (firstLine / lastLine).
 *     This is independent of the copper and is always correct.
 *  2. Apply copper MOVE instructions that execute *before* firstLine — giving the
 *     register state at the moment the display starts, not contaminated by mid-screen
 *     or bottom-HUD copper changes.
 *  3. Compute display width from DDFSTRT/DDFSTOP (OCS formula, no AGA FMODE).
 *
 * Rendering is intentionally decoupled: ResourcesView reads the actual DMA fetch
 * addresses from the grid for each scan line, which handles mid-screen bitplane
 * pointer resets transparently.
 */
export function buildScreenFromModel(model: IProfileModel): IScreen | undefined {
  const custom = model.dmaSnapshot?.custom;
  const copper = model.copper;
  const dma    = model.dma;
  if (!custom || !copper || !dma) return undefined;

  // ── Step 1: find display bounds from DMA grid ─────────────────────────────
  // Do this first so we can use firstLine as the copper cutoff in step 2.

  let firstLine = -1;
  let lastLine  = -1;
  const ownerLen = dma.owner.length;

  for (let i = 0; i < ownerLen; i++) {
    const o = dma.owner[i];
    if (o < BusOwner.BPL1 || o > BusOwner.BPL6) continue;
    const vpos = (i / DMA_HPOS) | 0;
    if (firstLine < 0) firstLine = vpos;
    lastLine = vpos;
  }

  if (firstLine < 0) return undefined; // no bitplane DMA — display was off

  const height = lastLine - firstLine + 1;

  // ── Step 2: init from baseline, then apply copper MOVEs before firstLine ──
  // Copper writes that happen during or after the display area are excluded —
  // they belong to a different screen region (e.g. HUD overlay, next-frame setup).

  let BPLCON0 = custom[R.BPLCON0 >> 1];
  let DDFSTRT = custom[R.DDFSTRT >> 1];
  let DDFSTOP = custom[R.DDFSTOP >> 1];

  const count = copper.addr.length;
  for (let i = 0; i < count; i++) {
    const w1 = copper.w1[i];
    if (w1 & 1) continue;                      // WAIT or SKIP
    if (copper.vpos[i] >= firstLine) continue; // only pre-display copper writes
    const da = w1 & 0x1fe;
    const rd = copper.w2[i];

    switch (da) {
      // Ignore BPLCON0 writes that turn off all planes (same heuristic as old ext.)
      case R.BPLCON0: if ((rd >>> 12) & 7) BPLCON0 = rd; break;
      case R.DDFSTRT: DDFSTRT = rd; break;
      case R.DDFSTOP: DDFSTOP = rd; break;
    }
  }

  // ── Step 3: geometry ──────────────────────────────────────────────────────

  const numPlanes = (BPLCON0 >>> 12) & 7;
  if (numPlanes === 0 || numPlanes > 6) return undefined;

  const hires = (BPLCON0 & (1 << 15)) !== 0;
  const ham   = (BPLCON0 & (1 << 11)) !== 0;

  // OCS lores/hires fetch-width formula (no AGA FMODE/large-block support)
  const ddfStart = DDFSTRT & 0xfc;
  const ddfStop  = DDFSTOP & 0xfc;
  if (ddfStart >= ddfStop) return undefined;
  const blocks = Math.floor((ddfStop - ddfStart + 7) / 8) + 1;
  const width  = blocks << (hires ? 5 : 4);

  return { numPlanes, width, height, firstLine, hires, ham };
}
