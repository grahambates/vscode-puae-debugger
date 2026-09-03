import { looksLikePlain68000, theoreticalTiming } from "../theoreticalTimings";
// analyseStalls lives in profileAnalysis but is tested here, alongside the timing source it
// depends on — the arithmetic is only meaningful in terms of what 68kcounter returns.
import { analyseStalls } from "../profileAnalysis";
import { IDisassembledFunction } from "../shared/profilerTypes";

describe("theoreticalTiming", () => {
  it("reports datasheet cost in COLOR clocks, not CPU cycles", () => {
    // 68kcounter gives move.l d(An),Dn as 16 CPU cycles / 4 reads. A profile's timeDeltas are
    // color clocks, which the 68000 runs at half the CPU clock — so 8, not 16. Getting this
    // backwards would make every instruction look twice as stalled as it is.
    const t = theoreticalTiming("move.l 4(a6),d1")!;
    expect(t).toBeDefined();
    expect(t.cck).toBe(8);
    expect(t.reads).toBe(4);
    expect(t.writes).toBe(0);
    expect(t.worstCase).toBe(false);
  });

  it("counts the bus accesses an instruction unavoidably makes", () => {
    const t = theoreticalTiming("move.l d7,80(a6)")!;
    expect(t.reads).toBe(2);
    expect(t.writes).toBe(2);
  });

  it("times a pc-relative branch, which is not source syntax", () => {
    // A disassembler renders the target as a displacement; 68kcounter parses source, where a
    // branch takes a label. Without the substitution this returns nothing — and branches are a
    // large share of the instructions in the tight loops this analysis is most wanted for.
    const t = theoreticalTiming("bcs.b -12(pc)");
    expect(t).toBeDefined();
    expect(t!.cck).toBeGreaterThan(0);
    expect(t!.worstCase).toBe(true); // taken and not-taken both exist
  });

  it("takes the slowest timing where an instruction has several", () => {
    // bcc is 10 CPU cycles taken, 8 not taken -> 5 color clocks, the slower one. The figure gets
    // subtracted from a measurement to claim the remainder was contention, so overstating it
    // keeps that claim conservative; the fastest would manufacture stall from a taken branch.
    const t = theoreticalTiming("bcs.b -12(pc)")!;
    expect(t.cck).toBe(5);
  });

  it("handles instructions with a single timing as not worst-case", () => {
    const t = theoreticalTiming("bra.b -8(pc)")!;
    expect(t.worstCase).toBe(false);
  });

  it("returns undefined for something it cannot time, without throwing", () => {
    expect(theoreticalTiming("not-an-instruction $$$")).toBeUndefined();
    expect(theoreticalTiming("")).toBeUndefined();
  });

  it("caches by exact text, including the undefined result", () => {
    // Same object identity isn't promised, but a repeated lookup must agree with itself — the
    // cache stores undefined too, so an untimeable instruction isn't re-parsed every hit.
    expect(theoreticalTiming("nop")).toEqual(theoreticalTiming("nop"));
    expect(theoreticalTiming("bogus %%%")).toBeUndefined();
    expect(theoreticalTiming("bogus %%%")).toBeUndefined();
  });

  it("times the instructions of a real captured loop body", () => {
    // The WaitRaster loop from the capture this analysis was built for — every instruction in it
    // must be timeable, or a per-function stall figure would be built from a partial sum.
    const loop = ["move.l 4(a6),d1", "lsr.l #1,d1", "lsr.w #7,d1", "cmp.w d0,d1", "bcs.b -12(pc)"];
    for (const text of loop) expect(theoreticalTiming(text)).toBeDefined();
  });
});

describe("looksLikePlain68000", () => {
  it("rejects a capture containing sub-color-clock samples", () => {
    // Only the 020+ cycle-exact path produces these, and its lumped accounting makes a
    // per-instruction datasheet comparison meaningless.
    expect(looksLikePlain68000(17185)).toBe(false);
    expect(looksLikePlain68000(1)).toBe(false);
  });

  it("accepts a capture with none", () => {
    expect(looksLikePlain68000(0)).toBe(true);
  });
});

// Minimal disassembly of one function, which is all analyseStalls reads.
function disasmWith(instructions: { text: string; hits: number; cycles: number }[]): IDisassembledFunction[] {
  return [{
    address: 0x1000, end: 0x1000 + instructions.length * 2, name: "fn", totalCycles: 0,
    instructions: instructions.map((ins, i) => ({
      address: 0x1000 + i * 2, hex: "0000", length: 2, text: ins.text, hits: ins.hits, cycles: ins.cycles,
    })),
  }];
}

describe("analyseStalls", () => {
  it("attributes the excess over datasheet cost to stall", () => {
    // move.l 4(a6),d1 is 8 color clocks unblocked. Run 10 times costing 200 measured means
    // 120 of those color clocks were spent waiting, not working.
    const st = analyseStalls(disasmWith([{ text: "move.l 4(a6),d1", hits: 10, cycles: 200 }]), 0);
    expect(st.applicable).toBe(true);
    expect(st.totalTheoretical).toBe(80);
    expect(st.totalMeasured).toBe(200);
    expect(st.functions[0].stall).toBe(120);
    expect(st.functions[0].stallPct).toBeCloseTo(60, 5);
    // 4 reads per execution: what the contention was competing for.
    expect(st.functions[0].busAccesses).toBe(40);
  });

  it("reports no stall for an instruction running at datasheet speed", () => {
    const st = analyseStalls(disasmWith([{ text: "move.l 4(a6),d1", hits: 10, cycles: 80 }]), 0);
    expect(st.applicable).toBe(true);
    expect(st.functions[0].stall).toBe(0);
  });

  it("excludes untimeable instructions from both sides rather than one", () => {
    const st = analyseStalls(disasmWith([
      { text: "move.l 4(a6),d1", hits: 10, cycles: 200 },
      { text: "$$$ not an instruction", hits: 5, cycles: 999 },
    ]), 0);
    expect(st.functions[0].untimed).toBe(1);
    expect(st.totalMeasured).toBe(200); // the 999 is not counted as measured-without-theoretical
    expect(st.functions[0].stall).toBe(120);
  });

  it("skips instructions that never executed", () => {
    const st = analyseStalls(disasmWith([
      { text: "move.l 4(a6),d1", hits: 0, cycles: 0 },
      { text: "nop", hits: 1, cycles: 2 },
    ]), 0);
    expect(st.functions[0].theoretical).toBe(2); // nop only: 4 CPU cycles -> 2 color clocks
  });

  it("refuses when the capture has sub-color-clock samples (68020+ path)", () => {
    const st = analyseStalls(disasmWith([{ text: "move.l 4(a6),d1", hits: 10, cycles: 200 }]), 17185);
    expect(st.applicable).toBe(false);
    expect(st.caveat).toMatch(/68020\+/);
  });

  it("refuses when measured comes in well under datasheet, which contention cannot cause", () => {
    // The guard that catches a 68020 capture old enough to have no stored zeros: a faster core
    // beats the 68000 datasheet, and no amount of bus contention can subtract cycles. A real one
    // measured 0.73x; this is 0.5x.
    const st = analyseStalls(disasmWith([{ text: "move.l 4(a6),d1", hits: 10, cycles: 40 }]), 0);
    expect(st.applicable).toBe(false);
    expect(st.caveat).toMatch(/0\.50x the 68000 datasheet/);
  });

  it("tolerates measuring slightly under datasheet, which the worst-case bias causes", () => {
    // theoreticalTiming takes the SLOWEST of a branch's timings, so the datasheet side runs a
    // little high. A real 68000 capture with an almost-idle bus came in at 0.997x — correct, and
    // rejected by an exact test. 8 cck x 10 = 80 datasheet against 78 measured is 0.975x.
    const st = analyseStalls(disasmWith([{ text: "move.l 4(a6),d1", hits: 10, cycles: 78 }]), 0);
    expect(st.applicable).toBe(true);
    expect(st.functions[0].stall).toBe(-2);
  });
});

describe("DBcc", () => {
  it("times a DBcc loop, whose counter register sits between mnemonic and target", () => {
    // "dbf.w d7,-16(pc)" — the shape of nearly every hand-written Amiga loop. Missing the
    // register group left every one of these untimed.
    const t = theoreticalTiming("dbf.w d7,-16(pc)");
    expect(t).toBeDefined();
    expect(t!.cck).toBeGreaterThan(0);
    expect(t!.worstCase).toBe(true); // taken / not taken / expired
  });

  it("times a conditional DBcc too", () => {
    expect(theoreticalTiming("dbhi.w d3,2(pc)")).toBeDefined();
  });
});
