import { createSourceLookup } from "../webview/profilerViewer/sourceLookup";
import { ILineTableEntry, ISegmentRange } from "../shared/profilerTypes";

const segments: ISegmentRange[] = [
  { address: 0x1000, size: 0x1000 }, // CODE: 0x1000-0x1fff
  { address: 0x4000, size: 0x1000 }, // DATA: 0x4000-0x4fff
];

const lineTable: ILineTableEntry[] = [
  { address: 0x1000, file: "a.asm", line: 9 },
  { address: 0x1002, file: "a.asm", line: 10 },
  { address: 0x4000, file: "b.asm", line: 42 }, // a data symbol's declaration (e.g. "Screen")
  { address: 0x4020, file: "b.asm", line: 43 }, // next line-table entry within the same buffer
];

describe("createSourceLookup", () => {
  it("returns undefined when there's no line table", () => {
    expect(createSourceLookup(undefined, segments)(0x1000)).toBeUndefined();
    expect(createSourceLookup([], segments)(0x1000)).toBeUndefined();
  });

  it("resolves an exact line-table address", () => {
    expect(createSourceLookup(lineTable, segments)(0x1002)).toEqual({ file: "a.asm", line: 10 });
  });

  it("resolves an address between two line-table entries via floor search (mid-instruction)", () => {
    expect(createSourceLookup(lineTable, segments)(0x1001)).toEqual({ file: "a.asm", line: 9 });
  });

  it("resolves a data address to its enclosing line-table entry (e.g. Screen+$f)", () => {
    expect(createSourceLookup(lineTable, segments)(0x400f)).toEqual({ file: "b.asm", line: 42 });
  });

  it("resolves past the next line-table entry within the same data buffer", () => {
    expect(createSourceLookup(lineTable, segments)(0x4025)).toEqual({ file: "b.asm", line: 43 });
  });

  it("returns undefined for an address before any known line-table entry", () => {
    expect(createSourceLookup(lineTable, segments)(0x500)).toBeUndefined();
  });

  it("returns undefined for an address in the gap between two segments", () => {
    // Floor-searches to 0x1002 (CODE), but 0x2000 itself isn't inside any loaded segment.
    expect(createSourceLookup(lineTable, segments)(0x2000)).toBeUndefined();
  });

  it("returns undefined for an address past the last entry, outside any segment", () => {
    expect(createSourceLookup(lineTable, segments)(0x9000)).toBeUndefined();
  });

  it("works with no segments at all (always misses past an exact match)", () => {
    const lookup = createSourceLookup(lineTable, undefined);
    expect(lookup(0x1002)).toEqual({ file: "a.asm", line: 10 }); // exact match doesn't need segments
    expect(lookup(0x1001)).toBeUndefined(); // floor match needs a segment to bound it
  });
});
