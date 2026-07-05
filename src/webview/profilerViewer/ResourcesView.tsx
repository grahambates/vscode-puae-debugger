import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BusOwner, IProfileModel } from "../../shared/profilerTypes";
import { disassembleCopperInstruction } from "../../shared/copperDisassembler";
import { buildScreenFromModel, DMA_HPOS } from "./gfxResources";
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
}

interface PixelSnapshot {
  rawBits:  Uint8Array;
  colorIdx: Uint8Array;
  colors:   Uint32Array;
  palettes: Uint32Array[];
  width: number;
  height: number;
  firstLine: number;
  numPlanes: number;
  ham: boolean;
}

const expand4 = (v: number) => v * 0x11;

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
  const r = c & 0xff;
  const g = (c >>> 8) & 0xff;
  const b = (c >>> 16) & 0xff;
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

// On-demand per-pixel extra data: BPL fetch addresses, Agnus CCK, BPLCON0 and
// copper instruction at the hovered scan line. Computed in the mousemove handler
// from the DMA grid and copper trace (~200-400 iterations — fast enough).
function computeHoverExtra(
  model: IProfileModel,
  firstLine: number,
  logY: number,
  logX: number,
  numPlanes: number,
): Pick<HoverInfo, "cck" | "planeAddrs" | "bplcon0" | "copperInstr"> {
  const dma = model.dma!;
  const copper = model.copper;
  const custom = model.dmaSnapshot?.custom ?? new Uint16Array(256);
  const vpos = firstLine + logY;
  const wx = logX >> 4;

  // BPL fetch addresses and CCK for the word at column wx on this scan line.
  const lineBase = vpos * DMA_HPOS;
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

  // Walk copper trace forward: accumulate BPLCON0, track the last instruction
  // executed at or before the hovered vpos.
  let bplcon0 = custom[R.BPLCON0 >> 1];
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

export function ResourcesView({ model }: ResourcesViewProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [scale, setScale] = useState(2);
  const [planeVis, setPlaneVis] = useState<boolean[]>(Array(6).fill(true));
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [hoverClientPos, setHoverClientPos] = useState({ x: 0, y: 0 });
  const pixelSnap = useRef<PixelSnapshot | null>(null);
  const modelRef = useRef<IProfileModel | null | undefined>(undefined);
  const screenRef = useRef<ReturnType<typeof buildScreenFromModel>>(undefined);

  const screen = useMemo(() => (model ? buildScreenFromModel(model) : undefined), [model]);

  // Keep refs in sync for the mousemove handler (avoids stale closure without
  // forcing the handler to re-create on every model/screen change).
  useEffect(() => { modelRef.current = model; }, [model]);
  useEffect(() => { screenRef.current = screen; }, [screen]);

  // Reset plane visibility when the number of planes changes.
  const prevNumPlanes = useRef(0);
  if (screen && screen.numPlanes !== prevNumPlanes.current) {
    prevNumPlanes.current = screen.numPlanes;
    if (planeVis.slice(0, screen.numPlanes).some((v, i) => !v && i < screen.numPlanes)) {
      setPlaneVis(Array(6).fill(true));
    }
  }

  useEffect(() => {
    const cvs = canvas.current;
    if (!cvs || !screen || !model?.dma) return;

    const { numPlanes, width, height, firstLine, ham } = screen;
    const rowWords = width >> 4;

    const baseRegs = model.dmaSnapshot?.custom ?? new Uint16Array(256);
    const linePalettes: Uint32Array[] = model.copper
      ? buildLinePalettes(baseRegs, model.copper, firstLine, height)
      : Array.from({ length: height }, () => buildPalette(baseRegs));

    cvs.width  = width  * scale;
    cvs.height = height * scale;

    const ctx     = cvs.getContext("2d")!;
    const imgData = ctx.createImageData(cvs.width, cvs.height);
    const data    = new Uint32Array(imgData.data.buffer);
    const dma     = model.dma;

    const pixRawBits  = new Uint8Array(width * height);
    const pixColorIdx = new Uint8Array(width * height);
    const pixColors   = new Uint32Array(width * height);

    for (let y = 0; y < height; y++) {
      const palette  = linePalettes[y];
      const vpos     = firstLine + y;
      const lineBase = vpos * DMA_HPOS;

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
          } else {
            effectiveIdx = pixel & ((1 << numPlanes) - 1);
            color = palette[effectiveIdx] ?? palette[0];
          }

          const px = wx * 16 + bit;
          const li = y * width + px;
          pixRawBits[li]  = rawPixel;
          pixColorIdx[li] = effectiveIdx;
          pixColors[li]   = color;

          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              data[((y * scale + sy) * cvs.width) + (px * scale + sx)] = color;
            }
          }
        }
      }
    }

    ctx.putImageData(imgData, 0, 0);
    pixelSnap.current = { rawBits: pixRawBits, colorIdx: pixColorIdx, colors: pixColors, palettes: linePalettes, width, height, firstLine, numPlanes, ham };
  }, [canvas, screen, model, scale, planeVis]);

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
    const li = logY * ps.width + logX;
    const extra = computeHoverExtra(m, ps.firstLine, logY, logX, ps.numPlanes);
    setHover({
      logX, logY,
      vpos:     ps.firstLine + logY,
      rawBits:  ps.rawBits[li],
      colorIdx: ps.colorIdx[li],
      color:    ps.colors[li],
      ham:      ps.ham,
      palette:  ps.palettes[logY],
      ...extra,
    });
    setHoverClientPos({ x: e.clientX, y: e.clientY });
  }, [scale]);

  const onMouseLeave = useCallback(() => setHover(null), []);

  const togglePlane = useCallback((i: number) => {
    setPlaneVis(v => { const n = [...v]; n[i] = !n[i]; return n; });
  }, []);

  if (!model?.dma) {
    return <div className="resources-empty">No DMA data available.</div>;
  }
  if (!screen) {
    return <div className="resources-empty">No bitplane display detected in this capture.</div>;
  }

  const { width, height, numPlanes, hires, ham, modeChanges } = screen;
  const modeStr = modeChanges
    ? "variable mode"
    : `${numPlanes}-plane${hires ? " hires" : " lores"}${ham ? " HAM" : ""}`;
  const info = `${width}×${height} · ${modeStr}`;

  // Derived display values from hover state (computed once for the render).
  let copperText: string | undefined;
  let bplcon0Str: string | undefined;
  let palNumColors = 0;
  if (hover) {
    const bpu = (hover.bplcon0 >>> 12) & 7;
    const isHires = !!(hover.bplcon0 & (1 << 15));
    const isHam   = !!(hover.bplcon0 & (1 << 11));
    const isDpf   = !!(hover.bplcon0 & (1 << 10));
    palNumColors = Math.min(1 << Math.max(0, Math.min(bpu, 5)), 32);
    bplcon0Str = `BPU:${bpu}  ${isHires ? "HIRES" : "LORES"}${isHam ? "  HAM" : ""}${isDpf ? "  DPF" : ""}`;
    if (hover.copperInstr) {
      const ci = hover.copperInstr;
      const d = disassembleCopperInstruction(ci.addr, ci.w1, ci.w2);
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
              {hover.planeAddrs.length > 0 && (
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
