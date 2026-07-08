import { Hunk, SourceSymbol } from "./amigaHunkParser";
import { normalize } from "path";
import {
  SourceMap,
  Segment,
  Location,
  ScopeEntry,
  Variable,
  LocalLocation,
} from "./sourceMap";
import { parseStabs, StabLocation, StabVariable } from "./stabsParser";

/**
 * Creates a source map from Amiga hunk debug information.
 *
 * Processes debugging information embedded in Amiga executable hunks
 * to create a mapping between memory addresses and source file locations.
 * Extracts symbols, line numbers, and source file references.
 *
 * Supports both the classic "LINE" HUNK_DEBUG format (symbols + line offsets)
 * and GNU stabs (magic 0x10b) — the latter additionally yields lexical scopes,
 * local/parameter variables, global variables and type descriptors, matching
 * what the DWARF path provides. Stabs carries no stack-unwind info, so no
 * debugFrame is produced (unwinding stays DWARF-only).
 *
 * @param hunks Array of parsed Amiga hunks containing debug info
 * @param offsets Memory offset addresses where hunks are loaded
 * @returns SourceMap instance for address-to-source resolution
 */
export function sourceMapFromHunks(
  hunks: Hunk[],
  offsets: number[],
): SourceMap {
  const symbols: Record<string, number> = {};
  const locations: Location[] = [];
  const sources = new Set<string>();
  const scopeTable: ScopeEntry[] = [];
  const globalVars: Variable[] = [];
  const segments: Segment[] = offsets.map((address, i) => {
    const hunk = hunks[i];
    return {
      address,
      // TODO: can we get section names?
      name: `${i}: ${hunk.hunkType} ${hunk.memType}`,
      size: hunk.dataSize ?? hunk.allocSize,
      memType: hunk.memType,
    };
  });

  // Symbols first (from HUNK_SYMBOL), so stabs globals can resolve their
  // addresses by name across all hunks.
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    for (const { offset, name } of hunks[i].symbols) {
      symbols[name] = seg.address + offset;
    }
  }

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const hunk = hunks[i];

    // Add first source from each hunk
    // This should be the entry point. Others files may be includes.
    if (hunk.lineDebugInfo[0]) {
      sources.add(normalize(hunk.lineDebugInfo[0].sourceFilename));
    }

    for (const debugInfo of hunk.lineDebugInfo) {
      const path = normalize(debugInfo.sourceFilename);
      for (const lineInfo of debugInfo.lines) {
        const { symbol, symbolOffset } = findEnclosingSymbol(
          hunk.symbols,
          lineInfo.offset,
        );
        locations.push({
          path,
          line: lineInfo.line,
          symbol,
          symbolOffset,
          segmentIndex: i,
          segmentOffset: lineInfo.offset,
          address: seg.address + lineInfo.offset,
        });
      }
    }

    if (hunk.stabs.length) {
      addStabs(
        hunk,
        i,
        seg.address,
        symbols,
        sources,
        locations,
        scopeTable,
        globalVars,
      );
    }
  }

  // Ensure we found some debug info
  if (!sources.size) {
    throw new Error(
      "Source map error: No debug information found in hunk executable",
    );
  }

  // getLocalsForPc binary-searches scopeTable by `low`.
  scopeTable.sort((a, b) => a.low - b.low);

  return new SourceMap(
    segments,
    sources,
    symbols,
    locations,
    scopeTable,
    undefined, // no debugFrame — stabs has no unwind info
    [], // no inline table
    globalVars,
  );
}

/** Find the nearest preceding symbol for a hunk-relative offset (symbols sorted by offset). */
function findEnclosingSymbol(
  hunkSymbols: SourceSymbol[],
  offset: number,
): { symbol?: string; symbolOffset?: number } {
  let symbol: string | undefined;
  let symbolOffset: number | undefined;
  for (const s of hunkSymbols) {
    if (s.offset > offset) break;
    symbol = s.name;
    symbolOffset = offset - s.offset;
  }
  return { symbol, symbolOffset };
}

/** GNU stabs frame locals live at [A5 + offset], which is the SourceMap `fbreg` case. */
function stabToLocalLocation(loc: StabLocation): LocalLocation {
  switch (loc.kind) {
    case "frame":
      return { kind: "fbreg", offset: loc.offset };
    case "register":
      // m68k stabs register numbers: 0-7 = D0-D7, 8-15 = A0-A7 (same as DWARF).
      return { kind: "reg", reg: loc.reg };
    // File-static locals can't be resolved to a readable memory location here
    // (their owning hunk is ambiguous), so surface them as unknown.
    default:
      return { kind: "unknown" };
  }
}

/** Decode a hunk's GNU stabs and append lines, scopes, globals and types. */
function addStabs(
  hunk: Hunk,
  segmentIndex: number,
  base: number,
  symbols: Record<string, number>,
  sources: Set<string>,
  locations: Location[],
  scopeTable: ScopeEntry[],
  globalVars: Variable[],
): void {
  const program = parseStabs(hunk.stabs);

  for (const file of program.files) {
    sources.add(normalize(file));
  }

  const mkVar = (v: StabVariable): Variable => {
    const td = program.resolveType(v.typeKey);
    return {
      name: v.name,
      typeName: td.typeName,
      byteSize: td.byteSize,
      typeDescriptor: td,
      location: stabToLocalLocation(v.location),
    };
  };

  for (const ln of program.lines) {
    const { symbol, symbolOffset } = findEnclosingSymbol(hunk.symbols, ln.address);
    locations.push({
      path: normalize(ln.file),
      line: ln.line,
      symbol,
      symbolOffset,
      segmentIndex,
      segmentOffset: ln.address,
      address: base + ln.address,
    });
  }

  for (const fn of program.functions) {
    if (symbols[fn.name] === undefined) symbols[fn.name] = base + fn.address;
    const high = base + fn.address + (fn.size ?? 0);
    // Function-level scope covering params (and top-level locals).
    if (fn.params.length) {
      scopeTable.push({
        low: base + fn.address,
        high,
        vars: fn.params.map(mkVar),
      });
    }
    // Nested lexical scopes (N_LBRAC/N_RBRAC).
    for (const sc of fn.scopes) {
      if (!sc.vars.length) continue;
      scopeTable.push({
        low: base + sc.start,
        high: base + sc.end,
        vars: sc.vars.map(mkVar),
      });
    }
  }

  for (const g of program.globals) {
    // N_GSYM carries no address — resolve via the linker symbol table. Statics
    // (STSYM/LCSYM) carry a hunk-relative address, but their owning hunk is
    // ambiguous, so prefer the symbol table there too and skip if unresolved.
    // C symbols are underscore-prefixed in HUNK_SYMBOL but bare in stabs.
    const address = symbols[g.name] ?? symbols["_" + g.name];
    if (address === undefined) continue;
    const td = program.resolveType(g.typeKey);
    globalVars.push({
      name: g.name,
      typeName: td.typeName,
      byteSize: td.byteSize,
      typeDescriptor: td,
      location: { kind: "addr", address },
    });
  }
}
