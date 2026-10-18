// Human-readable rendering of a ProfileAnalysis. Shared by the `profile` CLI subcommand and the
// MCP server's tools so both speak in exactly the same terms — a number a person reads in the
// terminal and a number a model reads over MCP should never be formatted differently, or a
// conversation about one won't transfer to the other.

import { BlitAnalysis, CallerPath, CallTreeNode, FlameBox, FlameView, FrameAnalysis, InstructionAnalysis, ProfileAnalysis, ScreenUpdates, StallAnalysis } from "./profileAnalysis";

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
    out.push(
      `  ${String(blit.index).padStart(3)}  ${linePos(blit.startSlot).padStart(7)}  ${end.padStart(7)}  ${slots.padStart(6)}  ` +
      `${blit.label.padEnd(26)}${`${blit.minterm} ${blit.mintermExpr}`.padEnd(22)}${blit.startedBy ?? "?"}`,
    );
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
    const other = blit.unseen.filter((r) => r !== "BLTCON0");
    if (other.length) out.push(`  ${"".padStart(3)}  set before the capture, not recorded: ${other.join(" ")}`);
  }
  return out;
}

function renderCallers(paths: CallerPath[], query: string, frameIndex: number): string[] {
  const out = ["", `  Calls into ${query}, frame ${frameIndex} (cycles including what it calls, by call path)`];
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
  out.push(`Frame ${f.index}: ${f.samples} samples, ${f.cycles} cycles = ${pct(f.cyclePct)} of ${f.frameCycles} color clocks` +
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
    `${"width%".padStart(8)}${"samples".padStart(9)}`,
  );
  for (const fn of fns) {
    // width% is only meaningful against a DMA grid; without one it degenerates to self%.
    out.push(
      `  ${label(fn).slice(0, 35).padEnd(36)}${String(fn.selfCycles).padStart(9)}${pct(fn.selfPct).padStart(8)}` +
      `${String(fn.totalCycles).padStart(9)}${pct(fn.totalPct).padStart(8)}` +
      `${pct(fn.widthPct).padStart(8)}${String(fn.samples).padStart(9)}`,
    );
  }
  if (limit > 0 && f.functions.length > limit) {
    out.push(`  … ${f.functions.length - limit} more (use --functions 0)`);
  }
  if (f.callTree) out.push(...renderCallTree(f.callTree, f.cycles, f.index, label));
  if (f.callers) out.push(...renderCallers(f.callers, callersQuery ?? "", f.index));
  if (f.flame) out.push(...renderFlame(f.flame, f.index, label));
  if (f.blits) out.push(...renderBlits(f.blits, f.cycles, f.index));
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
    `  ${d.name} (0x${d.address.toString(16)}) — per instruction, frame ${frameIndex}, ${d.totalCycles} cycles total`,
  ];
  if (d.datasheetApplicable) {
    out.push(`  cyc/hit vs datasheet cost; a large "stall" is time blocked on the bus, not work.`);
  } else if (d.datasheetCaveat) {
    out.push(`  (no datasheet comparison: ${d.datasheetCaveat})`);
  }
  out.push("");
  const head =
    `  ${"address".padEnd(10)}${"cycles".padStart(9)}${"%fn".padStart(7)}${"hits".padStart(8)}${"cyc/hit".padStart(9)}` +
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
  const out: string[] = ["", `  Measured vs 68000 datasheet cost (frame ${frameIndex})`];
  if (!st.applicable) {
    out.push(`  NOT APPLICABLE: ${st.caveat}`);
    return out;
  }
  const overall = st.totalMeasured - st.totalTheoretical;
  out.push(`  total measured ${st.totalMeasured}, datasheet ${st.totalTheoretical}, ` +
    `stall ${overall} (${st.totalMeasured > 0 ? ((overall / st.totalMeasured) * 100).toFixed(1) : "0.0"}% waiting)`);
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

export function renderDump(a: ProfileAnalysis, frame: number | undefined, limit: number, sort: "self" | "total" = "self"): string {
  const out: string[] = [];
  const m = a.manifest;
  out.push(`${m.program.name ?? "(unnamed program)"} — ${m.frameCount} frame(s), ${m.meta.isPAL ? "PAL" : "NTSC"}`);
  if (m.meta.capturedAt) out.push(`captured ${new Date(m.meta.capturedAt).toISOString()}`);
  out.push(`address range 0x${m.meta.start.toString(16)}-0x${m.meta.end.toString(16)}, ${m.meta.total} instructions executed (${m.meta.inRange} in range)`);
  if (m.kickstart.name) out.push(`kickstart ${m.kickstart.name}`);
  if (a.screenUpdates) out.push(...renderScreenUpdates(a.screenUpdates));

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
    out.push(`frame ${f.index}: ${String(f.samples).padStart(7)} samples  ${String(f.cycles).padStart(7)} cycles  ${pct(f.cyclePct).padStart(7)} of frame` +
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

