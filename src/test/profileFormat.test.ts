import { gzipSync } from "zlib";
import { encodeCapture, decodeCapture } from "../profileFormat";
import type { RawCapture } from "../profilerManager";

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
    const { raws: [out], elf: outElf, manifest } = decodeCapture(
      encodeCapture([raw], {
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

    expect(manifest.version).toBe(1);
    expect(manifest.frameCount).toBe(1);
    expect(manifest.program.name).toBe("a.elf");
    expect(manifest.program.elfEmbedded).toBe(true);
    expect(manifest.program.elfSha1).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.meta.capturedAt).toBe(1234);
    expect(manifest.kickstart).toEqual({ sha1: "891e9a547772fe0c6c19b610baf8bc4ea7fcb785", name: "Kickstart v1.3" });
  });

  it("round-trips a profile-only capture (no DMA, no ELF)", () => {
    const raw = sampleRaw(false);
    const { raws: [out], elf, manifest } = decodeCapture(encodeCapture([raw]));
    eq(out.profile.data, raw.profile.data);
    expect(out.dma).toBeUndefined();
    expect(out.snapshot).toBeUndefined();
    expect(out.copper).toBeUndefined();
    expect(elf).toBeUndefined();
    expect(manifest.program.elfEmbedded).toBe(false);
    // kickstart omitted at encode → written as the empty sentinel, never undefined.
    expect(manifest.kickstart).toEqual({ sha1: "", name: "" });
  });

  it("round-trips raw.snapshot.agaColors", () => {
    const raw = sampleRaw(true);
    raw.snapshot!.agaColors = new Uint8Array([0x11, 0x22, 0x33, 0x44]);
    const { raws: [out] } = decodeCapture(encodeCapture([raw]));
    eq(out.snapshot!.agaColors, raw.snapshot!.agaColors);
  });

  it("yields fresh, 4-byte-alignable profile bytes (Uint32Array view works)", () => {
    const { raws: [raw] } = decodeCapture(encodeCapture([sampleRaw(false)]));
    expect(raw.profile.data.byteOffset).toBe(0);
    expect(() => new Uint32Array(raw.profile.data.buffer, 0, raw.profile.data.byteLength >>> 2)).not.toThrow();
  });

  it("throws on a non-puaeprofile payload", () => {
    expect(() => decodeCapture(gzipSync(Buffer.from("not a profile")))).toThrow(/bad magic/);
  });

  it("throws encoding zero frames", () => {
    expect(() => encodeCapture([])).toThrow(/at least one frame/);
  });
});

describe("profileFormat codec: multi-frame captures", () => {
  it("round-trips every frame independently — no cross-contamination between frames", () => {
    const raw0: RawCapture = {
      ...sampleRaw(true),
      disassembly: [
        { address: 0x1000, end: 0x1002, name: "foo", totalCycles: 4, instructions: [{ address: 0x1000, hex: "4e71", text: "nop", length: 2, hits: 1, cycles: 4 }] },
      ],
      thumbnail: { data: new Uint8Array([1, 2, 3]), width: 4, height: 5 },
      fullFrame: { data: new Uint8Array([9, 9]), width: 10, height: 20 },
    };
    const raw1: RawCapture = {
      profile: {
        data: new Uint8Array([2, 0, 0, 0, 0x99, 0x99, 0x99, 0x99, 4, 0, 0, 0]),
        start: 0x1000, end: 0x2000, total: 1234, inRange: 1000, frameCycles: 226_000, isPAL: true,
      },
      dma: new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]),
      thumbnail: { data: new Uint8Array([4, 5, 6]), width: 4, height: 5 },
      duplicateOfPrevious: true,
    };

    const { raws, manifest } = decodeCapture(encodeCapture([raw0, raw1]));

    expect(manifest.version).toBe(1);
    expect(manifest.frameCount).toBe(2);
    expect(raws).toHaveLength(2);

    eq(raws[0].profile.data, raw0.profile.data);
    eq(raws[1].profile.data, raw1.profile.data);
    eq(raws[0].dma, raw0.dma);
    eq(raws[1].dma, raw1.dma);
    expect(Array.from(raws[0].dma!)).not.toEqual(Array.from(raws[1].dma!));

    // Only frame 0 persists real disassembly — later frames reweight it on load
    // (see profilerManager.buildFramesFromCaptures), matching a live capture exactly.
    expect(raws[0].disassembly).toEqual(raw0.disassembly);
    expect(raws[1].disassembly).toBeUndefined();

    eq(raws[0].thumbnail!.data, raw0.thumbnail!.data);
    expect(raws[0].thumbnail!.width).toBe(4);
    expect(raws[0].thumbnail!.height).toBe(5);
    eq(raws[1].thumbnail!.data, raw1.thumbnail!.data);

    eq(raws[0].fullFrame!.data, raw0.fullFrame!.data);
    expect(raws[1].fullFrame).toBeUndefined(); // frame 1 never had one

    // duplicateOfPrevious round-trips per frame — this is the actual bug report: it must survive
    // save/load, not just live capture (it lives on RawCapture specifically so it does, for free).
    expect(raws[0].duplicateOfPrevious).toBeFalsy();
    expect(raws[1].duplicateOfPrevious).toBe(true);

    // meta is shared across every frame — matches how a live multi-frame capture actually
    // populates it (one getProfileData fetch, copied onto every frame's raw.profile).
    expect(manifest.meta.start).toBe(raw0.profile.start);
    expect(manifest.meta.frameCycles).toBe(raw0.profile.frameCycles);
  });
});
