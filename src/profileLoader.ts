// Loads a .puaeprofile into FrameCapture[] — the file-side counterpart of a live capture.
// Reconstructs the exact SourceMap the capture used (from the embedded ELF + the manifest's
// relocation), then runs the same buildFramesFromCaptures as ProfilerManager.capture() does for
// its live multi-frame path. Pure (no vscode/fs): the CustomEditor provider passes in the file
// bytes, and the replay tests call it directly.

import { parseDwarf } from "./dwarfParser";
import { parseHunks } from "./amigaHunkParser";
import { sourceMapFromDwarf } from "./dwarfSourceMap";
import { sourceMapFromHunks } from "./amigaHunkSourceMap";
import { SourceMap } from "./sourceMap";
import { kickstartSymbolModuleBySha1 } from "./kickstart";
import { decodeCapture, ProfileManifest } from "./profileFormat";
import { buildFramesFromCaptures, FrameCapture, InstructionSample } from "./profilerManager";

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

// Returns every captured frame (one-element array for a single-frame capture, matching a live
// capture's own return shape) — frames[0].combined carries the all-frames-combined model when
// there's more than one, exactly as ProfilerManager.capture() attaches it. frameSamples[i]
// (parallel to frames[i]) + sourceMap let the caller resolve "computeRange" sub-selections the
// same way a live capture session does (see profilerManager.buildFrameRangeModel).
export function loadProfile(file: Uint8Array): { frames: FrameCapture[]; frameSamples: InstructionSample[][]; sourceMap: SourceMap; manifest: ProfileManifest } {
  const { raws, elf, manifest } = decodeCapture(file);
  if (!elf) {
    // The path+sha1 fallback (load the ELF from disk) is a future addition for the UI.
    throw new Error("This .puaeprofile has no embedded program; loading by path isn't supported yet.");
  }
  const sourceMap = buildSourceMapFromBundle(elf, manifest);
  const { frames, frameSamples } = buildFramesFromCaptures(raws, sourceMap);
  return { frames, frameSamples, sourceMap, manifest };
}
