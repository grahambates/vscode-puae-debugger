// Visual (bitmap) mode for the profiler Memory View — renders reconstructed chip/slow RAM as a
// 1-bit-per-pixel canvas, identical pixel encoding to the live memory viewer's VisualView
// (each byte = 8 horizontal pixels, MSB first) but reading synchronously from the already-loaded
// byte buffer rather than the live viewer's async chunked pattern.
// Use forwardRef so MemoryView can call scrollToOffset() for "Follow writes" and combo-nav.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { guessWidthsUnknownLength } from "../shared/strideGuesser";
import { isMac } from "../shared/platform";

const PIXELS_PER_BYTE = 8;  // each byte → 8 horizontal pixels (one per bit, MSB first)
const BUFFER_ROWS = 20;     // extra rows rendered beyond the visible viewport

export interface MemoryVisualAPI {
  // `widthBytes`, if given (and in range), also sets the row width — e.g. a blit's channel
  // width+modulo, so the image lines up with that buffer's actual stride instead of whatever
  // width happened to be set before. Applied atomically with the alignment phase (see
  // skipNextPhaseResetRef below) so the two don't fight across renders.
  // `align`: "start" (default) always (re)centres the target row, for a deliberate jump (combo
  // box, blit link, ...). "smart" — mirroring react-window's List align mode, for Follow Writes —
  // only scrolls if the target row isn't already fully visible, so scrubbing through consecutive
  // writes to the same on-screen buffer doesn't re-centre on every single one.
  scrollToOffset(off: number, alignOff?: number, widthBytes?: number, align?: "start" | "smart"): void;
}

interface Props {
  getByte: (off: number) => number | undefined;
  getFadeOpacity: (off: number) => number;
  bufLength: number;
  bufVersion: number; // bumped when buffer contents change, forces redraw
  fadeTick: number;   // bumped on each animation frame while fades are active
  baseAddr: number;
  highlightOffset: number | undefined; // offset of the current-write highlight
  onByteClick: (addr: number, jumpToSource: boolean, toSide: boolean, forward: boolean) => void;
  onByteHover: (addr: number, x: number, y: number) => void;
  onByteLeave: () => void;
  // Initial row width (1..512), e.g. from a blit jump request that arrived before this component
  // ever mounted — lets the very first render already use it instead of the 40-byte default.
  initialBytesPerRow?: number;
}

export const MemoryVisual = forwardRef<MemoryVisualAPI, Props>(function MemoryVisual({
  getByte, getFadeOpacity, bufLength, bufVersion, fadeTick, baseAddr, highlightOffset,
  onByteClick, onByteHover, onByteLeave, initialBytesPerRow,
}, ref) {
  const validInitialWidth = initialBytesPerRow && initialBytesPerRow >= 1 && initialBytesPerRow <= 512
    ? initialBytesPerRow
    : undefined;
  const [bytesPerRow, setBytesPerRow] = useState(validInitialWidth ?? 40); // 40 bytes = 320px lores bitplane row
  const [bytesPerRowInput, setBytesPerRowInput] = useState(String(validInitialWidth ?? 40));
  const [scale, setScale] = useState(2);
  // rowPhase: number of leading "empty" columns before byte 0. When set to
  // (bytesPerRow - addr%bytesPerRow) % bytesPerRow, the selected address lands
  // exactly at column 0 of its row, aligning the image to the left edge.
  const [rowPhase, setRowPhase] = useState(0);
  const pendingScrollRef = useRef<{ off: number; phase: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [visibleRange, setVisibleRange] = useState({ first: 0, last: 0 });
  // Tracks the previous bytesPerRow (for the phase-reset effect below) and whether the next
  // bytesPerRow change came from scrollToOffset itself (which already set the correct phase for
  // the new width, so that effect should leave rowPhase alone instead of zeroing it).
  const prevBprRef = useRef(bytesPerRow);
  const skipNextPhaseResetRef = useRef(false);

  const totalRows = bufLength > 0 ? Math.ceil((bufLength + rowPhase) / bytesPerRow) : 0;
  const rowH = scale;
  const canvasW = bytesPerRow * PIXELS_PER_BYTE * scale;

  // ── Scroll handling ──────────────────────────────────────────────────────────

  const recalcVisible = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const first = Math.max(0, Math.floor(el.scrollTop / rowH) - BUFFER_ROWS);
    const last = Math.min(totalRows, Math.ceil((el.scrollTop + el.clientHeight) / rowH) + BUFFER_ROWS);
    setVisibleRange((prev) => (prev.first === first && prev.last === last ? prev : { first, last }));
  }, [rowH, totalRows]);

  useEffect(() => { recalcVisible(); }, [recalcVisible]);

  useImperativeHandle(ref, () => ({
    scrollToOffset(off: number, alignOff = off, widthBytes?: number, align: "start" | "smart" = "start") {
      const widthChanging = widthBytes !== undefined && widthBytes >= 1 && widthBytes <= 512 && widthBytes !== bytesPerRow;
      const bpr = widthChanging ? widthBytes : bytesPerRow;
      // Compute phase so that `alignOff` (default: same as off) lands at column 0 of its row.
      // Pass a symbol's base offset as alignOff to keep the whole image aligned to that label.
      const newPhase = (bpr - alignOff % bpr) % bpr;
      pendingScrollRef.current = { off, phase: newPhase };
      if (widthChanging) {
        // Set width and phase together (same tick — React batches this into one render) so the
        // phase-reset effect below sees skipNextPhaseResetRef and leaves our phase alone instead
        // of zeroing it out from under us.
        skipNextPhaseResetRef.current = true;
        setBytesPerRow(bpr);
        setRowPhase(newPhase);
      } else if (newPhase !== rowPhase) {
        setRowPhase(newPhase); // triggers re-render; useLayoutEffect below applies the scroll
      } else {
        // Phase and width unchanged: React skips re-render, so decide/apply the scroll directly
        // now. "smart" (Follow Writes) only recentres if the row isn't already fully on screen —
        // otherwise every write to an already-visible buffer would re-centre the view on each one.
        const el = containerRef.current;
        if (el) {
          const row = Math.floor((off + newPhase) / bpr);
          const rowTop = row * rowH;
          const alreadyVisible = rowTop >= el.scrollTop && rowTop + rowH <= el.scrollTop + el.clientHeight;
          if (align !== "smart" || !alreadyVisible) {
            el.scrollTop = Math.max(0, rowTop - el.clientHeight / 2);
          }
        }
        pendingScrollRef.current = null;
      }
    },
  }), [bytesPerRow, rowH, rowPhase]);

  // After a rowPhase change re-renders the canvas (and the wrapper div height updates),
  // apply the deferred scroll so the target row is centred in view.
  useLayoutEffect(() => {
    const pending = pendingScrollRef.current;
    if (!pending) return;
    pendingScrollRef.current = null;
    const el = containerRef.current;
    if (!el) return;
    const row = Math.floor((pending.off + pending.phase) / bytesPerRow);
    el.scrollTop = Math.max(0, row * rowH - el.clientHeight / 2);
  }, [rowPhase, bytesPerRow, rowH]);

  // Re-sync width input when state is set externally (e.g. stride guesser).
  useEffect(() => { setBytesPerRowInput(String(bytesPerRow)); }, [bytesPerRow]);

  // Reset row phase when bytesPerRow changes — the old phase may be >= new width, which
  // would produce invalid (negative or out-of-bounds) byte offsets in the canvas loop. Skipped
  // when scrollToOffset just set width+phase together (skipNextPhaseResetRef) — that phase was
  // computed FOR the new width and would otherwise get clobbered back to 0 right after.
  useEffect(() => {
    if (bytesPerRow !== prevBprRef.current) {
      prevBprRef.current = bytesPerRow;
      if (skipNextPhaseResetRef.current) skipNextPhaseResetRef.current = false;
      else setRowPhase(0);
    }
  }, [bytesPerRow]);

  // ── Canvas draw ──────────────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { first, last } = visibleRange;
    const numRows = last - first;
    if (numRows <= 0) return;

    const h = numRows * rowH;
    canvas.width = canvasW;
    canvas.height = h;
    canvas.style.width = `${canvasW}px`;
    canvas.style.height = `${h}px`;

    const styles = getComputedStyle(document.documentElement);
    const fg = styles.getPropertyValue("--vscode-editor-foreground").trim() || "#d4d4d4";
    const bg = styles.getPropertyValue("--vscode-editor-background").trim() || "#1e1e1e";
    const focusBorder = styles.getPropertyValue("--vscode-focusBorder").trim() || "#007acc";

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvasW, h);

    for (let row = first; row < last; row++) {
      const canvasY = (row - first) * rowH;
      for (let col = 0; col < bytesPerRow; col++) {
        const off = row * bytesPerRow + col - rowPhase;
        if (off < 0 || off >= bufLength) continue;
        const byte = getByte(off);
        if (byte === undefined) continue;

        // Draw 8 pixels per byte, MSB first (same convention as live VisualView).
        ctx.fillStyle = fg;
        for (let bit = 7; bit >= 0; bit--) {
          if (byte & (1 << bit)) {
            ctx.fillRect((col * PIXELS_PER_BYTE + (7 - bit)) * scale, canvasY, scale, rowH);
          }
        }

        // Change-fade overlay — semi-transparent yellow matching the hex view.
        const fade = getFadeOpacity(off);
        if (fade > 0) {
          ctx.fillStyle = `rgba(255,200,0,${(fade * 0.6).toFixed(3)})`;
          ctx.fillRect(col * PIXELS_PER_BYTE * scale, canvasY, PIXELS_PER_BYTE * scale, rowH);
        }

        // Current-write highlight (outline, matching hex view's .mem-hit outline).
        if (off === highlightOffset) {
          ctx.strokeStyle = focusBorder;
          ctx.lineWidth = 1;
          ctx.strokeRect(
            col * PIXELS_PER_BYTE * scale + 0.5,
            canvasY + 0.5,
            PIXELS_PER_BYTE * scale - 1,
            rowH - 1,
          );
        }
      }
    }
  }, [bufVersion, fadeTick, visibleRange, bytesPerRow, rowPhase, scale, highlightOffset,
    getByte, getFadeOpacity, bufLength, canvasW, rowH]);

  // ── Interaction ──────────────────────────────────────────────────────────────

  // Resolve a canvas mouse event to a byte offset (or undefined if out of bounds).
  const canvasOffset = (e: React.MouseEvent<HTMLCanvasElement>): number | undefined => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const rect = canvas.getBoundingClientRect();
    const col = Math.floor((e.clientX - rect.left) / (scale * PIXELS_PER_BYTE));
    const row = visibleRange.first + Math.floor((e.clientY - rect.top) / rowH);
    if (col < 0 || col >= bytesPerRow) return undefined;
    const off = row * bytesPerRow + col - rowPhase;
    return off >= 0 && off < bufLength ? off : undefined;
  };

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const off = canvasOffset(e);
    if (off !== undefined) onByteClick(baseAddr + off, e.ctrlKey || e.metaKey, e.altKey, e.shiftKey);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const off = canvasOffset(e);
    if (off !== undefined) onByteHover(baseAddr + off, e.clientX, e.clientY);
    else onByteLeave();
  };

  // ── Stride guesser ───────────────────────────────────────────────────────────

  const handleGuessWidth = () => {
    // Sample up to 16 KB from the currently visible area for better relevance.
    const startOff = visibleRange.first * bytesPerRow;
    const sampleLen = Math.min(16384, bufLength - startOff);
    if (sampleLen < 16) return;
    const sample = new Uint8Array(sampleLen);
    for (let i = 0; i < sampleLen; i++) sample[i] = getByte(startOff + i) ?? 0;
    const guess = guessWidthsUnknownLength(sample);
    if (guess) setBytesPerRow(guess.widthBytes);
  };

  const commitBytesPerRow = () => {
    const n = parseInt(bytesPerRowInput, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= 512) setBytesPerRow(n);
    else setBytesPerRowInput(String(bytesPerRow));
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="memvisual">
      <div className="memvisual-toolbar">
        <label className="memvisual-label">Width</label>
        <input
          className="memvisual-width"
          type="number"
          min={1}
          max={512}
          value={bytesPerRowInput}
          onChange={(e) => setBytesPerRowInput(e.target.value)}
          onBlur={commitBytesPerRow}
          onKeyDown={(e) => e.key === "Enter" && commitBytesPerRow()}
          title="Bytes per row (40 = 320px Amiga low-res bitplane)"
        />
        <button className="memvisual-btn" onClick={handleGuessWidth} title="Auto-detect width from visible data">
          Guess width
        </button>
        <label className="memvisual-label">Scale</label>
        <select
          className="memvisual-scale"
          value={scale}
          onChange={(e) => setScale(Number(e.target.value))}
        >
          {[1, 2, 3, 4, 5].map((s) => <option key={s} value={s}>{s}×</option>)}
        </select>
        <span className="memvisual-hint">{isMac ? "Cmd" : "Ctrl"}+Click to open source · Shift+Click: next write</span>
      </div>
      <div
        ref={containerRef}
        className="memvisual-scroll"
        onScroll={recalcVisible}
      >
        {/* Virtual full-height div; canvas only covers the visible window. */}
        <div style={{ height: totalRows * rowH, position: "relative" }}>
          <canvas
            ref={canvasRef}
            style={{
              position: "absolute",
              top: visibleRange.first * rowH,
              cursor: "crosshair",
              imageRendering: "pixelated",
            }}
            onClick={handleClick}
            onMouseMove={handleMouseMove}
            onMouseLeave={onByteLeave}
          />
        </div>
      </div>
    </div>
  );
});
