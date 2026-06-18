// Webview-side address symbolization. The extension ships the program + Kickstart symbol
// table (ISymbol[], sorted by address, each with a segment-clamped size) and this builds a
// floor-search `symbolize(addr)` — the reusable primitive the DMA tooltip uses now and
// future disassembly/copper/memory views can reuse. Mirrors SourceMap.findSymbolOffset.

import { ISymbol } from "../../shared/profilerTypes";

export type Symbolizer = (addr: number) => string | undefined;

// Build a symbolizer from the shipped symbol list. Returns a function that maps an address
// to "name" / "name+$offset", or undefined if it falls outside every symbol's range.
export function createSymbolizer(symbols: readonly ISymbol[] | undefined): Symbolizer {
  if (!symbols || symbols.length === 0) return () => undefined;

  // Sort once by address (the extension sends sorted, but don't rely on it).
  const sorted = [...symbols].sort((a, b) => a.address - b.address);
  const addrs = Int32Array.from(sorted, (s) => s.address | 0);

  return (addr: number): string | undefined => {
    const a = addr >>> 0;
    // Binary search for the largest symbol address <= a.
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
    // Exact hits always resolve; a positive offset only if it's within the symbol's known
    // size (size<=0 ⇒ unknown extent ⇒ exact-match only, never claim trailing addresses).
    if (offset !== 0 && (sym.size <= 0 || offset >= sym.size)) return undefined;
    return offset ? `${sym.name}+$${offset.toString(16)}` : sym.name;
  };
}
