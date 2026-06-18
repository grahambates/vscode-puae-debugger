import { decodeProfileStream, buildCallTree, applyContextReuse, syntheticLabel, InstructionSample } from "../profilerManager";
import { SourceMap } from "../sourceMap";

// Minimal SourceMap stand-in exposing only what buildCallTree uses.
function fakeSourceMap(names: Record<number, string>): SourceMap {
  return {
    findSymbolOffset: (pc: number) => (names[pc] ? { symbol: names[pc], offset: 0 } : undefined),
    lookupAddress: (pc: number) => ({ path: "x.c", line: pc, address: pc, segmentIndex: 0, segmentOffset: 0 }),
    findSegmentForAddress: () => ({}), // all test PCs are "in program"
    getCfaForPc: () => ({ reg: 15, offset: 0 }), // all test PCs have CFI (not no-debug blobs)
    getUnwindRows: () => [{}], // non-empty -> a DWARF program (blob-nesting enabled)
  } as unknown as SourceMap;
}

describe("decodeProfileStream", () => {
  it("decodes [depth, ...pcs, cycles] records leaf-first", () => {
    const words = new Uint32Array([2, 0x100, 0x200, 10, 1, 0x100, 5]);
    expect(decodeProfileStream(words)).toEqual<InstructionSample[]>([
      { stack: [0x100, 0x200], cycles: 10 },
      { stack: [0x100], cycles: 5 },
    ]);
  });

  it("stops on a zero/implausible depth", () => {
    const words = new Uint32Array([1, 0x100, 7, 0 /* depth 0 -> stop */, 0x999]);
    expect(decodeProfileStream(words)).toEqual([{ stack: [0x100], cycles: 7 }]);
  });

  it("stops cleanly on a truncated final record", () => {
    const words = new Uint32Array([2, 0x100]); // claims depth 2 but is cut off
    expect(decodeProfileStream(words)).toEqual([]);
  });
});

describe("buildCallTree", () => {
  const sm = fakeSourceMap({ 0x100: "funcA", 0x200: "funcB" });
  const samples: InstructionSample[] = [
    { stack: [0x100, 0x200], cycles: 10 }, // A called from B
    { stack: [0x100], cycles: 5 }, // A at top level
  ];
  const result = buildCallTree(samples, sm);

  it("aggregates totals and self time root-first", () => {
    expect(result.totalCycles).toBe(15);
    expect(result.sampleCount).toBe(2);
    expect(result.root.total).toBe(15);

    const byFunc = (n: { frame: number }) => result.uniqueFrames[n.frame].func;
    const top = result.root.children;
    const b = top.find((c) => byFunc(c) === "funcB")!;
    const aTop = top.find((c) => byFunc(c) === "funcA")!;

    expect(b.total).toBe(10);
    expect(b.self).toBe(0);
    expect(aTop.total).toBe(5);
    expect(aTop.self).toBe(5);

    const aUnderB = b.children.find((c) => byFunc(c) === "funcA")!;
    expect(aUnderB.total).toBe(10);
    expect(aUnderB.self).toBe(10);
  });

  it("interns each distinct PC exactly once", () => {
    expect(result.uniqueFrames).toHaveLength(2);
    expect(result.uniqueFrames.map((f) => f.func).sort()).toEqual(["funcA", "funcB"]);
  });
});

describe("applyContextReuse", () => {
  // 0x900 is a no-debug blob (in a segment, but no CFI — like an #embed'd binary called
  // via jsr); 0x100/0x200 are real C frames (have CFI). getUnwindRows non-empty => DWARF.
  const sm = {
    findSegmentForAddress: () => ({}), // everything is in a loaded program segment
    getCfaForPc: (pc: number) => (pc === 0x900 ? undefined : { reg: 15, offset: 0 }),
    getUnwindRows: () => [{}],
  } as unknown as SourceMap;
  // Pure-assembly capture: no DWARF at all (getUnwindRows empty, getCfaForPc always undefined).
  const asmSm = {
    findSegmentForAddress: () => ({}),
    getCfaForPc: () => undefined,
    getUnwindRows: () => [],
  } as unknown as SourceMap;

  it("nests a depth-1 no-CFI blob leaf under the previous program stack", () => {
    const out = applyContextReuse(
      [
        { stack: [0x100, 0x200], cycles: 10 }, // real C: leaf 0x100 called from 0x200
        { stack: [0x900], cycles: 5 }, // blob, depth-1, no CFI -> should inherit context
      ],
      sm,
    );
    expect(out[0].stack).toEqual([0x100, 0x200]);
    expect(out[1].stack).toEqual([0x900, 0x100, 0x200]); // nested below its caller
  });

  it("leaves a depth-1 leaf WITH CFI (a real root) at the root", () => {
    const out = applyContextReuse(
      [
        { stack: [0x100, 0x200], cycles: 10 },
        { stack: [0x300], cycles: 5 }, // has CFI -> genuine root, not a blob
      ],
      sm,
    );
    expect(out[1].stack).toEqual([0x300]);
  });

  it("does NOT blob-nest depth-1 leaves in a pure-assembly capture (no DWARF)", () => {
    // In branch-stack mode every leaf lacks CFI and depth-1 is legitimate (shadow stack);
    // 0x300 must stay a root, not be nested under the previous stack.
    const out = applyContextReuse(
      [
        { stack: [0x100, 0x200], cycles: 10 },
        { stack: [0x300], cycles: 5 },
      ],
      asmSm,
    );
    expect(out[1].stack).toEqual([0x300]);
  });
});

describe("syntheticLabel", () => {
  const sm = (overrides: Partial<Record<string, unknown>>) =>
    ({ findSymbolOffset: () => undefined, findSegmentForAddress: () => undefined, ...overrides }) as unknown as SourceMap;

  it("symbolizes a Kickstart ROM PC as [Kick] <name> when ROM symbols are loaded", () => {
    const out = syntheticLabel(0xf80100, sm({ findSymbolOffset: () => ({ symbol: "WaitBlit", offset: 4 }) }));
    expect(out).toBe("[Kick] WaitBlit");
  });

  it("falls back to flat [Kickstart] for a ROM PC with no symbols", () => {
    expect(syntheticLabel(0xf80100, sm({}))).toBe("[Kickstart]");
  });

  it("labels the IRQ marker, external, and (un)labels in-program code", () => {
    expect(syntheticLabel(0xfffffffe, sm({}))).toBe("[IRQ]");
    expect(syntheticLabel(0x5000, sm({}))).toBe("[External]"); // no segment -> external
    expect(syntheticLabel(0x5000, sm({ findSegmentForAddress: () => ({}) }))).toBeUndefined(); // in a segment -> program
  });
});
