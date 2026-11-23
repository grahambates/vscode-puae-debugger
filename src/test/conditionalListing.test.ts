import { HunkType, MemoryType } from "../amigaHunkParser";
import { MacroListing } from "../macroListing";

const hunks = [{
  index: 0, hunkType: HunkType.CODE, fileOffset: 0, memType: MemoryType.ANY,
  allocSize: 8, data: Buffer.from("700170054e750000", "hex"), symbols: [],
  lineDebugInfo: [], stabs: [], reloc32: [],
}];

const listing = [
  '00: "CODE" (0-6)',
  'Source: "main.asm"',
  "\t 1:  ifne FEATURE",
  "00:00000000 7001 \t 2:  moveq #1,d0",
  "\t 3:  ifne 0",
  "\t 4:  moveq #4,d0",
  "\t 5:  else",
  "00:00000002 7005 \t 6:  moveq #5,d0",
  "\t 7:  endc",
  "\t 8:  else",
  "\t 9:  moveq #2,d0",
  "\t 10:  endc",
  "\t 11:  ifne 0",
  "\t 12: ABSENT equ 1",
  "\t 13:  else",
  "\t 14: PRESENT equ 2",
  "\t 15:  endc",
  "00:00000004 4E75 \t 16:  rts",
].join("\n");

it("finds inactive source branches only when a sibling emitted matching code", () => {
  const blocks = new MacroListing(listing, [8]).conditionals.inactiveBlocks("/project/main.asm", hunks);
  expect(blocks).toEqual([{
    startLine: 1,
    lines: [" ifne FEATURE", " moveq #1,d0", " ifne 0", " moveq #4,d0", " else",
      " moveq #5,d0", " endc", " else", " moveq #2,d0", " endc"],
    ranges: [{ start: 4, end: 4 }, { start: 9, end: 9 }],
  }]);
  const stale = [{ ...hunks[0], data: Buffer.alloc(8) }];
  expect(new MacroListing(listing, [8]).conditionals.inactiveBlocks("/project/main.asm", stale)).toEqual([]);
});

it("does not assign one branch state to repeatedly included source", () => {
  const twice = listing + '\nSource: "main.asm"\n\t 1:  ifne FEATURE';
  expect(new MacroListing(twice, [8]).conditionals.inactiveBlocks("/project/main.asm", hunks)).toEqual([]);
});

it("uses only the current expansion as evidence for a macro template", () => {
  const template = [
    '00: "CODE" (0-6)',
    'Source: "macro.asm"',
    "\t 1: Choose macro",
    "\t 2:  ifne \\1",
    "\t 3:  moveq #1,d0",
    "\t 4:  else",
    "\t 5:  moveq #2,d0",
    "\t 6:  endif",
    "\t 7:  endm",
  ].join("\n");
  const conditionals = new MacroListing(template, [8]).conditionals;
  const ranges = (lines?: number[]) => conditionals.inactiveBlocks(
    "/project/macro.asm", hunks, lines && new Set(lines),
  ).flatMap(block => block.ranges);
  expect(ranges()).toEqual([]);
  expect(ranges([3])).toEqual([{ start: 5, end: 5 }]);
  expect(ranges([5])).toEqual([{ start: 3, end: 3 }]);
  expect(ranges([3, 5])).toEqual([]);
});
