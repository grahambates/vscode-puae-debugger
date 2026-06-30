import { buildAddressSuggestions, parseAddressInput } from "../webview/profilerViewer/addressSuggestions";
import { ISymbol } from "../shared/profilerTypes";

const symbols: ISymbol[] = [
  { address: 0x1000, name: "main", size: 0x40 },
  { address: 0x4000, name: "Screen", size: 0x100 },
  { address: 0x4100, name: "ScreenEnd", size: 0 },
  { address: 0x5000, name: "copperList", size: 0x80 },
];

describe("buildAddressSuggestions", () => {
  it("includes both regions and all symbols, alphabetically, when the query is empty", () => {
    const result = buildAddressSuggestions("", symbols, true);
    expect(result[0]).toEqual({ kind: "region", label: "Chip RAM", region: "chip" });
    expect(result[1]).toEqual({ kind: "region", label: "Slow RAM", region: "slow" });
    const symbolLabels = result.slice(2).map((s) => s.label);
    expect(symbolLabels).toEqual(["copperList", "main", "Screen", "ScreenEnd"]);
  });

  it("omits Slow RAM when hasSlow is false", () => {
    const result = buildAddressSuggestions("", symbols, false);
    expect(result.filter((s) => s.kind === "region")).toEqual([{ kind: "region", label: "Chip RAM", region: "chip" }]);
  });

  it("filters by case-insensitive substring match across both regions and symbols", () => {
    const result = buildAddressSuggestions("scr", symbols, true);
    expect(result).toEqual([
      { kind: "symbol", label: "Screen", address: 0x4000, size: 0x100 },
      { kind: "symbol", label: "ScreenEnd", address: 0x4100, size: 0 },
    ]);
  });

  it("matches a region by substring (e.g. 'chip' or 'ram')", () => {
    expect(buildAddressSuggestions("chip", symbols, true).map((s) => s.label)).toEqual(["Chip RAM"]);
    expect(buildAddressSuggestions("ram", symbols, true).map((s) => s.label)).toEqual(["Chip RAM", "Slow RAM"]);
  });

  it("caps the symbol count at the given limit, regions are never capped", () => {
    const many: ISymbol[] = Array.from({ length: 10 }, (_, i) => ({ address: i, name: `sym${i}`, size: 1 }));
    const result = buildAddressSuggestions("", many, true, 3);
    expect(result.filter((s) => s.kind === "region")).toHaveLength(2);
    expect(result.filter((s) => s.kind === "symbol")).toHaveLength(3);
  });

  it("returns no symbols when there's no model.symbols yet", () => {
    const result = buildAddressSuggestions("", undefined, true);
    expect(result.every((s) => s.kind === "region")).toBe(true);
  });
});

describe("parseAddressInput", () => {
  it("parses a bare hex string with no prefix", () => {
    expect(parseAddressInput("4000")).toBe(0x4000);
  });

  it("strips a $ prefix", () => {
    expect(parseAddressInput("$4000")).toBe(0x4000);
  });

  it("strips a 0x prefix", () => {
    expect(parseAddressInput("0x4000")).toBe(0x4000);
  });

  it("returns undefined for empty or non-hex input", () => {
    expect(parseAddressInput("")).toBeUndefined();
    expect(parseAddressInput("   ")).toBeUndefined();
    expect(parseAddressInput("not-an-address")).toBeUndefined();
  });
});
