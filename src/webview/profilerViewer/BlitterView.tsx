import { useEffect, useMemo, useRef } from "react";
import { getProfileModel } from "./modelStore";
import { getBlits, blitLabel, blitTooltip, blitChannels, Blit } from "./blits";
import { blitStyle } from "./dma";
import { BlitDetailGrid } from "./BlitDetail";
import { createSymbolizer } from "./symbols";
import { DisplayUnit, Timing } from "./display";
import { DMA_HPOS } from "../../shared/profilerTypes";

// List of blits reconstructed for the captured frame (the old vscode-amiga-debug
// debugger/blitter.tsx, ported, minus the per-channel source-data canvases), linked to the
// shared time cursor: highlights whichever blit is current at `selectedSlot`, auto-scrolls to
// it, and shows its full tooltip-grade detail (BlitDetailGrid, shared with the flame graph's
// hover tooltip) below the list. Clicking a row jumps the playhead to that blit's start.
export function BlitterView({
  selectedSlot,
  onSelectSlot,
  displayUnit,
  timing,
}: {
  selectedSlot: number | undefined;
  onSelectSlot: (slot: number) => void;
  displayUnit: DisplayUnit;
  timing: Timing;
}) {
  const model = getProfileModel();
  const dma = model?.dma;
  const symbolize = useMemo(() => createSymbolizer(model?.symbols), [model]);
  const blitResult = useMemo(() => (dma ? getBlits(dma) : { blits: [] as Blit[], fastBlitter: false }), [dma]);
  const blits = blitResult.blits;
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Latest blit whose start is <= selectedSlot (blits are in execution order, so startSlot is
  // monotonically increasing — binary search for the floor), defaulting to the last blit.
  const currentIndex = useMemo(() => {
    if (blits.length === 0) return -1;
    if (selectedSlot === undefined) return blits.length - 1;
    let lo = 0;
    let hi = blits.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (blits[mid].startSlot <= selectedSlot) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return idx < 0 ? 0 : idx;
  }, [blits, selectedSlot]);

  useEffect(() => {
    rowRefs.current[currentIndex]?.scrollIntoView({ block: "nearest" });
  }, [currentIndex]);

  if (!model) return null;
  if (!dma || blits.length === 0) {
    return <div className="hint">No blits reconstructed for this frame.</div>;
  }

  const current = currentIndex >= 0 ? blits[currentIndex] : undefined;
  const currentInfo = current ? blitTooltip(current) : undefined;

  return (
    <div className="blitterview">
      <div className="bv-rows">
        {blits.map((b, i) => (
          <div
            key={i}
            ref={(el) => { rowRefs.current[i] = el; }}
            className={"bv-row" + (i === currentIndex ? " bv-current" : "")}
            onClick={() => onSelectSlot(b.startSlot)}
          >
            <span className="dma-dot" style={{ background: blitStyle(b.mode).color }} />
            <span className="bv-label">{blitLabel(b)}</span>
            <span className="bv-channels">{blitChannels(b.con0)}</span>
            <span className="bv-pos">
              {Math.floor(b.startSlot / DMA_HPOS)},{b.startSlot % DMA_HPOS}
            </span>
            {!b.finished && <span className="bv-unfinished">unfinished</span>}
          </div>
        ))}
        {blitResult.fastBlitter && (
          <div className="hint">blitter accuracy &lt; 2 — spans/ends are estimated</div>
        )}
      </div>
      {current && currentInfo && (
        <div className="bv-detail">
          <BlitDetailGrid blit={current} info={currentInfo} symbolize={symbolize} displayUnit={displayUnit} timing={timing} />
        </div>
      )}
    </div>
  );
}
