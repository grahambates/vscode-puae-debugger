import { normalize } from "path";
import { DWARFData } from "./dwarfParser";
import { buildElfSegments, resolveElfAddress, SectionOffset } from "./dwarfSourceMap";
import {
  SourceMap,
  Location,
  ScopeEntry,
  Variable,
  LocalLocation,
} from "./sourceMap";
import { StabData } from "./amigaHunkParser";
import { parseStabs, StabLocation, StabVariable } from "./stabsParser";

/**
 * Creates a source map from GNU stabs debug information embedded in an ELF
 * file's `.stab`/`.stabstr` sections (GCC `-gstabs` targeting an ELF, as
 * opposed to DWARF `-g` or hunk-embedded stabs — see amigaHunkSourceMap.ts
 * for that case).
 *
 * Reuses the container-agnostic stabs decoder (stabsParser.ts) — the same
 * nlist/type-grammar logic as the hunk-stabs path — but resolves addresses
 * differently: stabs `n_value` fields here are ELF-vaddr-space values (GNU
 * BFD applies real ELF relocations to `.stab` at link time, same as `.text`/
 * `.data`), so they're relocated via `resolveElfAddress` — the exact same
 * mechanism `sourceMapFromDwarf` uses for DWARF line/location addresses in
 * this project's Amiga-ELF toolchain, and empirically confirmed against this
 * project's own ELF fixtures (see below). Globals resolve by NAME through the
 * ELF `.symtab` (`dwarfData.elfSymbols`) — confirmed (via c_prog.elf /
 * simple_c.elf fixtures) that this toolchain's C symbols are NOT
 * underscore-prefixed in ELF, unlike the Amiga-hunk target.
 *
 * CONFIDENCE NOTE: unlike the hunk-stabs implementation (reverse-engineered
 * and validated byte-for-byte against a real GCC/vlink hunk+stabs binary),
 * no real ELF+stabs (`-gstabs`, ELF target) fixture was available at
 * implementation time. The address-relocation and symbol-naming conventions
 * above are derived with reasonable confidence from this project's own
 * ALREADY-VALIDATED DWARF/ELF-symbol handling (same toolchain family), not
 * from a fixture of this exact debug format. Recommend validating against a
 * real `-gstabs` ELF build before relying on this in production, the same
 * way pt1210-debug.exe validated the hunk-stabs path.
 *
 * Stabs carries no stack-unwind info, so no debugFrame is produced here either
 * (unwinding stays DWARF-only, same as the hunk-stabs path).
 *
 * @param dwarfData Parsed ELF data (sections + symbol table) — from parseDwarf,
 *                  which parses these unconditionally regardless of whether
 *                  DWARF sections are present.
 * @param stabs Raw `.stab`/`.stabstr` bytes (see extractElfStabs).
 * @param offsets Runtime load addresses for each loaded ELF section (same
 *                convention as sourceMapFromDwarf).
 */
export function sourceMapFromElfStabs(
  dwarfData: DWARFData,
  stabs: StabData,
  offsets: number[],
): SourceMap {
  const { segments, sectionOffsets } = buildElfSegments(dwarfData, offsets);
  const sources = new Set<string>();
  const symbols: Record<string, number> = {};
  const locations: Location[] = [];
  const scopeTable: ScopeEntry[] = [];
  const globalVars: Variable[] = [];

  // ELF .symtab first (bare C names — no underscore prefix on this toolchain,
  // confirmed against this project's own ELF fixtures), so stabs globals with
  // no address of their own (N_GSYM) can resolve by name.
  for (const elfSymbol of dwarfData.elfSymbols) {
    const so = sectionOffsets[elfSymbol.sectionIndex];
    if (so.loaded) {
      symbols[elfSymbol.name] = elfSymbol.value + so.offset;
    }
  }

  const program = parseStabs([stabs]);

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
    const resolved = resolveElfAddress(ln.address, dwarfData, sectionOffsets);
    if (!resolved) continue; // debug-only or otherwise unloaded address
    locations.push({
      path: normalize(ln.file),
      line: ln.line,
      segmentIndex: resolved.segmentIndex,
      segmentOffset: resolved.segmentOffset,
      address: resolved.address,
    });
  }

  for (const fn of program.functions) {
    const resolved = resolveElfAddress(fn.address, dwarfData, sectionOffsets);
    if (!resolved) continue;
    if (symbols[fn.name] === undefined) symbols[fn.name] = resolved.address;
    const high = resolved.address + (fn.size ?? 0);
    if (fn.params.length) {
      scopeTable.push({
        low: resolved.address,
        high,
        vars: fn.params.map(mkVar),
      });
    }
    for (const sc of fn.scopes) {
      if (!sc.vars.length) continue;
      const scLow = resolveElfAddress(sc.start, dwarfData, sectionOffsets);
      const scHigh = resolveElfAddress(sc.end, dwarfData, sectionOffsets);
      if (!scLow || !scHigh) continue;
      scopeTable.push({ low: scLow.address, high: scHigh.address, vars: sc.vars.map(mkVar) });
    }
  }

  for (const g of program.globals) {
    // Statics (STSYM/LCSYM) carry their own ELF-vaddr address — resolve
    // directly. N_GSYM carries no address, so fall back to .symtab by name.
    const address =
      g.address !== undefined
        ? resolveElfAddress(g.address, dwarfData, sectionOffsets)?.address
        : symbols[g.name];
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

  if (!sources.size) {
    throw new Error(
      "Source map error: No debug information found in ELF stabs sections",
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

/** GNU stabs frame locals live at [A5 + offset], which is the SourceMap `fbreg` case. */
function stabToLocalLocation(loc: StabLocation): LocalLocation {
  switch (loc.kind) {
    case "frame":
      return { kind: "fbreg", offset: loc.offset };
    case "register":
      // m68k stabs register numbers: 0-7 = D0-D7, 8-15 = A0-A7 (same as DWARF).
      return { kind: "reg", reg: loc.reg };
    default:
      return { kind: "unknown" };
  }
}

/**
 * Read the raw `.stab`/`.stabstr` section bytes from an ELF buffer, using the
 * section table already parsed by parseDwarf. Call only after confirming
 * hasElfStabsSections(dwarfData).
 */
export function extractElfStabs(elfBuffer: Buffer, dwarfData: DWARFData): StabData {
  const stabHeader = dwarfData.sections.get(".stab");
  const strHeader = dwarfData.sections.get(".stabstr");
  if (!stabHeader || !strHeader) {
    throw new Error(
      "ELF stabs error: .stab or .stabstr section missing (call hasElfStabsSections first)",
    );
  }
  return {
    stabs: elfBuffer.subarray(stabHeader.offset, stabHeader.offset + stabHeader.size),
    strings: elfBuffer.subarray(strHeader.offset, strHeader.offset + strHeader.size),
  };
}

// Re-exported for callers that only need the type, without importing dwarfSourceMap directly.
export type { SectionOffset };
