import * as Path from "path";
import { parseHunksFromFile, StabData } from "../amigaHunkParser";
import { parseStabs, StabType } from "../stabsParser";
import { sourceMapFromHunks } from "../amigaHunkSourceMap";

const FIXTURES_PATH = Path.join(__dirname, "fixtures");

/** Build a synthetic HUNK_DEBUG stabs section (nlist table + string table) from raw entries. */
function buildStabSection(
  entries: { str: string; type: number; value: number }[],
): StabData {
  // String table: offset 0 is reserved (readStabString treats offset <= 0 as ""),
  // so the first real string starts at offset 1.
  const strParts: Buffer[] = [Buffer.from([0])];
  let offset = 1;
  const strx: number[] = [];
  for (const e of entries) {
    strx.push(e.str ? offset : 0);
    const buf = Buffer.from(e.str + "\0", "latin1");
    strParts.push(buf);
    offset += buf.length;
  }
  const strings = Buffer.concat(strParts);

  const stabs = Buffer.alloc(entries.length * 12);
  entries.forEach((e, i) => {
    const o = i * 12;
    stabs.writeUInt32BE(strx[i], o);
    stabs.writeUInt8(e.type, o + 4);
    stabs.writeUInt8(0, o + 5); // n_other
    stabs.writeUInt16BE(0, o + 6); // n_desc
    stabs.writeUInt32BE(e.value >>> 0, o + 8);
  });

  return { stabs, strings };
}

// pt1210-debug.exe: m68k-amigaos-gcc build with GNU stabs in HUNK_DEBUG (magic 0x10b).
describe("stabsParser", function () {
  it("captures stabs sections from the hunk executable", async function () {
    const hunks = await parseHunksFromFile(
      Path.join(FIXTURES_PATH, "pt1210-debug.exe"),
    );
    const sections = hunks.flatMap((h) => h.stabs);
    expect(sections.length).toBeGreaterThan(0);
    // First (main code) stabs block: 8716 nlist entries.
    expect(sections[0].stabs.length % 12).toBe(0);
    expect(sections[0].stabs.length / 12).toBe(8716);
  });

  it("extracts source files, functions and lines", async function () {
    const hunks = await parseHunksFromFile(
      Path.join(FIXTURES_PATH, "pt1210-debug.exe"),
    );
    const program = parseStabs(hunks.flatMap((h) => h.stabs));

    // Source files
    expect(
      program.files.some((f) => f.endsWith("action.c")),
    ).toBe(true);

    // Functions (values are hunk-relative offsets)
    const rescan = program.functions.find((f) => f.name === "rescan_wrapper");
    expect(rescan).toBeDefined();
    expect(rescan?.address).toBe(0xd8);
    expect(rescan?.size).toBe(0x16);
    expect(rescan?.isGlobal).toBe(false);
    expect(rescan?.returnTypeRef).toBe("0:17");
    expect(rescan?.file.endsWith("action.c")).toBe(true);

    const sw = program.functions.find(
      (f) => f.name === "pt1210_action_switch_screen",
    );
    expect(sw).toBeDefined();
    expect(sw?.address).toBe(0xee);
    expect(sw?.size).toBe(0x166);
    expect(sw?.isGlobal).toBe(true);

    // Lines: first source line of rescan_wrapper is line 29 at 0xd8.
    const line29 = program.lines.find((l) => l.address === 0xd8);
    expect(line29?.line).toBe(29);
    expect(line29?.file.endsWith("action.c")).toBe(true);
  });

  it("resolves types, function params, scopes and globals", async function () {
    const hunks = await parseHunksFromFile(
      Path.join(FIXTURES_PATH, "pt1210-debug.exe"),
    );
    const program = parseStabs(hunks.flatMap((h) => h.stabs));

    // Base type: `int:t1=r1;...` → primitive int, 4 bytes.
    // Type keys are namespaced per stabs section ("0:" — see the mixed-object test below).
    const intType = program.resolveType("0:1");
    expect(intType.kind).toBe("primitive");
    expect(intType.typeName).toBe("int");
    expect(intType.byteSize).toBe(4);

    // `char:t2=r2;0;127;` → 1 byte.
    expect(program.resolveType("0:2").byteSize).toBe(1);

    // At least one function has parameters located at a frame offset.
    const withParams = program.functions.find((f) => f.params.length > 0);
    expect(withParams).toBeDefined();
    expect(withParams!.params[0].location.kind).toBe("frame");

    // Scopes are captured (LBRAC/RBRAC) with a valid range.
    const withScope = program.functions.find((f) => f.scopes.length > 0);
    expect(withScope).toBeDefined();
    expect(withScope!.scopes[0].end).toBeGreaterThanOrEqual(
      withScope!.scopes[0].start,
    );

    // Globals are captured.
    expect(program.globals.length).toBeGreaterThan(0);

    // Every param/local/global type resolves without throwing or looping.
    expect(() => {
      for (const f of program.functions) {
        program.resolveType(f.returnTypeRef);
        for (const p of f.params) program.resolveType(p.typeKey);
        for (const sc of f.scopes)
          for (const v of sc.vars) program.resolveType(v.typeKey);
      }
      for (const g of program.globals) program.resolveType(g.typeKey);
    }).not.toThrow();
  });

  it("builds a working SourceMap from stabs (lines, symbols, locals, globals)", async function () {
    const hunks = await parseHunksFromFile(
      Path.join(FIXTURES_PATH, "pt1210-debug.exe"),
    );
    // Arbitrary distinct load addresses per hunk.
    const offsets = hunks.map((_, i) => 0x10000 * (i + 1));
    const sm = sourceMapFromHunks(hunks, offsets);
    const base = offsets[0]; // stabs are attached to the first code hunk

    // Address -> source line (0xd8 = rescan_wrapper, action.c:29).
    const loc = sm.lookupAddress(base + 0xd8);
    expect(loc?.line).toBe(29);
    expect(loc?.path.toLowerCase()).toContain("action.c");

    // Function symbol resolved.
    const syms = sm.getSymbols();
    expect(syms["rescan_wrapper"]).toBe(base + 0xd8);

    // Globals present with resolved addresses and types.
    expect(sm.getGlobalVariables().length).toBeGreaterThan(0);

    // Locals: a function with parameters exposes them via getLocalsForPc.
    const program = parseStabs(hunks.flatMap((h) => h.stabs));
    const fn = program.functions.find(
      (f) => f.params.length > 0 && (f.size ?? 0) > 4,
    );
    expect(fn).toBeDefined();
    const locals = sm.getLocalsForPc(base + fn!.address + 2);
    expect(locals.map((v) => v.name)).toEqual(
      expect.arrayContaining([fn!.params[0].name]),
    );
    // The param has an A5-relative (fbreg) location.
    const p0 = locals.find((v) => v.name === fn!.params[0].name);
    expect(p0?.location.kind).toBe("fbreg");

    // Register variables (N_RSYM) surface with a `reg` location end-to-end.
    const regScope = program.functions
      .flatMap((f) => f.scopes)
      .find(
        (sc) =>
          sc.end > sc.start &&
          sc.vars.some((v) => v.location.kind === "register"),
      );
    expect(regScope).toBeDefined();
    const scopeLocals = sm.getLocalsForPc(base + regScope!.start);
    expect(scopeLocals.some((v) => v.location.kind === "reg")).toBe(true);
  });

  // A linker (e.g. vlink) merging several object files' CODE sections into one
  // output hunk packs each object's stabs as a separate HUNK_DEBUG block, so a
  // single hunk's `stabs` array can hold more than one entry. Type numbers are
  // only unique within the compilation unit that defined them, so two blocks
  // reusing the same raw number (very likely - both start counting from 1)
  // must not resolve to each other's definition.
  it("keeps type numbers from different merged stabs blocks distinct", function () {
    // Section 0: `fnA` returns type 1, defined inline as a 4-byte int range.
    const sectionA = buildStabSection([
      { str: "fnA:F1=r1;-2147483648;2147483647;", type: StabType.FUN, value: 0x10 },
      { str: "", type: StabType.FUN, value: 4 }, // size terminator
    ]);
    // Section 1: `fnB` also returns type 1, but here it's a 1-byte range.
    const sectionB = buildStabSection([
      { str: "fnB:F1=r1;0;127;", type: StabType.FUN, value: 0x20 },
      { str: "", type: StabType.FUN, value: 4 },
    ]);

    const program = parseStabs([sectionA, sectionB]);

    const fnA = program.functions.find((f) => f.name === "fnA");
    const fnB = program.functions.find((f) => f.name === "fnB");
    expect(fnA).toBeDefined();
    expect(fnB).toBeDefined();

    // Namespaced keys, not the same raw "1" clobbering each other.
    expect(fnA!.returnTypeRef).not.toBe(fnB!.returnTypeRef);

    expect(program.resolveType(fnA!.returnTypeRef).byteSize).toBe(4);
    expect(program.resolveType(fnB!.returnTypeRef).byteSize).toBe(1);
  });
});
