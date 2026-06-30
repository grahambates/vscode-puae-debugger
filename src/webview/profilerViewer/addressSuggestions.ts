// Suggestion list for the Memory View's address combo box: merges the two RAM regions (Chip/Slow)
// and the program's symbol table into one filterable list, so a single input replaces both the
// old region <select> and the "Go to address" text box. Mirrors the live memory viewer's
// getSymbolSuggestions (case-insensitive substring match, alphabetical), but runs client-side —
// the profiler model already ships the full symbol table to the webview, unlike the live viewer
// (which queries the host on every keystroke since its symbol set isn't preloaded).

import { ISymbol } from "../../shared/profilerTypes";

export type Region = "chip" | "slow";

export interface RegionSuggestion {
  kind: "region";
  label: string;
  region: Region;
}

export interface SymbolSuggestion {
  kind: "symbol";
  label: string;
  address: number;
  size: number;
}

export type AddressSuggestion = RegionSuggestion | SymbolSuggestion;

const SUGGESTIONS_LIMIT = 50;

export function buildAddressSuggestions(
  query: string,
  symbols: readonly ISymbol[] | undefined,
  hasSlow: boolean,
  limit = SUGGESTIONS_LIMIT,
): AddressSuggestion[] {
  const q = query.trim().toLowerCase();

  const regions: RegionSuggestion[] = [{ kind: "region", label: "Chip RAM", region: "chip" }];
  if (hasSlow) regions.push({ kind: "region", label: "Slow RAM", region: "slow" });
  const matchedRegions = regions.filter((r) => !q || r.label.toLowerCase().includes(q));

  const matchedSymbols: SymbolSuggestion[] = [];
  if (symbols) {
    for (const s of symbols) {
      if (!q || s.name.toLowerCase().includes(q)) {
        matchedSymbols.push({ kind: "symbol", label: s.name, address: s.address, size: s.size });
        if (matchedSymbols.length >= limit) break;
      }
    }
  }
  matchedSymbols.sort((a, b) => a.label.localeCompare(b.label));

  return [...matchedRegions, ...matchedSymbols];
}

// Hex address parsing for free-typed input that doesn't match any suggestion (e.g. "$4000",
// "0x4000", "4000" — all parsed as hex, "$"/"0x" prefix optional) — same convention as the old
// "Go to address" box's jumpTo().
export function parseAddressInput(input: string): number | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const addr = parseInt(trimmed.replace(/^\$|^0x/i, ""), 16);
  return Number.isNaN(addr) ? undefined : addr;
}
