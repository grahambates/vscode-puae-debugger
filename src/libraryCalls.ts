// Library calls named in disassembly: `jsr -198(a6)` annotated `exec.library AllocMem`.
//
// Asks the machine rather than a table of offsets: which library base `a6` holds, that library's
// own name (its Node's ln_Name), and where its jump-table entry at that offset points. So the
// annotation is right for any library, including a program's own, and shows when SetFunction has
// patched an entry. The target is named only on an exact symbol (the Kickstart symbol tables): the
// nearest symbol would confidently name the wrong function.
//
// `a6` is the hard part. Where it's known exactly — the live register at the current PC, or a
// capture's register trace at the call itself — that's used. Otherwise it comes from the code
// before the call: the nearest earlier load of a6 (`movea.l 4.w,a6`, `movea.l GfxBase(pc),a6`,
// `movea.l _GfxBase,a6`), whose source is read from memory now. Either way the base must check out
// as a library node before anything is said about it, so a wrong guess about a6 yields no
// annotation rather than a wrong one. The operand is never rewritten: the offset is what the code
// says, and the name is a reading of the machine.
//
// Shared by the debugger's disassembly, the profiler's (resolved at capture time, against the live
// machine — library names are in ROM, which a capture's memory snapshot doesn't hold) and the MCP
// tools'.

import { decodeInstruction, Instruction } from "m68kdecode";

export type ReadMemory = (address: number, length: number) => Promise<Uint8Array>;
/** The symbol exactly at an address, if there is one. */
export type ExactSymbol = (address: number) => string | undefined;

export interface CodeLine {
  address: number;
  /** The instruction's bytes in hex, pairs with or without spaces between. */
  hex: string;
}

const A6 = 6;
const JMP_ABS_L = 0x4ef9;

function decode(line: CodeLine): Instruction | undefined {
  try {
    const bytes = Uint8Array.from((line.hex.replace(/\s+/g, "").match(/../g) ?? []).map((b) => parseInt(b, 16)));
    return decodeInstruction(bytes).instruction;
  } catch {
    return undefined;
  }
}

/** `jsr d16(a6)` / `jmp d16(a6)`: the offset into the library's jump table. */
export function libraryCallOffset(ins: Instruction): number | undefined {
  if (ins.operation !== "JSR" && ins.operation !== "JMP") return undefined;
  const op = ins.operands[0];
  if (op?.kind !== "ARDISP" || op.reg !== A6 || op.disp.indexer || op.disp.indirection) return undefined;
  return op.disp.baseDisplacement;
}

type A6Write = { from: number } | { value: number } | "unknown";

/**
 * How an instruction sets a6, if it does: loaded from an address, set to a value, or changed in a
 * way that can't be followed from here (lea, arithmetic, movem, exg, a load through a register).
 */
function a6Write(ins: Instruction, address: number): A6Write | undefined {
  const [src, dst] = ins.operands;
  if (ins.operation === "EXG") {
    return (src?.kind === "AR" && src.reg === A6) || (dst?.kind === "AR" && dst.reg === A6) ? "unknown" : undefined;
  }
  if (ins.operation === "MOVEM") {
    return dst?.kind === "REGLIST" && dst.bitmask & (1 << (8 + A6)) ? "unknown" : undefined;
  }
  if (dst?.kind !== "AR" || dst.reg !== A6) return undefined;
  if ((ins.operation === "MOVEA" || ins.operation === "MOVE") && ins.size === 4 && src) {
    if (src.kind === "ABS16" || src.kind === "ABS32") return { from: src.value >>> 0 };
    if (src.kind === "PCDISP" && !src.disp.indexer && !src.disp.indirection) {
      return { from: (address + src.offset + src.disp.baseDisplacement) >>> 0 };
    }
    if (src.kind === "IMM32") return { value: src.value >>> 0 };
  }
  return "unknown";
}

const long = async (read: ReadMemory, address: number) => {
  const b = await read(address >>> 0, 4);
  return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
};

/** What `jsr offset(base)` calls, or undefined if `base` isn't a library (or device, or resource). */
export async function describeLibraryCall(base: number, offset: number, read: ReadMemory, symbolAt: ExactSymbol): Promise<string | undefined> {
  try {
    // ln_Type at +8: NT_DEVICE 3, NT_RESOURCE 8, NT_LIBRARY 9 — anything else has no jump table.
    const header = await read((base + 8) >>> 0, 6);
    if (![3, 8, 9].includes(header[0])) return undefined;
    const namePtr = ((header[2] << 24) | (header[3] << 16) | (header[4] << 8) | header[5]) >>> 0;
    const nameBytes = await read(namePtr, 40);
    const end = nameBytes.indexOf(0);
    const name = String.fromCharCode(...nameBytes.subarray(0, end < 0 ? 40 : end));
    if (!/^[\x20-\x7e]+$/.test(name)) return undefined;
    const entry = await read((base + offset) >>> 0, 6);
    if (((entry[0] << 8) | entry[1]) !== JMP_ABS_L) return `${name} ${offset}`; // just the library and offset
    const target = (((entry[2] << 24) | (entry[3] << 16) | (entry[4] << 8) | entry[5]) >>> 0) & 0xffffff;
    const symbol = symbolAt(target);
    if (symbol) return `${name} ${symbol}`;
    const where = target >= 0xf80000 ? "ROM" : "RAM, patched";
    return `${name} ${offset} -> $${target.toString(16).padStart(6, "0")} (${where})`;
  } catch {
    return undefined;
  }
}

/**
 * Comments for the library calls in a listing, keyed by address. `live`, when given, is a6 at the
 * current PC (if the PC is in the listing); `a6At`, when given, is a6 known exactly at an address
 * (a capture's register trace) — tried before anything is inferred from the code.
 */
export async function libraryCallComments(
  lines: CodeLine[],
  read: ReadMemory,
  symbolAt: ExactSymbol,
  known: { live?: { pc: number; a6: number }; a6At?: (address: number) => number[] | undefined } = {},
): Promise<Map<number, string>> {
  const decoded = lines.map(decode);
  const pcIndex = known.live ? lines.findIndex((l) => l.address === known.live!.pc) : -1;
  const out = new Map<number, string>();
  for (let i = 0; i < lines.length; i++) {
    const ins = decoded[i];
    const offset = ins && libraryCallOffset(ins);
    if (offset === undefined) continue;

    let bases: number[] | undefined = known.a6At?.(lines[i].address);
    if (!bases?.length) {
      let base: number | undefined;
      // Back from the call to the nearest write of a6. The live register holds a6 as it is before
      // the instruction at the PC runs, so that instruction's own write is checked first.
      for (let j = i; j >= 0; j--) {
        if (j < i) {
          const prev = decoded[j];
          const write = prev && a6Write(prev, lines[j].address);
          if (write === "unknown") break;
          if (write) {
            base = "value" in write ? write.value : await long(read, write.from).catch(() => undefined);
            break;
          }
        }
        if (j === pcIndex) { base = known.live!.a6; break; }
      }
      bases = base === undefined ? [] : [base];
    }

    // One a6 for the call, or (from a trace) several — a routine called with different libraries.
    const names: string[] = [];
    for (const base of [...new Set(bases)].slice(0, 4)) {
      const comment = await describeLibraryCall(base, offset, read, symbolAt);
      if (comment && !names.includes(comment)) names.push(comment);
    }
    if (names.length) out.set(lines[i].address, names.join(" | "));
  }
  return out;
}
