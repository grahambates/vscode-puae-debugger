import * as Path from "path";
import { parseHunksFromFile } from "../amigaHunkParser";
import { parseStabs } from "../stabsParser";
import { sourceMapFromHunks } from "../amigaHunkSourceMap";

const FIXTURES_PATH = Path.join(__dirname, "fixtures");

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
    expect(rescan?.returnTypeRef).toBe("17");
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
    const intType = program.resolveType("1");
    expect(intType.kind).toBe("primitive");
    expect(intType.typeName).toBe("int");
    expect(intType.byteSize).toBe(4);

    // `char:t2=r2;0;127;` → 1 byte.
    expect(program.resolveType("2").byteSize).toBe(1);

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
});
