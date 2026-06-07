import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Category, ILocation, DMA_WRITE, DMA_BYTE, DMA_HPOS, dmaIsCustomReg } from "../../shared/profilerTypes";
import { getProfileModel } from "./modelStore";
import { buildColumns, IColumn, IColumnLocation } from "./columns";
import { binarySearch } from "./array";
import { dataName, DisplayUnit, formatValue, scaleValue, Timing } from "./display";
import { compileFilter, IRichFilter } from "./filter";
import { channelStyle } from "./dma";
import { createSymbolizer } from "./symbols";
import { customRegisterName } from "../shared/customRegisters";
import { MiddleOut } from "./MiddleOut";

// Time-ordered flame chart on a 2D canvas. x = cycles in execution order (the old
// vscode-amiga-debug model, ported as data — see columns.ts), depth grows downward.
// Visible window is `bounds` (0..1 of the frame). Interaction is ported from the old
// renderer: drag the canvas to pan (with click-vs-drag detection), mouse wheel zooms
// centred on the cursor (shift = pan), a synced scrollbar pans, double-click / Enter
// zooms the focused box, arrows navigate, Esc resets, Ctrl/Cmd+click jumps to source.

const ROW_H = 18;
const TIMELINE_H = 18;
const DMA_BAND_H = 18; // height of the DMA channel line above the CPU rows
const Y_BUFFER = 8;
const MIN_LABEL_W = 28; // px; narrower boxes get no text
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
    for (let y = 0; y < col.rows.length; y++) {
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

const locText = (loc: ILocation): string | undefined =>
  loc.callFrame.url
    ? `${loc.callFrame.url}${loc.callFrame.lineNumber >= 0 ? `:${loc.callFrame.lineNumber}` : ""}`
    : undefined;

export function FlameGraph({
  displayUnit,
  filter,
  onOpenSource,
}: {
  displayUnit: DisplayUnit;
  filter: IRichFilter;
  onOpenSource: (file: string, line: number, toSide: boolean) => void;
}) {
  // The model is read from the external store (not a prop) so its large arrays never go through
  // React's serializer. FlameGraph is only rendered when a model exists (App guards it), and it
  // re-renders with its parent, so this read is non-null and current.
  // eslint-disable-next-line react-hooks/purity -- model is read from an external store (modelStore)
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
  const [focused, setFocused] = useState<IBox | undefined>(undefined);
  const [drag, setDrag] = useState<IDrag | undefined>(undefined);

  // DMA channel line (captured in the same frame). A band of DMA_BAND_H sits between
  // the timeline ruler and the CPU rows, which are shifted down by the band height.
  const dma = model.dma;
  const dmaSlots = dma ? dma.owner.length : 0;
  const bandH = dma ? DMA_BAND_H : 0;
  const yOffset = TIMELINE_H + bandH;

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

    // DMA channel line: one row per dma-cycle, colored by bus owner (CPU Code/Data,
    // Copper MOVE/WAIT/SKIP, etc.). Drawn directly off the typed arrays, coalescing
    // adjacent same-color slots into one fillRect at draw time (the box MODEL stays
    // per-cycle for tooltips). Only the visible slot range is touched.
    if (dma && dmaSlots > 0) {
      const N = dmaSlots;
      const bandY = TIMELINE_H;
      const sLo = Math.max(0, Math.floor(bounds.minX * N));
      const sHi = Math.min(N, Math.ceil(bounds.maxX * N) + 1);
      let runStart = -1;
      let runColor = "";
      const flushRun = (end: number) => {
        if (runStart < 0) return;
        const x1 = Math.max(0, toX(runStart / N));
        const x2 = Math.min(width, toX(end / N));
        if (x2 > x1) ctx.fillRect(x1, bandY, Math.max(x2 - x1, MIN_DRAW_W), DMA_BAND_H - 1);
        runStart = -1;
      };
      for (let i = sLo; i < sHi; i++) {
        const st = channelStyle(dma.owner[i], dma.flags[i]);
        const c = st ? st.color : "";
        if (c !== runColor) {
          flushRun(i);
          runColor = c;
          if (c) { runStart = i; ctx.fillStyle = c; }
        }
      }
      flushRun(sHi);
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

    // Boxes. Labels use the UI font (no glyph cache / monospace requirement anymore).
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
        ctx.fillStyle = dim ? "rgba(255,255,255,0.4)" : b.textDark ? "#000" : "#fff";
        // Proportional font: measure-and-truncate rather than estimate a fixed char width.
        const maxW = cw - 6;
        let label = b.text;
        if (ctx.measureText(label).width > maxW) {
          while (label.length > 0 && ctx.measureText(label + "…").width > maxW) label = label.slice(0, -1);
          label += "…";
        }
        ctx.save();
        ctx.beginPath();
        ctx.rect(cx, b.y1, cw, ROW_H);
        ctx.clip();
        ctx.fillText(label, cx + 3, b.y1 + ROW_H / 2);
        ctx.restore();
      }
    }
  }, [boxes, width, height, bounds, hovered, focused, duration, displayUnit, timing, matches, dma, dmaSlots, dmaHover]);

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
    (x: number): string[] => {
      let col = binarySearch(columns, (c) => c.x2 - x);
      if (col < 0) col = -col - 1;
      const column = columns[col];
      if (!column) return [];
      const names: string[] = [];
      for (let y = 0; y < column.rows.length; y++) {
        let cell = column.rows[y];
        if (typeof cell === "number") cell = columns[cell].rows[y];
        if (cell !== undefined && typeof cell !== "number") {
          names.push((cell as IColumnLocation).callFrame.functionName);
        }
      }
      return names;
    },
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
      return;
    }
    setDmaHover(undefined);
    const box = boxAt(mx, my);
    setHovered(box ? { box, x: e.clientX, y: e.clientY } : undefined);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drag) return;
    // A click (not a drag): short, with little pointer travel — select / jump.
    const isClick = Date.now() - drag.timestamp < 500 && Math.abs(e.pageX - drag.pageXOrigin) < 100;
    if (isClick && hovered) {
      setFocused(hovered.box);
      const loc = hovered.box.loc;
      if ((e.ctrlKey || e.metaKey) && loc.callFrame.url) {
        onOpenSource(loc.callFrame.url, loc.callFrame.lineNumber, e.altKey);
      }
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
  const hoverText = hoverLoc ? locText(hoverLoc) : undefined;
  // Keep the whole filename visible in the middle-ellipsis; only the directory truncates.
  const fileEndChars = hoverText
    ? hoverText.length - (Math.max(hoverText.lastIndexOf("/"), hoverText.lastIndexOf("\\")) + 1)
    : 8;
  // Clamp the tooltip into the viewport so it never runs off the right/bottom edge.
  const TIP_W = 480;
  const TIP_H = 150;
  const tipLeft = hovered ? Math.max(8, Math.min(hovered.x + 12, window.innerWidth - TIP_W - 8)) : 0;
  const tipTop = hovered ? Math.max(8, Math.min(hovered.y + 12, window.innerHeight - TIP_H - 8)) : 0;

  // DMA band hover info — mirrors the old extension's DMA tooltip: channel, symbolized
  // Address (call-stack for code) or custom Register name, sized Data, R/W + size, and the
  // raster Line / Color Clock decoded from the slot index.
  const dmaInfo = (() => {
    if (!dmaHover || !dma) return undefined;
    const slot = dmaHover.slot;
    const owner = dma.owner[slot];
    const flags = dma.flags[slot];
    const addr = dma.addr[slot] >>> 0;
    const isWrite = !!(flags & DMA_WRITE);
    const isByte = !!(flags & DMA_BYTE);
    const isCustom = dmaIsCustomReg(owner, flags, addr);
    const off = addr & 0x1fe;
    // Custom register → name ($offset); otherwise symbolize the bus address.
    const symbol = isCustom
      ? `${customRegisterName(off) ?? "custom"} ($${off.toString(16).padStart(3, "0")})`
      : symbolize(addr);
    const data = isByte
      ? `$${(dma.value[slot] & 0xff).toString(16).padStart(2, "0")}`
      : `$${dma.value[slot].toString(16).padStart(4, "0")}`;
    return {
      style: channelStyle(owner, flags),
      isCustom,
      symbol,
      addrHex: `$${addr.toString(16).padStart(6, "0")}`,
      data,
      access: `${isWrite ? "Write" : "Read"}${isByte ? ".B" : ".W"}`,
      line: Math.floor(slot / DMA_HPOS),
      colorClock: slot % DMA_HPOS,
      // CPU call stack at this instant (outer→leaf), from the flame columns at this x.
      callStack: stackAtX((slot + 0.5) / dmaSlots),
    };
  })();
  const dmaTipLeft = dmaHover ? Math.max(8, Math.min(dmaHover.x + 12, window.innerWidth - 360 - 8)) : 0;
  const dmaTipTop = dmaHover ? Math.max(8, Math.min(dmaHover.y + 12, window.innerHeight - 170 - 8)) : 0;

  return (
    <div className="flame">
      <div className="canvas-wrap" ref={canvasWrapRef}>
        <canvas
          ref={canvasRef}
          style={{ cursor: drag ? "grabbing" : hovered ? "pointer" : "default" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onLostPointerCapture={() => setDrag(undefined)}
          onPointerCancel={() => setDrag(undefined)}
          onDoubleClick={onDoubleClick}
          onMouseLeave={() => {
            if (!drag) { setHovered(undefined); setDmaHover(undefined); }
          }}
        />
      </div>
      <div className="hscroll" ref={scrollRef} onScroll={onScroll} style={{ width }}>
        <div ref={scrollChildRef} />
      </div>
      {hovered && hoverLoc && (
        <div className="tooltip" style={{ left: tipLeft, top: tipTop }}>
          <div className="tt-func">{hovered.box.text}</div>
          <div className="tt-loc">
            {hoverText ? <MiddleOut text={hoverText} endChars={fileEndChars} /> : "no source"}
          </div>
          <div className="tt-row">
            <span>Total {dataName(displayUnit)}</span>
            <span>{formatValue(hoverLoc.selfTime + hoverLoc.aggregateTime, displayUnit, timing)}</span>
          </div>
          <div className="tt-row">
            <span>Self {dataName(displayUnit)}</span>
            <span>{formatValue(hoverLoc.selfTime, displayUnit, timing)}</span>
          </div>
          {hoverLoc.aggregateTime > 0 && (
            <div className="tt-row">
              <span>Aggregate {dataName(displayUnit)}</span>
              <span>{formatValue(hoverLoc.aggregateTime, displayUnit, timing)}</span>
            </div>
          )}
          {hoverLoc.callFrame.url && <div className="tt-hint">Ctrl+Click to open source</div>}
        </div>
      )}
      {dmaHover && dmaInfo?.style && (
        <div className="tooltip" style={{ left: dmaTipLeft, top: dmaTipTop, width: 360 }}>
          <div className="tt-func">
            <span className="dma-dot" style={{ background: dmaInfo.style.color }} />
            {dmaInfo.style.label}
          </div>
          {dmaInfo.isCustom ? (
            <div className="tt-row">
              <span>Register</span>
              <span>{dmaInfo.symbol ?? dmaInfo.addrHex}</span>
            </div>
          ) : (
            <div className="tt-row">
              <span>Address</span>
              <span className="tt-addr">{dmaInfo.symbol ?? dmaInfo.addrHex}</span>
            </div>
          )}
          <div className="tt-row">
            <span>Data</span>
            <span>{dmaInfo.data}</span>
          </div>
          <div className="tt-row">
            <span>Access</span>
            <span>{dmaInfo.access}</span>
          </div>
          <div className="tt-row">
            <span>Line</span>
            <span>{dmaInfo.line}</span>
          </div>
          <div className="tt-row">
            <span>Color Clock</span>
            <span>{dmaInfo.colorClock}</span>
          </div>
          {dmaInfo.callStack.length > 0 && (
            <>
              <div className="tt-loc" style={{ marginTop: 4 }}>CPU call stack</div>
              <div className="tt-addr">{dmaInfo.callStack.join(" › ")}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
