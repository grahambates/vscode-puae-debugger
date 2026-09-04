// Human-readable rendering of a ProfileAnalysis. Shared by the `profile` CLI subcommand and the
// MCP server's tools so both speak in exactly the same terms — a number a person reads in the
// terminal and a number a model reads over MCP should never be formatted differently, or a
// conversation about one won't transfer to the other.

import { FrameAnalysis, InstructionAnalysis, ProfileAnalysis, StallAnalysis } from "./profileAnalysis";

export function pct(v: number): string {
  return `${v.toFixed(1)}%`;
}

function dumpFrame(f: FrameAnalysis, limit: number, out: string[], instructionQuery?: string): void {
  out.push("");
  out.push(`Frame ${f.index}: ${f.samples} samples, ${f.cycles} cycles = ${pct(f.cyclePct)} of ${f.frameCycles} color clocks`);
  const detail = [`zero-cost samples: ${f.zeroCostSamples}`];
  if (f.registerSamples) detail.push(`register trace: ${f.registerSamples}`);
  if (f.dmaSlots) detail.push(`fetch cells: ${f.fetchCells}`, `anchored: ${f.anchoredSamples}`);
  out.push(`  ${detail.join(", ")}`);

  if (f.dmaOwners.length > 0) {
    out.push(`  DMA bus: ${f.dmaOwners.map((o) => `${o.name} ${pct(o.pct)}`).join("  ")}`);
  }

  const fns = limit > 0 ? f.functions.slice(0, limit) : f.functions;
  if (fns.length === 0) return;
  out.push("");
  out.push(`  ${"function".padEnd(36)}${"self".padStart(9)}${"self%".padStart(8)}${"width%".padStart(8)}${"samples".padStart(9)}`);
  for (const fn of fns) {
    // width% is only meaningful against a DMA grid; without one it degenerates to self%.
    out.push(
      `  ${fn.name.slice(0, 35).padEnd(36)}${String(fn.selfCycles).padStart(9)}` +
      `${pct(fn.selfPct).padStart(8)}${pct(fn.widthPct).padStart(8)}${String(fn.samples).padStart(9)}`,
    );
  }
  if (limit > 0 && f.functions.length > limit) {
    out.push(`  … ${f.functions.length - limit} more (use --functions 0)`);
  }
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

export function renderDump(a: ProfileAnalysis, frame: number | undefined, limit: number): string {
  const out: string[] = [];
  const m = a.manifest;
  out.push(`${m.program.name ?? "(unnamed program)"} — ${m.frameCount} frame(s), ${m.meta.isPAL ? "PAL" : "NTSC"}`);
  if (m.meta.capturedAt) out.push(`captured ${new Date(m.meta.capturedAt).toISOString()}`);
  out.push(`address range 0x${m.meta.start.toString(16)}-0x${m.meta.end.toString(16)}, ${m.meta.total} instructions executed (${m.meta.inRange} in range)`);
  if (m.kickstart.name) out.push(`kickstart ${m.kickstart.name}`);

  const frames = frame === undefined ? a.frames : a.frames.filter((f) => f.index === frame);
  if (frames.length === 0) {
    out.push("");
    out.push(`No such frame ${frame} (capture has ${a.frames.length}).`);
    return out.join("\n");
  }
  for (const f of frames) dumpFrame(f, limit, out, a.instructionQuery);
  return out.join("\n");
}

export function renderCheck(a: ProfileAnalysis): string {
  const out: string[] = [];
  for (const f of a.frames) {
    out.push(`frame ${f.index}: ${String(f.samples).padStart(7)} samples  ${String(f.cycles).padStart(7)} cycles  ${pct(f.cyclePct).padStart(7)} of frame`);
  }
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

