import { decodeProfileStream, buildCallTree, InstructionSample } from "../profilerManager";
import { SourceMap } from "../sourceMap";

// Minimal SourceMap stand-in exposing only what buildCallTree uses.
function fakeSourceMap(names: Record<number, string>): SourceMap {
  return {
    findSymbolOffset: (pc: number) => (names[pc] ? { symbol: names[pc], offset: 0 } : undefined),
    lookupAddress: (pc: number) => ({ path: "x.c", line: pc, address: pc, segmentIndex: 0, segmentOffset: 0 }),
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
