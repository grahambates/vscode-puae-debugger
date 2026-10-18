import * as assert from "assert";
import * as crypto from "crypto";
import { readFileSync } from "fs";
import * as path from "path";
import { kickstartSymbolModule, kickstartSymbolModuleBySha1, singleImage } from "../kickstart";
import { kickstartRoms } from "../kickstartSymbols";
import { SourceMap, Segment } from "../sourceMap";
import { MemoryType } from "../amigaHunkParser";
import { parseDwarf } from "../dwarfParser";
import { buildSourceMapFromBundle } from "../profileLoader";
import type { ProfileManifest } from "../profileFormat";

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

  describe("kickstartSymbolModuleBySha1", () => {
    // Same synthetic-ROM injection as above, but the reconstruction takes the sha1 alone (no ROM
    // bytes) — the size/base come from the table entry. This is the saved-.puaeprofile path.
    const injected: string[] = [];
    function registerSyntheticRom(size: number, symbols: [string, number][]): string {
      const buffer = Buffer.alloc(size);
      buffer.write(`synthetic-bysha1-${size}-${symbols.length}`);
      const sha1 = crypto.createHash("sha1").update(buffer).digest("hex");
      kickstartRoms[sha1] = { name: "Synthetic ROM", size, symbols };
      injected.push(sha1);
      return sha1;
    }
    afterEach(() => {
      for (const sha1 of injected) delete kickstartRoms[sha1];
      injected.length = 0;
    });

    it("returns undefined for an unknown and the empty-sentinel sha1", () => {
      assert.strictEqual(kickstartSymbolModuleBySha1("not-a-known-sha1"), undefined);
      assert.strictEqual(kickstartSymbolModuleBySha1(""), undefined);
    });

    it("reconstructs the same module as kickstartSymbolModule, from the sha1 alone", () => {
      const sha1 = registerSyntheticRom(256 * 1024, [
        ["OpenLibrary", 0x1474],
        ["CloseLibrary", 0x1480],
      ]);
      const mod = kickstartSymbolModuleBySha1(sha1);
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

  describe("buildSourceMapFromBundle re-merges Kickstart symbols (saved profile)", () => {
    // A real ELF fixture stands in for the embedded program; the manifest carries a ROM sha1.
    const ELF = readFileSync(path.join(__dirname, "fixtures/amigaPrograms/c_prog.elf"));
    const sectionCount = parseDwarf(ELF).sections.size;
    const ROM_ADDR = 0xfc1474 + 8; // OpenLibrary+8 in a 256K ROM mapped at 0xFC0000

    function manifest(sha1: string): ProfileManifest {
      return {
        version: 1,
        program: { elfEmbedded: true },
        meta: { frameCycles: 0, isPAL: true, start: 0, end: 0, total: 0, inRange: 0 },
        relocation: { segmentOffsets: new Array(sectionCount).fill(0), baseDir: "" },
        kickstart: { sha1, name: "" },
        sections: [],
        frameCount: 1,
        frameMeta: [{}],
      };
    }

    let romSha1: string;
    beforeEach(() => {
      const buffer = Buffer.alloc(256 * 1024);
      buffer.write("loader-synthetic-rom");
      romSha1 = crypto.createHash("sha1").update(buffer).digest("hex");
      kickstartRoms[romSha1] = { name: "Synthetic ROM", size: 256 * 1024, symbols: [["OpenLibrary", 0x1474]] };
    });
    afterEach(() => delete kickstartRoms[romSha1]);

    it("resolves a ROM address to its symbol when the manifest carries a known sha1", () => {
      const sourceMap = buildSourceMapFromBundle(ELF, manifest(romSha1));
      assert.deepStrictEqual(sourceMap.findSymbolOffset(ROM_ADDR), {
        symbol: "OpenLibrary",
        offset: 8,
      });
    });

    it("leaves ROM addresses unresolved for the empty-sentinel sha1 (no ROM info)", () => {
      const sourceMap = buildSourceMapFromBundle(ELF, manifest(""));
      assert.strictEqual(sourceMap.findSymbolOffset(ROM_ADDR), undefined);
    });
  });
});

describe("doubled Kickstart dumps", () => {
  // Kickstart 1.3 is usually dumped as 512KB: the 256KB image twice. Synthetic bytes stand in for
  // the ROM (which is copyrighted and not in the repo); what matters is the shape.
  const image = Buffer.alloc(262144);
  for (let i = 0; i < image.length; i++) image[i] = (i * 7) & 0xff;

  it("reads a 256KB image repeated to 512KB as the single image", () => {
    const doubled = Buffer.concat([image, image]);
    assert.ok(singleImage(doubled).equals(image));
    assert.strictEqual(singleImage(doubled).length, 262144);
  });

  it("leaves a genuine 512KB ROM, and a plain 256KB one, alone", () => {
    const different = Buffer.concat([image, Buffer.alloc(262144, 0x11)]);
    assert.strictEqual(singleImage(different).length, 524288);
    assert.strictEqual(singleImage(image).length, 262144);
  });

  it("identifies a doubled dump of a known ROM by that ROM's table", () => {
    // A doubled buffer whose halves hash like the image itself — so whatever the 256KB image
    // matches, the doubled dump matches too, at the 256KB ROM's base.
    const doubled = Buffer.concat([image, image]);
    const viaDoubled = crypto.createHash("sha1").update(singleImage(doubled)).digest("hex");
    const viaImage = crypto.createHash("sha1").update(image).digest("hex");
    assert.strictEqual(viaDoubled, viaImage);
  });
});
