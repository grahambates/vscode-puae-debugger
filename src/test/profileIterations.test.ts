import { analyseIterations } from "../profileIterations";
import { IProfileModel } from "../shared/profilerTypes";
import { SourceMap } from "../sourceMap";
import { MemoryType } from "../amigaHunkParser";

// Two functions: Loop (the main loop, at 0x1000) calling Work (at 0x2000).
const locations = [
  { callFrame: { functionName: "Loop", url: "" } },
  { callFrame: { functionName: "Work", url: "" } },
];
const nodes = [
  { id: 0, selfTime: 0, aggregateTime: 0, children: [1], locationId: -1 },
  { id: 1, selfTime: 0, aggregateTime: 0, children: [2], parent: 0, locationId: 0 },
  { id: 2, selfTime: 0, aggregateTime: 0, children: [], parent: 1, locationId: 1 },
];
const NODE = { 0x1000: 1, 0x2000: 2 } as Record<number, number>;

// One frame's samples: [pc, colour clocks] pairs. samples[k + 1] is sample k's node.
function frame(samples: [number, number][]): IProfileModel {
  return {
    pcs: samples.map(([pc]) => pc),
    timeDeltas: samples.map(([, cc]) => cc),
    samples: [0, ...samples.map(([pc]) => NODE[pc])],
    nodes,
    locations,
  } as unknown as IProfileModel;
}

const sourceMap = new SourceMap([{ name: "CODE", address: 0x1000, size: 0x2000, memType: MemoryType.CHIP }], new Set(), { Loop: 0x1000, Work: 0x2000 }, []);

describe("analyseIterations", () => {
  it("measures each pass from one hit to the next, across frames, and flags the ones over a frame", () => {
    const it = analyseIterations(
      [
        frame([[0x2000, 500], [0x1000, 100], [0x2000, 70451]]), // a partial pass, then pass 0 begins
        frame([[0x2000, 71051]]), // pass 0 runs on through a whole second frame
        frame([[0x1000, 100], [0x2000, 70900], [0x1000, 51]]), // pass 1, fitting in a frame
      ],
      sourceMap,
      "Loop",
    );
    expect(it.address).toBe(0x1000);
    expect(it.iterations.map((i) => [i.frame, i.length])).toEqual([[0, 100 + 70451 + 71051], [2, 100 + 70900]]);
    expect(it.iterations[0]).toMatchObject({ line: 2, hpos: 500 - 2 * 227 }); // began 500 cc into frame 0
    expect(it.overran).toBe(1);
    const work = it.summary.functions.find((f) => f.name === "Work")!;
    expect(work.self).toEqual({ min: 70900, avg: (70451 + 71051 + 70900) / 2, max: 70451 + 71051 });
    expect(it.summary.functions.find((f) => f.name === "Loop")!.total.max).toBe(100 + 70451 + 71051);
  });

  it("allows for the beam wait ending a few colour clocks either side", () => {
    const it = analyseIterations([frame([[0x1000, 71060], [0x1000, 71040], [0x1000, 1]])], sourceMap, "0x1000");
    expect(it.iterations).toHaveLength(2);
    expect(it.overran).toBe(0);
  });

  it("names what it couldn't find", () => {
    expect(() => analyseIterations([frame([[0x1000, 1]])], sourceMap, "mainLoop")).toThrow(/Unknown breakpoint "mainLoop"/);
  });
});
