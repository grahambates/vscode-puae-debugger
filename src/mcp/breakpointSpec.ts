// Resolving a breakpoint the way a person would write one down.
//
// A caller asking to "break at draw_sprite" shouldn't have to look up an address first, and a
// model reading a source file already knows the file and line it cares about — so one string
// covers all three forms a breakpoint is naturally expressed in:
//
//   "0x2140" / "$2140"   an absolute address
//   "draw_sprite"        a symbol from the program's debug info
//   "main.s:42"          a source line (the nearest line at or before it that has code)
//
// Kept separate from the tools and the session so it can be tested against a real SourceMap
// without booting an emulator, and so a failure can say what it tried rather than just "not
// found" — the difference between a caller fixing their argument and a caller giving up.

import { SourceMap } from "../sourceMap";

export interface ResolvedBreakpoint {
  address: number;
  /** How this resolved, for reporting back: the spec plus what it turned out to mean. */
  description: string;
}

const HEX = /^(?:0x|\$)([0-9a-f]+)$/i;
const DECIMAL = /^\d+$/;

export function resolveBreakpointSpec(spec: string, sourceMap: SourceMap): ResolvedBreakpoint {
  const trimmed = spec.trim();
  if (!trimmed) throw new Error("Empty breakpoint specification");

  const hex = HEX.exec(trimmed);
  if (hex) {
    const address = parseInt(hex[1], 16);
    return { address, description: `${trimmed} -> ${describe(address, sourceMap)}` };
  }
  // A bare number is an address too, but decimal — worth accepting, since a caller reading an
  // address out of a report may not re-prefix it.
  if (DECIMAL.test(trimmed)) {
    const address = parseInt(trimmed, 10);
    return { address, description: `${trimmed} -> ${describe(address, sourceMap)}` };
  }

  // "path:line" — split on the LAST colon so a Windows drive letter (C:\src\main.s:42) survives.
  const colon = trimmed.lastIndexOf(":");
  if (colon > 0 && DECIMAL.test(trimmed.slice(colon + 1))) {
    // A file name alone, or a trailing part of the path (main.s, src/main.s), names the one
    // source file it ends — the program records full paths, which a caller rarely spells out.
    const given = trimmed.slice(0, colon);
    const tail = given.replace(/\\/g, "/");
    const matches = sourceMap.getSourceFiles().filter((f) => {
      const file = f.replace(/\\/g, "/");
      return file === tail || file.endsWith(`/${tail}`);
    });
    const path = matches.length === 1 ? matches[0] : given;
    const line = parseInt(trimmed.slice(colon + 1), 10);
    let location;
    try {
      location = sourceMap.lookupSourceLine(path, line);
    } catch (error) {
      throw new Error(
        `No code at ${trimmed}: ${error instanceof Error ? error.message : String(error)}. ` +
          `Source files in this program: ${listSome(sourceMap.getSourceFiles())}`,
      );
    }
    const at = location.line === line ? "" : ` (nearest line with code: ${location.line})`;
    return {
      address: location.address,
      description: `${trimmed}${at} -> ${formatAddress(location.address)}`,
    };
  }

  const symbols = sourceMap.getSymbols();
  const address = symbols[trimmed];
  if (address === undefined) {
    const near = Object.keys(symbols).filter((name) => name.toLowerCase().includes(trimmed.toLowerCase()));
    throw new Error(
      `Unknown breakpoint "${trimmed}" — not an address, not a "file:line", and not a symbol in ` +
        `this program.${near.length ? ` Did you mean: ${listSome(near)}?` : ` Symbols: ${listSome(Object.keys(symbols))}`}`,
    );
  }
  return { address, description: `${trimmed} -> ${formatAddress(address)}` };
}

export function formatAddress(address: number): string {
  return `0x${(address >>> 0).toString(16).padStart(8, "0")}`;
}

// Kickstart ROM window (256K and 512K ROMs both sit inside it), as in WinUAE and the profiler's
// own syntheticLabel.
const ROM_START = 0xf80000;
const ROM_END = 0x1000000;

/** "0x00c02140 (moveloop+4, main.s:31)" — as much context as the debug info actually supports. */
export function describe(address: number, sourceMap: SourceMap | undefined): string {
  const parts: string[] = [];
  const symbol = sourceMap?.findSymbolOffset(address);
  if (symbol) parts.push(symbol.offset ? `${symbol.symbol}+${symbol.offset}` : symbol.symbol);
  const location = sourceMap?.lookupAddress(address);
  if (location) parts.push(`${location.path}:${location.line}`);
  // Say so rather than leaving a bare address the reader has to recognise: ROM symbols only
  // resolve for the handful of ROMs with an embedded symbol table, so an unnamed address in this
  // window is the normal case, not a lookup failure.
  if (parts.length === 0 && address >= ROM_START && address < ROM_END) parts.push("Kickstart ROM");
  return parts.length ? `${formatAddress(address)} (${parts.join(", ")})` : formatAddress(address);
}

// Enough names to recognise the right one, not so many that an error message becomes a dump.
function listSome(names: string[], limit = 12): string {
  if (names.length === 0) return "(none)";
  const shown = names.slice(0, limit).join(", ");
  return names.length > limit ? `${shown}, ... (${names.length} total)` : shown;
}
