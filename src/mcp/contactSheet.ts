// A contact sheet: several emulated frames laid out on one PNG, each labelled with its frame
// number — how a model, which reads still images and not video, gets to see an animation or a
// glitch that lasts a single frame.
//
// Pure (RGBA in, RGBA out) so the layout can be tested without an emulator; the session supplies
// the frames and png.ts encodes the result.

export interface SheetTile {
  rgba: Uint8Array;
  width: number;
  height: number;
  /** Frame number shown in the tile's header. */
  frame: number;
  /** The picture is byte-identical to the frame before it — marked, as the profiler's "=" badge. */
  repeated: boolean;
}

export interface SheetOptions {
  /**
   * Halve each tile (point-sampled). The 720x574 framebuffer is a lores screen with each pixel
   * doubled horizontally, on 287 non-interlaced lines, so half size keeps every lores pixel and
   * line; hires or interlaced screens lose detail and want full size.
   */
  half: boolean;
  /** Tiles per row. */
  columns: number;
}

// 3x5 glyphs, one row per string, '#' set. Only what a label needs: digits, and "=" for repeats.
const GLYPHS: Record<string, string[]> = {
  "0": ["###", "#.#", "#.#", "#.#", "###"],
  "1": [".#.", "##.", ".#.", ".#.", "###"],
  "2": ["###", "..#", "###", "#..", "###"],
  "3": ["###", "..#", ".##", "..#", "###"],
  "4": ["#.#", "#.#", "###", "..#", "..#"],
  "5": ["###", "#..", "###", "..#", "###"],
  "6": ["###", "#..", "###", "#.#", "###"],
  "7": ["###", "..#", ".#.", ".#.", ".#."],
  "8": ["###", "#.#", "###", "#.#", "###"],
  "9": ["###", "#.#", "###", "..#", "###"],
  "=": ["...", "###", "...", "###", "..."],
};
const GLYPH_SCALE = 2; // 6x10 pixels per character
const HEADER = 14;
const GAP = 4;
const BACKGROUND = [0x20, 0x20, 0x20];
const LABEL = [0xff, 0xff, 0xff];
const REPEAT = [0xff, 0xd0, 0x40];

export function composeSheet(tiles: SheetTile[], options: SheetOptions): { rgba: Uint8Array; width: number; height: number } {
  if (tiles.length === 0) throw new Error("No frames to lay out");
  const div = options.half ? 2 : 1;
  const tileW = Math.floor(tiles[0].width / div);
  const tileH = Math.floor(tiles[0].height / div);
  const columns = Math.max(1, Math.min(options.columns, tiles.length));
  const rows = Math.ceil(tiles.length / columns);
  const width = GAP + columns * (tileW + GAP);
  const height = GAP + rows * (HEADER + tileH + GAP);
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    out.set(BACKGROUND, i * 4);
    out[i * 4 + 3] = 0xff;
  }

  const plot = (x: number, y: number, rgb: number[]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    out.set(rgb, (y * width + x) * 4);
  };
  const text = (s: string, x: number, y: number, rgb: number[]) => {
    for (const ch of s) {
      const glyph = GLYPHS[ch];
      if (glyph) {
        glyph.forEach((row, gy) => [...row].forEach((cell, gx) => {
          if (cell !== "#") return;
          for (let dy = 0; dy < GLYPH_SCALE; dy++) {
            for (let dx = 0; dx < GLYPH_SCALE; dx++) plot(x + gx * GLYPH_SCALE + dx, y + gy * GLYPH_SCALE + dy, rgb);
          }
        }));
      }
      x += 4 * GLYPH_SCALE;
    }
  };

  tiles.forEach((tile, i) => {
    if (tile.width !== tiles[0].width || tile.height !== tiles[0].height) {
      throw new Error(`Frame ${tile.frame} is ${tile.width}x${tile.height}, not ${tiles[0].width}x${tiles[0].height} like the first`);
    }
    const left = GAP + (i % columns) * (tileW + GAP);
    const top = GAP + Math.floor(i / columns) * (HEADER + tileH + GAP);
    const label = String(tile.frame);
    text(label, left + 2, top + 2, LABEL);
    if (tile.repeated) text("=", left + 2 + (label.length + 1) * 4 * GLYPH_SCALE, top + 2, REPEAT);
    // Point-sampled: averaging would blend dithering and invent colours the palette never had.
    for (let y = 0; y < tileH; y++) {
      const src = y * div * tile.width * 4;
      const dst = ((top + HEADER + y) * width + left) * 4;
      for (let x = 0; x < tileW; x++) {
        const s = src + x * div * 4;
        out[dst + x * 4] = tile.rgba[s];
        out[dst + x * 4 + 1] = tile.rgba[s + 1];
        out[dst + x * 4 + 2] = tile.rgba[s + 2];
        out[dst + x * 4 + 3] = 0xff;
      }
    }
  });
  return { rgba: out, width, height };
}
