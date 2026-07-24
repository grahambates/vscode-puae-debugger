import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IProfileModel } from "../../shared/profilerTypes";
import { disassembleCopperInstruction } from "../../shared/copperDisassembler";
import {
  buildScreenFromModel, computeBeamPosition, computeHoverExtra, computeLineMode, computeSlotFromBeamPosition,
  decodeScreenPixels, PixelSnapshot,
} from "./gfxResources";

interface ResourcesViewProps {
  selectedSlot: number | undefined;
  model: IProfileModel | null | undefined;
  // Jumps the shared timeline playhead to a clicked pixel's DMA slot (computeSlotFromBeamPosition).
  // Absent in contexts that don't want the screen view driving the playhead.
  onSelectSlot?: (slot: number) => void;
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

// ── Component ─────────────────────────────────────────────────────────────────

export function ResourcesView({ model, selectedSlot, onSelectSlot }: ResourcesViewProps) {
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
    const snapshot = decodeScreenPixels(model, screen, planeVis, spriteVis);
    if (!snapshot) return;
    const { width, height, colors, activeSpritesMask } = snapshot;

    cvs.width  = width  * scale;
    cvs.height = height * scale;
    const ctx     = cvs.getContext("2d")!;
    const imgData = ctx.createImageData(cvs.width, cvs.height);
    const data    = new Uint32Array(imgData.data.buffer);
    for (let y = 0; y < height; y++) {
      for (let px = 0; px < width; px++) {
        const color = colors[y * width + px];
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            data[((y * scale + sy) * cvs.width) + (px * scale + sx)] = color;
          }
        }
      }
    }
    ctx.putImageData(imgData, 0, 0);
    pixelSnap.current = snapshot;
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

  // Jump the shared timeline playhead to whichever DMA slot drew the clicked pixel — the inverse
  // of the beam-position crosshair (computeBeamPosition), so this is a two-way sync.
  const onClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onSelectSlot) return;
    const sc = screenRef.current;
    if (!sc) return;
    const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    const logX = Math.floor((e.clientX - rect.left) / scale);
    const logY = Math.floor((e.clientY - rect.top)  / scale);
    if (logX < 0 || logX >= sc.width || logY < 0 || logY >= sc.height) return;
    onSelectSlot(computeSlotFromBeamPosition(sc, logX, logY));
  }, [scale, onSelectSlot]);
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

  const { numPlanes, hires, shres, ham, dpf, staticPlanes, modeChanges, diwLeft, diwRight, diwTop, diwBottom } = screen;
  // The info line used to report the canvas's fixed border size (screen.width/height — a standard
  // PAL preset, not what was actually displayed) and one frame-wide mode label. Width + mode now
  // track whatever's in effect at the current playhead position (computeLineMode) instead, so a
  // copper split that changes plane count/resolution/DIW partway down the frame shows correctly as
  // you scrub — falling back to the display-start values (same as before) when nothing's selected
  // yet. Height stays the whole-frame DIW vertical extent: unlike width, "at this line" isn't a
  // meaningful way to describe a single scanline's height.
  const lineMode = selectedSlot !== undefined ? computeLineMode(model!, selectedSlot) : undefined;
  const m = lineMode ?? { numPlanes, hires, shres, ham, dpf, staticPlanes, width: diwRight - diwLeft };
  const modeStr = `${m.numPlanes}-plane${m.shres ? " super-hires" : m.hires ? " hires" : " lores"}${m.ham ? " HAM" : ""}${m.dpf ? " DPF" : ""}${m.staticPlanes ? " (7-plane trick)" : ""}`;
  // modeChanges only tracks BPLCON0 (plane count/resolution/HAM/DPF) splits, not a DIW-only
  // resize — a known gap, same honesty as IScreen.modeChanges's own doc comment.
  const info = `${m.width}×${diwBottom - diwTop} · ${modeStr}${modeChanges ? " (varies elsewhere in frame)" : ""}`;

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
        <div className="resources-btn-group">
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
        </div>
        {activeSpritesMask !== 0 && (
          <div className="resources-btn-group">
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
          </div>
        )}
      </div>
      <div className="resources-canvas-wrap">
        <div className="resources-canvas-inner">
          <canvas
            ref={canvas}
            style={{ imageRendering: "pixelated", cursor: "crosshair" }}
            onMouseMove={onMouseMove}
            onMouseLeave={onMouseLeave}
            onClick={onClick}
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
