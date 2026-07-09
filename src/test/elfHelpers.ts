/**
 * Minimal 32-bit big-endian ELF builder for tests — constructs just enough of
 * a real ELF (header, section table, .symtab/.strtab, .shstrtab, plus
 * caller-supplied raw sections) to exercise parseDwarf's section/symbol
 * parsing and the elfStabsSourceMap relocation path, without needing a real
 * compiler-produced binary. Matches this project's actual toolchain
 * (32-bit, big-endian — confirmed against src/test/fixtures/amigaPrograms
 * ELF fixtures).
 */

export interface ElfSymbolSpec {
  name: string;
  value: number;
  size: number;
  type: number; // STT_* (1 = OBJECT, 2 = FUNC)
  bind: number; // STB_* (1 = GLOBAL, 0 = LOCAL)
  sectionIndex: number; // raw section header index (st_shndx)
}

export interface ElfSectionSpec {
  name: string;
  type: number; // SHT_*
  addr: number;
  size: number;
  data?: Buffer; // raw bytes to embed (defaults to zero-filled `size` bytes)
}

/** Builds a minimal but structurally valid 32-bit BE ELF file. */
export function buildElf(
  extraSections: ElfSectionSpec[],
  symbols: ElfSymbolSpec[] = [],
): Buffer {
  const strTabBytes = (names: string[]): { buf: Buffer; offsets: number[] } => {
    const parts: number[] = [0]; // index 0 = empty string (ELF convention)
    const offsets: number[] = [];
    for (const n of names) {
      offsets.push(parts.length);
      for (const ch of n) parts.push(ch.charCodeAt(0));
      parts.push(0);
    }
    return { buf: Buffer.from(parts), offsets };
  };

  // .strtab (symbol names) + .symtab
  const { buf: strtabBuf, offsets: symNameOffsets } = strTabBytes(symbols.map((s) => s.name));
  const symtabBuf = Buffer.alloc(16 * (symbols.length + 1)); // +1 for the null symbol
  symbols.forEach((s, i) => {
    const o = 16 * (i + 1);
    symtabBuf.writeUInt32BE(symNameOffsets[i], o); // st_name
    symtabBuf.writeUInt32BE(s.value >>> 0, o + 4); // st_value
    symtabBuf.writeUInt32BE(s.size >>> 0, o + 8); // st_size
    symtabBuf.writeUInt8(((s.bind & 0xf) << 4) | (s.type & 0xf), o + 12); // st_info
    symtabBuf.writeUInt8(0, o + 13); // st_other
    symtabBuf.writeUInt16BE(s.sectionIndex, o + 14); // st_shndx
  });

  const allSections: (ElfSectionSpec & { data: Buffer })[] = [
    { name: "", type: 0, addr: 0, size: 0, data: Buffer.alloc(0) },
    ...extraSections.map((s) => ({ ...s, data: s.data ?? Buffer.alloc(s.size) })),
    { name: ".symtab", type: 2 /* SHT_SYMTAB */, addr: 0, size: symtabBuf.length, data: symtabBuf },
    { name: ".strtab", type: 3 /* SHT_STRTAB */, addr: 0, size: strtabBuf.length, data: strtabBuf },
  ];
  const symtabIndex = allSections.findIndex((s) => s.name === ".symtab");
  const strtabIndex = allSections.findIndex((s) => s.name === ".strtab");

  // .shstrtab (section names) — appended last, so its own name is included when
  // building the name string table from the final section list.
  allSections.push({ name: ".shstrtab", type: 3, addr: 0, size: 0, data: Buffer.alloc(0) });
  const shstrndx = allSections.length - 1;
  const { buf: shstrtabBuf, offsets: shNameOffsets } = strTabBytes(allSections.map((s) => s.name));
  allSections[shstrndx].data = shstrtabBuf;
  allSections[shstrndx].size = shstrtabBuf.length;

  // Lay out section data after the ELF header (52 bytes for 32-bit).
  const headerSize = 52;
  let fileOffset = headerSize;
  const sectionOffsets: number[] = [];
  for (const s of allSections) {
    sectionOffsets.push(fileOffset);
    fileOffset += s.data.length;
    // 4-byte align the next section's start.
    fileOffset = (fileOffset + 3) & ~3;
  }
  const shoff = fileOffset;
  const shentsize = 40;
  const shnum = allSections.length;
  const totalSize = shoff + shentsize * shnum;

  const out = Buffer.alloc(totalSize);
  // ELF header
  out.write("\x7fELF", 0, "latin1");
  out[4] = 1; // ELFCLASS32
  out[5] = 2; // ELFDATA2MSB (big-endian)
  out[6] = 1; // EV_CURRENT
  out.writeUInt16BE(2, 16); // e_type = ET_EXEC
  out.writeUInt16BE(0, 18); // e_machine (unused by parseDwarf)
  out.writeUInt32BE(1, 20); // e_version
  out.writeUInt32BE(0, 24); // e_entry
  out.writeUInt32BE(0, 28); // e_phoff
  out.writeUInt32BE(shoff, 32); // e_shoff
  out.writeUInt32BE(0, 36); // e_flags
  out.writeUInt16BE(headerSize, 40); // e_ehsize
  out.writeUInt16BE(0, 42); // e_phentsize
  out.writeUInt16BE(0, 44); // e_phnum
  out.writeUInt16BE(shentsize, 46); // e_shentsize
  out.writeUInt16BE(shnum, 48); // e_shnum
  out.writeUInt16BE(shstrndx, 50); // e_shstrndx

  // Section data
  allSections.forEach((s, i) => s.data.copy(out, sectionOffsets[i]));

  // Section header table
  allSections.forEach((s, i) => {
    const o = shoff + i * shentsize;
    out.writeUInt32BE(shNameOffsets[i], o); // sh_name
    out.writeUInt32BE(s.type, o + 4); // sh_type
    out.writeUInt32BE(0, o + 8); // sh_flags
    out.writeUInt32BE(s.addr >>> 0, o + 12); // sh_addr
    out.writeUInt32BE(sectionOffsets[i], o + 16); // sh_offset
    out.writeUInt32BE(s.size, o + 20); // sh_size
    out.writeUInt32BE(i === symtabIndex ? strtabIndex : 0, o + 24); // sh_link
    out.writeUInt32BE(0, o + 28); // sh_info
    out.writeUInt32BE(1, o + 32); // sh_addralign
    out.writeUInt32BE(i === symtabIndex ? 16 : 0, o + 36); // sh_entsize
  });

  return out;
}

/** Encode one GNU-stabs nlist entry (12 bytes BE): strx, type, other, desc, value. */
export function nlistEntry(
  strx: number,
  type: number,
  desc: number,
  value: number,
): Buffer {
  const b = Buffer.alloc(12);
  b.writeUInt32BE(strx >>> 0, 0);
  b.writeUInt8(type, 4);
  b.writeUInt8(0, 5);
  b.writeUInt16BE(desc, 6);
  b.writeUInt32BE(value >>> 0, 8);
  return b;
}

/** Builds a stabs table (nlist entries) + string table from (type, desc, str, value) tuples. */
export function buildStabs(
  entries: { type: number; desc?: number; str?: string; value?: number }[],
): { stab: Buffer; stabstr: Buffer } {
  const strParts: number[] = [0]; // index 0 = empty string
  const strx: number[] = [];
  for (const e of entries) {
    const str = e.str ?? "";
    strx.push(str ? strParts.length : 0);
    for (const ch of str) strParts.push(ch.charCodeAt(0));
    if (str) strParts.push(0);
  }
  const stab = Buffer.concat(
    entries.map((e, i) => nlistEntry(strx[i], e.type, e.desc ?? 0, e.value ?? 0)),
  );
  return { stab, stabstr: Buffer.from(strParts) };
}
