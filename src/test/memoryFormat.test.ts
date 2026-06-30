import { convertToSigned } from "../webview/shared/memoryFormat";
import { convertToSigned as convertToSignedReExport } from "../webview/memoryViewer/lib";
import { markChanges } from "../webview/profilerViewer/memoryDiff";

describe("convertToSigned", () => {
  it("converts a byte (size 1)", () => {
    expect(convertToSigned(0x00, 1)).toBe(0);
    expect(convertToSigned(0x7f, 1)).toBe(127);
    expect(convertToSigned(0x80, 1)).toBe(-128);
    expect(convertToSigned(0xff, 1)).toBe(-1);
  });

  it("converts a word (size 2)", () => {
    expect(convertToSigned(0x7fff, 2)).toBe(32767);
    expect(convertToSigned(0x8000, 2)).toBe(-32768);
    expect(convertToSigned(0xffff, 2)).toBe(-1);
  });

  it("converts a long (size 4)", () => {
    expect(convertToSigned(0x7fffffff, 4)).toBe(2147483647);
    expect(convertToSigned(0x80000000, 4)).toBe(-2147483648);
    expect(convertToSigned(0xffffffff, 4)).toBe(-1);
  });

  it("memoryViewer/lib.ts's re-export is the same implementation", () => {
    expect(convertToSignedReExport(0xff, 1)).toBe(convertToSigned(0xff, 1));
    expect(convertToSignedReExport).toBe(convertToSigned); // literally the same function reference
  });
});

describe("markChanges", () => {
  it("marks every byte that differs, with the given timestamp", () => {
    const changed = new Map<number, number>();
    markChanges(new Uint8Array([1, 2, 3]), new Uint8Array([1, 9, 3]), changed, 1000, 1000);
    expect(changed).toEqual(new Map([[1, 1000]]));
  });

  it("only compares up to the shorter buffer's length", () => {
    const changed = new Map<number, number>();
    markChanges(new Uint8Array([1, 2]), new Uint8Array([9, 9, 9, 9]), changed, 1000, 1000);
    expect([...changed.keys()].sort()).toEqual([0, 1]); // offsets 2,3 are out of `prev`'s range, not compared
  });

  it("re-stamps a byte that changed again before its previous mark expired", () => {
    const changed = new Map<number, number>([[5, 100]]);
    markChanges(new Uint8Array([0, 0, 0, 0, 0, 1]), new Uint8Array([0, 0, 0, 0, 0, 2]), changed, 500, 1000);
    expect(changed.get(5)).toBe(500);
  });

  it("evicts entries older than the fade window (1000ms) on every call", () => {
    const changed = new Map<number, number>([[3, 100], [4, 2000]]);
    markChanges(new Uint8Array(8), new Uint8Array(8), changed, 1200, 1000); // no new diffs, just eviction
    expect(changed.has(3)).toBe(false); // 1200 - 100 = 1100ms old, past the 1000ms window
    expect(changed.has(4)).toBe(true); // 1200 - 2000 < 0 (a "future" timestamp — not stale)
  });
});
