// .puaeprofile container codec (extension-side; Node zlib/crypto/Buffer only — never
// imported by the webview). A profile document is the gzip of a small binary container:
//
//   [ magic "PUAEPROF1" ][ u32 LE manifestLen ][ manifest: JSON utf8 ][ section bytes… ]
//
// The manifest indexes the raw binary sections (offsets relative to the section blob). This
// stores the *raw* capture (RawCapture[], one per frame) plus the program ELF, not the built
// model — so it's compact (binary, gzip), and re-symbolicates on load via buildModelFromCapture,
// picking up any later symbolication improvements. One document serves save/load, the dev
// fixture, and the replay tests. See the design notes for the rationale (raw-not-model,
// embed-the-ELF).
//
// Stores every captured frame (section names prefixed "f0:", "f1:", ...) so a multi-frame
// capture's Save button round-trips the whole filmstrip, not just frame 0.

import { gzipSync, gunzipSync } from "zlib";
import { createHash } from "crypto";
import type { RawCapture, RawDisassembledFunction } from "./profilerManager";

const MAGIC = "PUAEPROF1";
const FORMAT_VERSION = 1;

export interface ProfileManifest {
  version: number;
  program: {
    name?: string;
    elfSha1?: string; // sha1 of the embedded (or referenced) ELF, for the load-time fallback
    elfEmbedded: boolean;
  };
  // Shared across every frame in the capture — a live multi-frame capture fetches these once
  // (getProfileData) and copies them onto every frame's RawCapture.profile, so there's nothing
  // frame-specific to store here even in a multi-frame document.
  meta: {
    capturedAt?: number; // ms since epoch (stamped by the caller; clock isn't available here)
    frameCycles: number; // 0 = emulator didn't report one
    isPAL: boolean;
    start: number;
    end: number;
    total: number;
    inRange: number;
  };
  // How the program was relocated at capture time, so the loader rebuilds an identical
  // SourceMap (captured PCs are absolute — symbolication must use the same addresses).
  // segmentOffsets are the loaded segment base addresses; baseDir resolves ELF source paths.
  // Always present (empty segmentOffsets/baseDir == the -Ttext=0 / no-relocation case).
  relocation: { segmentOffsets: number[]; baseDir: string };
  // Kickstart ROM identity at capture time, so the loader can re-merge the `.kick` symbol module
  // (via kickstartSymbolModuleBySha1) and symbolicate ROM/OS leaves as [Kick] <name> — matching the
  // live view. Always present; the empty sentinel { sha1: "", name: "" } means "no ROM symbols"
  // (unknown/unset ROM), which the loader treats as a flat [Kickstart] fallback.
  kickstart: { sha1: string; name: string };
  sections: { name: string; offset: number; length: number }[];
  // Disassembly text/bytes/stats for every function that executed — stored directly in the
  // manifest (JSON, not a binary section) since it's naturally structured data, not a flat
  // buffer, and the whole container is gzipped anyway. Re-symbolicated (file/line) on load via
  // attachDisassembly, same as every other RawCapture field. Absent in pre-disassembly documents.
  // Frame 0's only, like a live capture — later frames reweight it (see buildFramesFromCaptures).
  disassembly?: RawDisassembledFunction[];
  // Number of captured frames.
  frameCount: number;
  // Per-frame metadata too small to warrant its own binary section, parallel to frameCount.
  // Thumbnail/full-frame JPEG byte lengths already live in `sections`, but width/height aren't
  // recoverable from a JPEG's length alone. duplicateOfPrevious mirrors RawCapture's field of the
  // same name (see its comment) — round-tripped here since it's plain per-frame boolean data,
  // not something re-derivable from the other sections on load.
  frameMeta: { thumbWidth?: number; thumbHeight?: number; fullWidth?: number; fullHeight?: number; duplicateOfPrevious?: boolean }[];
}

export interface DecodedCapture {
  raws: RawCapture[]; // one per captured frame, in capture order
  elf?: Uint8Array; // present iff the document embedded the ELF
  manifest: ProfileManifest;
}

export interface EncodeOptions {
  elf?: Uint8Array; // embed the program ELF (default for self-contained documents)
  programName?: string;
  capturedAt?: number; // ms since epoch; pass Date.now() at the call site
  segmentOffsets?: number[]; // loaded segment base addresses (relocation)
  baseDir?: string; // base directory for resolving ELF source paths
  kickstart?: { sha1: string; name: string }; // ROM identity for re-symbolicating ROM/OS leaves
}

// View a Uint8Array as a Buffer over the same memory (no copy) for concatenation.
function asBuffer(a: Uint8Array): Buffer {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength);
}

// One frame's binary sections, named with `prefix` (e.g. "f3:") so every frame's sections coexist
// in the document's single flat section list without colliding.
function frameSections(raw: RawCapture, prefix: string): { name: string; bytes: Uint8Array }[] {
  const sections: { name: string; bytes: Uint8Array }[] = [{ name: `${prefix}profile`, bytes: raw.profile.data }];
  if (raw.dma) sections.push({ name: `${prefix}dma`, bytes: raw.dma });
  if (raw.snapshot) {
    sections.push({ name: `${prefix}chip`, bytes: raw.snapshot.chip });
    sections.push({ name: `${prefix}slow`, bytes: raw.snapshot.slow });
    sections.push({ name: `${prefix}custom`, bytes: raw.snapshot.custom });
    if (raw.snapshot.agaColors) sections.push({ name: `${prefix}agaColors`, bytes: raw.snapshot.agaColors });
  }
  if (raw.copper) sections.push({ name: `${prefix}copper`, bytes: raw.copper });
  if (raw.dmaEvents) sections.push({ name: `${prefix}dmaEvents`, bytes: raw.dmaEvents });
  if (raw.registers) sections.push({ name: `${prefix}registers`, bytes: raw.registers });
  if (raw.thumbnail) sections.push({ name: `${prefix}thumbnail`, bytes: raw.thumbnail.data });
  if (raw.fullFrame) sections.push({ name: `${prefix}fullFrame`, bytes: raw.fullFrame.data });
  return sections;
}

export function encodeCapture(raws: RawCapture[], opts: EncodeOptions = {}): Buffer {
  if (raws.length === 0) throw new Error("encodeCapture: at least one frame is required");

  const sections: { name: string; bytes: Uint8Array }[] = [];
  const frameMeta: ProfileManifest["frameMeta"] = [];
  raws.forEach((raw, i) => {
    sections.push(...frameSections(raw, `f${i}:`));
    frameMeta.push({
      thumbWidth: raw.thumbnail?.width,
      thumbHeight: raw.thumbnail?.height,
      fullWidth: raw.fullFrame?.width,
      fullHeight: raw.fullFrame?.height,
      duplicateOfPrevious: raw.duplicateOfPrevious,
    });
  });
  if (opts.elf) sections.push({ name: "elf", bytes: opts.elf });

  let offset = 0;
  const index = sections.map((s) => {
    const entry = { name: s.name, offset, length: s.bytes.length };
    offset += s.bytes.length;
    return entry;
  });

  const first = raws[0];
  const manifest: ProfileManifest = {
    version: FORMAT_VERSION,
    program: {
      name: opts.programName,
      elfSha1: opts.elf ? createHash("sha1").update(opts.elf).digest("hex") : undefined,
      elfEmbedded: !!opts.elf,
    },
    meta: {
      capturedAt: opts.capturedAt,
      frameCycles: first.profile.frameCycles,
      isPAL: first.profile.isPAL,
      start: first.profile.start,
      end: first.profile.end,
      total: first.profile.total,
      inRange: first.profile.inRange,
    },
    relocation: { segmentOffsets: opts.segmentOffsets ?? [], baseDir: opts.baseDir ?? "" },
    kickstart: opts.kickstart ?? { sha1: "", name: "" },
    sections: index,
    disassembly: first.disassembly,
    frameCount: raws.length,
    frameMeta,
  };

  const manifestJson = Buffer.from(JSON.stringify(manifest), "utf8");
  const header = Buffer.alloc(MAGIC.length + 4);
  header.write(MAGIC, 0, "ascii");
  header.writeUInt32LE(manifestJson.length, MAGIC.length);

  const container = Buffer.concat([header, manifestJson, ...sections.map((s) => asBuffer(s.bytes))]);
  return gzipSync(container);
}

// A .puaeprofile file is loaded from disk -- possibly one a user didn't create themselves.
// gzip's compression ratio is effectively unbounded (a few KB can expand to gigabytes), so cap
// the decompressed size before any of the manifest/section bounds checks below get a chance to
// run. Generous relative to any real capture (chip RAM tops out at 2MB, slow RAM ~1.8MB, plus a
// DMA grid/copper trace/disassembly manifest that's still comfortably under this per frame, times
// however many frames a multi-frame capture stores), but firmly blocks a crafted small file from
// exhausting memory.
const MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;

export function decodeCapture(file: Uint8Array): DecodedCapture {
  const container = gunzipSync(file, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
  const magic = container.toString("ascii", 0, MAGIC.length);
  if (magic !== MAGIC) throw new Error(`Not a .puaeprofile file (bad magic ${JSON.stringify(magic)})`);

  const manifestLen = container.readUInt32LE(MAGIC.length);
  const manifestStart = MAGIC.length + 4;
  // Bounds-check before slicing: a truncated/corrupt file must fail with a clear message
  // rather than an out-of-range read or a giant allocation.
  if (manifestStart + manifestLen > container.length) {
    throw new Error(`.puaeprofile manifest length ${manifestLen} exceeds container (${container.length} bytes)`);
  }
  const manifest = JSON.parse(container.toString("utf8", manifestStart, manifestStart + manifestLen)) as ProfileManifest;
  if (manifest.version !== FORMAT_VERSION) {
    throw new Error(`Unsupported .puaeprofile version ${manifest.version} (expected ${FORMAT_VERSION})`);
  }
  const blobStart = manifestStart + manifestLen;

  // Copy each section into its own ArrayBuffer (byteOffset 0) so downstream typed-array
  // views — e.g. Uint32Array over the profile stream — are correctly aligned.
  const get = (name: string): Uint8Array | undefined => {
    const s = manifest.sections.find((x) => x.name === name);
    if (!s) return undefined;
    const start = blobStart + s.offset;
    if (s.offset < 0 || s.length < 0 || start + s.length > container.length) {
      throw new Error(`.puaeprofile section '${name}' is out of bounds (offset ${s.offset}, length ${s.length}, container ${container.length})`);
    }
    return new Uint8Array(container.subarray(start, start + s.length));
  };

  const raws: RawCapture[] = [];
  for (let i = 0; i < manifest.frameCount; i++) {
    const prefix = `f${i}:`;
    const profile = get(`${prefix}profile`);
    if (!profile) throw new Error(`.puaeprofile is missing the required '${prefix}profile' section`);
    const chip = get(`${prefix}chip`);
    const slow = get(`${prefix}slow`);
    const fm = manifest.frameMeta[i];
    const thumbBytes = get(`${prefix}thumbnail`);
    const fullBytes = get(`${prefix}fullFrame`);

    raws.push({
      profile: {
        data: profile,
        start: manifest.meta.start,
        end: manifest.meta.end,
        total: manifest.meta.total,
        inRange: manifest.meta.inRange,
        frameCycles: manifest.meta.frameCycles,
        isPAL: manifest.meta.isPAL,
      },
      dma: get(`${prefix}dma`),
      // `custom` (the custom-register baseline) may be absent in pre-baseline documents;
      // decodeCustomRegs() tolerates an empty array, so default it rather than dropping the snapshot.
      snapshot: chip && slow ? { chip, slow, custom: get(`${prefix}custom`) ?? new Uint8Array(0), agaColors: get(`${prefix}agaColors`) } : undefined,
      copper: get(`${prefix}copper`), // absent in pre-copper-trace documents
      dmaEvents: get(`${prefix}dmaEvents`), // absent in pre-events documents
      // Only frame 0 ever carries real disassembly (see ProfileManifest.disassembly's comment) —
      // buildFramesFromCaptures reweights it onto frames 1..N-1 the same way a live capture does.
      disassembly: i === 0 ? manifest.disassembly : undefined,
      registers: get(`${prefix}registers`), // absent in pre-register-trace documents, or frames 1..N-1
      thumbnail: thumbBytes && fm?.thumbWidth && fm?.thumbHeight
        ? { data: thumbBytes, width: fm.thumbWidth, height: fm.thumbHeight }
        : undefined,
      fullFrame: fullBytes && fm?.fullWidth && fm?.fullHeight
        ? { data: fullBytes, width: fm.fullWidth, height: fm.fullHeight }
        : undefined,
      duplicateOfPrevious: fm?.duplicateOfPrevious,
    });
  }

  return { raws, elf: get("elf"), manifest };
}
