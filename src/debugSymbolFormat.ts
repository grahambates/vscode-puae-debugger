/**
 * Detects the debug-symbol file's container format and, for ELF, which debug
 * format it carries — by content (magic bytes / section presence), never by
 * filename extension. Both vasm/vbcc and GCC can target either container
 * (ELF or Amiga Hunk) independently of which debug format they emit, so the
 * two axes are detected separately:
 *
 *   Hunk container -> "LINE" or GNU stabs, both inside HUNK_DEBUG blocks
 *                      (auto-detected per-block in amigaHunkParser.parseDebug;
 *                      DWARF cannot appear in a Hunk container).
 *   ELF  container -> DWARF (.debug_info/.debug_line) or GNU stabs
 *                      (.stab/.stabstr); "LINE" cannot appear in ELF.
 */

import { DWARFData } from "./dwarfParser";

export type ContainerFormat = "elf" | "hunk";

/** Amiga HUNK_HEADER block type (amigaHunkParser.ts BlockTypes.HEADER). */
const HUNK_HEADER = 0x000003f3;

/**
 * Sniff the container format from the file's magic bytes.
 * @throws if the buffer is neither a valid ELF file nor an Amiga hunk executable.
 */
export function detectContainer(buffer: Buffer): ContainerFormat {
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x7f &&
    buffer[1] === 0x45 && // 'E'
    buffer[2] === 0x4c && // 'L'
    buffer[3] === 0x46 // 'F'
  ) {
    return "elf";
  }
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === HUNK_HEADER) {
    return "hunk";
  }
  throw new Error(
    "Unrecognised debug symbol file: not an ELF file or an Amiga hunk executable",
  );
}

/** Does this (already section-parsed) ELF carry real DWARF debug info? */
export function hasDwarfSections(data: DWARFData): boolean {
  const info = data.sections.get(".debug_info");
  return !!info && info.size > 0;
}

/** Does this (already section-parsed) ELF carry GNU stabs debug info? */
export function hasElfStabsSections(data: DWARFData): boolean {
  const stab = data.sections.get(".stab");
  const stabstr = data.sections.get(".stabstr");
  return !!stab && stab.size > 0 && !!stabstr && stabstr.size > 0;
}
