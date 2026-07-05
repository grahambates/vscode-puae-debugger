import { useEffect, useMemo, useRef, useState } from "react";
import { BusOwner, IProfileModel } from "../../shared/profilerTypes";
import { buildScreenFromModel, DMA_HPOS } from "./gfxResources";
import { CUSTOM_REGISTER_OFFSETS as R } from "../shared/customRegisters";

interface ResourcesViewProps {
  selectedSlot: number | undefined;
  model: IProfileModel | null | undefined;
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

/**
 * Build one palette snapshot per scan line by replaying copper COLOR register writes
 * in scan-line order on top of the custom-register baseline.
 */
function buildLinePalettes(
  baseRegs: Uint16Array,
  copper: NonNullable<IProfileModel["copper"]>,
  firstLine: number,
  height: number,
): Uint32Array[] {
  const cur = buildPalette(baseRegs);

  const COLOR_BASE = R.COLOR00; // 0x180
  const writesByVpos = new Map<number, Array<[number, number]>>();
  for (let i = 0; i < copper.addr.length; i++) {
    const w1 = copper.w1[i];
    if (w1 & 1) continue;
    const da = w1 & 0x1fe;
    if (da < COLOR_BASE || da > COLOR_BASE + 62) continue; // COLOR00-COLOR31
    const ci = (da - COLOR_BASE) >> 1;
    const vp = copper.vpos[i];
    const slot = writesByVpos.get(vp);
    if (slot) slot.push([ci, copper.w2[i]]);
    else writesByVpos.set(vp, [[ci, copper.w2[i]]]);
  }

  const sortedVpos = [...writesByVpos.keys()].sort((a, b) => a - b);
  let vposPtr = 0;

  const palettes = new Array<Uint32Array>(height);
  for (let y = 0; y < height; y++) {
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
    palettes[y] = new Uint32Array(cur);
  }
  return palettes;
}

export function ResourcesView({ model }: ResourcesViewProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [scale, setScale] = useState(2);

  const screen = useMemo(() => (model ? buildScreenFromModel(model) : undefined), [model]);

  useEffect(() => {
    const cvs = canvas.current;
    if (!cvs || !screen || !model?.dma) return;

    const { numPlanes, width, height, firstLine, ham } = screen;
    const rowWords = width >> 4;

    // Per-line palettes from copper COLOR register writes.
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

    for (let y = 0; y < height; y++) {
      const palette  = linePalettes[y];
      const vpos     = firstLine + y;
      const lineBase = vpos * DMA_HPOS;

      // Collect the actual 16-bit words the BPL hardware fetched on this scan line,
      // grouped by plane index, in hpos order. We use dma.value[idx] — the value that
      // was on the bus at fetch time — rather than reading from the chip-RAM snapshot.
      // The snapshot is the post-frame state and can't be used to reconstruct mid-frame
      // memory; the DMA grid value is always correct regardless of snapshot timing.
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
          let pixel = 0;
          for (let p = 0; p < numPlanes; p++) {
            if (words[p] & (1 << (15 - bit))) pixel |= 1 << p;
          }

          let color: number;
          if (ham && numPlanes === 6) {
            const mode = pixel >> 4;
            const val  = pixel & 0xf;
            const exp  = expand4(val);
            switch (mode) {
              case 0: color = palette[val]; break;
              case 1: color = (prevColor & ~0x00ff0000) | (exp << 16); break; // blue
              case 2: color = (prevColor & ~0x000000ff) | exp;          break; // red
              case 3: color = (prevColor & ~0x0000ff00) | (exp << 8);   break; // green
              default: color = prevColor;
            }
            prevColor = color;
          } else {
            color = palette[pixel & ((1 << numPlanes) - 1)] ?? palette[0];
          }

          const px = wx * 16 + bit;
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              data[((y * scale + sy) * cvs.width) + (px * scale + sx)] = color;
            }
          }
        }
      }
    }

    ctx.putImageData(imgData, 0, 0);
  }, [canvas, screen, model, scale]);

  if (!model?.dma) {
    return <div className="resources-empty">No DMA data available.</div>;
  }
  if (!screen) {
    return <div className="resources-empty">No bitplane display detected in this capture.</div>;
  }

  const { width, height, numPlanes, hires, ham } = screen;
  const info = `${width}×${height} · ${numPlanes}-plane${hires ? " hires" : " lores"}${ham ? " HAM" : ""}`;

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
      </div>
      <div className="resources-canvas-wrap">
        <canvas ref={canvas} style={{ imageRendering: "pixelated" }} />
      </div>
    </div>
  );
}
