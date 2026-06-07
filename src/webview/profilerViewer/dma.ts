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

export interface ChannelStyle {
  key: string; // stable identity for merging/aggregation (CPU split, Copper split)
  label: string; // tooltip / time-view row name
  color: string; // CSS rgb()
}

const rgb = (abgr: number): string =>
  `rgb(${abgr & 0xff},${(abgr >> 8) & 0xff},${(abgr >> 16) & 0xff})`;

// Owner-only styles (CPU and Copper are handled specially in channelStyle).
const OWNER_STYLE: Record<number, ChannelStyle> = {
  [BusOwner.REFRESH]: { key: "refresh", label: "Refresh", color: rgb(0xff444444) },
  [BusOwner.DISK]: { key: "disk", label: "Disk", color: rgb(0xffffffff) },
  [BusOwner.AUD0]: { key: "aud0", label: "Audio 0", color: rgb(0xff0000ff) },
  [BusOwner.AUD1]: { key: "aud1", label: "Audio 1", color: rgb(0xff0000ee) },
  [BusOwner.AUD2]: { key: "aud2", label: "Audio 2", color: rgb(0xff0000dd) },
  [BusOwner.AUD3]: { key: "aud3", label: "Audio 3", color: rgb(0xff0000cc) },
  [BusOwner.BPL1]: { key: "bpl1", label: "Bitplane 1", color: rgb(0xffff0000) },
  [BusOwner.BPL2]: { key: "bpl2", label: "Bitplane 2", color: rgb(0xffee0000) },
  [BusOwner.BPL3]: { key: "bpl3", label: "Bitplane 3", color: rgb(0xffdd0000) },
  [BusOwner.BPL4]: { key: "bpl4", label: "Bitplane 4", color: rgb(0xffcc0000) },
  [BusOwner.BPL5]: { key: "bpl5", label: "Bitplane 5", color: rgb(0xffbb0000) },
  [BusOwner.BPL6]: { key: "bpl6", label: "Bitplane 6", color: rgb(0xffaa0000) },
  [BusOwner.SPRITE0]: { key: "spr0", label: "Sprite 0", color: rgb(0xffff00ff) },
  [BusOwner.SPRITE1]: { key: "spr1", label: "Sprite 1", color: rgb(0xffee00ee) },
  [BusOwner.SPRITE2]: { key: "spr2", label: "Sprite 2", color: rgb(0xffdd00dd) },
  [BusOwner.SPRITE3]: { key: "spr3", label: "Sprite 3", color: rgb(0xffcc00cc) },
  [BusOwner.SPRITE4]: { key: "spr4", label: "Sprite 4", color: rgb(0xffbb00bb) },
  [BusOwner.SPRITE5]: { key: "spr5", label: "Sprite 5", color: rgb(0xffaa00aa) },
  [BusOwner.SPRITE6]: { key: "spr6", label: "Sprite 6", color: rgb(0xff990099) },
  [BusOwner.SPRITE7]: { key: "spr7", label: "Sprite 7", color: rgb(0xff880088) },
  [BusOwner.BLITTER]: { key: "blitter", label: "Blitter", color: rgb(0xff888800) },
};

const CPU_CODE: ChannelStyle = { key: "cpu-code", label: "CPU Code", color: rgb(0xff4253a2) };
const CPU_DATA: ChannelStyle = { key: "cpu-data", label: "CPU Data", color: rgb(0xffd698ad) };
const COP_MOVE: ChannelStyle = { key: "cop-move", label: "Copper", color: rgb(0xff00eeee) };
const COP_WAIT: ChannelStyle = { key: "cop-wait", label: "Copper Wait", color: rgb(0xff22aaaa) };
const COP_SKIP: ChannelStyle = { key: "cop-skip", label: "Copper Skip", color: rgb(0xff446666) };

// Returns the style for a DMA cycle, or null for idle/blocked cycles (not drawn).
export function channelStyle(owner: number, flags: number): ChannelStyle | null {
  switch (owner) {
    case BusOwner.NONE:
    case BusOwner.BLOCKED:
      return null;
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
