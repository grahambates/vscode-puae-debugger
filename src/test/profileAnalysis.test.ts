import { readFileSync } from "fs";
import * as path from "path";
import { analyseBlits, analyseCopper, analyseFrame, analyseInstructions, analyseProfile, buildCallTree, buildFlame, callersOf, checkFrame, FlameBox, parseLineRange, FrameAnalysis, ProfileFinding, ProfileRequestError, selectInstructionDetail, summariseScreenUpdates } from "../profileAnalysis";
import { BusOwner, Category, DMA_CODE, DMA_WRITE, IDisassembledFunction, IProfileModel } from "../shared/profilerTypes";
import { loadProfile } from "../profileLoader";
import { renderFlame } from "../profileReport";
import { createTopDownGraph } from "../webview/profilerViewer/topDownGraph";

// Minimal synthetic model: root -> "hot" (2 samples, 10 cycles each) and root -> "cold" (2
// samples, 5 cycles each). No `dma`, so buildColumns falls back to plain cycle-cost fractions —
// which makes widthPct exactly equal selfPct here, the simplest case to assert precise numbers
// against (buildColumns' DMA-anchored path is the columns.test.ts's job to cover, not this file's).
function twoFunctionModel(): IProfileModel {
  return {
    nodes: [
      { id: 0, selfTime: 0, aggregateTime: 0, children: [1, 2], locationId: 0 },
      { id: 1, selfTime: 20, aggregateTime: 20, children: [], locationId: 1, parent: 0 },
      { id: 2, selfTime: 10, aggregateTime: 10, children: [], locationId: 2, parent: 0 },
    ],
    locations: [
      { id: 0, selfTime: 0, aggregateTime: 0, category: Category.System, address: 0,
        callFrame: { functionName: "(all)", url: "", scriptId: "root", lineNumber: -1, columnNumber: 0 } },
      { id: 1, selfTime: 20, aggregateTime: 20, category: Category.User, address: 0x1000,
        callFrame: { functionName: "hot", url: "a.c", scriptId: "0", lineNumber: 1, columnNumber: 0 } },
      { id: 2, selfTime: 10, aggregateTime: 10, category: Category.User, address: 0x2000,
        callFrame: { functionName: "cold", url: "a.c", scriptId: "0", lineNumber: 5, columnNumber: 0 } },
    ],
    samples: [0, 1, 1, 2, 2],
    timeDeltas: [10, 10, 5, 5],
    pcs: [0x1000, 0x1004, 0x2000, 0x2004],
    duration: 30,
    cyclesPerMicroSecond: 3.546895,
  };
}

describe("analyseFrame", () => {
  const f = analyseFrame(twoFunctionModel(), 0);

  it("totals samples and cycles across all functions", () => {
    expect(f.samples).toBe(4);
    expect(f.cycles).toBe(30);
    expect(f.zeroCostSamples).toBe(0);
  });

  it("falls back to the fixed PAL frame length when the model has no DMA grid", () => {
    expect(f.dmaSlots).toBe(0);
    expect(f.frameCycles).toBe(227 * 313);
    expect(f.fetchCells).toBe(0);
    expect(f.anchoredSamples).toBe(0);
    expect(f.dmaOwners).toEqual([]);
  });

  it("aggregates self cycles per function, descending", () => {
    expect(f.functions.map((fn) => fn.name)).toEqual(["hot", "cold"]);
    expect(f.functions[0]).toMatchObject({ name: "hot", samples: 2, selfCycles: 20 });
    expect(f.functions[1]).toMatchObject({ name: "cold", samples: 2, selfCycles: 10 });
  });

  it("derives selfPct from the frame's own total, and widthPct from the real column layout", () => {
    expect(f.functions[0].selfPct).toBeCloseTo((20 / 30) * 100, 6);
    expect(f.functions[1].selfPct).toBeCloseTo((10 / 30) * 100, 6);
    // No DMA grid -> buildColumns' cycle-fraction fallback -> width tracks self time exactly.
    expect(f.functions[0].widthPct).toBeCloseTo(f.functions[0].selfPct, 6);
    expect(f.functions[1].widthPct).toBeCloseTo(f.functions[1].selfPct, 6);
  });

  it("counts a sub-color-clock (zero-cost) delta separately from a truly missing one", () => {
    const model = twoFunctionModel();
    model.timeDeltas = [0, 10, 5, 5]; // first "hot" sample measured zero (68020+ lumped accounting)
    const f2 = analyseFrame(model, 0);
    expect(f2.zeroCostSamples).toBe(1);
    expect(f2.cycles).toBe(20); // the zero contributes nothing to the total, not a fabricated 1
  });

  it("censuses the DMA grid by owner group when one is present", () => {
    const model = twoFunctionModel();
    const owner = new Uint8Array([BusOwner.CPU, BusOwner.CPU, BusOwner.BLITTER, BusOwner.BPL3, BusOwner.NONE]);
    const flags = new Uint8Array(5);
    model.dma = { owner, flags, addr: new Uint32Array(5), value: new Uint16Array(5) };
    const f2 = analyseFrame(model, 0);
    expect(f2.dmaSlots).toBe(5);
    expect(f2.frameCycles).toBe(5); // a present grid overrides the PAL fallback
    expect(f2.dmaOwners).toEqual([
      { name: "CPU", cells: 2, pct: 40 },
      { name: "BLITTER", cells: 1, pct: 20 },
      { name: "BITPLANE", cells: 1, pct: 20 },
      { name: "IDLE", cells: 1, pct: 20 },
    ]);
  });

  it("counts instruction-fetch cells and how many samples anchored to one", () => {
    const model = twoFunctionModel();
    const N = 100;
    const owner = new Uint8Array(N);
    const flags = new Uint8Array(N);
    const addr = new Uint32Array(N);
    // Fetch cells for 3 of the 4 samples' own PCs — buildColumns anchors those directly, giving
    // them real (non-interpolated) width; the 4th sample has no cell of its own to anchor to.
    const fetch = (slot: number, pc: number) => { owner[slot] = BusOwner.CPU; flags[slot] = DMA_CODE; addr[slot] = pc; };
    fetch(10, 0x1000);
    fetch(40, 0x1004);
    fetch(70, 0x2000);
    model.dma = { owner, flags, addr, value: new Uint16Array(N) };
    const f2 = analyseFrame(model, 0);
    expect(f2.fetchCells).toBe(3);
    // The matcher's own count, so this is exact rather than inferred from column widths: samples
    // 0, 1 and 2 each have a fetch cell of their own; sample 3 has none and is interpolated.
    expect(f2.anchoredSamples).toBe(3);
  });
});

// checkFrame operates on plain FrameAnalysis data, so these build one directly rather than going
// through analyseFrame/buildColumns — the point is to pin the threshold/severity logic itself.
function baseFrame(overrides: Partial<FrameAnalysis> = {}): FrameAnalysis {
  return {
    index: 0,
    samples: 1000,
    cycles: 71051,
    frameCycles: 71051,
    cyclePct: 100,
    zeroCostSamples: 0,
    registerSamples: 0,
    duplicateOfPrevious: false,
    dmaSlots: 71051,
    // Healthy by low-anchor-rate's measure: the matcher used most of the fetch cells the grid
    // offered it (3000/5000). The sample count is deliberately far higher than either — a cached
    // CPU emits no fetch cell for most instructions, which is exactly why the check counts
    // against fetchCells rather than samples.
    fetchCells: 5000,
    anchoredSamples: 3000,
    functions: [],
    dmaOwners: [],
    ...overrides,
  };
}

function codesOf(findings: ProfileFinding[]): string[] {
  return findings.map((f) => f.code);
}

describe("checkFrame", () => {
  it("reports nothing for a frame that lands cleanly on the frame length", () => {
    const findings: ProfileFinding[] = [];
    checkFrame(baseFrame(), false, findings);
    expect(findings).toEqual([]);
  });

  it("flags frame-over-budget when cycles exceed the tolerance, on a non-last frame", () => {
    const findings: ProfileFinding[] = [];
    checkFrame(baseFrame({ cycles: 111424, cyclePct: 156.8 }), false, findings);
    expect(codesOf(findings)).toContain("frame-over-budget");
    expect(findings.find((f) => f.code === "frame-over-budget")!.severity).toBe("error");
  });

  it("does not flag frame-over-budget for the same overrun tolerated on the last frame", () => {
    // Within LAST_FRAME_OVERRUN_TOLERANCE (1.05) but past 100% -> info, not error.
    const findings: ProfileFinding[] = [];
    checkFrame(baseFrame({ cycles: 71760, cyclePct: 101 }), true, findings);
    expect(codesOf(findings)).toEqual(["last-frame-overrun"]);
    expect(findings[0].severity).toBe("info");
  });

  it("still flags an over-budget last frame once it exceeds even the relaxed tolerance", () => {
    const findings: ProfileFinding[] = [];
    checkFrame(baseFrame({ cycles: 78000, cyclePct: 109.8 }), true, findings);
    expect(codesOf(findings)).toContain("frame-over-budget");
  });

  it("flags frame-short when a frame accounts for too little of its length", () => {
    const findings: ProfileFinding[] = [];
    checkFrame(baseFrame({ samples: 200, cycles: 40522, cyclePct: 57 }), false, findings);
    expect(codesOf(findings)).toContain("frame-short");
    expect(findings.find((f) => f.code === "frame-short")!.severity).toBe("warning");
  });

  it("flags registers-truncated when the register trace is shorter than the sample count", () => {
    const findings: ProfileFinding[] = [];
    checkFrame(baseFrame({ samples: 1000, registerSamples: 400 }), false, findings);
    expect(codesOf(findings)).toContain("registers-truncated");
    expect(findings.find((f) => f.code === "registers-truncated")!.severity).toBe("info");
  });

  it("does not flag registers-truncated when there is no register trace at all", () => {
    const findings: ProfileFinding[] = [];
    checkFrame(baseFrame({ registerSamples: 0 }), false, findings);
    expect(codesOf(findings)).not.toContain("registers-truncated");
  });

  it("flags no-dma-grid and skips the DMA-dependent checks", () => {
    const findings: ProfileFinding[] = [];
    checkFrame(baseFrame({ dmaSlots: 0, fetchCells: 0, anchoredSamples: 0 }), false, findings);
    expect(codesOf(findings)).toEqual(["no-dma-grid"]);
  });

  it("flags low-anchor-rate when the matcher used few of the available fetch cells", () => {
    const findings: ProfileFinding[] = [];
    checkFrame(baseFrame({ fetchCells: 5000, anchoredSamples: 50 }), false, findings);
    expect(codesOf(findings)).toContain("low-anchor-rate");
    expect(findings.find((f) => f.code === "low-anchor-rate")!.severity).toBe("info");
  });

  it("does not flag low-anchor-rate merely because samples outnumber fetch cells", () => {
    // The cached-CPU case: 31k samples against 10k fetch cells, but the matcher anchored to most
    // of the cells that existed. Counting against samples would call this a problem; it isn't.
    const findings: ProfileFinding[] = [];
    checkFrame(baseFrame({ samples: 31078, fetchCells: 10028, anchoredSamples: 5959 }), false, findings);
    expect(codesOf(findings)).not.toContain("low-anchor-rate");
  });

  it("flags width-vs-cycles when a function's flame-graph width diverges from its cycle share", () => {
    const findings: ProfileFinding[] = [];
    checkFrame(baseFrame({
      functions: [
        { name: "WaitRaster", samples: 500, selfCycles: 10000, selfPct: 14.5, totalCycles: 10000, totalPct: 14.5, widthPct: 91.5 },
        { name: "FillMask", samples: 200, selfCycles: 15000, selfPct: 21.0, totalCycles: 15000, totalPct: 21.0, widthPct: 0.5 },
      ],
    }), false, findings);
    const codes = codesOf(findings).filter((c) => c === "width-vs-cycles");
    expect(codes).toHaveLength(2);
    expect(findings.find((f) => f.message.includes("WaitRaster"))!.severity).toBe("error");
  });

  it("does not flag width-vs-cycles within the divergence tolerance", () => {
    const findings: ProfileFinding[] = [];
    checkFrame(baseFrame({
      functions: [{ name: "main", samples: 500, selfCycles: 10000, selfPct: 40, totalCycles: 10000, totalPct: 40, widthPct: 41.5 }],
    }), false, findings);
    expect(codesOf(findings)).not.toContain("width-vs-cycles");
  });
});

describe("analyseProfile (real fixture)", () => {
  const FIXTURE = path.join(__dirname, "fixtures/profiles/template.puaeprofile");

  it("loads through the real decode + model-build + column-layout path and produces per-frame stats", () => {
    const a = analyseProfile(readFileSync(FIXTURE));
    expect(a.frames).toHaveLength(1);
    expect(a.frames[0].samples).toBeGreaterThan(0);
    expect(a.frames[0].functions.length).toBeGreaterThan(0);
    // Every function's widthPct should be a real number in [0, 100] regardless of what checkFrame
    // makes of it — a basic sanity bound on the buildColumns wiring.
    for (const fn of a.frames[0].functions) {
      expect(fn.widthPct).toBeGreaterThanOrEqual(0);
      expect(fn.widthPct).toBeLessThanOrEqual(100);
    }
  });

  // This fixture (captured 2026-06-15) predates the g_wprofArmPending mechanism in puae_debug.c,
  // which is what makes a capture discard wasm_profile_start's throwaway alignment retro_run()
  // instead of recording across it. Captured without that, its single "frame 0" spans the
  // alignment frame *plus* the counted frame — hence ~200% of a PAL frame's color clocks, and
  // hence its stream holding more samples (7860) than its own inRange counter (4637), the two
  // having been reset at different points.
  //
  // Not a live bug: the current build was re-verified across whole and narrow address ranges, one
  // and two frames, five capture start phases, and running vs paused — every run gives
  // samples == inRange exactly and frameCycles of one frame (~101%, the known last-frame overrun).
  // The fixture is simply stale. It's kept because profileReplay.test.ts depends on its exact
  // symbolication (inlined frames, [Kick] names), which the cycle-window issue doesn't affect —
  // regenerating it would churn those assertions for no gain. `check` is right to flag it, so this
  // pins that it does.
  it("surfaces the frame-over-budget anomaly baked into this pre-fix fixture", () => {
    const a = analyseProfile(readFileSync(FIXTURE));
    const overBudget = a.findings.find((f) => f.code === "frame-over-budget");
    expect(overBudget).toBeDefined();
    expect(overBudget!.severity).toBe("error");
    expect(a.frames[0].zeroCostSamples).toBe(0); // rules out the (already-fixed) cycleDelta floor
  });

  it("reports the out-of-range-instructions finding when ROM/OS code was executed but not sampled", () => {
    const a = analyseProfile(readFileSync(FIXTURE));
    expect(a.manifest.meta.inRange).toBeLessThan(a.manifest.meta.total);
    expect(a.findings.some((f) => f.code === "out-of-range-instructions")).toBe(true);
  });
});

// Two functions' worth of disassembly, which is all analyseInstructions reads. Hand-built for the
// same reason analyseStalls' tests are (see theoreticalTimings.test.ts): the committed
// .puaeprofile fixture predates the sections the disassembler needs, and a capture that has them
// can only be produced by running the emulator against a real Kickstart ROM.
function disassembly(): IDisassembledFunction[] {
  const fn = (name: string, address: number, rows: { text: string; hits: number; cycles: number }[], end?: number) => ({
    address, end: end ?? address + rows.length * 2, name,
    totalCycles: rows.reduce((sum, r) => sum + r.cycles, 0),
    instructions: rows.map((r, i) => ({
      address: address + i * 2, hex: "0000", length: 2, text: r.text, hits: r.hits, cycles: r.cycles,
      line: 10 + i,
    })),
  });
  return [
    // move.l 4(a6),d1 is 8 color clocks unblocked; lsr.w #7,d1 is 10. The second row here costs
    // 24.5/execution against that 10 — the shape of a real bus stall, not a slow instruction.
    fn("DrawThing", 0x1000, [
      { text: "move.l 4(a6),d1", hits: 2, cycles: 16 },
      { text: "lsr.w #7,d1", hits: 2, cycles: 49 },
      { text: "rts", hits: 0, cycles: 0 },
    ]),
    fn("DrawOther", 0x2000, [{ text: "nop", hits: 1, cycles: 4 }]),
  ];
}

describe("analyseInstructions", () => {
  it("reports per-instruction cost, in address order", () => {
    const d = analyseInstructions(disassembly(), "DrawThing", 0);
    expect(d.name).toBe("DrawThing");
    expect(d.instructions.map((i) => i.address)).toEqual([0x1000, 0x1002, 0x1004]);
    expect(d.instructions[1]).toMatchObject({ hits: 2, cycles: 49, cyclesPerHit: 24.5, line: 11 });
  });

  it("expresses each instruction as a share of its function", () => {
    const d = analyseInstructions(disassembly(), "DrawThing", 0);
    // 49 of 65 total cycles.
    expect(d.instructions[1].pctOfFunction).toBeCloseTo(75.4, 1);
    expect(d.totalCycles).toBe(65);
  });

  it("separates a slow instruction from a blocked one", () => {
    // The distinction the whole feature exists for: lsr.w is a 10-cycle instruction that spent
    // 14.5 cycles per execution waiting for the bus. "Make it faster" and "stop competing for the
    // bus" are different fixes, and only this column tells them apart.
    const d = analyseInstructions(disassembly(), "DrawThing", 0);
    expect(d.datasheetApplicable).toBe(true);
    expect(d.instructions[0]).toMatchObject({ theoreticalCycles: 8, stallPerHit: 0 });
    expect(d.instructions[1]).toMatchObject({ theoreticalCycles: 10, stallPerHit: 14.5 });
  });

  it("leaves stall undefined for instructions that never ran", () => {
    // 0 hits means no measurement to compare, not a zero-cost instruction.
    const d = analyseInstructions(disassembly(), "DrawThing", 0);
    expect(d.instructions[2].hits).toBe(0);
    expect(d.instructions[2].stallPerHit).toBeUndefined();
  });

  it("withholds the datasheet comparison when the capture says it doesn't apply", () => {
    // zeroCostSamples > 0 means a 68020+ capture, where 68000 datasheet timings are fiction.
    const d = analyseInstructions(disassembly(), "DrawThing", 5);
    expect(d.datasheetApplicable).toBe(false);
    expect(d.datasheetCaveat).toBeTruthy();
    expect(d.instructions[1].stallPerHit).toBeUndefined();
    // The measured figures stand on their own and are still reported.
    expect(d.instructions[1].cyclesPerHit).toBe(24.5);
  });

  it("matches a name case-insensitively, and by unique substring", () => {
    expect(analyseInstructions(disassembly(), "drawthing", 0).name).toBe("DrawThing");
    expect(analyseInstructions(disassembly(), "Other", 0).name).toBe("DrawOther");
  });

  it("prefers an exact match over a substring one", () => {
    // Without this, a function whose name is a prefix of another's is unreachable.
    const fns = [...disassembly(), { address: 0x3000, end: 0x3002, name: "Draw", totalCycles: 0,
      instructions: [{ address: 0x3000, hex: "0000", length: 2, text: "nop", hits: 1, cycles: 2 }] }];
    expect(analyseInstructions(fns, "Draw", 0).name).toBe("Draw");
  });

  it("refuses an ambiguous match rather than picking one", () => {
    expect(() => analyseInstructions(disassembly(), "Draw", 0)).toThrow(ProfileRequestError);
    expect(() => analyseInstructions(disassembly(), "Draw", 0)).toThrow(/matches 2 functions/);
  });

  it("lists what does exist when nothing matches", () => {
    expect(() => analyseInstructions(disassembly(), "Missing", 0)).toThrow(/DrawThing, DrawOther/);
  });

  it("distinguishes a capture with no disassembly from a bad function name", () => {
    expect(() => analyseInstructions([], "DrawThing", 0)).toThrow(/carries no disassembly/);
    expect(() => analyseInstructions(undefined, "DrawThing", 0)).toThrow(ProfileRequestError);
  });

  it("flags a listing the disassembler cut short of the function's end", () => {
    // Silently showing a partial routine would understate its cost and hide the expensive line.
    const [fn] = disassembly();
    const truncated = [{ ...fn, end: fn.address + 0x100 }];
    expect(analyseInstructions(truncated, "DrawThing", 0).truncated).toBe(true);
    expect(analyseInstructions(disassembly(), "DrawThing", 0).truncated).toBe(false);
  });
});

describe("selectInstructionDetail", () => {
  // A capture whose frames don't run the same code: frame 0 runs DrawThing/DrawOther, frame 1 also
  // spends time in Rebuild — the every-other-frame cadence (a rebuild step, a double-buffered
  // update) that is completely normal in demo code.
  const frame0 = () => ({
    disassembly: disassembly(),
    zeroCostSamples: 0,
    executedFunctions: ["DrawThing", "DrawOther"],
  });
  const frame1 = () => ({
    disassembly: disassembly(), // frame 0's listing, reused — Rebuild is not in it
    zeroCostSamples: 0,
    executedFunctions: ["DrawThing", "DrawOther", "Rebuild"],
  });

  it("resolves a function present in every frame, per frame", () => {
    const details = selectInstructionDetail([frame0(), frame1()], "DrawThing");
    expect(details.map((d) => d?.name)).toEqual(["DrawThing", "DrawThing"]);
  });

  it("tolerates frames that never ran the function instead of failing the whole capture", () => {
    // The bug this covers: resolving per frame inside the analysis loop meant one frame without
    // the function aborted the run, so a routine absent from frame 0 was unreachable even with
    // --frame pointed straight at the frame that did run it.
    const missingInFrame0 = { ...frame0(), disassembly: [disassembly()[1]] }; // only DrawOther
    const details = selectInstructionDetail([missingInFrame0, frame1()], "DrawThing");
    expect(details[0]).toBeUndefined();
    expect(details[1]?.name).toBe("DrawThing");
  });

  it("explains a function that ran but was never disassembled", () => {
    // The honest answer for a later-frame-only routine: it exists, it cost time, and the capture
    // simply has no instruction text for it. Saying "no such function" would send the caller off
    // to correct a name that was right all along.
    let error: Error | undefined;
    try {
      selectInstructionDetail([frame0(), frame1()], "Rebuild");
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeInstanceOf(ProfileRequestError);
    expect(error!.message).toMatch(/Rebuild ran in frame\(s\) 1 but was never disassembled/);
    expect(error!.message).toMatch(/warmupFrames/); // says how to get a capture that can answer
  });

  it("still reports a genuinely unknown name as unknown", () => {
    expect(() => selectInstructionDetail([frame0(), frame1()], "NeverHeardOfIt")).toThrow(
      /No executed function matching "NeverHeardOfIt" anywhere/,
    );
  });

  it("reports ambiguity across the whole capture, not just the first frame", () => {
    expect(() => selectInstructionDetail([frame0(), frame1()], "Draw")).toThrow(/matches 2 functions/);
  });

  it("reports a capture with no disassembly at all as such", () => {
    const bare = { disassembly: undefined, zeroCostSamples: 0, executedFunctions: ["DrawThing"] };
    expect(() => selectInstructionDetail([bare], "DrawThing")).toThrow(/carries no disassembly/);
  });
});


describe("summariseScreenUpdates", () => {
  it("has nothing to say about a single frame", () => {
    expect(summariseScreenUpdates([false], 50)).toBeUndefined();
  });

  it("lists repeats and how long each bounded picture was held", () => {
    // Changes at 1,2,3,5,6,8: holds 1,1,2,1,2. Frame 0 and the trailing frames are unbounded.
    const dup = [false, false, false, false, true, false, false, true, false, true];
    const su = summariseScreenUpdates(dup, 50)!;
    expect(su.compared).toBe(9);
    expect(su.repeats).toEqual([4, 7, 9]);
    expect(su.holds).toEqual({ 1: 3, 2: 2 });
  });

  it("reads a steady half-rate effect as a single hold length", () => {
    const dup = Array.from({ length: 11 }, (_, i) => i > 0 && i % 2 === 0);
    expect(summariseScreenUpdates(dup, 50)!.holds).toEqual({ 2: 4 });
  });
});

// main (no self time) -> fib -> fib (recursion), and main -> helper. Cycles: outer fib 5 self,
// inner fib 15, helper 10 — 30 in all.
function recursiveModel(): IProfileModel {
  const loc = (id: number, functionName: string) => ({
    id, selfTime: 0, aggregateTime: 0, category: Category.User, address: 0x1000 * id,
    callFrame: { functionName, url: "a.c", scriptId: "0", lineNumber: id, columnNumber: 0 },
  });
  return {
    nodes: [
      { id: 0, selfTime: 0, aggregateTime: 30, children: [1], locationId: 0 },
      { id: 1, selfTime: 0, aggregateTime: 30, children: [2, 4], locationId: 1, parent: 0 },
      { id: 2, selfTime: 5, aggregateTime: 20, children: [3], locationId: 2, parent: 1 },
      { id: 3, selfTime: 15, aggregateTime: 15, children: [], locationId: 2, parent: 2 },
      { id: 4, selfTime: 10, aggregateTime: 10, children: [], locationId: 3, parent: 1 },
    ],
    locations: [loc(0, "(all)"), loc(1, "main"), loc(2, "fib"), loc(3, "helper")],
    samples: [0, 2, 3, 4],
    timeDeltas: [5, 15, 10],
    pcs: [0x2000, 0x2004, 0x3000],
    duration: 30,
    cyclesPerMicroSecond: 3.546895,
  };
}

describe("inclusive time", () => {
  const f = analyseFrame(recursiveModel(), 0);
  const fn = (name: string) => f.functions.find((x) => x.name === name)!;

  it("lists a function that only calls others, with its callees' time as its total", () => {
    expect(fn("main")).toMatchObject({ selfCycles: 0, totalCycles: 30, samples: 0 });
    expect(fn("main").totalPct).toBeCloseTo(100, 6);
  });

  it("counts a recursive function once per path, not once per level", () => {
    // 20, not 20 + 15: the inner call's time is already inside the outer one's.
    expect(fn("fib")).toMatchObject({ selfCycles: 20, totalCycles: 20 });
  });

  it("gives a leaf a total equal to its self time", () => {
    expect(fn("helper")).toMatchObject({ selfCycles: 10, totalCycles: 10 });
  });
});

describe("call tree and callers", () => {
  it("builds the top-down tree, children by cost", () => {
    const tree = buildCallTree(recursiveModel());
    expect(tree.totalCycles).toBe(30);
    const main = tree.children[0];
    expect(main.name).toBe("main");
    expect(main.children.map((c) => [c.name, c.totalCycles])).toEqual([["fib", 20], ["helper", 10]]);
    expect(main.children[0].children[0]).toMatchObject({ name: "fib", selfCycles: 15, totalCycles: 15 });
  });

  it("reports each call path into a function once, at its outermost occurrence", () => {
    const paths = callersOf(recursiveModel(), "fib", 30);
    expect(paths).toEqual([{ path: ["main", "fib"], cycles: 20, pct: (20 / 30) * 100 }]);
  });
});

describe("call tree against the profiler's Time view", () => {
  // The Time view's own builder, run on the same real capture: the text tree must not disagree
  // with what the user sees in the UI.
  it("matches createTopDownGraph node for node", () => {
    const { frames } = loadProfile(new Uint8Array(readFileSync(path.join(__dirname, "fixtures/profiles/template.puaeprofile"))));
    const model = frames[0].model;
    const ui = createTopDownGraph(model);
    const cpu = model.dma ? Object.values(ui.children).find((c) => c.callFrame.functionName === "CPU")! : ui;
    const flatten = (name: string, total: number, kids: [string, number, unknown][]): string[] => [`${name}:${total}`, ...kids.flatMap(([n, t, k]) => flatten(n, t, k as [string, number, unknown][]))];
    type UiNode = { callFrame: { functionName: string }; aggregateTime: number; children: Record<number, UiNode> };
    const fromUi = (n: UiNode): [string, number, unknown][] =>
      Object.values(n.children).map((c) => [c.callFrame.functionName, c.aggregateTime, fromUi(c)] as [string, number, unknown]);
    const ours = (n: ReturnType<typeof buildCallTree>): [string, number, unknown][] =>
      n.children.map((c) => [c.name, c.totalCycles, ours(c)] as [string, number, unknown]);
    const sortAll = (xs: string[]) => [...xs].sort();
    expect(sortAll(flatten("root", 0, ours(buildCallTree(model))))).toEqual(sortAll(flatten("root", 0, fromUi(cpu as unknown as UiNode))));
  });
});

describe("flame graph as text", () => {
  // No DMA grid in these models, so positions are cycle-cost fractions spread over a PAL frame.
  const FRAME = 227 * 313;

  it("nests boxes by call depth, in time order", () => {
    const v = buildFlame(recursiveModel());
    expect(v.anchored).toBe(false);
    expect(v.boxes.map((b) => b.name)).toEqual(["main"]);
    const main = v.boxes[0];
    expect(main.children.map((b) => b.name)).toEqual(["fib", "helper"]);
    const outerFib = main.children[0];
    expect(outerFib.start).toBeCloseTo(0, 6);
    expect(outerFib.end).toBeCloseTo((20 / 30) * FRAME, 6);
    expect(outerFib.children.map((b) => b.name)).toEqual(["fib"]);
  });

  it("clips to a window of lines and says which boxes run past it", () => {
    const v = buildFlame(recursiveModel(), { from: 100, to: 120 });
    expect(v.start).toBe(100 * 227);
    expect(v.end).toBe(121 * 227);
    const main = v.boxes[0];
    expect(main).toMatchObject({ startsBefore: true, endsAfter: true, start: 100 * 227, end: 121 * 227 });
  });

  it("folds boxes too short to matter into their parent, by function", () => {
    const model = recursiveModel();
    // helper becomes 1 cycle of 20001 — far under the 0.5% folding threshold.
    model.timeDeltas = [5000, 15000, 1];
    model.duration = 20001;
    model.nodes[2].aggregateTime = 20000; model.nodes[2].selfTime = 5000;
    model.nodes[3].aggregateTime = 15000; model.nodes[3].selfTime = 15000;
    model.nodes[4].aggregateTime = 1; model.nodes[4].selfTime = 1;
    const main = buildFlame(model).boxes[0];
    expect(main.children.map((b) => b.name)).toEqual(["fib"]);
    expect(main.folded).toEqual([{ name: "helper", count: 1, slots: expect.any(Number) }]);
  });

  it("parses a line range and rejects nonsense", () => {
    expect(parseLineRange("40-80")).toEqual({ from: 40, to: 80 });
    expect(parseLineRange("44")).toEqual({ from: 44, to: 44 });
    expect(() => parseLineRange("80-40")).toThrow(ProfileRequestError);
    expect(() => parseLineRange("0-400")).toThrow(/within 0-312/);
  });
});

describe("flame graph rendering", () => {
  const box = (name: string, start: number, len: number, children: FlameBox[] = []): FlameBox =>
    ({ name, start, end: start + len, children, folded: [] });

  it("collapses a repeating sequence of calls into one entry with its period", () => {
    // A loop body of two calls, every 8 lines, five times; the wait drifts by a few slots.
    const body = [0, 1, 2, 3, 4].flatMap((i) => [box("compute", 1000 + i * 8 * 227, 900), box("WaitBlit", 1950 + i * 8 * 227, 57 + i * 2)]);
    const text = renderFlame(
      { start: 0, end: 227 * 313, minSlots: 10, anchored: true, dma: [], folded: [], boxes: [box("main", 0, 227 * 313, body)] },
      0,
      (fn) => fn.name,
    ).join("\n");
    expect(text).toMatch(/×5 \[compute, WaitBlit\], every ~8\.0 lines — first one:/);
    expect(text.match(/ compute$/gm)).toHaveLength(1); // the example iteration only
  });
});

describe("analyseBlits", () => {
  // twoFunctionModel's 30 cycles spread over a 30-slot grid: hot runs slots 0-19, cold 20-29.
  function modelWithBlit(writeCon0: boolean): IProfileModel {
    const model = twoFunctionModel();
    const n = 30;
    const dma = { owner: new Uint8Array(n), flags: new Uint8Array(n), addr: new Uint32Array(n), value: new Uint16Array(n) };
    const write = (i: number, off: number, value: number) => {
      dma.owner[i] = BusOwner.CPU; dma.flags[i] = DMA_WRITE; dma.addr[i] = 0xdff000 + off; dma.value[i] = value;
    };
    if (writeCon0) write(0, 0x040, 0x0100);
    write(1, 0x054, 0x0001);
    write(2, 0x056, 0x0000);
    write(3, 0x058, (1 << 6) | 1);
    for (let i = 4; i < 8; i++) { dma.owner[i] = BusOwner.BLITTER; dma.flags[i] = DMA_WRITE; }
    return { ...model, dma };
  }

  it("names the function that started the blit and its timing", () => {
    const b = analyseBlits(modelWithBlit(true))!;
    expect(b.busySlots).toBe(4);
    expect(b.blits[0]).toMatchObject({ startSlot: 3, endSlot: 7, finished: true, startedBy: "hot", label: "Clear ---D 16x1px" });
  });

  it("uses a frame-start snapshot as the register baseline, and only a frame-start one", () => {
    const custom = new Uint16Array(256);
    custom[0x040 >> 1] = 0x0100;
    const snapshot = { chip: new Uint8Array(0), slow: new Uint8Array(0), custom };
    const seeded = analyseBlits({ ...modelWithBlit(false), dmaSnapshot: { ...snapshot, atFrameStart: true } })!.blits[0];
    expect(seeded.label).toBe("Clear ---D 16x1px");
    // A post-capture snapshot (older captures) holds later values; it must not be used.
    const unseeded = analyseBlits({ ...modelWithBlit(false), dmaSnapshot: snapshot })!.blits[0];
    expect(unseeded.label).toBe("? 16x1px");
  });

  it("refuses to describe an operation whose BLTCON0 it never saw", () => {
    const blit = analyseBlits(modelWithBlit(false))!.blits[0];
    expect(blit.label).toBe("? 16x1px");
    expect(blit.minterm).toBe("?");
    expect(blit.unseen).toContain("BLTCON0");
  });
});

describe("analyseCopper", () => {
  // MOVE COLOR00 at 0:010, WAIT 44,6 at 0:014, MOVE COLOR00 at 44:012, and one record whose raw
  // hpos (230) runs past the last slot of its line.
  function modelWithCopper(): IProfileModel {
    const rec = [
      { addr: 0x1000, w1: 0x0180, w2: 0x0f00, vpos: 0, hpos: 10 },
      { addr: 0x1004, w1: 0x2c07, w2: 0xfffe, vpos: 0, hpos: 14 },
      { addr: 0x1008, w1: 0x0180, w2: 0x000f, vpos: 44, hpos: 12 },
      { addr: 0x100c, w1: 0x0182, w2: 0x0fff, vpos: 50, hpos: 230 },
    ];
    return {
      ...twoFunctionModel(),
      copper: {
        addr: Uint32Array.from(rec, (r) => r.addr),
        w1: Uint16Array.from(rec, (r) => r.w1),
        w2: Uint16Array.from(rec, (r) => r.w2),
        hpos: Uint16Array.from(rec, (r) => r.hpos),
        vpos: Uint16Array.from(rec, (r) => r.vpos),
      },
    };
  }

  it("lists executed instructions with their position, and how long each WAIT waited", () => {
    const c = analyseCopper(modelWithCopper())!;
    expect(c.executed).toBe(4);
    expect(c.steps.map((s) => s.text)).toEqual(["MOVE #$F00,COLOR00", "WAIT 44,6", "MOVE #$00F,COLOR00", "MOVE #$FFF,COLOR01"]);
    expect(c.steps[1]).toMatchObject({ slot: 14, waitedSlots: 44 * 227 + 12 - 14 });
    expect(c.steps[0].waitedSlots).toBeUndefined();
  });

  it("clamps an hpos past the end of its line rather than spilling onto the next", () => {
    expect(analyseCopper(modelWithCopper())!.steps[3].slot).toBe(50 * 227 + 226);
  });

  it("narrows to a window of lines, still counting the whole frame", () => {
    const c = analyseCopper(modelWithCopper(), { from: 40, to: 45 })!;
    expect(c.executed).toBe(4);
    expect(c.steps.map((s) => s.address)).toEqual([0x1008]);
  });

  it("is absent when the capture recorded no copper trace", () => {
    expect(analyseCopper(twoFunctionModel())).toBeUndefined();
  });
});
