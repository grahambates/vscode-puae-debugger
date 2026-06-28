// Hover tooltip for the live DMA overlay: maps a mouse position over the
// video canvas to whatever owned that DMA cycle and shows brief info about
// it. Copper gets full instruction disassembly (+ source-location lookup);
// CPU gets the profiler-style Address/Register + Data + Access breakdown,
// plus the same source-location lookup/click-to-open as copper when the
// cycle was an instruction fetch (isCode) — a data read/write's address
// isn't a code location, so it gets no source line; blitter gets per-cycle
// channel/read-write/data/address plus the overall blit configuration;
// refresh/audio/bitplane/sprite/disk (always plain reads except disk, no
// configuration to summarize) just get the channel and memory address.
// DMARECORD_CONFLICT is intentionally unhandled — see the DMARECORD_REFRESH
// comment below for why.
//
// All lookups read the *last completed frame* live (not the separate
// wasm_dma_get_grid_ptr/size grid, which is profiler-only — it's only
// populated on demand by wasm_dma_serialize_grid and otherwise stale), via
// small single-cell queries in puae-wasm/libretro-uae/sources/src/debug.c:
//  - wasm_dma_get_cell_type(hpos, vpos): DMARECORD_* (debug.h) — which
//    channel owned this DMA cycle, if any;
//  - wasm_dma_get_cell_addr(hpos, vpos): the raw bus address fetched/written
//    on that cycle;
//  - wasm_dma_get_cell_data(hpos, vpos): the raw bus data for that cycle;
//  - wasm_dma_get_cell_extra(hpos, vpos): type-specific sub-channel/mode
//    bits (e.g. blitter A/B/C/D + fill/line — see decodeBlitterChannel;
//    audio/bitplane/sprite's channel/plane/sprite index — see
//    channelInfoAtSlot).
//
// Copper additionally uses e9k_copper_serialize/wasm_copper_get_records_ptr/
// size, a flat dump of cop_record[] (addr/w1/w2/hpos/vpos per instruction,
// the same data record_copper() has always collected for the disassembler/
// breakpoint commands, just not previously exposed to JS) to recover the
// actual instruction words — matched by address (cell addr == instruction
// addr, or addr - 2), not by hpos/vpos cycle position, since the gap
// between an instruction's two word fetches isn't reliably exactly 1 DMA
// cycle once other channels can contend for the bus.
import { disassembleCopperInstruction } from "../../shared/copperDisassembler";
import { DMA_HPOS, DMA_VPOS } from "../../shared/profilerTypes";
import { BLTCON0Flags, BLTCON1Flags, BlitOp } from "../profilerViewer/blitMinterm";
import { customRegisterLabel } from "../shared/customRegisters";
import type { PuaeModule } from "./types";

// addr:u32, w1:u16, w2:u16, hpos:u16, vpos:u16 — see e9k_copper_serialize.
const COPPER_RECORD_BYTES = 12;

// DMARECORD_* (puae-wasm/libretro-uae/sources/src/include/debug.h) — the
// values wasm_dma_get_cell_type returns. DMARECORD_CONFLICT (9) is
// deliberately not handled here: verified it's unreachable in practice —
// every known hardware DMA-priority quirk this emulator models (the
// bitplane/sprite chipset bug, strobe/refresh slot conflicts; see
// custom.c:2733/2879/2947) computes its merged result and logs it as a
// single ordinary BITPLANE/REFRESH record, deliberately avoiding the
// generic conflict-detection path (two of them call record_dma_clear_2()
// first specifically to prevent it firing). Those quirks already show up
// here as a normal BITPLANE/REFRESH entry with merged/unusual values.
const DMARECORD_REFRESH = 1;
const DMARECORD_CPU = 2;
const DMARECORD_AUDIO = 4;
const DMARECORD_COPPER = 3;
const DMARECORD_BLITTER = 5;
const DMARECORD_BITPLANE = 6;
const DMARECORD_SPRITE = 7;
const DMARECORD_DISK = 8;

// "No data" sentinels for the cell getters.
const NO_ADDR = 0xffffffff;
const NO_EXTRA = 0xffff;
const NO_REG = 0xffff;

// hpos/vpos of the hovered DMA cell — shown in every tooltip as "Line
// {vpos}, Color Clock {hpos}", matching the profiler's DMA tooltip
// (FlameGraph.tsx's dmaInfo.line/colorClock).
interface DmaHoverPosition {
  hpos: number;
  vpos: number;
}

export interface CopperHoverInfo extends DmaHoverPosition {
  kind: "copper";
  address: number;
  mnemonic: string;
  operands: string;
  comment?: string;
  // RGB (0-255 each), set when this is a MOVE to a COLORnn register — see
  // disassembleCopperInstruction (src/shared/copperDisassembler.ts).
  color?: [number, number, number];
}

// The blit's overall configuration — BLTCON0/1, size, the four channel
// pointers/modulos — reconstructed as of the hovered DMA cycle (see
// readBlitConfigAt below), not read live: the hovered cell is from the last
// completed frame, and registers persist unchanged until next written, so a
// live read would show whatever blit was *most recently configured*, not
// necessarily the one that owned the hovered cycle.
export interface BlitConfig {
  con0: number;
  con1: number;
  widthWords: number;
  heightLines: number;
  ptr: [number, number, number, number]; // A,B,C,D
  mod: [number, number, number, number]; // A,B,C,D (signed)
}

export interface BlitterHoverInfo extends DmaHoverPosition {
  kind: "blitter";
  address: number;
  channel: "A" | "B" | "C" | "D";
  readWrite: "read" | "write";
  data: number;
  mode?: "fill" | "line";
  // Undefined if the register-write log isn't available yet (e.g. the DMA
  // overlay was only just enabled this frame).
  config?: BlitConfig;
}

// Audio/bitplane/sprite/disk DMA cycles are always plain reads (Agnus
// fetching data into the custom chip — except disk, which can write too,
// but is otherwise a single channel with no sub-index to show) with no
// configuration to summarize the way a blit has — just the channel and the
// memory address it read from/wrote to.
export interface ChannelHoverInfo extends DmaHoverPosition {
  kind: "channel";
  // e.g. "AUD2", "BPL3", "SPR0", "DSK" — matches the AUDnLC/BPLnPT/SPRnPT
  // custom register naming convention.
  channelLabel: string;
  address: number;
}

// CPU bus cycles — mirrors the profiler's CPU DMA tooltip (FlameGraph.tsx):
// Address (or Register, for a custom-register access), Data, Access
// (Read/Write + size), and whether a read was an instruction fetch.
export interface CpuHoverInfo extends DmaHoverPosition {
  kind: "cpu";
  address: number;
  data: number;
  size: "B" | "W" | "L";
  isWrite: boolean;
  // Only meaningful when !isWrite — writes are always data, never code.
  isCode: boolean;
}

export type DmaHoverInfo = CopperHoverInfo | BlitterHoverInfo | ChannelHoverInfo | CpuHoverInfo;

// --- Symbol/source-location lookup ---------------------------------------
//
// The extension host holds the session's SourceMap (WebviewEmulator.
// setSourceMap, wired from VamigaDebugAdapter); the webview asks it to
// symbolize an address via postMessage and gets an async reply — mirrors
// how breakpointManager.ts already resolves copper watchpoint hits to
// source via sourceMap.lookupAddress, just round-tripped through the
// webview instead of called directly (the lookup itself lives extension-
// side either way). For assembly sources, copper's source line often
// resolves directly to the `dc.w` (or similar) line that emits the
// instruction's data. The symbol+offset label (e.g. "Screen+12", matching
// src/numbers.ts's formatAddress convention used in the Variables view) is
// used for blitter channel pointers too, where a source line rarely applies
// but the enclosing symbol usually does.

export interface SourceLocation {
  path: string;
  line: number;
}

export interface SymbolInfo {
  location: SourceLocation | null;
  // Pre-formatted "name+offset" (or just "name" at offset 0), or null if no
  // enclosing symbol was found.
  symbolLabel: string | null;
}

interface VsCodeApi {
  postMessage(message: unknown): void;
}

// address -> resolved info. Module-scoped: there's only ever one PUAE
// canvas/panel per webview instance, so a single cache for the process
// lifetime is fine.
const symbolCache = new Map<number, SymbolInfo>();
const inFlight = new Set<number>();
const pendingRequests = new Map<string, (info: SymbolInfo) => void>();
let nextRequestId = 0;

// Handles `symbolizeResult` replies from the extension host — wire this into
// app.ts's `window.addEventListener('message', ...)`.
export function handleDmaHoverMessage(message: {
  type?: string;
  requestId?: string;
  location?: SourceLocation;
  symbol?: { name: string; offset: number };
}): void {
  if (!message || message.type !== "symbolizeResult" || !message.requestId) return;
  const resolve = pendingRequests.get(message.requestId);
  if (!resolve) return;
  pendingRequests.delete(message.requestId);
  const symbolLabel = message.symbol
    ? message.symbol.offset ? `${message.symbol.name}+${message.symbol.offset}` : message.symbol.name
    : null;
  resolve({ location: message.location ?? null, symbolLabel });
}

// Kicks off (or skips, if already cached/in flight) a symbolize request for
// `address`, calling `onResolved` once the result lands in symbolCache.
function requestSymbol(vscodeApi: VsCodeApi, address: number, onResolved: () => void): void {
  if (symbolCache.has(address) || inFlight.has(address)) return;
  inFlight.add(address);
  const requestId = `dmaSym${nextRequestId++}`;
  pendingRequests.set(requestId, (info) => {
    symbolCache.set(address, info);
    inFlight.delete(address);
    onResolved();
  });
  vscodeApi.postMessage({ type: "symbolizeAddress", address, requestId });
}

// Finds the cop_record[] entry whose instruction starts at `fetchAddr` (the
// hovered cell fetched its word1) or `fetchAddr - 2` (the cell fetched its
// word2, so the instruction started 2 bytes earlier).
function findCopperInstructionByAddr(M: PuaeModule, fetchAddr: number, hpos: number, vpos: number): CopperHoverInfo | undefined {
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
      kind: "copper",
      address: recAddr,
      mnemonic: insn.mnemonic,
      operands: insn.operands,
      comment: insn.comment,
      color: insn.color,
      hpos,
      vpos,
    };
  }
  return undefined;
}

// `extra & 7` is the blitter channel (0=A,1=B,2=C reads, 3=D write);
// `extra & 0x10`/`0x20` flag fill/line mode — see blitter.c's
// record_dma_blit (the call site that sets dr->extra for blitter cycles).
function decodeBlitterChannel(extra: number): Pick<BlitterHoverInfo, "channel" | "readWrite" | "mode"> {
  const ch = extra & 0x07;
  const channel = (["A", "B", "C", "D"] as const)[ch] ?? "D";
  const readWrite = ch === 3 ? "write" : "read";
  const mode = extra & 0x20 ? "line" : extra & 0x10 ? "fill" : undefined;
  return { channel, readWrite, mode };
}

const coerceI16 = (x: number): number => ((x ^ 0x8000) - 0x8000) | 0; // sign-extend a u16

// reg:u16, value:u16, hpos:i16, vpos:i16 — see e9k_regwrite_serialize.
const REGWRITE_RECORD_BYTES = 8;

// $DFFxxx offsets needed for the blit-config summary (custom_wput_1_impl's
// switch in custom.c, e.g. case 0x040: BLTCON0(...)).
const BLT_ADDR = {
  BLTCON0: 0x040, BLTCON1: 0x042, BLTSIZE: 0x058,
  BLTAPTH: 0x050, BLTAPTL: 0x052,
  BLTBPTH: 0x04c, BLTBPTL: 0x04e,
  BLTCPTH: 0x048, BLTCPTL: 0x04a,
  BLTDPTH: 0x054, BLTDPTL: 0x056,
  BLTAMOD: 0x064, BLTBMOD: 0x062, BLTCMOD: 0x060, BLTDMOD: 0x066,
};

// Reconstructs the blit's configuration as of the hovered DMA cycle by
// backward-scanning the register-write log (regwrite_record, debug.c) for
// the last write to each relevant register at-or-before that cycle's
// position — unlike reading the live custom-register shadow, this is tied
// to the specific blit the hovered cycle belongs to, not whatever blit was
// configured most recently. The log is in chronological (append) order and
// seeded with a pre-frame baseline (hpos=vpos=-1, sorts first), so a single
// forward pass that stops once it passes the target position is enough.
function readBlitConfigAt(M: PuaeModule, hpos: number, vpos: number): BlitConfig | undefined {
  const ptr = M._wasm_regwrite_get_records_ptr();
  const size = M._wasm_regwrite_get_records_size();
  if (!ptr || size < REGWRITE_RECORD_BYTES) return undefined;
  const count = (size / REGWRITE_RECORD_BYTES) | 0;
  const view = new DataView(M.HEAPU8.buffer, ptr, count * REGWRITE_RECORD_BYTES);
  const targetSlot = vpos * DMA_HPOS + hpos;

  const latest = new Map<number, number>(); // reg -> value
  for (let i = 0; i < count; i++) {
    const o = i * REGWRITE_RECORD_BYTES;
    const recVpos = view.getInt16(o + 6, true);
    const recHpos = view.getInt16(o + 4, true);
    const slot = recVpos < 0 ? -1 : recVpos * DMA_HPOS + recHpos;
    if (slot > targetSlot) break; // chronological order — nothing after this matters
    latest.set(view.getUint16(o + 0, true), view.getUint16(o + 2, true));
  }

  const get = (addr: number): number => latest.get(addr) ?? 0;
  const size16 = get(BLT_ADDR.BLTSIZE);
  return {
    con0: get(BLT_ADDR.BLTCON0),
    con1: get(BLT_ADDR.BLTCON1),
    widthWords: (size16 & 0x3f) === 0 ? 64 : size16 & 0x3f,
    heightLines: (size16 >> 6) & 0x3ff,
    ptr: [
      ((get(BLT_ADDR.BLTAPTH) << 16) | get(BLT_ADDR.BLTAPTL)) >>> 0,
      ((get(BLT_ADDR.BLTBPTH) << 16) | get(BLT_ADDR.BLTBPTL)) >>> 0,
      ((get(BLT_ADDR.BLTCPTH) << 16) | get(BLT_ADDR.BLTCPTL)) >>> 0,
      ((get(BLT_ADDR.BLTDPTH) << 16) | get(BLT_ADDR.BLTDPTL)) >>> 0,
    ],
    mod: [
      coerceI16(get(BLT_ADDR.BLTAMOD)),
      coerceI16(get(BLT_ADDR.BLTBMOD)),
      coerceI16(get(BLT_ADDR.BLTCMOD)),
      coerceI16(get(BLT_ADDR.BLTDMOD)),
    ],
  };
}

function blitterInfoAtSlot(M: PuaeModule, hpos: number, vpos: number): BlitterHoverInfo | undefined {
  const fetchAddr = M._wasm_dma_get_cell_addr(hpos, vpos);
  if (fetchAddr === NO_ADDR) return undefined;
  const extra = M._wasm_dma_get_cell_extra(hpos, vpos);
  if (extra === NO_EXTRA) return undefined;
  const data = M._wasm_dma_get_cell_data(hpos, vpos);
  return {
    kind: "blitter",
    address: fetchAddr >>> 0,
    data: (data >>> 0) & 0xffff,
    config: readBlitConfigAt(M, hpos, vpos),
    hpos,
    vpos,
    ...decodeBlitterChannel(extra),
  };
}

// `extra & 3` (audio) / `extra & 7` (bitplane, sprite) is the channel/plane/
// sprite index — see custom.c's record_dma_read call sites for each
// (e.g. AUD0-3's `record_dma_read(0xaa + nr*16, pt, hpos, vpos,
// DMARECORD_AUDIO, nr)`), matching e9k_dma_serialize's owner computation
// for these same types. Bitplane is shown 1-based (BPL1..BPL6) to match the
// BPLnPT/BPLnDAT register naming; audio/sprite are 0-based (AUD0-3, SPR0-7).
// Disk has only one channel (extra is a buffer-position counter, not an
// index), so it's always just "DSK". Refresh's extra is a positional slot
// index on the current line (not a stable per-channel identity the way
// audio/sprite/bitplane numbers are), so it's also just a fixed label.
function channelLabelFor(cellType: number, extra: number): string | undefined {
  if (cellType === DMARECORD_REFRESH) return "REFRESH";
  if (cellType === DMARECORD_AUDIO) return `AUD${extra & 3}`;
  if (cellType === DMARECORD_BITPLANE) return `BPL${(extra & 7) + 1}`;
  if (cellType === DMARECORD_SPRITE) return `SPR${extra & 7}`;
  if (cellType === DMARECORD_DISK) return "DSK";
  return undefined;
}

function channelInfoAtSlot(M: PuaeModule, hpos: number, vpos: number, cellType: number): ChannelHoverInfo | undefined {
  const fetchAddr = M._wasm_dma_get_cell_addr(hpos, vpos);
  if (fetchAddr === NO_ADDR) return undefined;
  const extra = M._wasm_dma_get_cell_extra(hpos, vpos);
  if (extra === NO_EXTRA) return undefined;
  const channelLabel = channelLabelFor(cellType, extra);
  if (!channelLabel) return undefined;
  return { kind: "channel", channelLabel, address: fetchAddr >>> 0, hpos, vpos };
}

// dr->reg for a CPU cell is a synthetic marker, not a register address:
// 0x1000|sizebits for a read, 0x1100|sizebits for a write (sizebits 1=byte,
// 2=word, 4=long) — see wait_cpu_cycle_read/write in custom.c and
// e9k_dma_get_cell_reg's comment. extra & 1 distinguishes an instruction
// fetch (0) from a data read (1); writes are always extra=1 (data).
function cpuInfoAtSlot(M: PuaeModule, hpos: number, vpos: number): CpuHoverInfo | undefined {
  const fetchAddr = M._wasm_dma_get_cell_addr(hpos, vpos);
  if (fetchAddr === NO_ADDR) return undefined;
  const reg = M._wasm_dma_get_cell_reg(hpos, vpos) & 0xffff;
  if (reg === NO_REG) return undefined;
  const extra = M._wasm_dma_get_cell_extra(hpos, vpos);
  const data = M._wasm_dma_get_cell_data(hpos, vpos);
  const isWrite = (reg & 0x100) !== 0;
  const sizeBits = reg & 0x7;
  const size = sizeBits === 4 ? "L" : sizeBits === 2 ? "W" : "B";
  return {
    kind: "cpu",
    address: fetchAddr >>> 0,
    data: data >>> 0,
    size,
    isWrite,
    isCode: !isWrite && (extra & 1) === 0,
    hpos,
    vpos,
  };
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

// Looks up DMA hover info under the given framebuffer pixel, if any.
// Returns undefined when the cell is idle, owned by a channel not toggled
// on in the overlay panel (debug_dma records every channel's cycles
// regardless of which ones the overlay is actually drawing — isChannelType
// Enabled keeps the tooltip in sync with what's visually highlighted), owned
// by a channel without a hover handler yet, or (for copper) instruction
// tracking isn't enabled (debug_copper off — see wasm_copper_tracking_enable).
function dmaHoverInfoAtPixel(
  M: PuaeModule,
  px: number,
  py: number,
  fbWidth: number,
  fbHeight: number,
  isChannelTypeEnabled: (type: number) => boolean,
): DmaHoverInfo | undefined {
  const slot = pixelToDmaSlot(px, py, fbWidth, fbHeight);
  if (!slot) return undefined;
  const cellType = M._wasm_dma_get_cell_type(slot.hpos, slot.vpos);
  if (!isChannelTypeEnabled(cellType)) return undefined;
  if (cellType === DMARECORD_COPPER) {
    const fetchAddr = M._wasm_dma_get_cell_addr(slot.hpos, slot.vpos);
    if (fetchAddr === NO_ADDR) return undefined;
    return findCopperInstructionByAddr(M, fetchAddr >>> 0, slot.hpos, slot.vpos);
  }
  if (cellType === DMARECORD_BLITTER) {
    return blitterInfoAtSlot(M, slot.hpos, slot.vpos);
  }
  if (cellType === DMARECORD_CPU) {
    return cpuInfoAtSlot(M, slot.hpos, slot.vpos);
  }
  if (
    cellType === DMARECORD_REFRESH ||
    cellType === DMARECORD_AUDIO ||
    cellType === DMARECORD_BITPLANE ||
    cellType === DMARECORD_SPRITE ||
    cellType === DMARECORD_DISK
  ) {
    return channelInfoAtSlot(M, slot.hpos, slot.vpos, cellType);
  }
  return undefined;
}

declare global {
  interface Window {
    // Set window.__dmaHoverDebug = true in the webview devtools console to
    // log diagnostic info (slot, cell type, info) on every mousemove over
    // the canvas — see installDmaHoverTooltip below.
    __dmaHoverDebug?: boolean;
  }
}

// Diagnostic snapshot of every step of the lookup, for window.__dmaHoverDebug.
function debugDmaHoverState(M: PuaeModule, px: number, py: number, fbWidth: number, fbHeight: number) {
  const slot = pixelToDmaSlot(px, py, fbWidth, fbHeight);
  const cellType = slot ? M._wasm_dma_get_cell_type(slot.hpos, slot.vpos) : undefined;
  const fetchAddr = slot ? M._wasm_dma_get_cell_addr(slot.hpos, slot.vpos) >>> 0 : undefined;
  const recPtr = M._wasm_copper_get_records_ptr();
  const recSize = M._wasm_copper_get_records_size();
  return {
    px, py, fbWidth, fbHeight,
    slot,
    cellType,
    fetchAddr: fetchAddr !== undefined ? "0x" + fetchAddr.toString(16) : undefined,
    copperRecordCount: recPtr ? (recSize / COPPER_RECORD_BYTES) | 0 : 0,
  };
}

// Builds the copper line: "$ADDR: MNEMONIC [swatch] OPERANDS", with a small
// colored square inserted right before the operands (the value) when this
// instruction is a MOVE to a COLORnn register.
function buildCopperLine(info: CopperHoverInfo): HTMLDivElement {
  const div = document.createElement("div");
  div.appendChild(document.createTextNode(`${addressLabel(info.address)}: ${info.mnemonic} `.trimStart()));
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

function buildBlitterLine(info: BlitterHoverInfo): HTMLDivElement {
  const div = document.createElement("div");
  const data = "$" + info.data.toString(16).toUpperCase().padStart(4, "0");
  div.textContent = `BLITTER ${info.channel} ${info.readWrite}  ${addressLabel(info.address)}: ${data}`;
  return div;
}

// Mirrors the profiler's CPU DMA tooltip: Address (or Register, for a
// custom-register access — matches dmaIsCustomReg's $DFFxxx range check),
// Data sized to the access width, and Access (Read/Write + size), with an
// "(code)" tag when a read was an instruction fetch rather than data.
function buildCpuLines(info: CpuHoverInfo): HTMLDivElement[] {
  const isCustomReg = (info.address & 0xfff000) === 0xdff000;
  const label = isCustomReg ? customRegisterLabel(info.address & 0x1fe) : addressLabel(info.address);
  const access = `${info.isWrite ? "Write" : "Read"}.${info.size}`;
  const codeTag = info.isCode ? " (code)" : "";

  const main = document.createElement("div");
  main.textContent = `CPU ${access}  ${label}${codeTag}`;

  const digits = info.size === "L" ? 8 : info.size === "W" ? 4 : 2;
  const mask = info.size === "L" ? 0xffffffff : info.size === "W" ? 0xffff : 0xff;
  const data = document.createElement("div");
  data.textContent = "$" + ((info.data & mask) >>> 0).toString(16).toUpperCase().padStart(digits, "0");

  return [main, data];
}

// "A-CD"-style channel-enable string from BLTCON0's USEA..USED bits.
const BLT_CHANNEL_USE: [number, "A" | "B" | "C" | "D"][] = [
  [BLTCON0Flags.USEA, "A"], [BLTCON0Flags.USEB, "B"],
  [BLTCON0Flags.USEC, "C"], [BLTCON0Flags.USED, "D"],
];
function blitChannelsLabel(con0: number): string {
  let s = "";
  for (const [bit, label] of BLT_CHANNEL_USE) if (con0 & bit) s += label;
  return s || "-";
}

// Label for a chip-memory address: the symbol+offset (e.g. "Screen+12",
// matching src/numbers.ts's formatAddress/the Variables view's convention)
// when known, otherwise the raw hex address.
function addressLabel(address: number): string {
  const symbolLabel = symbolCache.get(address)?.symbolLabel;
  return symbolLabel ?? "$" + address.toString(16).toUpperCase().padStart(6, "0");
}

// Brief lines summarizing the blit's overall configuration: size (in
// pixels — width is BLTSIZE's word count * 16), enabled channels, the
// logic op (or "LINE" mode), then one line per enabled channel's
// pointer + modulo.
function buildBlitConfigLines(config: BlitConfig): HTMLDivElement[] {
  const isLine = (config.con1 & BLTCON1Flags.LINE) !== 0;
  const opLabel = isLine ? "LINE" : BlitOp[config.con0 & 0xff] ?? "";
  const summary = document.createElement("div");
  summary.textContent =
    `${config.widthWords * 16}x${config.heightLines}px  ${blitChannelsLabel(config.con0)}  ${opLabel}`.trim();

  const lines = [summary];
  const useBits: [number, "A" | "B" | "C" | "D"][] = BLT_CHANNEL_USE;
  for (let i = 0; i < 4; i++) {
    const [bit, label] = useBits[i];
    if (!(config.con0 & bit)) continue;
    const line = document.createElement("div");
    line.textContent = `${label}: ${addressLabel(config.ptr[i])} mod ${config.mod[i]}`;
    lines.push(line);
  }
  return lines;
}

// "Line {vpos}, Color Clock {hpos}" — matches the profiler's DMA tooltip
// wording (FlameGraph.tsx) exactly, so the same raster position reads the
// same way in both places.
function buildPositionLine(info: DmaHoverPosition): HTMLDivElement {
  const line = document.createElement("div");
  line.textContent = `Line ${info.vpos}, Color Clock ${info.hpos}`;
  return line;
}

// Appends "path:line" for `address`'s source location, if known — shared by
// copper (always a code fetch) and CPU instruction-fetch cells.
function appendLocationLine(tooltip: HTMLDivElement, address: number): void {
  const location = symbolCache.get(address)?.location;
  if (!location) return;
  const line = document.createElement("div");
  line.textContent = `${location.path}:${location.line}`;
  tooltip.appendChild(line);
}

function renderTooltipContent(tooltip: HTMLDivElement, info: DmaHoverInfo): void {
  if (info.kind === "copper") {
    tooltip.replaceChildren(buildCopperLine(info));
    if (info.comment) {
      const line = document.createElement("div");
      line.textContent = info.comment;
      tooltip.appendChild(line);
    }
    appendLocationLine(tooltip, info.address);
  } else if (info.kind === "channel") {
    const line = document.createElement("div");
    line.textContent = `${info.channelLabel}: ${addressLabel(info.address)}`;
    tooltip.replaceChildren(line);
  } else if (info.kind === "cpu") {
    const [main, data] = buildCpuLines(info);
    tooltip.replaceChildren(main, data);
    if (info.isCode) appendLocationLine(tooltip, info.address);
  } else {
    tooltip.replaceChildren(buildBlitterLine(info));
    if (info.mode) {
      const line = document.createElement("div");
      line.textContent = info.mode === "line" ? "line mode" : "fill mode";
      tooltip.appendChild(line);
    }
    if (info.config) {
      for (const line of buildBlitConfigLines(info.config)) tooltip.appendChild(line);
    }
  }
  tooltip.appendChild(buildPositionLine(info));
}

// Wires a mousemove/mouseleave/click hover tooltip onto `canvas`, showing
// brief info about whichever DMA channel owned the hovered cell. `isActive`
// reports whether the DMA overlay is currently enabled with the COPPER
// channel on — copper-instruction tracking (debug_copper) is gated on that,
// so copper hovers stay empty without it; other channels' per-cycle info
// doesn't need that flag (just debug_dma, already on whenever any overlay
// channel is enabled) but `isActive` gates the whole tooltip for simplicity.
// `vscodeApi` (acquireVsCodeApi(), undefined outside the real VS Code
// webview e.g. debug.html) enables the source-location lookup and
// click-to-open for copper and CPU instruction-fetch cells; without it the
// tooltip still shows the disassembly/access info, just with no source
// line.
export function installDmaHoverTooltip(
  canvas: HTMLCanvasElement,
  M: PuaeModule,
  isActive: () => boolean,
  isChannelTypeEnabled: (type: number) => boolean,
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
  let current: { info: DmaHoverInfo; clientX: number; clientY: number } | undefined;

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

  function render(info: DmaHoverInfo, clientX: number, clientY: number): void {
    current = { info, clientX, clientY };
    renderTooltipContent(tooltip, info);
    tooltip.style.display = "block";
    positionTooltip(clientX, clientY);
  }

  // Re-renders whatever's currently shown once an async symbolize request
  // resolves — used as the shared onResolved callback below, regardless of
  // which address it was for (copper's own address, or one of a blit's
  // channel pointers): cheap, and avoids fragile "is this still the same
  // hover" address-matching now that a blit hover can be waiting on
  // several addresses at once.
  function rerenderCurrent(): void {
    if (current) render(current.info, current.clientX, current.clientY);
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
    const info = dmaHoverInfoAtPixel(M, px, py, canvas.width, canvas.height, isChannelTypeEnabled);
    if (window.__dmaHoverDebug) {
      console.log("[dmaHover]", debugDmaHoverState(M, px, py, canvas.width, canvas.height), "info:", info);
    }
    if (!info) {
      hide();
      return;
    }
    render(info, event.clientX, event.clientY);
    if (vscodeApi) {
      requestSymbol(vscodeApi, info.address, rerenderCurrent);
      if (info.kind === "blitter" && info.config) {
        // Symbolize whichever channel pointers are actually enabled, for
        // the "Screen+12"-style labels in buildBlitConfigLines.
        const useBits: [number, "A" | "B" | "C" | "D"][] = BLT_CHANNEL_USE;
        for (let i = 0; i < 4; i++) {
          if (info.config.con0 & useBits[i][0]) {
            requestSymbol(vscodeApi, info.config.ptr[i], rerenderCurrent);
          }
        }
      }
    }
  });

  canvas.addEventListener("mouseleave", hide);

  // Registered before installMouseCapture's click listener (app.ts installs
  // that after this), so stopImmediatePropagation here suppresses a
  // would-be pointer-lock request on the same click — opening a source file
  // shouldn't also grab the mouse into the canvas.
  canvas.addEventListener("click", (event) => {
    if (!vscodeApi || !current) return;
    const isCopper = current.info.kind === "copper";
    const isCpuCode = current.info.kind === "cpu" && current.info.isCode;
    if (!isCopper && !isCpuCode) return;
    const location = symbolCache.get(current.info.address)?.location;
    if (location) {
      event.stopImmediatePropagation();
      vscodeApi.postMessage({ type: "openSource", path: location.path, line: location.line });
    }
  });
}
