import { buildProfileModel, InstructionSample } from "../profilerManager";
import { buildColumns, columnIndexAtX } from "../webview/profilerViewer/columns";
import { Category } from "../shared/profilerTypes";
import { SourceMap } from "../sourceMap";

// Minimal SourceMap stub: only the two methods symbolicate() touches.
function stubSourceMap(): SourceMap {
  const names: Record<number, string> = { 0x100: "_start", 0x200: "fib" };
  const lines: Record<number, number> = { 0x100: 1, 0x200: 5 };
  return {
    findSymbolOffset: (pc: number) => (names[pc] ? { symbol: names[pc], offset: 0 } : undefined),
    lookupAddress: (pc: number) => (names[pc] ? { path: "a.c", line: lines[pc] } : undefined),
    findSegmentForAddress: () => ({}), // all test PCs are "in program"
    getCfaForPc: () => ({ reg: 15, offset: 0 }), // all test PCs have CFI (not no-debug blobs)
    getUnwindRows: () => [{}], // non-empty -> a DWARF program (blob-nesting enabled)
  } as unknown as SourceMap;
}

// Tiny synthetic capture: _start calls fib (twice, contiguously), then runs alone.
// Stacks are leaf-first, as the emulator emits them.
const samples: InstructionSample[] = [
  { stack: [0x100], cycles: 4 }, // _start
  { stack: [0x200, 0x100], cycles: 10 }, // fib under _start
  { stack: [0x200, 0x100], cycles: 6 }, // same path again
  { stack: [0x100], cycles: 4 }, // back in _start
];

describe("buildProfileModel", () => {
  const model = buildProfileModel(samples, stubSourceMap());

  it("interns one location per PC plus the synthetic root", () => {
    expect(model.locations.length).toBe(3); // (all), _start, fib
    expect(model.locations[0].callFrame.functionName).toBe("(all)");
    expect(model.locations[1].callFrame.functionName).toBe("_start");
    expect(model.locations[1].callFrame.url).toBe("a.c");
    expect(model.locations[1].callFrame.lineNumber).toBe(1);
    expect(model.locations[1].address).toBe(0x100); // retained PC for coverage/disasm
  });

  it("builds the call tree with parent links to the synthetic root", () => {
    expect(model.nodes.length).toBe(3); // root, _start, fib
    const startNode = model.nodes[1];
    const fibNode = model.nodes[2];
    expect(startNode.parent).toBe(0);
    expect(fibNode.parent).toBe(1);
  });

  it("emits time-ordered samples/timeDeltas (samples[0] is the dummy)", () => {
    expect(model.samples).toEqual([0, 1, 2, 2, 1]);
    expect(model.timeDeltas).toEqual([4, 10, 6, 4]);
    expect(model.duration).toBe(24);
  });

  it("accumulates self/aggregate time", () => {
    expect(model.nodes[1].selfTime).toBe(8); // _start leaf: 4 + 4
    expect(model.nodes[2].selfTime).toBe(16); // fib leaf: 10 + 6
    expect(model.nodes[1].aggregateTime).toBe(24); // _start subtree = whole frame
    expect(model.nodes[2].aggregateTime).toBe(16);
  });

  it("categorises a location with no source as System", () => {
    const m = buildProfileModel([{ stack: [0x999], cycles: 3 }], stubSourceMap());
    const loc = m.locations[m.nodes[m.samples[1]].locationId];
    expect(loc.category).toBe(Category.System);
    expect(loc.callFrame.url).toBe("");
  });

  it("carries the PAL CPU clock (NTSC deferred)", () => {
    expect(model.cyclesPerMicroSecond).toBeCloseTo(7.09379, 5);
  });
});

// SourceMap stub with DWARF inline info: PC 0x400 sits in physical function "F", with
// "A" inlined into F (call site f.c:5) and "B" inlined into A (call site a.c:20); the
// instruction's own line is f.c:30. getInlineFramesForPc returns innermost-first.
function inlineStubSourceMap(): SourceMap {
  return {
    findSymbolOffset: (pc: number) => (pc === 0x400 ? { symbol: "F", offset: 0 } : undefined),
    lookupAddress: (pc: number) => (pc === 0x400 ? { path: "f.c", line: 30 } : undefined),
    getInlineFramesForPc: (pc: number) =>
      pc === 0x400
        ? [
            { name: "B", callPath: "a.c", callLine: 20 }, // innermost: B's call site (in A)
            { name: "A", callPath: "f.c", callLine: 5 }, //  outer: A's call site (in F)
          ]
        : [],
    findSegmentForAddress: () => ({}), // all test PCs are "in program"
    getCfaForPc: () => ({ reg: 15, offset: 0 }), // all test PCs have CFI (not no-debug blobs)
    getUnwindRows: () => [{}], // non-empty -> a DWARF program (blob-nesting enabled)
  } as unknown as SourceMap;
}

describe("buildProfileModel inline expansion", () => {
  const model = buildProfileModel([{ stack: [0x400], cycles: 7 }], inlineStubSourceMap());

  it("expands a PC into physical + inlined frames (outermost→innermost)", () => {
    // root + F + A + B
    expect(model.nodes.length).toBe(4);
    const names = model.nodes.map((n) => model.locations[n.locationId].callFrame.functionName);
    expect(names).toEqual(["(all)", "F", "A (inlined)", "B (inlined)"]);
    // parent chain root→F→A→B
    expect(model.nodes[1].parent).toBe(0);
    expect(model.nodes[2].parent).toBe(1);
    expect(model.nodes[3].parent).toBe(2);
  });

  it("attributes each frame's line to the next-inner call site (addr2line --inlines)", () => {
    const lineOf = (id: number) => model.locations[model.nodes[id].locationId].callFrame.lineNumber;
    expect(lineOf(1)).toBe(5); // F shown where A is called (f.c:5)
    expect(lineOf(2)).toBe(20); // A shown where B is called (a.c:20)
    expect(lineOf(3)).toBe(30); // B (innermost) shown at the instruction's own line
  });

  it("attributes self time to the innermost inlined frame", () => {
    expect(model.nodes[3].selfTime).toBe(7); // B is the leaf
    expect(model.nodes[1].selfTime).toBe(0);
  });
});

describe("buildColumns", () => {
  const model = buildProfileModel(samples, stubSourceMap());
  const columns = buildColumns(model);

  it("produces one column per instruction spanning the full frame", () => {
    expect(columns.length).toBe(4);
    expect(columns[0].x1).toBe(0);
    expect(columns[columns.length - 1].x2).toBeCloseTo(1, 10);
  });

  it("merges contiguous identical stacks into numeric run references", () => {
    // _start runs across every column → all merge back to column 0.
    expect(columns[1].rows[0]).toBe(0);
    expect(columns[2].rows[0]).toBe(0);
    // The leaf-most cell of the first column is the real _start frame.
    const first = columns[0].rows[0];
    expect(typeof first).toBe("object");
    expect((first as { callFrame: { functionName: string } }).callFrame.functionName).toBe("_start");
  });
});

// Regression test for a bug where the Disassembly view's "current instruction" tracking only
// ever showed the function's FIRST-ever-sampled address while scrubbing, never the real
// instruction at the scrubbed cycle — because locations are deduped per function (internLocation
// keys on functionName:file), so `locations[locId].address` is frozen to whichever PC first
// created that location, shared by every sample in that function. buildColumns must instead use
// model.pcs (the exact per-sample PC, parallel to timeDeltas) for each column's leaf cell.
describe("buildColumns: leaf cell address is the exact per-sample PC, not the function's", () => {
  function stubSourceMapOneFuncTwoPcs(): SourceMap {
    const fibAddrs = new Set([0x200, 0x204]);
    return {
      findSymbolOffset: (pc: number) => (fibAddrs.has(pc) ? { symbol: "fib", offset: pc - 0x200 } : pc === 0x100 ? { symbol: "_start", offset: 0 } : undefined),
      lookupAddress: () => ({ path: "a.c", line: 5 }),
      findSegmentForAddress: () => ({}),
      getCfaForPc: () => ({ reg: 15, offset: 0 }),
      getUnwindRows: () => [{}],
    } as unknown as SourceMap;
  }

  // fib (0x200), then _start (breaks the run so the two fib columns don't merge), then fib
  // again at a DIFFERENT instruction (0x204) — re-entering the same function elsewhere.
  const twoPcSamples: InstructionSample[] = [
    { stack: [0x200], cycles: 5 },
    { stack: [0x100], cycles: 3 },
    { stack: [0x204], cycles: 5 },
  ];
  const model = buildProfileModel(twoPcSamples, stubSourceMapOneFuncTwoPcs());
  const columns = buildColumns(model);

  it("confirms the dedup: both fib samples share one location, frozen to the first PC", () => {
    const fibLocId = model.nodes[model.samples[1]].locationId;
    expect(model.nodes[model.samples[3]].locationId).toBe(fibLocId); // same location both times
    expect(model.locations[fibLocId].address).toBe(0x200); // frozen — NOT instruction-accurate
  });

  it("still preserves the exact per-sample PC separately", () => {
    expect(model.pcs).toEqual([0x200, 0x100, 0x204]);
  });

  it("gives each non-merged column its own exact leaf address", () => {
    expect(columns).toHaveLength(3);
    const leafAddr = (i: number) => (columns[i].rows[columns[i].rows.length - 1] as { address: number }).address;
    expect(leafAddr(0)).toBe(0x200); // first fib sample
    expect(leafAddr(2)).toBe(0x204); // second fib sample — was wrongly 0x200 before the fix
  });
});

// Regression test for a SECOND bug, found after the first fix: within a hot loop (many
// different instructions, all in the same function, sampled on CONSECUTIVE columns), buildColumns'
// merge pass (for flame-graph rendering) coalesces the whole run into one box — so resolving
// through columns[].rows (resolveStackAtX) always returns that run's FIRST instruction, frozen,
// no matter where within the run you actually are. The Disassembly view's "current instruction"
// must instead read model.pcs directly via columnIndexAtX (column x1/x2 boundaries — set once,
// never touched by the merge pass), bypassing the row-merge entirely.
describe("columnIndexAtX + model.pcs: exact instruction within a coalesced (merged) run", () => {
  function stubSourceMapLoop(): SourceMap {
    const loopAddrs = new Set([0x200, 0x202, 0x204]);
    return {
      findSymbolOffset: (pc: number) => (loopAddrs.has(pc) ? { symbol: "loop", offset: pc - 0x200 } : undefined),
      lookupAddress: () => ({ path: "a.c", line: 5 }),
      findSegmentForAddress: () => ({}),
      getCfaForPc: () => ({ reg: 15, offset: 0 }),
      getUnwindRows: () => [{}],
    } as unknown as SourceMap;
  }

  // Three different instructions of ONE loop, sampled back-to-back — contiguous, so they merge
  // into a single flame box (same function every column).
  const loopSamples: InstructionSample[] = [
    { stack: [0x200], cycles: 2 },
    { stack: [0x202], cycles: 2 },
    { stack: [0x204], cycles: 2 },
  ];
  const model = buildProfileModel(loopSamples, stubSourceMapLoop());
  const columns = buildColumns(model);

  it("confirms the three columns DO merge in .rows (resolveStackAtX would be frozen)", () => {
    expect(columns[1].rows[0]).toBe(0); // merged: "see column 0"
    expect(columns[2].rows[0]).toBe(0); // merged: "see column 0"
  });

  it("columnIndexAtX + model.pcs still resolves the real, distinct instruction at each x", () => {
    // Frame duration is 6 cycles (2+2+2); column k covers [k*2, k*2+2)/6.
    expect(model.pcs[columnIndexAtX(columns, 0.5 / 6)]).toBe(0x200); // inside column 0
    expect(model.pcs[columnIndexAtX(columns, 2.5 / 6)]).toBe(0x202); // inside column 1 — NOT frozen at 0x200
    expect(model.pcs[columnIndexAtX(columns, 4.5 / 6)]).toBe(0x204); // inside column 2 — NOT frozen at 0x200
  });
});
