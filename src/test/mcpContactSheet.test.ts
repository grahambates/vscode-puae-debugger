// Tests for the MCP contact sheet — pure RGBA layout, no emulator.

import { composeSheet, SheetTile } from "../mcp/contactSheet";

// A w x h tile whose pixel (x, y) is (x, y, frame, 255), so sampling can be checked exactly.
function tile(frame: number, w = 8, h = 6, repeated = false): SheetTile {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set([x, y, frame, 255], (y * w + x) * 4);
  return { rgba, width: w, height: h, frame, repeated };
}

const pixel = (s: { rgba: Uint8Array; width: number }, x: number, y: number) =>
  Array.from(s.rgba.subarray((y * s.width + x) * 4, (y * s.width + x) * 4 + 4));

describe("composeSheet", () => {
  // Layout constants: 4px gaps, a 14px header above each tile.
  it("lays tiles out in rows of `columns`, with a header above each", () => {
    const sheet = composeSheet([tile(1), tile(2), tile(3)], { half: false, columns: 2 });
    expect(sheet.width).toBe(4 + 2 * (8 + 4));
    expect(sheet.height).toBe(4 + 2 * (14 + 6 + 4));
    // Tile 2's top-left pixel sits right of tile 1, below its header.
    expect(pixel(sheet, 4 + 12, 4 + 14)).toEqual([0, 0, 2, 255]);
    // Tile 3 wraps to the second row.
    expect(pixel(sheet, 4, 4 + 24 + 14)).toEqual([0, 0, 3, 255]);
  });

  it("halves by point-sampling, never blending colours", () => {
    const sheet = composeSheet([tile(1)], { half: true, columns: 4 });
    expect(sheet.width).toBe(4 + 4 + 4);
    // Half-size pixel (1, 2) is source pixel (2, 4), exactly.
    expect(pixel(sheet, 4 + 1, 4 + 14 + 2)).toEqual([2, 4, 1, 255]);
  });

  it("draws the frame number, and the repeat marker only on a repeated frame", () => {
    const labelPixels = (s: { rgba: Uint8Array; width: number }, rgb: number[]) => {
      let n = 0;
      for (let y = 4; y < 4 + 14; y++) for (let x = 4; x < s.width; x++) if (pixel(s, x, y).slice(0, 3).join() === rgb.join()) n++;
      return n;
    };
    const plain = composeSheet([tile(7, 64, 6)], { half: false, columns: 1 });
    const repeated = composeSheet([tile(7, 64, 6, true)], { half: false, columns: 1 });
    expect(labelPixels(plain, [255, 255, 255])).toBeGreaterThan(0); // the "7"
    expect(labelPixels(plain, [0xff, 0xd0, 0x40])).toBe(0);
    expect(labelPixels(repeated, [0xff, 0xd0, 0x40])).toBeGreaterThan(0); // the "="
  });

  it("refuses frames of different sizes rather than misaligning them", () => {
    expect(() => composeSheet([tile(1), tile(2, 10, 6)], { half: false, columns: 2 })).toThrow(/not 8x6/);
    expect(() => composeSheet([], { half: false, columns: 2 })).toThrow(/No frames/);
  });
});
