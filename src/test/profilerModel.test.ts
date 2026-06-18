import { buildProfileModel, InstructionSample } from "../profilerManager";
import { buildColumns } from "../webview/profilerViewer/columns";
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
