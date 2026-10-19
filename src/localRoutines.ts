// Subroutines at local labels, named as such: `bsr .bar` inside Foo shows as `Foo.bar`, not as
// Foo calling Foo.
//
// vasm doesn't put local labels in the symbol table, so a profile attributes `.bar`'s code to the
// global label before it, and a call to it looks like recursion. What the profile does know is the
// call. A frame's entry is the target of the `bsr`/`jsr` at its call site (a branch-stack capture
// records each caller frame there) when the instruction says — or, for a call through a register
// or a jump table (`jsr .table(pc,d0.w)`), the first instruction the frame ran, when it started
// during the capture (every instruction in range is sampled). A frame entered inside a routine but
// not at its start is a routine of its own, named for the nearest local label at or above its
// entry in the source (`Foo.bar`; a jump table's entries all take the table's label), or by its
// offset (`Foo+$1a`) when the source can't be read.
//
// Only called local labels are affected: code reached by a branch (a loop, `bra .done`) stays part
// of its routine.

import { readFileSync } from "fs";
import { decodeInstruction } from "m68kdecode";
import { SourceMap } from "./sourceMap";

/** The bytes at an address, as far as they're known (a capture's memory snapshot). */
export type CodeReader = (address: number) => Uint8Array | undefined;
/** A source file's lines, or undefined if it can't be read. */
export type SourceLines = (path: string) => string[] | undefined;

/** Reads chip RAM from 0, slow RAM from $c00000 and fast RAM from `fastAddr`, as captures store them. */
export function snapshotReader(chip?: Uint8Array, slow?: Uint8Array, fast?: Uint8Array, fastAddr?: number): CodeReader {
  return (address) => {
    const a = address >>> 0;
    if (chip && a < chip.length) return chip.subarray(a);
    if (slow && a >= 0xc00000 && a < 0xc00000 + slow.length) return slow.subarray(a - 0xc00000);
    if (fast && fastAddr !== undefined && a >= fastAddr && a < fastAddr + fast.length) return fast.subarray(a - fastAddr);
    return undefined;
  };
}

/** Source files read from disk, once each. */
export function diskSourceLines(): SourceLines {
  const cache = new Map<string, string[] | undefined>();
  return (path) => {
    if (!cache.has(path)) {
      try {
        cache.set(path, readFileSync(path, "latin1").split(/\r?\n/));
      } catch {
        cache.set(path, undefined);
      }
    }
    return cache.get(path);
  };
}

/** Where the call at `callSite` goes, when the instruction says: `bsr`, `jsr d(pc)` or an absolute `jsr`. */
export function callTarget(callSite: number, read: CodeReader): number | undefined {
  const bytes = read(callSite);
  if (!bytes || bytes.length < 2) return undefined;
  try {
    const { operation, operands } = decodeInstruction(bytes).instruction;
    if (operation !== "BSR" && operation !== "JSR") return undefined;
    const op = operands[0];
    if (op?.kind === "PCDISP" && !op.disp.indexer && !op.disp.indirection) {
      return (callSite + op.offset + op.disp.baseDisplacement) >>> 0;
    }
    if (op?.kind === "ABS16" || op?.kind === "ABS32") return op.value >>> 0;
  } catch {
    // not decodable: no target
  }
  return undefined;
}

// A label at the start of a line: `.bar`, `.bar:`, `bar$` — then optionally the instruction.
const LABEL = /^([.A-Za-z_][\w.$]*):?(?=\s|;|\*|$)/;

/**
 * The nearest local label (".bar") at or above `address`'s line in the source, within its routine:
 * the search stops at a global label, which starts the routine.
 */
function localLabelAt(address: number, sourceMap: SourceMap, lines: SourceLines): string | undefined {
  const loc = sourceMap.lookupAddress(address);
  if (!loc) return undefined;
  const text = lines(loc.path);
  if (!text) return undefined;
  for (let i = loc.line - 1; i >= 0 && i >= loc.line - 400; i--) {
    const label = LABEL.exec(text[i] ?? "")?.[1];
    if (label) return label.startsWith(".") ? label : undefined;
  }
  return undefined;
}

/**
 * The name of a routine entered at `entry`, when that isn't the start of the routine it's in:
 * `Foo.bar` from the source, else `Foo+$1a`. Undefined for an entry at a symbol, or with no symbol.
 */
export function localRoutineName(entry: number, sourceMap: SourceMap, lines?: SourceLines): string | undefined {
  const sym = sourceMap.findSymbolOffset(entry, true);
  if (!sym || sym.offset === 0) return undefined;
  const label = lines ? localLabelAt(entry, sourceMap, lines) : undefined;
  return label ? `${sym.symbol}${label}` : `${sym.symbol}+$${sym.offset.toString(16)}`;
}
