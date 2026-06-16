// Loads a .vamigaprofile into an IProfileModel — the file-side counterpart of a live
// capture. Reconstructs the exact SourceMap the capture used (from the embedded ELF +
// the manifest's relocation), then runs the same buildModelFromCapture as live capture.
// Pure (no vscode/fs): the CustomEditor provider passes in the file bytes, and the replay
// tests call it directly.

import { parseDwarf } from "./dwarfParser";
import { parseHunks } from "./amigaHunkParser";
import { sourceMapFromDwarf } from "./dwarfSourceMap";
import { sourceMapFromHunks } from "./amigaHunkSourceMap";
import { SourceMap } from "./sourceMap";
import { kickstartSymbolModuleBySha1 } from "./kickstart";
import { decodeCapture, ProfileManifest } from "./vamigaProfile";
import { buildModelFromCapture, RawCapture } from "./profilerManager";
import { IProfileModel } from "./shared/profilerTypes";

const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46]; // \x7fELF

// Rebuild the SourceMap from the embedded program + relocation. Uses the same inputs the
// debug adapter fed to sourceMapFromDwarf/Hunks at capture time, so the absolute captured
// PCs symbolicate identically. Kickstart ROM symbols are re-merged from the manifest's ROM sha1
// (rebuilt by kickstartSymbolModuleBySha1, no ROM bytes needed) so ROM/OS leaves symbolicate as
// [Kick] <name> just like the live view; an empty/unknown sha1 leaves them as flat [Kickstart].
export function buildSourceMapFromBundle(program: Uint8Array, manifest: ProfileManifest): SourceMap {
  const { segmentOffsets, baseDir } = manifest.relocation;
  const buf = Buffer.from(program.buffer, program.byteOffset, program.byteLength);
  const isElf = program.length >= 4 && ELF_MAGIC.every((b, i) => program[i] === b);
  const sourceMap = isElf
    ? sourceMapFromDwarf(parseDwarf(buf), segmentOffsets, baseDir)
    : sourceMapFromHunks(parseHunks(buf), segmentOffsets);

  const kick = kickstartSymbolModuleBySha1(manifest.kickstart.sha1);
  if (kick) {
    sourceMap.addSymbolModule(kick.segment, kick.symbols);
  }
  return sourceMap;
}

export function loadProfile(file: Uint8Array): { model: IProfileModel; raw: RawCapture; manifest: ProfileManifest } {
  const { raw, elf, manifest } = decodeCapture(file);
  if (!elf) {
    // The path+sha1 fallback (load the ELF from disk) is a future addition for the UI.
    throw new Error("This .vamigaprofile has no embedded program; loading by path isn't supported yet.");
  }
  const sourceMap = buildSourceMapFromBundle(elf, manifest);
  const { model } = buildModelFromCapture(raw, sourceMap);
  return { model, raw, manifest };
}
