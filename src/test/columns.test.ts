import { buildColumns, columnIndexAtX, columnIndexToSlot, findLineExecutionSlot, findNextSample, IColumn } from "../webview/profilerViewer/columns";
import { BusOwner, DMA_CODE, IDisassembledFunction, IDisassembledInstruction, IProfileModel } from "../shared/profilerTypes";

const columns: IColumn[] = [
  { x1: 0, x2: 0.25, rows: [] },
  { x1: 0.25, x2: 0.5, rows: [] },
  { x1: 0.5, x2: 0.75, rows: [] },
  { x1: 0.75, x2: 1, rows: [] },
];

describe("buildColumns (DMA-anchored positions)", () => {
  // 4 samples, uniform cycle cost — under the old cycle-fraction model these would land at
  // x1 = 0, 0.25, 0.5, 0.75 (of a 100-slot grid: 0, 25, 50, 75). The DMA grid instead records the
  // *real* fetch slot for samples 0, 2, 3 (10, 40, 50) with no cell for sample 1 (0x1002) — as if
  // its opcode word was still sitting in the prefetch queue — which must be recovered by
  // interpolating between samples 0 and 2's real slots (10 and 40), not by dividing cycle cost.
  const N = 100;
  const owner = new Uint8Array(N);
  const flags = new Uint8Array(N);
  const addr = new Uint32Array(N);
  const value = new Uint16Array(N);
  const fetch = (slot: number, pc: number) => {
    owner[slot] = BusOwner.CPU;
    flags[slot] = DMA_CODE;
    addr[slot] = pc;
  };
  fetch(10, 0x1000);
  // slot for 0x1002 deliberately omitted (unmatched sample).
  fetch(40, 0x1004);
  fetch(50, 0x1006);

  const model: IProfileModel = {
    nodes: [
      { id: 0, selfTime: 0, aggregateTime: 0, children: [1], locationId: 0 },
      { id: 1, selfTime: 0, aggregateTime: 0, children: [], locationId: 0, parent: 0 },
    ],
    locations: [{ id: 0, selfTime: 0, aggregateTime: 0, category: 1, address: 0x1000,
      callFrame: { functionName: "fn", url: "a.c", scriptId: "0", lineNumber: 10, columnNumber: 0 } }],
    samples: [0, 1, 1, 1, 1],
    timeDeltas: [5, 5, 5, 5],
    pcs: [0x1000, 0x1002, 0x1004, 0x1006],
    duration: 20,
    cyclesPerMicroSecond: 7.09379,
    dma: { owner, flags, addr, value },
  };

  it("positions matched samples at their real DMA slot, not a cycle-cost fraction", () => {
    const columns = buildColumns(model);
    expect(columns[0].x1).toBeCloseTo(10 / N, 6); // sample 0 -> real slot 10, not 0
    expect(columns[2].x1).toBeCloseTo(40 / N, 6); // sample 2 -> real slot 40, not 0.5
    expect(columns[3].x1).toBeCloseTo(50 / N, 6); // sample 3 -> real slot 50, not 0.75
    expect(columns[3].x2).toBe(1); // last column always closes out the frame
  });

  it("interpolates an unmatched sample between its matched neighbours", () => {
    const columns = buildColumns(model);
    // Sample 1 (0x1002) has no fetch cell: interpolated midway between slots 10 and 40 -> 25.
    expect(columns[1].x1).toBeCloseTo(25 / N, 6);
  });

  it("falls back to the cycle-cost fraction when the grid has no matching CPU/CODE cells", () => {
    const noMatches: IProfileModel = {
      ...model,
      dma: { owner: new Uint8Array(N), flags: new Uint8Array(N), addr: new Uint32Array(N), value: new Uint16Array(N) },
    };
    const columns = buildColumns(noMatches);
    expect(columns[0].x1).toBe(0);
    expect(columns[1].x1).toBeCloseTo(0.25, 6);
  });

  // Regression test for a real bug report: a long-running loop where sample 0's own opcode fetch
  // never got recorded (it was already in the 68000's prefetch queue when recording turned on),
  // so its address doesn't reappear in the grid until the *next* lap of the loop — many cells
  // later. Searching for sample 0's address across the whole grid used to latch onto that later
  // lap, rendering a large, spurious empty gap at the start of the flame graph even though sample
  // 1 (and everything after it) genuinely started almost immediately.
  it("anchors on an early sample instead of a later same-address loop revisit for sample 0", () => {
    const M = 1000;
    const owner = new Uint8Array(M);
    const flags = new Uint8Array(M);
    const addr = new Uint32Array(M);
    const value = new Uint16Array(M);
    const fetch = (slot: number, pc: number) => {
      owner[slot] = BusOwner.CPU;
      flags[slot] = DMA_CODE;
      addr[slot] = pc;
    };
    // Sample 0's own address (0x2000) has NO cell near the true start — it only reappears at
    // slot 900, on the loop's next lap. Sample 1 (0x2004, the very next instruction) is fetched
    // normally and shows up right away, at slot 20.
    fetch(20, 0x2004);
    fetch(30, 0x2006);
    fetch(900, 0x2000); // the "next lap" revisit — must NOT be picked as sample 0's anchor.

    const loopModel: IProfileModel = {
      ...model,
      samples: [0, 1, 1, 1],
      timeDeltas: [5, 5, 5],
      pcs: [0x2000, 0x2004, 0x2006],
      duration: 15,
      dma: { owner, flags, addr, value },
    };
    const columns = buildColumns(loopModel);
    // Sample 0 must clamp to sample 1's real (early) slot, not jump to the loop-revisit slot 900.
    expect(columns[0].x1).toBeCloseTo(20 / M, 6);
    expect(columns[1].x1).toBeCloseTo(20 / M, 6);
    expect(columns[2].x1).toBeCloseTo(30 / M, 6);
  });

  // Regression test for a code-review finding on the fix above: checking only the EARLIEST grid
  // position among the first ANCHOR_CANDIDATES samples (with no further validation) can itself
  // pick a wrong anchor if one of those samples' addresses happens to also occur earlier for an
  // unrelated reason — e.g. a shared subroutine an interrupt handler calls moments before the
  // profiled program's own code starts. That coincidental occurrence has nothing executing near
  // it that belongs to the profiled run, unlike the genuine start.
  it("rejects a coincidental earlier same-address match with no nearby confirming run", () => {
    const M = 5000;
    const owner = new Uint8Array(M);
    const flags = new Uint8Array(M);
    const addr = new Uint32Array(M);
    const value = new Uint16Array(M);
    const fetch = (slot: number, pc: number) => {
      owner[slot] = BusOwner.CPU;
      flags[slot] = DMA_CODE;
      addr[slot] = pc;
    };
    // A coincidental earlier occurrence of sample 0's address, with nothing nearby confirming
    // it's part of a real run of the profiled program.
    fetch(5, 0xA000);
    // The genuine run, far enough away (beyond CODE_MATCH_WINDOW) that it can't confirm slot 5.
    fetch(3005, 0xA004);
    fetch(3010, 0xA008);

    const runModel: IProfileModel = {
      ...model,
      samples: [0, 1, 1, 1],
      timeDeltas: [5, 5, 5],
      pcs: [0xA000, 0xA004, 0xA008],
      duration: 15,
      dma: { owner, flags, addr, value },
    };
    const columns = buildColumns(runModel);
    // Must NOT anchor on the coincidental slot 5 match; sample 0 clamps to the genuine run instead.
    expect(columns[0].x1).toBeCloseTo(3005 / M, 6);
    expect(columns[1].x1).toBeCloseTo(3005 / M, 6);
    expect(columns[2].x1).toBeCloseTo(3010 / M, 6);
  });

  // Regression test for a real bug report: on a 68020 the I-cache means most instructions never
  // emit a fetch cell at all (a whole captured frame offered 10,028 cells for 31,078 executed
  // instructions), and a busy-wait spin loop emits almost none — so long runs of samples get
  // interpolated rather than matched. Spreading such a run by sample INDEX assumes every sample
  // costs the same, which is exactly what a spin loop violates: it retires far more instructions
  // per cycle than the real work around it, so it swallows width that belongs to the work.
  it("spreads an unmatched run by cycle cost, not by sample count", () => {
    const M = 1000;
    const owner = new Uint8Array(M);
    const flags = new Uint8Array(M);
    const addr = new Uint32Array(M);
    const value = new Uint16Array(M);
    const fetch = (slot: number, pc: number) => {
      owner[slot] = BusOwner.CPU;
      flags[slot] = DMA_CODE;
      addr[slot] = pc;
    };
    // Samples 1 and 6 both match a real fetch cell, 400 slots apart. Samples 2-5 fall between
    // them with no cell of their own: three cheap spin samples (1 cycle each) and one expensive
    // one (297 cycles). (Sample 0 anchors and sample 1 confirms it — see the tests above.)
    fetch(100, 0x3000);
    fetch(105, 0x3004);
    fetch(505, 0x3014);

    const spinModel: IProfileModel = {
      ...model,
      samples: [0, 1, 1, 1, 1, 1, 1],
      timeDeltas: [1, 1, 1, 1, 297, 1],
      pcs: [0x3000, 0x3004, 0x3008, 0x300c, 0x3010, 0x3014],
      duration: 302,
      dma: { owner, flags, addr, value },
    };
    const columns = buildColumns(spinModel);
    expect(columns[0].x1).toBeCloseTo(100 / M, 6);
    expect(columns[1].x1).toBeCloseTo(105 / M, 6);
    // Samples 2-4 span 400 slots and 300 cycles between the anchors at 105 and 505. The two
    // cheap samples sit 1 and 2 cycles in, so they stay bunched against the left anchor...
    expect(columns[2].x1).toBeCloseTo((105 + Math.round((400 * 1) / 300)) / M, 6);
    expect(columns[3].x1).toBeCloseTo((105 + Math.round((400 * 2) / 300)) / M, 6);
    expect(columns[4].x1).toBeCloseTo((105 + Math.round((400 * 3) / 300)) / M, 6);
    // ...rather than each taking a quarter of the span, as spreading by sample index would give.
    expect(columns[4].x1).toBeLessThan((105 + (400 * 3) / 4) / M);
    // The expensive sample gets essentially the whole gap, closing on the right anchor.
    expect(columns[4].x2 - columns[4].x1).toBeGreaterThan((400 * 0.95) / M);
    expect(columns[5].x1).toBeCloseTo(505 / M, 6);
  });

  // Regression test for the same bug report: once one spin puts the matcher's cursor more than
  // CODE_MATCH_WINDOW behind the raster, the bounded forward search can never catch back up, so
  // matching stops for the rest of the frame (measured: dead at sample 1,907 of 31,078). Clamping
  // that whole trailing run onto the last matched slot gives every one of those samples zero
  // width and lets the single final column stretch across everything they should have covered —
  // which is how a busy-wait ended up rendered as 91.5% of a frame it actually spent 14.5% of.
  // A grid slot is one color clock and timeDeltas are color clocks, so the run extrapolates
  // directly at one slot per cycle.
  it("extrapolates a trailing unmatched run by cycles instead of collapsing it onto one slot", () => {
    const M = 1000;
    const owner = new Uint8Array(M);
    const flags = new Uint8Array(M);
    const addr = new Uint32Array(M);
    const value = new Uint16Array(M);
    owner[100] = BusOwner.CPU;
    flags[100] = DMA_CODE;
    addr[100] = 0x4000;
    // Only sample 0 ever matches; samples 1-3 are the trailing run.
    const tailModel: IProfileModel = {
      ...model,
      samples: [0, 1, 1, 1, 1],
      timeDeltas: [50, 200, 50, 1],
      pcs: [0x4000, 0x4004, 0x4008, 0x400c],
      duration: 301,
      dma: { owner, flags, addr, value },
    };
    const columns = buildColumns(tailModel);
    expect(columns[0].x1).toBeCloseTo(100 / M, 6);
    expect(columns[1].x1).toBeCloseTo(150 / M, 6); // +50 cycles
    expect(columns[2].x1).toBeCloseTo(350 / M, 6); // +200
    expect(columns[3].x1).toBeCloseTo(400 / M, 6); // +50
    // Each trailing sample gets real width proportional to its cost, rather than all three
    // collapsing to slot 100 and leaving the last column to span the remaining 90% of the frame.
    expect(columns[1].x2 - columns[1].x1).toBeCloseTo(200 / M, 6);
    expect(columns[2].x2 - columns[2].x1).toBeCloseTo(50 / M, 6);
  });
});

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
    end: 0x1006,
    name: "fn",
    totalCycles: 3,
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
