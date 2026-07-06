import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BusOwner, IProfileModel } from "../../shared/profilerTypes";
import { disassembleCopperInstruction } from "../../shared/copperDisassembler";
import { buildScreenFromModel, DMA_HPOS, IScreen } from "./gfxResources";
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
  ham: boolean;
}

// One sprite's data for a single scan line.
interface SpriteLine {
  hstartCanvas: number; // canvas x where the sprite starts (may be negative / out of bounds)
  dataA: number;
  dataB: number;
}

const expand4 = (v: number) => v * 0x11;

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
  const { firstLine, height, hires, displayLeft } = screen;
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
        hstartCanvas: (hs - displayLeft) * (hires ? 2 : 1),
        dataA: vals[n * 2],
        dataB: vals[n * 2 + 1],
      };
    }
  }

  return overlay;
}

// ── Palette helpers ───────────────────────────────────────────────────────────

function buildPalette(regs: Uint16Array): Uint32Array {
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

function buildLineBplcon2(
  baseRegs: Uint16Array,
  copper: NonNullable<IProfileModel["copper"]>,
  firstLine: number,
  height: number,
): number[] {
  let cur = baseRegs[R.BPLCON2 >> 1];
  // Collect copper BPLCON2 writes per vpos (last write per vpos wins).
  const writesByVpos = new Map<number, number>();
  for (let i = 0; i < copper.addr.length; i++) {
    const w1 = copper.w1[i];
    if (w1 & 1) continue;
    if ((w1 & 0x1fe) !== R.BPLCON2) continue;
    writesByVpos.set(copper.vpos[i], copper.w2[i]);
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

function buildLinePalettes(
  baseRegs: Uint16Array,
  copper: NonNullable<IProfileModel["copper"]>,
  firstLine: number,
  height: number,
): Uint32Array[] {
  const cur = buildPalette(baseRegs);
  const COLOR_BASE = R.COLOR00;
  const writesByVpos = new Map<number, Array<[number, number]>>();
  for (let i = 0; i < copper.addr.length; i++) {
    const w1 = copper.w1[i];
    if (w1 & 1) continue;
    const da = w1 & 0x1fe;
    if (da < COLOR_BASE || da > COLOR_BASE + 62) continue;
    const ci = (da - COLOR_BASE) >> 1;
    const vp = copper.vpos[i];
    const slot = writesByVpos.get(vp);
    if (slot) slot.push([ci, copper.w2[i]]);
    else writesByVpos.set(vp, [[ci, copper.w2[i]]]);
  }
  const sortedVpos = [...writesByVpos.keys()].sort((a, b) => a - b);
  let vposPtr = 0;
  return Array.from({ length: height }, (_, y) => {
    const vpos = firstLine + y;
    while (vposPtr < sortedVpos.length && sortedVpos[vposPtr] <= vpos) {
      for (const [ci, val] of writesByVpos.get(sortedVpos[vposPtr])!) {
        const r = expand4((val >> 8) & 0xf);
        const g = expand4((val >> 4) & 0xf);
        const b = expand4(val & 0xf);
        cur[ci] = 0xff000000 | (b << 16) | (g << 8) | r;
      }
      vposPtr++;
    }
    return new Uint32Array(cur);
  });
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
): Pick<HoverInfo, "cck" | "planeAddrs" | "bplcon0" | "copperInstr"> {
  const dma    = model.dma!;
  const copper = model.copper;
  const custom = model.dmaSnapshot?.custom ?? new Uint16Array(256);
  const vpos   = firstLine + logY;
  const wx     = logX >> 4;

  const lineBase   = vpos * DMA_HPOS;
  const wordCounts = new Array(numPlanes).fill(0);
  const planeAddrs: (number | undefined)[] = new Array(numPlanes).fill(undefined);
  let cck: number | undefined;

  for (let hpos = 0; hpos < DMA_HPOS; hpos++) {
    const idx = lineBase + hpos;
    if (idx >= dma.owner.length) break;
    const o = dma.owner[idx];
    if (o < BusOwner.BPL1 || o > BusOwner.BPL6) continue;
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

export function ResourcesView({ model }: ResourcesViewProps) {
  const canvas   = useRef<HTMLCanvasElement>(null);
  const [scale, setScale]           = useState(2);
  const [planeVis, setPlaneVis]     = useState<boolean[]>(Array(6).fill(true));
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

  // Reset plane visibility when the plane count changes to a new value.
  const prevNumPlanes = useRef(0);
  useEffect(() => {
    if (!screen || screen.numPlanes === prevNumPlanes.current) return;
    prevNumPlanes.current = screen.numPlanes;
    setPlaneVis(prev => // eslint-disable-line react-hooks/set-state-in-effect
      prev.slice(0, screen.numPlanes).some((v, i) => !v && i < screen.numPlanes)
        ? Array(6).fill(true)
        : prev,
    );
  }, [screen]);

  useEffect(() => {
    const cvs = canvas.current;
    if (!cvs || !screen || !model?.dma) return;

    const { numPlanes, width, height, firstLine, ham, hires, dpf } = screen;
    const rowWords = width >> 4;

    const baseRegs     = model.dmaSnapshot?.custom ?? new Uint16Array(256);
    const linePalettes: Uint32Array[] = model.copper
      ? buildLinePalettes(baseRegs, model.copper, firstLine, height)
      : Array.from({ length: height }, () => buildPalette(baseRegs));

    const lineBplcon2: number[] = model.copper
      ? buildLineBplcon2(baseRegs, model.copper, firstLine, height)
      : Array.from({ length: height }, () => baseRegs[R.BPLCON2 >> 1]);

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

    for (let y = 0; y < height; y++) {
      const palette  = linePalettes[y];
      const vpos     = firstLine + y;
      const lineBase = vpos * DMA_HPOS;

      // ── Bitplane data ──────────────────────────────────────────────────
      const fetchWords: number[][] = Array.from({ length: numPlanes }, () => []);
      for (let hpos = 0; hpos < DMA_HPOS; hpos++) {
        const idx = lineBase + hpos;
        if (idx >= dma.owner.length) break;
        const o = dma.owner[idx];
        if (o < BusOwner.BPL1 || o > BusOwner.BPL6) continue;
        const pIdx = o - BusOwner.BPL1;
        if (pIdx < numPlanes) fetchWords[pIdx].push(dma.value[idx]);
      }

      let prevColor = palette[0];

      for (let wx = 0; wx < rowWords; wx++) {
        const words = new Array<number>(numPlanes).fill(0);
        for (let p = 0; p < numPlanes; p++) words[p] = fetchWords[p][wx] ?? 0;

        for (let bit = 0; bit < 16; bit++) {
          let rawPixel = 0;
          for (let p = 0; p < numPlanes; p++) {
            if (words[p] & (1 << (15 - bit))) rawPixel |= 1 << p;
          }
          let pixel = 0;
          for (let p = 0; p < numPlanes; p++) {
            if (planeVis[p] && (rawPixel & (1 << p))) pixel |= 1 << p;
          }

          let color: number;
          let effectiveIdx: number;

          if (ham && numPlanes === 6) {
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
          } else if (dpf) {
            // Dual playfield: odd planes → PF1, even planes → PF2.
            // PF1 index uses bits 0,2,4 of pixel; PF2 uses bits 1,3,5.
            const pf1Idx = (pixel & 1) | (((pixel >> 2) & 1) << 1) | (((pixel >> 4) & 1) << 2);
            const pf2Idx = ((pixel >> 1) & 1) | (((pixel >> 3) & 1) << 1) | (((pixel >> 5) & 1) << 2);
            const pf2pri = (lineBplcon2[y] >> 6) & 1;
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
            effectiveIdx = pixel & ((1 << numPlanes) - 1);
            color = palette[effectiveIdx] ?? palette[0];
          }

          const px = wx * 16 + bit;
          const li = y * width + px;
          pixRawBits[li]  = rawPixel;
          pixColorIdx[li] = effectiveIdx;
          pixColors[li]   = color;
        }
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
      const bplcon2  = lineBplcon2[y];
      const pf1p     = bplcon2 & 0x7;
      const pf2p     = (bplcon2 >> 3) & 0x7;
      const pf2pri   = (bplcon2 >> 6) & 1;
      // Front/back PFP for the priority chain (only matters in DPF).
      const frontPFP = dpf ? (pf2pri ? pf2p : pf1p) : pf1p;
      const backPFP  = dpf ? (pf2pri ? pf1p : pf2p) : 0;

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

          const pxBase = hstartCanvas + bit * (hires ? 2 : 1);
          const colorsToSet = hires ? 2 : 1;
          for (let dx = 0; dx < colorsToSet; dx++) {
            const px = pxBase + dx;
            if (px < 0 || px >= width) continue;
            const li = y * width + px;

            // Priority check: sprites in front of frontPFP always draw.
            if (pair >= frontPFP) {
              const ci = pixColorIdx[li];
              if (dpf) {
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
    }

    ctx.putImageData(imgData, 0, 0);
    pixelSnap.current = {
      rawBits: pixRawBits, colorIdx: pixColorIdx, colors: pixColors,
      palettes: linePalettes, spriteMask: pixSprite,
      width, height, firstLine, numPlanes, ham,
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
    const extra = computeHoverExtra(m, ps.firstLine, logY, logX, ps.numPlanes);
    const spr   = ps.spriteMask[li];
    setHover({
      logX, logY,
      vpos:        ps.firstLine + logY,
      rawBits:     ps.rawBits[li],
      colorIdx:    ps.colorIdx[li],
      color:       ps.colors[li],
      ham:         ps.ham,
      palette:     ps.palettes[logY],
      spriteOwner: spr === 0xff ? undefined : spr,
      ...extra,
    });
    setHoverClientPos({ x: e.clientX, y: e.clientY });
  }, [scale]);

  const onMouseLeave = useCallback(() => setHover(null), []);
  const togglePlane  = useCallback((i: number) => {
    setPlaneVis(v => { const n = [...v]; n[i] = !n[i]; return n; });
  }, []);
  const toggleSprite = useCallback((i: number) => {
    setSpriteVis(v => { const n = [...v]; n[i] = !n[i]; return n; });
  }, []);

  if (!model?.dma) {
    return <div className="resources-empty">No DMA data available.</div>;
  }
  if (!screen) {
    return <div className="resources-empty">No bitplane display detected in this capture.</div>;
  }

  const { width, height, numPlanes, hires, ham, dpf, modeChanges } = screen;
  const modeStr = modeChanges
    ? "variable mode"
    : `${numPlanes}-plane${hires ? " hires" : " lores"}${ham ? " HAM" : ""}${dpf ? " DPF" : ""}`;
  const info = `${width}×${height} · ${modeStr}`;

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
        {Array.from({ length: numPlanes }, (_, i) => (
          <button
            key={i}
            className={"resources-bpl-btn" + (planeVis[i] ? " active" : "")}
            onClick={() => togglePlane(i)}
            title={`${planeVis[i] ? "Hide" : "Show"} bitplane ${i + 1}`}
          >
            {i + 1}
          </button>
        ))}
        {activeSpritesMask !== 0 && (
          <>
            <span className="resources-bpl-label">SPR</span>
            {Array.from({ length: 8 }, (_, i) => {
              if (!(activeSpritesMask & (1 << i))) return null;
              return (
                <button
                  key={i}
                  className={"resources-bpl-btn" + (spriteVis[i] ? " active" : "")}
                  onClick={() => toggleSprite(i)}
                  title={`${spriteVis[i] ? "Hide" : "Show"} sprite ${i}`}
                >
                  {i}
                </button>
              );
            })}
          </>
        )}
      </div>
      <div className="resources-canvas-wrap">
        <canvas
          ref={canvas}
          style={{ imageRendering: "pixelated", cursor: "crosshair" }}
          onMouseMove={onMouseMove}
          onMouseLeave={onMouseLeave}
        />
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
