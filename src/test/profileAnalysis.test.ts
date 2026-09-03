import { readFileSync } from "fs";
import * as path from "path";
import { analyseFrame, analyseProfile, checkFrame, FrameAnalysis, ProfileFinding } from "../profileAnalysis";
import { BusOwner, Category, DMA_CODE, IProfileModel } from "../shared/profilerTypes";

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
    dmaSlots: 71051,
    fetchCells: 5000,
    anchoredSamples: 900,
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

  it("flags low-anchor-rate when few samples matched a real instruction fetch", () => {
    const findings: ProfileFinding[] = [];
    checkFrame(baseFrame({ samples: 1000, anchoredSamples: 50 }), false, findings);
    expect(codesOf(findings)).toContain("low-anchor-rate");
    expect(findings.find((f) => f.code === "low-anchor-rate")!.severity).toBe("info");
  });

  it("flags width-vs-cycles when a function's flame-graph width diverges from its cycle share", () => {
    const findings: ProfileFinding[] = [];
    checkFrame(baseFrame({
      functions: [
        { name: "WaitRaster", samples: 500, selfCycles: 10000, selfPct: 14.5, widthPct: 91.5 },
        { name: "FillMask", samples: 200, selfCycles: 15000, selfPct: 21.0, widthPct: 0.5 },
      ],
    }), false, findings);
    const codes = codesOf(findings).filter((c) => c === "width-vs-cycles");
    expect(codes).toHaveLength(2);
    expect(findings.find((f) => f.message.includes("WaitRaster"))!.severity).toBe("error");
  });

  it("does not flag width-vs-cycles within the divergence tolerance", () => {
    const findings: ProfileFinding[] = [];
    checkFrame(baseFrame({
      functions: [{ name: "main", samples: 500, selfCycles: 10000, selfPct: 40, widthPct: 41.5 }],
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
