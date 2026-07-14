// Paused-emulator counterpart of the profiler's Screen reconstruction tooltip
// (profilerViewer/ResourcesView.tsx). Builds a live IProfileModel-shaped snapshot from the
// same on-demand wasm serializers the profiler capture uses (wasm_dma_serialize_grid,
// wasm_copper_get_records_ptr/size, wasm_read_custom_regs_raw, wasm_read_aga_colors), then
// reuses the profiler's own proven buildScreenFromModel/decodeScreenPixels/computeHoverExtra
// (gfxResources.ts) to decode it — instead of a hand-rolled parallel re-implementation. An
// earlier version of this file re-derived the bitplane bit/colour decode independently and got
// subtly out of sync with the profiler's own math (a wrong fetch/display timing correction, a
// data-source question that took real source-diving to resolve) — reuse eliminates that whole
// class of bug by construction: whatever the profiler's Screen view shows for a given DMA/copper
// state is bit-for-bit what this tooltip shows too, because it's the same code.
//
// Requires the emulator to be paused, and recording to have happened *during* the frame being
// inspected (see app.ts's persistent tracking auto-enable — it can't be turned on retroactively
// once paused). Deliberately does NOT need the DMA overlay panel's full-raster geometry: unlike
// that panel (which tints the *real* framebuffer at raw hpos/vpos coordinates, so it needs the
// live canvas to actually span the full raw raster), this tooltip reconstructs its own screen
// from the DMA/copper trace — exactly like the profiler's Screen view does — so the live canvas
// can stay in its normal (default-crop) geometry; the hovered pixel just needs proportionally
// mapping into the reconstruction's own coordinate space (see decodeScreenHover below).
import { disassembleCopperInstruction } from "../../shared/copperDisassembler";
import { decodeCopperRecords, decodeCustomRegs, decodeAgaColors, decodeDmaGrid } from "../../shared/dma";
import { IProfileModel } from "../../shared/profilerTypes";
import {
  buildScreenFromModel, computeHoverExtra, decodeScreenPixels, IScreen, PixelSnapshot,
} from "../profilerViewer/gfxResources";
import type { PuaeModule } from "./types";

// Builds a minimal but structurally valid IProfileModel — only dma/copper/dmaSnapshot are ever
// read by buildScreenFromModel/decodeScreenPixels/computeHoverExtra, but the type itself requires
// the CPU-profile fields too (nodes/locations/samples/...), so these are filled with harmless
// empty placeholders purely to satisfy the shared type.
function emptyProfileModel(): IProfileModel {
  return {
    nodes: [], locations: [], samples: [], timeDeltas: [], pcs: [],
    duration: 0, cyclesPerMicroSecond: 7.09379, // PAL CPU clock, matching profilerTypes.ts's own doc comment
  };
}

// Reads the wasm module's on-demand serializers for "the last completed frame" — the same ones
// profilerManager.ts's capture flow and rpc.ts's getDmaSnapshot RPC handler use — and decodes
// them with the shared/dma.ts parsers into an IProfileModel the profiler's own reconstruction
// pipeline (gfxResources.ts) can consume directly.
function buildLiveModel(M: PuaeModule): IProfileModel {
  const model = emptyProfileModel();

  M._wasm_dma_serialize_grid();
  const gridPtr = M._wasm_dma_get_grid_ptr();
  const gridSize = M._wasm_dma_get_grid_size();
  if (gridPtr && gridSize) {
    model.dma = decodeDmaGrid(new Uint8Array(M.HEAPU8.buffer, gridPtr, gridSize));
  }

  // buildScreenFromModel hard-requires `copper` to be present (not undefined) — but copper
  // tracking is a separate toggle from the other DMA channels (app.ts's setChannel only enables
  // debug_copper when the "Copper" button specifically is on), so a user who only enabled e.g.
  // Bitplane would otherwise get no tooltip at all, for every hover, with no indication why. Fall
  // back to an empty (but truthy) ICopperModel in that case: buildScreenFromModel/decodeScreenPixels
  // just find no copper writes and use the live custom-register snapshot as-is for the whole
  // frame — a reasonable degrade (copper writes *within* this frame won't be reflected), not a
  // silent failure.
  const copperPtr = M._wasm_copper_get_records_ptr();
  const copperSize = M._wasm_copper_get_records_size();
  model.copper = (copperPtr && copperSize)
    ? decodeCopperRecords(new Uint8Array(M.HEAPU8.buffer, copperPtr, copperSize))
    : { addr: new Uint32Array(0), w1: new Uint16Array(0), w2: new Uint16Array(0), hpos: new Uint16Array(0), vpos: new Uint16Array(0) };

  // save_custom() output: 4-byte chipset_mask header + 256 big-endian u16 words. decodeCustomRegs
  // expects 256 little-endian u16 words (512 bytes) — same header-skip + byte-swap rpc.ts's
  // getDmaSnapshot handler already does for the profiler's own capture.
  M._wasm_read_custom_regs_raw();
  const rawPtr = M._wasm_get_custom_regs_raw_buf();
  const rawView = new DataView(M.HEAPU8.buffer, rawPtr, 520);
  const customBytes = new Uint8Array(512);
  const customView = new DataView(customBytes.buffer);
  for (let i = 0; i < 256; i++) customView.setUint16(i * 2, rawView.getUint16(4 + i * 2, false), true);
  const custom = decodeCustomRegs(customBytes);

  // AGA's full 256-entry, already-24-bit palette — native little-endian, no byte-swap needed.
  M._wasm_read_aga_colors();
  const agaPtr = M._wasm_get_aga_colors_buf();
  const agaColors = decodeAgaColors(new Uint8Array(M.HEAPU8.buffer, agaPtr, 256 * 4));

  model.dmaSnapshot = { chip: new Uint8Array(0), slow: new Uint8Array(0), custom, agaColors };
  return model;
}

export interface ScreenHoverInfo {
  x: number; // canvas-space (profiler reconstruction coordinates, not raw hpos/vpos)
  y: number;
  vpos: number;
  cck: number | undefined;
  rawBits: number;
  colorIdx: number;
  color: number;
  ham: boolean;
  spriteOwner: number | undefined;
  planeAddrs: (number | undefined)[];
  bplcon0: number;
  numPlanes: number;
  palette: Uint32Array;
  copperInstr: { mnemonic: string; operands: string; vpos: number } | undefined;
}

// Decodes the profiler-style Screen-reconstruction fields for whatever pixel is under the cursor
// on the *live* emulator canvas — reusing the exact same
// buildScreenFromModel/decodeScreenPixels/computeHoverExtra pipeline the profiler's own Screen
// view (ResourcesView.tsx) uses, just fed from a live model instead of a captured one.
//
// (px, py) are pixel coordinates in the live canvas's own backing-store resolution
// (fbWidth/fbHeight — whatever the emulator's normal, default-crop framebuffer size currently
// is, NOT forced to any particular geometry). Mapped proportionally into the reconstruction's
// own (independently-sized) coordinate space — the same kind of scale ResourcesView.tsx's own
// hover handler applies between CSS pixels and its canvas's backing store, just one more space
// over. This works because gfxResources.ts's STANDARD_FB_WIDTH/HEIGHT (the reconstruction's
// canvas preset) was deliberately chosen to match the live emulator's own default PAL geometry
// (PUAE_VIDEO_WIDTH/HEIGHT_PAL) — the two aren't byte-for-byte guaranteed identical for every
// exotic DDFSTRT/DIWSTRT configuration, but line up for the standard case a proportional scale
// is built to handle regardless.
export function decodeScreenHover(M: PuaeModule, px: number, py: number, fbWidth: number, fbHeight: number): ScreenHoverInfo | undefined {
  if (fbWidth <= 0 || fbHeight <= 0) return undefined;
  const model = buildLiveModel(M);
  const screen: IScreen | undefined = buildScreenFromModel(model);
  if (!screen) return undefined;
  const snapshot: PixelSnapshot | undefined = decodeScreenPixels(model, screen);
  if (!snapshot) return undefined;

  const x = Math.floor((px * screen.width) / fbWidth);
  const y = Math.floor((py * screen.height) / fbHeight);
  if (x < 0 || x >= screen.width || y < 0 || y >= screen.height) return undefined;
  const li = y * snapshot.width + x;

  const spr = snapshot.spriteMask[li];
  const extra = computeHoverExtra(model, screen.firstLine, y, x, snapshot.numPlanes, snapshot.lineDup[y]);
  const disassembled = extra.copperInstr
    ? disassembleCopper(extra.copperInstr)
    : undefined;

  return {
    x, y, vpos: screen.firstLine + y, cck: extra.cck,
    rawBits: snapshot.rawBits[li], colorIdx: snapshot.colorIdx[li], color: snapshot.colors[li],
    ham: !!snapshot.lineHam[y], spriteOwner: spr === 0xff ? undefined : spr,
    planeAddrs: extra.planeAddrs, bplcon0: extra.bplcon0, numPlanes: snapshot.numPlanes,
    palette: snapshot.palettes[y], copperInstr: disassembled,
  };
}

function disassembleCopper(instr: { w1: number; w2: number; addr: number; instrVpos: number }) {
  const d = disassembleCopperInstruction(instr.addr, instr.w1, instr.w2);
  return { mnemonic: d.mnemonic, operands: d.operands, vpos: instr.instrVpos };
}

declare global {
  interface Window {
    // Set window.__screenHoverDebug = true in the webview devtools console to log which stage
    // of the live reconstruction (grid/copper/custom-regs decode, buildScreenFromModel,
    // decodeScreenPixels) is failing, on every mousemove — see installScreenHoverTooltip below.
    __screenHoverDebug?: boolean;
  }
}

// Diagnostic snapshot of every stage of decodeScreenHover, for window.__screenHoverDebug — same
// checkpoints, run separately so a failure partway through doesn't stop the rest from reporting.
function debugScreenHoverState(M: PuaeModule, px: number, py: number, fbWidth: number, fbHeight: number) {
  const isPaused = !!M._wasm_is_paused();

  M._wasm_dma_serialize_grid();
  const gridPtr = M._wasm_dma_get_grid_ptr();
  const gridSize = M._wasm_dma_get_grid_size();
  const dma = (gridPtr && gridSize) ? decodeDmaGrid(new Uint8Array(M.HEAPU8.buffer, gridPtr, gridSize)) : undefined;
  let bplCells = 0;
  if (dma) for (const o of dma.owner) if (o >= 8 && o <= 15) bplCells++; // BusOwner.BPL1..BPL8

  const copperPtr = M._wasm_copper_get_records_ptr();
  const copperSize = M._wasm_copper_get_records_size();

  M._wasm_read_custom_regs_raw();
  const rawPtr = M._wasm_get_custom_regs_raw_buf();
  const rawView = new DataView(M.HEAPU8.buffer, rawPtr, 520);
  const bplcon0 = rawView.getUint16(4 + 0x100, false);
  const ddfstrt = rawView.getUint16(4 + 0x092, false);
  const ddfstop = rawView.getUint16(4 + 0x094, false);
  const dmacon = rawView.getUint16(4 + 0x096, false);

  let info: ScreenHoverInfo | undefined;
  let error: unknown;
  try {
    info = decodeScreenHover(M, px, py, fbWidth, fbHeight);
  } catch (e) {
    error = e;
  }

  return {
    isPaused, px, py, fbWidth, fbHeight,
    gridPtr, gridSize, gridCellCount: gridSize ? (gridSize / 8) | 0 : 0, bplCellsInGrid: bplCells,
    copperPtr, copperSize, copperRecordCount: copperSize ? (copperSize / 12) | 0 : 0,
    bplcon0: "0x" + bplcon0.toString(16), ddfstrt: "0x" + ddfstrt.toString(16),
    ddfstop: "0x" + ddfstop.toString(16), dmacon: "0x" + dmacon.toString(16),
    info, error,
  };
}

// ── Tooltip UI — mirrors ResourcesView.tsx's screen-tooltip table (same row set/order/wording;
// see dmaHover.ts for the sibling per-cell tooltip this one visually replaces while paused). ────

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

function addRow(table: HTMLTableElement, label: string, value: Node | string): void {
  const tr = document.createElement("tr");
  const td1 = document.createElement("td");
  td1.textContent = label;
  td1.style.cssText = "opacity:0.7;padding-right:8px;vertical-align:top;white-space:nowrap";
  const td2 = document.createElement("td");
  if (typeof value === "string") td2.textContent = value;
  else td2.appendChild(value);
  tr.appendChild(td1);
  tr.appendChild(td2);
  table.appendChild(tr);
}

function renderScreenTooltipContent(tooltip: HTMLDivElement, info: ScreenHoverInfo): void {
  const table = document.createElement("table");
  table.style.cssText = "border-collapse:collapse";

  addRow(table, "Beam", `${info.cck !== undefined ? `CCK:${info.cck}  ` : ""}VPOS:${info.vpos}`);
  addRow(table, "Source", info.spriteOwner !== undefined
    ? `Sprite ${info.spriteOwner}`
    : info.rawBits === 0 ? "Background" : "Bitplane");

  const colorRow = document.createElement("div");
  colorRow.style.cssText = "display:flex;align-items:center;gap:4px";
  const swatch = document.createElement("span");
  swatch.style.cssText = `display:inline-block;width:10px;height:10px;border:1px solid rgba(255,255,255,0.4);background:${colorToCss(info.color)}`;
  colorRow.appendChild(swatch);
  colorRow.appendChild(document.createTextNode(
    info.ham ? colorToHex(info.color)
      : `${info.colorIdx} ($${info.colorIdx.toString(16).padStart(2, "0")}) · ${colorToHex(info.color)}`,
  ));
  addRow(table, "Colour", colorRow);

  if (info.spriteOwner === undefined) {
    const planesRow = document.createElement("div");
    planesRow.style.cssText = "display:flex;gap:2px";
    for (let i = 0; i < info.numPlanes; i++) {
      const bit = document.createElement("span");
      const on = (info.rawBits & (1 << i)) !== 0;
      bit.textContent = String(i + 1);
      bit.title = `BPL${i + 1}: ${on ? "1" : "0"}`;
      bit.style.cssText = `display:inline-block;width:14px;text-align:center;border-radius:2px;font-size:10px;background:${on ? "#4a4" : "#444"};color:${on ? "#fff" : "#888"}`;
      planesRow.appendChild(bit);
    }
    addRow(table, "Planes", planesRow);

    const addrsCell = document.createElement("div");
    info.planeAddrs.forEach((addr, i) => {
      const line = document.createElement("div");
      line.textContent = `BPL${i + 1}: ${addr !== undefined ? "$" + addr.toString(16).toUpperCase().padStart(6, "0") : "—"}`;
      addrsCell.appendChild(line);
    });
    addRow(table, "Addrs", addrsCell);
  }

  const bpu = (info.bplcon0 >>> 12) & 7;
  const isHires = !!(info.bplcon0 & (1 << 15));
  const isHam = !!(info.bplcon0 & (1 << 11));
  const isDpf = !!(info.bplcon0 & (1 << 10));
  addRow(table, "BPLCON0", `BPU:${bpu}  ${isHires ? "HIRES" : "LORES"}${isHam ? "  HAM" : ""}${isDpf ? "  DPF" : ""}`);

  const palNumColors = Math.min(1 << Math.max(0, Math.min(bpu, 5)), 32);
  if (info.palette.length > 0 && palNumColors > 0) {
    const palRow = document.createElement("div");
    palRow.style.cssText = "display:flex;flex-wrap:wrap;gap:1px;max-width:200px";
    for (let i = 0; i < palNumColors; i++) {
      const chip = document.createElement("span");
      chip.title = `${i}: ${colorToHex(info.palette[i])}`;
      chip.style.cssText = `display:inline-block;width:10px;height:10px;background:${colorToCss(info.palette[i])}`;
      palRow.appendChild(chip);
    }
    addRow(table, "Palette", palRow);
  }

  if (info.copperInstr) {
    addRow(table, "Copper", `${info.copperInstr.mnemonic} ${info.copperInstr.operands}  @L${info.copperInstr.vpos}`);
  }

  tooltip.replaceChildren(table);
}

// Wires a mousemove/mouseleave hover tooltip onto `canvas` showing the profiler's Screen-
// reconstruction fields (Colour/Planes/Addrs/BPLCON0/Palette/Copper) decoded live from the
// current frame's DMA/copper/register-write records — active only while `isActive()` (paused +
// DMA overlay panel on; see app.ts's install call site for why).
export function installScreenHoverTooltip(canvas: HTMLCanvasElement, M: PuaeModule, isActive: () => boolean): void {
  const tooltip = document.createElement("div");
  tooltip.style.cssText = [
    "position:fixed",
    "display:none",
    "pointer-events:none",
    "z-index:1000",
    "padding:6px 8px",
    "border-radius:3px",
    "font-family:var(--vscode-editor-font-family, monospace)",
    "font-size:11px",
    "background:var(--vscode-editorHoverWidget-background, #2d2d2d)",
    "color:var(--vscode-editorHoverWidget-foreground, #ccc)",
    "border:1px solid var(--vscode-editorHoverWidget-border, #454545)",
  ].join(";");
  document.body.appendChild(tooltip);

  function hide(): void {
    tooltip.style.display = "none";
  }

  const MARGIN = 12;
  function positionTooltip(clientX: number, clientY: number): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const { width, height } = tooltip.getBoundingClientRect();
    let left = clientX + MARGIN;
    let top = clientY + MARGIN;
    if (left + width > vw) left = clientX - MARGIN - width;
    if (top + height > vh) top = clientY - MARGIN - height;
    tooltip.style.left = `${Math.max(0, left)}px`;
    tooltip.style.top = `${Math.max(0, top)}px`;
  }

  canvas.addEventListener("mousemove", (event) => {
    if (!isActive()) {
      if (window.__screenHoverDebug) console.log("[screenHover] inactive: paused=", M._wasm_is_paused());
      hide();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) { hide(); return; }
    const px = ((event.clientX - rect.left) * canvas.width) / rect.width;
    const py = ((event.clientY - rect.top) * canvas.height) / rect.height;
    if (window.__screenHoverDebug) {
      console.log("[screenHover] canvas:", canvas.width, "x", canvas.height, "px/py:", px, py,
        debugScreenHoverState(M, px, py, canvas.width, canvas.height));
    }
    let info;
    try {
      info = decodeScreenHover(M, px, py, canvas.width, canvas.height);
    } catch (e) {
      // Surface unexpected decode failures instead of just leaving the tooltip permanently
      // hidden with no clue why (this reuses the profiler's own reconstruction pipeline, fed
      // live data it wasn't originally written to receive — a shape mismatch anywhere in there
      // should be loud, not silent).
      console.error("[screenHover] decode failed", e);
      hide();
      return;
    }
    if (!info) { hide(); return; }
    renderScreenTooltipContent(tooltip, info);
    tooltip.style.display = "block";
    positionTooltip(event.clientX, event.clientY);
  });

  canvas.addEventListener("mouseleave", hide);
}
