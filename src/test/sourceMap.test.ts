import * as assert from "assert";
import { SourceMap, Location, Segment } from "../sourceMap";
import { MemoryType } from "../amigaHunkParser";

/**
 * Tests for SourceMap functionality
 */
describe("SourceMap Tests", () => {
  let sourceMap: SourceMap;
  let testSegments: Segment[];
  let testSources: Set<string>;
  let testSymbols: Record<string, number>;
  let testLocations: Location[];

  beforeEach(() => {
    testSegments = [
      { name: "CODE", address: 0x1000, size: 0x1000, memType: MemoryType.CHIP },
      { name: "DATA", address: 0x2000, size: 0x800, memType: MemoryType.CHIP },
    ];

    testSources = new Set(["/test/main.c", "/test/util.c"]);

    testSymbols = {
      main: 0x1000,
      sub1: 0x1100,
      sub2: 0x1200,
      data_start: 0x2000,
      buffer: 0x2100,
    };

    testLocations = [
      {
        path: "/test/main.c",
        line: 10,
        address: 0x1000,
        segmentIndex: 0,
        segmentOffset: 0,
      },
      {
        path: "/test/main.c",
        line: 15,
        address: 0x1020,
        segmentIndex: 0,
        segmentOffset: 0x20,
      },
      {
        path: "/test/main.c",
        line: 20,
        address: 0x1100,
        segmentIndex: 0,
        segmentOffset: 0x100,
      },
      {
        path: "/test/util.c",
        line: 5,
        address: 0x1200,
        segmentIndex: 0,
        segmentOffset: 0x200,
      },
    ];

    sourceMap = new SourceMap(
      testSegments,
      testSources,
      testSymbols,
      testLocations,
    );
  });

  describe("Constructor and Basic Access", () => {
    it("should store segments correctly", () => {
      const segments = sourceMap.getSegmentsInfo();
      assert.strictEqual(segments.length, 2);
      assert.strictEqual(segments[0].name, "CODE");
      assert.strictEqual(segments[1].name, "DATA");
    });

    it("should store source files correctly", () => {
      const sources = sourceMap.getSourceFiles();
      assert.strictEqual(sources.length, 2);
      assert.ok(sources.includes("/test/main.c"));
      assert.ok(sources.includes("/test/util.c"));
    });

    it("should store symbols correctly", () => {
      const symbols = sourceMap.getSymbols();
      assert.strictEqual(symbols.main, 0x1000);
      assert.strictEqual(symbols.sub1, 0x1100);
      assert.strictEqual(symbols.data_start, 0x2000);
    });
  });

  describe("Address Lookup", () => {
    it("should find exact address match", () => {
      const location = sourceMap.lookupAddress(0x1000);
      assert.ok(location);
      assert.strictEqual(location.path, "/test/main.c");
      assert.strictEqual(location.line, 10);
      assert.strictEqual(location.address, 0x1000);
    });

    it("should find nearest address match within range", () => {
      const location = sourceMap.lookupAddress(0x1005); // Between 0x1000 and 0x1020
      assert.ok(location);
      assert.strictEqual(location.address, 0x1000);
      assert.strictEqual(location.line, 10);
    });

    it("should find address far from line table entry (mid-statement floor search)", () => {
      const location = sourceMap.lookupAddress(0x1015); // Between 0x1000 and 0x1020 — a C statement spanning many instructions
      assert.ok(location);
      assert.strictEqual(location.address, 0x1000);
      assert.strictEqual(location.line, 10);
    });

    it("should return undefined for address outside any loaded segment", () => {
      const location = sourceMap.lookupAddress(0x5000);
      assert.strictEqual(location, undefined);
    });
  });

  describe("getLineTable", () => {
    it("returns one entry per location, with path/line/address", () => {
      const table = sourceMap.getLineTable();
      assert.strictEqual(table.length, testLocations.length);
      const byAddress = new Map(table.map((e) => [e.address, e]));
      assert.deepStrictEqual(byAddress.get(0x1000), { address: 0x1000, path: "/test/main.c", line: 10 });
      assert.deepStrictEqual(byAddress.get(0x1200), { address: 0x1200, path: "/test/util.c", line: 5 });
    });
  });

  describe("Source Line Lookup", () => {
    it("should find exact line match", () => {
      const location = sourceMap.lookupSourceLine("/test/main.c", 10);
      assert.strictEqual(location.address, 0x1000);
      assert.strictEqual(location.line, 10);
    });

    it("should find nearest line match", () => {
      const location = sourceMap.lookupSourceLine("/test/main.c", 12); // Between lines 10 and 15
      assert.strictEqual(location.address, 0x1000);
      assert.strictEqual(location.line, 10);
    });

    it("should handle case-insensitive path matching", () => {
      const location = sourceMap.lookupSourceLine("/TEST/MAIN.C", 10);
      assert.strictEqual(location.address, 0x1000);
    });

    it("should throw for non-existent file", () => {
      assert.throws(() => {
        sourceMap.lookupSourceLine("/nonexistent/file.c", 10);
      }, /Source map error: File not found/);
    });

    it("should find last available line for high line numbers", () => {
      const location = sourceMap.lookupSourceLine("/test/main.c", 100);
      assert.strictEqual(location.address, 0x1100); // Last line in main.c
      assert.strictEqual(location.line, 20);
    });
  });

  describe("Segment Operations", () => {
    it("should get segment by index", () => {
      const segment = sourceMap.getSegmentInfo(0);
      assert.strictEqual(segment.name, "CODE");
      assert.strictEqual(segment.address, 0x1000);
    });

    it("should find segment for address", () => {
      const segment = sourceMap.findSegmentForAddress(0x1500);
      assert.ok(segment);
      assert.strictEqual(segment.name, "CODE");

      const dataSegment = sourceMap.findSegmentForAddress(0x2200);
      assert.ok(dataSegment);
      assert.strictEqual(dataSegment.name, "DATA");
    });

    it("should return undefined for address outside segments", () => {
      const segment = sourceMap.findSegmentForAddress(0x5000);
      assert.strictEqual(segment, undefined);
    });
  });

  describe("Symbol Operations", () => {
    it("should calculate symbol lengths correctly", () => {
      const lengths = sourceMap.getSymbolLengths();
      assert.ok(lengths);

      // main to sub1: 0x1100 - 0x1000 = 0x100
      assert.strictEqual(lengths.main, 0x100);

      // sub1 to sub2: 0x1200 - 0x1100 = 0x100
      assert.strictEqual(lengths.sub1, 0x100);

      // sub2 to end of CODE segment: (0x1000 + 0x1000) - 0x1200 = 0xE00
      assert.strictEqual(lengths.sub2, 0xe00);

      // data_start to buffer: 0x2100 - 0x2000 = 0x100
      assert.strictEqual(lengths.data_start, 0x100);

      // buffer to end of DATA segment: (0x2000 + 0x800) - 0x2100 = 0x700
      assert.strictEqual(lengths.buffer, 0x700);
    });

    it("should find symbol offset correctly", () => {
      const offset = sourceMap.findSymbolOffset(0x1050);
      assert.ok(offset);
      assert.strictEqual(offset.symbol, "main");
      assert.strictEqual(offset.offset, 0x50);
    });

    it("should find exact symbol match with zero offset", () => {
      const offset = sourceMap.findSymbolOffset(0x1100);
      assert.ok(offset);
      assert.strictEqual(offset.symbol, "sub1");
      assert.strictEqual(offset.offset, 0);
    });

    it("should return undefined for address outside segments", () => {
      const offset = sourceMap.findSymbolOffset(0x5000);
      assert.strictEqual(offset, undefined);
    });

    it("should return correct symbol for address in different segment", () => {
      const offset = sourceMap.findSymbolOffset(0x2150);
      assert.ok(offset);
      assert.strictEqual(offset.symbol, "buffer");
      assert.strictEqual(offset.offset, 0x50);
    });

    it("excludeLocal skips vasm-style local labels (leading dot) from getSymbols", () => {
      const map = new SourceMap(
        testSegments,
        testSources,
        { ...testSymbols, ".loop": 0x1110 },
        testLocations,
      );
      assert.ok(".loop" in map.getSymbols());
      assert.ok(!(".loop" in map.getSymbols(true)));
      assert.ok("sub1" in map.getSymbols(true));
    });

    it("excludeLocal makes a routine's length span past its internal local labels", () => {
      // sub1 contains a local label (e.g. a macro's internal loop target, like BLIT_WAIT's
      // `.\@`) partway through it. Without excludeLocal, sub1's computed length stops at the
      // local label instead of extending to sub2 - the bug that split the flame graph and
      // made the webview symbolizer disagree with it.
      const map = new SourceMap(
        testSegments,
        testSources,
        { main: 0x1000, sub1: 0x1100, ".loop": 0x1110, sub2: 0x1200, data_start: 0x2000, buffer: 0x2100 },
        testLocations,
      );
      const lengthsWithLocal = map.getSymbolLengths();
      assert.strictEqual(lengthsWithLocal?.sub1, 0x10); // truncated at .loop

      const lengthsExcludingLocal = map.getSymbolLengths(true);
      assert.strictEqual(lengthsExcludingLocal?.sub1, 0x100); // spans to sub2, as before
      assert.ok(!lengthsExcludingLocal || !(".loop" in lengthsExcludingLocal));
    });

    it("computes correct lengths regardless of the symbol table's insertion order", () => {
      // getSymbolLengths needs each symbol's address-order successor, but a real ELF's .symtab
      // is emitted in whatever order the assembler/linker produced (declaration order, roughly)
      // — NOT address order. Confirmed against a real hand-assembled ELF, where routines appeared
      // completely scrambled by address in the raw symbol table. Iterating unsorted computed the
      // distance to whatever unrelated symbol happened to be next in that scrambled order instead
      // — sometimes wildly oversized, sometimes negative (which a real function then got dropped
      // from the disassembly entirely for, since fetchDisassembly skips size <= 0).
      const scrambled = new SourceMap(
        testSegments,
        testSources,
        { sub2: 0x1200, main: 0x1000, buffer: 0x2100, sub1: 0x1100, data_start: 0x2000 },
        testLocations,
      );
      const lengths = scrambled.getSymbolLengths();
      assert.ok(lengths);
      assert.strictEqual(lengths.main, 0x100); // main -> sub1
      assert.strictEqual(lengths.sub1, 0x100); // sub1 -> sub2
      assert.strictEqual(lengths.sub2, 0xe00); // sub2 -> end of CODE segment
      assert.strictEqual(lengths.data_start, 0x100); // data_start -> buffer
      assert.strictEqual(lengths.buffer, 0x700); // buffer -> end of DATA segment
      assert.ok(Object.values(lengths).every((len) => len > 0)); // never negative
    });

    it("excludeLocal in findSymbolOffset resolves an address inside a local label's range back to the enclosing routine", () => {
      const map = new SourceMap(
        testSegments,
        testSources,
        { ...testSymbols, ".loop": 0x1110 },
        testLocations,
      );
      // Without excludeLocal, the nearest preceding symbol for 0x1115 is the local label.
      const withLocal = map.findSymbolOffset(0x1115);
      assert.strictEqual(withLocal?.symbol, ".loop");

      // With excludeLocal, it resolves to the enclosing routine instead.
      const withoutLocal = map.findSymbolOffset(0x1115, true);
      assert.strictEqual(withoutLocal?.symbol, "sub1");
      assert.strictEqual(withoutLocal?.offset, 0x15);
    });

    it("should prefer the nearest symbol when symbols are packed adjacently", () => {
      // Simulates packed data variables: int (4 bytes) then short (2 bytes) then char (1 byte)
      const packedMap = new SourceMap(
        [{ name: "DATA", address: 0x2034, size: 0x10, memType: MemoryType.CHIP }],
        testSources,
        { global_int: 0x2034, global_short: 0x2038, global_char: 0x203a },
        [],
      );
      // Exact match for global_short must not return global_int+4
      const shortOffset = packedMap.findSymbolOffset(0x2038);
      assert.ok(shortOffset);
      assert.strictEqual(shortOffset.symbol, "global_short");
      assert.strictEqual(shortOffset.offset, 0);

      // Exact match for global_char must not return global_short+2 or global_int+6
      const charOffset = packedMap.findSymbolOffset(0x203a);
      assert.ok(charOffset);
      assert.strictEqual(charOffset.symbol, "global_char");
      assert.strictEqual(charOffset.offset, 0);
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty symbol list", () => {
      const emptyMap = new SourceMap(
        testSegments,
        testSources,
        {},
        testLocations,
      );
      const lengths = emptyMap.getSymbolLengths();
      assert.deepStrictEqual(lengths, {});

      const offset = emptyMap.findSymbolOffset(0x1000);
      assert.strictEqual(offset, undefined);
    });

    it("should handle single symbol", () => {
      const singleSymbol = { alone: 0x1000 };
      const singleMap = new SourceMap(
        testSegments,
        testSources,
        singleSymbol,
        testLocations,
      );

      const lengths = singleMap.getSymbolLengths();
      assert.ok(lengths);
      assert.strictEqual(lengths.alone, 0x1000); // To end of segment
    });

    it("should handle segments with no symbols", () => {
      const symbolsInCodeOnly = { main: 0x1000, sub1: 0x1100 };
      const map = new SourceMap(
        testSegments,
        testSources,
        symbolsInCodeOnly,
        testLocations,
      );

      // Address in DATA segment with no symbols
      const offset = map.findSymbolOffset(0x2000);
      assert.strictEqual(offset, undefined);
    });
  });
});
