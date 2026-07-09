import { buildColumns, columnIndexAtX, columnIndexToSlot, findLineExecutionSlot, findNextSample, IColumn } from "../webview/profilerViewer/columns";
import { IDisassembledFunction, IDisassembledInstruction, IProfileModel } from "../shared/profilerTypes";

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

describe("findLineExecutionSlot", () => {
  // 5 samples: pcs 0x1000/0x1002 are on line 10 (two instructions the line compiled to);
  // 0x1004 is on line 20. samples[0] is the dummy per IProfileModel's convention; every real
  // sample shares one leaf node/location (irrelevant to this function — it only reads pcs).
  const ins = (address: number, file: string, line: number): IDisassembledInstruction => ({
    address, hex: "0000", text: "nop", length: 2, hits: 1, cycles: 1, file, line,
  });
  const fn: IDisassembledFunction = {
    address: 0x1000,
    name: "fn",
    instructions: [
      ins(0x1000, "a.c", 10),
      ins(0x1002, "a.c", 10),
      ins(0x1004, "a.c", 20),
    ],
  };
  const model: IProfileModel = {
    // nodes[0] is the synthetic root (array index, not .id — buildColumns indexes model.nodes[]
    // positionally via model.samples[i]/leaf.parent, matching IProfileModel's own convention of
    // "node 0" as root). nodes[1] is the one real leaf every sample below maps to; parent:0 is
    // falsy, so buildColumns' parent-walk stops immediately without needing a real root node.
    nodes: [
      { id: 0, selfTime: 0, aggregateTime: 0, children: [1], locationId: 0 },
      { id: 1, selfTime: 0, aggregateTime: 0, children: [], locationId: 0, parent: 0 },
    ],
    locations: [{ id: 0, selfTime: 0, aggregateTime: 0, category: 1, address: 0x1000,
      callFrame: { functionName: "fn", url: "a.c", scriptId: "0", lineNumber: 10, columnNumber: 0 } }],
    samples: [0, 1, 1, 1, 1, 1],
    timeDeltas: [1, 1, 1, 1, 1],
    pcs: [0x1000, 0x1002, 0x1004, 0x1000, 0x1002],
    duration: 5,
    cyclesPerMicroSecond: 7.09379,
    dma: { owner: new Uint8Array(100), flags: new Uint8Array(100), addr: new Uint32Array(100), value: new Uint16Array(100) },
    disassembly: [fn],
  };
  const sameFile = (a: string, b: string) => a === b;

  it("finds the first matching execution when starting with no current slot", () => {
    const slot = findLineExecutionSlot(model, "a.c", 10, undefined, sameFile);
    expect(slot).toBeDefined();
    // Column 0 (sample index 0, pcs[0]=0x1000) — resolves back to column 0.
    expect(columnIndexAtX(buildColumns(model), (slot! + 0.5) / 100)).toBe(0);
  });

  it("cycles to the next matching sample when already at a match", () => {
    const first = findLineExecutionSlot(model, "a.c", 10, undefined, sameFile)!;
    const second = findLineExecutionSlot(model, "a.c", 10, first, sameFile)!;
    expect(columnIndexAtX(buildColumns(model), (second + 0.5) / 100)).toBe(1); // next matching sample
  });

  it("returns undefined for a line with no instructions", () => {
    expect(findLineExecutionSlot(model, "a.c", 999, undefined, sameFile)).toBeUndefined();
  });

  it("returns undefined when isSameFile rejects every candidate", () => {
    expect(findLineExecutionSlot(model, "a.c", 10, undefined, () => false)).toBeUndefined();
  });

  it("returns undefined when the model has no DMA trace", () => {
    const noDma: IProfileModel = { ...model, dma: undefined };
    expect(findLineExecutionSlot(noDma, "a.c", 10, undefined, sameFile)).toBeUndefined();
  });
});
