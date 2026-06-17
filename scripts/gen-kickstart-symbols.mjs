// Generator for src/kickstartSymbols.ts
//
// Pre-processes the offline-generated `kick_<sha1>.elf` symbol files (in kickstart/symbols/)
// into a single committed TypeScript data module. Those ELF files are produced by the
// vscode-amiga-debug Kickstart ROM scanner (Resident structs -> LVO vectors -> .fd names); we
// only consume their `.symtab` here. The extension never reads the ELF files at runtime.
//
// The ELFs are 32-bit big-endian m68k with a single NOBITS `.kick` section at address 0, so each
// symbol's `st_value` is its offset from the ROM base. The runtime base is `0x1000000 - romSize`
// (256K -> 0xFC0000, 512K -> 0xF80000), matching vscode-amiga-debug.
//
// Run with: npm run gen:kickstart-symbols   (plain Node, no extra deps)

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const inputDir = path.join(repoRoot, "kickstart", "symbols");
const outFile = path.join(repoRoot, "src", "kickstartSymbols.ts");

// ELF / symbol-table constants
const SHT_SYMTAB = 2;
const STT_FUNC = 2;
const STT_OBJECT = 1;

// Friendly ROM names by SHA-1, for developer sanity (which hash is which ROM).
// Source: the `libraryVectors` comments in vscode-amiga-debug/src/kickstart.ts.
const ROM_NAMES = {
  "11f9e62cf299f72184835b7b2a70a16333fc0d88": "Kickstart v1.2 r33.180 (1986)(Commodore)(A500-A1000-A2000)",
  "891e9a547772fe0c6c19b610baf8bc4ea7fcb785": "Kickstart v1.3 r34.5 (1987)(Commodore)(A500-A1000-A2000-CDTV)",
  "c5839f5cb98a7a8947065c3ed2f14f5f42e334a1": "Kickstart v2.04 r37.175 (1991)(Commodore)(A500+)",
  "87508de834dc7eb47359cede72d2e3c8a2e5d8db": "Kickstart v2.05 r37.299 (1991)(Commodore)(A600)",
  "70033828182fffc7ed106e5373a8b89dda76faa5": "Kickstart v3.0 r39.106 (1992)(Commodore)(A1200)",
  "e21545723fe8374e91342617604f1b3d703094f1": "Kickstart v3.1 r40.68 (1993)(Commodore)(A1200)",
};

/**
 * Parse the `.symtab` of a 32-bit big-endian m68k ELF and return the named symbols that live in
 * the `.kick` section. Values are kept as-is (offset from ROM base, since `.kick` has addr 0).
 *
 * @param {Buffer} b
 * @returns {{ kickSize: number, symbols: Array<[string, number]> }}
 */
function parseKickElf(b) {
  if (b.length < 0x34 || b.readUInt32BE(0) !== 0x7f454c46) {
    throw new Error("not an ELF file");
  }
  if (b[4] !== 1 || b[5] !== 2) {
    throw new Error("expected 32-bit big-endian ELF");
  }
  const u16 = (o) => b.readUInt16BE(o);
  const u32 = (o) => b.readUInt32BE(o);

  const eShoff = u32(0x20);
  const eShentsize = u16(0x2e);
  const eShnum = u16(0x30);

  // Locate .symtab (+ its linked .strtab) and the .kick section index.
  let symtab;
  let kickIndex = -1;
  let kickSize = 0;
  // Section name string table, to find `.kick` by name.
  const eShstrndx = u16(0x32);
  const shstrOff = u32(eShoff + eShstrndx * eShentsize + 0x10);
  const sectionName = (nameOff) => {
    let s = "";
    while (b[shstrOff + nameOff]) {
      s += String.fromCharCode(b[shstrOff + nameOff]);
      nameOff++;
    }
    return s;
  };

  for (let i = 0; i < eShnum; i++) {
    const sh = eShoff + i * eShentsize;
    const type = u32(sh + 4);
    const name = sectionName(u32(sh));
    if (name === ".kick") {
      kickIndex = i;
      kickSize = u32(sh + 0x14);
    }
    if (type === SHT_SYMTAB) {
      symtab = {
        off: u32(sh + 0x10),
        size: u32(sh + 0x14),
        link: u32(sh + 0x18),
        entsize: u32(sh + 0x24) || 16,
      };
    }
  }
  if (!symtab) throw new Error("no .symtab section");
  if (kickIndex === -1) throw new Error("no .kick section");

  const strOff = u32(eShoff + symtab.link * eShentsize + 0x10);
  const symName = (nameOff) => {
    let s = "";
    while (b[strOff + nameOff]) {
      s += String.fromCharCode(b[strOff + nameOff]);
      nameOff++;
    }
    return s;
  };

  // Elf32_Sym: st_name(4) st_value(4) st_size(4) st_info(1) st_other(1) st_shndx(2)
  const symbols = [];
  const count = Math.floor(symtab.size / symtab.entsize);
  for (let i = 0; i < count; i++) {
    const e = symtab.off + i * symtab.entsize;
    const name = symName(u32(e));
    if (!name) continue;
    const value = u32(e + 4);
    const stType = b[e + 12] & 0xf;
    const shndx = u16(e + 14);
    if (shndx !== kickIndex) continue;
    if (stType !== STT_FUNC && stType !== STT_OBJECT) continue;
    symbols.push([name, value]);
  }
  // Sort by address for compact, stable output.
  symbols.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
  return { kickSize, symbols };
}

function main() {
  const files = fs
    .readdirSync(inputDir)
    .filter((f) => /^kick_[0-9a-f]{40}\.elf$/i.test(f))
    .sort();
  if (files.length === 0) {
    throw new Error(`no kick_<sha1>.elf files found in ${inputDir}`);
  }

  const entries = [];
  for (const file of files) {
    const sha1 = file.slice("kick_".length, -".elf".length).toLowerCase();
    const { kickSize, symbols } = parseKickElf(fs.readFileSync(path.join(inputDir, file)));
    const name = ROM_NAMES[sha1] ?? "Unknown ROM";
    if (!ROM_NAMES[sha1]) {
      console.warn(`WARNING: no friendly name for ${sha1} - add it to ROM_NAMES`);
    }
    entries.push({ sha1, name, kickSize, symbols });
    console.log(`${file}: ${name} - ${symbols.length} symbols, .kick size ${kickSize}`);
  }

  let out = "";
  out += "// AUTO-GENERATED by scripts/gen-kickstart-symbols.mjs - DO NOT EDIT BY HAND.\n";
  out += "// Run `npm run gen:kickstart-symbols` to regenerate from kickstart/symbols/*.elf.\n";
  out += "//\n";
  out += "// Amiga Kickstart ROM symbols, keyed by the ROM's SHA-1. `symbols` are [name, offset]\n";
  out += "// pairs where offset is relative to the ROM base (base = 0x1000000 - size).\n\n";
  out += "export interface KickstartRomSymbols {\n";
  out += "  /** Friendly ROM name/version, for developer sanity. */\n";
  out += "  name: string;\n";
  out += "  /** Size of the ROM in bytes (256K or 512K); base = 0x1000000 - size. */\n";
  out += "  size: number;\n";
  out += "  /** [symbolName, offsetFromBase] pairs, sorted by offset. */\n";
  out += "  symbols: [string, number][];\n";
  out += "}\n\n";
  out += "export const kickstartRoms: Record<string, KickstartRomSymbols> = {\n";
  for (const { sha1, name, kickSize, symbols } of entries) {
    out += `  // ${name}\n`;
    out += `  "${sha1}": {\n`;
    out += `    name: ${JSON.stringify(name)},\n`;
    out += `    size: ${kickSize},\n`;
    out += "    symbols: [\n";
    for (const [name, offset] of symbols) {
      out += `      [${JSON.stringify(name)}, 0x${offset.toString(16)}],\n`;
    }
    out += "    ],\n";
    out += "  },\n";
  }
  out += "};\n";

  fs.writeFileSync(outFile, out);
  console.log(`Wrote ${outFile} (${entries.length} ROMs).`);
}

main();
