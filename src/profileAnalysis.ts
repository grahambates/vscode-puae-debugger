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

import { analyseIterations, IterationAnalysis } from "./profileIterations";
import { buildColumns, buildSampleSlots, columnIndexAtX, countCalls } from "./webview/profilerViewer/columns";
import { blitLabel, blitTooltip, getBlits } from "./webview/profilerViewer/blits";
import { createSymbolizer } from "./webview/profilerViewer/symbols";
import { disassembleCopperInstruction } from "./shared/copperDisassembler";
import { formatInstruction } from "./m68kDisassembly";
import { BusOwner, DMA_HPOS, IComputedNode, IDisassembledFunction, ILocation, IProfileModel, REG_COUNT } from "./shared/profilerTypes";
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
  /**
   * Including everything it called — the profiler's top-down Time view. Counted once per call
   * path even when the function recurses, so it never exceeds the frame.
   */
  totalCycles: number;
  totalPct: number;
  widthPct: number; // share of the flame graph's width (should track selfPct)
  /**
   * Times it was entered during the frame: each new box the flame graph draws for it. One already
   * running when the frame began isn't counted — it was entered in an earlier frame. A labelled
   * part of a routine reached by a branch counts as an entry too, as it gets a box of its own.
   */
  calls: number;
}

/** One node of the top-down call tree: a function as reached by one particular call path. */
export interface CallTreeNode {
  name: string;
  file?: string;
  selfCycles: number;
  totalCycles: number;
  children: CallTreeNode[]; // descending by totalCycles
}

/**
 * One box of the flame graph: a function on the stack continuously from `start` to `end` (DMA
 * slots from the frame's start — one colour clock each, DMA_HPOS per line), with what it called
 * nested inside. Boxes too short to matter are folded into `folded`, by function.
 */
export interface FlameBox {
  name: string;
  file?: string;
  start: number;
  end: number;
  /** Clipped by the window: the function was already running before it, or carries on after. */
  startsBefore?: boolean;
  endsAfter?: boolean;
  children: FlameBox[]; // in time order
  folded: { name: string; count: number; slots: number }[]; // descending by slots
}

export interface FlameView {
  /** The window shown, in slots: the whole frame, or the lines asked for. */
  start: number;
  end: number;
  /** Boxes shorter than this many slots were folded. */
  minSlots: number;
  boxes: FlameBox[];
  folded: { name: string; count: number; slots: number }[];
  /** Whether positions come from the DMA grid (as the flame graph draws them) or from cycle costs. */
  anchored: boolean;
  /** Bus use within the window — the flame graph's DMA strip, summed. */
  dma: DmaOwnerCount[];
}

/** One blitter operation, as the profiler's Blitter view reconstructs it from the DMA grid. */
export interface BlitSummary {
  index: number;
  /** "Blit ABCD 64x32px", "Clear --CD 320x256px", "Line A-CD 120px" — the view's own label. */
  label: string;
  startSlot: number;
  /**
   * Started in an earlier frame and still running when this one began: startSlot is then 0, the
   * frame's start, and the channel pointers are where the blit had got to, not where it started.
   */
  startedBefore: boolean;
  /** The final D write; equal to startSlot if no blitter cycles were seen after the start. */
  endSlot: number;
  /** False when the blit was still running when the frame ended (or the capture had no blitter cycles). */
  finished: boolean;
  minterm: string; // "$ca"
  mintermExpr: string; // "AB + ĀC"
  /** The CPU function running when BLTSIZE was written — the code that started this blit. */
  startedBy?: string;
  /** Channel pointers and modulos, for the channels that take part; symbolicated where possible. */
  channels: { label: string; ptr?: string; literal?: string; modulo: number; shift?: number }[];
  /**
   * Registers last written before the capture began, so the values above read 0 for them rather
   * than what the blitter actually used (the registers are write-only; only writes inside the
   * frame are recorded). With BLTCON0 here, the operation and channels themselves are unknown.
   */
  unseen: string[];
}

export interface BlitAnalysis {
  blits: BlitSummary[];
  /** Slots the blitter owned the bus this frame. */
  busySlots: number;
  /** BLTSIZE writes but no blitter bus cycles: a fast (non-cycle-exact) blitter; timings are estimates. */
  fastBlitter: boolean;
}

/** One executed copper instruction, as the profiler's Copper view lists it. */
export interface CopperStep {
  /** DMA slot it executed at: line * DMA_HPOS + hpos. */
  slot: number;
  address: number;
  /** The symbol the instruction sits in (a copper list's label), if any. */
  symbol?: string;
  text: string; // "MOVE #$0F00,COLOR00", "WAIT 44,6"
  /** For a WAIT: slots until the copper's next instruction ran — how long it actually waited. */
  waitedSlots?: number;
}

export interface CopperTrace {
  /** Instructions executed this frame (in the window, when one was given). */
  steps: CopperStep[];
  /** Total executed in the whole frame, before any window. */
  executed: number;
}

/** One call path into a function, and the cycles spent in it (including callees) via that path. */
export interface CallerPath {
  path: string[]; // outermost first, ending with the function itself
  cycles: number;
  pct: number; // of the frame
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
  /** Present only when the call tree was requested. Its children are the outermost calls. */
  callTree?: CallTreeNode;
  /** Present only when callers were requested: every path into that function this frame. */
  callers?: CallerPath[];
  /** Present only when the flame graph was requested. */
  flame?: FlameView;
  /** Present only when blits were requested and the capture has a DMA grid. */
  blits?: BlitAnalysis;
  /** Present only when the copper trace was requested and the capture recorded one. */
  copper?: CopperTrace;
  /**
   * The screen output is byte-identical to the previous frame's — the profiler filmstrip's "="
   * badge. Never true for frame 0 (nothing earlier in the capture to compare against).
   */
  duplicateOfPrevious: boolean;
}

/**
 * How often the picture actually changed across a multi-frame capture. Repeated frames are the
 * only program-independent sign of a missed frame: an effect that normally updates every frame
 * and then shows the same picture twice didn't finish in time. There's no other useful
 * definition of an application "frame" to measure against.
 */
export interface ScreenUpdates {
  /** Frames compared — every frame after the first. */
  compared: number;
  /** Indices of frames identical to the frame before. */
  repeats: number[];
  /**
   * How many frames each picture stayed on screen, as { frames held: occurrences }. Only holds
   * bounded by a change at both ends — the first and last pictures may have started before the
   * capture or carried on after it, so their lengths aren't known.
   */
  holds: Record<number, number>;
  /** Display refresh rate, for turning hold lengths into an update rate. */
  refreshHz: number;
}

export function summariseScreenUpdates(duplicates: boolean[], refreshHz: number): ScreenUpdates | undefined {
  if (duplicates.length < 2) return undefined;
  const repeats: number[] = [];
  const changes: number[] = [];
  for (let i = 1; i < duplicates.length; i++) (duplicates[i] ? repeats : changes).push(i);
  const holds: Record<number, number> = {};
  for (let k = 1; k < changes.length; k++) {
    const held = changes[k] - changes[k - 1];
    holds[held] = (holds[held] ?? 0) + 1;
  }
  return { compared: duplicates.length - 1, repeats, holds, refreshHz };
}

export interface ProfileAnalysis {
  manifest: ProfileManifest;
  frames: FrameAnalysis[];
  findings: ProfileFinding[];
  /** Multi-frame captures only. */
  screenUpdates?: ScreenUpdates;
  /**
   * The function name `--instructions` asked for, if any. Carried so a report can distinguish
   * "this frame didn't run that function" from "no detail was requested" — the two look identical
   * from a frame with no `instructionDetail`.
   */
  instructionQuery?: string;
  /** The function `callers` resolved to, as the capture spells it. */
  callersOf?: string;
  /** Present only when iterations were requested. */
  iterations?: IterationAnalysis;
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
/** Same keying as the function table's: name plus file, so the two agree on what "a function" is. */
function functionKey(loc: ILocation): { key: string; name: string; file?: string } {
  const name = loc.callFrame.functionName;
  const file = loc.callFrame.url || undefined;
  return { key: `${name} ${file ?? ""}`, name, file };
}

/**
 * Walks the call tree outermost-first, calling `visit` for each node with the path of functions
 * above it, and whether this is the outermost occurrence of its function on that path — which is
 * what makes recursion count once rather than once per level.
 */
function walkCallTree(
  model: IProfileModel,
  visit: (node: IComputedNode, fn: ReturnType<typeof functionKey>, path: string[], outermost: boolean) => void,
): void {
  if (model.nodes.length === 0) return;
  const depthOnPath = new Map<string, number>();
  const path: string[] = [];
  const recurse = (id: number) => {
    const node = model.nodes[id];
    const loc = model.locations[node.locationId];
    if (!loc) return;
    const fn = functionKey(loc);
    const depth = depthOnPath.get(fn.key) ?? 0;
    path.push(fn.name);
    visit(node, fn, path, depth === 0);
    depthOnPath.set(fn.key, depth + 1);
    for (const child of node.children) recurse(child);
    depthOnPath.set(fn.key, depth);
    path.pop();
  };
  for (const child of model.nodes[0].children) recurse(child);
}

function inclusiveCycles(model: IProfileModel): Map<string, { name: string; file?: string; cycles: number }> {
  const totals = new Map<string, { name: string; file?: string; cycles: number }>();
  walkCallTree(model, (node, fn, _path, outermost) => {
    if (!outermost) return;
    const e = totals.get(fn.key) ?? { name: fn.name, file: fn.file, cycles: 0 };
    e.cycles += node.aggregateTime;
    totals.set(fn.key, e);
  });
  return totals;
}

export function buildCallTree(model: IProfileModel): CallTreeNode {
  const build = (id: number): CallTreeNode | undefined => {
    const node = model.nodes[id];
    const loc = model.locations[node.locationId];
    if (!loc) return undefined;
    const { name, file } = functionKey(loc);
    const children = node.children.map(build).filter((c): c is CallTreeNode => c !== undefined);
    children.sort((a, b) => b.totalCycles - a.totalCycles);
    return { name, file, selfCycles: node.selfTime, totalCycles: node.aggregateTime, children };
  };
  const top = (model.nodes[0]?.children ?? []).map(build).filter((c): c is CallTreeNode => c !== undefined);
  top.sort((a, b) => b.totalCycles - a.totalCycles);
  return { name: "(frame)", selfCycles: 0, totalCycles: top.reduce((n, c) => n + c.totalCycles, 0), children: top };
}

/** Every call path into `name` (outermost occurrences only), merged and by cost. */
// Boxes under this share of the window are folded: a hot loop calling a helper per iteration
// is thousands of boxes, and the shape — which calls happen, how often, at what cost — is the
// useful part, not each one.
const FLAME_MIN_FRACTION = 0.005;

/**
 * The flame graph as boxes, from the same column layout the profiler's flame graph draws
 * (buildColumns: positions anchored to the DMA grid's instruction fetches where possible), so the
 * text and the picture can't disagree about when something ran.
 */
export function buildFlame(model: IProfileModel, lines?: { from: number; to: number }): FlameView {
  const columns = buildColumns(model);
  const totalSlots = model.dma?.owner.length || PAL_FRAME_CCK;
  const anchored = !!model.dma && model.pcs.length > 0 && buildSampleSlots(model.pcs, model.timeDeltas, model.dma).matched > 0;
  const winStart = lines ? Math.max(0, lines.from * DMA_HPOS) : 0;
  const winEnd = lines ? Math.min(totalSlots, (lines.to + 1) * DMA_HPOS) : totalSlots;
  const minSlots = Math.max(1, (winEnd - winStart) * FLAME_MIN_FRACTION);

  // Every merged run at every depth: a cell that is a location object starts a box; numeric
  // cells pointing back at it extend it.
  type Raw = { name: string; file?: string; depth: number; start: number; end: number };
  const open = new Map<string, Raw>(); // `${depth}:${startColumn}` -> box
  const raws: Raw[] = [];
  columns.forEach((col, x) => {
    col.rows.forEach((cell, depth) => {
      const startCol = typeof cell === "number" ? cell : x;
      const key = `${depth}:${startCol}`;
      let box = open.get(key);
      if (!box) {
        const loc = (typeof cell === "number" ? columns[cell].rows[depth] : cell) as ILocation;
        const { name, file } = functionKey(loc);
        box = { name, file, depth, start: col.x1 * totalSlots, end: col.x2 * totalSlots };
        open.set(key, box);
        raws.push(box);
      }
      box.end = Math.max(box.end, col.x2 * totalSlots);
    });
  });

  // Clip to the window, then nest by time: sorted by start then depth, each box's parent is the
  // nearest open box one level up.
  const inWindow = raws
    .filter((b) => b.end > winStart && b.start < winEnd)
    .map((b) => ({ ...b, startsBefore: b.start < winStart, endsAfter: b.end > winEnd, start: Math.max(b.start, winStart), end: Math.min(b.end, winEnd) }))
    .sort((a, b) => a.start - b.start || a.depth - b.depth);
  const top: FlameBox[] = [];
  const topFolded = new Map<string, { name: string; count: number; slots: number }>();
  const folds = new Map<FlameBox, Map<string, { name: string; count: number; slots: number }>>();
  const stack: { depth: number; box: FlameBox }[] = [];
  const minDepth = inWindow.reduce((d, b) => Math.min(d, b.depth), Infinity);
  for (const raw of inWindow) {
    while (stack.length && stack[stack.length - 1].depth >= raw.depth) stack.pop();
    const parent = stack[stack.length - 1]?.box;
    if (raw.end - raw.start < minSlots) {
      // A folded box's own callees fold with it: they're inside its time already.
      if (parent && stack[stack.length - 1].depth !== raw.depth - 1) continue;
      if (!parent && raw.depth !== minDepth) continue;
      const target = parent ? (folds.get(parent) ?? folds.set(parent, new Map()).get(parent)!) : topFolded;
      const f = target.get(raw.name) ?? { name: raw.name, count: 0, slots: 0 };
      f.count++;
      f.slots += raw.end - raw.start;
      target.set(raw.name, f);
      continue;
    }
    if (parent ? stack[stack.length - 1].depth !== raw.depth - 1 : raw.depth !== minDepth) continue; // under a folded box
    const box: FlameBox = { name: raw.name, file: raw.file, start: raw.start, end: raw.end, children: [], folded: [] };
    if (raw.startsBefore) box.startsBefore = true;
    if (raw.endsAfter) box.endsAfter = true;
    (parent ? parent.children : top).push(box);
    stack.push({ depth: raw.depth, box });
  }
  const sortFolded = (m?: Map<string, { name: string; count: number; slots: number }>) =>
    [...(m?.values() ?? [])].sort((a, b) => b.slots - a.slots);
  for (const [box, m] of folds) box.folded = sortFolded(m);

  const dma: DmaOwnerCount[] = [];
  if (model.dma) {
    const counts = new Map<string, number>();
    for (let s = winStart; s < winEnd; s++) counts.set(ownerGroup(model.dma.owner[s]), (counts.get(ownerGroup(model.dma.owner[s])) ?? 0) + 1);
    for (const [name, cells] of counts) dma.push({ name, cells, pct: (cells / (winEnd - winStart)) * 100 });
    dma.sort((a, b) => b.cells - a.cells);
  }
  return { start: winStart, end: winEnd, minSlots, boxes: top, folded: sortFolded(topFolded), anchored, dma };
}

/**
 * Replaces each instruction's text — m68kdecode's raw rendering, as stored in the capture — with
 * the readable form emulator_disassemble prints: absolute addresses and immediates in hex, branch
 * targets instead of displacements, and symbols, custom registers and CIAs named. Re-decoded from
 * the instruction's own stored bytes, so it applies to captures saved before this existed.
 *
 * Display only: the datasheet timings were computed from the raw text first (68kcounter parses
 * that syntax), and are left exactly as they were.
 */
function formatInstructionText(detail: InstructionAnalysis, model: IProfileModel): void {
  const fn = model.disassembly?.find((f) => f.address === detail.address);
  if (!fn) return;
  const byAddress = new Map(fn.instructions.map((ins) => [ins.address, ins]));
  const symbolize = createSymbolizer(model.symbols);
  for (const ins of detail.instructions) {
    const stored = byAddress.get(ins.address);
    if (!stored?.hex) continue;
    ins.text = formatInstruction(stored.hex, ins.address, symbolize);
    // A library call's name, resolved when the capture was made (see annotateLibraryCalls).
    if (stored.comment) ins.text += ins.text.includes("  ; ") ? `, ${stored.comment}` : `  ; ${stored.comment}`;
  }
}

/**
 * The frame's blits, reconstructed exactly as the Blitter view does (getBlits over the DMA grid),
 * plus which CPU function started each — the code that wrote BLTSIZE, from the flame graph's own
 * column layout at that slot.
 */
export function analyseBlits(model: IProfileModel): BlitAnalysis | undefined {
  if (!model.dma) return undefined;
  // Only a snapshot recorded at the frame's start is a valid baseline; an older capture's is the
  // state after it, and seeding from that would present a later value as the one the blit used.
  const baseline = model.dmaSnapshot?.atFrameStart ? model.dmaSnapshot.custom : undefined;
  const { blits, fastBlitter } = getBlits(model.dma, baseline);
  const symbolize = createSymbolizer(model.symbols);
  const pointer = (addr: number) => {
    const sym = symbolize(addr);
    return `$${(addr >>> 0).toString(16).padStart(6, "0")}${sym ? ` (${sym})` : ""}`;
  };
  const columns = buildColumns(model);
  const slots = model.dma.owner.length;
  const leafAt = (slot: number): string | undefined => {
    const col = columns[columnIndexAtX(columns, (slot + 0.5) / slots)];
    let cell = col?.rows[col.rows.length - 1];
    if (typeof cell === "number") cell = columns[cell].rows[col.rows.length - 1];
    return (cell as ILocation | undefined)?.callFrame.functionName;
  };
  let busySlots = 0;
  for (const o of model.dma.owner) if (o === BusOwner.BLITTER) busySlots++;
  return {
    fastBlitter,
    busySlots,
    blits: blits.map((blit, index) => {
      const tip = blitTooltip(blit);
      // Without BLTCON0 the operation, channels and minterm are all reconstructed from a 0 that
      // was never written; only the size (from BLTSIZE itself) is known.
      const opKnown = !blit.unseen.includes("BLTCON0");
      return {
        index,
        label: opKnown ? blitLabel(blit) : `${blit.startedBefore ? "… " : ""}? ${tip.size}`,
        startSlot: blit.startSlot,
        startedBefore: blit.startedBefore,
        endSlot: blit.endSlot,
        finished: blit.finished,
        minterm: opKnown ? tip.mintermHex : "?",
        mintermExpr: opKnown ? tip.mintermExpr : "",
        // Whatever ran at the frame's start didn't start a blit from an earlier frame.
        startedBy: blit.startedBefore ? undefined : leafAt(blit.startSlot),
        channels: tip.channels.map((c) => ({
          label: c.label,
          ptr: c.ptr !== undefined ? pointer(c.ptr) : undefined,
          literal: c.literal !== undefined ? `$${c.literal.toString(16).padStart(4, "0")}` : undefined,
          modulo: c.modulo,
          shift: c.shift,
        })),
        unseen: [...new Set(blit.unseen.map((r) => r.replace(/PT[HL]$/, "PT")))],
      };
    }),
  };
}

/**
 * The copper instructions executed this frame, in order — the Copper view's list. A WAIT is
 * recorded where the copper first reached it (decodeCopperRecords drops the wake-up copy), so
 * the gap to the next instruction is how long it really waited: the timing fact a copper list
 * is written around.
 */
export function analyseCopper(model: IProfileModel, lines?: { from: number; to: number }): CopperTrace | undefined {
  const copper = model.copper;
  if (!copper) return undefined;
  const symbolize = createSymbolizer(model.symbols);
  const n = copper.addr.length;
  // hpos is clamped as the Copper view clamps it: the raw hardware hpos can run past the last
  // DMA slot of a line, which would otherwise land the instruction on the next line.
  const slotOf = (i: number) => copper.vpos[i] * DMA_HPOS + Math.min(copper.hpos[i], DMA_HPOS - 1);
  const steps: CopperStep[] = [];
  for (let i = 0; i < n; i++) {
    const line = copper.vpos[i];
    if (lines && (line < lines.from || line > lines.to)) continue;
    const ins = disassembleCopperInstruction(copper.addr[i], copper.w1[i], copper.w2[i]);
    const step: CopperStep = {
      slot: slotOf(i),
      address: copper.addr[i],
      symbol: symbolize(copper.addr[i]),
      text: `${ins.mnemonic} ${ins.operands}`.trim() + (ins.comment ? `  ; ${ins.comment}` : ""),
    };
    if (ins.mnemonic === "WAIT" && i + 1 < n) step.waitedSlots = slotOf(i + 1) - step.slot;
    steps.push(step);
  }
  return { steps, executed: n };
}

/** "40-80" or "44" as an inclusive range of raster lines, for zooming the flame graph. */
export function parseLineRange(text: string): { from: number; to: number } {
  const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(text);
  const from = m ? Number(m[1]) : NaN;
  const to = m ? Number(m[2] ?? m[1]) : NaN;
  if (!m || from > to || to >= 313) {
    throw new ProfileRequestError(`Lines must be "FROM-TO" or "LINE" within 0-312 (a PAL frame), got "${text}".`);
  }
  return { from, to };
}

/**
 * A function name as the capture spells it: exact match first, else a unique case-insensitive
 * substring — the same leniency `instructions` gives, and the same refusal to guess between two.
 */
function resolveFunctionName(names: string[], query: string): string {
  const all = [...new Set(names)];
  if (all.includes(query)) return query;
  const wanted = query.trim().toLowerCase();
  const near = all.filter((n) => n.toLowerCase().includes(wanted));
  if (near.length === 1) return near[0];
  if (near.length > 1) throw new ProfileRequestError(`"${query}" matches several functions: ${near.slice(0, 12).join(", ")}. Use the exact name.`);
  throw new ProfileRequestError(`No function "${query}" in this capture. Functions: ${all.slice(0, 20).join(", ")}${all.length > 20 ? ", …" : ""}`);
}

export function callersOf(model: IProfileModel, name: string, frameCycles: number): CallerPath[] {
  const byPath = new Map<string, CallerPath>();
  walkCallTree(model, (node, fn, path, outermost) => {
    if (!outermost || fn.name !== name) return;
    const key = path.join("\u0000");
    const e = byPath.get(key) ?? { path: [...path], cycles: 0, pct: 0 };
    e.cycles += node.aggregateTime;
    byPath.set(key, e);
  });
  const paths = [...byPath.values()].sort((a, b) => b.cycles - a.cycles);
  for (const p of paths) p.pct = frameCycles > 0 ? (p.cycles / frameCycles) * 100 : 0;
  return paths;
}

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
    if (!e) { e = { name, file, samples: 0, selfCycles: 0, selfPct: 0, totalCycles: 0, totalPct: 0, widthPct: 0, calls: 0 }; byFn.set(key, e); }
    e.samples++;
    e.selfCycles += cost;
    const col = columns[k];
    if (col) e.widthPct += (col.x2 - col.x1) * 100;
  }
  // Inclusive time comes from the call tree, not the samples. A function that only ever calls
  // others (main, a frame loop) has no self time at all, so it's added here or it would be
  // missing from the table entirely.
  for (const [key, inc] of inclusiveCycles(model)) {
    let e = byFn.get(key);
    if (!e) { e = { name: inc.name, file: inc.file, samples: 0, selfCycles: 0, selfPct: 0, totalCycles: 0, totalPct: 0, widthPct: 0, calls: 0 }; byFn.set(key, e); }
    e.totalCycles = inc.cycles;
  }
  // Calls: see countCalls — the same count the flame graph's tooltip shows.
  for (const [key, { name, file, calls }] of countCalls(columns)) {
    let e = byFn.get(key);
    if (!e) {
      e = { name, file, samples: 0, selfCycles: 0, selfPct: 0, totalCycles: 0, totalPct: 0, widthPct: 0, calls: 0 };
      byFn.set(key, e);
    }
    e.calls = calls;
  }
  for (const e of byFn.values()) {
    e.selfPct = cycles > 0 ? (e.selfCycles / cycles) * 100 : 0;
    // A leaf the tree doesn't reach (shouldn't happen) still has its own time as a floor.
    e.totalCycles = Math.max(e.totalCycles, e.selfCycles);
    e.totalPct = cycles > 0 ? (e.totalCycles / cycles) * 100 : 0;
  }

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
    // Lives on the raw capture, not the model — analyseProfile fills it in.
    duplicateOfPrevious: false,
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

/**
 * Resolves one function's per-instruction detail across every frame, tolerating the frames that
 * never ran it.
 *
 * A capture's frames don't all execute the same code — a routine can be absent from frame 0 and
 * dominate frame 1 — so a miss in any one frame is normal and must not fail the analysis. Only a
 * function absent from *every* frame is a bad request, and its error names what was executed
 * anywhere in the capture rather than whatever happened to be in the frame that failed first.
 *
 * Exported so this can be tested directly against hand-built disassembly, in the same spirit as
 * analyseFrame/checkFrame: reaching it through analyseProfile would need a multi-frame encoded
 * capture with real disassembly, which only the emulator can produce.
 */
export function selectInstructionDetail(
  frames: {
    disassembly: IDisassembledFunction[] | undefined;
    zeroCostSamples: number;
    /** Function names the frame's samples attribute time to — a superset of the disassembled ones. */
    executedFunctions: string[];
  }[],
  query: string,
): (InstructionAnalysis | undefined)[] {
  const details = frames.map((f) => {
    try {
      return analyseInstructions(f.disassembly, query, f.zeroCostSamples);
    } catch (err) {
      if (err instanceof ProfileRequestError) return undefined;
      throw err;
    }
  });
  if (details.some((d) => d !== undefined)) return details;

  // Nothing matched anywhere: report against the union of what every frame did execute, so the
  // caller sees the whole capture's vocabulary and not just one frame's.
  const executed = [...new Set(frames.flatMap((f) => (f.disassembly ?? []).map((fn) => fn.name)))];
  if (executed.length === 0) {
    throw new ProfileRequestError(
      "This capture carries no disassembly, so per-instruction costs aren't available for it.",
    );
  }
  const wanted = query.trim().toLowerCase();
  const ambiguous = executed.filter((name) => name.toLowerCase().includes(wanted));
  if (ambiguous.length > 1) {
    throw new ProfileRequestError(
      `"${query}" matches ${ambiguous.length} functions: ${ambiguous.join(", ")}. Be more specific.`,
    );
  }

  // A function can cost real time in a later frame and still have no disassembly: only the FIRST
  // frame's executed functions are disassembled, and later frames reuse that listing with their
  // own counts reweighted onto it (see reweightDisassembly). Saying "no such function" there is
  // wrong twice over — it did run, and the fix is to re-capture, not to correct the name.
  const ranIn = frames
    .map((f, i) => ({ i, names: f.executedFunctions.filter((n) => n.toLowerCase().includes(wanted)) }))
    .filter((f) => f.names.length > 0);
  if (ranIn.length > 0) {
    const names = [...new Set(ranIn.flatMap((f) => f.names))];
    throw new ProfileRequestError(
      `${names.join(", ")} ran in frame(s) ${ranIn.map((f) => f.i).join(", ")} but was never disassembled: a ` +
        "capture only disassembles the functions that executed in its FIRST frame, and later frames reuse that " +
        "listing with their own hit/cycle counts. To inspect it, re-capture so the frame that runs it is frame 0 " +
        "(e.g. raise warmupFrames by one). Function-level costs for it are still in the dump.",
    );
  }

  throw new ProfileRequestError(
    `No executed function matching "${query}" anywhere in this capture. Executed functions: ${executed.join(", ")}`,
  );
}

export function analyseProfile(
  file: Uint8Array,
  opts: {
    stalls?: boolean;
    instructions?: string;
    callTree?: boolean;
    callers?: string;
    /** The flame graph: the whole frame (true), or just these raster lines. */
    flame?: boolean | { from: number; to: number };
    blits?: boolean;
    /** The copper trace, for the whole frame or the `flame` window's lines when one is given. */
    copper?: boolean;
    /** Split the capture into iterations at each execution of this address, symbol or source line. */
    iterations?: string;
  } = {},
): ProfileAnalysis {
  const { frames, manifest, sourceMap } = loadProfile(file);
  const analysed = frames.map((f, i) => {
    const a = analyseFrame(f.model, i);
    a.duplicateOfPrevious = f.raw.duplicateOfPrevious === true;
    if (opts.stalls) a.stalls = analyseStalls(f.model.disassembly, a.zeroCostSamples);
    if (opts.callTree) a.callTree = buildCallTree(f.model);
    if (opts.flame) a.flame = buildFlame(f.model, opts.flame === true ? undefined : opts.flame);
    if (opts.blits) a.blits = analyseBlits(f.model);
    if (opts.copper) a.copper = analyseCopper(f.model, typeof opts.flame === "object" ? opts.flame : undefined);
    return a;
  });
  let callersName: string | undefined;
  if (opts.callers) {
    // Resolved against every frame's functions at once, like `instructions` below: the routine
    // may only run in some frames.
    callersName = resolveFunctionName(analysed.flatMap((a) => a.functions.map((fn) => fn.name)), opts.callers);
    frames.forEach((f, i) => { analysed[i].callers = callersOf(f.model, callersName!, analysed[i].cycles); });
  }
  if (opts.instructions) {
    // Resolved across all frames at once, not per frame inside the map above: a function that only
    // runs in a later frame would otherwise abort the whole analysis on the first frame that
    // didn't run it — which made exactly the routines worth inspecting unreachable.
    const details = selectInstructionDetail(
      frames.map((f, i) => ({
        disassembly: f.model.disassembly,
        zeroCostSamples: analysed[i].zeroCostSamples,
        executedFunctions: analysed[i].functions.map((fn) => fn.name),
      })),
      opts.instructions,
    );
    details.forEach((d, i) => {
      if (d) formatInstructionText(d, frames[i].model);
      analysed[i].instructionDetail = d;
    });
  }
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
  const screenUpdates = summariseScreenUpdates(
    analysed.map((f) => f.duplicateOfPrevious),
    manifest.meta.isPAL ? 50 : 60,
  );
  let iterations: IterationAnalysis | undefined;
  if (opts.iterations) {
    try {
      iterations = analyseIterations(frames.map((f) => f.model), sourceMap, opts.iterations);
    } catch (err) {
      // An address the capture can't resolve is the caller's argument, not a damaged file.
      throw new ProfileRequestError(`--iterations ${opts.iterations}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { manifest, frames: analysed, findings, screenUpdates, instructionQuery: opts.instructions, callersOf: callersName, iterations };
}
