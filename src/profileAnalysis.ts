// Machine-readable analysis of a .puaeprofile document: per-frame cost tables plus a set of
// physical-invariant checks. Backs `puae-debugger profile dump` / `profile check`
// (src/standalone/profileCli.ts) and is the entry point intended for automated/AI consumers.
//
// Why this exists as a first-class module rather than an ad-hoc script: every investigation of a
// suspect profile so far has started by hand-reimplementing the container parse and the sample
// decode in throwaway JS, which is both laborious and free to drift from what the extension
// actually does. Everything here goes through the real load path (loadProfile → decodeCapture →
// buildFramesFromCaptures) and the real flame-graph layout (buildColumns), so a report can't
// disagree with the viewer.
//
// The checks matter more than the dump. Raw per-function numbers are easy to rationalise —
// a busy-wait loop reported at 76% of a frame looks plausible until you notice the frame's
// samples sum to 157% of the color clocks a PAL frame physically contains. Each check below
// encodes one such invariant, and each corresponds to a bug that shipped:
//   - frame-over-budget      → the cycleDelta floor that fabricated a color clock per sample
//   - width-vs-cycles        → flame-graph runs spread by sample index instead of cycle cost
//   - registers-truncated    → the register cap that used to stop profile recording outright
//   - frame-short            → the profile buffer running out mid-capture

import { buildColumns, buildSampleSlots } from "./webview/profilerViewer/columns";
import { BusOwner, IDisassembledFunction, IProfileModel, REG_COUNT } from "./shared/profilerTypes";
import { loadProfile } from "./profileLoader";
import { ProfileManifest } from "./profileFormat";
import { datasheetApplicability, theoreticalTiming } from "./theoreticalTimings";

// The emulator serialises a fixed PAL-geometry DMA grid (DMA_HPOS × DMA_VPOS in the C side), so
// a frame's grid cell count is also the number of color clocks in that frame — the ground truth
// every cycle figure here is measured against. Used as the fallback when a frame has no grid.
const PAL_FRAME_CCK = 227 * 313;

// Kept for captures taken before wasm_profile_on_frame_boundary learned to stop recording at the
// final frame's true boundary. Until then the last frame ran on for the few scanlines retro_run()
// takes to return past that boundary — a consistent ~1% overrun, since nothing marked where the
// last frame really ended (every earlier frame is bounded on both sides by markers). Current
// captures land on the frame length like any other frame, so this only tolerates older files.
const LAST_FRAME_OVERRUN_TOLERANCE = 1.05;
// Earlier frames are bounded on both sides by markers and should land on the frame length. Only
// rounding of the one unfinalized sample per frame should show up, hence a tight bound.
const FRAME_OVERRUN_TOLERANCE = 1.02;
// Below this, something swallowed samples (a full buffer) or the CPU spent the rest of the frame
// outside the profiled address range.
const FRAME_SHORTFALL_TOLERANCE = 0.8;
// A function whose flame-graph width and cycle share disagree by more than this (in percentage
// points of the frame) is being drawn in the wrong place, however plausible its cycle figure is.
// Calibrated rather than guessed: sweeping columns.ts's CODE_MATCH_WINDOW over a real capture put
// a healthy layout at 0.2pp worst-case and a deliberately mis-tuned one (wrong-lap matches) at
// 6.8pp, with the two well separated. 3pp sits between them — comfortably clear of measurement
// noise, and still catching the real failure this check exists for (a busy-wait rendered at 91.5%
// of a frame's width for 14.5% of its cycles).
const WIDTH_DIVERGENCE_PP = 3;
// Share of the frame's instruction-fetch cells the matcher actually tied a sample to, below which
// flame-graph positions are mostly interpolated rather than observed.
//
// Measured against fetch cells, NOT against sample count. A cached CPU emits no fetch cell for
// most instructions — on a real 68020 frame, 10,028 cells for 31,078 samples — so anchored/samples
// is capped by cache behaviour nobody controls and reads "low" even when the matcher has done
// everything available to it. Anchored/fetchCells asks the question that's actually actionable:
// of the positions the grid could have confirmed, how many did we use? The same frame went from
// 7.9% of them (blind forward search) to 59.4% (cycle-predicted), so half is a fair line between
// "working" and "struggling".
const LOW_ANCHOR_RATE = 0.5;

export type Severity = "error" | "warning" | "info";

export interface ProfileFinding {
  severity: Severity;
  code: string;
  frame?: number; // frame index, omitted for document-wide findings
  message: string; // one line, states the problem and the numbers behind it
  hint?: string; // where to look / what it usually means
}

export interface FunctionCost {
  name: string;
  file?: string;
  samples: number;
  selfCycles: number;
  selfPct: number; // share of the frame's total sampled cycles
  widthPct: number; // share of the flame graph's width (should track selfPct)
}

export interface DmaOwnerCount {
  name: string;
  cells: number;
  pct: number;
}

export interface FrameAnalysis {
  index: number;
  samples: number;
  cycles: number; // Σ timeDeltas
  frameCycles: number; // color clocks the frame physically contains
  cyclePct: number; // cycles / frameCycles
  zeroCostSamples: number; // sub-color-clock instructions (68020+ lumped accounting)
  registerSamples: number; // per-sample register trace length (0 = none)
  dmaSlots: number;
  fetchCells: number; // CPU instruction-fetch cells in the grid
  anchoredSamples: number; // samples matched to one of those cells
  functions: FunctionCost[]; // descending by selfCycles
  dmaOwners: DmaOwnerCount[]; // descending by cells
  /** Present only when stall analysis was requested (see analyseProfile's options). */
  stalls?: StallAnalysis;
  /** Present only when per-instruction detail was requested for a named function. */
  instructionDetail?: InstructionAnalysis;
}

export interface ProfileAnalysis {
  manifest: ProfileManifest;
  frames: FrameAnalysis[];
  findings: ProfileFinding[];
}

// Measured cost against datasheet cost, per function — the difference between "this routine is
// doing a lot of work" and "this routine spent its time waiting for the bus". See
// theoreticalTimings.ts for why this is opt-in and 68000-only.
export interface FunctionStall {
  name: string;
  /** Cycles the capture measured across every instruction of this function that could be timed. */
  measured: number;
  /** Datasheet cost of those same executions, unblocked. */
  theoretical: number;
  /** measured - theoretical: time the CPU spent not retiring the instruction it was on. */
  stall: number;
  /** Share of measured that is stall. */
  stallPct: number;
  /** Bus accesses those executions demand — what the contention is competing for. */
  busAccesses: number;
  /** Instructions in the function 68kcounter could not time; their cost is excluded above. */
  untimed: number;
}

/**
 * A request this capture can't satisfy — an unknown or ambiguous function name, or a frame with
 * no disassembly — as distinct from a file that can't be read or decoded.
 *
 * The difference is the whole message to the caller: "fix your argument" versus "this file is
 * damaged or the wrong file". Typed rather than sniffed from the message text so the CLI and the
 * MCP tools can tell them apart without matching on prose.
 */
export class ProfileRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileRequestError";
  }
}

// One instruction's measured cost within a function, for the question a function-level table
// can't answer: WHICH instruction in this routine is expensive. The capture has carried this all
// along (it is what the profiler's Disassembly view draws, and what analyseStalls aggregates);
// it just had no way out of the library until now.
export interface InstructionCost {
  address: number;
  /** Mnemonic + operands, as disassembled. */
  text: string;
  /** Source line, when the debug info places this address. */
  line?: number;
  /** Times this exact PC was the executing instruction in this frame. */
  hits: number;
  /** Cycles attributed to this PC in this frame. */
  cycles: number;
  /** cycles/hits — the figure to compare against the datasheet cost below. */
  cyclesPerHit: number;
  /** Share of the enclosing function's measured cycles. */
  pctOfFunction: number;
  /** Datasheet cost of ONE unblocked execution, when 68kcounter can time it (68000 only). */
  theoreticalCycles?: number;
  /** cyclesPerHit - theoreticalCycles: per-execution time spent blocked rather than working. */
  stallPerHit?: number;
}

export interface InstructionAnalysis {
  /** The function actually matched, which may differ from what was asked for. */
  name: string;
  address: number;
  /** Exact total for the function this frame, correct even if `instructions` was truncated. */
  totalCycles: number;
  /** True when the decode budget cut the listing short of the function's real end. */
  truncated: boolean;
  /** Whether datasheet comparison applies at all — same gate `--stalls` uses. */
  datasheetApplicable: boolean;
  datasheetCaveat?: string;
  /** In address order: how you read a routine, not a ranking. */
  instructions: InstructionCost[];
}

export interface StallAnalysis {
  /** False when the capture's own data says the 68000 timings don't apply — see the `caveat`. */
  applicable: boolean;
  caveat?: string;
  functions: FunctionStall[]; // descending by stall
  totalMeasured: number;
  totalTheoretical: number;
}

// Bus owners collapsed to the categories worth reporting. Deliberately coarse: the point is to
// answer "was the CPU working, blocked, or idle while this function ran", not to reproduce the
// viewer's per-channel legend.
function ownerGroup(owner: number): string {
  if (owner >= BusOwner.BPL1 && owner <= BusOwner.BPL8) return "BITPLANE";
  if (owner >= BusOwner.SPRITE0 && owner <= BusOwner.SPRITE7) return "SPRITE";
  if (owner >= BusOwner.AUD0 && owner <= BusOwner.AUD3) return "AUDIO";
  switch (owner) {
    case BusOwner.CPU: return "CPU";
    case BusOwner.COPPER: return "COPPER";
    case BusOwner.BLITTER: return "BLITTER";
    case BusOwner.DISK: return "DISK";
    case BusOwner.REFRESH: return "REFRESH";
    case BusOwner.BLOCKED: return "BLOCKED"; // CPU wanted the bus and was denied
    default: return "IDLE";
  }
}

// Leaf function name for sample k. Reads the model's own symbolication rather than re-deriving
// it, so names match the viewer exactly (including the "(inlined)" suffix and [Kick]/[IRQ]
// synthetic labels).
function leafOf(model: IProfileModel, k: number): { name: string; file?: string } {
  const node = model.nodes[model.samples[k + 1]];
  const loc = node ? model.locations[node.locationId] : undefined;
  if (!loc) return { name: `0x${(model.pcs[k] ?? 0).toString(16)}` };
  return { name: loc.callFrame.functionName, file: loc.callFrame.url || undefined };
}

// Exported (alongside checkFrame below) so tests can exercise the aggregation and threshold
// logic directly against hand-built models/FrameAnalysis objects — the same reasoning as
// columns.ts exporting buildColumns, without needing a full encoded .puaeprofile + embedded ELF
// just to test a threshold.
export function analyseFrame(model: IProfileModel, index: number): FrameAnalysis {
  const n = model.pcs.length;
  const dmaSlots = model.dma ? model.dma.owner.length : 0;
  const frameCycles = dmaSlots || PAL_FRAME_CCK;

  // buildColumns is the real layout the flame graph renders, and its column k corresponds to
  // sample k (one column per sample, in order — its merge pass never touches x1/x2). Running it
  // here is what lets the width-vs-cycles check see what a user would actually see.
  const columns = buildColumns(model);

  const byFn = new Map<string, FunctionCost>();
  let cycles = 0;
  let zeroCostSamples = 0;
  for (let k = 0; k < n; k++) {
    const cost = model.timeDeltas[k] ?? 0;
    cycles += cost;
    if (cost === 0) zeroCostSamples++;
    const { name, file } = leafOf(model, k);
    const key = `${name} ${file ?? ""}`;
    let e = byFn.get(key);
    if (!e) { e = { name, file, samples: 0, selfCycles: 0, selfPct: 0, widthPct: 0 }; byFn.set(key, e); }
    e.samples++;
    e.selfCycles += cost;
    const col = columns[k];
    if (col) e.widthPct += (col.x2 - col.x1) * 100;
  }
  for (const e of byFn.values()) e.selfPct = cycles > 0 ? (e.selfCycles / cycles) * 100 : 0;

  // Instruction-fetch cells, and how many samples the layout could actually anchor to one.
  // Recomputing the match count here (rather than plumbing it out of buildSampleSlots) keeps
  // buildColumns' signature untouched; it's a single linear pass over the grid.
  let fetchCells = 0;
  if (model.dma) {
    const { owner, flags } = model.dma;
    for (let i = 0; i < owner.length; i++) {
      if (owner[i] === BusOwner.CPU && (flags[i] & 0x4) !== 0) fetchCells++;
    }
  }
  // The matcher's own count of samples it tied to a real fetch cell. Re-running buildSampleSlots
  // repeats a linear pass buildColumns already did, which is irrelevant for an offline report and
  // buys an exact figure rather than one inferred from column widths.
  const anchoredSamples = model.dma && model.pcs.length
    ? buildSampleSlots(model.pcs, model.timeDeltas, model.dma).matched
    : 0;

  const dmaOwners: DmaOwnerCount[] = [];
  if (model.dma) {
    const counts = new Map<string, number>();
    for (const o of model.dma.owner) counts.set(ownerGroup(o), (counts.get(ownerGroup(o)) ?? 0) + 1);
    for (const [name, cells] of counts) dmaOwners.push({ name, cells, pct: (cells / dmaSlots) * 100 });
    dmaOwners.sort((a, b) => b.cells - a.cells);
  }

  return {
    index,
    samples: n,
    cycles,
    frameCycles,
    cyclePct: frameCycles > 0 ? (cycles / frameCycles) * 100 : 0,
    zeroCostSamples,
    registerSamples: model.registers ? Math.floor(model.registers.length / REG_COUNT) : 0,
    dmaSlots,
    fetchCells,
    anchoredSamples,
    functions: [...byFn.values()].sort((a, b) => b.selfCycles - a.selfCycles),
    dmaOwners,
  };
}

export function checkFrame(f: FrameAnalysis, isLast: boolean, findings: ProfileFinding[]): void {
  const budget = isLast ? LAST_FRAME_OVERRUN_TOLERANCE : FRAME_OVERRUN_TOLERANCE;
  if (f.cycles > f.frameCycles * budget) {
    findings.push({
      severity: "error",
      code: "frame-over-budget",
      frame: f.index,
      message: `frame ${f.index} reports ${f.cycles} cycles = ${f.cyclePct.toFixed(1)}% of the ${f.frameCycles} color clocks the frame physically contains`,
      hint: "per-sample cycle costs are being over-reported; see wasm_profile_instrHook's cycleDelta accounting",
    });
  } else if (isLast && f.cycles > f.frameCycles) {
    findings.push({
      severity: "info",
      code: "last-frame-overrun",
      frame: f.index,
      message: `frame ${f.index} (the last) runs ${(f.cyclePct - 100).toFixed(1)}% past the frame boundary`,
      hint: "expected: retro_run() returns a few scanlines late and no marker bounds the final frame",
    });
  }

  if (f.cycles < f.frameCycles * FRAME_SHORTFALL_TOLERANCE) {
    findings.push({
      severity: "warning",
      code: "frame-short",
      frame: f.index,
      message: `frame ${f.index} accounts for only ${f.cyclePct.toFixed(1)}% of its ${f.frameCycles} color clocks`,
      hint: "recording stopped early (profile buffer full) or the CPU spent the rest of the frame outside the profiled address range",
    });
  }

  if (f.registerSamples > 0 && f.registerSamples < f.samples) {
    findings.push({
      severity: "info",
      code: "registers-truncated",
      frame: f.index,
      message: `frame ${f.index} has registers for ${f.registerSamples} of ${f.samples} samples`,
      hint: "register buffer cap reached; profile samples are unaffected, but the Disassembly view's register panel stops there",
    });
  }

  if (f.dmaSlots === 0) {
    findings.push({
      severity: "warning",
      code: "no-dma-grid",
      frame: f.index,
      message: `frame ${f.index} has no DMA grid`,
      hint: "flame-graph positions fall back to cycle-cost fractions, and no bus-contention context is available",
    });
    return;
  }

  if (f.fetchCells > 0 && f.anchoredSamples / f.fetchCells < LOW_ANCHOR_RATE) {
    findings.push({
      severity: "info",
      code: "low-anchor-rate",
      frame: f.index,
      message: `frame ${f.index} used ${f.anchoredSamples} of the ${f.fetchCells} instruction-fetch cells available to anchor to (${((f.anchoredSamples / f.fetchCells) * 100).toFixed(0)}%), across ${f.samples} samples`,
      hint: "most flame-graph positions are interpolated from cycle cost rather than observed; see buildSampleSlots' CODE_MATCH_WINDOW",
    });
  }

  // The check that catches a layout bug the cycle numbers alone cannot reveal.
  for (const fn of f.functions) {
    const diff = Math.abs(fn.widthPct - fn.selfPct);
    if (diff > WIDTH_DIVERGENCE_PP) {
      findings.push({
        severity: "error",
        code: "width-vs-cycles",
        frame: f.index,
        message: `frame ${f.index}: ${fn.name} occupies ${fn.widthPct.toFixed(1)}% of the flame graph but only ${fn.selfPct.toFixed(1)}% of the frame's cycles`,
        hint: "flame-graph box positions disagree with the measured cost; see buildSampleSlots in columns.ts",
      });
    }
  }
}

// Measured-vs-datasheet cost per function. Takes the FRAME's own disassembly rather than the
// document's: ProfileManifest.disassembly holds frame 0's only, and buildFramesFromCaptures
// reweights per-instruction hits/cycles onto each later frame. Reading the manifest here made
// every frame report frame 0's figures — visibly wrong on a capture whose bus load alternates
// between frames. Instructions 68kcounter can't time are counted in `untimed` and excluded from
// both totals rather than silently contributing to one side.
export function analyseStalls(
  disassembly: IDisassembledFunction[] | undefined,
  zeroCostSamples: number,
): StallAnalysis {
  const functions: FunctionStall[] = [];
  let totalMeasured = 0;
  let totalTheoretical = 0;

  for (const fn of disassembly ?? []) {
    let measured = 0;
    let theoretical = 0;
    let busAccesses = 0;
    let untimed = 0;
    for (const ins of fn.instructions) {
      if (ins.hits === 0) continue; // never executed this frame
      const t = theoreticalTiming(ins.text);
      if (!t) { untimed++; continue; }
      measured += ins.cycles;
      theoretical += t.cck * ins.hits;
      busAccesses += (t.reads + t.writes) * ins.hits;
    }
    if (measured === 0 && untimed === 0) continue;
    const stall = measured - theoretical;
    functions.push({
      name: fn.name, measured, theoretical, stall,
      stallPct: measured > 0 ? (stall / measured) * 100 : 0,
      busAccesses, untimed,
    });
    totalMeasured += measured;
    totalTheoretical += theoretical;
  }
  functions.sort((a, b) => b.stall - a.stall);

  const { applicable, caveat } = datasheetApplicability(zeroCostSamples, totalMeasured, totalTheoretical);
  return { applicable, caveat, functions, totalMeasured, totalTheoretical };
}

/**
 * Per-instruction costs within one function.
 *
 * `query` is matched leniently — exact name first (case-insensitively), then a unique substring —
 * because a caller reading a function table shouldn't have to reproduce a mangled or suffixed
 * name exactly. An ambiguous or unknown query throws with the candidates listed, since silently
 * picking one would attribute costs to the wrong routine.
 */
export function analyseInstructions(
  disassembly: IDisassembledFunction[] | undefined,
  query: string,
  zeroCostSamples: number,
): InstructionAnalysis {
  const functions = disassembly ?? [];
  if (functions.length === 0) {
    throw new ProfileRequestError(
      "This frame carries no disassembly, so per-instruction costs aren't available for it.",
    );
  }
  const wanted = query.trim().toLowerCase();
  const exact = functions.filter((f) => f.name.toLowerCase() === wanted);
  const matches = exact.length ? exact : functions.filter((f) => f.name.toLowerCase().includes(wanted));
  if (matches.length === 0) {
    throw new ProfileRequestError(
      `No executed function matching "${query}" in this frame. Executed functions: ` +
        functions.map((f) => f.name).join(", "),
    );
  }
  if (matches.length > 1) {
    throw new ProfileRequestError(
      `"${query}" matches ${matches.length} functions: ${matches.map((f) => f.name).join(", ")}. Be more specific.`,
    );
  }

  const fn = matches[0];
  // Totals for the datasheet gate are computed over this function alone: it is the only code
  // being reported on, so a global figure could declare the comparison applicable (or not) on
  // the strength of code the caller isn't looking at.
  // Datasheet cost comes from theoreticalTiming(text), not the model's precomputed
  // `theoreticalCycles` field: analyseStalls derives it the same way, so both report identical
  // numbers for the same instruction, and neither silently loses the comparison against a model
  // whose optional field wasn't populated.
  let measured = 0;
  let theoretical = 0;
  const timings = fn.instructions.map((ins) => theoreticalTiming(ins.text)?.cck);
  fn.instructions.forEach((ins, i) => {
    const cck = timings[i];
    if (ins.hits === 0 || cck === undefined) return;
    measured += ins.cycles;
    theoretical += cck * ins.hits;
  });
  const { applicable, caveat } = datasheetApplicability(zeroCostSamples, measured, theoretical);

  const instructions = fn.instructions.map((ins, i) => {
    const cyclesPerHit = ins.hits > 0 ? ins.cycles / ins.hits : 0;
    const theoreticalCycles = timings[i];
    return {
      address: ins.address,
      text: ins.text,
      line: ins.line,
      hits: ins.hits,
      cycles: ins.cycles,
      cyclesPerHit,
      pctOfFunction: fn.totalCycles > 0 ? (ins.cycles / fn.totalCycles) * 100 : 0,
      theoreticalCycles,
      stallPerHit:
        applicable && ins.hits > 0 && theoreticalCycles !== undefined
          ? cyclesPerHit - theoreticalCycles
          : undefined,
    };
  });

  const last = fn.instructions[fn.instructions.length - 1];
  return {
    name: fn.name,
    address: fn.address,
    totalCycles: fn.totalCycles,
    // `end` is the symbol's real end; the listing stops early when the decode budget ran out.
    truncated: last !== undefined && last.address + last.length < fn.end,
    datasheetApplicable: applicable,
    datasheetCaveat: caveat,
    instructions,
  };
}

export function analyseProfile(file: Uint8Array, opts: { stalls?: boolean; instructions?: string } = {}): ProfileAnalysis {
  const { frames, manifest } = loadProfile(file);
  const analysed = frames.map((f, i) => {
    const a = analyseFrame(f.model, i);
    if (opts.stalls) a.stalls = analyseStalls(f.model.disassembly, a.zeroCostSamples);
    if (opts.instructions) {
      a.instructionDetail = analyseInstructions(f.model.disassembly, opts.instructions, a.zeroCostSamples);
    }
    return a;
  });
  const findings: ProfileFinding[] = [];

  const { total, inRange } = manifest.meta;
  if (total > 0 && inRange < total) {
    findings.push({
      severity: "info",
      code: "out-of-range-instructions",
      message: `${total - inRange} of ${total} executed instructions were outside the profiled address range (${((1 - inRange / total) * 100).toFixed(1)}%)`,
      hint: "ROM/OS/interrupt code is never sampled; its time folds into the preceding in-range sample",
    });
  }

  analysed.forEach((f, i) => checkFrame(f, i === analysed.length - 1, findings));

  const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.frame ?? -1) - (b.frame ?? -1));
  return { manifest, frames: analysed, findings };
}
