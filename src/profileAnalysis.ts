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

import { buildColumns } from "./webview/profilerViewer/columns";
import { BusOwner, IProfileModel, REG_COUNT } from "./shared/profilerTypes";
import { loadProfile } from "./profileLoader";
import { ProfileManifest } from "./profileFormat";

// The emulator serialises a fixed PAL-geometry DMA grid (DMA_HPOS × DMA_VPOS in the C side), so
// a frame's grid cell count is also the number of color clocks in that frame — the ground truth
// every cycle figure here is measured against. Used as the fallback when a frame has no grid.
const PAL_FRAME_CCK = 227 * 313;

// A capture's final frame legitimately overruns: retro_run() returns a few scanlines past the
// true frame boundary and, unlike every earlier frame, nothing emits a boundary marker to cut it
// off there. Measured at ~1% (~3 scanlines) on real captures, so allow a little headroom on the
// last frame before calling it a fault.
const LAST_FRAME_OVERRUN_TOLERANCE = 1.05;
// Earlier frames are bounded on both sides by markers and should land on the frame length. Only
// rounding of the one unfinalized sample per frame should show up, hence a tight bound.
const FRAME_OVERRUN_TOLERANCE = 1.02;
// Below this, something swallowed samples (a full buffer) or the CPU spent the rest of the frame
// outside the profiled address range.
const FRAME_SHORTFALL_TOLERANCE = 0.8;
// A function whose flame-graph width and cycle share disagree by more than this (in percentage
// points of the frame) is being drawn in the wrong place, however plausible its cycle figure is.
const WIDTH_DIVERGENCE_PP = 3;
// Below this share of samples anchored to a real instruction fetch, flame-graph positions are
// mostly interpolated. Not a fault — a cached CPU emits no fetch cell for most instructions —
// but it decides how much to trust box positions, so it belongs in the report.
const LOW_ANCHOR_RATE = 0.2;

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
}

export interface ProfileAnalysis {
  manifest: ProfileManifest;
  frames: FrameAnalysis[];
  findings: ProfileFinding[];
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
  // A column narrower than a single grid slot never got its own anchor — it was interpolated or
  // extrapolated into place. Counting the rest approximates the anchored share closely enough to
  // judge how literally to read box positions.
  let anchoredSamples = 0;
  if (dmaSlots > 0) {
    const slot = 1 / dmaSlots;
    for (let k = 0; k < columns.length; k++) if (columns[k].x2 - columns[k].x1 >= slot) anchoredSamples++;
  }

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

  if (f.samples > 0 && f.anchoredSamples / f.samples < LOW_ANCHOR_RATE) {
    findings.push({
      severity: "info",
      code: "low-anchor-rate",
      frame: f.index,
      message: `frame ${f.index} anchored ~${f.anchoredSamples} of ${f.samples} samples to a real instruction fetch (${f.fetchCells} fetch cells in the grid)`,
      hint: "normal with an instruction cache — most positions are interpolated from cycle cost rather than observed directly",
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

export function analyseProfile(file: Uint8Array): ProfileAnalysis {
  const { frames, manifest } = loadProfile(file);
  const analysed = frames.map((f, i) => analyseFrame(f.model, i));
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
