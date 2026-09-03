// Theoretical (unblocked) instruction timings, from the 68kcounter library, for comparison
// against what a capture actually measured.
//
// This is what separates "this instruction is inherently slow" from "this instruction was
// blocked". A profile alone can't tell them apart: it reports that an instruction cost 40 color
// clocks, not whether that's because the instruction does a lot of work or because the CPU sat
// waiting for the bus while the blitter and bitplane DMA had it. 68kcounter gives the datasheet
// cost assuming the CPU never waits, so the excess over it is contention:
//
//     stall = measured - theoretical
//
// Two things to be careful about, both of which the caller has to opt into rather than get
// silently wrong:
//
//   - These are 68000 timings. 68kcounter models the 68000 only (its "Level" export is a
//     display-severity band, not a CPU selector), so on 020+ code the comparison is meaningless —
//     different cycle counts, a cache, and lumped accounting that measures many instructions at
//     zero. A capture reporting any zero-cost sample is 020+ on that evidence alone; see
//     looksLikePlain68000.
//   - The unit differs. 68kcounter reports CPU clock cycles; a profile's timeDeltas are color
//     clocks, which the 68000 runs at half of. Everything here is converted to color clocks so
//     it can be compared directly, at the cost of a half-clock rounding per instruction.

import parse from "68kcounter";

export interface TheoreticalTiming {
  /** Datasheet cost with no bus contention, in COLOR clocks (68kcounter's CPU cycles / 2). */
  cck: number;
  /** Bus read/write accesses the instruction makes — its unavoidable DMA demand. */
  reads: number;
  writes: number;
  /** True when the instruction has several timings (a branch) and this is the slowest. */
  worstCase: boolean;
}

// A disassembler renders a branch target as a pc-relative displacement ("bcs.b -12(pc)"), which
// isn't source syntax and parses as no instruction at all — which would silently drop every
// branch, and branches are a large share of the instructions in the tight loops this analysis is
// most wanted for. Substituting a stand-in label gets the real timing back.
//
// The optional register group is DBcc's counter ("dbf.w d7,-16(pc)"), which comes between the
// mnemonic and the target. Omitting it left every DBcc untimed — and a DBcc loop is about the most
// common shape there is in hand-written Amiga code, so that accounted for every untimed
// instruction across both captures on hand.
const PC_RELATIVE_BRANCH = /^(b[a-z]{2}|bra|bsr|db[a-z]{1,2})(\.[bwsl])?\s+(d\d\s*,\s*)?-?\d+\(pc\)$/i;

function toSourceSyntax(text: string): string {
  const t = text.trim();
  if (!PC_RELATIVE_BRANCH.test(t)) return t;
  return t.replace(/-?\d+\(pc\)$/i, "target");
}

// 68kcounter parses source text, which is not free, and a profile asks about the same handful of
// instruction texts over and over (a loop body, every iteration). Memoized on the exact text.
const cache = new Map<string, TheoreticalTiming | undefined>();

/**
 * Datasheet timing for one disassembled instruction, or undefined if 68kcounter can't time it
 * (an unrecognised mnemonic, or a line that isn't an instruction at all).
 *
 * Where an instruction has several possible timings — a branch's taken/not-taken, DBcc's
 * expiry — this reports the SLOWEST. That direction is deliberate: the figure exists to be
 * subtracted from a measurement to claim "the rest was contention", so overstating the
 * theoretical cost understates the stall and keeps the claim conservative. Reporting the fastest
 * would manufacture stall out of a branch simply having been taken.
 */
export function theoreticalTiming(text: string): TheoreticalTiming | undefined {
  const cached = cache.get(text);
  if (cached !== undefined || cache.has(text)) return cached;

  let result: TheoreticalTiming | undefined;
  try {
    const lines = parse("\t" + toSourceSyntax(text) + "\n");
    const values = lines[0]?.timing?.values;
    if (values && values.length > 0) {
      // Timing vectors are [cycles, reads, writes]; pick the one with the highest cycle count.
      let worst = values[0];
      for (const v of values) if (v[0] > worst[0]) worst = v;
      result = {
        cck: worst[0] / 2, // CPU clock -> color clock
        reads: worst[1],
        writes: worst[2],
        worstCase: values.length > 1,
      };
    }
  } catch {
    // 68kcounter throws on some malformed input rather than returning null; an instruction it
    // can't handle is simply one this analysis has nothing to say about.
    result = undefined;
  }
  cache.set(text, result);
  return result;
}

/**
 * Whether a capture's cycle data is consistent with a plain 68000, and so with 68kcounter's
 * timings being applicable at all.
 *
 * Evidence-based and deliberately one-directional: a capture containing sub-color-clock
 * (zero-cost) samples can only have come from the 020+ cycle-exact path, whose lumped accounting
 * defers cycles onto whichever instruction next touches memory — so a comparison against
 * per-instruction datasheet timings would be nonsense. The absence of such samples is weaker
 * evidence (a 68020 running entirely uncached code would show none either), which is why the
 * comparison is opt-in rather than something applied automatically to anything that passes here.
 */
export function looksLikePlain68000(zeroCostSamples: number): boolean {
  return zeroCostSamples === 0;
}

/**
 * Whether measured cost may be compared against 68000 datasheet cost for this capture, given the
 * aggregate of both. Shared by the CLI's stall report and the model the profiler UI renders, so
 * the two can never disagree about whether the comparison is meaningful.
 *
 * Two independent guards, because the first alone is not enough:
 *
 *   - Sub-color-clock samples prove the 020+ cycle-exact path, whose lumped accounting makes a
 *     per-instruction datasheet comparison meaningless. But that evidence only exists in captures
 *     recorded since cycleDelta stopped flooring those to 1; an older capture of the very same
 *     68020 program stores no zeros and sails through.
 *   - Bus contention can only ever ADD cycles, so on a real 68000 measured cannot come in under
 *     the datasheet. Aggregate measured below theoretical means the code is not running 68000
 *     timings — a faster core, near-certainly — whatever the sample data looks like. Checked in
 *     aggregate so ordinary per-instruction noise doesn't trip it.
 */
export function datasheetApplicability(
  zeroCostSamples: number,
  totalMeasured: number,
  totalTheoretical: number,
): { applicable: boolean; caveat?: string } {
  if (!looksLikePlain68000(zeroCostSamples)) {
    return {
      applicable: false,
      caveat: `capture contains ${zeroCostSamples} sub-color-clock samples, so it was recorded on the 68020+ cycle-exact path — 68kcounter models the 68000 only, and these figures do not apply`,
    };
  }
  if (totalMeasured < totalTheoretical) {
    return {
      applicable: false,
      caveat: `measured cost (${totalMeasured}) is below the 68000 datasheet cost (${totalTheoretical}), which bus contention cannot cause — this code is not running 68000 timings, so the comparison is void`,
    };
  }
  return { applicable: true };
}
