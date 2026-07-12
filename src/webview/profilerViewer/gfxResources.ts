import { BusOwner, IProfileModel } from "../../shared/profilerTypes";
import { CUSTOM_REGISTER_OFFSETS as R } from "../shared/customRegisters";

export interface IScreen {
  numPlanes: number;   // max BPL owner index seen in the DMA grid + 1
  width: number;       // canvas pixel width, sized for the highest resolution used anywhere
                        // in the display area (see canvasHires below)
  height: number;      // number of scan lines with BPL DMA activity
  firstLine: number;   // vpos of first BPL-active scan line
  hires: boolean;      // BPLCON0 at display start — may not hold for the whole frame
  ham: boolean;        // BPLCON0 at display start — may not hold for the whole frame
  dpf: boolean;        // BPLCON0[10] — dual playfield at display start
  // True for the OCS/ECS "7-plane trick" (BPLCON0 BPU field == 7 on a non-AGA capture):
  // Agnus only DMA-fetches 4 bitplanes, but Denise still decodes a 6-bit-wide pixel (typically
  // HAM6), with planes 5/6 held static from BPL5DAT/BPL6DAT instead of being DMA-driven. When
  // set, numPlanes is forced to 6 and the reconstruction sources planes 4/5 (0-based) from
  // buildLineRegister(BPL5DAT/BPL6DAT) rather than the DMA grid. Never set for AGA captures,
  // where a BPU field of 7 is a literal (DMA-fetched) 7-plane mode.
  staticPlanes: boolean;
  // True if hires is set anywhere in the display area (at firstLine, or via a later copper
  // BPLCON0 write). Distinct from `hires` (the *initial* state, still used for the mode label):
  // this instead picks the canvas's pixel-unit convention — the finer of the two resolutions
  // actually used, so a mid-frame hires split never needs more columns than the canvas has.
  // A lores line rendered into a canvasHires canvas draws each fetched bit into 2 columns
  // (mirroring the existing hires?2:1 sprite-pixel-doubling pattern); a hires line draws 1:1.
  // All canvas-unit coordinate conversions (this width formula, computeBeamPosition, sprite
  // HSTRT->canvas mapping) key off this, not `hires`.
  canvasHires: boolean;
  // True when the copper writes BPLCON0 during the display area. When set the
  // info label should say "variable" rather than reporting a single mode, because
  // numPlanes / hires / ham may be different in different parts of the screen.
  modeChanges: boolean;
  // Lores pixel position of canvas x=0 within the full horizontal line.
  // Used to map sprite HSTRT register values (lores pixel units) to canvas coords:
  //   canvas_x = (hstart - displayLeft) * (canvasHires ? 2 : 1)
  displayLeft: number;
  // DIWSTRT/DIWSTOP (the display window Denise actually shows bitplane data in), at display
  // start. DIW is an *independent* clip against the same raw beam-position counter DDFSTRT/
  // DDFSTOP use for fetch timing — not nested inside or scaled relative to it, and can be
  // larger or smaller than the fetched area in either dimension. Columns/lines outside
  // [diwLeft,diwRight)/[diwTop,diwBottom) were never actually displayed on real hardware
  // (regardless of whether bitplane data was fetched there), and the render loop paints them as
  // background (palette[0]) rather than showing the raw fetched bits. diwLeft/diwRight are
  // canvas-x (clamped to [0,width]); diwTop/diwBottom are *absolute* vpos (same space as
  // firstLine, clamped to [firstLine, firstLine+height]) — not canvas-y. Both verified against a
  // real capture (vpos bounds against independently-DMA-grid-derived firstLine/height; canvas-x
  // bounds by cross-referencing PUAE's own calcdiw() in custom.c, see buildScreenFromModel's
  // comment). Sprites aren't clipped by any of this — they're a separate hardware unit not gated
  // by DIW.
  diwLeft: number;
  diwRight: number;
  diwTop: number;
  diwBottom: number;
}

// Decodes the mode-relevant bits of a BPLCON0 value in isolation — shared by the initial-state
// computation below and by ResourcesView's per-line BPLCON0 tracking, so both interpret the
// register identically (including the OCS/ECS 7-plane trick). `numPlanes` here is read directly
// off the BPU field (bpu, or 6 for the 7-plane trick) — NOT the DMA-grid-derived value
// buildScreenFromModel's IScreen.numPlanes uses for buffer sizing; callers that need "how many
// planes does *this* BPLCON0 value describe" (e.g. per-line decode) want this one.
export function decodeBplcon0(bplcon0: number, isAga: boolean): {
  numPlanes: number; hires: boolean; ham: boolean; dpf: boolean; staticPlanes: boolean;
} {
  const hires = (bplcon0 & (1 << 15)) !== 0;
  const ham   = (bplcon0 & (1 << 11)) !== 0;
  const dpf   = (bplcon0 & (1 << 10)) !== 0;
  const bpu   = (bplcon0 >> 12) & 7;
  // See IScreen.staticPlanes's doc comment for the hardware background.
  const staticPlanes = bpu === 7 && !isAga;
  const numPlanes = staticPlanes ? 6 : bpu;
  return { numPlanes, hires, ham, dpf, staticPlanes };
}

export const DMA_HPOS = 227; // slots per scan line in the DMA grid
export const DMA_VPOS = 313; // scan lines per frame in the DMA grid

/**
 * Derive screen geometry from the DMA grid + copper trace.
 *
 * - Display bounds (firstLine / lastLine / height): always from the DMA grid.
 * - numPlanes: highest BPL owner seen anywhere in the DMA grid, so copper splits
 *   that add planes later in the frame don't cause us to allocate too few arrays.
 * - hires / ham / dpf: copper state at firstLine (the initial display setup) — used for the
 *   mode label; the render loop tracks these per-line itself (see ResourcesView's
 *   buildLineBplcon0) so mid-frame copper changes still decode correctly.
 * - canvasHires / width: canvasHires is true if hires is set anywhere in the display area
 *   (not just at firstLine), so a mid-frame hires split always fits the canvas; width is sized
 *   from it.
 *   modeChanges is set when the copper writes BPLCON0 inside the display area so
 *   callers can flag that hires/ham/dpf/numPlanes aren't constant across the whole image.
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
    if (o < BusOwner.BPL1 || o > BusOwner.BPL8) continue;
    const pIdx = o - BusOwner.BPL1; // 0-7 (AGA: up to 8 bitplanes)
    const vpos = (i / DMA_HPOS) | 0;
    if (firstLine < 0) firstLine = vpos;
    lastLine   = vpos;
    if (pIdx > maxPlaneIdx) maxPlaneIdx = pIdx;
  }

  if (firstLine < 0) return undefined; // no bitplane DMA — display was off

  const height = lastLine - firstLine + 1;
  let numPlanes = maxPlaneIdx + 1;

  // ── Step 2: copper state at display start ─────────────────────────────────
  // Apply only copper MOVEs that execute before firstLine so we get the register
  // values in effect when the display area begins.

  let BPLCON0 = custom[R.BPLCON0 >> 1];
  let DDFSTRT = custom[R.DDFSTRT >> 1];
  let DDFSTOP = custom[R.DDFSTOP >> 1];
  let DIWSTRT = custom[R.DIWSTRT >> 1];
  let DIWSTOP = custom[R.DIWSTOP >> 1];

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
      case R.DIWSTRT: DIWSTRT = rd; break;
      case R.DIWSTOP: DIWSTOP = rd; break;
    }
  }

  const isAga = !!model.dmaSnapshot?.agaColors;
  const { hires, ham, dpf, staticPlanes } = decodeBplcon0(BPLCON0, isAga);
  if (staticPlanes) numPlanes = 6;

  const ddfStart = DDFSTRT & 0xfc;
  const ddfStop  = DDFSTOP & 0xfc;
  if (ddfStart >= ddfStop) return undefined;
  const blocks = Math.floor((ddfStop - ddfStart + 7) / 8) + 1;

  // ── Step 3: detect mid-display BPLCON0 changes ───────────────────────────
  // If the copper writes BPLCON0 during the display area, the mode (hires/ham/
  // numPlanes) isn't constant and the info label should say so. Also determines
  // canvasHires: true if hires is set anywhere in the display area, not just at firstLine.

  let modeChanges = false;
  let canvasHires = hires;
  for (let i = 0; i < count; i++) {
    const w1 = copper.w1[i];
    if (w1 & 1) continue;
    const vp = copper.vpos[i];
    if (vp < firstLine) continue;
    if (vp > lastLine)  break;
    if ((w1 & 0x1fe) === R.BPLCON0) {
      modeChanges = true;
      if (copper.w2[i] & (1 << 15)) canvasHires = true;
    }
  }

  const width = blocks << (canvasHires ? 5 : 4);
  const displayLeft = ddfStart * 2;

  // ── DIWSTRT/DIWSTOP: the actual display window, distinct from the DDF fetch window ────────
  // Vertical (VSTART/VSTOP) is in vpos-native units, no conversion needed. VSTOP's
  // hardware-documented wraparound rule: if its top bit is set (128-255) use it directly, else
  // the display extends past line 255, so add 256 (e.g. a typical PAL DIWSTOP byte of 0x2C/44,
  // bit7 clear, means actual VSTOP = 300) — cross-checked against a real capture's independently
  // DMA-grid-derived firstLine/height and matched exactly.
  //
  // Horizontal (HSTART/HSTOP): DIW is an *independent* clip against the same raw beam-position
  // counter DDFSTRT/DDFSTOP use — it isn't nested inside or scaled relative to the fetch window,
  // so HSTART/HSTOP convert to canvas-x via the exact same hpos->canvas-x step displayLeft
  // itself uses (raw byte, no extra doubling). HSTOP alone (never HSTART) gets a further
  // hardware-documented "+256, in this same pre-doubled unit" extension — mirrored from
  // PUAE's own calcdiw() (custom.c): `hstop |= 0x100 << 2` unconditionally unless the extended
  // DIWHIGH register was written on ECS Denise/AGA, which this project doesn't track (DIWHIGH is
  // rare in practice) — exactly the same shape as the VSTOP wraparound below, just horizontal.
  // Verified against a real capture/screenshot: without it HSTOP badly under-reached, cropping
  // away most of the picture from the right.
  const diwHStart = DIWSTRT & 0xff;
  const diwHStop  = (DIWSTOP & 0xff) + 256;
  const diwVStart = (DIWSTRT >> 8) & 0xff;
  const diwVStopByte = (DIWSTOP >> 8) & 0xff;
  const diwVStop = diwVStopByte & 0x80 ? diwVStopByte : diwVStopByte + 256;

  const diwLeft  = Math.max(0, Math.min(width, (diwHStart - displayLeft) * (canvasHires ? 2 : 1)));
  const diwRight = Math.max(0, Math.min(width, (diwHStop  - displayLeft) * (canvasHires ? 2 : 1)));
  const diwTop    = Math.max(firstLine, Math.min(firstLine + height, diwVStart));
  const diwBottom = Math.max(firstLine, Math.min(firstLine + height, diwVStop));

  return {
    numPlanes, width, height, firstLine, hires, ham, dpf, staticPlanes, canvasHires, modeChanges,
    displayLeft, diwLeft, diwRight, diwTop, diwBottom,
  };
}

/**
 * Maps a shared-playhead DMA slot to a canvas pixel position within a rendered IScreen, for the
 * beam-position crosshair — as the old extension's resource view showed, synced to the timeline.
 *
 * `slot % (DMA_HPOS * DMA_VPOS)` handles multi-frame combined mode, where the shared selectedSlot
 * spans N × frameSlots (a no-op when already within a single frame — same simplification
 * CopperView's own playhead sync uses for the same reason).
 *
 * hpos (CCK) -> lores-pixel-x -> canvas-x reuses the proven HSTRT sprite-positioning formula
 * (see displayLeft's own doc comment above): canvas_x = (x - displayLeft) * (canvasHires ? 2 : 1),
 * with hpos*2 converting CCK to lores-pixel units (matching HSTRT's own "9-bit lores-pixel"
 * convention and ddfStart*2 above).
 *
 * Clamped into the visible bitplane rect [0,width)x[0,height) — a beam position in vblank/border
 * (outside the DMA-active area this IScreen covers) snaps to the nearest edge rather than being
 * omitted, so the indicator is always visible somewhere while scrubbing.
 */
export function computeBeamPosition(screen: IScreen, slot: number): { x: number; y: number } {
  const frameSlots = DMA_HPOS * DMA_VPOS;
  const localSlot = slot % frameSlots;
  const vpos = Math.floor(localSlot / DMA_HPOS);
  const hpos = localSlot % DMA_HPOS;
  const loresX = hpos * 2;
  const canvasX = (loresX - screen.displayLeft) * (screen.canvasHires ? 2 : 1);
  const canvasY = vpos - screen.firstLine;
  return {
    x: Math.max(0, Math.min(screen.width - 1, canvasX)),
    y: Math.max(0, Math.min(screen.height - 1, canvasY)),
  };
}

// ── Per-line/per-pixel register tracking ────────────────────────────────────────
// Pure helpers the render loop (ResourcesView) uses to reconstruct custom-register state at
// exact copper timing. Kept here (rather than in the .tsx) so they're unit-testable without a
// JSX-capable test transform — jest's ts-jest config only handles plain .ts.

export const expand4 = (v: number) => v * 0x11;

// `agaColors`, when present, is AGA's full 256-entry, already-24-bit-per-channel palette
// (see DmaSnapshot.agaColors's doc comment) — already fully reconstructed C-side (BPLCON3
// LOCT/bank-select applied), so this just repacks each 0x00RRGGBB entry into the canvas-ready
// 0xAABBGGRR (RGBA byte order) format the rest of this file uses. Falls back to the OCS/ECS
// COLOR00-31 window (32 entries, 4-bit-per-channel) when absent (non-AGA capture).
export function buildPalette(regs: Uint16Array, agaColors?: Uint32Array): Uint32Array {
  if (agaColors) {
    const pal = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      const v = agaColors[i];
      const r = (v >> 16) & 0xff, g = (v >> 8) & 0xff, b = v & 0xff;
      pal[i] = 0xff000000 | (b << 16) | (g << 8) | r;
    }
    return pal;
  }
  const pal = new Uint32Array(32);
  for (let i = 0; i < 32; i++) {
    const raw = regs[(R.COLOR00 + i * 2) >> 1];
    const r = expand4((raw >> 8) & 0xf);
    const g = expand4((raw >> 4) & 0xf);
    const b = expand4(raw & 0xf);
    pal[i] = 0xff000000 | (b << 16) | (g << 8) | r;
  }
  return pal;
}

// Tracks a single custom register's value across the display area, seeded from the capture-start
// snapshot and updated by copper MOVEs to that register (last write per vpos wins). Used only for
// BPLCON0: it drives numPlanes/hires/dup/word-count, and splitting the canvas geometry itself
// mid-line is out of scope (see buildLineRegisterTimeline below for every other register), so a
// mid-line BPLCON0 write affects that write's *whole* line rather than just the pixels after it —
// a known approximation, chosen because it preserves the far more common
// "WAIT vpos,hpos≈0; MOVE BPLCON0" per-line split working exactly as expected.
// `accept`, when given, filters which write values are allowed to update the tracked state —
// used to ignore transient zero-BPU (blanking) writes, matching the same convention
// buildScreenFromModel's initial-state scan uses.
export function buildLineRegister(
  baseRegs: Uint16Array,
  copper: NonNullable<IProfileModel["copper"]>,
  firstLine: number,
  height: number,
  regOffset: number,
  accept: (val: number) => boolean = () => true,
): number[] {
  let cur = baseRegs[regOffset >> 1];
  const writesByVpos = new Map<number, number>();
  for (let i = 0; i < copper.addr.length; i++) {
    const w1 = copper.w1[i];
    if (w1 & 1) continue;
    if ((w1 & 0x1fe) !== regOffset) continue;
    const val = copper.w2[i];
    if (!accept(val)) continue;
    writesByVpos.set(copper.vpos[i], val);
  }
  const sortedVpos = [...writesByVpos.keys()].sort((a, b) => a - b);
  let vposPtr = 0;
  // Apply writes before the display area.
  while (vposPtr < sortedVpos.length && sortedVpos[vposPtr] < firstLine) {
    cur = writesByVpos.get(sortedVpos[vposPtr++])!;
  }
  return Array.from({ length: height }, (_, y) => {
    const vpos = firstLine + y;
    while (vposPtr < sortedVpos.length && sortedVpos[vposPtr] <= vpos) {
      cur = writesByVpos.get(sortedVpos[vposPtr++])!;
    }
    return cur;
  });
}

// Tracks a single custom register's value with *sub-scanline* precision: `start[y]` is the value
// in effect at the very beginning of line y (hpos=0, i.e. excluding that line's own writes), and
// `events[y]` is that line's own writes, each carrying the hpos (color clock) it executed at —
// still in copper execution order, since the trace already is. Callers that need exact
// mid-line timing (copper bars changing a register several times across one scanline — a very
// common effect, e.g. horizontal-split palette/scroll/priority changes) replay `events[y]`
// against the pixel-decode loop's own per-word timing (see `eventThresholds`); callers that only
// need "the value for this whole line" can ignore `events` and just use `start[y]`.
export function buildLineRegisterTimeline(
  baseRegs: Uint16Array,
  copper: NonNullable<IProfileModel["copper"]>,
  firstLine: number,
  height: number,
  regOffset: number,
): { start: number[]; events: { hpos: number; val: number }[][] } {
  let cur = baseRegs[regOffset >> 1];
  const start: number[] = new Array(height);
  const events: { hpos: number; val: number }[][] = Array.from({ length: height }, () => []);
  let i = 0;
  for (let y = 0; y < height; y++) {
    const vpos = firstLine + y;
    while (i < copper.addr.length && copper.vpos[i] < vpos) {
      const w1 = copper.w1[i];
      if (!(w1 & 1) && (w1 & 0x1fe) === regOffset) cur = copper.w2[i];
      i++;
    }
    start[y] = cur;
    while (i < copper.addr.length && copper.vpos[i] === vpos) {
      const w1 = copper.w1[i];
      if (!(w1 & 1) && (w1 & 0x1fe) === regOffset) {
        cur = copper.w2[i];
        events[y].push({ hpos: copper.hpos[i], val: cur });
      }
      i++;
    }
  }
  return { start, events };
}

// Given a line's mid-scanline register-write events (hpos-ordered) and that same line's
// per-fetched-word hpos (`wordHpos[wx]`, built alongside `fetchWords` during the render loop's DMA
// scan), converts each event's hpos into the pixel-decode loop's own `i` (fetched-bit index)
// domain: the first word-boundary at or after the write's hpos, i.e. "this write's effect starts
// visible from the next fetched word onward" — deliberately reusing the DMA grid's own captured
// timing rather than re-deriving a color-clock-to-pixel formula, so it's exactly consistent with
// however `fetchWords`/`i` ended up indexed for this line, whatever that mapping actually is.
export function eventThresholds(events: { hpos: number }[], wordHpos: number[]): number[] {
  return events.map(ev => {
    let wx = 0;
    while (wx < wordHpos.length && wordHpos[wx] <= ev.hpos) wx++;
    return wx * 16;
  });
}

export interface PaletteEvent { hpos: number; colreg: number; rgba: number; }

// Palette counterpart of buildLineRegisterTimeline — COLORxx is 32 (OCS/ECS) or up to 256 (AGA,
// bank-selected via BPLCON3) separate registers rather than one, so each event carries which
// palette slot it targets and its fully-resolved RGBA (AGA's bank/LOCT-nibble logic already
// applied, mirroring custom.c's own AGA COLORxx write handler exactly).
export function buildLinePaletteTimeline(
  baseRegs: Uint16Array,
  copper: NonNullable<IProfileModel["copper"]>,
  firstLine: number,
  height: number,
  agaColors?: Uint32Array,
): { start: Uint32Array[]; events: PaletteEvent[][] } {
  const COLOR_BASE = R.COLOR00;
  const cur = buildPalette(baseRegs, agaColors); // mutated in place as we advance through the trace

  const run = (applyOne: (i: number) => PaletteEvent | undefined) => {
    const start: Uint32Array[] = new Array(height);
    const events: PaletteEvent[][] = Array.from({ length: height }, () => []);
    let i = 0;
    for (let y = 0; y < height; y++) {
      const vpos = firstLine + y;
      while (i < copper.addr.length && copper.vpos[i] < vpos) { applyOne(i); i++; }
      start[y] = new Uint32Array(cur);
      while (i < copper.addr.length && copper.vpos[i] === vpos) {
        const ev = applyOne(i);
        if (ev) events[y].push(ev);
        i++;
      }
    }
    return { start, events };
  };

  if (agaColors) {
    const chR = new Uint8Array(256), chG = new Uint8Array(256), chB = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      chR[i] = (agaColors[i] >> 16) & 0xff;
      chG[i] = (agaColors[i] >> 8) & 0xff;
      chB[i] = agaColors[i] & 0xff;
    }
    let bplcon3 = baseRegs[R.BPLCON3 >> 1];
    return run((i): PaletteEvent | undefined => {
      const w1 = copper.w1[i];
      if (w1 & 1) return undefined;
      const da = w1 & 0x1fe;
      if (da === R.BPLCON3) { bplcon3 = copper.w2[i]; return undefined; }
      if (da < COLOR_BASE || da > COLOR_BASE + 62) return undefined;
      const ci = (da - COLOR_BASE) >> 1;
      const colreg = ((bplcon3 >> 13) & 7) * 32 + ci;
      const val = copper.w2[i];
      const r4 = (val >> 8) & 0xf, g4 = (val >> 4) & 0xf, b4 = val & 0xf;
      if (bplcon3 & 0x200) { // LOCT: refine the low nibble only
        chR[colreg] = (chR[colreg] & 0xf0) | r4;
        chG[colreg] = (chG[colreg] & 0xf0) | g4;
        chB[colreg] = (chB[colreg] & 0xf0) | b4;
      } else { // both nibbles at once
        chR[colreg] = expand4(r4);
        chG[colreg] = expand4(g4);
        chB[colreg] = expand4(b4);
      }
      const rgba = 0xff000000 | (chB[colreg] << 16) | (chG[colreg] << 8) | chR[colreg];
      cur[colreg] = rgba;
      return { hpos: copper.hpos[i], colreg, rgba };
    });
  }

  return run((i): PaletteEvent | undefined => {
    const w1 = copper.w1[i];
    if (w1 & 1) return undefined;
    const da = w1 & 0x1fe;
    if (da < COLOR_BASE || da > COLOR_BASE + 62) return undefined;
    const ci = (da - COLOR_BASE) >> 1;
    const val = copper.w2[i];
    const rgba = 0xff000000
      | (expand4(val & 0xf) << 16) | (expand4((val >> 4) & 0xf) << 8) | expand4((val >> 8) & 0xf);
    cur[ci] = rgba;
    return { hpos: copper.hpos[i], colreg: ci, rgba };
  });
}
