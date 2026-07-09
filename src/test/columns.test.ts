import { columnIndexAtX, columnIndexToSlot, findNextSample, IColumn } from "../webview/profilerViewer/columns";

const columns: IColumn[] = [
  { x1: 0, x2: 0.25, rows: [] },
  { x1: 0.25, x2: 0.5, rows: [] },
  { x1: 0.5, x2: 0.75, rows: [] },
  { x1: 0.75, x2: 1, rows: [] },
];

describe("columnIndexToSlot", () => {
  it("maps a column index to a slot within its x1..x2 span (uses midpoint, not left edge)", () => {
    const dmaSlots = 100;
    const slot = columnIndexToSlot(columns, 2, dmaSlots); // mid=(0.5+0.75)/2=0.625 -> slot 62
    expect(slot).toBe(62);
  });

  it("round-trips with columnIndexAtX: the returned slot resolves back to the same column", () => {
    const dmaSlots = 100;
    for (let idx = 0; idx < columns.length; idx++) {
      const slot = columnIndexToSlot(columns, idx, dmaSlots);
      const resolved = columnIndexAtX(columns, (slot + 0.5) / dmaSlots);
      expect(resolved).toBe(idx);
    }
  });

  it("clamps an out-of-range index into bounds", () => {
    expect(columnIndexToSlot(columns, -5, 100)).toBe(columnIndexToSlot(columns, 0, 100));
    expect(columnIndexToSlot(columns, 999, 100)).toBe(columnIndexToSlot(columns, columns.length - 1, 100));
  });

  it("returns 0 for an empty columns array or zero dmaSlots", () => {
    expect(columnIndexToSlot([], 0, 100)).toBe(0);
    expect(columnIndexToSlot(columns, 0, 0)).toBe(0);
  });
});

describe("findNextSample", () => {
  it("finds the next match forward, wrapping past the end", () => {
    const matchAt = new Set([2, 7]);
    expect(findNextSample(10, 5, false, (i) => matchAt.has(i))).toBe(7);
    expect(findNextSample(10, 7, false, (i) => matchAt.has(i))).toBe(2); // wraps around
  });

  it("finds the previous match backward, wrapping past the start", () => {
    const matchAt = new Set([2, 7]);
    expect(findNextSample(10, 5, true, (i) => matchAt.has(i))).toBe(2);
    expect(findNextSample(10, 2, true, (i) => matchAt.has(i))).toBe(7); // wraps around
  });

  it("never matches `from` itself", () => {
    // Only index 5 satisfies the predicate, but from=5 — every OTHER index is scanned and
    // rejected, so this correctly reports no match rather than "matching" its own start point.
    expect(findNextSample(10, 5, false, (i) => i === 5)).toBeUndefined();
  });

  it("returns undefined when nothing matches", () => {
    expect(findNextSample(10, 5, false, () => false)).toBeUndefined();
  });

  it("treats from=-1 as 'search from the start' going forward", () => {
    expect(findNextSample(10, -1, false, (i) => i === 0)).toBe(0);
  });

  it("cycles through every matching sample on repeated calls, one match per click", () => {
    const matchAt = [1, 4, 8];
    let from = -1;
    const seen: number[] = [];
    for (let i = 0; i < matchAt.length; i++) {
      const k = findNextSample(10, from, false, (idx) => matchAt.includes(idx));
      expect(k).toBeDefined();
      seen.push(k!);
      from = k!;
    }
    expect(seen).toEqual(matchAt);
    // One more click wraps back to the first match.
    expect(findNextSample(10, from, false, (idx) => matchAt.includes(idx))).toBe(matchAt[0]);
  });
});
