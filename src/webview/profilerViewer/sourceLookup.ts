// Resolves an arbitrary memory address to a source file/line for the Memory View's "jump to
// source" (Ctrl/Cmd+click). Two data sources, tried in order:
//   1. model.disassembly — exact per-instruction file/line, but only covers addresses that were
//      actually executed this frame (code only).
//   2. model.symbols — each symbol's own declaration site, covering data symbols too (e.g. a
//      "Screen" buffer declared via dc.b/dcb.b), at the granularity of "somewhere in this symbol",
//      not a specific byte.
// An address outside both (e.g. unlabelled/un-disassembled memory) resolves to undefined, i.e.
// "not applicable" — not every byte has a source location.

import { IDisassembledFunction, ISymbol } from "../../shared/profilerTypes";

export interface SourceLocation {
  file: string;
  line: number; // raw, same (unadjusted) convention as IDisassembledInstruction.line/ProfileFrame.line
}

export type SourceLookup = (addr: number) => SourceLocation | undefined;

// Lookup #1: every disassembled function's instructions, flattened and sorted by address once. A
// hit requires `addr` to fall within some instruction's [address, address+length) span (not just
// past the function's first instruction), so addresses outside any executed function (or in
// padding/data the disassembler skipped) correctly miss.
function createInstructionLookup(disassembly: readonly IDisassembledFunction[] | undefined): SourceLookup {
  if (!disassembly || disassembly.length === 0) return () => undefined;

  const instructions = disassembly
    .flatMap((fn) => fn.instructions)
    .filter((ins) => ins.file !== undefined && ins.line !== undefined)
    .sort((a, b) => a.address - b.address);
  if (instructions.length === 0) return () => undefined;

  const addrs = Int32Array.from(instructions, (ins) => ins.address | 0);

  return (addr: number): SourceLocation | undefined => {
    const a = addr >>> 0;
    let lo = 0;
    let hi = addrs.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if ((addrs[mid] >>> 0) <= a) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (idx < 0) return undefined;
    const ins = instructions[idx];
    if (a >= ins.address + ins.length) return undefined;
    return { file: ins.file!, line: ins.line! };
  };
}

// Lookup #2: symbol declaration sites (mirrors symbols.ts's createSymbolizer floor-search +
// size-bound, but returning file/line instead of a display string). Covers data symbols, which
// have no disassembly entry at all.
function createSymbolDeclLookup(symbols: readonly ISymbol[] | undefined): SourceLookup {
  if (!symbols || symbols.length === 0) return () => undefined;

  const withLoc = symbols.filter((s) => s.file !== undefined && s.line !== undefined);
  if (withLoc.length === 0) return () => undefined;

  const sorted = [...withLoc].sort((a, b) => a.address - b.address);
  const addrs = Int32Array.from(sorted, (s) => s.address | 0);

  return (addr: number): SourceLocation | undefined => {
    const a = addr >>> 0;
    let lo = 0;
    let hi = addrs.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if ((addrs[mid] >>> 0) <= a) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (idx < 0) return undefined;
    const sym = sorted[idx];
    const offset = a - (sym.address >>> 0);
    if (offset !== 0 && (sym.size <= 0 || offset >= sym.size)) return undefined;
    return { file: sym.file!, line: sym.line! };
  };
}

export function createSourceLookup(
  disassembly: readonly IDisassembledFunction[] | undefined,
  symbols: readonly ISymbol[] | undefined,
): SourceLookup {
  const instructionLookup = createInstructionLookup(disassembly);
  const symbolLookup = createSymbolDeclLookup(symbols);
  return (addr: number): SourceLocation | undefined => instructionLookup(addr) ?? symbolLookup(addr);
}
