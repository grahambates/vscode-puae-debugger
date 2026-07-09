import { parseDwarf } from "../dwarfParser";
import { detectContainer, hasDwarfSections, hasElfStabsSections } from "../debugSymbolFormat";
import { extractElfStabs, sourceMapFromElfStabs } from "../elfStabsSourceMap";
import { buildElf, buildStabs } from "./elfHelpers";

// GNU stabs embedded in ELF .stab/.stabstr sections (GCC -gstabs targeting ELF).
// No real -gstabs ELF binary was available when this was built (unlike the
// hunk-stabs path, validated against a real fixture — see stabsParser.test.ts),
// so this test builds a minimal synthetic ELF matching this project's actual
// toolchain (32-bit big-endian — confirmed against src/test/fixtures ELF
// fixtures) and the address/symbol conventions confirmed against those same
// real fixtures (see elfStabsSourceMap.ts's header comment for the evidence).

const N = {
  SO: 0x64,
  FUN: 0x24,
  SLINE: 0x44,
  LSYM: 0x80,
  PSYM: 0xa0,
  RSYM: 0x40,
  GSYM: 0x20,
  LCSYM: 0x28,
  LBRAC: 0xc0,
  RBRAC: 0xe0,
};

describe("ELF + GNU stabs", function () {
  it("detectContainer recognises ELF and Hunk magic, rejects garbage", function () {
    const elf = buildElf([]);
    expect(detectContainer(elf)).toBe("elf");

    const hunk = Buffer.alloc(16);
    hunk.writeUInt32BE(0x000003f3, 0); // HUNK_HEADER
    expect(detectContainer(hunk)).toBe("hunk");

    expect(() => detectContainer(Buffer.from("not a real file"))).toThrow();
  });

  it("hasDwarfSections / hasElfStabsSections detect by section presence, not extension", function () {
    const withStabs = buildElf([
      { name: ".text", type: 1, addr: 0x1000, size: 0x10 },
      { name: ".stab", type: 1, addr: 0, size: 12, data: buildStabs([{ type: N.SO, str: "x.c" }]).stab },
      { name: ".stabstr", type: 3, addr: 0, size: 4, data: Buffer.from([0, 120, 46, 0]) },
    ]);
    const dwarfData = parseDwarf(withStabs);
    expect(hasElfStabsSections(dwarfData)).toBe(true);
    expect(hasDwarfSections(dwarfData)).toBe(false);

    const bare = buildElf([{ name: ".text", type: 1, addr: 0x1000, size: 0x10 }]);
    const bareData = parseDwarf(bare);
    expect(hasElfStabsSections(bareData)).toBe(false);
    expect(hasDwarfSections(bareData)).toBe(false);
  });

  it("builds a working SourceMap: relocated lines/functions/scopes/statics, symtab-resolved globals", function () {
    // Link-time layout: .text @ 0x1000 (size 0x100), .bss @ 0x2000 (size 0x100).
    // Runtime load addresses (as if reported by the emulator after loading):
    //   .text -> 0x100000  (delta = +0xFF000)
    //   .bss  -> 0x200000  (delta = +0x1FE000)
    const stabs = buildStabs([
      { type: N.SO, str: "myFile.c" },
      // Base type used by params/locals.
      { type: N.LSYM, str: "int:t1=r1;-2147483648;2147483647;" },
      // int myFunc(int myParam) { int myLocal; register int myReg; ... }
      { type: N.FUN, str: "myFunc:F1", value: 0x1010 },
      { type: N.FUN, str: "", value: 0x20 }, // function size
      { type: N.SLINE, desc: 10, value: 0x1010 },
      { type: N.SLINE, desc: 11, value: 0x1018 },
      { type: N.PSYM, str: "myParam:p1", value: 8 }, // [A5+8]
      { type: N.LBRAC, value: 0x1010 },
      { type: N.LSYM, str: "myLocal:1", value: -4 }, // [A5-4]
      { type: N.RSYM, str: "myReg:r1", value: 1 }, // D1
      { type: N.RBRAC, value: 0x1020 },
      // static int myStatic; (file-static, address known directly)
      { type: N.LCSYM, str: "myStatic:S1", value: 0x2010 },
      // extern int myGlobal; (resolved via .symtab — no address in the stab)
      { type: N.GSYM, str: "myGlobal:G1" },
    ]);

    const elf = buildElf(
      [
        { name: ".text", type: 1, addr: 0x1000, size: 0x100 },
        { name: ".bss", type: 8, addr: 0x2000, size: 0x100 },
        { name: ".stab", type: 1, addr: 0, size: stabs.stab.length, data: stabs.stab },
        { name: ".stabstr", type: 3, addr: 0, size: stabs.stabstr.length, data: stabs.stabstr },
      ],
      [
        // sectionIndex 1 = .text (raw index: 0=null,1=.text,2=.bss,...)
        { name: "myFunc", value: 0x1010, size: 0x20, type: 2, bind: 1, sectionIndex: 1 },
        // sectionIndex 2 = .bss
        { name: "myGlobal", value: 0x2004, size: 4, type: 1, bind: 1, sectionIndex: 2 },
      ],
    );

    const dwarfData = parseDwarf(elf);
    expect(hasElfStabsSections(dwarfData)).toBe(true);
    const stabData = extractElfStabs(elf, dwarfData);

    // Runtime offsets, one per LOADED section in encounter order: .text, .bss.
    const offsets = [0x100000, 0x200000];
    const sm = sourceMapFromElfStabs(dwarfData, stabData, offsets);

    // Function address relocated: 0x1010 + (0x100000-0x1000) = 0x100010.
    const syms = sm.getSymbols();
    expect(syms["myFunc"]).toBe(0x100010);

    // Line -> relocated address.
    const loc = sm.lookupAddress(0x100010);
    expect(loc?.line).toBe(10);
    const loc2 = sm.lookupAddress(0x100010 + (0x1018 - 0x1010));
    expect(loc2?.line).toBe(11);

    // Locals: param (fbreg), local (fbreg), register var (reg) — all visible
    // inside the function's PC range.
    const locals = sm.getLocalsForPc(0x100010 + 4);
    const byName = new Map(locals.map((v) => [v.name, v]));
    expect(byName.get("myParam")?.location).toEqual({ kind: "fbreg", offset: 8 });
    expect(byName.get("myLocal")?.location).toEqual({ kind: "fbreg", offset: -4 });
    expect(byName.get("myReg")?.location).toEqual({ kind: "reg", reg: 1 });

    // Globals: static resolved directly (0x2010 + 0x1FE000 = 0x200010);
    // extern resolved via .symtab (0x2004 + 0x1FE000 = 0x200004).
    const globals = sm.getGlobalVariables();
    const gByName = new Map(globals.map((v) => [v.name, v]));
    expect(gByName.get("myStatic")?.location).toEqual({ kind: "addr", address: 0x200010 });
    expect(gByName.get("myGlobal")?.location).toEqual({ kind: "addr", address: 0x200004 });
  });

  it("throws a clear error for an ELF with neither DWARF nor stabs sections", function () {
    const elf = buildElf([{ name: ".text", type: 1, addr: 0x1000, size: 0x10 }]);
    const dwarfData = parseDwarf(elf);
    expect(hasDwarfSections(dwarfData)).toBe(false);
    expect(hasElfStabsSections(dwarfData)).toBe(false);
    // (The actual throw-on-neither lives in vAmigaDebugAdapter's launch dispatch;
    // this asserts the two predicates it relies on both correctly report "no".)
  });
});
