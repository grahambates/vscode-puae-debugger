// Every access to an address range during a captured frame, and who made it — "who wrote to this
// buffer", "who set COLOR00 to that" — from the DMA grid, which records every chip-bus cycle with
// its address, direction and value. Shared by profile_dump's `accesses` and the profiler's views.
//
// Chip and slow RAM and the custom registers only: fast RAM isn't on the chip bus, so the CPU's
// accesses to it aren't in the grid.
//
// The CPU's are the hard part to attribute. The grid says when an access happened; the samples
// are anchored to instruction fetches (buildSampleSlots), and the 68000 fetches the next opcode
// before the current instruction's data access, so an access usually belongs to the instruction
// *before* the last one fetched. Where the register trace is there (a capture's first frame), the
// owner is the neighbouring instruction whose operand, computed from its registers, points at the
// accessed address (`verified`). Otherwise it's the nearest that accesses memory in that direction
// — a write needs a memory destination, a read a memory source or a read-modify-write — preferring
// the previous instruction. Measured against the register-checked answer on real captures, that
// agrees 98-100% of the time, but it's still a guess, and marked as one.
//
// A long access is two word accesses on the bus; they're joined back into one (longWords).

import { decodeInstruction, Instruction, Operand } from "m68kdecode";
import { BusOwner, DMA_BYTE, DMA_CODE, DMA_HPOS, DMA_WRITE, IProfileModel, REG_COUNT } from "../../shared/profilerTypes";
import { buildSampleSlots } from "./columns";
import { Blit } from "./blits";

/** The code's bytes at an address, as far as they're known (a capture's memory snapshot). */
export type ReadCode = (address: number) => Uint8Array | undefined;

export type AccessSource =
  | { kind: "cpu"; sample: number; pc: number; function: string; verified: boolean }
  /** A copper write is a MOVE (`instruction`: its list address, when the trace has it); a read is the copper fetching its list. */
  | { kind: "copper"; instruction?: number }
  /** Writes are the D channel; `blit` indexes the frame's blits (getBlits). */
  | { kind: "blitter"; blit?: number }
  /** Bitplane, sprite, audio, disk or refresh DMA. */
  | { kind: "dma"; owner: BusOwner };

export interface Access {
  slot: number;
  write: boolean;
  /** 1, 2 or 4 bytes: a CPU long access is two word accesses on the bus, joined into one here. */
  size: 1 | 2 | 4;
  /** The bus address, with custom registers as $dffxxx — a copper MOVE's included. */
  address: number;
  value: number;
  source: AccessSource;
}

// Operands that are addresses, not accesses: LEA computes one, a branch or JMP goes to one.
const NO_DATA_OPS = new Set(["LEA", "BRA", "BCC", "DBCC", "JMP"]);
// With a memory destination these only read it; MOVE only writes it; everything else reads it
// and writes it back (a 68000 CLR included).
const READ_ONLY_DST = new Set(["CMP", "CMPA", "CMPI", "CMPM", "BTST", "TST", "CHK"]);
const WRITE_ONLY_DST = new Set(["MOVE", "MOVEA"]);
const MEMORY_KINDS = new Set(["ARIND", "ARINC", "ARDEC", "ARDISP", "ABS16", "ABS32", "PCDISP", "DISP"]);
// The stack ones, by what they do to it: push (write below A7) or pop (read at A7), how many bytes.
const STACK_PUSH: Record<string, number> = { JSR: 4, BSR: 4, PEA: 4, LINK: 4 };
const STACK_POP: Record<string, number> = { RTS: 4, RTE: 6, RTR: 6 };
const A7 = 15;

/** Which ways an instruction accesses data memory; undefined for "could be either" (TRAP). */
function memoryDirections(ins: Instruction): { read: boolean; write: boolean } | undefined {
  const op = ins.operation;
  if (op === "TRAP") return undefined;
  if (STACK_PUSH[op]) return { read: false, write: true };
  if (STACK_POP[op] || op === "UNLK") return { read: true, write: false };
  if (NO_DATA_OPS.has(op)) return { read: false, write: false };
  const [src, dst] = ins.operands;
  const srcMem = !!src && MEMORY_KINDS.has(src.kind);
  const dstMem = !!dst && MEMORY_KINDS.has(dst.kind);
  if (op === "MOVEM") return { read: srcMem, write: dstMem }; // registers to memory, or memory to registers
  let read = false;
  let write = false;
  if (dst === null) {
    // One operand: TST reads it; CLR/NEG/NOT/Scc/TAS/shifts read and write it.
    if (srcMem) { read = true; write = !READ_ONLY_DST.has(op); }
  } else {
    if (srcMem) read = true;
    if (dstMem) {
      if (WRITE_ONLY_DST.has(op)) write = true;
      else if (READ_ONLY_DST.has(op)) read = true;
      else { read = true; write = true; }
    }
  }
  return { read, write };
}

type Range = [number, number]; // [start, end) bus addresses

/**
 * The memory an instruction's operands cover, from its registers (before it runs): each memory
 * operand's address, for the operation's size — a MOVEM's for every register in its list, a
 * stack instruction's the long (or exception frame) it pushes or pops. "unknown" for any it can't
 * work out: one needing a register without the trace, an indexed or memory-indirect mode.
 */
function operandRanges(ins: Instruction, pc: number, reg: ((n: number) => number) | undefined): Range[] | "unknown" {
  const op = ins.operation;
  if (op === "TRAP") return "unknown";
  if (NO_DATA_OPS.has(op)) return [];
  if (STACK_PUSH[op]) return reg ? [[reg(A7) - STACK_PUSH[op], reg(A7)]] : "unknown";
  if (STACK_POP[op]) return reg ? [[reg(A7), reg(A7) + STACK_POP[op]]] : "unknown";
  if (op === "UNLK") {
    const r = ins.operands[0];
    return reg && r?.kind === "AR" ? [[reg(8 + r.reg), reg(8 + r.reg) + 4]] : "unknown";
  }
  const size = ins.size === 1 || ins.size === 2 || ins.size === 4 ? ins.size : 2;
  // A MOVEM moves its whole list: one size-wide slot per register.
  let count = 1;
  const list = ins.operands.find((o) => o?.kind === "REGLIST");
  if (op === "MOVEM" && list?.kind === "REGLIST") {
    count = 0;
    for (let m = list.bitmask; m; m &= m - 1) count++;
  }
  const span = Math.max(1, count) * size;
  const out: Range[] = [];
  for (const o of ins.operands as (Operand | null)[]) {
    if (!o) continue;
    let ea: number | undefined;
    switch (o.kind) {
      case "ARIND":
      case "ARINC":
        if (!reg) return "unknown";
        ea = reg(8 + o.reg);
        out.push([ea, ea + span]);
        break;
      case "ARDEC":
        if (!reg) return "unknown";
        out.push([reg(8 + o.reg) - span, reg(8 + o.reg)]);
        break;
      case "ARDISP":
        if (!reg || o.disp.indexer || o.disp.indirection) return "unknown";
        ea = reg(8 + o.reg) + o.disp.baseDisplacement;
        out.push([ea, ea + span]);
        break;
      case "ABS16":
      case "ABS32":
        out.push([o.value, o.value + span]);
        break;
      case "PCDISP":
        if (o.disp.indexer || o.disp.indirection) return "unknown";
        ea = pc + o.offset + o.disp.baseDisplacement;
        out.push([ea, ea + span]);
        break;
      case "DISP":
        return "unknown";
    }
  }
  const mask = (a: number) => (a >>> 0) & 0xffffff;
  return out.map(([lo, hi]) => [mask(lo), mask(lo) + (hi - lo)]);
}

/** Bus address of a grid cell, custom registers as $dffxxx (a copper MOVE records just the offset). */
function cellAddress(owner: number, flags: number, addr: number): number {
  if (owner === BusOwner.COPPER && flags & DMA_WRITE) return 0xdff000 | (addr & 0x1fe);
  return (addr >>> 0) & 0xffffff;
}

const functionAt = (model: IProfileModel, k: number): string => {
  const node = model.nodes[model.samples[k + 1]];
  const loc = node ? model.locations[node.locationId] : undefined;
  return loc?.callFrame.functionName ?? `$${(model.pcs[k] ?? 0).toString(16)}`;
};

/**
 * Every access to [start, end) in the frame, in time order. `readCode` lets CPU accesses be tied to
 * their instruction (without it they're attributed to the nearest sample, unverified); `blits`
 * (getBlits) names which blit a blitter access belongs to.
 */
export function findAccesses(model: IProfileModel, start: number, end: number, readCode?: ReadCode, blits?: Blit[]): Access[] {
  const dma = model.dma;
  if (!dma) return [];
  const { owner, flags, addr, value } = dma;
  const n = model.pcs.length;

  // Sample positions in the grid: anchored where they can be, else from cycle costs.
  let slots: Int32Array | undefined;
  if (n > 0) {
    const anchored = buildSampleSlots(model.pcs, model.timeDeltas, dma);
    slots = anchored.matched > 0 ? anchored.slots : undefined;
    if (!slots) {
      slots = new Int32Array(n);
      let at = 0;
      for (let k = 0; k < n; k++) { slots[k] = Math.round(at); at += model.timeDeltas[k] ?? 0; }
    }
  }
  const decoded = new Map<number, Instruction | null>();
  const decode = (pc: number): Instruction | undefined => {
    if (!decoded.has(pc)) {
      let ins: Instruction | null = null;
      try { const bytes = readCode?.(pc); if (bytes && bytes.length >= 2) ins = decodeInstruction(bytes).instruction; } catch { /* not code */ }
      decoded.set(pc, ins);
    }
    return decoded.get(pc) ?? undefined;
  };
  const registers = model.registers && model.registers.length >= n * REG_COUNT ? model.registers : undefined;

  // The neighbouring instructions that could have made an access, most likely first (measured on
  // real captures with a register trace: the previous one about three times in four, then the
  // current one, rarely two back or one ahead).
  const cpuSource = (k: number, address: number, size: number, write: boolean): AccessSource => {
    const candidates = [k - 1, k, k - 2, k + 1].filter((j) => j >= 0 && j < n);
    let fallback: number | undefined;
    for (const j of candidates) {
      const ins = decode(model.pcs[j]);
      if (!ins) continue;
      const dirs = memoryDirections(ins);
      if (dirs && !(write ? dirs.write : dirs.read)) continue; // can't have made this access
      const reg = registers ? (r: number) => registers[j * REG_COUNT + r] >>> 0 : undefined;
      const ranges = operandRanges(ins, model.pcs[j], reg);
      if (ranges !== "unknown" && ranges.some(([lo, hi]) => address < hi && address + size > lo)) {
        return { kind: "cpu", sample: j, pc: model.pcs[j], function: functionAt(model, j), verified: true };
      }
      // Without the registers to check, the first that could have made it.
      if (fallback === undefined && (!reg || ranges === "unknown")) fallback = j;
    }
    const j = fallback ?? Math.max(0, k - 1);
    return { kind: "cpu", sample: j, pc: model.pcs[j] ?? 0, function: functionAt(model, j), verified: false };
  };

  // The copper MOVE executed at a slot, from the trace (keyed by where its second word was fetched).
  const copperAt = new Map<number, number>();
  if (model.copper) {
    for (let i = 0; i < model.copper.addr.length; i++) copperAt.set(model.copper.vpos[i] * DMA_HPOS + model.copper.hpos[i], model.copper.addr[i]);
  }
  const blitAt = (slot: number) => blits?.findIndex((b) => slot >= b.startSlot && slot <= b.endSlot);

  const overlaps = (a: Access) => a.address + a.size > start && a.address < end;
  const out: Access[] = [];
  // Every CPU data access in the frame, not just the range's: a long is two word accesses, and its
  // halves are paired up per instruction (longWords) before the range is applied, so a byte in
  // either half finds the whole long — and a movem's longs pair from its first word, wherever the
  // range starts.
  const cpu: Access[] = [];
  let k = 0;
  for (let s = 0; s < owner.length; s++) {
    const o = owner[s];
    if (o === BusOwner.NONE || o === BusOwner.BLOCKED) continue;
    const f = flags[s];
    if (o === BusOwner.CPU) {
      if (slots) while (k + 1 < n && slots[k + 1] <= s) k++;
      if (f & DMA_CODE) continue; // instruction fetches aren't accesses to the data
    }
    const a = cellAddress(o, f, addr[s]);
    // Overlapping, not starting inside: a word access covers its odd byte too, so asking about
    // that byte alone — or a range starting there — must still find it.
    const size = f & DMA_BYTE ? 1 : 2;
    const access: Access = { slot: s, write: !!(f & DMA_WRITE), size, address: a, value: value[s], source: { kind: "dma", owner: o } };
    if (o === BusOwner.CPU) {
      if (n > 0) {
        access.source = cpuSource(k, a, size, access.write);
        cpu.push(access);
      } else if (overlaps(access)) out.push(access);
      continue;
    }
    if (!overlaps(access)) continue;
    if (o === BusOwner.COPPER) access.source = { kind: "copper", instruction: access.write ? (copperAt.get(s) ?? copperAt.get(s - 1) ?? copperAt.get(s - 2)) : undefined };
    else if (o === BusOwner.BLITTER) {
      const b = blitAt(s);
      access.source = { kind: "blitter", blit: b !== undefined && b >= 0 ? b : undefined };
    }
    out.push(access);
  }
  for (const a of longWords(cpu, decode)) if (overlaps(a)) out.push(a);
  return out.sort((x, y) => x.slot - y.slot);
}

// Instructions whose accesses are longs though they have no size of their own: a call pushes a
// long return address, a return pops one, pea pushes an address, link and unlk move a long.
const LONG_STACK_OPS = new Set(["JSR", "BSR", "RTS", "PEA", "LINK", "UNLK"]);

/**
 * The CPU's word accesses joined into longs where the instruction made long ones: two words from
 * the same instruction, the same way round, at adjacent addresses, in the order it made them. The
 * 68000 does the high word first for most modes but the low word first for -(An), so a pair can
 * come either way; the long's value puts the lower address's word on top either way.
 */
function longWords(cpu: Access[], decode: (pc: number) => Instruction | undefined): Access[] {
  const out: Access[] = [];
  const pending = new Map<string, Access>(); // an unpaired first half, by instruction and direction
  for (const a of cpu) {
    if (a.source.kind !== "cpu" || a.size !== 2) { out.push(a); continue; }
    const ins = decode(a.source.pc);
    const isLong = !!ins && (ins.size === 4 || LONG_STACK_OPS.has(ins.operation));
    if (!isLong) { out.push(a); continue; }
    const key = `${a.source.sample}:${a.write}`;
    const first = pending.get(key);
    if (first && Math.abs(first.address - a.address) === 2) {
      pending.delete(key);
      const [hi, lo] = first.address < a.address ? [first, a] : [a, first];
      out.push({ ...first, size: 4, address: hi.address, value: (((hi.value << 16) | lo.value) >>> 0) });
    } else {
      if (first) out.push(first); // its partner never came: leave it a word
      pending.set(key, a);
    }
  }
  out.push(...pending.values());
  return out;
}

/** Accesses grouped by who made them and how — the summary to read before the rows. */
export interface AccessGroup {
  who: string;
  write: boolean;
  count: number;
  firstSlot: number;
  lastSlot: number;
  /** Lowest and highest address touched. */
  low: number;
  high: number;
  /** Some CPU accesses in the group are attributed by position only (see the header). */
  unverified: boolean;
}

const OWNER_NAMES: Partial<Record<BusOwner, string>> = {
  [BusOwner.REFRESH]: "Refresh", [BusOwner.DISK]: "Disk",
  [BusOwner.AUD0]: "Audio 0", [BusOwner.AUD1]: "Audio 1", [BusOwner.AUD2]: "Audio 2", [BusOwner.AUD3]: "Audio 3",
};

export function sourceName(source: AccessSource, write: boolean): string {
  switch (source.kind) {
    case "cpu": return `CPU ${source.function}`;
    case "copper": return write ? "Copper MOVE" : "Copper (list fetch)";
    case "blitter": return `Blitter ${write ? "D" : "read"}${source.blit !== undefined ? ` (blit #${source.blit})` : ""}`;
    case "dma": {
      const o = source.owner;
      if (o >= BusOwner.BPL1 && o <= BusOwner.BPL8) return `Bitplane ${o - BusOwner.BPL1 + 1}`;
      if (o >= BusOwner.SPRITE0 && o <= BusOwner.SPRITE7) return `Sprite ${o - BusOwner.SPRITE0}`;
      return OWNER_NAMES[o] ?? BusOwner[o] ?? "DMA";
    }
  }
}

export function groupAccesses(accesses: Access[]): AccessGroup[] {
  const groups = new Map<string, AccessGroup>();
  for (const a of accesses) {
    const who = sourceName(a.source, a.write);
    const key = `${who}\0${a.write}`;
    let g = groups.get(key);
    if (!g) {
      g = { who, write: a.write, count: 0, firstSlot: a.slot, lastSlot: a.slot, low: a.address, high: a.address + a.size - 1, unverified: false };
      groups.set(key, g);
    }
    g.count++;
    g.lastSlot = a.slot;
    g.low = Math.min(g.low, a.address);
    g.high = Math.max(g.high, a.address + a.size - 1);
    if (a.source.kind === "cpu" && !a.source.verified) g.unverified = true;
  }
  return [...groups.values()].sort((x, y) => x.firstSlot - y.firstSlot);
}

// ── CPU registers ─────────────────────────────────────────────────────────────────────────

export const CPU_REGISTER_NAMES = ["d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "sr", "pc", "usp"];

export interface RegisterChange {
  /** The sample whose instruction made the change (the register trace is taken before each one). */
  sample: number;
  slot: number;
  from: number;
  to: number;
  pc: number;
  function: string;
  /**
   * What happened between this sample and the next, if it wasn't just this instruction: an
   * exception being taken (into supervisor mode), or code outside the profiled range running — a
   * ROM call, say — whose effect lands on the instruction that called it.
   */
  via?: "exception" | "outside";
}

/**
 * Every change to a CPU register (REG_COUNT index) during the frame, from the register trace —
 * each pair of samples whose values differ means the instruction between them wrote it. A write
 * of the value it already held changes nothing and isn't seen. Empty without a register trace
 * (only a capture's first frame has one).
 */
export function findRegisterChanges(model: IProfileModel, reg: number, readCode?: ReadCode): RegisterChange[] {
  const regs = model.registers;
  const n = model.pcs.length;
  if (!regs || regs.length < n * REG_COUNT) return [];
  // Where each sample is in the frame: anchored to the grid where it can be, else by cycle costs.
  let slots = model.dma ? buildSampleSlots(model.pcs, model.timeDeltas, model.dma) : undefined;
  if (!slots || slots.matched === 0) {
    const cum = new Int32Array(n);
    for (let j = 1; j < n; j++) cum[j] = cum[j - 1] + (model.timeDeltas[j - 1] ?? 0);
    slots = { slots: cum, matched: 0 };
  }
  const at = (k: number) => slots!.slots[k];
  const SR_S = 0x2000;
  const out: RegisterChange[] = [];
  for (let k = 0; k + 1 < n; k++) {
    const from = regs[k * REG_COUNT + reg] >>> 0;
    const to = regs[(k + 1) * REG_COUNT + reg] >>> 0;
    if (from === to) continue;
    const change: RegisterChange = { sample: k, slot: at(k), from, to, pc: model.pcs[k], function: functionAt(model, k) };
    if (!(regs[k * REG_COUNT + 16] & SR_S) && regs[(k + 1) * REG_COUNT + 16] & SR_S) {
      change.via = "exception";
    } else {
      // A call followed straight by the instruction after it: the whole subroutine ran unsampled
      // (the ROM, or code outside the profiled range), so what it changed lands on the call.
      let decoded: { bytesUsed: number; instruction: Instruction } | undefined;
      try { const bytes = readCode?.(model.pcs[k]); if (bytes) decoded = decodeInstruction(bytes); } catch { /* not code */ }
      const op = decoded?.instruction.operation;
      if ((op === "JSR" || op === "BSR") && model.pcs[k + 1] === model.pcs[k] + decoded!.bytesUsed) change.via = "outside";
    }
    out.push(change);
  }
  return out;
}

// ── For the profiler's views ──────────────────────────────────────────────────────────────

/**
 * Code bytes from the capture's disassembly listing, which holds every executed instruction's —
 * enough to tie CPU accesses to instructions without a memory snapshot (which a multi-frame
 * capture only keeps for its last frame).
 */
export function readCodeFromListing(model: IProfileModel): ReadCode {
  const bytes = new Map<number, Uint8Array>();
  for (const fn of model.disassembly ?? []) {
    for (const ins of fn.instructions) {
      bytes.set(ins.address, Uint8Array.from((ins.hex.replace(/\s+/g, "").match(/../g) ?? []).map((b) => parseInt(b, 16))));
    }
  }
  return (address) => bytes.get(address);
}

/** One row of an access list, ready to show. */
export interface AccessListRow {
  slot: number;
  /** The CPU sample behind it, for moving the CPU tab's cursor exactly there. */
  sample?: number;
  /** "W.w", "R.b", or "" for a register change. */
  kind: string;
  /** "$0f00", or "$00c014d4 → $00c7fffa" for a register. */
  value: string;
  offset?: string;
  who: string;
  /** The instruction or copper MOVE that made it, where known. */
  detail?: string;
  /** Its source line, where known. */
  source?: { file: string; line: number };
  unverified?: boolean;
}

/** A source location for an address (the views' createSourceLookup). */
export type SourceAt = (address: number) => { file: string; line: number } | undefined;

/** "+$1a", or "-$1" for a word access that starts a byte before the range asked about. */
export const formatOffset = (d: number) => `${d < 0 ? "-" : "+"}$${Math.abs(d).toString(16)}`;

const hexOf = (v: number, digits: number) => `$${(v >>> 0).toString(16).padStart(digits, "0")}`;

export function accessListRows(
  model: IProfileModel,
  accesses: Access[],
  start: number,
  instructionText: (pc: number) => string | undefined,
  sourceAt: SourceAt,
  registerName: (offset: number) => string | undefined,
): AccessListRow[] {
  return accesses.map((a) => {
    const row: AccessListRow = {
      slot: a.slot,
      kind: `${a.write ? "W" : "R"}.${a.size === 1 ? "b" : a.size === 4 ? "l" : "w"}`,
      value: a.size === 1 ? hexOf(a.value & 0xff, 2) : hexOf(a.value, a.size * 2),
      offset: formatOffset(a.address - start),
      who: sourceName(a.source, a.write),
    };
    if (a.source.kind === "cpu") {
      row.sample = a.source.sample;
      row.detail = instructionText(a.source.pc);
      row.source = sourceAt(a.source.pc);
      if (!a.source.verified) row.unverified = true;
    } else if (a.source.kind === "copper" && a.source.instruction !== undefined) {
      const reg = registerName(a.address & 0x1fe) ?? hexOf(a.address & 0x1fe, 3);
      row.detail = `MOVE to ${reg} at ${hexOf(a.source.instruction, 6)}`;
      row.source = sourceAt(a.source.instruction);
    }
    return row;
  });
}

export function registerChangeRows(
  changes: RegisterChange[],
  instructionText: (pc: number) => string | undefined,
  sourceAt: SourceAt,
): AccessListRow[] {
  return changes.map((c) => ({
    slot: c.slot,
    sample: c.sample,
    kind: "",
    value: `${hexOf(c.from, 8)} → ${hexOf(c.to, 8)}`,
    who: c.via === "exception" ? `${c.function} (taking an exception)` : c.via === "outside" ? `${c.function} (in the code it called)` : c.function,
    detail: instructionText(c.pc),
    source: sourceAt(c.pc),
  }));
}
