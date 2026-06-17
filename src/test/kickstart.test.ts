import * as assert from "assert";
import * as crypto from "crypto";
import { kickstartSymbolModule } from "../kickstart";
import { kickstartRoms } from "../kickstartSymbols";
import { SourceMap, Segment } from "../sourceMap";
import { MemoryType } from "../amigaHunkParser";

describe("Kickstart symbols", () => {
  describe("generated data module", () => {
    it("contains the six known ROMs", () => {
      assert.strictEqual(Object.keys(kickstartRoms).length, 6);
    });

    it("uses 256K or 512K ROM sizes and in-range offsets", () => {
      for (const [sha1, rom] of Object.entries(kickstartRoms)) {
        assert.ok(/^[0-9a-f]{40}$/.test(sha1), `bad sha1 ${sha1}`);
        assert.ok(
          rom.size === 256 * 1024 || rom.size === 512 * 1024,
          `unexpected size ${rom.size}`,
        );
        assert.ok(rom.name.length > 0, `missing name for ${sha1}`);
        assert.ok(rom.symbols.length > 0);
        for (const [name, offset] of rom.symbols) {
          assert.ok(name.length > 0);
          assert.ok(
            offset >= 0 && offset < rom.size,
            `offset out of range for ${name}`,
          );
        }
      }
    });

    it("includes OpenLibrary in the 1.3 ROM", () => {
      const rom = kickstartRoms["891e9a547772fe0c6c19b610baf8bc4ea7fcb785"];
      assert.ok(rom, "1.3 ROM missing");
      const openLib = rom.symbols.find(([name]) => name === "OpenLibrary");
      assert.ok(openLib, "OpenLibrary not found");
      assert.strictEqual(openLib![1], 0x1474);
    });
  });

  describe("kickstartSymbolModule", () => {
    // Helper: register a synthetic ROM of `size` bytes and return its buffer + sha1.
    function registerSyntheticRom(
      size: number,
      symbols: [string, number][],
    ): { buffer: Buffer; sha1: string } {
      const buffer = Buffer.alloc(size);
      // Make the contents unique so the sha1 doesn't collide with anything real.
      buffer.write(`synthetic-${size}-${symbols.length}`);
      const sha1 = crypto.createHash("sha1").update(buffer).digest("hex");
      kickstartRoms[sha1] = { name: "Synthetic ROM", size, symbols };
      return { buffer, sha1 };
    }

    const injected: string[] = [];
    afterEach(() => {
      for (const sha1 of injected) delete kickstartRoms[sha1];
      injected.length = 0;
    });

    it("returns undefined for an unknown ROM", () => {
      const buffer = Buffer.from("not a known rom");
      assert.strictEqual(kickstartSymbolModule(buffer), undefined);
    });

    it("relocates a 256K ROM to base 0xFC0000", () => {
      const { buffer, sha1 } = registerSyntheticRom(256 * 1024, [
        ["OpenLibrary", 0x1474],
        ["CloseLibrary", 0x1480],
      ]);
      injected.push(sha1);

      const mod = kickstartSymbolModule(buffer);
      assert.ok(mod);
      assert.strictEqual(mod!.sha1, sha1);
      assert.strictEqual(mod!.base, 0xfc0000);
      assert.strictEqual(mod!.symbols["OpenLibrary"], 0xfc1474);
      assert.strictEqual(mod!.symbols["CloseLibrary"], 0xfc1480);
      assert.deepStrictEqual(mod!.segment, {
        name: "kickstart",
        address: 0xfc0000,
        size: 256 * 1024,
        memType: MemoryType.ANY,
      });
    });

    it("relocates a 512K ROM to base 0xF80000", () => {
      const { buffer, sha1 } = registerSyntheticRom(512 * 1024, [
        ["Exec", 0x10],
      ]);
      injected.push(sha1);

      const mod = kickstartSymbolModule(buffer);
      assert.ok(mod);
      assert.strictEqual(mod!.base, 0xf80000);
      assert.strictEqual(mod!.symbols["Exec"], 0xf80010);
      assert.strictEqual(mod!.segment.address, 0xf80000);
      assert.strictEqual(mod!.segment.size, 512 * 1024);
    });
  });

  describe("SourceMap.addSymbolModule", () => {
    it("merges ROM symbols so findSymbolOffset resolves ROM addresses", () => {
      const segments: Segment[] = [
        {
          name: "CODE",
          address: 0x1000,
          size: 0x1000,
          memType: MemoryType.CHIP,
        },
      ];
      const sourceMap = new SourceMap(
        segments,
        new Set(),
        { main: 0x1000 },
        [],
      );

      // Before merging, a ROM address is in no segment, so no symbol resolves.
      assert.strictEqual(sourceMap.findSymbolOffset(0xfc1474 + 4), undefined);

      const kickSegment: Segment = {
        name: "kickstart",
        address: 0xfc0000,
        size: 256 * 1024,
        memType: MemoryType.ANY,
      };
      sourceMap.addSymbolModule(kickSegment, {
        OpenLibrary: 0xfc1474,
        CloseLibrary: 0xfc1480,
      });

      // Program symbols are preserved.
      assert.strictEqual(sourceMap.getSymbols()["main"], 0x1000);
      // ROM symbols are now present and resolvable with the correct offset.
      assert.strictEqual(sourceMap.getSymbols()["OpenLibrary"], 0xfc1474);
      assert.deepStrictEqual(sourceMap.findSymbolOffset(0xfc1474 + 4), {
        symbol: "OpenLibrary",
        offset: 4,
      });
    });
  });
});
