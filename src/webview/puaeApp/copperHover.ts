// Hover tooltip for the live copper DMA overlay: maps a mouse position over
// the video canvas to a copper instruction and shows its disassembly.
//
// Requires three things from the wasm side (see puae-wasm/libretro-uae/
// sources/src/debug.c), all reading the *last completed frame* live (not the
// separate wasm_dma_get_grid_ptr/size grid, which is profiler-only — it's
// only populated on demand by wasm_dma_serialize_grid and otherwise stale):
//  - wasm_dma_get_cell_type(hpos, vpos) to tell whether the hovered cell was
//    a COPPER DMA cycle at all;
//  - wasm_dma_get_cell_addr(hpos, vpos), the raw bus address (cop_state.ip)
//    fetched on that cycle — either the instruction's word1 or word2
//    address, whichever was fetched at this specific hpos/vpos;
//  - e9k_copper_serialize/wasm_copper_get_records_ptr/size, a flat dump of
//    cop_record[] (addr/w1/w2/hpos/vpos per instruction, the same data
//    record_copper() has always collected for the disassembler/breakpoint
//    commands, just not previously exposed to JS) to recover the actual
//    instruction words at that cell.
//
// Matching is done by address (cell addr == instruction addr, or addr - 2),
// not by hpos/vpos cycle position — the gap between an instruction's two
// word fetches isn't reliably exactly 1 DMA cycle once other channels can
// contend for the bus, so a position-based ±1 match misses real hits.
import { disassembleCopperInstruction } from "../../shared/copperDisassembler";
import { DMA_HPOS, DMA_VPOS } from "../../shared/profilerTypes";
import type { PuaeModule } from "./types";

// addr:u32, w1:u16, w2:u16, hpos:u16, vpos:u16 — see e9k_copper_serialize.
const COPPER_RECORD_BYTES = 12;

// DMARECORD_COPPER (puae-wasm/libretro-uae/sources/src/include/debug.h) — the
// value wasm_dma_get_cell_type returns for a copper DMA cycle.
const DMARECORD_COPPER = 3;

// e9k_dma_get_cell_addr's "no data" sentinel.
const NO_ADDR = 0xffffffff;

export interface CopperHoverInfo {
  address: number;
  mnemonic: string;
  operands: string;
  comment?: string;
  // RGB (0-255 each), set when this is a MOVE to a COLORnn register — see
  // disassembleCopperInstruction (src/shared/copperDisassembler.ts).
  color?: [number, number, number];
}

// --- Source-location lookup --------------------------------------------
//
// The extension host holds the session's SourceMap (WebviewEmulator.
// setSourceMap, wired from VamigaDebugAdapter); the webview asks it to
// symbolize an address via postMessage and gets an async reply — mirrors
// how breakpointManager.ts already resolves copper watchpoint hits to
// source via sourceMap.lookupAddress, just round-tripped through the
// webview instead of called directly (the lookup itself lives extension-
// side either way). For assembly sources this often resolves directly to
// the `dc.w` (or similar) line that emits the instruction's data.

export interface SourceLocation {
  path: string;
  line: number;
}

interface VsCodeApi {
  postMessage(message: unknown): void;
}

// address -> resolved location, or null if the lookup found nothing.
// Module-scoped: there's only ever one PUAE canvas/panel per webview
// instance, so a single cache for the process lifetime is fine.
const symbolCache = new Map<number, SourceLocation | null>();
const inFlight = new Set<number>();
const pendingRequests = new Map<string, (location: SourceLocation | null) => void>();
let nextRequestId = 0;

// Handles `symbolizeResult` replies from the extension host — wire this into
// app.ts's `window.addEventListener('message', ...)`.
export function handleCopperHoverMessage(message: { type?: string; requestId?: string; location?: SourceLocation }): void {
  if (!message || message.type !== "symbolizeResult" || !message.requestId) return;
  const resolve = pendingRequests.get(message.requestId);
  if (!resolve) return;
  pendingRequests.delete(message.requestId);
  resolve(message.location ?? null);
}

// Kicks off (or skips, if already cached/in flight) a symbolize request for
// `address`, calling `onResolved` once the result lands in symbolCache.
function requestSymbol(vscodeApi: VsCodeApi, address: number, onResolved: () => void): void {
  if (symbolCache.has(address) || inFlight.has(address)) return;
  inFlight.add(address);
  const requestId = `copperSym${nextRequestId++}`;
  pendingRequests.set(requestId, (location) => {
    symbolCache.set(address, location);
    inFlight.delete(address);
    onResolved();
  });
  vscodeApi.postMessage({ type: "symbolizeAddress", address, requestId });
}

// Finds the cop_record[] entry whose instruction starts at `fetchAddr` (the
// hovered cell fetched its word1) or `fetchAddr - 2` (the cell fetched its
// word2, so the instruction started 2 bytes earlier).
function findCopperInstructionByAddr(M: PuaeModule, fetchAddr: number): CopperHoverInfo | undefined {
  const ptr = M._wasm_copper_get_records_ptr();
  const size = M._wasm_copper_get_records_size();
  if (!ptr || size < COPPER_RECORD_BYTES) return undefined;
  const count = (size / COPPER_RECORD_BYTES) | 0;
  const view = new DataView(M.HEAPU8.buffer, ptr, count * COPPER_RECORD_BYTES);
  for (let i = 0; i < count; i++) {
    const o = i * COPPER_RECORD_BYTES;
    const recAddr = view.getUint32(o + 0, true);
    if (recAddr !== fetchAddr && recAddr !== (fetchAddr - 2) >>> 0) continue;
    const w1 = view.getUint16(o + 4, true);
    const w2 = view.getUint16(o + 6, true);
    const insn = disassembleCopperInstruction(recAddr, w1, w2);
    return {
      address: recAddr,
      mnemonic: insn.mnemonic,
      operands: insn.operands,
      comment: insn.comment,
      color: insn.color,
    };
  }
  return undefined;
}

// Maps a framebuffer-space pixel to a DMA-grid (hpos, vpos) cell, inverting
// e9k_dma_draw_overlay's (debug.c) `h*width/DMA_HPOS`/`v*height/DMA_VPOS`
// cell-rect mapping.
function pixelToDmaSlot(
  px: number,
  py: number,
  fbWidth: number,
  fbHeight: number,
): { hpos: number; vpos: number } | undefined {
  if (fbWidth <= 0 || fbHeight <= 0) return undefined;
  const hpos = Math.floor((px * DMA_HPOS) / fbWidth);
  const vpos = Math.floor((py * DMA_VPOS) / fbHeight);
  if (hpos < 0 || hpos >= DMA_HPOS || vpos < 0 || vpos >= DMA_VPOS) return undefined;
  return { hpos, vpos };
}

// Looks up the copper instruction under the given framebuffer pixel, if any.
// Returns undefined if the pixel isn't a copper DMA cycle, or copper-instruction
// tracking isn't enabled (debug_copper off — see wasm_dma_overlay_set_channel).
function copperInstructionAtPixel(
  M: PuaeModule,
  px: number,
  py: number,
  fbWidth: number,
  fbHeight: number,
): CopperHoverInfo | undefined {
  const slot = pixelToDmaSlot(px, py, fbWidth, fbHeight);
  if (!slot) return undefined;
  if (M._wasm_dma_get_cell_type(slot.hpos, slot.vpos) !== DMARECORD_COPPER) return undefined;
  const fetchAddr = M._wasm_dma_get_cell_addr(slot.hpos, slot.vpos);
  if (fetchAddr === NO_ADDR) return undefined;
  return findCopperInstructionByAddr(M, fetchAddr >>> 0);
}

declare global {
  interface Window {
    // Set window.__copperHoverDebug = true in the webview devtools console
    // to log diagnostic info (slot, cell type, record count) on every
    // mousemove over the canvas — see installCopperHoverTooltip below.
    __copperHoverDebug?: boolean;
  }
}

// Diagnostic snapshot of every step of the lookup, for window.__copperHoverDebug.
function debugCopperHoverState(M: PuaeModule, px: number, py: number, fbWidth: number, fbHeight: number) {
  const slot = pixelToDmaSlot(px, py, fbWidth, fbHeight);
  const cellType = slot ? M._wasm_dma_get_cell_type(slot.hpos, slot.vpos) : undefined;
  const fetchAddr = slot ? M._wasm_dma_get_cell_addr(slot.hpos, slot.vpos) >>> 0 : undefined;
  const recPtr = M._wasm_copper_get_records_ptr();
  const recSize = M._wasm_copper_get_records_size();
  return {
    px, py, fbWidth, fbHeight,
    slot,
    cellType,
    isCopperCell: cellType === DMARECORD_COPPER,
    fetchAddr: fetchAddr !== undefined ? "0x" + fetchAddr.toString(16) : undefined,
    recordPtr: recPtr,
    recordCount: recPtr ? (recSize / COPPER_RECORD_BYTES) | 0 : 0,
  };
}

// Builds the tooltip's first line: "$ADDR: MNEMONIC [swatch] OPERANDS",
// with a small colored square inserted right before the operands (the
// value) when this instruction is a MOVE to a COLORnn register.
function buildInstructionLine(info: CopperHoverInfo): HTMLDivElement {
  const div = document.createElement("div");
  const addr = "$" + info.address.toString(16).toUpperCase().padStart(6, "0");
  div.appendChild(document.createTextNode(`${addr}: ${info.mnemonic} `.trimStart()));
  if (info.color) {
    const [r, g, b] = info.color;
    const swatch = document.createElement("span");
    swatch.style.cssText = [
      "display:inline-block",
      "width:10px",
      "height:10px",
      "margin-right:4px",
      "vertical-align:middle",
      "border:1px solid rgba(255,255,255,0.4)",
      `background:rgb(${r},${g},${b})`,
    ].join(";");
    div.appendChild(swatch);
  }
  div.appendChild(document.createTextNode(info.operands));
  return div;
}

function renderTooltipContent(
  tooltip: HTMLDivElement,
  info: CopperHoverInfo,
  location: SourceLocation | null | undefined,
): void {
  tooltip.replaceChildren(buildInstructionLine(info));
  if (info.comment) {
    const line = document.createElement("div");
    line.textContent = info.comment;
    tooltip.appendChild(line);
  }
  if (location) {
    const line = document.createElement("div");
    line.textContent = `${location.path}:${location.line}`;
    tooltip.appendChild(line);
  }
}

// Wires a mousemove/mouseleave/click hover tooltip onto `canvas`, showing
// the disassembled copper instruction under the cursor. `isActive` reports
// whether the DMA overlay is currently enabled with the COPPER channel on —
// the tooltip stays hidden otherwise, and the hot path (mousemove) skips the
// grid/record lookups entirely when inactive. `vscodeApi` (acquireVsCodeApi(),
// undefined outside the real VS Code webview e.g. debug.html) enables the
// source-location lookup and click-to-open; without it the tooltip still
// shows the disassembly, just with no source line.
export function installCopperHoverTooltip(
  canvas: HTMLCanvasElement,
  M: PuaeModule,
  isActive: () => boolean,
  vscodeApi?: VsCodeApi,
): void {
  const tooltip = document.createElement("div");
  tooltip.style.cssText = [
    "position:fixed",
    "display:none",
    "pointer-events:none",
    "z-index:1000",
    "padding:4px 6px",
    "border-radius:3px",
    "font-family:var(--vscode-editor-font-family, monospace)",
    "font-size:11px",
    "background:var(--vscode-editorHoverWidget-background, #2d2d2d)",
    "color:var(--vscode-editorHoverWidget-foreground, #ccc)",
    "border:1px solid var(--vscode-editorHoverWidget-border, #454545)",
  ].join(";");
  document.body.appendChild(tooltip);

  // Tracks what's currently shown, so the click handler knows what to open
  // and the async symbolize callback can tell whether it's still relevant
  // (the mouse may have moved to a different instruction by the time the
  // extension host replies).
  let current: { info: CopperHoverInfo; clientX: number; clientY: number } | undefined;

  function hide(): void {
    tooltip.style.display = "none";
    current = undefined;
  }

  // Anchors the tooltip near (clientX, clientY), flipping to whichever side
  // of the cursor keeps it fully inside the viewport — otherwise it runs off
  // the right/bottom edge whenever the cursor is near them. Must run after
  // textContent + display are set, since measuring needs real layout.
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

  function render(info: CopperHoverInfo, clientX: number, clientY: number): void {
    current = { info, clientX, clientY };
    renderTooltipContent(tooltip, info, symbolCache.get(info.address));
    tooltip.style.display = "block";
    positionTooltip(clientX, clientY);
  }

  canvas.addEventListener("mousemove", (event) => {
    if (!isActive()) {
      hide();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      hide();
      return;
    }
    // Scale CSS-displayed coordinates to the canvas's backing-store
    // resolution (the framebuffer, drawn 1:1 — see app.ts's frame()).
    const px = ((event.clientX - rect.left) * canvas.width) / rect.width;
    const py = ((event.clientY - rect.top) * canvas.height) / rect.height;
    const info = copperInstructionAtPixel(M, px, py, canvas.width, canvas.height);
    if (window.__copperHoverDebug) {
      console.log("[copperHover]", debugCopperHoverState(M, px, py, canvas.width, canvas.height), "info:", info);
    }
    if (!info) {
      hide();
      return;
    }
    render(info, event.clientX, event.clientY);
    if (vscodeApi && !symbolCache.has(info.address)) {
      requestSymbol(vscodeApi, info.address, () => {
        // Still hovering the same instruction? Re-render to add the source
        // line now that it's resolved (or leave it off if there isn't one).
        if (current && current.info.address === info.address) {
          render(current.info, current.clientX, current.clientY);
        }
      });
    }
  });

  canvas.addEventListener("mouseleave", hide);

  canvas.addEventListener("click", () => {
    if (!vscodeApi || !current) return;
    const location = symbolCache.get(current.info.address);
    if (location) {
      vscodeApi.postMessage({ type: "openSource", path: location.path, line: location.line });
    }
  });
}
