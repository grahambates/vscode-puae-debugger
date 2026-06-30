import { Fragment } from "react";
import { Blit, BlitTooltip, blitLabel } from "./blits";
import { blitStyle } from "./dma";
import { Symbolizer } from "./symbols";
import { DisplayUnit, Timing, formatValue } from "./display";

const bin16 = (v: number) => `%${(v & 0xffff).toString(2).padStart(16, "0")}`;

// The full blit-detail body (size, BLTCON chips, minterm, per-channel A/B/C/D, start/end/duration)
// as a `.tip-grid` — shared between the flame graph's hover tooltip and the Blitter view's detail
// pane, so the two never drift apart. `header` controls whether the label/swatch line is included
// (the flame tooltip wants it; the Blitter view already shows the label in its row list).
export function BlitDetailGrid({
  blit,
  info,
  symbolize,
  displayUnit,
  timing,
  header = true,
}: {
  blit: Blit;
  info: BlitTooltip;
  symbolize: Symbolizer;
  displayUnit: DisplayUnit;
  timing: Timing;
  header?: boolean;
}) {
  const blitAddr = (a: number) => {
    const hex = `$${(a >>> 0).toString(16).padStart(6, "0")}`;
    const sym = symbolize(a);
    return sym ? `${sym} (${hex})` : hex;
  };

  return (
    <>
      {header && (
        <div className="tt-func">
          <span className="dma-dot" style={{ background: blitStyle(blit.mode).color }} />
          {blitLabel(blit)}
        </div>
      )}
      <div className="tip-grid">
        <span className="tip-label">Size</span>
        <span className="tip-val">{info.size}</span>

        <span className="tip-label">Blitter Control</span>
        <span className="tip-val bt-chips">
          {info.control.map((c) => (
            <span key={c.name} className={c.on ? "tt-bit on" : "tt-bit"}>{c.name}</span>
          ))}
        </span>

        <span className="tip-label">Minterm</span>
        <span className="tip-val bt-chips">
          <span className="bt-mt">{info.mintermHex} {info.mintermExpr}</span>
          {info.mintermBits.map((c, i) => (
            <span key={i} className={c.on ? "tt-bit on" : "tt-bit"}>{c.name}</span>
          ))}
        </span>

        {info.line && (
          <>
            <span className="tip-label">Line</span>
            <span className="tip-val">
              <span className="bt-eh">Start</span> {info.line.start}
              <span className="bt-eh">Texture</span> {info.line.texture}
            </span>
          </>
        )}

        {info.channels.map((ch) => (
          <Fragment key={ch.label}>
            <span className="tip-label">{ch.label}</span>
            <span className="tip-val">
              {ch.literal !== undefined ? (
                bin16(ch.literal)
              ) : (
                <>
                  <span>{blitAddr(ch.ptr!)}</span>
                  {ch.shift !== undefined && <><span className="bt-eh">Shift</span> {ch.shift}</>}
                  <span className="bt-eh">Modulo</span> {ch.modulo}
                </>
              )}
            </span>
            {ch.fwm !== undefined && (
              <>
                <span className="tip-label">Masks</span>
                <span className="tip-val">
                  <span className="bt-eh">FWM</span> {bin16(ch.fwm)}
                  <span className="bt-eh">LWM</span> {bin16(ch.lwm!)}
                </span>
              </>
            )}
          </Fragment>
        ))}

        <span className="tip-label">Start</span>
        <span className="tip-val">Line {info.start.line}, Color Clock {info.start.colorClock}, DMA Cycle {info.start.slot}</span>
        {info.end && (
          <>
            <span className="tip-label">End</span>
            <span className="tip-val">Line {info.end.line}, Color Clock {info.end.colorClock}, DMA Cycle {info.end.slot}</span>
            <span className="tip-label">Duration</span>
            <span className="tip-val">{info.end.durationSlots} DMA Cycles ({formatValue(info.end.durationSlots * 2, displayUnit, timing)})</span>
          </>
        )}
      </div>
    </>
  );
}
