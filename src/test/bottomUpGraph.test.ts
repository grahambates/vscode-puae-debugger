import { createBottomUpGraph } from "../webview/profilerViewer/bottomUpGraph";
import { buildProfileModel, InstructionSample } from "../profilerManager";
import { SourceMap } from "../sourceMap";

// A function name per address, all non-inlined, all "in program" with CFI (so
// applyContextReuse's no-debug-blob nesting never kicks in and stacks pass through as-is).
const NAMES: Record<number, string> = { 0x100: "leaf", 0x200: "callerA", 0x300: "callerB", 0x400: "callerC" };
function stubSourceMap(): SourceMap {
  return {
    findSymbolOffset: (pc: number) => (NAMES[pc] ? { symbol: NAMES[pc], offset: 0 } : undefined),
    lookupAddress: (pc: number) => (NAMES[pc] ? { path: "a.c", line: 1 } : undefined),
    findSegmentForAddress: () => ({}),
    getCfaForPc: () => ({ reg: 15, offset: 0 }),
    getUnwindRows: () => [{}],
  } as unknown as SourceMap;
}

describe("createBottomUpGraph", () => {
  it("groups a leaf called from two different callers under one root-level entry", () => {
    // leaf() called from callerA() (10 cycles) and from callerB() (30 cycles).
    const samples: InstructionSample[] = [
      { stack: [0x100, 0x200], cycles: 10 },
      { stack: [0x100, 0x300], cycles: 30 },
    ];
    const model = buildProfileModel(samples, stubSourceMap());
    const top = Object.values(createBottomUpGraph(model).children);

    // One root-level entry for "leaf", aggregating both call paths.
    expect(top.map((n) => n.callFrame.functionName)).toEqual(["leaf"]);
    const leaf = top[0];
    expect(leaf.selfTime + leaf.aggregateTime).toBeGreaterThan(0);

    // Its children are the two distinct callers, reversed (leaf→caller).
    const callers = Object.values(leaf.children).map((n) => n.callFrame.functionName).sort();
    expect(callers).toEqual(["callerA", "callerB"]);
  });

  it("keeps two independent leaves as separate root-level entries", () => {
    const samples: InstructionSample[] = [
      { stack: [0x100, 0x200], cycles: 10 }, // leaf via callerA
      { stack: [0x300], cycles: 5 }, // callerB itself is a leaf (depth-1, no caller)
    ];
    const model = buildProfileModel(samples, stubSourceMap());
    const top = Object.values(createBottomUpGraph(model).children);
    expect(top.map((n) => n.callFrame.functionName).sort()).toEqual(["callerB", "leaf"]);

    // callerB was sampled as a depth-1 leaf directly under the synthetic root — no further
    // reversed levels (node.parent === 0 stops the walk, see bottomUpGraph.ts).
    const callerB = top.find((n) => n.callFrame.functionName === "callerB")!;
    expect(callerB.childrenSize).toBe(0);
  });

  it("reverses a 3-deep chain into a single caller-chain path", () => {
    // leaf() called from callerA() called from callerC().
    const samples: InstructionSample[] = [{ stack: [0x100, 0x200, 0x400], cycles: 7 }];
    const model = buildProfileModel(samples, stubSourceMap());
    const top = Object.values(createBottomUpGraph(model).children);
    expect(top.map((n) => n.callFrame.functionName)).toEqual(["leaf"]);

    const callerA = Object.values(top[0].children)[0];
    expect(callerA.callFrame.functionName).toBe("callerA");
    const callerC = Object.values(callerA.children)[0];
    expect(callerC.callFrame.functionName).toBe("callerC");
    expect(callerC.childrenSize).toBe(0); // top-level call, nothing further up
  });

  it("returns an empty tree for an empty model", () => {
    const model = buildProfileModel([], stubSourceMap());
    expect(Object.values(createBottomUpGraph(model).children)).toEqual([]);
  });
});
