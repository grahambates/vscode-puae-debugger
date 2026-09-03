// Human-readable rendering of a ProfileAnalysis. Shared by the `profile` CLI subcommand and the
// MCP server's tools so both speak in exactly the same terms — a number a person reads in the
// terminal and a number a model reads over MCP should never be formatted differently, or a
// conversation about one won't transfer to the other.

import { FrameAnalysis, ProfileAnalysis, StallAnalysis } from "./profileAnalysis";

export function pct(v: number): string {
  return `${v.toFixed(1)}%`;
}

function dumpFrame(f: FrameAnalysis, limit: number, out: string[]): void {
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
  for (const f of frames) dumpFrame(f, limit, out);
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

