import * as crypto from "crypto";
import { MemoryType } from "./amigaHunkParser";
import { Segment } from "./sourceMap";
import { kickstartRoms } from "./kickstartSymbols";

export interface KickstartSymbolModule {
  /** SHA-1 of the matched ROM (also identifies the symbol set). */
  sha1: string;
  /** Friendly ROM name/version (e.g. "Kickstart v1.3 r34.5 ..."). */
  name: string;
  /** Base address the ROM is mapped at: 0x1000000 - romSize. */
  base: number;
  /** Synthetic segment covering the ROM region, so SourceMap address lookups apply to it. */
  segment: Segment;
  /** Absolute symbol addresses by name. */
  symbols: Record<string, number>;
}

/**
 * Resolve Kickstart ROM debug symbols for a loaded ROM image.
 *
 * Hashes the ROM, looks it up in the embedded {@link kickstartRoms} data (pre-processed from the
 * vscode-amiga-debug `kick_<sha1>.elf` symbol files), and relocates the offsets to absolute
 * addresses at the ROM base. Returns `undefined` for an unknown ROM (the caller should carry on
 * without ROM symbols).
 *
 * The base mirrors vscode-amiga-debug: 256K ROM -> 0xFC0000, 512K ROM -> 0xF80000.
 */
export function kickstartSymbolModule(
  romBuffer: Buffer,
): KickstartSymbolModule | undefined {
  const sha1 = crypto.createHash("sha1").update(romBuffer).digest("hex");
  const rom = kickstartRoms[sha1];
  if (!rom) {
    return undefined;
  }

  // Kickstart ROMs are mapped at the top of the 16MB address space.
  const base = 0x1000000 - romBuffer.length;

  const symbols: Record<string, number> = {};
  for (const [name, offset] of rom.symbols) {
    symbols[name] = base + offset;
  }

  const segment: Segment = {
    name: "kickstart",
    address: base,
    size: romBuffer.length,
    memType: MemoryType.ANY,
  };

  return { sha1, name: rom.name, base, segment, symbols };
}
