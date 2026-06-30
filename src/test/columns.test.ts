import { columnIndexAtX, columnIndexToSlot, IColumn } from "../webview/profilerViewer/columns";

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
