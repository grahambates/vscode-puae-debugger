import { BusOwner, IProfileModel } from "../../shared/profilerTypes";
import { CUSTOM_REGISTER_OFFSETS as R } from "../shared/customRegisters";
// Pixel-decode primitives shared with the live emulator's paused-screen hover tooltip
// (puaeApp/screenHover.ts) — re-exported here so this file's existing consumers/tests are
// unaffected by the move.
import { expand4, expand6, decodeBplcon0, buildPalette } from "../../shared/gfxDecode";
export { expand4, expand6, decodeBplcon0, buildPalette };

export interface IScreen {
  numPlanes: number;   // max BPL owner index seen in the DMA grid + 1
  // Canvas pixel width/height: always PUAE's standard PAL preset (STANDARD_FB_WIDTH/HEIGHT below,
  // converted into this file's own canvas-unit convention — see those constants' doc comment),
  // not a tight crop around just the DDF-fetched/DMA-active area, so the reconstruction shows a
  // sensible border like the live emulator view rather than a razor-tight crop. displayLeft/
  // firstLine below are shifted to center the fetched content within this canvas, so every
  // existing hpos/vpos->canvas-x/y formula in this file (and ResourcesView's per-line offset/DIW
  // logic) lands in the correctly-centered coordinate space with no further changes.
  width: number;
  height: number;
  firstLine: number;   // vpos of first BPL-active scan line, shifted by the centering offset above
  hires: boolean;      // BPLCON0 at display start — may not hold for the whole frame
  // AGA-only super-hires (BPLCON0 bit 6) at display start — informational only, for the mode
  // label (see decodeBplcon0's doc comment): doesn't affect canvasHires/width/dup, so a
  // super-hires capture still reconstructs at the hires pixel grid, one canvas pixel per 2
  // actual super-hires pixels.
  shres: boolean;
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
  // DDFSTRT/DDFSTOP "blocks" (8-cck fetch units) at display start, i.e. the content-only word
  // count `width` itself would have been sized from before the standard-canvas substitution
  // below. Exists purely as a sane fallback for ResourcesView's per-line DDFSTRT/DDFSTOP
  // tracking (a specific line's own registers can momentarily fail to form a valid window) —
  // deriving a fallback from `width` directly no longer works once width is the (unrelated)
  // outer canvas size.
  blocks: number;
}

export const DMA_HPOS = 227; // slots per scan line in the DMA grid
export const DMA_VPOS = 313; // scan lines per frame in the DMA grid

// A fetched DDF word doesn't appear on-screen at its own raw DDFSTRT/DDFSTOP hpos — real hardware
// pipelines it through a fixed fetch-scheduling delay before Denise can display it. Mirrored from
// PUAE's own custom.c (the `decide_line`-adjacent DIW/DDF bookkeeping around `ddffirstword_total`):
// `int f = 8 << fetchmode; ddffirstword_total = plfstrt + f;` (`plfstrt` is DDFSTRT, already masked
// the same way `ddfStart` is here) — an 8-color-clock delay for fetch mode 0 (OCS/ECS, and AGA's
// own default fetch mode), i.e. +16 in this file's already-doubled canvas-x units; see
// fetchDelayCck below for AGA's 2x/4x fetch-mode cases. DIW_DDF_OFFSET(1) is
// a further, much smaller "pixel data spends a couple of cycles in the chips" pipeline fudge PUAE
// applies when finally converting to window-x (drawing.h). Without either, DDFSTRT-derived canvas
// positions (content position, per-line offsets) land a full DDF block short of where the display
// window (DIWSTRT/DIWSTOP) actually is — verified against a real capture where the corrected DDF
// window's edges land exactly on DIWSTRT/DIWSTOP's own canvas-x positions (129 and 449), confirming
// a normal (default-DDFSTRT/DIWSTRT) display's fetch and display windows are meant to fully overlap,
// not sit ~16px apart as the unadjusted formula implied. Previously showed up as legitimate content
// clipped off the left edge of the display window — most visible on sharp-edged content (scrolltext)
// sitting right at that boundary, but present (just imperceptible against a plain background) for
// every capture.
export const DDF_FETCH_DELAY_CCK = 8;
export const DIW_DDF_OFFSET = 1;

// AGA's fetch-mode register (FMODE, $DFF1FC) widens the DMA fetch to 2/4 words per slot for its
// 2x/4x fetch modes, which lengthens the same fetch-scheduling delay proportionally — mirrors
// PUAE's own custom.c formula exactly: `int f = 8 << fetchmode;` (fetchmode = FMODE & 3). Absent
// (reads back 0) on OCS/ECS captures, so this is a no-op — `fetchDelayCck(0) === DDF_FETCH_DELAY_CCK`
// — everywhere except an AGA capture actually using a non-zero fetch mode.
export function fetchDelayCck(fmode: number): number {
  return DDF_FETCH_DELAY_CCK << (fmode & 3);
}

// PUAE's standard (non-"extreme overscan") PAL framebuffer preset — see
// puae-wasm/libretro-uae/libretro/libretro-core.h's PUAE_VIDEO_WIDTH/PUAE_VIDEO_HEIGHT_PAL
// (== EMULATOR_DEF_WIDTH/HEIGHT, the project's own default geometry) — used as a fixed "sensible
// border" canvas size for the screen reconstruction, regardless of what the live emulator was
// actually doing at capture time. These are real digitized-output pixels, a *different* unit from
// this file's own canvas-x/canvas-y convention, so they need converting before use as width/height
// below:
//  - horizontal: this file's canvas-x is in real (hires) pixels when canvasHires, but in
//    lores-pixel units (half as many) otherwise — see IScreen.canvasHires's doc comment — so
//    STANDARD_FB_WIDTH must be halved except in the canvasHires case.
//  - vertical: canvas-y is always raw vpos units (one count per scanline, no doubling), while
//    STANDARD_FB_HEIGHT is PUAE's line-doubled broadcast-style output height, so it's always
//    halved regardless of canvasHires.
// Empirically verified against a real capture (booted demo.adf, lores Kickstart/Workbench
// screen): content width 320 canvas-units vs. STANDARD_FB_WIDTH 720 real pixels is a ~2.25x
// ratio (roughly the expected 2x conversion plus a modest genuine border), not 1x — using
// STANDARD_FB_WIDTH unconverted made the canvas ~2x too wide, matching a "huge border" bug.
const STANDARD_FB_WIDTH  = 720;
const STANDARD_FB_HEIGHT = 574;

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
  let FMODE   = custom[R.FMODE >> 1];

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
      case R.FMODE:   FMODE = rd; break;
    }
  }

  const isAga = !!model.dmaSnapshot?.agaColors;
  const { hires, shres, ham, dpf, staticPlanes } = decodeBplcon0(BPLCON0, isAga);
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

  const contentWidth       = blocks << (canvasHires ? 5 : 4);
  const contentDisplayLeft = (ddfStart + fetchDelayCck(FMODE)) * 2 + DIW_DDF_OFFSET;

  // ── DIWSTRT/DIWSTOP: the actual display window, distinct from the DDF fetch window ────────
  // Read here (ahead of the canvas-centering step below, which now needs it) rather than after.
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

  // ── Canvas sizing: PUAE's standard PAL preset, not a tight crop around the fetched content ──
  // See STANDARD_FB_WIDTH/HEIGHT's doc comment for the pixel-unit conversion. Centers the UNION of
  // the fetched content AND the real display window (DIW) within the standard-sized canvas — NOT
  // just the content alone. DIW is an independent clip against the same beam-position counter DDF
  // uses (see the DIW comment above) and can be wider than, narrower than, or off-center relative
  // to whatever DDF actually fetches. Centering on content alone let DIW's real (correctly
  // computed) edges land outside [0, finalWidth) whenever DIW extended further than DDF's own
  // span — silently clamped away by diwLeft/diwRight's Math.max/min below, e.g. a full-width DIW
  // with a narrower, off-center DDF reported a badly wrong (clamped) DIW extent even though the
  // content pixels themselves were always positioned correctly. Reduces to the original
  // content-only centering whenever DIW's span already sits inside content's (the common case,
  // and every capture this was originally verified against) — see gfxResources.test.ts.
  const finalWidth  = STANDARD_FB_WIDTH  / (canvasHires ? 1 : 2);
  const finalHeight = STANDARD_FB_HEIGHT / 2;
  const mult = canvasHires ? 2 : 1;
  // DIW's span, in the same "canvas-x units relative to content's own x=0" space as contentWidth
  // — i.e. through the exact same (x - contentDisplayLeft) * mult step canvas-x always uses, just
  // anchored at content's (not yet known) final origin instead.
  const diwStartRelContent = (diwHStart - contentDisplayLeft) * mult;
  const diwEndRelContent   = (diwHStop  - contentDisplayLeft) * mult;
  const diwStartRelContentY = diwVStart - firstLine;
  const diwEndRelContentY   = diwVStop  - firstLine;
  const unionStartX = Math.min(0, diwStartRelContent);
  const unionEndX   = Math.max(contentWidth, diwEndRelContent);
  const unionStartY = Math.min(0, diwStartRelContentY);
  const unionEndY   = Math.max(height, diwEndRelContentY);
  const offsetX = Math.floor((finalWidth  - (unionEndX - unionStartX)) / 2) - unionStartX;
  const offsetY = Math.floor((finalHeight - (unionEndY - unionStartY)) / 2) - unionStartY;
  const finalDisplayLeft = contentDisplayLeft - offsetX / mult;
  const finalFirstLine   = firstLine - offsetY;

  const diwLeft  = Math.max(0, Math.min(finalWidth, (diwHStart - finalDisplayLeft) * mult));
  const diwRight = Math.max(0, Math.min(finalWidth, (diwHStop  - finalDisplayLeft) * mult));
  const diwTop    = Math.max(finalFirstLine, Math.min(finalFirstLine + finalHeight, diwVStart));
  const diwBottom = Math.max(finalFirstLine, Math.min(finalFirstLine + finalHeight, diwVStop));

  return {
    numPlanes, hires, shres, ham, dpf, staticPlanes, canvasHires, modeChanges, blocks,
    width: finalWidth, height: finalHeight, firstLine: finalFirstLine, displayLeft: finalDisplayLeft,
    diwLeft, diwRight, diwTop, diwBottom,
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

/**
 * The inverse of computeBeamPosition: maps a clicked canvas pixel back to a (local, within-frame)
 * DMA slot, so clicking the screen view can jump the shared timeline playhead there — the same
 * canvas_x = (hpos*2 - displayLeft) * (canvasHires ? 2 : 1) relationship, solved for hpos. Result is
 * clamped into [0, DMA_HPOS/DMA_VPOS) — a click near the canvas edge (border/centering padding)
 * still resolves to *some* valid slot in that scan line/column rather than an out-of-range one.
 */
export function computeSlotFromBeamPosition(screen: IScreen, canvasX: number, canvasY: number): number {
  const vpos = Math.max(0, Math.min(DMA_VPOS - 1, canvasY + screen.firstLine));
  const loresX = canvasX / (screen.canvasHires ? 2 : 1) + screen.displayLeft;
  const hpos = Math.max(0, Math.min(DMA_HPOS - 1, Math.round(loresX / 2)));
  return vpos * DMA_HPOS + hpos;
}

// ── Per-line/per-pixel register tracking ────────────────────────────────────────
// Pure helpers the render loop (ResourcesView) uses to reconstruct custom-register state at
// exact copper timing. Kept here (rather than in the .tsx) so they're unit-testable without a
// JSX-capable test transform — jest's ts-jest config only handles plain .ts.

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

export interface ILineMode {
  numPlanes: number;
  hires: boolean;
  shres: boolean;
  ham: boolean;
  dpf: boolean;
  staticPlanes: boolean;
  width: number; // real displayed pixels (DIW HSTART..HSTOP, doubled if hires) — not the canvas width
}

// The bitplane mode + display-window width actually in effect at a given DMA slot's scanline —
// for the Screen tab's info line, which used to report the *canvas's* fixed border size and a
// single frame-wide mode label, misleading whenever a copper split changes plane count/resolution/
// DIW partway down the frame (see IScreen.modeChanges's doc comment). Reuses buildLineRegister with
// a 1-line window: `firstLine=vpos, height=1` resolves to "baseline + every write strictly before
// vpos" then applies vpos's own writes on top — the exact same "a mid-line write affects that
// write's whole line" convention already used for the full-frame per-line arrays (lineBplcon0Raw
// etc. in decodeScreenPixels), just evaluated at one line instead of building an array for all of
// them (this is only ever needed for one line at a time, to back a label).
//
// DIWSTRT/DIWSTOP pack HSTART/HSTOP *and* VSTART/VSTOP into the same two registers, so a mid-frame
// write to them (a real, if uncommon, demo trick for resizing the display window mid-frame) also
// carries new vertical fields — but re-deriving "vertical extent" doesn't make sense per scanline
// (a single line has no height), so height is deliberately NOT recomputed here: callers should keep
// using the whole-frame screen.diwBottom-diwTop for that, and only substitute this width/mode.
export function computeLineMode(model: IProfileModel, slot: number): ILineMode | undefined {
  const custom = model.dmaSnapshot?.custom;
  const copper = model.copper;
  if (!custom || !copper) return undefined;

  const frameSlots = DMA_HPOS * DMA_VPOS;
  const vpos = Math.floor((slot % frameSlots) / DMA_HPOS);
  const isAga = !!model.dmaSnapshot?.agaColors;

  // Same "ignore a transient zero-BPU (blanking) write" convention as buildScreenFromModel's
  // initial-state scan and decodeScreenPixels' lineBplcon0Raw.
  const bplcon0 = buildLineRegister(custom, copper, vpos, 1, R.BPLCON0, v => ((v >>> 12) & 7) !== 0)[0];
  const { numPlanes, hires, shres, ham, dpf, staticPlanes } = decodeBplcon0(bplcon0, isAga);

  const diwstrt = buildLineRegister(custom, copper, vpos, 1, R.DIWSTRT)[0];
  const diwstop = buildLineRegister(custom, copper, vpos, 1, R.DIWSTOP)[0];
  const hstart = diwstrt & 0xff;
  const hstop  = (diwstop & 0xff) + 256; // HSTOP's own hardware-documented wraparound, see buildScreenFromModel
  const width  = Math.max(0, hstop - hstart) * (hires ? 2 : 1);

  return { numPlanes, hires, shres, ham, dpf, staticPlanes, width };
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

// ── Sprite overlay (per-sprite, per-scanline pixel data) ────────────────────────────────────
// Shared by ResourcesView.tsx's canvas render and puaeApp/screenHover.ts's live paused-screen
// tooltip (via decodeScreenPixels below), so both composite sprites identically.

export interface SpriteLine {
  hstartCanvas: number; // canvas x where the sprite starts (may be negative / out of bounds)
  dataA: number;
  dataB: number;
}

// SPRxPOS = 0x140 + N*8, SPRxCTL = 0x142 + N*8  (as Uint16Array indices)
const sprPosOffset = (n: number) => (0x140 + n * 8) >> 1;
const sprCtlOffset = (n: number) => (0x142 + n * 8) >> 1;
const hstartFromRegs = (pos: number, ctl: number) =>
  ((pos & 0xff) << 1) | ((ctl >> 2) & 1);

// Sprite colour group: sprites 0/1 → palette base 17, 2/3 → 21, 4/5 → 25, 6/7 → 29.
// palette[colorBase + pixelBits - 1] for pixelBits ∈ {1,2,3} (0 = transparent).
export const sprColorBase = (n: number) => 17 + (n >> 1) * 4;

/**
 * Build per-sprite, per-relative-scan-line pixel data for the visible screen.
 *
 * HSTRT derivation: scan vpos 0..firstLine-1 for the first SPRITE_N DMA pair.
 * After the copper resets SPRxPT during VBL the sprite DMA reads SPRxPOS/SPRxCTL
 * from chip RAM immediately (at ~vpos 11-25, before the display area). These
 * are the true control words for the current frame's activation, unaffected by
 * any end-of-sprite terminator that may have zeroed the snapshot register.
 *
 * The copper's per-line SPRxPOS/SPRxCTL writes are replayed on top of that
 * initial HSTRT (same pattern as palette tracking) for games that reposition
 * sprites mid-frame via the copper.
 *
 * Display-area DMA slots are treated as pixel data. A VSTOP line that falls
 * within the display area will produce a single garbage row (the next-frame
 * control word interpreted as pixel data); that is acceptable without a full
 * VSTRT/VSTOP state machine.
 */
export function buildSpriteOverlay(
  model: IProfileModel,
  screen: IScreen,
): SpriteLine[][] {
  const { firstLine, height, canvasHires, displayLeft } = screen;
  const dma    = model.dma!;
  const copper = model.copper;
  const custom = model.dmaSnapshot?.custom ?? new Uint16Array(256);

  // --- Phase 1: find initial HSTRT from pre-display-area control-word reads ---
  //
  // After the copper resets SPRxPT during VBL, the sprite DMA immediately reads
  // the control-word pair (SPRxPOS / SPRxCTL) from chip RAM. That read happens
  // on the very next sprite-DMA slot, typically vpos 11-25 — well before firstLine.
  // Scanning those slots gives us the correct HSTRT even when the post-frame
  // snapshot holds 0 (because the end-of-sprite terminator was the last thing read).

  const curPos = new Uint16Array(8);
  const curCtl = new Uint16Array(8);
  const foundPre = new Uint8Array(8); // 1 = control words found before firstLine

  {
    const preVals = new Uint16Array(16);
    const preCnt  = new Uint8Array(8);

    for (let vpos = 0; vpos < firstLine; vpos++) {
      preCnt.fill(0);
      const lineBase = vpos * DMA_HPOS;
      for (let hpos = 0; hpos < DMA_HPOS; hpos++) {
        const idx = lineBase + hpos;
        if (idx >= dma.owner.length) break;
        const o = dma.owner[idx];
        if (o < BusOwner.SPRITE0 || o > BusOwner.SPRITE7) continue;
        const n = o - BusOwner.SPRITE0;
        if (!foundPre[n] && preCnt[n] < 2) preVals[n * 2 + preCnt[n]++] = dma.value[idx];
      }
      for (let n = 0; n < 8; n++) {
        if (!foundPre[n] && preCnt[n] >= 2) {
          // First pair before display area = SPRxPOS / SPRxCTL control words.
          curPos[n] = preVals[n * 2];
          curCtl[n] = preVals[n * 2 + 1];
          foundPre[n] = 1;
        }
      }
    }
    // Fallback for sprites with no pre-firstLine DMA slot (unusual, e.g. copper
    // writes SPRxPOS directly without SPRxPT, or firstLine is very early).
    for (let n = 0; n < 8; n++) {
      if (!foundPre[n]) {
        curPos[n] = custom[sprPosOffset(n)];
        curCtl[n] = custom[sprCtlOffset(n)];
      }
    }
  }

  // Collect copper writes per sprite, grouped by vpos.
  // Each entry: { isPos: true|false, val } — we track pos and ctl independently.
  type SprWrite = { isPos: boolean; val: number };
  const writesByVpos = new Map<number, SprWrite[][]>(); // Map<vpos, [sprite0writes, sprite1writes, ...]>
  if (copper) {
    for (let i = 0; i < copper.addr.length; i++) {
      const w1 = copper.w1[i];
      if (w1 & 1) continue;
      const da = w1 & 0x1fe;
      for (let n = 0; n < 8; n++) {
        const isPos = da === 0x140 + n * 8;
        const isCtl = da === 0x142 + n * 8;
        if (!isPos && !isCtl) continue;
        const vp = copper.vpos[i];
        let slot = writesByVpos.get(vp);
        if (!slot) { slot = Array.from({ length: 8 }, () => []); writesByVpos.set(vp, slot); }
        slot[n].push({ isPos, val: copper.w2[i] });
      }
    }
  }
  const sortedVpos = [...writesByVpos.keys()].sort((a, b) => a - b);

  // --- DMA scan over visible lines ---

  const overlay: SpriteLine[][] = Array.from({ length: 8 }, () => []);
  const vals   = new Uint16Array(16); // [spriteN*2 + 0/1]
  const valCnt = new Uint8Array(8);
  let copperVposPtr = 0;

  for (let y = 0; y < height; y++) {
    const vpos = firstLine + y;

    // Apply copper moves at or before this vpos.
    while (copperVposPtr < sortedVpos.length && sortedVpos[copperVposPtr] <= vpos) {
      const slot = writesByVpos.get(sortedVpos[copperVposPtr])!;
      for (let n = 0; n < 8; n++) {
        for (const w of slot[n]) {
          if (w.isPos) curPos[n] = w.val;
          else         curCtl[n] = w.val;
        }
      }
      copperVposPtr++;
    }

    // Collect sprite DMA values for this line.
    valCnt.fill(0);
    const lineBase = vpos * DMA_HPOS;
    for (let hpos = 0; hpos < DMA_HPOS; hpos++) {
      const idx = lineBase + hpos;
      if (idx >= dma.owner.length) break;
      const o = dma.owner[idx];
      if (o < BusOwner.SPRITE0 || o > BusOwner.SPRITE7) continue;
      const n = o - BusOwner.SPRITE0;
      if (valCnt[n] < 2) vals[n * 2 + valCnt[n]++] = dma.value[idx];
    }

    // Record any sprite that has 2 DMA words on this visible line.
    for (let n = 0; n < 8; n++) {
      if (valCnt[n] < 2) continue;
      const hs = hstartFromRegs(curPos[n], curCtl[n]);
      overlay[n][y] = {
        hstartCanvas: (hs - displayLeft) * (canvasHires ? 2 : 1),
        dataA: vals[n * 2],
        dataB: vals[n * 2 + 1],
      };
    }
  }

  return overlay;
}

// ── Full-frame pixel decode (bitplane + sprite composite) ───────────────────────────────────

export interface PixelSnapshot {
  rawBits:    Uint8Array;
  colorIdx:   Uint8Array;
  colors:     Uint32Array;
  palettes:   Uint32Array[];
  spriteMask: Uint8Array; // per-pixel: 0xff = no sprite, else sprite index (0-7)
  width: number;
  height: number;
  firstLine: number;
  numPlanes: number;
  lineHam: Uint8Array; // per-scanline HAM state (BPLCON0 can change mid-frame)
  lineDup: Uint8Array; // per-scanline canvas-column duplication factor (1 or 2, see canvasHires)
  activeSpritesMask: number; // which sprites (0-7) have any visible data in the display area
}

// Decodes every pixel of the reconstructed screen (bitplane colour/HAM/DPF + sprite compositing)
// — shared by ResourcesView.tsx's canvas render and puaeApp/screenHover.ts's live paused-screen
// tooltip, so both read the exact same decode for the exact same underlying DMA/copper state
// instead of two independently-written (and potentially divergent) implementations. Everything
// below is unchanged from ResourcesView.tsx's own render effect, just without the final
// canvas-specific "write to ImageData" step — callers that need pixels on screen do that
// themselves from the returned `colors` array (see ResourcesView.tsx).
export function decodeScreenPixels(
  model: IProfileModel,
  screen: IScreen,
  planeVis: boolean[] = Array(8).fill(true),
  spriteVis: boolean[] = Array(8).fill(true),
): PixelSnapshot | undefined {
  if (!model.dma) return undefined;
  const { numPlanes, width, height, firstLine, canvasHires, diwLeft, diwRight, diwTop, diwBottom, displayLeft } = screen;

  const baseRegs     = model.dmaSnapshot?.custom ?? new Uint16Array(256);
  const agaColors    = model.dmaSnapshot?.agaColors;
  const isAga        = !!agaColors;
  const copper       = model.copper;
  const dma          = model.dma;

  // Registers below are tracked with *sub-scanline* precision (buildLineRegisterTimeline /
  // buildLinePaletteTimeline): `.start[y]` is the value at the start of line y, and
  // `.events[y]` are that same line's own copper writes, replayed against the pixel loop's own
  // timing (eventThresholds) — copper moves can and frequently do happen mid-line with exact
  // horizontal timing (rainbow colour bars being the classic example), so a single value per
  // line isn't accurate enough for these. BPLCON0 is the one exception, tracked per-line only
  // (via the simpler buildLineRegister below): it drives numPlanes/hires/dup/word-count, and
  // splitting the canvas geometry itself mid-line is out of scope, so a mid-line BPLCON0 write
  // affects that write's *whole* line rather than just the pixels after it — a known
  // approximation, but preserves the far more common "WAIT vpos,hpos≈0; MOVE BPLCON0" per-line
  // split working exactly as before.
  const paletteTimeline = copper
    ? buildLinePaletteTimeline(baseRegs, copper, firstLine, height, agaColors)
    : { start: Array.from({ length: height }, () => buildPalette(baseRegs, agaColors)), events: [] as PaletteEvent[][] };
  const bplcon1Timeline = copper
    ? buildLineRegisterTimeline(baseRegs, copper, firstLine, height, R.BPLCON1)
    : { start: Array.from({ length: height }, () => baseRegs[R.BPLCON1 >> 1]), events: [] as { hpos: number; val: number }[][] };
  const bplcon2Timeline = copper
    ? buildLineRegisterTimeline(baseRegs, copper, firstLine, height, R.BPLCON2)
    : { start: Array.from({ length: height }, () => baseRegs[R.BPLCON2 >> 1]), events: [] as { hpos: number; val: number }[][] };

  // Per-line BPLCON0: numPlanes/hires/ham/dpf can all change mid-frame via a copper split
  // (e.g. a HAM picture with a normal-mode status bar, or a plane-count reduction partway
  // down). Zero-BPU writes are ignored — same "not a real mode change" convention
  // buildScreenFromModel's initial-state scan uses (see decodeBplcon0's doc comment).
  const lineBplcon0Raw: number[] = copper
    ? buildLineRegister(baseRegs, copper, firstLine, height, R.BPLCON0, v => ((v >>> 12) & 7) !== 0)
    : Array.from({ length: height }, () => baseRegs[R.BPLCON0 >> 1]);

  // Per-line DDFSTRT/DDFSTOP: a copper split that changes plane count (e.g. into the 7-plane
  // trick) commonly narrows the fetch window at the same time, to save DMA bandwidth once
  // fewer planes need it. screen.width/blocks are sized from the *initial* DDFSTRT/DDFSTOP —
  // using that same (now stale) word count for a line whose real DDFSTRT has since changed
  // desyncs `marginWords` below (fetchWords.length - nominal goes negative, corrupting the
  // first word of every such line) — catastrophic for HAM specifically, since it's extremely
  // sensitive to control/data-bit alignment. Tracked at line granularity only, same as
  // BPLCON0 — a mid-line DDFSTRT change is exotic and not handled.
  const lineDdfstrtRaw: number[] = copper
    ? buildLineRegister(baseRegs, copper, firstLine, height, R.DDFSTRT)
    : Array.from({ length: height }, () => baseRegs[R.DDFSTRT >> 1]);
  const lineDdfstopRaw: number[] = copper
    ? buildLineRegister(baseRegs, copper, firstLine, height, R.DDFSTOP)
    : Array.from({ length: height }, () => baseRegs[R.DDFSTOP >> 1]);
  // Per-line FMODE (AGA only; reads back 0 on OCS/ECS) — see fetchDelayCck's doc comment. Tracked
  // at the same line granularity as DDFSTRT/DDFSTOP, since a copper split that changes fetch mode
  // commonly changes the fetch window at the same time.
  const lineFmodeRaw: number[] = copper
    ? buildLineRegister(baseRegs, copper, firstLine, height, R.FMODE)
    : Array.from({ length: height }, () => baseRegs[R.FMODE >> 1]);
  // Fallback word count for the rare degenerate line where that line's own DDFSTRT/DDFSTOP
  // momentarily don't form a valid window. screen.blocks is the *content*-only word count
  // (width itself may now be PUAE's own, unrelated, live framebuffer size — see IScreen.width).
  const fallbackBlocks = screen.blocks;

  // OCS/ECS 7-plane trick: planes 5/6 (0-based 4/5) aren't DMA-fetched — Denise holds
  // BPL5DAT/BPL6DAT static instead, so track their value (with the same mid-line precision as
  // above — the control word is sometimes changed partway down a line too). Tracked whenever
  // the chipset can even use the trick (non-AGA), not gated on the initial screen.staticPlanes,
  // so a mid-frame transition into the trick still has data to read.
  const emptyTimeline = { start: [] as number[], events: [] as { hpos: number; val: number }[][] };
  const bpl5Timeline = !isAga
    ? (copper
        ? buildLineRegisterTimeline(baseRegs, copper, firstLine, height, R.BPL5DAT)
        : { start: Array.from({ length: height }, () => baseRegs[R.BPL5DAT >> 1]), events: [] as { hpos: number; val: number }[][] })
    : emptyTimeline;
  const bpl6Timeline = !isAga
    ? (copper
        ? buildLineRegisterTimeline(baseRegs, copper, firstLine, height, R.BPL6DAT)
        : { start: Array.from({ length: height }, () => baseRegs[R.BPL6DAT >> 1]), events: [] as { hpos: number; val: number }[][] })
    : emptyTimeline;

  // Sprite overlay: per-sprite, per-relative-y line data.
  const spriteOverlay = (model.copper || model.dmaSnapshot)
    ? buildSpriteOverlay(model, screen)
    : Array.from({ length: 8 }, () => [] as SpriteLine[]);

  // Which sprites have any visible data in the display area (for toolbar).
  const activeSpritesMask = spriteOverlay.reduce(
    (mask, lines, n) => lines.length > 0 ? mask | (1 << n) : mask, 0
  );

  const pixRawBits  = new Uint8Array(width * height);
  const pixColorIdx = new Uint8Array(width * height);
  const pixColors   = new Uint32Array(width * height);
  const pixSprite   = new Uint8Array(width * height).fill(0xff); // 0xff = no sprite
  const lineDup     = new Uint8Array(height); // per-line canvas-column duplication factor (hover mapping)
  const lineHamArr  = new Uint8Array(height); // per-line HAM state (hover "Colour" row format)
  // End-of-line palette snapshot per line, for the hover "Palette" swatch row — loses mid-line
  // precision (a hovered pixel under a colour-bar split shows the line's *final* palette, not
  // the one active at that exact x), an acceptable simplification for a debug-only display.
  const linePalettesSnap: Uint32Array[] = new Array(height);

  for (let y = 0; y < height; y++) {
    const vpos     = firstLine + y;
    const lineBase = vpos * DMA_HPOS;
    // DDF (fetch) commonly fetches more than DIW (display) actually shows — see diwLeft's doc
    // comment on IScreen. Pixels outside the display window paint as background, below.
    const lineInDiw = vpos >= diwTop && vpos < diwBottom;

    const { numPlanes: lnPlanes, hires: lnHires, ham: lnHam, dpf: lnDpf, staticPlanes: lnStatic } =
      decodeBplcon0(lineBplcon0Raw[y], isAga);
    // A lores line rendered into a canvasHires canvas draws each fetched bit into 2 columns;
    // everything else (a hires line, or a whole-lores-frame canvas) draws 1:1.
    const dup = canvasHires && !lnHires ? 2 : 1;
    lineDup[y]    = dup;
    lineHamArr[y] = lnHam ? 1 : 0;
    // Nominal fetched-word count for this line's own resolution and this line's own DDFSTRT/
    // DDFSTOP (see the tracking comment above) — sized so dup*16*lineRowWords covers this
    // line's real fetch window, whether or not that matches the screen-wide canvas width.
    const lineDdfStart = lineDdfstrtRaw[y] & 0xfc;
    const lineDdfStop  = lineDdfstopRaw[y] & 0xfc;
    const lineBlocks = lineDdfStart < lineDdfStop
      ? Math.floor((lineDdfStop - lineDdfStart + 7) / 8) + 1
      : fallbackBlocks;
    const lineRowWords = lineBlocks * (canvasHires && lnHires ? 2 : 1);
    // This line's fetch can start at a different hpos than the screen-wide displayLeft
    // reference (the same DDFSTRT split that changes lineRowWords above commonly also moves
    // the start point) — offset this line's output into canvas-x accordingly, the same
    // hpos->canvas-x conversion displayLeft/diwLeft themselves use (including the fetch-
    // scheduling delay — see DDF_FETCH_DELAY_CCK's doc comment in gfxResources.ts). Without
    // this, a narrowed *and shifted* fetch window still gets the right word count but drawn
    // from canvas x=0, i.e. shifted from where it actually belongs.
    const lineDdfCanvasX = (lineDdfStart + fetchDelayCck(lineFmodeRaw[y])) * 2 + DIW_DDF_OFFSET;
    const lineOffsetX = (lineDdfCanvasX - displayLeft) * (canvasHires ? 2 : 1);

    // ── Bitplane data ──────────────────────────────────────────────────
    // 7-plane trick: planes 4/5 (0-based) aren't DMA-fetched at all, so don't bother scanning
    // for them — they're filled from the static per-line register value below instead.
    const dmaPlanes = lnStatic ? Math.min(lnPlanes, 4) : lnPlanes;
    const fetchWords: number[][] = Array.from({ length: dmaPlanes }, () => []);
    // hpos of each fetched word for plane 0 (in fetch order) — the real, captured timing this
    // line's mid-scanline register events get positioned against (see eventThresholds).
    const wordHpos: number[] = [];
    for (let hpos = 0; hpos < DMA_HPOS; hpos++) {
      const idx = lineBase + hpos;
      if (idx >= dma.owner.length) break;
      const o = dma.owner[idx];
      if (o < BusOwner.BPL1 || o > BusOwner.BPL8) continue;
      const pIdx = o - BusOwner.BPL1;
      if (pIdx < dmaPlanes) {
        fetchWords[pIdx].push(dma.value[idx]);
        if (pIdx === 0) wordHpos.push(hpos);
      }
    }

    // Live register state for this line, seeded from the start-of-line value and advanced to
    // the mid-line events' exact position as the pixel loop below crosses their threshold.
    const palette = paletteTimeline.start[y]; // mutable working copy, safe to write into
    const paletteEvents = paletteTimeline.events[y] ?? [];
    const paletteThresh = eventThresholds(paletteEvents, wordHpos);
    let evPal = 0;

    let curBplcon1 = bplcon1Timeline.start[y];
    const bplcon1Events = bplcon1Timeline.events[y] ?? [];
    const bplcon1Thresh = eventThresholds(bplcon1Events, wordHpos);
    let evB1 = 0;

    let curBplcon2 = bplcon2Timeline.start[y];
    const bplcon2Events = bplcon2Timeline.events[y] ?? [];
    const bplcon2Thresh = eventThresholds(bplcon2Events, wordHpos);
    let evB2 = 0;

    let curBpl5 = bpl5Timeline.start[y] ?? 0;
    const bpl5Events = bpl5Timeline.events[y] ?? [];
    const bpl5Thresh = eventThresholds(bpl5Events, wordHpos);
    let evB5 = 0;

    let curBpl6 = bpl6Timeline.start[y] ?? 0;
    const bpl6Events = bpl6Timeline.events[y] ?? [];
    const bpl6Thresh = eventThresholds(bpl6Events, wordHpos);
    let evB6 = 0;

    // Extra words actually fetched beyond the nominal window, per plane — the scroll margin a
    // scrolling display's wider DDFSTRT provides. 0 for a non-scrolling line/plane, matching
    // the pre-scroll-support behaviour exactly.
    const marginWords = new Array<number>(dmaPlanes);
    for (let p = 0; p < dmaPlanes; p++) marginWords[p] = fetchWords[p].length - lineRowWords;

    let prevColor = palette[0];
    const totalBits = lineRowWords * 16;

    for (let i = 0; i < totalBits; i++) {
      // Apply any mid-line register writes whose effect starts at or before this pixel —
      // exact copper timing for e.g. rainbow palette bars within a single scanline.
      while (evPal < paletteEvents.length && paletteThresh[evPal] <= i) {
        const ev = paletteEvents[evPal]; palette[ev.colreg] = ev.rgba; evPal++;
      }
      while (evB1 < bplcon1Events.length && bplcon1Thresh[evB1] <= i) { curBplcon1 = bplcon1Events[evB1].val; evB1++; }
      while (evB2 < bplcon2Events.length && bplcon2Thresh[evB2] <= i) { curBplcon2 = bplcon2Events[evB2].val; evB2++; }
      while (evB5 < bpl5Events.length   && bpl5Thresh[evB5]   <= i) { curBpl5   = bpl5Events[evB5].val;   evB5++; }
      while (evB6 < bpl6Events.length   && bpl6Thresh[evB6]   <= i) { curBpl6   = bpl6Events[evB6].val;   evB6++; }
      const pf1h = curBplcon1 & 0xf;
      const pf2h = (curBplcon1 >> 4) & 0xf;

      let rawPixel = 0;
      for (let p = 0; p < lnPlanes; p++) {
        let bitVal = 0;
        // Odd bitplane index (BPL2/4/6/8, 1-based) -> PF2H; even (BPL1/3/5/7) -> PF1H. Scroll
        // is a *display-timing* delay Denise applies uniformly to every bitplane's shift-out —
        // it doesn't care whether that plane's holding register came from DMA or is held
        // statically (the 7-plane trick) — so BPL5/BPL6 need it exactly like any other plane,
        // just against their repeating 16-bit word instead of a fetched one. Skipping it here
        // was a real bug: on lines where scroll is active the static (unshifted) control bits
        // desync from the (shifted) data bits by however many pixels the scroll delay is,
        // producing HAM speckling on exactly those lines.
        const scroll = (p % 2 === 0) ? pf1h : pf2h;
        if (lnStatic && p === 4) {
          bitVal = (curBpl5 >> (15 - ((i - scroll) & 15))) & 1;
        } else if (lnStatic && p === 5) {
          bitVal = (curBpl6 >> (15 - ((i - scroll) & 15))) & 1;
        } else if (p < dmaPlanes) {
          const srcBit = marginWords[p] * 16 + i - scroll;
          if (srcBit >= 0) {
            const w = fetchWords[p][srcBit >> 4] ?? 0;
            bitVal = (w >> (15 - (srcBit & 15))) & 1;
          }
        }
        if (bitVal) rawPixel |= 1 << p;
      }
      let pixel = 0;
      for (let p = 0; p < lnPlanes; p++) {
        if (planeVis[p] && (rawPixel & (1 << p))) pixel |= 1 << p;
      }

      let color: number;
      let effectiveIdx: number;

      if (lnHam && lnPlanes === 6) {
        const mode = pixel >> 4;
        const val  = pixel & 0xf;
        const exp  = expand4(val);
        switch (mode) {
          case 0: color = palette[val]; effectiveIdx = val; break;
          case 1: color = (prevColor & ~0x00ff0000) | (exp << 16); effectiveIdx = pixel; break;
          case 2: color = (prevColor & ~0x000000ff) | exp;          effectiveIdx = pixel; break;
          case 3: color = (prevColor & ~0x0000ff00) | (exp << 8);   effectiveIdx = pixel; break;
          default: color = prevColor; effectiveIdx = pixel;
        }
        prevColor = color;
      } else if (lnHam && lnPlanes === 8) {
        // AGA HAM8: top 2 of the 8 plane bits select the mode, the low 6 bits carry either
        // a direct (low-bank) palette index (mode 0) or a 6-bit new component value (modes
        // 1-3) — same structure as HAM6 above, just 6-bit fields instead of 4-bit ones.
        const mode = pixel >> 6;
        const val  = pixel & 0x3f;
        const exp  = expand6(val);
        switch (mode) {
          case 0: color = palette[val]; effectiveIdx = val; break;
          case 1: color = (prevColor & ~0x00ff0000) | (exp << 16); effectiveIdx = pixel; break;
          case 2: color = (prevColor & ~0x000000ff) | exp;          effectiveIdx = pixel; break;
          case 3: color = (prevColor & ~0x0000ff00) | (exp << 8);   effectiveIdx = pixel; break;
          default: color = prevColor; effectiveIdx = pixel;
        }
        prevColor = color;
      } else if (lnDpf) {
        // Dual playfield: odd planes → PF1, even planes → PF2.
        // PF1 index uses bits 0,2,4 of pixel; PF2 uses bits 1,3,5.
        // NOTE: only verified for OCS/ECS's up-to-6-plane DPF (3 planes/playfield, the
        // hardware-fixed +8 palette offset below). AGA can in principle run DPF with more
        // planes, but the wider-DPF palette-indexing convention isn't confirmed here, so
        // planes 7/8 are simply not read by this branch (bits 6/7 of `pixel` are ignored) —
        // graceful degradation (those planes' data is dropped) rather than a guessed-at,
        // possibly-wrong decode.
        const pf1Idx = (pixel & 1) | (((pixel >> 2) & 1) << 1) | (((pixel >> 4) & 1) << 2);
        const pf2Idx = ((pixel >> 1) & 1) | (((pixel >> 3) & 1) << 1) | (((pixel >> 5) & 1) << 2);
        const pf2pri = (curBplcon2 >> 6) & 1;
        if (pf2pri) {
          if (pf2Idx !== 0)      { effectiveIdx = 8 + pf2Idx; color = palette[8 + pf2Idx]; }
          else if (pf1Idx !== 0) { effectiveIdx = pf1Idx;      color = palette[pf1Idx]; }
          else                   { effectiveIdx = 0;            color = palette[0]; }
        } else {
          if (pf1Idx !== 0)      { effectiveIdx = pf1Idx;      color = palette[pf1Idx]; }
          else if (pf2Idx !== 0) { effectiveIdx = 8 + pf2Idx; color = palette[8 + pf2Idx]; }
          else                   { effectiveIdx = 0;            color = palette[0]; }
        }
      } else {
        effectiveIdx = pixel & ((1 << lnPlanes) - 1);
        color = palette[effectiveIdx] ?? palette[0];
      }

      const outXBase = lineOffsetX + i * dup;
      for (let d = 0; d < dup; d++) {
        const px = outXBase + d;
        if (px < 0 || px >= width) continue;
        const li = y * width + px;
        // Outside the display window: real hardware shows the border (palette[0]) here, not
        // this fetched bit — decode continues normally above so HAM/scroll state stays correct
        // for when the line re-enters the window, but the *displayed* pixel is background.
        const inDiw = lineInDiw && px >= diwLeft && px < diwRight;
        pixRawBits[li]  = rawPixel;
        pixColorIdx[li] = inDiw ? effectiveIdx : 0;
        pixColors[li]   = inDiw ? color : palette[0];
      }
    }

    // This line's own DDFSTRT/DDFSTOP can produce a fetch window narrower than, and/or shifted
    // from, the screen-wide canvas (e.g. a split that narrows/moves the window for a
    // plane-count change) — paint any columns outside [lineOffsetX, lineOffsetX+totalBits*dup)
    // as background rather than leaving them at the typed array's zero-initialised (fully
    // transparent) default.
    const lineDecodedStart = Math.max(0, lineOffsetX);
    const lineDecodedEnd   = Math.min(width, lineOffsetX + totalBits * dup);
    for (let px = 0; px < lineDecodedStart; px++) {
      const li = y * width + px;
      pixColorIdx[li] = 0;
      pixColors[li]   = palette[0];
    }
    for (let px = lineDecodedEnd; px < width; px++) {
      const li = y * width + px;
      pixColorIdx[li] = 0;
      pixColors[li]   = palette[0];
    }

    // ── Sprite composite with BPLCON2 priority ────────────────────────
    // Single playfield: PF1P (bits 2:0) = sprite pairs in front of PF1.
    // Dual playfield:   PF1P and PF2P (bits 5:3) guard each playfield;
    //   PF2PRI (bit 6) selects which is "front" and which is "back".
    //   Priority chain: sprites(pair<frontPFP) > frontPF
    //                   > sprites(frontPFP≤pair<backPFP) > backPF
    //                   > sprites(pair≥backPFP)
    // In DPF mode, effectiveIdx 1-7 = front-PF pixel, 8-15 = back-PF pixel,
    // 0 = both transparent — so we derive each PF's opacity from pixColorIdx.
    // Uses curBplcon2's final (end-of-line) value: sprites are composited in a separate pass
    // after the whole line's bitplane pixels are decided, so a mid-line BPLCON2 change (rare)
    // only affects sprite priority/colour for this whole line, not just the pixels after it —
    // the same approximation BPLCON0 makes, see this effect's opening comment.
    const bplcon2  = curBplcon2;
    const pf1p     = bplcon2 & 0x7;
    const pf2p     = (bplcon2 >> 3) & 0x7;
    const pf2pri   = (bplcon2 >> 6) & 1;
    // Front/back PFP for the priority chain (only matters in DPF).
    const frontPFP = lnDpf ? (pf2pri ? pf2p : pf1p) : pf1p;
    const backPFP  = lnDpf ? (pf2pri ? pf1p : pf2p) : 0;

    for (let n = 7; n >= 0; n--) { // lower-numbered sprites drawn last → higher priority
      if (!(activeSpritesMask & (1 << n))) continue;
      if (!spriteVis[n]) continue;
      const sl = spriteOverlay[n][y];
      if (!sl) continue;

      const pair = n >> 1;
      const { hstartCanvas, dataA, dataB } = sl;
      const colorBase = sprColorBase(n);
      let a = dataA, b = dataB;

      for (let bit = 0; bit < 16; bit++) {
        const sprPixel = ((a >>> 15) & 1) | (((b >>> 15) & 1) << 1);
        a = (a << 1) & 0xffff;
        b = (b << 1) & 0xffff;
        if (sprPixel === 0) continue; // transparent

        // Sprite dot width follows the canvas's own resolution convention, not this line's —
        // sprites don't track BPLCON0's HIRES bit the way bitplane data does (see
        // canvasHires's doc comment in gfxResources.ts).
        const pxBase = hstartCanvas + bit * (canvasHires ? 2 : 1);
        const colorsToSet = canvasHires ? 2 : 1;
        for (let dx = 0; dx < colorsToSet; dx++) {
          const px = pxBase + dx;
          if (px < 0 || px >= width) continue;
          const li = y * width + px;

          // Priority check: sprites in front of frontPFP always draw.
          if (pair >= frontPFP) {
            const ci = pixColorIdx[li];
            if (lnDpf) {
              // Front PF is opaque when ci is in its color range (1-7 or 8-15).
              const frontOpaque = pf2pri ? ci >= 8 : (ci !== 0 && ci <= 7);
              if (pair < backPFP) {
                // Between front and back playfield.
                if (frontOpaque) continue;
              } else {
                // Behind both playfields.
                if (frontOpaque || ci !== 0) continue;
              }
            } else {
              if (ci !== 0) continue; // behind PF1, only draw when transparent
            }
          }

          pixColors[li] = palette[colorBase + sprPixel - 1];
          pixSprite[li] = n;
        }
      }
    }

    linePalettesSnap[y] = palette; // already this line's own array — no clone needed
  }

  return {
    rawBits: pixRawBits, colorIdx: pixColorIdx, colors: pixColors,
    palettes: linePalettesSnap, spriteMask: pixSprite,
    width, height, firstLine, numPlanes, lineHam: lineHamArr, lineDup,
    activeSpritesMask,
  };
}

// ── Hover lookup (per-pixel extra info: plane addresses, BPLCON0, last copper instruction) ──

export interface HoverExtra {
  cck: number | undefined;
  planeAddrs: (number | undefined)[];
  bplcon0: number;
  copperInstr: { w1: number; w2: number; addr: number; instrVpos: number } | undefined;
}

// On-demand hover extras for a reconstructed-screen pixel: which colour-clock/plane addresses
// fed this column, BPLCON0 as of this line, and the last copper instruction executed at or
// before it. Shared by ResourcesView.tsx's own hover tooltip and puaeApp/screenHover.ts's live
// paused-screen tooltip.
export function computeHoverExtra(
  model: IProfileModel,
  firstLine: number,
  logY: number,
  logX: number,
  numPlanes: number,
  dup: number,
): HoverExtra {
  const dma    = model.dma!;
  const copper = model.copper;
  const custom = model.dmaSnapshot?.custom ?? new Uint16Array(256);
  const vpos   = firstLine + logY;
  // Best-effort word index: accounts for this line's resolution (dup), but not any BPLCON1
  // scroll offset in effect — a scrolled line's reported plane address may be one word off.
  const wx     = Math.floor(logX / dup) >> 4;

  const lineBase   = vpos * DMA_HPOS;
  const wordCounts = new Array(numPlanes).fill(0);
  const planeAddrs: (number | undefined)[] = new Array(numPlanes).fill(undefined);
  let cck: number | undefined;

  for (let hpos = 0; hpos < DMA_HPOS; hpos++) {
    const idx = lineBase + hpos;
    if (idx >= dma.owner.length) break;
    const o = dma.owner[idx];
    if (o < BusOwner.BPL1 || o > BusOwner.BPL8) continue;
    const pIdx = o - BusOwner.BPL1;
    if (pIdx >= numPlanes) continue;
    const wi = wordCounts[pIdx]++;
    if (wi === wx) {
      planeAddrs[pIdx] = dma.addr[idx];
      if (pIdx === 0 && cck === undefined) cck = hpos;
    }
  }

  let bplcon0    = custom[R.BPLCON0 >> 1];
  let lastInstrIdx = -1;

  if (copper) {
    for (let i = 0; i < copper.addr.length; i++) {
      const vp = copper.vpos[i];
      if (vp > vpos) break;
      lastInstrIdx = i;
      const w1 = copper.w1[i];
      if (w1 & 1) continue;
      if ((w1 & 0x1fe) === R.BPLCON0) {
        const val = copper.w2[i];
        if ((val >>> 12) & 7) bplcon0 = val;
      }
    }
  }

  const copperInstr = copper && lastInstrIdx >= 0 ? {
    w1: copper.w1[lastInstrIdx],
    w2: copper.w2[lastInstrIdx],
    addr: copper.addr[lastInstrIdx],
    instrVpos: copper.vpos[lastInstrIdx],
  } : undefined;

  return { cck, planeAddrs, bplcon0, copperInstr };
}
