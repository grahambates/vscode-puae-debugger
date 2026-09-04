// Minimal PNG encoder for the emulator's RGBA framebuffer.
//
// Hand-rolled for the same reason the MCP transport is: the whole job is one IHDR/IDAT/IEND
// sequence over zlib, which Node already provides, versus adding an image library to a package
// that currently has no image dependency at all. There is no decoder here and no format
// negotiation — one caller, one pixel layout, one output.
//
// The framebuffer arrives as RGBA8888 (frontend_shim.c's `wasm_get_fb_rgba`, the same buffer the
// browser hands to putImageData), which is exactly PNG colour type 6, so the pixels pass through
// untouched: the only work is prefixing each row with its filter byte.

import { createHash } from "crypto";
import { deflateSync } from "zlib";

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

// Standard PNG/zlib CRC-32, table built once on first use.
let crcTable: Uint32Array | undefined;
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Encodes `width` x `height` RGBA8888 pixels as a PNG. `rgba` must hold exactly width*height*4
 * bytes; anything else is a caller bug rather than something to paper over, since a short buffer
 * would silently produce a corrupt image.
 */
export function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  if (width <= 0 || height <= 0) throw new Error(`encodePng: invalid size ${width}x${height}`);
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(`encodePng: expected ${expected} bytes for ${width}x${height}, got ${rgba.length}`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha (RGBA)
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // One filter byte (0 = None) per row, then that row's pixels. Filtering exists to help the
  // compressor find patterns; None keeps this a straight copy, and emulator output compresses
  // well regardless since large areas repeat exactly.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** SHA-1 of the encoded bytes — used by the tests to assert two renders are identical. */
export function pngDigest(png: Buffer): string {
  return createHash("sha1").update(png).digest("hex");
}
