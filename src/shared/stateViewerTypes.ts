/**
 * Shared types for the Amiga State Viewer webview
 */

/**
 * RGB color value from Amiga's 4-bit RGB format
 */
export interface AmigaColor {
  /** 4-bit red value (0-15) */
  r: number;
  /** 4-bit green value (0-15) */
  g: number;
  /** 4-bit blue value (0-15) */
  b: number;
  /** Register number (0-31) */
  register: number;
}

/**
 * One entry of AGA's full 256-colour, 8-bit-per-channel palette (BPLCON3 bank/LOCT already
 * resolved chip-side — unlike AmigaColor, this is NOT a raw COLORxx register readout).
 */
export interface AmigaColor256 {
  /** 8-bit red value (0-255) */
  r: number;
  /** 8-bit green value (0-255) */
  g: number;
  /** 8-bit blue value (0-255) */
  b: number;
  /** Palette index (0-255) */
  register: number;
}

/**
 * Display configuration and state information
 */
export interface DisplayState {
  /** Color palette (32 colors from COLOR00-COLOR31 registers, current BPLCON3 bank only, 4-bit/channel) */
  palette: AmigaColor[];
  /** AGA's full 256-colour, 8-bit-per-channel palette (all 8 BPLCON3 banks). Absent outside AGA mode
   *  — callers should fall back to `palette` in that case. */
  aga256Palette?: AmigaColor256[];
  /** Number of active bitplanes (0-8; AGA supports up to 8, OCS/ECS up to 6) */
  bitplanes?: number;
  /** Is interlaced mode enabled */
  interlaced?: boolean;
  /** Is high-res mode enabled */
  hires?: boolean;
  /** Is super-hires mode enabled (BPLCON0 bit 6, AGA only) */
  shres?: boolean;
  /** Is HAM (Hold-And-Modify) mode enabled */
  ham?: boolean;
  /** HAM variant in effect when `ham` is set: 6 (OCS/ECS, from a 6-plane BPLCON0) or 8 (AGA, from an
   *  8-plane BPLCON0). Undefined when `ham` is false or the plane count doesn't match either variant. */
  hamBits?: 6 | 8;
  /** Is DPF (Dual Playfield) mode enabled */
  dpf?: boolean;
  /** Is ECS mode enabled (from BPLCON0) */
  ecsEna?: boolean;
  /** Is this an AGA chipset capture (aga256Palette/fetchMode/bplam/esprm/osprm all gated on this) */
  isAga?: boolean;
  /** AGA bitplane DMA fetch mode (FMODE bits 1-0): 0=1x, 1=2x, 2=4x words per DMA slot */
  fetchMode?: number;
  /** BPLCON4 BPLAM: 8-bit XOR mask applied to the playfield colour index before palette lookup */
  bplam?: number;
  /** BPLCON4 ESPRM: colour-bank nibble for even-numbered sprites (0/2/4/6) */
  esprm?: number;
  /** BPLCON4 OSPRM: colour-bank nibble for odd-numbered sprites (1/3/5/7) */
  osprm?: number;
  /** Playfield 2 horizontal position (from BPLCON1) */
  pf2h?: number;
  /** Playfield 1 horizontal position (from BPLCON1) */
  pf1h?: number;
  /** Playfield 2 priority over pf1 (from BPLCON2) */
  pf2Pri: boolean;
  /** Playfield 2 priority with respect to sprites (from BPLCON2) */
  pf2p: number;
  /** Playfield 1 priority with respect to sprites (from BPLCON2) */
  pf1p: number;
  /** Are border sprites enabled (from BPLCON3) */
  borderSprites?: boolean;
  /** Is border transparent (from BPLCON3) */
  borderTransparent?: boolean;
  /** Is border blanked (from BPLCON3) */
  borderBlank?: boolean;
  /** Display window start register value */
  diwstrt: string;
  /** Display window stop register value */
  diwstop: string;
  /** Display data fetch start register value */
  ddfstrt: string;
  /** Display data fetch stop register value */
  ddfstop: string;
}

/**
 * Segment information for a memory block
 */
export interface SegmentInfo {
  name: string;
  address: number;
}

/**
 * Memory block information from Exec memory management
 */
export interface MemoryBlock {
  address: number;
  size: number;
  free: boolean;
  attributes: number;
  /** Optional segment name if this block maps to a loaded program segment */
  segmentName?: string;
  /** Optional array of segments that map to this block */
  segments?: SegmentInfo[];
}

/**
 * Memory region information
 */
export interface MemoryRegion {
  lower: number;
  upper: number;
  attributes: number;
  firstChunk: number;
}

/**
 * Comprehensive memory information from Exec structures
 */
export interface MemoryInfo {
  execBase: number;
  memList: number;
  totalChip: number;
  totalSlow: number;
  totalFast: number;
  freeChip: number;
  freeSlow: number;
  freeFast: number;
  blocks: MemoryBlock[];
  regions: MemoryRegion[];
}

/**
 * Messages from extension to webview
 */
export interface UpdateDisplayStateMessage {
  command: "updateDisplayState";
  displayState: DisplayState;
}

export interface UpdateMemoryInfoMessage {
  command: "updateMemoryInfo";
  memoryInfo: MemoryInfo;
}

export interface ShowErrorMessage {
  command: 'showError';
  error: string;
}

/**
 * Messages from webview to extension
 */
export interface ReadyMessage {
  command: "ready";
}

export interface RefreshMessage {
  command: "refresh";
}

export interface OpenMemoryViewerMessage {
  command: "openMemoryViewer";
  address: number;
}

export type StateViewerMessage = ReadyMessage | RefreshMessage | OpenMemoryViewerMessage;
