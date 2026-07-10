import { gzipSync, gunzipSync } from "zlib";
import { encodeCapture, decodeCapture } from "../profileFormat";
import type { RawCapture } from "../profilerManager";

// Rebuild a container with the `kickstart` manifest field removed, simulating a legacy
// (pre-kickstart-field) .puaeprofile so we can assert decode normalizes it to the sentinel.
function stripKickstart(file: Buffer): Buffer {
  const MAGIC = "PUAEPROF1";
  const c = gunzipSync(file);
  const manifestLen = c.readUInt32LE(MAGIC.length);
  const start = MAGIC.length + 4;
  const manifest = JSON.parse(c.toString("utf8", start, start + manifestLen));
  delete manifest.kickstart;
  const blob = c.subarray(start + manifestLen);
  const json = Buffer.from(JSON.stringify(manifest), "utf8");
  const header = Buffer.alloc(MAGIC.length + 4);
  header.write(MAGIC, 0, "ascii");
  header.writeUInt32LE(json.length, MAGIC.length);
  return gzipSync(Buffer.concat([header, json, blob]));
}

function sampleRaw(withDma: boolean): RawCapture {
  const raw: RawCapture = {
    profile: {
      data: new Uint8Array([1, 0, 0, 0, 0x10, 0x20, 0x30, 0x40, 4, 0, 0, 0]),
      start: 0x1000,
      end: 0x2000,
      total: 1234,
      inRange: 1000,
      frameCycles: 226_000,
      isPAL: true,
    },
  };
  if (withDma) {
    raw.dma = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    raw.snapshot = {
      chip: new Uint8Array([0xaa, 0xbb, 0xcc]),
      slow: new Uint8Array([]),
      custom: new Uint8Array([0x96, 0x03, 0x80, 0x7f]), // DMACONR=0x0396, ... (LE u16 pairs)
    };
    raw.copper = new Uint8Array([0x00, 0x10, 0x00, 0x00, 0x96, 0x00, 0x00, 0x82, 0x0a, 0x00, 0x05, 0x00]); // one 12-byte record
  }
  return raw;
}

const eq = (a: Uint8Array | undefined, b: Uint8Array | undefined) =>
  expect(a ? Array.from(a) : a).toEqual(b ? Array.from(b) : b);

describe("profileFormat codec", () => {
  it("round-trips a full capture (DMA + snapshot + embedded ELF)", () => {
    const raw = sampleRaw(true);
    const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4]);
    const { raw: out, elf: outElf, manifest } = decodeCapture(
      encodeCapture(raw, {
        elf,
        programName: "a.elf",
        capturedAt: 1234,
        kickstart: { sha1: "891e9a547772fe0c6c19b610baf8bc4ea7fcb785", name: "Kickstart v1.3" },
      }),
    );

    eq(out.profile.data, raw.profile.data);
    expect(out.profile.start).toBe(raw.profile.start);
    expect(out.profile.end).toBe(raw.profile.end);
    expect(out.profile.total).toBe(raw.profile.total);
    expect(out.profile.inRange).toBe(raw.profile.inRange);
    expect(out.profile.frameCycles).toBe(raw.profile.frameCycles);
    expect(out.profile.isPAL).toBe(true);
    eq(out.dma, raw.dma);
    eq(out.snapshot!.chip, raw.snapshot!.chip);
    eq(out.snapshot!.slow, raw.snapshot!.slow);
    eq(out.snapshot!.custom, raw.snapshot!.custom);
    eq(out.copper, raw.copper);
    eq(outElf, elf);

    expect(manifest.program.name).toBe("a.elf");
    expect(manifest.program.elfEmbedded).toBe(true);
    expect(manifest.program.elfSha1).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.meta.capturedAt).toBe(1234);
    expect(manifest.kickstart).toEqual({ sha1: "891e9a547772fe0c6c19b610baf8bc4ea7fcb785", name: "Kickstart v1.3" });
  });

  it("round-trips a profile-only capture (no DMA, no ELF)", () => {
    const raw = sampleRaw(false);
    const { raw: out, elf, manifest } = decodeCapture(encodeCapture(raw));
    eq(out.profile.data, raw.profile.data);
    expect(out.dma).toBeUndefined();
    expect(out.snapshot).toBeUndefined();
    expect(out.copper).toBeUndefined();
    expect(elf).toBeUndefined();
    expect(manifest.program.elfEmbedded).toBe(false);
    // kickstart omitted at encode → written as the empty sentinel, never undefined.
    expect(manifest.kickstart).toEqual({ sha1: "", name: "" });
  });

  it("normalizes a legacy file with no kickstart field to the empty sentinel", () => {
    const legacy = stripKickstart(encodeCapture(sampleRaw(false)));
    const { manifest } = decodeCapture(legacy);
    expect(manifest.kickstart).toEqual({ sha1: "", name: "" });
  });

  it("yields fresh, 4-byte-alignable profile bytes (Uint32Array view works)", () => {
    const { raw } = decodeCapture(encodeCapture(sampleRaw(false)));
    expect(raw.profile.data.byteOffset).toBe(0);
    expect(() => new Uint32Array(raw.profile.data.buffer, 0, raw.profile.data.byteLength >>> 2)).not.toThrow();
  });

  it("throws on a non-puaeprofile payload", () => {
    expect(() => decodeCapture(gzipSync(Buffer.from("not a profile")))).toThrow(/bad magic/);
  });
});
