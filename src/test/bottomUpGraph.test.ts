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

    // Self time = total cycles spent in leaf (40). Aggregate = same (leaf never calls anything).
    expect(leaf.selfTime).toBe(40);
    expect(leaf.aggregateTime).toBe(40);

    // Its children are the two distinct callers. Each child's self time = cycles via that caller.
    const callers = Object.values(leaf.children);
    const callerMap = Object.fromEntries(callers.map((n) => [n.callFrame.functionName, n]));
    expect(Object.keys(callerMap).sort()).toEqual(["callerA", "callerB"]);
    expect(callerMap["callerA"].selfTime).toBe(10);
    expect(callerMap["callerB"].selfTime).toBe(30);
    // Nested entries: aggregate = self (leaf time via this path, no further sub-breakdown)
    expect(callerMap["callerA"].aggregateTime).toBe(10);
    expect(callerMap["callerB"].aggregateTime).toBe(30);
  });

  it("keeps two independent leaves as separate root-level entries", () => {
    const samples: InstructionSample[] = [
      { stack: [0x100, 0x200], cycles: 10 }, // leaf via callerA
      { stack: [0x300], cycles: 5 }, // callerB itself is a leaf (depth-1, no caller)
    ];
    const model = buildProfileModel(samples, stubSourceMap());
    const top = Object.values(createBottomUpGraph(model).children);
    expect(top.map((n) => n.callFrame.functionName).sort()).toEqual(["callerB", "leaf"]);

    const callerB = top.find((n) => n.callFrame.functionName === "callerB")!;
    expect(callerB.selfTime).toBe(5);
    expect(callerB.aggregateTime).toBe(5); // callerB was a leaf: inclusive = self
    expect(callerB.childrenSize).toBe(0);
  });

  it("reverses a 3-deep chain into a single caller-chain path with correct self times", () => {
    // leaf() called from callerA() called from callerC().
    const samples: InstructionSample[] = [{ stack: [0x100, 0x200, 0x400], cycles: 7 }];
    const model = buildProfileModel(samples, stubSourceMap());
    const top = Object.values(createBottomUpGraph(model).children);
    expect(top.map((n) => n.callFrame.functionName)).toEqual(["leaf"]);

    const leafEntry = top[0];
    expect(leafEntry.selfTime).toBe(7);
    expect(leafEntry.aggregateTime).toBe(7);

    const callerA = Object.values(leafEntry.children)[0];
    expect(callerA.callFrame.functionName).toBe("callerA");
    expect(callerA.selfTime).toBe(7);    // all 7 cycles of leaf flowed through callerA
    expect(callerA.aggregateTime).toBe(7);

    const callerC = Object.values(callerA.children)[0];
    expect(callerC.callFrame.functionName).toBe("callerC");
    expect(callerC.selfTime).toBe(7);    // and through callerC
    expect(callerC.aggregateTime).toBe(7);
    expect(callerC.childrenSize).toBe(0);
  });

  it("top-level aggregateTime ≤ frame duration — no > 100% bug from the old double-counting", () => {
    // Two disjoint call paths: callerA→leaf (60 cy) and callerB→leaf (40 cy). 'leaf' is called
    // from two different callers; 'callerA' and 'callerB' each called only leaf.
    // Old bug: the propagation added each ancestor's full subtree aggregateTime back up the
    // reversed chain, causing leaf's aggregateTime to accumulate to 60+40+60+40 = 200 (>100%).
    const samples: InstructionSample[] = [
      { stack: [0x100, 0x200], cycles: 60 }, // leaf via callerA
      { stack: [0x100, 0x300], cycles: 40 }, // leaf via callerB
    ];
    const model = buildProfileModel(samples, stubSourceMap());
    const top = Object.values(createBottomUpGraph(model).children);
    const byName = Object.fromEntries(top.map((n) => [n.callFrame.functionName, n]));

    // leaf: total self = 100, aggregate = 100 (same — pure leaf)
    expect(byName["leaf"].selfTime).toBe(100);
    expect(byName["leaf"].aggregateTime).toBe(100);

    // No entry exceeds the frame duration
    for (const entry of top) {
      expect(entry.aggregateTime).toBeLessThanOrEqual(model.duration);
    }
  });

  it("returns an empty tree for an empty model", () => {
    const model = buildProfileModel([], stubSourceMap());
    expect(Object.values(createBottomUpGraph(model).children)).toEqual([]);
  });
});
