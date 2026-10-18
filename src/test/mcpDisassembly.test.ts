// Tests for the MCP disassembly formatter — plain bytes in, readable text out.

import { readFileSync } from "fs";
import * as path from "path";
import { parseHunks } from "../amigaHunkParser";
import { sourceMapFromHunks } from "../amigaHunkSourceMap";
import { decodeLine, decodeRange, formatListing, sourceMapSymbolizer } from "../mcp/disassembly";
import { formatInstruction } from "../m68kDisassembly";

const bytes = (hex: string) => new Uint8Array(Buffer.from(hex.replace(/\s/g, ""), "hex"));

describe("decodeLine", () => {
  it("names custom registers and prints absolute addresses and immediates in hex", () => {
    const line = decodeLine(bytes("33fc 4000 00df f09a"), 0x1000);
    expect(line.text).toBe("move.w #$4000,$dff09a");
    expect(line.comments).toEqual(["INTENA"]);
    expect(line.length).toBe(8);
  });

  it("resolves a branch displacement to its target", () => {
    expect(decodeLine(bytes("60fe"), 0x1000).text).toBe("bra.b $1000");
    expect(decodeLine(bytes("51c8 fffc"), 0x2000).text).toBe("dbf.w d0,$1ffe");
  });

  it("keeps PC-relative data references as written, with the target alongside", () => {
    const line = decodeLine(bytes("41fa 0010"), 0x1000);
    expect(line.text).toBe("lea 16(pc),a0");
    expect(line.comments).toEqual(["$1012"]);
  });

  it("leaves a sign-mismatched immediate alone rather than mis-rewriting it", () => {
    // moveq #-1 decodes as value 255 but prints -1.
    expect(decodeLine(bytes("70ff"), 0x1000).text).toBe("moveq #-1,d0");
  });

  it("names CIA registers", () => {
    expect(decodeLine(bytes("4a39 00bf e001"), 0x1000).comments).toEqual(["CIA-A reg 0"]);
  });

  it("falls back to dc.w for an invalid opcode", () => {
    const line = decodeLine(bytes("ffff"), 0x1000);
    expect(line.text).toBe("dc.w $ffff");
    expect(line.length).toBe(2);
  });
});

describe("formatListing", () => {
  const BASE = 0x00c02140;
  const file = readFileSync(path.join(__dirname, "fixtures/amigaPrograms/gencop"));
  const hunks = parseHunks(file);
  const sourceMap = sourceMapFromHunks(hunks, [BASE]);
  const code = new Uint8Array(hunks[0].data!);

  it("labels symbols, marks the PC and shows source lines as they change", () => {
    const start = sourceMap.getSymbols()["moveloop"];
    const lines = decodeRange(code, BASE, start, 4, Infinity, sourceMapSymbolizer(sourceMap));
    const listing = formatListing(lines, lines[1].address, sourceMap);
    const rows = listing.split("\n");
    expect(rows[0]).toBe("moveloop:");
    expect(rows[2].startsWith("=>")).toBe(true);
    expect(rows[1]).toMatch(/gencop\.s:\d+/);
  });
});

describe("formatInstruction", () => {
  it("formats one instruction from its stored hex bytes, as profile_dump's listing does", () => {
    // The capture stores bytes as space-separated hex pairs.
    expect(formatInstruction("22 39 00 df f0 04", 0xc022ae)).toBe("move.l $dff004,d1  ; VPOSR");
    expect(formatInstruction("66 f2", 0xc022ba, (a) => (a === 0xc022ae ? "WaitRaster" : undefined))).toBe("bne.b $c022ae  ; WaitRaster");
    expect(formatInstruction("4e 75", 0x1000)).toBe("rts");
  });
});
