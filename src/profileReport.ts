// Human-readable rendering of a ProfileAnalysis. Shared by the `profile` CLI subcommand and the
// MCP server's tools so both speak in exactly the same terms — a number a person reads in the
// terminal and a number a model reads over MCP should never be formatted differently, or a
// conversation about one won't transfer to the other.

import { AccessAnalysis, BlitAnalysis, CopperTrace, CallerPath, CallTreeNode, FlameBox, FlameView, FrameAnalysis, InstructionAnalysis, ProfileAnalysis, ScreenUpdates, StallAnalysis } from "./profileAnalysis";
import { CaptureSummary, ProfileDiff, Stat } from "./profileCompare";
import { IterationAnalysis, OVERRUN_TOLERANCE } from "./profileIterations";

export function pct(v: number): string {
  return `${v.toFixed(1)}%`;
}

// Repeated frames, summarised as how long each picture stayed up — which reads straight off as
// an update rate ("held 1 frame ×40, 2 frames ×3" is a 50fps effect that dropped three updates).
function renderScreenUpdates(su: ScreenUpdates): string[] {
  const out = ["", "Screen updates (byte-exact framebuffer comparison, the filmstrip's \"=\" badge):"];
  const changes = su.compared - su.repeats.length;
  if (changes === 0) {
    out.push(`  the picture never changed after frame 0 — a static screen, so repeats say nothing about timing here`);
    return out;
  }
  if (su.repeats.length === 0) {
    out.push(`  every frame's picture differs from the one before — no repeated frames`);
    return out;
  }
  const shown = su.repeats.slice(0, 20).join(", ") + (su.repeats.length > 20 ? `, … (${su.repeats.length} total)` : "");
  out.push(`  ${su.repeats.length} of ${su.compared} frames repeated the previous frame's picture: ${shown}`);
  const holds = Object.entries(su.holds).map(([held, count]) => [Number(held), count] as const).sort((a, b) => a[0] - b[0]);
  if (holds.length) {
    const rate = (held: number) => `${+(su.refreshHz / held).toFixed(1)} fps`;
    out.push(`  each picture held for: ${holds.map(([held, n]) => `${held} frame${held === 1 ? "" : "s"} ×${n} (${rate(held)})`).join(", ")}`);
  }
  out.push(
    "  In an effect that otherwise updates at a steady rate, a longer hold is a missed update: the",
    "  work behind it overran. Compare the frames just before a repeat with their neighbours.",
  );
  return out;
}

/**
 * A function's display name: bare, unless another function in the frame shares it (the profiler
 * keys functions by name *and* source file, so one name can be two rows), in which case the
 * file's basename tells them apart.
 */
function labeller(names: { name: string; file?: string }[]): (fn: { name: string; file?: string }) => string {
  const files = new Map<string, Set<string>>();
  for (const { name, file } of names) {
    const set = files.get(name) ?? new Set<string>();
    set.add(file ?? "");
    files.set(name, set);
  }
  return ({ name, file }) => ((files.get(name)?.size ?? 0) > 1 && file ? `${name} (${file.split(/[\\/]/).pop()})` : name);
}

// Below this share of the frame a call is folded into its parent's "+N smaller" line: a tree of
// every 0.01% leaf buries the shape it exists to show.
const TREE_MIN_PCT = 1;

function renderCallTree(root: CallTreeNode, frameCycles: number, frameIndex: number, label: (fn: CallTreeNode) => string): string[] {
  const out = ["", `  Call tree, frame ${frameIndex} (total% includes callees; calls under ${TREE_MIN_PCT}% of the frame folded)`, ""];
  const share = (c: number) => (frameCycles > 0 ? (c / frameCycles) * 100 : 0);
  out.push(`  ${"total%".padStart(7)}${"self%".padStart(8)}  function`);
  const visit = (node: CallTreeNode, depth: number) => {
    const shown = node.children.filter((c) => share(c.totalCycles) >= TREE_MIN_PCT);
    for (const child of shown) {
      out.push(`  ${pct(share(child.totalCycles)).padStart(7)}${pct(share(child.selfCycles)).padStart(8)}  ${"  ".repeat(depth)}${label(child)}`);
      visit(child, depth + 1);
    }
    const folded = node.children.length - shown.length;
    if (folded > 0) {
      const cycles = node.children.filter((c) => !shown.includes(c)).reduce((n, c) => n + c.totalCycles, 0);
      out.push(`  ${pct(share(cycles)).padStart(7)}${"".padStart(8)}  ${"  ".repeat(depth)}+${folded} smaller call${folded === 1 ? "" : "s"}`);
    }
  };
  visit(root, 0);
  return out;
}

const LINE_SLOTS = 227; // DMA_HPOS: colour clocks per raster line

/** A slot as "line:hpos", the position a copper WAIT or a raster check would name. */
function linePos(slot: number): string {
  const s = Math.round(slot);
  return `${Math.floor(s / LINE_SLOTS)}:${String(s % LINE_SLOTS).padStart(3, "0")}`;
}

/** The last slot a box covers — its end is exclusive, and line 313 doesn't exist. */
function lastPos(end: number): string {
  return linePos(Math.max(0, Math.round(end) - 1));
}

export function renderFlame(v: FlameView, frameIndex: number, label: (fn: { name: string; file?: string }) => string): string[] {
  const window = v.end - v.start;
  const lines = `lines ${linePos(v.start).split(":")[0]}-${linePos(v.end - 1).split(":")[0]}`;
  const out = [
    "",
    `  Flame graph, frame ${frameIndex}, ${lines} — boxes in time order, nested by call depth; ` +
      `positions are line:hpos (colour clocks), ${v.anchored ? "anchored to the DMA grid as the flame graph draws them" : "from cycle costs (no DMA grid to anchor to)"}.`,
    `  Boxes under ${(v.minSlots / LINE_SLOTS).toFixed(1)} lines are folded into "+" summaries; < and > mark a box that started before or runs past the window.`,
  ];
  if (v.dma.length) out.push(`  DMA bus in this window: ${v.dma.map((o) => `${o.name} ${pct(o.pct)}`).join("  ")}`);
  out.push("", `  ${"start".padStart(9)}  ${"end".padStart(8)}  ${"slots".padStart(6)}${"%win".padStart(7)}  function`);
  const share = (slots: number) => pct(window > 0 ? (slots / window) * 100 : 0);
  const folded = (fs: FlameView["folded"], depth: number) => {
    for (const f of fs) {
      out.push(`  ${"".padStart(9)}  ${"".padStart(8)}  ${String(Math.round(f.slots)).padStart(6)}${share(f.slots).padStart(7)}  ` +
        `${"  ".repeat(depth)}+ ${f.name} ×${f.count}`);
    }
  };
  // Same function, same callees, about the same length: one iteration of a loop, repeated. Shown
  // once with a count and its period, or a loop calling a helper per line is a page per frame.
  // Folded calls are left out: they're under the threshold by definition, and an occasional one
  // (an interrupt landing in one iteration) shouldn't break the run.
  const shape = (b: FlameBox): string => `${b.name}(${b.children.map(shape).join(",")})`;
  const similar = (a: FlameBox, b: FlameBox) => {
    const la = a.end - a.start;
    const lb = b.end - b.start;
    // 10%, or a few instructions' worth for a short box — a blitter wait drifts by a handful of
    // slots from one iteration to the next without being a different kind of iteration.
    return shape(a) === shape(b) && Math.abs(la - lb) <= Math.max(Math.max(la, lb) * 0.1, 16);
  };
  // A loop body is often several calls (compute, then wait for the blitter), so look for a
  // repeating sequence of up to MAX_PERIOD siblings, not just one function repeated.
  const MAX_PERIOD = 4;
  const repeatsAt = (boxes: FlameBox[], i: number, period: number): number => {
    let n = 1;
    for (;;) {
      const base = i + n * period;
      if (base + period > boxes.length) return n;
      for (let k = 0; k < period; k++) if (!similar(boxes[i + k], boxes[base + k])) return n;
      n++;
    }
  };
  const visitAll = (boxes: FlameBox[], depth: number) => {
    for (let i = 0; i < boxes.length; ) {
      let best = { period: 1, count: 1 };
      for (let period = 1; period <= MAX_PERIOD; period++) {
        const count = repeatsAt(boxes, i, period);
        if (count >= 2 && count * period > best.count * best.period) best = { period, count };
      }
      if (best.count < 2) {
        visit(boxes[i], depth);
        i++;
        continue;
      }
      const run = boxes.slice(i, i + best.count * best.period);
      const first = run[0];
      const last = run[run.length - 1];
      const busy = run.reduce((n, b) => n + (b.end - b.start), 0);
      const period = (boxes[i + (best.count - 1) * best.period].start - first.start) / (best.count - 1) / LINE_SLOTS;
      const names = run.slice(0, best.period).map(label).join(", ");
      out.push(
        `  ${linePos(first.start).padStart(9)}  ${lastPos(last.end).padStart(8)}  ${String(Math.round(busy)).padStart(6)}${share(busy).padStart(7)}  ` +
        `${"  ".repeat(depth)}×${best.count} ${best.period > 1 ? `[${names}]` : names}, every ~${period.toFixed(1)} lines — first one:`,
      );
      for (const b of run.slice(0, best.period)) visit(b, depth);
      i += run.length;
    }
  };
  const visit = (box: FlameBox, depth: number) => {
    const slots = box.end - box.start;
    out.push(
      `  ${((box.startsBefore ? "<" : "") + linePos(box.start)).padStart(9)}  ${(lastPos(box.end) + (box.endsAfter ? ">" : "")).padStart(8)}  ` +
      `${String(Math.round(slots)).padStart(6)}${share(slots).padStart(7)}  ${"  ".repeat(depth)}${label(box)}`,
    );
    visitAll(box.children, depth + 1);
    folded(box.folded, depth + 1);
  };
  visitAll(v.boxes, 0);
  folded(v.folded, 0);
  return out;
}

function renderBlits(b: BlitAnalysis, frameCycles: number, frameIndex: number): string[] {
  const out = [
    "",
    `  Blits, frame ${frameIndex}: ${b.blits.length} blit(s); the blitter had the bus for ${b.busySlots} slots ` +
      `(${pct(frameCycles > 0 ? (b.busySlots / frameCycles) * 100 : 0)} of the frame).`,
  ];
  if (b.fastBlitter) {
    out.push("  NOTE: BLTSIZE was written but no blitter bus cycles were captured — a fast (non-cycle-exact) blitter, so start/end times are estimates.");
  }
  if (b.blits.length === 0) return out;
  if (b.blits.some((blit) => blit.unseen.length)) {
    out.push("  Blitter registers are write-only and only writes inside the frame are recorded: a value set before the capture shows as 0 and is listed as unrecorded.");
  }
  out.push("", `  ${"#".padStart(3)}  ${"start".padStart(7)}  ${"end".padStart(7)}  ${"slots".padStart(6)}  ${"operation".padEnd(26)}${"minterm".padEnd(22)}started by`);
  for (const blit of b.blits) {
    const end = blit.finished ? lastPos(blit.endSlot + 1) : "running>";
    const slots = blit.finished ? String(blit.endSlot - blit.startSlot) : "-";
    const start = blit.startedBefore ? "earlier" : linePos(blit.startSlot);
    out.push(
      `  ${String(blit.index).padStart(3)}  ${start.padStart(7)}  ${end.padStart(7)}  ${slots.padStart(6)}  ` +
      `${blit.label.padEnd(26)}${`${blit.minterm} ${blit.mintermExpr}`.padEnd(22)}${blit.startedBy ?? (blit.startedBefore ? "(an earlier frame)" : "?")}`,
    );
    if (blit.startedBefore) {
      out.push(`  ${"".padStart(3)}  started in an earlier frame and still running at this one's start; slots are those in this frame, and pointers are where it had got to`);
    }
    const chans = blit.channels.map((c) => {
      const what = c.ptr ?? `literal ${c.literal}`;
      const extra = [c.modulo ? `mod ${c.modulo}` : "", c.shift ? `shift ${c.shift}` : ""].filter(Boolean).join(", ");
      return `${c.label.replace("Source ", "").replace("Destination", "D")}=${what}${extra ? ` (${extra})` : ""}`;
    });
    if (blit.unseen.includes("BLTCON0")) {
      out.push(`  ${"".padStart(3)}  operation and channels unknown: BLTCON0 was set before the capture`);
    } else if (chans.length) {
      out.push(`  ${"".padStart(3)}  ${chans.join("  ")}`);
    }
    // A carried-over blit's pointers are covered by the note above.
    const other = blit.unseen.filter((r) => r !== "BLTCON0" && !(blit.startedBefore && /^BLT[A-D]PT$/.test(r)));
    if (other.length) out.push(`  ${"".padStart(3)}  set before the capture, not recorded: ${other.join(" ")}`);
  }
  return out;
}

// A full-screen gradient or per-line palette list is hundreds of instructions; past this the
// reader wants a window (`lines`), not more of the list.
const COPPER_MAX_STEPS = 400;

function renderCopper(c: CopperTrace, frameIndex: number, windowed: boolean): string[] {
  const out = [
    "",
    `  Copper, frame ${frameIndex}: ${c.executed} instruction(s) executed${windowed ? `, ${c.steps.length} in the window` : ""}. ` +
      "A WAIT shows how long the copper actually waited before its next instruction ran.",
  ];
  if (c.steps.length === 0) return out;
  out.push("", `  ${"at".padStart(7)}  ${"address".padEnd(26)}instruction`);
  for (const step of c.steps.slice(0, COPPER_MAX_STEPS)) {
    const where = `$${step.address.toString(16).padStart(6, "0")}${step.symbol ? ` ${step.symbol}` : ""}`;
    const waited = step.waitedSlots !== undefined ? `   (waited ${step.waitedSlots} slots, ${(step.waitedSlots / LINE_SLOTS).toFixed(1)} lines)` : "";
    out.push(`  ${linePos(step.slot).padStart(7)}  ${where.padEnd(26)}${step.text}${waited}`);
  }
  if (c.steps.length > COPPER_MAX_STEPS) {
    out.push(`  … ${c.steps.length - COPPER_MAX_STEPS} more; narrow it with lines (e.g. --lines 40-80)`);
  }
  return out;
}

function renderCallers(paths: CallerPath[], query: string, frameIndex: number): string[] {
  const out = ["", `  Calls into ${query}, frame ${frameIndex} (colour clocks including what it calls, by call path)`];
  if (paths.length === 0) {
    out.push(`  not executed in frame ${frameIndex}.`);
    return out;
  }
  for (const p of paths) out.push(`  ${String(p.cycles).padStart(9)}${pct(p.pct).padStart(8)}  ${p.path.join(" > ")}`);
  return out;
}

function dumpFrame(
  f: FrameAnalysis,
  limit: number,
  out: string[],
  instructionQuery?: string,
  sort: "self" | "total" = "self",
  callersQuery?: string,
): void {
  out.push("");
  out.push(`Frame ${f.index}: ${f.samples} samples, ${f.cycles} cc = ${pct(f.cyclePct)} of the frame's ${f.frameCycles}` +
    (f.duplicateOfPrevious ? ` — same picture as frame ${f.index - 1}` : ""));
  const detail = [`zero-cost samples: ${f.zeroCostSamples}`];
  if (f.registerSamples) detail.push(`register trace: ${f.registerSamples}`);
  if (f.dmaSlots) detail.push(`fetch cells: ${f.fetchCells}`, `anchored: ${f.anchoredSamples}`);
  out.push(`  ${detail.join(", ")}`);

  if (f.dmaOwners.length > 0) {
    out.push(`  DMA bus: ${f.dmaOwners.map((o) => `${o.name} ${pct(o.pct)}`).join("  ")}`);
  }

  const sorted = sort === "total"
    ? [...f.functions].sort((a, b) => b.totalCycles - a.totalCycles)
    : f.functions;
  const fns = limit > 0 ? sorted.slice(0, limit) : sorted;
  if (fns.length === 0) return;
  const label = labeller(f.functions);
  out.push("");
  out.push(
    `  ${"function".padEnd(36)}${"self".padStart(9)}${"self%".padStart(8)}${"total".padStart(9)}${"total%".padStart(8)}` +
    `${"width%".padStart(8)}${"samples".padStart(9)}${"calls".padStart(7)}`,
  );
  for (const fn of fns) {
    // width% is only meaningful against a DMA grid; without one it degenerates to self%.
    out.push(
      `  ${label(fn).slice(0, 35).padEnd(36)}${String(fn.selfCycles).padStart(9)}${pct(fn.selfPct).padStart(8)}` +
      `${String(fn.totalCycles).padStart(9)}${pct(fn.totalPct).padStart(8)}` +
      `${pct(fn.widthPct).padStart(8)}${String(fn.samples).padStart(9)}${String(fn.calls ?? "").padStart(7)}`,
    );
  }
  if (limit > 0 && f.functions.length > limit) {
    out.push(`  … ${f.functions.length - limit} more (use --functions 0)`);
  }
  if (f.callTree) out.push(...renderCallTree(f.callTree, f.cycles, f.index, label));
  if (f.callers) out.push(...renderCallers(f.callers, callersQuery ?? "", f.index));
  if (f.flame) out.push(...renderFlame(f.flame, f.index, label));
  if (f.blits) out.push(...renderBlits(f.blits, f.cycles, f.index));
  if (f.copper) out.push(...renderCopper(f.copper, f.index, f.flame !== undefined && f.flame.end - f.flame.start < f.cycles));
  if (f.accesses) out.push(...renderAccesses(f.accesses, f.index));
  if (f.stalls) out.push(...renderStalls(f.stalls, limit, f.index));
  if (f.instructionDetail) {
    out.push(...renderInstructions(f.instructionDetail, f.index));
  } else if (instructionQuery) {
    // Said explicitly rather than left as an absent section: a frame that didn't run the function
    // and a frame nobody asked about look identical otherwise, and the first is a real answer —
    // frames of the same capture don't all execute the same code.
    out.push("", `  ${instructionQuery}: not executed in frame ${f.index}.`);
  }
}

// Address order, not cost order: a routine is read top to bottom, and where the expensive
// instruction sits relative to the branch above it is usually the point. The cost columns make
// the hot line obvious without reordering it out of its context.
function renderInstructions(d: InstructionAnalysis, frameIndex: number): string[] {
  const out: string[] = [
    "",
    `  ${d.name} (0x${d.address.toString(16)}) — per instruction, frame ${frameIndex}, ${d.totalCycles} cc total`,
  ];
  if (d.datasheetApplicable) {
    out.push(`  cc/hit vs datasheet cost; a large "stall" is time blocked on the bus, not work. Stalls are charged to the
` +
      `  instruction running when the bus was busy: on code in chip or slow RAM, a register-only instruction can
` +
      `  show one for its own prefetch, so read a block's total stall rather than pinning it on one instruction.`);
  } else if (d.datasheetCaveat) {
    out.push(`  (no datasheet comparison: ${d.datasheetCaveat})`);
  }
  out.push("");
  const head =
    `  ${"address".padEnd(10)}${"cc".padStart(9)}${"%fn".padStart(7)}${"hits".padStart(8)}${"cc/hit".padStart(9)}` +
    (d.datasheetApplicable ? `${"sheet".padStart(7)}${"stall".padStart(7)}` : "") +
    "  instruction";
  out.push(head);
  for (const ins of d.instructions) {
    const timing = d.datasheetApplicable
      ? (ins.theoreticalCycles === undefined ? "".padStart(7) + "".padStart(7)
        : String(ins.theoreticalCycles).padStart(7) +
          (ins.stallPerHit === undefined ? "".padStart(7) : ins.stallPerHit.toFixed(1).padStart(7)))
      : "";
    out.push(
      `  0x${ins.address.toString(16).padStart(6, "0")}  ${String(ins.cycles).padStart(9)}` +
      `${pct(ins.pctOfFunction).padStart(7)}${String(ins.hits).padStart(8)}` +
      `${(ins.hits ? ins.cyclesPerHit.toFixed(1) : "-").padStart(9)}${timing}  ${ins.text}`,
    );
  }
  if (d.truncated) {
    out.push(`  … listing cut short by the disassembler's instruction budget before the function's end.`);
  }
  return out;
}

function renderStalls(st: StallAnalysis, limit: number, frameIndex: number): string[] {
  const out: string[] = ["", `  Measured vs 68000 datasheet cost (frame ${frameIndex}), in colour clocks`];
  if (!st.applicable) {
    out.push(`  NOT APPLICABLE: ${st.caveat}`);
    return out;
  }
  const overall = st.totalMeasured - st.totalTheoretical;
  out.push(`  total measured ${st.totalMeasured}, datasheet ${st.totalTheoretical}, ` +
    `stall ${overall} (${st.totalMeasured > 0 ? ((overall / st.totalMeasured) * 100).toFixed(1) : "0.0"}% waiting)`);
  out.push("  A function's stall includes its own instruction fetches waiting for the bus, so code in chip or slow RAM");
  out.push("  stalls even where it never touches memory; --instructions shows where within it.");
  out.push("");
  out.push(`  ${"function".padEnd(36)}${"measured".padStart(10)}${"datasheet".padStart(11)}${"stall".padStart(9)}${"stall%".padStart(8)}${"bus".padStart(8)}`);
  const rows = limit > 0 ? st.functions.slice(0, limit) : st.functions;
  for (const f of rows) {
    out.push(
      `  ${f.name.slice(0, 35).padEnd(36)}${String(f.measured).padStart(10)}${String(f.theoretical).padStart(11)}` +
      `${String(f.stall).padStart(9)}${(f.stallPct.toFixed(1) + "%").padStart(8)}${String(f.busAccesses).padStart(8)}` +
      (f.untimed ? `  (${f.untimed} untimed)` : ""),
    );
  }
  return out;
}

// Every time in these reports is in colour clocks, the unit the DMA grid and the beam count in —
// not CPU cycles, which a reader checking against a 68000 timing table would otherwise assume.
const UNITS = "times are in colour clocks (cc): 1 cc = 2 68000 CPU cycles; a PAL frame is 71051 cc (313 lines of 227)";

/** The capture's description, above any per-frame or summary table. */
export function renderHeader(a: ProfileAnalysis): string[] {
  const out: string[] = [];
  const m = a.manifest;
  out.push(`${m.program.name ?? "(unnamed program)"} — ${m.frameCount} frame(s), ${m.meta.isPAL ? "PAL" : "NTSC"}`);
  if (m.meta.capturedAt) out.push(`captured ${new Date(m.meta.capturedAt).toISOString()}`);
  out.push(`address range 0x${m.meta.start.toString(16)}-0x${m.meta.end.toString(16)}, ${m.meta.total} instructions executed (${m.meta.inRange} in range)`);
  if (m.kickstart.name) out.push(`kickstart ${m.kickstart.name}`);
  out.push(UNITS);
  if (a.screenUpdates) out.push(...renderScreenUpdates(a.screenUpdates));
  return out;
}

export function renderDump(a: ProfileAnalysis, frame: number | undefined, limit: number, sort: "self" | "total" = "self"): string {
  const out = renderHeader(a);
  const frames = frame === undefined ? a.frames : a.frames.filter((f) => f.index === frame);
  if (frames.length === 0) {
    out.push("");
    out.push(`No such frame ${frame} (capture has ${a.frames.length}).`);
    return out.join("\n");
  }
  for (const f of frames) dumpFrame(f, limit, out, a.instructionQuery, sort, a.callersOf);
  return out.join("\n");
}

export function renderCheck(a: ProfileAnalysis): string {
  const out: string[] = [];
  for (const f of a.frames) {
    out.push(`frame ${f.index}: ${String(f.samples).padStart(7)} samples  ${String(f.cycles).padStart(7)} cc  ${pct(f.cyclePct).padStart(7)} of frame` +
      (f.duplicateOfPrevious ? "  = previous picture" : ""));
  }
  if (a.screenUpdates) out.push(...renderScreenUpdates(a.screenUpdates));
  out.push("");
  if (a.findings.length === 0) {
    out.push("OK — no findings.");
    return out.join("\n");
  }
  for (const fi of a.findings) {
    out.push(`${fi.severity.toUpperCase().padEnd(8)}[${fi.code}] ${fi.message}`);
    if (fi.hint) out.push(`         ${fi.hint}`);
  }
  const errors = a.findings.filter((f) => f.severity === "error").length;
  const warnings = a.findings.filter((f) => f.severity === "warning").length;
  out.push("");
  out.push(`${errors} error(s), ${warnings} warning(s), ${a.findings.length - errors - warnings} info.`);
  return out.join("\n");
}


// ── Across frames, and between captures (profileCompare.ts) ───────────────────────────────

const cc = (v: number) => String(Math.round(v));
const statCells = (s: Stat) => `${cc(s.min).padStart(8)}${cc(s.avg).padStart(8)}${cc(s.max).padStart(8)}`;

export function renderSummary(s: CaptureSummary, limit: number, unit = "frame"): string {
  const out = [
    "",
    `  Per function across all ${s.frames} ${unit}(s), in colour clocks per ${unit} — min, avg, max, counting 0 for`,
    `  ${/^[aeiou]/.test(unit) ? "an" : "a"} ${unit} it didn't run in. "ran" is the ${unit}s it ran in; "calls" the range of calls per ${unit}.`,
    "",
    `  ${"function".padEnd(36)}${"ran".padStart(7)}  ${"self min".padStart(8)}${"avg".padStart(8)}${"max".padStart(8)}  ${"total min".padStart(9)}${"avg".padStart(8)}${"max".padStart(8)}${"calls".padStart(9)}`,
  ];
  const label = labeller(s.functions);
  const rows = limit > 0 ? s.functions.slice(0, limit) : s.functions;
  for (const f of rows) {
    const calls = f.calls.min === f.calls.max ? cc(f.calls.min) : `${cc(f.calls.min)}-${cc(f.calls.max)}`;
    out.push(`  ${label(f).slice(0, 35).padEnd(36)}${`${f.frames}/${s.frames}`.padStart(7)}  ${statCells(f.self)}  ${" "}${statCells(f.total)}${calls.padStart(9)}`);
  }
  if (limit > 0 && s.functions.length > limit) out.push(`  … ${s.functions.length - limit} more (functions: 0 for all)`);
  return out.join("\n");
}

export function renderDiff(d: ProfileDiff, limit: number, names: [string, string]): string {
  const signed = (v: number) => (Math.round(v) > 0 ? "+" : "") + cc(v);
  const change = (was: number, now: number) => {
    if (Math.round(now) === Math.round(was)) return "";
    if (was <= 0) return "new";
    const p = ((now - was) / was) * 100;
    return `${p > 0 ? "+" : ""}${p.toFixed(0)}%`;
  };
  const out = [
    `before: ${names[0]} (${d.before.frames} frame(s))`,
    `after:  ${names[1]} (${d.after.frames} frame(s))`,
    "",
    "  Average colour clocks per frame, per function, ordered by the size of the change in self time. A",
    "  function that didn't run in a frame counts 0 there; \"ran\" is the frames it ran in, before → after.",
    "",
    `  ${"function".padEnd(36)}${"self before".padStart(12)}${"after".padStart(9)}${"change".padStart(9)}${"".padStart(7)}` +
      `${"total before".padStart(13)}${"after".padStart(9)}${"change".padStart(9)}${"ran".padStart(11)}`,
  ];
  const label = labeller(d.functions);
  const rows = (limit > 0 ? d.functions.slice(0, limit) : d.functions);
  for (const f of rows) {
    const sb = f.before?.self.avg ?? 0, sa = f.after?.self.avg ?? 0;
    const tb = f.before?.total.avg ?? 0, ta = f.after?.total.avg ?? 0;
    const ran = `${f.before?.frames ?? 0}→${f.after?.frames ?? 0}`;
    out.push(
      `  ${label(f).slice(0, 35).padEnd(36)}${cc(sb).padStart(12)}${cc(sa).padStart(9)}${signed(f.selfDelta).padStart(9)}${change(sb, sa).padStart(7)}` +
      `${cc(tb).padStart(13)}${cc(ta).padStart(9)}${signed(f.totalDelta).padStart(9)}${ran.padStart(11)}`,
    );
  }
  if (limit > 0 && d.functions.length > limit) out.push(`  … ${d.functions.length - limit} more (functions: 0 for all)`);
  return out.join("\n");
}

/**
 * The analysis as JSON for a caller to process — `profile dump --json`, and profile_dump's `out`.
 * The manifest's disassembly is left out (large, and available through `instructions`); `frame`,
 * `limit` and `sort` scope it the way they scope the text.
 */
export function analysisJson(a: ProfileAnalysis, opts: { frame?: number; limit?: number; sort?: "self" | "total"; summary?: CaptureSummary } = {}): unknown {
  const { disassembly: _disassembly, ...manifest } = a.manifest;
  let { frames, findings } = a;
  if (opts.frame !== undefined) {
    frames = frames.filter((f) => f.index === opts.frame);
    findings = findings.filter((f) => f.frame === undefined || f.frame === opts.frame);
  }
  if (opts.sort === "total") frames = frames.map((f) => ({ ...f, functions: [...f.functions].sort((x, y) => y.totalCycles - x.totalCycles) }));
  if (opts.limit && opts.limit > 0) frames = frames.map((f) => ({ ...f, functions: f.functions.slice(0, opts.limit) }));
  return { ...a, manifest, frames, findings, ...(opts.summary ? { summary: opts.summary } : {}) };
}

export function renderIterations(it: IterationAnalysis, limit: number): string {
  const out = [
    "",
    `  Iterations of ${it.query} (0x${it.address.toString(16)}): from one execution of it to the next.`,
  ];
  if (it.iterations.length === 0) {
    out.push("  It ran fewer than twice in the capture, so no complete iteration — capture more frames, or check the address.");
    return out.join("\n");
  }
  const frames = (v: number, frameCc: number) => (v / frameCc).toFixed(2);
  const frameCc = it.frameCycles;
  out.push(
    `  ${it.iterations.length} complete; length min ${cc(it.length.min)}, avg ${cc(it.length.avg)}, max ${cc(it.length.max)} colour clocks ` +
      `(${frames(it.length.min, frameCc)}-${frames(it.length.max, frameCc)} frames).`,
    it.overran
      ? `  ${it.overran} took longer than a frame: each of those is a missed frame, whether or not the picture repeated.`
      : `  None took longer than a frame (allowing ${OVERRUN_TOLERANCE * 100}% for where the beam wait happens to end).`,
    "",
    `  ${"#".padStart(4)}  ${"starts".padStart(13)}  ${"length".padStart(8)}  frames`,
  );
  const rows = it.iterations.length > 60 ? [...it.iterations.slice(0, 30), undefined, ...it.iterations.slice(-30)] : it.iterations;
  for (const r of rows) {
    if (!r) { out.push(`  … ${it.iterations.length - 60} more`); continue; }
    const at = `f${r.frame} ${r.line}:${String(r.hpos).padStart(3, "0")}`;
    out.push(`  ${String(r.index).padStart(4)}  ${at.padStart(13)}  ${cc(r.length).padStart(8)}  ${frames(r.length, frameCc).padStart(6)}${r.frames > 1 + OVERRUN_TOLERANCE ? "  overran" : ""}`);
  }
  out.push(renderSummary(it.summary, limit, "iteration"));
  return out.join("\n");
}

// Rows past this go to --json / `out`: a buffer cleared by the CPU is thousands of accesses, and the
// summary above them says who and when already.
const ACCESS_TEXT_ROWS = 100;

function renderAccesses(a: AccessAnalysis, frameIndex: number): string[] {
  const hex = (v: number, w = 6) => `$${(v >>> 0).toString(16).padStart(w, "0")}`;
  const t = a.target;
  if (a.registerChanges) {
    const out = ["", `  Changes to ${t.query}, frame ${frameIndex}: ${a.total}`];
    if (a.noTrace) {
      out[1] += " — this frame has no register trace (a capture records one for its first frame only)";
      return out;
    }
    if (a.total === 0) return out;
    out.push("", `  ${"who".padEnd(40)}${"count".padStart(7)}  lines`);
    for (const g of a.groups) {
      const p = (slot: number) => `${Math.floor(slot / LINE_SLOTS)}:${String(slot % LINE_SLOTS).padStart(3, "0")}`;
      out.push(`  ${g.who.slice(0, 39).padEnd(40)}${String(g.count).padStart(7)}  ${p(g.firstSlot)}-${p(g.lastSlot)}`);
    }
    out.push("", `  ${"line:hpos".padEnd(10)}${"from".padEnd(11)}${"to".padEnd(11)}who`);
    for (const r of a.registerChanges.slice(0, ACCESS_TEXT_ROWS)) {
      const via = r.via === "exception" ? "  (taking an exception)" : r.via === "outside" ? "  (in the unprofiled code it called)" : "";
      out.push(`  ${`${r.line}:${String(r.hpos).padStart(3, "0")}`.padEnd(10)}${hex(r.from, 8).padEnd(11)}${hex(r.to, 8).padEnd(11)}${r.who}${r.at ? `  ${r.at}` : ""}${via}`);
    }
    if (a.total > ACCESS_TEXT_ROWS) out.push(`  … ${a.total - ACCESS_TEXT_ROWS} more (--json, or profile_dump's out)`);
    return out;
  }
  const out = [
    "",
    `  Accesses to ${t.query} (${hex(t.start)}-${hex(t.end - 1)}), frame ${frameIndex}: ${a.total}` +
      (a.total ? "" : " — nothing touched it on the chip bus this frame (fast RAM isn't on it)"),
  ];
  if (a.total === 0) return out;
  const pos = (slot: number) => `${Math.floor(slot / LINE_SLOTS)}:${String(slot % LINE_SLOTS).padStart(3, "0")}`;
  out.push("", `  ${"who".padEnd(40)}${"".padEnd(6)}${"count".padStart(7)}  ${"lines".padEnd(17)}offsets`);
  for (const g of a.groups) {
    const offsets = g.low === g.high ? `+$${(g.low - t.start).toString(16)}` : `+$${(g.low - t.start).toString(16)}-$${(g.high - t.start).toString(16)}`;
    out.push(`  ${(g.who + (g.unverified ? " ~" : "")).slice(0, 39).padEnd(40)}${(g.write ? "write" : "read").padEnd(6)}${String(g.count).padStart(7)}  ${`${pos(g.firstSlot)}-${pos(g.lastSlot)}`.padEnd(17)}${offsets}`);
  }
  if (a.groups.some((g) => g.unverified)) {
    out.push("  ~ some CPU accesses here are placed by timing only, not checked against the instruction's operand (no register trace for this frame)");
  }
  out.push("", `  ${"line:hpos".padEnd(10)}${"".padEnd(4)}${"value".padEnd(8)}${"offset".padEnd(9)}who`);
  for (const r of a.rows.slice(0, ACCESS_TEXT_ROWS)) {
    const value = r.size === 1 ? hex(r.value & 0xff, 2) : hex(r.value, 4);
    out.push(
      `  ${`${r.line}:${String(r.hpos).padStart(3, "0")}`.padEnd(10)}${(r.write ? "W" : "R") + (r.size === 1 ? ".b" : ".w")} ${value.padEnd(8)}${`+$${r.offset.toString(16)}`.padEnd(9)}` +
        `${r.who}${r.unverified ? " ~" : ""}${r.at ? `  ${r.at}` : ""}`,
    );
  }
  if (a.total > ACCESS_TEXT_ROWS) out.push(`  … ${a.total - ACCESS_TEXT_ROWS} more (--json, or profile_dump's out, has ${Math.min(a.total, a.rows.length)})`);
  return out;
}
