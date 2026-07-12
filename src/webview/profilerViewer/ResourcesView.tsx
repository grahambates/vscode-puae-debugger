import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BusOwner, IProfileModel } from "../../shared/profilerTypes";
import { disassembleCopperInstruction } from "../../shared/copperDisassembler";
import {
  buildLinePaletteTimeline, buildLineRegister, buildLineRegisterTimeline, buildPalette,
  buildScreenFromModel, computeBeamPosition, decodeBplcon0, DMA_HPOS, eventThresholds, expand4,
  IScreen, PaletteEvent,
} from "./gfxResources";
import { CUSTOM_REGISTER_OFFSETS as R } from "../shared/customRegisters";

interface ResourcesViewProps {
  selectedSlot: number | undefined;
  model: IProfileModel | null | undefined;
}

interface HoverInfo {
  logX: number;
  logY: number;
  vpos: number;
  rawBits: number;
  colorIdx: number;
  color: number;
  ham: boolean;
  cck: number | undefined;
  planeAddrs: (number | undefined)[];
  bplcon0: number;
  copperInstr: { w1: number; w2: number; addr: number; instrVpos: number } | undefined;
  palette: Uint32Array | undefined;
  spriteOwner: number | undefined; // which sprite (0-7) owns this pixel, if any
}

interface PixelSnapshot {
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
}

// One sprite's data for a single scan line.
interface SpriteLine {
  hstartCanvas: number; // canvas x where the sprite starts (may be negative / out of bounds)
  dataA: number;
  dataB: number;
}

// 6-bit component (HAM8's per-pixel R/G/B modify value) -> 8-bit, by bit replication.
const expand6 = (v: number) => (v << 2) | (v >> 4);

// ── Sprite register helpers ───────────────────────────────────────────────────

// SPRxPOS = 0x140 + N*8, SPRxCTL = 0x142 + N*8  (as Uint16Array indices)
const sprPosOffset = (n: number) => (0x140 + n * 8) >> 1;
const sprCtlOffset = (n: number) => (0x142 + n * 8) >> 1;

// HSTRT = SPRxPOS[7:0]<<1 | SPRxCTL[2]  (9-bit lores-pixel horizontal start)
const hstartFromRegs = (pos: number, ctl: number) =>
  ((pos & 0xff) << 1) | ((ctl >> 2) & 1);

// Sprite colour group: sprites 0/1 → palette base 17, 2/3 → 21, 4/5 → 25, 6/7 → 29.
// palette[colorBase + pixelBits - 1] for pixelBits ∈ {1,2,3} (0 = transparent).
const sprColorBase = (n: number) => 17 + (n >> 1) * 4;

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
function buildSpriteOverlay(
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

function colorToCss(c: number): string {
  const r = c & 0xff;
  const g = (c >>> 8) & 0xff;
  const b = (c >>> 16) & 0xff;
  return `rgb(${r},${g},${b})`;
}

function colorToHex(c: number): string {
  const r = (c & 0xff) >> 4;
  const g = ((c >>> 8) & 0xff) >> 4;
  const b = ((c >>> 16) & 0xff) >> 4;
  return `$${r.toString(16).toUpperCase()}${g.toString(16).toUpperCase()}${b.toString(16).toUpperCase()}`;
}

// ── On-demand hover extras ────────────────────────────────────────────────────

function computeHoverExtra(
  model: IProfileModel,
  firstLine: number,
  logY: number,
  logX: number,
  numPlanes: number,
  dup: number,
): Pick<HoverInfo, "cck" | "planeAddrs" | "bplcon0" | "copperInstr"> {
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

// ── Component ─────────────────────────────────────────────────────────────────

export function ResourcesView({ model, selectedSlot }: ResourcesViewProps) {
  const canvas   = useRef<HTMLCanvasElement>(null);
  const [scale, setScale]           = useState(2);
  const [planeVis, setPlaneVis]     = useState<boolean[]>(Array(8).fill(true)); // up to 8 planes (AGA)
  const [spriteVis, setSpriteVis]   = useState<boolean[]>(Array(8).fill(true));
  const [activeSpritesMask, setActiveSpritesMask] = useState(0);
  const [hover, setHover]           = useState<HoverInfo | null>(null);
  const [hoverClientPos, setHoverClientPos] = useState({ x: 0, y: 0 });
  const pixelSnap = useRef<PixelSnapshot | null>(null);
  const modelRef  = useRef<IProfileModel | null | undefined>(undefined);
  const screenRef = useRef<ReturnType<typeof buildScreenFromModel>>(undefined);

  const screen = useMemo(() => (model ? buildScreenFromModel(model) : undefined), [model]);

  useEffect(() => { modelRef.current = model;  }, [model]);
  useEffect(() => { screenRef.current = screen; }, [screen]);

  // Beam-position crosshair, synced to the shared timeline playhead — as the old extension's
  // resource view showed. See computeBeamPosition's doc comment for the mapping.
  const beamPos = useMemo(
    () => (selectedSlot === undefined || !screen ? undefined : computeBeamPosition(screen, selectedSlot)),
    [selectedSlot, screen],
  );

  // Reset plane visibility when the plane count changes to a new value.
  const prevNumPlanes = useRef(0);
  useEffect(() => {
    if (!screen || screen.numPlanes === prevNumPlanes.current) return;
    prevNumPlanes.current = screen.numPlanes;
    setPlaneVis(prev => // eslint-disable-line react-hooks/set-state-in-effect
      prev.slice(0, screen.numPlanes).some((v, i) => !v && i < screen.numPlanes)
        ? Array(8).fill(true)
        : prev,
    );
  }, [screen]);

  useEffect(() => {
    const cvs = canvas.current;
    if (!cvs || !screen || !model?.dma) return;

    const { numPlanes, width, height, firstLine, canvasHires, diwLeft, diwRight, diwTop, diwBottom, displayLeft } = screen;

    const baseRegs     = model.dmaSnapshot?.custom ?? new Uint16Array(256);
    const agaColors    = model.dmaSnapshot?.agaColors;
    const isAga        = !!agaColors;
    const copper       = model.copper;

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
    // Fallback word count (screen-wide blocks, recovered from width/canvasHires) for the rare
    // degenerate line where that line's own DDFSTRT/DDFSTOP momentarily don't form a valid window.
    const fallbackBlocks = canvasHires ? width >> 5 : width >> 4;

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

    cvs.width  = width  * scale;
    cvs.height = height * scale;

    const ctx     = cvs.getContext("2d")!;
    const imgData = ctx.createImageData(cvs.width, cvs.height);
    const data    = new Uint32Array(imgData.data.buffer);
    const dma     = model.dma;

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
      // hpos->canvas-x conversion displayLeft/diwLeft themselves use. Without this, a narrowed
      // *and shifted* fetch window still gets the right word count but drawn from canvas x=0,
      // i.e. shifted from where it actually belongs.
      const lineOffsetX = (lineDdfStart * 2 - displayLeft) * (canvasHires ? 2 : 1);

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

      // ── Write to canvas ────────────────────────────────────────────────
      for (let px = 0; px < width; px++) {
        const color = pixColors[y * width + px];
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            data[((y * scale + sy) * cvs.width) + (px * scale + sx)] = color;
          }
        }
      }

      linePalettesSnap[y] = palette; // already this line's own array — no clone needed
    }

    ctx.putImageData(imgData, 0, 0);
    pixelSnap.current = {
      rawBits: pixRawBits, colorIdx: pixColorIdx, colors: pixColors,
      palettes: linePalettesSnap, spriteMask: pixSprite,
      width, height, firstLine, numPlanes, lineHam: lineHamArr, lineDup,
    };
    setActiveSpritesMask(activeSpritesMask); // eslint-disable-line react-hooks/set-state-in-effect
  }, [canvas, screen, model, scale, planeVis, spriteVis]);

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const ps = pixelSnap.current;
    const m  = modelRef.current;
    const sc = screenRef.current;
    if (!ps || !m || !sc) return;
    const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    const logX = Math.floor((e.clientX - rect.left) / scale);
    const logY = Math.floor((e.clientY - rect.top)  / scale);
    if (logX < 0 || logX >= ps.width || logY < 0 || logY >= ps.height) {
      setHover(null);
      return;
    }
    const li    = logY * ps.width + logX;
    const extra = computeHoverExtra(m, ps.firstLine, logY, logX, ps.numPlanes, ps.lineDup[logY]);
    const spr   = ps.spriteMask[li];
    setHover({
      logX, logY,
      vpos:        ps.firstLine + logY,
      rawBits:     ps.rawBits[li],
      colorIdx:    ps.colorIdx[li],
      color:       ps.colors[li],
      ham:         !!ps.lineHam[logY],
      palette:     ps.palettes[logY],
      spriteOwner: spr === 0xff ? undefined : spr,
      ...extra,
    });
    setHoverClientPos({ x: e.clientX, y: e.clientY });
  }, [scale]);

  const onMouseLeave = useCallback(() => setHover(null), []);
  // `isolate` (shift-click): turn this one on and every other item in the group off, instead
  // of just flipping this one.
  const togglePlane  = useCallback((i: number, isolate = false) => {
    setPlaneVis(v => (isolate ? v.map((_, j) => j === i) : v.map((b, j) => (j === i ? !b : b))));
  }, []);
  const toggleSprite = useCallback((i: number, isolate = false) => {
    setSpriteVis(v => (isolate ? v.map((_, j) => j === i) : v.map((b, j) => (j === i ? !b : b))));
  }, []);

  if (!model?.dma) {
    return <div className="resources-empty">No DMA data available.</div>;
  }
  if (!screen) {
    return <div className="resources-empty">No bitplane display detected in this capture.</div>;
  }

  const { width, height, numPlanes, hires, ham, dpf, staticPlanes, modeChanges } = screen;
  const modeStr = modeChanges
    ? "variable mode"
    : `${numPlanes}-plane${hires ? " hires" : " lores"}${ham ? " HAM" : ""}${dpf ? " DPF" : ""}${staticPlanes ? " (7-plane trick)" : ""}`;
  const info = `${width}×${height} · ${modeStr}`;

  // "All" buttons' state is derived (not stored) — same pattern as the emulator webview's
  // channel-visibility toggles: active iff every item currently shown for this group is on.
  const allPlanesOn = planeVis.slice(0, numPlanes).every(Boolean);
  const activeSpriteIndices: number[] = [];
  for (let i = 0; i < 8; i++) if (activeSpritesMask & (1 << i)) activeSpriteIndices.push(i);
  const allSpritesOn = activeSpriteIndices.every(i => spriteVis[i]);

  // Tooltip derived display values.
  let copperText: string | undefined;
  let bplcon0Str: string | undefined;
  let palNumColors = 0;
  if (hover) {
    const bpu    = (hover.bplcon0 >>> 12) & 7;
    const isHires = !!(hover.bplcon0 & (1 << 15));
    const isHam   = !!(hover.bplcon0 & (1 << 11));
    const isDpf   = !!(hover.bplcon0 & (1 << 10));
    palNumColors = Math.min(1 << Math.max(0, Math.min(bpu, 5)), 32);
    bplcon0Str = `BPU:${bpu}  ${isHires ? "HIRES" : "LORES"}${isHam ? "  HAM" : ""}${isDpf ? "  DPF" : ""}`;
    if (hover.copperInstr) {
      const ci = hover.copperInstr;
      const d  = disassembleCopperInstruction(ci.addr, ci.w1, ci.w2);
      copperText = `${d.mnemonic} ${d.operands}  @L${ci.instrVpos}`;
    }
  }

  return (
    <div className="resources-view">
      <div className="resources-toolbar">
        <span className="resources-info">{info}</span>
        <label className="resources-scale-label">Scale</label>
        <select
          className="resources-scale-select"
          value={scale}
          onChange={(e) => setScale(Number((e.target as HTMLSelectElement).value))}
        >
          <option value="1">1×</option>
          <option value="2">2×</option>
          <option value="3">3×</option>
        </select>
        <span className="resources-bpl-label">BPL</span>
        {numPlanes > 1 && (
          <button
            className={"resources-bpl-btn resources-bpl-all" + (allPlanesOn ? " active" : "")}
            onClick={() => {
              const on = !allPlanesOn;
              setPlaneVis(v => v.map((b, j) => (j < numPlanes ? on : b)));
            }}
            title="Toggle all bitplanes"
          >
            All
          </button>
        )}
        {Array.from({ length: numPlanes }, (_, i) => (
          <button
            key={i}
            className={"resources-bpl-btn" + (planeVis[i] ? " active" : "")}
            onClick={(e) => togglePlane(i, e.shiftKey)}
            title={`${planeVis[i] ? "Hide" : "Show"} bitplane ${i + 1}${numPlanes > 1 ? " (Shift-click to isolate)" : ""}`}
          >
            {i + 1}
          </button>
        ))}
        {activeSpritesMask !== 0 && (
          <>
            <span className="resources-bpl-label">SPR</span>
            {activeSpriteIndices.length > 1 && (
              <button
                className={"resources-bpl-btn resources-bpl-all" + (allSpritesOn ? " active" : "")}
                onClick={() => {
                  const on = !allSpritesOn;
                  setSpriteVis(v => v.map((b, j) => (activeSpritesMask & (1 << j) ? on : b)));
                }}
                title="Toggle all sprites"
              >
                All
              </button>
            )}
            {activeSpriteIndices.map(i => (
              <button
                key={i}
                className={"resources-bpl-btn" + (spriteVis[i] ? " active" : "")}
                onClick={(e) => toggleSprite(i, e.shiftKey)}
                title={`${spriteVis[i] ? "Hide" : "Show"} sprite ${i}${activeSpriteIndices.length > 1 ? " (Shift-click to isolate)" : ""}`}
              >
                {i}
              </button>
            ))}
          </>
        )}
      </div>
      <div className="resources-canvas-wrap">
        <div className="resources-canvas-inner">
          <canvas
            ref={canvas}
            style={{ imageRendering: "pixelated", cursor: "crosshair" }}
            onMouseMove={onMouseMove}
            onMouseLeave={onMouseLeave}
          />
          {beamPos && (
            <>
              <div className="resources-beam-h" style={{ top: beamPos.y * scale }} />
              <div className="resources-beam-v" style={{ left: beamPos.x * scale }} />
            </>
          )}
        </div>
      </div>
      {hover && (
        <div
          className="screen-tooltip"
          style={{ left: hoverClientPos.x + 16, top: hoverClientPos.y + 16 }}
        >
          <table className="screen-tooltip-table">
            <tbody>
              <tr>
                <td className="screen-tooltip-label">Pixel</td>
                <td>{hover.logX}, {hover.logY}</td>
              </tr>
              <tr>
                <td className="screen-tooltip-label">Beam</td>
                <td>{hover.cck !== undefined ? `CCK:${hover.cck}  ` : ""}VPOS:{hover.vpos}</td>
              </tr>
              <tr>
                <td className="screen-tooltip-label">Source</td>
                <td>{hover.spriteOwner !== undefined
                  ? `Sprite ${hover.spriteOwner}`
                  : hover.rawBits === 0 ? "Background" : "Bitplane"
                }</td>
              </tr>
              <tr>
                <td className="screen-tooltip-label">Colour</td>
                <td className="screen-tooltip-color-row">
                  <span
                    className="screen-tooltip-swatch"
                    style={{ background: colorToCss(hover.color) }}
                  />
                  {hover.ham
                    ? colorToHex(hover.color)
                    : `${hover.colorIdx} ($${hover.colorIdx.toString(16).padStart(2, "0")}) · ${colorToHex(hover.color)}`
                  }
                </td>
              </tr>
              {hover.spriteOwner === undefined && (
                <tr>
                  <td className="screen-tooltip-label">Planes</td>
                  <td className="screen-tooltip-bits">
                    {Array.from({ length: numPlanes }, (_, i) => (
                      <span
                        key={i}
                        className={"screen-tooltip-bit" + ((hover.rawBits & (1 << i)) ? " on" : " off")}
                        title={`BPL${i + 1}: ${(hover.rawBits & (1 << i)) ? "1" : "0"}`}
                      >
                        {i + 1}
                      </span>
                    ))}
                  </td>
                </tr>
              )}
              {hover.planeAddrs.length > 0 && hover.spriteOwner === undefined && (
                <tr>
                  <td className="screen-tooltip-label">Addrs</td>
                  <td>
                    <div className="screen-tooltip-addrs">
                      {hover.planeAddrs.map((addr, i) => (
                        <span key={i} className="screen-tooltip-addr-item">
                          {`BPL${i + 1}: `}
                          {addr !== undefined
                            ? <span className="screen-tooltip-addr-val">{`$${addr.toString(16).toUpperCase().padStart(6, "0")}`}</span>
                            : <span className="screen-tooltip-addr-none">—</span>
                          }
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              )}
              {bplcon0Str && (
                <tr>
                  <td className="screen-tooltip-label">BPLCON0</td>
                  <td>{bplcon0Str}</td>
                </tr>
              )}
              {hover.palette && palNumColors > 0 && (
                <tr>
                  <td className="screen-tooltip-label">Palette</td>
                  <td>
                    <div className="screen-tooltip-palette">
                      {Array.from({ length: palNumColors }, (_, i) => (
                        <span
                          key={i}
                          className="screen-tooltip-palette-chip"
                          style={{ background: colorToCss(hover.palette![i]) }}
                          title={`${i}: ${colorToHex(hover.palette![i])}`}
                        />
                      ))}
                    </div>
                  </td>
                </tr>
              )}
              {copperText && (
                <tr>
                  <td className="screen-tooltip-label">Copper</td>
                  <td className="screen-tooltip-copper">{copperText}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
