// Blitter-operation reconstruction from the captured per-cycle DMA grid — a host/webview-only
// port of the old vscode-amiga-debug `GetBlits` (src/client/dma.ts), adapted to our enriched
// grid. No emulator change: vAmiga's default BLITTER_ACCURACY=2 (SlowBlitter) stamps
// owner==BLITTER on every blitter bus cycle and sets the WRITE flag only on the D-channel write.
//
// Pipeline, per blit:
//   * START  — a write to BLTSIZE (OCS) or BLTSIZH (ECS). We shadow every register WRITE cell as
//              we walk (mirroring reconstructCustomRegs' DMA_WRITE gating) and snapshot the
//              blitter register set at the start.
//   * END    — the blitter's *final D write*, i.e. the last `owner==BLITTER && DMA_WRITE` cell
//              attributed to the blit. This is WinUAE's BLIFINALD event, reconstructed directly
//              from the bus — strictly more accurate than the old ext's `BLITIRQ + 8` fudge
//              (BLITIRQ fires at the end of internal counting, ~2+ cycles before the final write).
//
// CRITICAL: register detection MUST gate on the DMA_WRITE flag. vAmiga leaves a stale busAddr on
// idle cells (WinUAE leaves it undefined), so matching on the 0xDFFxxx address range alone
// invents phantom BLTSIZE writes (and an extra blit). Validated against template.puaeprofile:
// WRITE-gated reconstruction yields exactly the old ext's 17 blits; address-only yields 18.
//
// LIMITATION: there is no pre-capture register baseline (write-only blitter regs aren't
// snapshot), so the shadow file starts at 0 — a blit whose BLTCON/pointers were last written
// before the captured frame reconstructs those fields from 0. In practice the blitter registers
// are rewritten right before BLTSIZE, so this rarely bites (same gap noted in reconstruct.ts).

import { IDmaModel, BusOwner, DMA_WRITE, dmaIsCustomReg, DMA_HPOS } from "../../shared/profilerTypes";
import { CUSTOM_REGISTER_OFFSETS } from "../shared/customRegisters";
import { BLTCON0Flags, BLTCON1Flags, BlitOp } from "./blitMinterm";

export enum BlitMode {
  Copy,
  Fill,
  Line,
}

export interface Blit {
  startSlot: number; // BLTSIZE/BLTSIZH write slot (deterministic anchor)
  endSlot: number; // final D-write slot (BLIFINALD); last blitter cell if D-disabled; startSlot if none
  finished: boolean; // false => no blitter cells captured after start (ran past frame / fast blitter)
  width: number; // words (BLTSIZH field)
  height: number; // lines (BLTSIZV field)
  con0: number;
  con1: number;
  afwm: number; // BLTAFWM (first-word mask)
  alwm: number; // BLTALWM (last-word mask)
  ptr: number[]; // [A,B,C,D] pointer addresses
  dat: number[]; // [A,B,C] data registers (literal value shown for a disabled channel; D has none)
  mod: number[]; // [A,B,C,D] modulos (signed)
  mode: BlitMode;
}

// Result of reconstructing one capture's blits.
export interface BlitResult {
  blits: Blit[];
  // True when BLTSIZE writes were seen but no blitter bus cells were captured — the capture ran a
  // FastBlitter (BLITTER_ACCURACY < 2), so spans/ends are estimated, not measured.
  fastBlitter: boolean;
}

// Register offsets from $DFF000 (low byte of the custom address), from the shared canonical
// table. No BLTDDAT: there is no readable D-data register (0x76 is SPRHDAT) and the D channel
// never shows a literal.
const R = CUSTOM_REGISTER_OFFSETS;
// Channel order A,B,C,D for the pointer/modulo register triples and the USEx enables; DAT is
// A,B,C only (D has no data register).
const PTH = [R.BLTAPTH, R.BLTBPTH, R.BLTCPTH, R.BLTDPTH];
const DAT = [R.BLTADAT, R.BLTBDAT, R.BLTCDAT];
const MOD = [R.BLTAMOD, R.BLTBMOD, R.BLTCMOD, R.BLTDMOD];
const USE = [BLTCON0Flags.USEA, BLTCON0Flags.USEB, BLTCON0Flags.USEC, BLTCON0Flags.USED];

const coerce16 = (x: number): number => ((x ^ 0x8000) - 0x8000) | 0; // sign-extend a u16

function modeOf(con1: number): BlitMode {
  if (con1 & BLTCON1Flags.LINE) return BlitMode.Line;
  if (con1 & (BLTCON1Flags.EFE | BLTCON1Flags.IFE)) return BlitMode.Fill;
  return BlitMode.Copy;
}

// "A-CD"-style channel-enable string from BLTCON0 USEA..USED.
export function blitChannels(con0: number): string {
  let s = "";
  for (let c = 0; c < 4; c++) s += con0 & USE[c] ? "ABCD"[c] : "-";
  return s;
}

// Band/label verb: Clear (minterm 0), Blit (copy), Fill, Line.
export function blitVerb(blit: Blit): string {
  if (blit.mode === BlitMode.Line) return "Line";
  if (blit.mode === BlitMode.Fill) return "Fill";
  return (blit.con0 & 0xff) === 0 ? "Clear" : "Blit";
}

export function blitLabel(blit: Blit): string {
  return `${blitVerb(blit)} ${blitChannels(blit.con0)} ${blit.width * 16}x${blit.height}px`;
}

// A channel's real memory row stride, for lining up the Memory tab's visual view with the
// buffer a blit channel actually reads/writes (see BlitDetail.tsx / FlameGraph.tsx, the two
// places that jump there from a channel pointer). For area blits (Copy/Fill) the blitter
// advances a channel's pointer by (width*2 + modulo) bytes after each row (width is in words) —
// that IS the buffer's real row stride, regardless of the blit's own width in pixels. abs()
// because a negative modulo (upward/overlapping blits) still means the same physical stride.
//
// Line mode is different: BLTSIZE's width field is hardwired to a fixed constant (2 words),
// unrelated to the destination bitmap's geometry, so width*2+modulo is meaningless here. For
// line draw the C/D channel modulo alone already IS the bitmap's row stride (the Bresenham step
// uses BLTAMOD/BLTBMOD for its error term, not memory addressing).
//
// Clamped to MemoryVisual's supported row-width range (1..512 bytes).
export function channelStrideBytes(blit: Blit, modulo: number): number {
  return blit.mode === BlitMode.Line
    ? Math.min(512, Math.max(1, Math.abs(modulo)))
    : Math.min(512, Math.max(1, Math.abs(blit.width * 2 + modulo)));
}

// Reconstruct every blit in the captured frame from the DMA grid.
export function getBlits(dma: IDmaModel): BlitResult {
  const { owner, flags, addr, value } = dma;
  const N = owner.length;
  const regs = new Uint16Array(256); // shadow register file (intra-frame writes only)
  const regL = (off: number): number => (((regs[off >> 1] << 16) | regs[(off + 2) >> 1]) >>> 0);

  const blits: Blit[] = [];
  const lastDWrite: number[] = []; // final D-write slot per blit (-1 if none)
  const lastCell: number[] = []; // last blitter cell of any channel per blit (-1 if none)
  let blitterCells = 0;
  let bltSizeWrites = 0;

  for (let i = 0; i < N; i++) {
    const f = flags[i];

    // Shadow register writes — WRITE-gated (idle cells carry stale addresses; see header).
    if (f & DMA_WRITE && dmaIsCustomReg(owner[i], f, addr[i])) {
      const reg = addr[i] & 0x1fe;
      regs[reg >> 1] = value[i];

      const ocs = reg === R.BLTSIZE;
      const ecs = reg === R.BLTSIZH;
      if (ocs || ecs) {
        bltSizeWrites++;
        let width: number;
        let height: number;
        if (ocs) {
          width = (value[i] & 0x3f) || 64;
          height = ((value[i] >>> 6) & 0x3ff) || 1024;
        } else {
          width = (value[i] & 0x7ff) || 2048;
          height = (regs[R.BLTSIZV >> 1] & 0x7fff) || 32768;
        }
        const con0 = regs[R.BLTCON0 >> 1];
        const con1 = regs[R.BLTCON1 >> 1];
        blits.push({
          startSlot: i,
          endSlot: i,
          finished: false,
          width,
          height,
          con0,
          con1,
          afwm: regs[R.BLTAFWM >> 1],
          alwm: regs[R.BLTALWM >> 1],
          ptr: PTH.map((o) => regL(o) & 0x1ffffe),
          dat: DAT.map((o) => regs[o >> 1]),
          mod: MOD.map((o) => coerce16(regs[o >> 1])),
          mode: modeOf(con1),
        });
        lastDWrite.push(-1);
        lastCell.push(-1);
      }
    }

    // Attribute blitter bus cells to the most-recently-started blit (blits are serialized).
    if (owner[i] === BusOwner.BLITTER && blits.length) {
      blitterCells++;
      const b = blits.length - 1;
      lastCell[b] = i;
      if (f & DMA_WRITE) lastDWrite[b] = i; // the D-channel write
    }
  }

  // End = final D write (BLIFINALD); for a D-disabled blit, the last blitter cell of any channel.
  for (let b = 0; b < blits.length; b++) {
    const end = lastDWrite[b] >= 0 ? lastDWrite[b] : lastCell[b];
    if (end >= 0) {
      blits[b].endSlot = end;
      blits[b].finished = true;
    }
  }

  return { blits, fastBlitter: bltSizeWrites > 0 && blitterCells === 0 };
}

// ── Tooltip derivation (ported from the old ext's blit tooltip) ────────────────────────────
// All of this is derived on demand from BLTCON0/BLTCON1 + the register snapshot, so the Blit
// itself stays a thin raw-register record.

export interface BlitChip {
  name: string;
  on: boolean;
}

export interface BlitChannelRow {
  label: string; // "Source A" / … / "Destination"
  ptr?: number; // pointer address (enabled channel)
  literal?: number; // BLTxDAT literal (a disabled channel that still affects the result)
  shift?: number; // ASH (A) / BSH (B), copy/fill mode only
  modulo: number;
  fwm?: number; // channel A: first/last-word masks
  lwm?: number;
}

export interface BlitTooltip {
  size: string;
  control: BlitChip[];
  mintermHex: string;
  mintermExpr: string; // boolean expression with combining overbars for NOT
  mintermBits: BlitChip[]; // 8 LF7..LF0 chips labelled by their A/B/C input combination
  line?: { start: number; texture: number };
  channels: BlitChannelRow[];
  start: { line: number; colorClock: number; slot: number };
  end?: { line: number; colorClock: number; slot: number; durationSlots: number };
}

// Render NOT-brackets ([X]) as a combining overbar (X̄), matching the old tooltip. Every bracket
// in the active BlitOp table is single-char; this bars each char inside, so multi-char groups
// (none today) would also render correctly.
function overbar(expr: string): string {
  return expr.replace(/\[([^\]]*)\]/g, (_, inner: string) =>
    [...inner].map((c) => c + "̄").join(""),
  );
}

// A single A/B/C input with an optional overbar (bit set = true, clear = NOT).
const abc = (a: number, b: number, c: number): string =>
  (a ? "A" : "Ā") + (b ? "B" : "B̄") + (c ? "C" : "C̄");

// Does a *disabled* channel still affect the output (so its literal BLTxDAT matters)? Ported
// verbatim from the old ext: compare the minterm truth-table halves for that input.
function datMatters(con0: number, con1: number): [boolean, boolean, boolean] {
  const lf = (b: number) => (con0 >> b) & 1;
  const a =
    !(con0 & BLTCON0Flags.USEA) &&
    (lf(7) !== lf(3) || lf(6) !== lf(2) || lf(5) !== lf(1) || lf(4) !== lf(0));
  const b =
    !(con0 & BLTCON0Flags.USEB) &&
    (!!(con1 & BLTCON1Flags.LINE) || lf(7) !== lf(5) || lf(6) !== lf(4) || lf(3) !== lf(1) || lf(2) !== lf(0));
  const c =
    !(con0 & BLTCON0Flags.USEC) &&
    (lf(7) !== lf(6) || lf(5) !== lf(4) || lf(3) !== lf(2) || lf(1) !== lf(0));
  return [a, b, c];
}

const LINE_OCTANT: Record<number, number> = {
  0b110: 0, 0b001: 1, 0b011: 2, 0b111: 3, 0b101: 4, 0b010: 5, 0b000: 6, 0b100: 7,
};

export function blitTooltip(blit: Blit): BlitTooltip {
  const { con0, con1 } = blit;
  const line = !!(con1 & BLTCON1Flags.LINE);
  const minterm = con0 & 0xff;

  const control: BlitChip[] = [
    { name: "USEA", on: !!(con0 & BLTCON0Flags.USEA) },
    { name: "USEB", on: !!(con0 & BLTCON0Flags.USEB) },
    { name: "USEC", on: !!(con0 & BLTCON0Flags.USEC) },
    { name: "USED", on: !!(con0 & BLTCON0Flags.USED) },
    { name: "LINE", on: line },
  ];
  if (line) {
    control.push({ name: "SIGN", on: !!(con1 & BLTCON1Flags.SIGN) });
    control.push({ name: `OCT ${LINE_OCTANT[(con1 & (BLTCON1Flags.SUD | BLTCON1Flags.SUL | BLTCON1Flags.AUL)) >> 2] ?? 0}`, on: true });
  } else {
    control.push({ name: "DOFF", on: !!(con1 & BLTCON1Flags.DOFF) });
    control.push({ name: "EFE", on: !!(con1 & BLTCON1Flags.EFE) });
    control.push({ name: "IFE", on: !!(con1 & BLTCON1Flags.IFE) });
    control.push({ name: "FCI", on: !!(con1 & BLTCON1Flags.FCI) });
    control.push({ name: "DESC", on: !!(con1 & BLTCON1Flags.DESC) });
  }

  const mintermBits: BlitChip[] = [];
  for (let b = 7; b >= 0; b--) {
    mintermBits.push({ name: abc((b >> 2) & 1, (b >> 1) & 1, b & 1), on: !!(minterm & (1 << b)) });
  }

  const dat = datMatters(con0, con1);
  const labels = ["Source A", "Source B", "Source C", "Destination"];
  const channels: BlitChannelRow[] = [];
  for (let c = 0; c < 4; c++) {
    const enabled = !!(con0 & USE[c]);
    if (!enabled && !(c < 3 && dat[c])) continue;
    const row: BlitChannelRow = { label: labels[c], modulo: blit.mod[c] };
    if (enabled) {
      row.ptr = blit.ptr[c];
      if (!line && c === 0) row.shift = con0 >>> 12; // ASH
      if (!line && c === 1) row.shift = con1 >>> 12; // BSH
      if (c === 0) { row.fwm = blit.afwm; row.lwm = blit.alwm; }
    } else {
      row.literal = blit.dat[c];
    }
    channels.push(row);
  }

  const at = (slot: number) => ({ line: (slot / DMA_HPOS) | 0, colorClock: slot % DMA_HPOS, slot });
  return {
    size: `${blit.width * 16}x${blit.height}px`,
    control,
    mintermHex: `$${minterm.toString(16).padStart(2, "0")}`,
    mintermExpr: overbar(BlitOp[minterm] ?? ""),
    mintermBits,
    line: line ? { start: con0 >>> 12, texture: con1 >>> 12 } : undefined,
    channels,
    start: at(blit.startSlot),
    end: blit.finished
      ? { ...at(blit.endSlot), durationSlots: blit.endSlot - blit.startSlot }
      : undefined,
  };
}
