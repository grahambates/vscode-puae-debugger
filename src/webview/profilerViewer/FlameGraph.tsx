import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { BusOwner, Category, ILocation, DMA_WRITE, DMA_BYTE, DMA_HPOS, dmaIsCustomReg } from "../../shared/profilerTypes";
import { getProfileModel } from "./modelStore";
import { buildColumns, IColumn, IColumnLocation, resolveStackAtX } from "./columns";
import { binarySearch } from "./array";
import { dataName, DisplayUnit, formatValue, scaleValue, Timing } from "./display";
import { compileFilter, IRichFilter } from "./filter";
import Markdown from "markdown-to-jsx/react";
import { channelStyle, blitStyle, dmaconChannels, dmaEventNames, ownerRegister, DMACON_REG_INDEX, ChannelStyle } from "./dma";
import { getBlits, blitLabel, blitTooltip, channelStrideBytes, Blit } from "./blits";
import { BLTCON0Flags } from "./blitMinterm";
import { BlitDetailGrid } from "./BlitDetail";
import { Tooltip } from "./Tooltip";
import { reconstructCustomRegs } from "./reconstruct";
import { createSymbolizer } from "./symbols";
import { customRegisterName } from "../shared/customRegisters";
import { getCustomRegDoc } from "../shared/customRegisterDocs";
import { MiddleOut } from "./MiddleOut";
import { isMac } from "../shared/platform";

// Time-ordered flame chart on a 2D canvas. x = cycles in execution order (the old
// vscode-amiga-debug model, ported as data — see columns.ts), depth grows downward.
// Visible window is `bounds` (0..1 of the frame). Interaction is ported from the old
// renderer: drag the canvas to pan (with click-vs-drag detection), mouse wheel zooms
// centred on the cursor (shift = pan), a synced scrollbar pans, double-click / Enter
// zooms the focused box, arrows navigate, Esc resets, Ctrl/Cmd+click jumps to source.

const ROW_H = 18;
const TIMELINE_H = 18;
const DMA_BAND_H = 18; // height of the DMA channel line above the CPU rows
const BLIT_BAND_H = 18; // height of the blitter line (one box per blit), below the DMA line
const Y_BUFFER = 8;
const HSCROLL_H = 14; // height of the horizontal pan scrollbar (matches .flame .hscroll in App.css)
// Hard cap on call-stack depth: rows deeper than this aren't built or drawn (so the canvas / the
// flame area can't balloon on a pathologically deep stack). The flame area sizes itself to the
// actual depth up to this limit; beyond it, the deepest frames are intentionally not rendered.
const MAX_DEPTH = 16;
const MIN_LABEL_W = 28; // px; narrower boxes get no text
// Min slot length for a DMA run to be kept in `longRuns` (the labelable-width subset). Below this a
// run can only fit a label at extreme zoom, where the full run list is cheap to scan anyway.
const LABEL_LONG_RUN_SLOTS = 16;
const MIN_DRAW_W = 0.4; // px; narrower boxes are skipped entirely
const TIMELINE_LABEL_SPACING = 200; // min px between ruler labels (old Constants)
const TICK_SEQ = [2, 2.5, 2]; // "nice number" step sequence: 1,2,5,10,20,50,…

const clamp = (min: number, v: number, max: number) => Math.max(Math.min(v, max), min);

interface IBox {
  column: number;
  row: number;
  x1: number; // 0..1 of frame duration
  x2: number;
  y1: number; // px
  y2: number;
  fill: string;
  textDark: boolean;
  text: string;
  loc: IColumnLocation;
}

interface IBounds {
  minX: number;
  maxX: number;
}

// A pan drag in progress. `original` is the bounds at mousedown; click-vs-drag is
// decided at mouseup from the elapsed time + pointer travel.
interface IDrag {
  original: IBounds;
  pageXOrigin: number;
  xPerPixel: number;
  timestamp: number;
}

// Draw `text` left-aligned and vertically centred in a box, clipped to it, ellipsising if it
// doesn't fit. Shared by the flame boxes, the DMA band and the blitter band. Caller sets ctx.font.
function drawClippedLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  boxW: number,
  boxH: number,
  color: string,
) {
  const maxW = boxW - 6;
  if (maxW <= 0) return;
  let label = text;
  if (ctx.measureText(label).width > maxW) {
    while (label.length > 0 && ctx.measureText(label + "…").width > maxW) label = label.slice(0, -1);
    label += "…";
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, boxW, boxH);
  ctx.clip();
  ctx.fillStyle = color;
  ctx.fillText(label, x + 3, y + boxH / 2);
  ctx.restore();
}

// murmur3 32-bit finalizer — a fast hash for stable per-box colours.
function hash(n: number): number {
  n ^= n >>> 16;
  n = Math.imul(n, 2246822507);
  n ^= n >>> 13;
  n = Math.imul(n, 3266489909);
  n ^= n >>> 16;
  return n >>> 0;
}

// Warm flame palette (matches the old renderer): saturated reds→oranges→salmon.
function colorFor(loc: IColumnLocation): { fill: string; textDark: boolean } {
  if (loc.category === Category.System) return { fill: "#5a5a5a", textDark: false };
  const h = hash(loc.graphId);
  const r = 230;
  const g = ((h & 255) / 2) | 0;
  const b = (((h >> 8) & 255) / 2.353) | 0;
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  return { fill: `rgb(${r},${g},${b})`, textDark: luminance > 150 };
}

const getBoxInRowColumn = (
  columns: readonly IColumn[],
  boxById: ReadonlyMap<number, IBox>,
  column: number,
  row: number,
): IBox | undefined => {
  let candidate = columns[column]?.rows[row];
  if (typeof candidate === "number") candidate = columns[candidate].rows[row];
  return candidate !== undefined ? boxById.get((candidate as IColumnLocation).graphId) : undefined;
};

const buildBoxes = (columns: readonly IColumn[], yOffset: number) => {
  const boxById = new Map<number, IBox>();
  let maxY = 0;
  for (let x = 0; x < columns.length; x++) {
    const col = columns[x];
    // Don't build boxes deeper than the hard cap — they'd never be drawn and only inflate maxY.
    const rowCount = Math.min(col.rows.length, MAX_DEPTH);
    for (let y = 0; y < rowCount; y++) {
      const cell = col.rows[y];
      if (typeof cell === "number") {
        const existing = getBoxInRowColumn(columns, boxById, x, y);
        if (existing) existing.x2 = col.x2; // extend the merged run
      } else {
        const y1 = ROW_H * y + yOffset;
        const { fill, textDark } = colorFor(cell);
        boxById.set(cell.graphId, {
          column: x,
          row: y,
          x1: col.x1,
          x2: col.x2,
          y1,
          y2: y1 + ROW_H,
          fill,
          textDark,
          text: cell.callFrame.functionName,
          loc: cell,
        });
        maxY = Math.max(y1 + ROW_H, maxY);
      }
    }
  }
  return { boxById, boxes: [...boxById.values()], maxY };
};

const QuadEaseInOut = (p: number) => (p < 0.5 ? 2 * p * p : -2 * p * p + 4 * p - 1);

// Display-only: if `file` sits under `root`, show it relative to root instead of the full
// absolute path baked into the model by the DWARF/stabs symbolizer. Falls back to the absolute
// path when there's no workspace root or `file` isn't under it (e.g. a profile loaded on a
// different machine than it was captured on). Purely cosmetic — onOpenSource/line-matching
// still use the model's own (unmodified) callFrame.url.
function relativeToRoot(file: string, root: string | undefined): string {
  if (!root) return file;
  const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  const rootSlash = norm(root).replace(/\/$/, "") + "/";
  const nFile = norm(file);
  return nFile.startsWith(rootSlash) ? file.replace(/\\/g, "/").slice(rootSlash.length) : file;
}

const locText = (loc: ILocation, workspaceRoot: string | undefined): string | undefined =>
  loc.callFrame.url
    ? `${relativeToRoot(loc.callFrame.url, workspaceRoot)}${loc.callFrame.lineNumber >= 0 ? `:${loc.callFrame.lineNumber}` : ""}`
    : undefined;

export function FlameGraph({
  displayUnit,
  filter,
  onOpenSource,
  selectedSlot,
  onSelectSlot,
  onOpenBlitterTab,
  onOpenMemory,
  heightOverridePx,
  workspaceRoot,
}: {
  displayUnit: DisplayUnit;
  filter: IRichFilter;
  onOpenSource: (file: string, line: number, toSide: boolean) => void;
  // The pinned DMA-cycle cursor (shared with the custom-registers view): set by clicking the
  // DMA band. Persists across hover, unlike `dmaHover` — drawn as a vertical marker line.
  selectedSlot?: number;
  onSelectSlot?: (slot: number) => void;
  // Clicking a blit box jumps the playhead to its start (like a CPU box) AND switches to the
  // Blitter tab (always the left panel, matching jumpToExecutionAtLine's convention — the flame
  // graph sits above both panels, so there's no "whichever panel it was clicked from" to reuse).
  // BlitterView picks up the new selectedSlot itself and highlights/scrolls to that blit.
  onOpenBlitterTab?: () => void;
  // Ctrl/Cmd+click on a blit box jumps the Memory tab (also always the left panel, same
  // convention as onOpenBlitterTab) to that blit's destination (channel D) pointer, in visual
  // mode aligned to the buffer's real row stride — mirrors Ctrl/Cmd+click's "jump to source" on
  // a CPU box. Only fires when the blit actually writes memory (channel D enabled); a blit with
  // D disabled has no destination to jump to.
  onOpenMemory?: (address: number, bytesPerRow?: number) => void;
  // Manual override for the flame area's height (px), set by dragging the split divider in
  // App.tsx. undefined = auto-size to the (capped) call-stack depth, capped at 70% (default).
  heightOverridePx?: number;
  // The workspace folder's fsPath (from the captureResult message), for showing the hover
  // tooltip's source path relative to it rather than the full absolute path. undefined = no
  // workspace open (or not sent yet) — falls back to the absolute path.
  workspaceRoot?: string;
}) {
  // The model is read from the external store (not a prop) so its large arrays never go through
  // React's serializer. FlameGraph is only rendered when a model exists (App guards it), and it
  // re-renders with its parent, so this read is non-null and current.
  const model = getProfileModel()!;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollChildRef = useRef<HTMLDivElement>(null);
  const ignoreScrollRef = useRef(false);
  const animRef = useRef<number | undefined>(undefined);

  const [width, setWidth] = useState(800);
  const [bounds, setBounds] = useState<IBounds>({ minX: 0, maxX: 1 });
  const [hovered, setHovered] = useState<{ box: IBox; x: number; y: number } | undefined>(undefined);
  const [dmaHover, setDmaHover] = useState<{ slot: number; x: number; y: number } | undefined>(undefined);
  const [blitHover, setBlitHover] = useState<{ blit: Blit; x: number; y: number } | undefined>(undefined);
  const [focused, setFocused] = useState<IBox | undefined>(undefined);
  const [drag, setDrag] = useState<IDrag | undefined>(undefined);
  const [scrubbing, setScrubbing] = useState(false);

  // DMA channel line (captured in the same frame). A band of DMA_BAND_H sits between
  // the timeline ruler and the CPU rows, which are shifted down by the band height. The
  // blitter line (one box per blit, reconstructed from the same grid) sits below it.
  const dma = model.dma;
  const dmaSlots = dma ? dma.owner.length : 0;
  const bandH = dma ? DMA_BAND_H : 0;
  // DMA band as 1-D summed-area tables (prefix sums of r/g/b over slots): a pixel covering many
  // cycles gets a box-filtered average colour in O(1) — avg = (pre[s1]-pre[s0]) / (s1-s0). Channels
  // sum separately (a single channel reaches ~255·N ≈ 18M — too big to pack into one int, fine in
  // Int32). The band has no gaps (idle cycles have their own colour) so the denominator is the slot
  // count; an unknown owner (channelStyle → null) uses the idle colour. Also returns the colour
  // runs (for labels): `runs` is all of them, `longRuns` the labelable-width subset.
  const dmaData = useMemo(() => {
    if (!dma) return null;
    const owner = dma.owner;
    const flags = dma.flags;
    const N = owner.length;
    const preR = new Int32Array(N + 1);
    const preG = new Int32Array(N + 1);
    const preB = new Int32Array(N + 1);
    // Runs coalesce adjacent same-style cycles (by shared-style reference). `longRuns` keeps only
    // those long enough to ever fit a label, so the per-frame label scan skips the many tiny runs.
    const runs: { start: number; end: number; label: string }[] = [];
    const longRuns: { start: number; end: number; label: string }[] = [];
    const pushRun = (start: number, end: number, label: string) => {
      const run = { start, end, label };
      runs.push(run);
      if (end - start >= LABEL_LONG_RUN_SLOTS) longRuns.push(run);
    };
    const idle = channelStyle(BusOwner.NONE, 0)!; // fallback colour for any null style
    let r = 0, g = 0, b = 0;
    let start = 0;
    let cur: ChannelStyle | null = null;
    for (let i = 0; i < N; i++) {
      const st = channelStyle(owner[i], flags[i]) ?? idle;
      r += st.r; g += st.g; b += st.b;
      preR[i + 1] = r; preG[i + 1] = g; preB[i + 1] = b;
      if (st !== cur) {
        if (cur && i > start) pushRun(start, i, cur.label);
        cur = st;
        start = i;
      }
    }
    if (cur && N > start) pushRun(start, N, cur.label);
    return { N, preR, preG, preB, runs, longRuns };
  }, [dma]);
  // Offscreen 1px-tall band: the DMA fill writes per-pixel RGBA here and blits it in one drawImage.
  const dmaBandRef = useRef<{ canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; img: ImageData; cap: number } | null>(null);
  const blitResult = useMemo(() => (dma ? getBlits(dma) : { blits: [], fastBlitter: false }), [dma]);
  const blits = blitResult.blits;
  const blitH = blits.length ? BLIT_BAND_H : 0;
  const yOffset = TIMELINE_H + bandH + blitH;

  const columns = useMemo(() => buildColumns(model), [model]);
  const { boxById, boxes, maxY } = useMemo(() => buildBoxes(columns, yOffset), [columns, yOffset]);
  const height = Math.max(maxY, yOffset) + Y_BUFFER;
  const duration = model.duration || 1;
  const timing: Timing = useMemo(
    () => ({ cyclesPerMicroSecond: model.cyclesPerMicroSecond, duration: model.duration }),
    [model.cyclesPerMicroSecond, model.duration],
  );

  // Compiled filter predicate; null when the box matches the query (dim otherwise).
  const matches = useMemo(() => {
    if (!filter.text.trim()) return null;
    const pred = compileFilter(filter);
    return (b: IBox) => pred(b.text) || (!!b.loc.callFrame.url && pred(b.loc.callFrame.url));
  }, [filter]);

  // Address symbolizer from the shipped symbol table (for the DMA tooltip; reusable).
  const symbolize = useMemo(() => createSymbolizer(model.symbols), [model.symbols]);

  // Reset the view when a fresh capture (new model) arrives. Done during render via
  // the previous-value pattern rather than in an effect, so it doesn't cascade an
  // extra post-paint render (React bails out and re-renders immediately).
  const [prevModel, setPrevModel] = useState(model);
  if (model !== prevModel) {
    setPrevModel(model);
    setBounds({ minX: 0, maxX: 1 });
    setFocused(undefined);
    setHovered(undefined);
    setDmaHover(undefined);
    setBlitHover(undefined);
  }

  // Track the visible canvas width (also reacts to the vertical scrollbar appearing).
  useEffect(() => {
    const el = canvasWrapRef.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth || 800);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Animate the visible window to `to` with quadratic easing; zooming to the box
  // we're already framed on returns to the whole frame.
  const zoomTo = useCallback(
    (to: IBounds) => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
      const from = bounds;
      const target = from.minX === to.minX && from.maxX === to.maxX ? { minX: 0, maxX: 1 } : to;
      const dur = 250;
      let start: number | undefined;
      const step = (ts: number) => {
        if (start === undefined) start = ts;
        const t = Math.min(1, (ts - start) / dur);
        const k = QuadEaseInOut(t);
        setBounds({ minX: from.minX + (target.minX - from.minX) * k, maxX: from.maxX + (target.maxX - from.maxX) * k });
        if (t < 1) animRef.current = requestAnimationFrame(step);
        else animRef.current = undefined;
      };
      animRef.current = requestAnimationFrame(step);
    },
    [bounds],
  );

  // Mouse-wheel: shift = pan, otherwise zoom centred on the cursor (ported from the
  // old renderer: scale = deltaY/-400, stop zooming in past ~10 cycles on screen).
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (animRef.current) {
        cancelAnimationFrame(animRef.current);
        animRef.current = undefined;
      }
      const rect = cv.getBoundingClientRect();
      setBounds((prev) => {
        const range = prev.maxX - prev.minX;
        if (e.shiftKey) {
          const dx = clamp(-prev.minX, (e.deltaY / rect.width) * range, 1 - prev.maxX);
          return { minX: prev.minX + dx, maxX: prev.maxX + dx };
        }
        const center = prev.minX + (range * (e.clientX - rect.left)) / rect.width;
        const scale = e.deltaY / -400;
        const nb = {
          minX: Math.max(0, prev.minX + scale * (center - prev.minX)),
          maxX: Math.min(1, prev.maxX - scale * (prev.maxX - center)),
        };
        return (nb.maxX - nb.minX) * duration > 10 ? nb : prev;
      });
    };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  }, [duration]);

  // Draw everything (ruler + boxes + labels + highlight).
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = width * dpr;
    cv.height = height * dpr;
    cv.style.width = `${width}px`;
    cv.style.height = `${height}px`;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const range = bounds.maxX - bounds.minX || 1;
    const xScale = width / range;
    const toX = (x: number) => (x - bounds.minX) * xScale;

    // Timeline ruler with "nice" round-number ticks (ported algorithm): pick the
    // finest 1/2/5·10ⁿ division whose labels stay ≥ TIMELINE_LABEL_SPACING px apart.
    const cs = getComputedStyle(document.body);
    ctx.font = `10px ${cs.fontFamily || "sans-serif"}`;
    ctx.textBaseline = "middle";
    ctx.fillStyle = cs.getPropertyValue("--vscode-foreground").trim() || "#ccc";
    ctx.strokeStyle = cs.getPropertyValue("--vscode-editorRuler-foreground").trim() || "#888";
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    const scaledDuration = scaleValue(duration, displayUnit, timing);
    if (scaledDuration > 0) {
      let uuu = 1;
      let i = 0;
      for (; uuu < scaledDuration; i++) uuu *= TICK_SEQ[i % 3];
      let div = scaledDuration / uuu;
      for (i--; width / range / (div * TICK_SEQ[((i % 3) + 3) % 3]) >= TIMELINE_LABEL_SPACING; i--)
        div *= TICK_SEQ[((i % 3) + 3) % 3];
      const unitsPerLabel = 1 / div;
      const firstLabel = (Math.floor(bounds.minX / unitsPerLabel) - 1) * unitsPerLabel;
      const lastLabel = (Math.ceil(bounds.maxX / unitsPerLabel) + 1) * unitsPerLabel;
      for (let u = firstLabel; u <= lastLabel; u += unitsPerLabel) {
        const x = (u - bounds.minX) * xScale;
        ctx.fillText(formatValue(duration * u, displayUnit, timing), x + 3, TIMELINE_H / 2);
        ctx.moveTo(x, 0);
        ctx.lineTo(x, TIMELINE_H);
      }
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    // DMA channel line: colored by bus owner (CPU Code/Data, Copper MOVE/WAIT/SKIP, etc.). Each
    // pixel is the box-filtered average of the cycles it covers (see dmaData), so the band stays
    // accurate and alias-free when many cycles map to one pixel.
    if (dma && dmaSlots > 0 && dmaData) {
      const { N, preR, preG, preB, runs, longRuns } = dmaData;
      const bandY = TIMELINE_H;
      ctx.font = `11px ${cs.fontFamily || "sans-serif"}`;
      const W = Math.max(1, Math.ceil(width));
      const slot0 = bounds.minX * N;
      const slotPerPx = ((bounds.maxX - bounds.minX) * N) / width;
      // Reusable W×1 offscreen band: write each pixel's colour as raw RGBA, then blit it once.
      let band = dmaBandRef.current;
      if (!band || band.cap < W) {
        const canvas = document.createElement("canvas");
        canvas.width = W;
        canvas.height = 1;
        const bctx = canvas.getContext("2d")!;
        band = { canvas, ctx: bctx, img: bctx.createImageData(W, 1), cap: W };
        dmaBandRef.current = band;
      }
      const data = band.img.data;
      // Box-filter each pixel from the prefix sums into the RGBA buffer (denominator = slot count,
      // since the band has no gaps); a gap past the last slot gets alpha 0.
      for (let p = 0; p < W; p++) {
        const o = p * 4;
        const i0 = (slot0 + p * slotPerPx) | 0; // floor (operands ≥ 0)
        let i1 = Math.ceil(slot0 + (p + 1) * slotPerPx);
        if (i1 > N) i1 = N;
        if (i1 <= i0) { if (i0 >= N) { data[o + 3] = 0; continue; } i1 = i0 + 1; }
        const denom = i1 - i0;
        data[o] = ((preR[i1] - preR[i0]) / denom + 0.5) | 0;
        data[o + 1] = ((preG[i1] - preG[i0]) / denom + 0.5) | 0;
        data[o + 2] = ((preB[i1] - preB[i0]) / denom + 0.5) | 0;
        data[o + 3] = 255;
      }
      // Blit the 1px band scaled to band height (nearest sampling, so the row just repeats down).
      band.ctx.putImageData(band.img, 0, 0);
      const prevSmooth = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(band.canvas, 0, 0, W, 1, 0, bandY, width, DMA_BAND_H - 1);
      ctx.imageSmoothingEnabled = prevSmooth;

      // Labels: a run needs ≥ minSlots slots to span MIN_LABEL_W px. Scan only `longRuns` once that
      // threshold clears the long-run floor; below it (extreme zoom) the full list is short anyway.
      const hiSlot = bounds.maxX * N;
      const minSlots = (MIN_LABEL_W * (bounds.maxX - bounds.minX) * N) / width;
      const src = minSlots >= LABEL_LONG_RUN_SLOTS ? longRuns : runs;
      let lo = 0;
      let hi = src.length;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (src[m].end <= slot0) lo = m + 1;
        else hi = m;
      }
      for (let ri = lo; ri < src.length && src[ri].start < hiSlot; ri++) {
        const run = src[ri];
        if (!run.label || run.end - run.start < minSlots) continue;
        const a = Math.max(0, toX(run.start / N));
        const w = Math.min(width, toX(run.end / N)) - a;
        if (w > MIN_LABEL_W) drawClippedLabel(ctx, run.label, a, bandY, w, DMA_BAND_H, "#fff");
      }

      // Highlight the hovered slot.
      if (dmaHover) {
        const hx = toX(dmaHover.slot / N);
        const hw = Math.max(toX((dmaHover.slot + 1) / N) - hx, 1.5);
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1;
        ctx.strokeRect(hx + 0.5, bandY + 0.5, hw, DMA_BAND_H - 2);
      }
      // Separator under the band.
      ctx.strokeStyle = cs.getPropertyValue("--vscode-panel-border").trim() || "#444";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, bandY + DMA_BAND_H - 0.5);
      ctx.lineTo(width, bandY + DMA_BAND_H - 0.5);
      ctx.stroke();
    }

    // Blitter line: one box per reconstructed blit, spanning BLTSIZE-write → final D write,
    // colored by mode (Copy/Fill/Line). Same slot→x mapping as the DMA band, so they align.
    if (dma && blitH > 0) {
      const N = dmaSlots;
      const blitBandY = TIMELINE_H + bandH;
      const spanX = (b: Blit) => [b.startSlot / N, (b.finished ? b.endSlot + 1 : b.startSlot + 1) / N] as const;
      ctx.font = `11px ${cs.fontFamily || "sans-serif"}`;
      for (const blit of blits) {
        const [s1, s2] = spanX(blit);
        const x1 = toX(s1);
        const x2 = toX(s2);
        if (x2 < 0 || x1 > width) continue;
        const cx = Math.max(0, x1);
        const cw = Math.min(width, x2) - cx;
        if (cw < MIN_DRAW_W) continue;
        const style = blitStyle(blit.mode);
        ctx.fillStyle = style.color;
        ctx.fillRect(cx, blitBandY, Math.max(cw, MIN_DRAW_W), BLIT_BAND_H - 1);
        if (cw > MIN_LABEL_W) {
          drawClippedLabel(ctx, blitLabel(blit), cx, blitBandY, cw, BLIT_BAND_H, style.textDark ? "#000" : "#fff");
        }
      }
      // Highlight the hovered blit.
      if (blitHover) {
        const [s1, s2] = spanX(blitHover.blit);
        const hx = Math.max(0, toX(s1));
        const hw = Math.min(width, toX(s2)) - hx;
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1;
        ctx.strokeRect(hx + 0.5, blitBandY + 0.5, Math.max(hw - 1, 0), BLIT_BAND_H - 2);
      }
      // Fast-blitter capture (accuracy < 2): blitter cells absent, spans estimated.
      if (blitResult.fastBlitter) {
        ctx.font = `10px ${cs.fontFamily || "sans-serif"}`;
        ctx.fillStyle = cs.getPropertyValue("--vscode-descriptionForeground").trim() || "#999";
        ctx.fillText("blitter accuracy < 2 — spans estimated", 4, blitBandY + BLIT_BAND_H / 2);
      }
      // Separator under the band.
      ctx.strokeStyle = cs.getPropertyValue("--vscode-panel-border").trim() || "#444";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, blitBandY + BLIT_BAND_H - 0.5);
      ctx.lineTo(width, blitBandY + BLIT_BAND_H - 0.5);
      ctx.stroke();
    }

    // Boxes. Labels use the UI font.
    ctx.font = `11px ${cs.fontFamily || "sans-serif"}`;
    for (const b of boxes) {
      const x1 = toX(b.x1);
      const x2 = toX(b.x2);
      if (x2 < 0 || x1 > width) continue;
      const w = x2 - x1;
      if (w < MIN_DRAW_W) continue;
      const cx = Math.max(0, x1);
      const cw = Math.min(width, x2) - cx;
      const dim = matches ? !matches(b) : false;
      const isHi = b === hovered?.box || b === focused;
      ctx.fillStyle = dim ? "#3a3a3a" : b.fill;
      ctx.fillRect(cx, b.y1, Math.max(cw - 1, MIN_DRAW_W), ROW_H - 1);
      if (isHi) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1;
        ctx.strokeRect(cx + 0.5, b.y1 + 0.5, Math.max(cw - 2, 0), ROW_H - 2);
      }
      if (w > MIN_LABEL_W) {
        drawClippedLabel(ctx, b.text, cx, b.y1, cw, ROW_H, dim ? "rgba(255,255,255,0.4)" : b.textDark ? "#000" : "#fff");
      }
    }

    // Pinned time-cursor: a vertical marker at the selected DMA cycle (set by clicking the DMA
    // band), spanning the whole chart — drives the custom-registers view.
    if (dma && selectedSlot !== undefined) {
      const mx = toX(selectedSlot / dmaSlots);
      if (mx >= -1 && mx <= width + 1) {
        ctx.strokeStyle = "#e8c547";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(mx + 0.5, 0);
        ctx.lineTo(mx + 0.5, height);
        ctx.stroke();
      }
    }
  }, [boxes, width, height, bounds, hovered, focused, duration, displayUnit, timing, matches, dma, dmaSlots, dmaData, dmaHover, bandH, blits, blitH, blitHover, blitResult, selectedSlot]);

  // --- horizontal pan scrollbar (synced to `bounds`) ----------------------------
  // The scroll child's width is canvasWidth/range, so when zoomed in it overflows
  // and the native scrollbar thumb shows the visible window; dragging it pans.
  const onScroll = useCallback(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    if (ignoreScrollRef.current) {
      ignoreScrollRef.current = false;
      return;
    }
    const range = bounds.maxX - bounds.minX;
    const w = width / range;
    const minX = clamp(0, sc.scrollLeft / w, 1 - range);
    setBounds({ minX, maxX: minX + range });
  }, [bounds, width]);

  useEffect(() => {
    const sc = scrollRef.current;
    const child = scrollChildRef.current;
    if (!sc || !child) return;
    const range = bounds.maxX - bounds.minX;
    const w = width / range;
    child.style.width = `${w}px`;
    const scroll = bounds.minX * w;
    if (Math.abs(scroll - sc.scrollLeft) > 0.5) {
      ignoreScrollRef.current = true;
      sc.scrollLeft = scroll;
    }
  }, [bounds, width]);

  // Hit-test the cursor → column (binary search by x) then row. CPU rows start below
  // the timeline + DMA band.
  const boxAt = useCallback(
    (mx: number, my: number): IBox | undefined => {
      if (my < yOffset) return undefined;
      const range = bounds.maxX - bounds.minX || 1;
      const x = bounds.minX + (mx / width) * range;
      const row = Math.floor((my - yOffset) / ROW_H);
      let col = binarySearch(columns, (c) => c.x2 - x);
      if (col < 0) col = -col - 1; // insertion point = first column whose x2 >= x
      if (col >= columns.length) return undefined;
      return getBoxInRowColumn(columns, boxById, col, row);
    },
    [columns, boxById, bounds, width, yOffset],
  );

  // The CPU call stack at a normalized x (0..1), read from the flame columns: the column
  // covering x, its rows outer→leaf as function names. This is what the CPU was executing
  // at that instant — used for the DMA tooltip's call-stack line.
  const stackAtX = useCallback(
    (x: number): string[] => resolveStackAtX(columns, x).map((loc) => loc.callFrame.functionName),
    [columns],
  );

  // Hit-test the cursor in the DMA band → slot index (or -1 if outside / idle slot).
  const slotAt = useCallback(
    (mx: number, my: number): number => {
      if (!dma || my < TIMELINE_H || my >= TIMELINE_H + bandH) return -1;
      const range = bounds.maxX - bounds.minX || 1;
      const x = bounds.minX + (mx / width) * range;
      const slot = Math.floor(x * dmaSlots);
      if (slot < 0 || slot >= dmaSlots) return -1;
      return channelStyle(dma.owner[slot], dma.flags[slot]) ? slot : -1;
    },
    [dma, dmaSlots, bandH, bounds, width],
  );

  // Hit-test the cursor in the blitter band → the blit whose [start, end] span covers it.
  const blitAt = useCallback(
    (mx: number, my: number): Blit | undefined => {
      if (!blitH || my < TIMELINE_H + bandH || my >= TIMELINE_H + bandH + blitH) return undefined;
      const range = bounds.maxX - bounds.minX || 1;
      const slot = (bounds.minX + (mx / width) * range) * dmaSlots;
      for (const b of blits) {
        const end = b.finished ? b.endSlot + 1 : b.startSlot + 1;
        if (slot >= b.startSlot && slot < end) return b;
      }
      return undefined;
    },
    [blits, blitH, bandH, bounds, width, dmaSlots],
  );

  // --- scrubbable playhead: a dedicated strip over the timeline ruler, separate from the
  // canvas pan-drag below, so dragging it continuously moves `selectedSlot` instead of panning
  // (ported from the old extension's timeBack/timeHandle). ---------------------------------
  const slotFromClientX = useCallback(
    (clientX: number): number => {
      const rect = canvasRef.current!.getBoundingClientRect();
      const range = bounds.maxX - bounds.minX || 1;
      const frac = bounds.minX + ((clientX - rect.left) / width) * range;
      return clamp(0, Math.round(frac * dmaSlots), Math.max(dmaSlots - 1, 0));
    },
    [bounds, width, dmaSlots],
  );

  // pointermove can fire far faster than the display refreshes (especially high-poll-rate mice/
  // trackpads) — calling onSelectSlot (a React state update with downstream consumers like the
  // Memory view) on every raw event queues up a backlog of renders that falls further and further
  // behind, making the UI appear to hang for seconds. Coalesce to at most one onSelectSlot call
  // per animation frame: pointermove just stashes the latest clientX, a pending rAF reads it once.
  const scrubRafRef = useRef<number | undefined>(undefined);
  const scrubPendingXRef = useRef<number | undefined>(undefined);
  const scheduleScrub = useCallback(
    (clientX: number) => {
      scrubPendingXRef.current = clientX;
      if (scrubRafRef.current !== undefined) return;
      scrubRafRef.current = requestAnimationFrame(() => {
        scrubRafRef.current = undefined;
        const x = scrubPendingXRef.current;
        if (x !== undefined && onSelectSlot) onSelectSlot(slotFromClientX(x));
      });
    },
    [onSelectSlot, slotFromClientX],
  );
  useEffect(() => () => { if (scrubRafRef.current !== undefined) cancelAnimationFrame(scrubRafRef.current); }, []);

  const onScrubPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dma || !onSelectSlot) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    onSelectSlot(slotFromClientX(e.clientX)); // first position applies immediately, not rAF-deferred
    setScrubbing(true);
    e.stopPropagation();
  };
  const onScrubPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!scrubbing) return;
    scheduleScrub(e.clientX);
  };
  const onScrubPointerUp = () => setScrubbing(false);

  // --- drag to pan with pointer capture, with click-vs-drag detection -----------
  // setPointerCapture routes all pointermove/up to the canvas even when the cursor
  // leaves the webview, so the drag always ends on release. Plain mouse events lose
  // the off-iframe mouseup (and report stale `buttons`), which left the old graph
  // stuck panning — pointer capture + lostpointercapture is the robust fix.
  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    canvasRef.current?.setPointerCapture(e.pointerId);
    setDrag({
      original: bounds,
      pageXOrigin: e.pageX,
      xPerPixel: (bounds.maxX - bounds.minX) / width,
      timestamp: Date.now(),
    });
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (drag) {
      const range = drag.original.maxX - drag.original.minX;
      const minX = clamp(0, drag.original.minX - (e.pageX - drag.pageXOrigin) * drag.xPerPixel, 1 - range);
      setBounds({ minX, maxX: minX + range });
      return;
    }
    const rect = canvasRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const slot = slotAt(mx, my);
    if (slot >= 0) {
      setDmaHover({ slot, x: e.clientX, y: e.clientY });
      setHovered(undefined);
      setBlitHover(undefined);
      return;
    }
    setDmaHover(undefined);
    const blit = blitAt(mx, my);
    if (blit) {
      setBlitHover({ blit, x: e.clientX, y: e.clientY });
      setHovered(undefined);
      return;
    }
    setBlitHover(undefined);
    const box = boxAt(mx, my);
    setHovered(box ? { box, x: e.clientX, y: e.clientY } : undefined);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drag) return;
    // A click (not a drag): short, with little pointer travel — select / jump.
    const isClick = Date.now() - drag.timestamp < 500 && Math.abs(e.pageX - drag.pageXOrigin) < 100;
    if (isClick && hovered) {
      setFocused(hovered.box);
      if (onSelectSlot && dmaSlots > 0) {
        // Jump the playhead to the start of this function's execution block, so the registers,
        // disassembly, memory, etc. all snap to where it begins.
        const slot = Math.max(0, Math.min(dmaSlots - 1, Math.floor(hovered.box.x1 * dmaSlots)));
        onSelectSlot(slot);
      }
      const loc = hovered.box.loc;
      if ((e.ctrlKey || e.metaKey) && loc.callFrame.url) {
        // lineNumber is already 1-based (raw SourceMap.lookupAddress().line — see internLocation),
        // matching what openProfilerSource expects. Normalize unknown (-1) to 1.
        onOpenSource(loc.callFrame.url, loc.callFrame.lineNumber >= 0 ? loc.callFrame.lineNumber : 1, e.altKey);
      }
    } else if (isClick && blitHover && onSelectSlot) {
      // Jump the playhead to the blit's start, same as a CPU box, and switch to the Blitter tab —
      // BlitterView highlights/scrolls to whichever blit covers selectedSlot on its own.
      onSelectSlot(blitHover.blit.startSlot);
      const blit = blitHover.blit;
      // Ctrl/Cmd+click jumps to the destination (channel D) in the Memory tab instead of the
      // Blitter tab — only meaningful if the blit actually writes memory (D enabled); otherwise
      // fall back to the normal-click behaviour since there's no destination to jump to.
      if ((e.ctrlKey || e.metaKey) && onOpenMemory && (blit.con0 & BLTCON0Flags.USED)) {
        onOpenMemory(blit.ptr[3], channelStrideBytes(blit, blit.mod[3]));
      } else {
        onOpenBlitterTab?.();
      }
    } else if (isClick && dmaHover && onSelectSlot) {
      onSelectSlot(dmaHover.slot);
    }
    setDrag(undefined);
  };

  // Double click zooms the focused box (or back out to the whole frame).
  const onDoubleClick = () => {
    if (focused) zoomTo({ minX: focused.x1, maxX: focused.x2 });
  };

  // Keyboard: arrows navigate the focused box, Enter/Space zoom, Esc reset/clear.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (bounds.minX !== 0 || bounds.maxX !== 1) zoomTo({ minX: 0, maxX: 1 });
        else setFocused(undefined);
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        if (focused) zoomTo({ minX: focused.x1, maxX: focused.x2 });
        return;
      }
      if (!focused) return;
      let next: IBox | undefined;
      if (e.key === "ArrowRight") {
        for (let x = focused.column + 1; x < columns.length; x++) {
          const b = getBoxInRowColumn(columns, boxById, x, focused.row);
          if (b && b !== focused) { next = b; break; }
        }
      } else if (e.key === "ArrowLeft") {
        for (let x = focused.column - 1; x >= 0; x--) {
          const b = getBoxInRowColumn(columns, boxById, x, focused.row);
          if (b && b !== focused) { next = b; break; }
        }
      } else if (e.key === "ArrowUp") {
        next = getBoxInRowColumn(columns, boxById, focused.column, focused.row - 1);
      } else if (e.key === "ArrowDown") {
        let x = focused.column;
        do {
          next = getBoxInRowColumn(columns, boxById, x, focused.row + 1);
        } while (!next && columns[++x]?.rows[focused.row] === focused.column);
      }
      if (next) {
        e.preventDefault();
        setFocused(next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [columns, boxById, focused, bounds, zoomTo]);

  const hoverLoc = hovered?.box.loc;
  const hoverText = hoverLoc ? locText(hoverLoc, workspaceRoot) : undefined;
  // Keep the whole filename visible in the middle-ellipsis; only the directory truncates.
  const fileEndChars = hoverText
    ? hoverText.length - (Math.max(hoverText.lastIndexOf("/"), hoverText.lastIndexOf("\\")) + 1)
    : 8;
  // DMA band hover info — mirrors the old extension's DMA tooltip: channel, symbolized
  // Address (call-stack for code) or custom Register name, sized Data, R/W + size, and the
  // raster Line / Color Clock decoded from the slot index. Recomputed only when the hovered
  // slot changes (not on every pointer move within the same slot) — it replays DMACON state
  // from the start of the frame, so it isn't free.
  const dmaHoverSlot = dmaHover?.slot;
  const dmaInfo = useMemo(() => {
    if (dmaHoverSlot === undefined || !dma) return undefined;
    const slot = dmaHoverSlot;
    const owner = dma.owner[slot];
    const flags = dma.flags[slot];
    const addr = dma.addr[slot] >>> 0;
    const isWrite = !!(flags & DMA_WRITE);
    const isByte = !!(flags & DMA_BYTE);
    const isCustom = dmaIsCustomReg(owner, flags, addr);
    const isCpu = owner === BusOwner.CPU;
    const isRefresh = owner === BusOwner.REFRESH;
    const isIdle = owner === BusOwner.NONE || owner === BusOwner.BLOCKED;
    // The associated custom register: a custom access carries it in its address; a channel DMA
    // (bitplane/audio/sprite/disk) maps from its bus owner (BPLxDAT, AUDxDAT, …). undefined → none.
    const regOff = isCustom ? addr & 0x1fe : ownerRegister(owner);
    const registerLabel =
      regOff !== undefined
        ? `${customRegisterName(regOff) ?? "custom"} ($${regOff.toString(16).padStart(3, "0")})`
        : undefined;
    const addrSymbol = symbolize(addr); // memory-address symbolization for the Address row
    const data = isByte
      ? `$${(dma.value[slot] & 0xff).toString(16).padStart(2, "0")}`
      : `$${dma.value[slot].toString(16).padStart(4, "0")}`;
    // DMA Control: DMACON reconstructed at this slot (baseline + the frame's writes up to here).
    const custom = model.dmaSnapshot?.custom;
    const dmacon = custom ? reconstructCustomRegs(dma, custom, slot + 1)[DMACON_REG_INDEX] : undefined;
    return {
      style: channelStyle(owner, flags),
      isCustom,
      // Refresh and idle/"-" cycles carry no meaningful address/data; Access is CPU-only.
      showAddrData: !isRefresh && !isIdle,
      showAccess: isCpu,
      registerLabel,
      addrSymbol,
      addrHex: `$${addr.toString(16).padStart(6, "0")}`,
      data,
      access: `${isWrite ? "Write" : "Read"}${isByte ? ".B" : ".W"}`,
      channels: dmacon !== undefined ? dmaconChannels(dmacon) : [],
      events: dma.events ? dmaEventNames(dma.events[slot]) : [],
      doc: regOff !== undefined ? getCustomRegDoc(regOff) : undefined,
      line: Math.floor(slot / DMA_HPOS),
      colorClock: slot % DMA_HPOS,
      // CPU call stack at this instant (outer→leaf), from the flame columns at this x.
      callStack: stackAtX((slot + 0.5) / dmaSlots),
    };
  }, [dmaHoverSlot, dma, model, symbolize, stackAtX, dmaSlots]);

  // Blit band hover info — the old extension's blitter tooltip: size, BLTCON chips, minterm
  // (hex + boolean expression + the 8 LF bits), per-channel source/destination (symbolized
  // address or literal data, shift, modulo), channel-A masks, and the start/end/duration.
  // Recomputed only when the hovered blit changes (not on every pointer move).
  const hoveredBlit = blitHover?.blit;
  const blitInfo = useMemo(() => (hoveredBlit ? blitTooltip(hoveredBlit) : undefined), [hoveredBlit]);

  return (
    // Size the flame area to the actual (capped) call-stack depth — canvas height plus the pan
    // scrollbar — instead of flex-filling the pane, so a shallow capture leaves the rest of the
    // space to the TimeView. A CSS max-height keeps the TimeView visible when the depth is large.
    // heightOverridePx (set by dragging the split divider in App.tsx) replaces both the
    // auto-computed height and the CSS max-height cap; canvas-wrap's own overflow-y:auto still
    // scrolls to any content that doesn't fit, same as the auto-sized case.
    <div
      className="flame"
      style={heightOverridePx !== undefined ? { height: heightOverridePx, maxHeight: "none" } : { height: height + HSCROLL_H }}
    >
      <div className="canvas-wrap" ref={canvasWrapRef}>
        <canvas
          ref={canvasRef}
          style={{ cursor: drag ? "grabbing" : hovered || blitHover ? "pointer" : "default" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onLostPointerCapture={() => setDrag(undefined)}
          onPointerCancel={() => setDrag(undefined)}
          onDoubleClick={onDoubleClick}
          onMouseLeave={() => {
            if (!drag) { setHovered(undefined); setDmaHover(undefined); setBlitHover(undefined); }
          }}
        />
        {dma && onSelectSlot && (
          <>
            <div
              className="time-ruler"
              style={{ height: TIMELINE_H }}
              onPointerDown={onScrubPointerDown}
              onPointerMove={onScrubPointerMove}
              onPointerUp={onScrubPointerUp}
              onLostPointerCapture={onScrubPointerUp}
            />
            {selectedSlot !== undefined && (
              <div
                className="time-handle"
                style={{
                  height: TIMELINE_H,
                  transform: `translateX(${(bounds.maxX - bounds.minX === 0 ? 0 : ((selectedSlot / dmaSlots - bounds.minX) / (bounds.maxX - bounds.minX)) * width) - 4}px)`,
                }}
                onPointerDown={onScrubPointerDown}
                onPointerMove={onScrubPointerMove}
                onPointerUp={onScrubPointerUp}
                onLostPointerCapture={onScrubPointerUp}
              />
            )}
          </>
        )}
      </div>
      <div className="hscroll" ref={scrollRef} onScroll={onScroll} style={{ width }}>
        <div ref={scrollChildRef} />
      </div>
      {hovered && hoverLoc && (
        <Tooltip x={hovered.x} y={hovered.y}>
          <div className="tt-func">
            <span className="dma-dot" style={{ background: hovered.box.fill }} />
            {hovered.box.text}
          </div>
          <div className="tt-loc">
            {hoverText ? <MiddleOut text={hoverText} endChars={fileEndChars} /> : "no source"}
          </div>
          <div className="tip-grid">
            <span className="tip-label">Total {dataName(displayUnit)}</span>
            <span className="tip-val">{formatValue(hoverLoc.selfTime + hoverLoc.aggregateTime, displayUnit, timing)}</span>

            <span className="tip-label">Self {dataName(displayUnit)}</span>
            <span className="tip-val">{formatValue(hoverLoc.selfTime, displayUnit, timing)}</span>

            {hoverLoc.aggregateTime > 0 && (
              <>
                <span className="tip-label">Aggregate {dataName(displayUnit)}</span>
                <span className="tip-val">{formatValue(hoverLoc.aggregateTime, displayUnit, timing)}</span>
              </>
            )}
          </div>
          {hoverLoc.callFrame.url && (
            <div className="tt-hint">{isMac ? "Cmd" : "Ctrl"}+Click to open source</div>
          )}
        </Tooltip>
      )}
      {dmaHover && dmaInfo?.style && (
        <Tooltip x={dmaHover.x} y={dmaHover.y} className="dma-tip" width={dmaInfo.doc ? 620 : 500}>
          <div className="tt-func">
            <span className="dma-dot" style={{ background: dmaInfo.style.color }} />
            {dmaInfo.style.label}
          </div>
          <div className="tip-grid">
            {/* Memory accesses show the bus Address; the associated Register (custom reg, or the
                channel's data register) gets its own row. Custom accesses have no separate Address. */}
            {!dmaInfo.isCustom && dmaInfo.showAddrData && (
              <>
                <span className="tip-label">Address</span>
                <span className="tip-val tt-addr">{dmaInfo.addrSymbol ?? dmaInfo.addrHex}</span>
              </>
            )}

            {dmaInfo.registerLabel && (
              <>
                <span className="tip-label">Register</span>
                <span className="tip-val">{dmaInfo.registerLabel}</span>
              </>
            )}

            {dmaInfo.showAddrData && (
              <>
                <span className="tip-label">Data</span>
                <span className="tip-val">{dmaInfo.data}</span>
              </>
            )}

            {dmaInfo.showAccess && (
              <>
                <span className="tip-label">Access</span>
                <span className="tip-val">{dmaInfo.access}</span>
              </>
            )}

            {dmaInfo.channels.length > 0 && (
              <>
                <span className="tip-label">DMA Control</span>
                <span className="tip-val bt-chips">
                  {dmaInfo.channels.map((c) => (
                    <span key={c.name} className={c.on ? "tt-bit on" : "tt-bit"}>{c.name}</span>
                  ))}
                </span>
              </>
            )}

            {dmaInfo.events.length > 0 && (
              <>
                <span className="tip-label">Events</span>
                <span className="tip-val bt-chips">
                  {dmaInfo.events.map((e) => (
                    <span key={e} className="tt-bit on">{e}</span>
                  ))}
                </span>
              </>
            )}

            <span className="tip-label">Line</span>
            <span className="tip-val">{dmaInfo.line}</span>

            <span className="tip-label">Color Clock</span>
            <span className="tip-val">{dmaInfo.colorClock}</span>

            {dmaInfo.callStack.length > 0 && (
              <>
                <span className="tip-label">CPU Call Stack</span>
                <span className="tip-val tt-addr">{dmaInfo.callStack.join(" › ")}</span>
              </>
            )}
          </div>
          {dmaInfo.doc && (
            <div className="dma-doc">
              <Markdown>{dmaInfo.doc}</Markdown>
            </div>
          )}
        </Tooltip>
      )}
      {blitHover && blitInfo && (
        <Tooltip x={blitHover.x} y={blitHover.y} className="blit-tip" width={480}>
          <BlitDetailGrid blit={blitHover.blit} info={blitInfo} symbolize={symbolize} displayUnit={displayUnit} timing={timing} />
          {onOpenMemory && (blitHover.blit.con0 & BLTCON0Flags.USED) !== 0 && (
            <div className="tt-hint">{isMac ? "Cmd" : "Ctrl"}+Click to jump to destination</div>
          )}
        </Tooltip>
      )}
    </div>
  );
}
