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
import { decodeCapture, ProfileManifest } from "./vamigaProfile";
import { buildModelFromCapture } from "./profilerManager";
import { IProfileModel } from "./shared/profilerTypes";

const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46]; // \x7fELF

// Rebuild the SourceMap from the embedded program + relocation. Uses the same inputs the
// debug adapter fed to sourceMapFromDwarf/Hunks at capture time, so the absolute captured
// PCs symbolicate identically. (Kickstart ROM symbols are not re-merged here — the ROM
// isn't in the bundle; ROM/OS addresses stay unsymbolicated on file load for now.)
export function buildSourceMapFromBundle(program: Uint8Array, manifest: ProfileManifest): SourceMap {
  const { segmentOffsets, baseDir } = manifest.relocation;
  const buf = Buffer.from(program.buffer, program.byteOffset, program.byteLength);
  const isElf = program.length >= 4 && ELF_MAGIC.every((b, i) => program[i] === b);
  if (isElf) {
    return sourceMapFromDwarf(parseDwarf(buf), segmentOffsets, baseDir);
  }
  return sourceMapFromHunks(parseHunks(buf), segmentOffsets);
}

export function loadProfile(file: Uint8Array): { model: IProfileModel; manifest: ProfileManifest } {
  const { raw, elf, manifest } = decodeCapture(file);
  if (!elf) {
    // The path+sha1 fallback (load the ELF from disk) is a future addition for the UI.
    throw new Error("This .vamigaprofile has no embedded program; loading by path isn't supported yet.");
  }
  const sourceMap = buildSourceMapFromBundle(elf, manifest);
  const { model } = buildModelFromCapture(raw, sourceMap);
  return { model, manifest };
}
