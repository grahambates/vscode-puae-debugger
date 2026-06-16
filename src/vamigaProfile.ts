// .vamigaprofile container codec (extension-side; Node zlib/crypto/Buffer only — never
// imported by the webview). A profile document is the gzip of a small binary container:
//
//   [ magic "VAMIGAPROF1" ][ u32 LE manifestLen ][ manifest: JSON utf8 ][ section bytes… ]
//
// The manifest indexes the raw binary sections (offsets relative to the section blob). This
// stores the *raw* capture (RawCapture) plus the program ELF, not the built model — so it's
// compact (binary, gzip), and re-symbolicates on load via buildModelFromCapture, picking up
// any later symbolication improvements. One document serves save/load, the dev fixture, and
// the replay tests. See the design notes for the rationale (raw-not-model, embed-the-ELF).

import { gzipSync, gunzipSync } from "zlib";
import { createHash } from "crypto";
import type { RawCapture } from "./profilerManager";

const MAGIC = "VAMIGAPROF1";
const FORMAT_VERSION = 1;

export interface ProfileManifest {
  version: number;
  program: {
    name?: string;
    elfSha1?: string; // sha1 of the embedded (or referenced) ELF, for the load-time fallback
    elfEmbedded: boolean;
  };
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
}

export interface DecodedCapture {
  raw: RawCapture;
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

export function encodeCapture(raw: RawCapture, opts: EncodeOptions = {}): Buffer {
  const sections: { name: string; bytes: Uint8Array }[] = [{ name: "profile", bytes: raw.profile.data }];
  if (raw.dma) sections.push({ name: "dma", bytes: raw.dma });
  if (raw.snapshot) {
    sections.push({ name: "chip", bytes: raw.snapshot.chip });
    sections.push({ name: "slow", bytes: raw.snapshot.slow });
    sections.push({ name: "custom", bytes: raw.snapshot.custom });
  }
  if (opts.elf) sections.push({ name: "elf", bytes: opts.elf });

  let offset = 0;
  const index = sections.map((s) => {
    const entry = { name: s.name, offset, length: s.bytes.length };
    offset += s.bytes.length;
    return entry;
  });

  const manifest: ProfileManifest = {
    version: FORMAT_VERSION,
    program: {
      name: opts.programName,
      elfSha1: opts.elf ? createHash("sha1").update(opts.elf).digest("hex") : undefined,
      elfEmbedded: !!opts.elf,
    },
    meta: {
      capturedAt: opts.capturedAt,
      frameCycles: raw.profile.frameCycles,
      isPAL: raw.profile.isPAL,
      start: raw.profile.start,
      end: raw.profile.end,
      total: raw.profile.total,
      inRange: raw.profile.inRange,
    },
    relocation: { segmentOffsets: opts.segmentOffsets ?? [], baseDir: opts.baseDir ?? "" },
    kickstart: opts.kickstart ?? { sha1: "", name: "" },
    sections: index,
  };

  const manifestJson = Buffer.from(JSON.stringify(manifest), "utf8");
  const header = Buffer.alloc(MAGIC.length + 4);
  header.write(MAGIC, 0, "ascii");
  header.writeUInt32LE(manifestJson.length, MAGIC.length);

  const container = Buffer.concat([header, manifestJson, ...sections.map((s) => asBuffer(s.bytes))]);
  return gzipSync(container);
}

export function decodeCapture(file: Uint8Array): DecodedCapture {
  const container = gunzipSync(file);
  const magic = container.toString("ascii", 0, MAGIC.length);
  if (magic !== MAGIC) throw new Error(`Not a .vamigaprofile file (bad magic ${JSON.stringify(magic)})`);

  const manifestLen = container.readUInt32LE(MAGIC.length);
  const manifestStart = MAGIC.length + 4;
  const manifest = JSON.parse(container.toString("utf8", manifestStart, manifestStart + manifestLen)) as ProfileManifest;
  if (manifest.version !== FORMAT_VERSION) {
    throw new Error(`Unsupported .vamigaprofile version ${manifest.version} (expected ${FORMAT_VERSION})`);
  }
  // Normalize legacy files (pre-kickstart-field) to the empty sentinel here, at the decode boundary,
  // so every consumer reads manifest.kickstart.sha1 without a guard.
  manifest.kickstart ??= { sha1: "", name: "" };
  const blobStart = manifestStart + manifestLen;

  // Copy each section into its own ArrayBuffer (byteOffset 0) so downstream typed-array
  // views — e.g. Uint32Array over the profile stream — are correctly aligned.
  const get = (name: string): Uint8Array | undefined => {
    const s = manifest.sections.find((x) => x.name === name);
    if (!s) return undefined;
    const start = blobStart + s.offset;
    return new Uint8Array(container.subarray(start, start + s.length));
  };

  const profile = get("profile");
  if (!profile) throw new Error(".vamigaprofile is missing the required 'profile' section");
  const chip = get("chip");
  const slow = get("slow");

  const raw: RawCapture = {
    profile: {
      data: profile,
      start: manifest.meta.start,
      end: manifest.meta.end,
      total: manifest.meta.total,
      inRange: manifest.meta.inRange,
      frameCycles: manifest.meta.frameCycles,
      isPAL: manifest.meta.isPAL,
    },
    dma: get("dma"),
    // `custom` (the custom-register baseline) may be absent in pre-baseline documents;
    // decodeCustomRegs() tolerates an empty array, so default it rather than dropping the snapshot.
    snapshot: chip && slow ? { chip, slow, custom: get("custom") ?? new Uint8Array(0) } : undefined,
  };
  return { raw, elf: get("elf"), manifest };
}
