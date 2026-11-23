import { HunkType, MemoryType } from "../amigaHunkParser";
import { MacroListing, relocatedListingBytes } from "../macroListing";

const listing = [
  "Sections:",
  '00: "CODE" (0-A)',
  "",
  'Source: "/project/main.s"',
  "                            \t     6:  Pair 3",
  "00:00000000 7003            \t     1M  moveq #3,d0",
  "00:00000002 5240            \t     2M  addq.w #1,d0",
  "                            \t     7:  Pair 7",
  "00:00000004 7007            \t     1M  moveq #7,d0",
  "00:00000006 5240            \t     2M  addq.w #1,d0",
  "00:00000008 4E75            \t     8:  rts",
].join("\r\n");

it("keeps repeated macro invocations separate and maps exact instruction offsets", () => {
  const macros = new MacroListing(listing, [12]);
  const first = macros.instructionAt(0, 0)!;
  const second = macros.instructionAt(0, 4)!;
  expect(first.expansion.sourceReference).not.toBe(second.expansion.sourceReference);
  expect(first.group.map(row => row.offset)).toEqual([0, 2]);
  expect(second.group.map(row => row.offset)).toEqual([4, 6]);
  expect(first.expansion.callSite).toEqual({ path: "/project/main.s", line: 6 });
  expect(second.expansion.callSite).toEqual({ path: "/project/main.s", line: 7 });
  expect(first.bytes.toString("hex")).toBe("7003");
  expect(second.bytes.toString("hex")).toBe("7007");
  const continued = macros.instructionAt(0, 6)!;
  const content = macros.source(second.expansion.sourceReference)!;
  expect(content.split("\n")[continued.line - 1].trim()).toBe("addq.w #1,d0");
  expect(content).toContain("moveq #7,d0");
  expect(macros.instructionAt(0, 5)).toBeUndefined();
  expect(macros.instructionAt(0, 8)).toBeUndefined();
});

it("rejects listings whose section table does not fit the executable", () => {
  expect(() => new MacroListing(listing, [16])).toThrow(/sections do not match/);
  expect(() => new MacroListing(listing.replace("(0-A)", '(0-A)\n01: "DATA" (0-4)'), [12]))
    .toThrow(/sections do not match/);
});

it("distinguishes instructions at the same offset in separate Hunks", () => {
  const text = listing.replace('(0-A)', '(0-A)\r\n01: "SECOND" (0-4)') +
    "\r\n                             \t    9:  Pair 9" +
    "\r\n01:00000000 7009            \t     1M  moveq #9,d0";
  const macros = new MacroListing(text, [12, 4]);
  expect(macros.instructionAt(0, 0)?.bytes.toString("hex")).toBe("7003");
  expect(macros.instructionAt(1, 0)?.bytes.toString("hex")).toBe("7009");
  expect(macros.instructionAt(1, 4)).toBeUndefined();
});

it("verifies relocated bytes, including a fixup overlapping the end of a listing row", () => {
  const data = Buffer.from("23fa28d400004a7a", "hex");
  const hunk = {
    index: 0, hunkType: HunkType.CODE, fileOffset: 0, memType: MemoryType.ANY,
    allocSize: data.length, symbols: [], lineDebugInfo: [], stabs: [], data,
    reloc32: [{ target: 1, offsets: [4] }],
  };
  expect(relocatedListingBytes(hunk, 0, 8, [0x90000, 0x50000])?.toString("hex"))
    .toBe("23fa28d400054a7a");
  expect(relocatedListingBytes(hunk, 0, 6, [0x90000, 0x50000])?.toString("hex"))
    .toBe("23fa28d40005");
  expect(data.toString("hex")).toBe("23fa28d400004a7a");
});

it("maps standalone repeat iterations and nested expansions to their outer REPT directive", () => {
  const text = [
    "Sections:",
    '00: "CODE" (0-C)',
    'Source: "/project/main.asm"',
    "\t 4:  rept 2",
    "\t 5:  moveq #REPTN,d1",
    "\t 6:  rept 1",
    "\t 7:  Pair REPTN",
    "\t 8:  endr",
    "\t 9:  endr",
    "00:00000000 7200 \t 1R  moveq #REPTN,d1",
    "\t 2R  rept 1",
    "\t 3R  Pair REPTN",
    "\t 4R  endr",
    "\t 1R  Pair REPTN",
    "00:00000002 7000 \t 1M  moveq #REPTN,d0",
    "\t 2R  ",
    "\t 5R  ",
    "00:00000004 7201 \t 1R  moveq #REPTN,d1",
    "\t 2R  rept 1",
    "\t 3R  Pair REPTN",
    "\t 4R  endr",
    "\t 1R  Pair REPTN",
    "00:00000006 7000 \t 1M  moveq #REPTN,d0",
    "\t 2R  ",
    "\t 5R  ",
    "\t 10:  rept 1",
    "\t 11:  nop",
    "\t 12:  endr",
    "00:00000008 4E71 \t 1R  nop",
    "00:0000000A 4E75 \t 13:  rts",
  ].join("\n");
  const macros = new MacroListing(text, [12]);
  const first = macros.instructionAt(0, 0)!;
  const second = macros.instructionAt(0, 4)!;
  const nested = macros.instructionAt(0, 6)!;
  const next = macros.instructionAt(0, 8)!;
  expect(first.expansion.kind).toBe("repeat");
  expect(first.expansion.callSite.line).toBe(4);
  expect(second.expansion).toBe(first.expansion);
  expect(first.group.map(row => row.offset)).toEqual([0]);
  expect(second.group.map(row => row.offset)).toEqual([4]);
  expect(nested.group.map(row => row.offset)).toEqual([6]);
  expect(nested.expansion).toBe(first.expansion);
  expect(next.expansion.callSite.line).toBe(10);
  expect(second.bytes.toString("hex")).toBe("7201");
  const lines = macros.source(first.expansion.sourceReference)!.split("\n");
  expect(lines[0]).toBe("; Repeat block: rept 2");
  expect(lines[second.line - 1].trim()).toBe("moveq #1,d1");
  expect(lines[nested.line - 1].trim()).toBe("moveq #0,d0");
  expect(macros.instructionAt(0, 10)).toBeUndefined();
});

it("substitutes REPTN inside macro repeat rows without losing symbols", () => {
  const text = [
    "Sections:",
    '00: "CODE" (0-8)',
    'Source: "/project/main.asm"',
    "\t 20:  COPY PendingLights,ShownLights",
    "\t 1M  rept 2",
    "\t 2M  move.l \\1+REPTN*4,\\2+REPTN*4",
    "\t 3M  endr",
    "00:00000000 12345678 \t 1M  move.l PendingLights+REPTN*4,ShownLights+REPTN*4 ; REPTN",
    "\t 2M  ",
    "00:00000004 12345679 \t 1M  move.l PendingLights+REPTN*4,ShownLights+REPTN*4",
    "\t 2M  ",
    "\t 4M  ",
  ].join("\n");
  const macros = new MacroListing(text, [8]);
  const first = macros.instructionAt(0, 0)!;
  const second = macros.instructionAt(0, 4)!;
  const content = macros.source(first.expansion.sourceReference)!;
  expect(content).not.toContain("rept 2");
  expect(content.split("\n")[first.line - 1].trim())
    .toBe("move.l PendingLights+0*4,ShownLights+0*4 ; REPTN");
  expect(content.split("\n")[second.line - 1].trim())
    .toBe("move.l PendingLights+1*4,ShownLights+1*4");
});
