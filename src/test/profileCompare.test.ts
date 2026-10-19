import { diffProfiles, summarizeFunctions } from "../profileCompare";
import { FrameAnalysis, FunctionCost } from "../profileAnalysis";

const fn = (name: string, self: number, total = self): FunctionCost =>
  ({ name, samples: 1, selfCycles: self, selfPct: 0, totalCycles: total, totalPct: 0, widthPct: 0, calls: 1 });
const frame = (index: number, functions: FunctionCost[]) => ({ index, functions }) as unknown as FrameAnalysis;

describe("summarizeFunctions", () => {
  it("counts a frame a function skipped as 0, and says how many it ran in", () => {
    const s = summarizeFunctions([
      frame(0, [fn("Draw", 100, 300), fn("RotateBuffers", 10)]),
      frame(1, [fn("Draw", 200, 400)]),
    ]);
    expect(s.frames).toBe(2);
    expect(s.functions.map((f) => f.name)).toEqual(["Draw", "RotateBuffers"]);
    expect(s.functions[0]).toMatchObject({ frames: 2, self: { min: 100, avg: 150, max: 200 }, total: { min: 300, avg: 350, max: 400 } });
    expect(s.functions[1]).toMatchObject({ frames: 1, self: { min: 0, avg: 5, max: 10 } });
  });

  it("keeps same-named functions from different files apart", () => {
    const s = summarizeFunctions([frame(0, [{ ...fn("init", 5), file: "a.s" }, { ...fn("init", 7), file: "b.s" }])]);
    expect(s.functions).toHaveLength(2);
  });
});

describe("diffProfiles", () => {
  it("orders by the change in self time, and shows functions only one side ran", () => {
    const d = diffProfiles(
      [frame(0, [fn("Draw", 1000), fn("Wait", 500), fn("Old", 50)])],
      [frame(0, [fn("Draw", 600), fn("Wait", 900)]), frame(1, [fn("Draw", 600), fn("Wait", 900), fn("New", 20)])],
    );
    expect(d.functions.map((f) => [f.name, f.selfDelta])).toEqual([
      ["Draw", -400],
      ["Wait", 400],
      ["Old", -50],
      ["New", 10],
    ]);
    expect(d.functions.find((f) => f.name === "Old")?.after).toBeUndefined();
  });
});
