// Webview-side DMA channel styling: map a (BusOwner, flags) pair to a color + label,
// reproducing the old vscode-amiga-debug DMA line. Color constants are copied verbatim from
// that extension and are **0xAABBGGRR** (R = low byte, B = high byte).
//
// CPU is split into Code/Data (the CODE flag), Copper into MOVE/WAIT/SKIP (the
// sub-state bits) — everything else is identified by BusOwner alone.

import {
  BusOwner,
  DMA_CODE,
  DMA_SUB_SHIFT,
  DMA_SUB_MASK,
  COP_SUB_WAIT,
  COP_SUB_SKIP,
} from "../../shared/profilerTypes";
import { CUSTOM_REGISTER_OFFSETS } from "../shared/customRegisters";
import { BlitMode } from "./blits";

// DMACON channel-enable / control bits (write register 0x096). Named so the DMA-Control readout
// doesn't sprinkle magic hex masks.
export const DMACONFlags = {
  BLTPRI: 1 << 10,
  DMAEN: 1 << 9, // master enable
  BPLEN: 1 << 8,
  COPEN: 1 << 7,
  BLTEN: 1 << 6,
  SPREN: 1 << 5,
  DSKEN: 1 << 4,
  AUD3EN: 1 << 3,
  AUD2EN: 1 << 2,
  AUD1EN: 1 << 1,
  AUD0EN: 1 << 0,
} as const;

// DMACON register word index in a 256-entry custom-register file (offset/2).
export const DMACON_REG_INDEX = CUSTOM_REGISTER_OFFSETS.DMACON >> 1;

export interface ChannelStyle {
  key: string; // stable identity for merging/aggregation (CPU split, Copper split)
  label: string; // tooltip / time-view row name
  color: string; // CSS rgb()
  r: number; // colour components (0..255), so consumers can blend without parsing `color`
  g: number;
  b: number;
  textDark?: boolean; // draw an on-color label in dark text (blit band only; default light)
}

// Build a ChannelStyle from a single 0xAABBGGRR literal (the colour constants below are
// **0xAABBGGRR** — R = low byte). Exposes both the CSS string and the numeric r/g/b so consumers
// like the DMA band's box-filter blend use the components directly instead of parsing `color`.
const mk = (key: string, label: string, abgr: number, textDark?: boolean): ChannelStyle => {
  const r = abgr & 0xff, g = (abgr >> 8) & 0xff, b = (abgr >> 16) & 0xff;
  const style: ChannelStyle = { key, label, color: `rgb(${r},${g},${b})`, r, g, b };
  if (textDark) style.textDark = true;
  return style;
};

// Owner-only styles (CPU and Copper are handled specially in channelStyle).
const OWNER_STYLE: Record<number, ChannelStyle> = {
  [BusOwner.REFRESH]: mk("refresh", "Refresh", 0xff444444),
  [BusOwner.DISK]: mk("disk", "Disk", 0xffffffff),
  [BusOwner.AUD0]: mk("aud0", "Audio 0", 0xff0000ff),
  [BusOwner.AUD1]: mk("aud1", "Audio 1", 0xff0000ee),
  [BusOwner.AUD2]: mk("aud2", "Audio 2", 0xff0000dd),
  [BusOwner.AUD3]: mk("aud3", "Audio 3", 0xff0000cc),
  [BusOwner.BPL1]: mk("bpl1", "Bitplane 1", 0xffff0000),
  [BusOwner.BPL2]: mk("bpl2", "Bitplane 2", 0xffee0000),
  [BusOwner.BPL3]: mk("bpl3", "Bitplane 3", 0xffdd0000),
  [BusOwner.BPL4]: mk("bpl4", "Bitplane 4", 0xffcc0000),
  [BusOwner.BPL5]: mk("bpl5", "Bitplane 5", 0xffbb0000),
  [BusOwner.BPL6]: mk("bpl6", "Bitplane 6", 0xffaa0000),
  [BusOwner.BPL7]: mk("bpl7", "Bitplane 7", 0xff990000),
  [BusOwner.BPL8]: mk("bpl8", "Bitplane 8", 0xff880000),
  [BusOwner.SPRITE0]: mk("spr0", "Sprite 0", 0xffff00ff),
  [BusOwner.SPRITE1]: mk("spr1", "Sprite 1", 0xffee00ee),
  [BusOwner.SPRITE2]: mk("spr2", "Sprite 2", 0xffdd00dd),
  [BusOwner.SPRITE3]: mk("spr3", "Sprite 3", 0xffcc00cc),
  [BusOwner.SPRITE4]: mk("spr4", "Sprite 4", 0xffbb00bb),
  [BusOwner.SPRITE5]: mk("spr5", "Sprite 5", 0xffaa00aa),
  [BusOwner.SPRITE6]: mk("spr6", "Sprite 6", 0xff990099),
  [BusOwner.SPRITE7]: mk("spr7", "Sprite 7", 0xff880088),
  [BusOwner.BLITTER]: mk("blitter", "Blitter", 0xff888800),
};

// Idle / blocked bus cycles. The old vscode-amiga-debug drew a dark gray "-" box (dmaTypes
// type 0) for these, so the DMA band is gap-free rather than blank; we do the same for both
// NONE (truly idle) and BLOCKED (CPU wanted the bus but was denied).
const IDLE: ChannelStyle = mk("idle", "-", 0xff222222);

const CPU_CODE: ChannelStyle = mk("cpu-code", "CPU Code", 0xff4253a2);
const CPU_DATA: ChannelStyle = mk("cpu-data", "CPU Data", 0xffd698ad);
const COP_MOVE: ChannelStyle = mk("cop-move", "Copper", 0xff00eeee);
const COP_WAIT: ChannelStyle = mk("cop-wait", "Copper Wait", 0xff22aaaa);
const COP_SKIP: ChannelStyle = mk("cop-skip", "Copper Skip", 0xff446666);

// Blit-line band colors by mode (the flame's second band). ABGR values copied verbatim from
// the old vscode-amiga-debug dmaTypes BLITTER subtypes; Copy matches the BLITTER owner color
// above so a copy blit's box tones with its DMA-band cells.
const BLIT_STYLE: Record<BlitMode, ChannelStyle> = {
  [BlitMode.Copy]: mk("blit-copy", "Blit", 0xff888800),
  [BlitMode.Fill]: mk("blit-fill", "Fill", 0xeeff8800),
  [BlitMode.Line]: mk("blit-line", "Line", 0xdd00ff00, true), // bright green
};

export function blitStyle(mode: BlitMode): ChannelStyle {
  return BLIT_STYLE[mode];
}

// The conventional custom data-register a channel DMA reads into / writes from, inferred from the
// bus owner. The old extension got this from WinUAE's per-cell `dma_rec.reg`; our grid only carries
// the bus owner + memory address, so we map owner → register here (so the tooltip can show the
// register name + its documentation for bitplane/audio/sprite/disk cells, not just the RAM address).
// Returns the register offset (0x000..0x1FE) or undefined when it can't be determined:
//   * Blitter — the channel (A/B/C/D) isn't recorded, so no single register applies.
//   * Copper non-MOVE / CPU / Refresh — no associated data register.
// Copper MOVEs and CPU custom accesses already carry the real register in their bus address.
export function ownerRegister(owner: number): number | undefined {
  const R = CUSTOM_REGISTER_OFFSETS;
  // Indexed channels: named base register + per-channel stride (2/8/0x10 bytes).
  if (owner >= BusOwner.BPL1 && owner <= BusOwner.BPL8) return R.BPL1DAT + (owner - BusOwner.BPL1) * 2;
  if (owner >= BusOwner.SPRITE0 && owner <= BusOwner.SPRITE7) return R.SPR0DATA + (owner - BusOwner.SPRITE0) * 8;
  if (owner >= BusOwner.AUD0 && owner <= BusOwner.AUD3) return R.AUD0DAT + (owner - BusOwner.AUD0) * (R.AUD1DAT - R.AUD0DAT);
  if (owner === BusOwner.DISK) return R.DSKDAT;
  return undefined;
}

// DMACON channel-enable bits → the old extension's "DMA Control" chip list (same order/names).
// When the master enable (DMAEN) is clear, all channels are off regardless of their bits, so we
// show just "Master" off — exactly like vscode-amiga-debug's flame-graph DMACON readout.
export interface DmaconChannel {
  name: string;
  on: boolean;
}
export function dmaconChannels(dmacon: number): DmaconChannel[] {
  const F = DMACONFlags;
  const bit = (m: number) => (dmacon & m) !== 0;
  if (!bit(F.DMAEN)) return [{ name: "Master", on: false }];
  return [
    { name: "Master", on: true },
    { name: "Raster", on: bit(F.BPLEN) },
    { name: "Copper", on: bit(F.COPEN) },
    { name: "Blitter", on: bit(F.BLTEN) },
    { name: "BltPri", on: bit(F.BLTPRI) },
    { name: "Sprite", on: bit(F.SPREN) },
    { name: "Disk", on: bit(F.DSKEN) },
    { name: "Aud0", on: bit(F.AUD0EN) },
    { name: "Aud1", on: bit(F.AUD1EN) },
    { name: "Aud2", on: bit(F.AUD2EN) },
    { name: "Aud3", on: bit(F.AUD3EN) },
  ];
}

// Returns the style for a DMA cycle. Idle/blocked cycles get the dark "-" style (continuous
// band, like the old extension) rather than null — so every slot draws and is hoverable.
export function channelStyle(owner: number, flags: number): ChannelStyle | null {
  switch (owner) {
    case BusOwner.NONE:
    case BusOwner.BLOCKED:
      return IDLE;
    case BusOwner.CPU:
      return flags & DMA_CODE ? CPU_CODE : CPU_DATA;
    case BusOwner.COPPER: {
      const sub = (flags & DMA_SUB_MASK) >> DMA_SUB_SHIFT;
      return sub === COP_SUB_WAIT ? COP_WAIT : sub === COP_SUB_SKIP ? COP_SKIP : COP_MOVE;
    }
    default:
      return OWNER_STYLE[owner] ?? null;
  }
}

// Per-cycle hardware-event bitfield (PUAE/WinUAE's dma_rec.evt — debug.h's DMA_EVENT_* defines,
// libretro-uae/sources/src/include/debug.h:251-282). Most cycles set none of these; a set bit
// means something notable coincided with that exact cycle (an IRQ fired, the copper woke up,
// a display-timing boundary was crossed, ...), distinct from `owner`/`flags` which only say who
// used the bus and whether it was a read/write. `evt2` (IPL/IPLSAMPLE/COPPERUSE) isn't captured.
export const DMA_EVENT_BLITIRQ = 1 << 0;
export const DMA_EVENT_BLITFINALD = 1 << 1;
export const DMA_EVENT_BLITSTARTFINISH = 1 << 2;
export const DMA_EVENT_BPLFETCHUPDATE = 1 << 3;
export const DMA_EVENT_COPPERWAKE = 1 << 4;
export const DMA_EVENT_CPUIRQ = 1 << 5;
export const DMA_EVENT_INTREQ = 1 << 6;
export const DMA_EVENT_COPPERWANTED = 1 << 7;
export const DMA_EVENT_NOONEGETS = 1 << 8;
export const DMA_EVENT_CPUBLITTERSTEAL = 1 << 9;
export const DMA_EVENT_CPUBLITTERSTOLEN = 1 << 10;
export const DMA_EVENT_COPPERSKIP = 1 << 11;
export const DMA_EVENT_DDFSTRT = 1 << 12;
export const DMA_EVENT_DDFSTOP = 1 << 13;
export const DMA_EVENT_DDFSTOP2 = 1 << 14;
export const DMA_EVENT_SPECIAL = 1 << 15;
export const DMA_EVENT_VB = 0x00010000;
export const DMA_EVENT_VS = 0x00020000;
export const DMA_EVENT_LOF = 0x00040000;
export const DMA_EVENT_LOL = 0x00080000;
export const DMA_EVENT_HBS = 0x00100000;
export const DMA_EVENT_HBE = 0x00200000;
export const DMA_EVENT_HDIWS = 0x00400000;
export const DMA_EVENT_HDIWE = 0x00800000;
export const DMA_EVENT_VDIW = 0x01000000;
export const DMA_EVENT_HSS = 0x02000000;
export const DMA_EVENT_HSE = 0x04000000;
export const DMA_EVENT_CIAA_IRQ = 0x08000000;
export const DMA_EVENT_CIAB_IRQ = 0x10000000;
export const DMA_EVENT_CPUSTOP = 0x20000000;
export const DMA_EVENT_CPUSTOPIPL = 0x40000000;
export const DMA_EVENT_CPUINS = 0x80000000;

// (bit, short label) in debug.h declaration order — drives the DMA tooltip's Events chip row.
const DMA_EVENT_LIST: readonly [number, string][] = [
  [DMA_EVENT_BLITIRQ, "BLITIRQ"],
  [DMA_EVENT_BLITFINALD, "BLITFINALD"],
  [DMA_EVENT_BLITSTARTFINISH, "BLITSTARTFINISH"],
  [DMA_EVENT_BPLFETCHUPDATE, "BPLFETCHUPDATE"],
  [DMA_EVENT_COPPERWAKE, "COPPERWAKE"],
  [DMA_EVENT_CPUIRQ, "CPUIRQ"],
  [DMA_EVENT_INTREQ, "INTREQ"],
  [DMA_EVENT_COPPERWANTED, "COPPERWANTED"],
  [DMA_EVENT_NOONEGETS, "NOONEGETS"],
  [DMA_EVENT_CPUBLITTERSTEAL, "CPUBLITTERSTEAL"],
  [DMA_EVENT_CPUBLITTERSTOLEN, "CPUBLITTERSTOLEN"],
  [DMA_EVENT_COPPERSKIP, "COPPERSKIP"],
  [DMA_EVENT_DDFSTRT, "DDFSTRT"],
  [DMA_EVENT_DDFSTOP, "DDFSTOP"],
  [DMA_EVENT_DDFSTOP2, "DDFSTOP2"],
  [DMA_EVENT_SPECIAL, "SPECIAL"],
  [DMA_EVENT_VB, "VB"],
  [DMA_EVENT_VS, "VS"],
  [DMA_EVENT_LOF, "LOF"],
  [DMA_EVENT_LOL, "LOL"],
  [DMA_EVENT_HBS, "HBS"],
  [DMA_EVENT_HBE, "HBE"],
  [DMA_EVENT_HDIWS, "HDIWS"],
  [DMA_EVENT_HDIWE, "HDIWE"],
  [DMA_EVENT_VDIW, "VDIW"],
  [DMA_EVENT_HSS, "HSS"],
  [DMA_EVENT_HSE, "HSE"],
  [DMA_EVENT_CIAA_IRQ, "CIAA_IRQ"],
  [DMA_EVENT_CIAB_IRQ, "CIAB_IRQ"],
  [DMA_EVENT_CPUSTOP, "CPUSTOP"],
  [DMA_EVENT_CPUSTOPIPL, "CPUSTOPIPL"],
  [DMA_EVENT_CPUINS, "CPUINS"],
];

// The set bits' names, in declaration order — empty for the (overwhelmingly common) no-event cycle.
export function dmaEventNames(bits: number): string[] {
  const names: string[] = [];
  for (const [bit, name] of DMA_EVENT_LIST) {
    if (bits & bit) names.push(name);
  }
  return names;
}
