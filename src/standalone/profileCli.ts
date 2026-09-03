// `puae-debugger profile dump|check <file.puaeprofile>` — offline inspection of a captured
// profile, without VS Code, a browser, or the emulator.
//
// Intended as much for automated consumers (a script, or an AI asked to find why a routine is
// slow) as for a human: `--json` emits the whole ProfileAnalysis, and `check` exits non-zero when
// a physical invariant is violated, so it can gate a capture the way a linter gates a build.
//
// All output goes to stdout here, unlike server.ts (whose stdout may be a DAP stream) — these
// subcommands never start the DAP server.

import { readFileSync } from "fs";
import { analyseProfile, FrameAnalysis, ProfileAnalysis, StallAnalysis } from "../profileAnalysis";

const USAGE = `Usage:
  puae-debugger profile dump  <file.puaeprofile> [--frame N] [--functions N] [--stalls] [--json]
  puae-debugger profile check <file.puaeprofile> [--json]

  dump   Per-frame cost tables: cycles, top functions by self time, DMA bus census.
  check  Verify the capture against physical invariants (frame length, flame-graph
         layout, buffer truncation). Exits 1 if any error-level finding is reported.

Options:
  --frame N       Restrict dump to one frame (default: all).
  --functions N   Functions to list per frame (default: 12, 0 for all).
  --stalls        Compare measured cost against 68000 datasheet timings (68kcounter)
                  to separate slow instructions from bus-blocked ones. 68000 only.
  --json          Emit the full analysis as JSON instead of text.`;

function pct(v: number): string {
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

function renderDump(a: ProfileAnalysis, frame: number | undefined, limit: number): string {
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

function renderCheck(a: ProfileAnalysis): string {
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

// Returns the process exit code. `check` fails the run on any error-level finding so it can be
// used as a gate; `dump` is purely informational and always succeeds once the file parses.
export function runProfileCli(argv: string[]): number {
  const sub = argv[0];
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(USAGE);
    return sub ? 0 : 1;
  }
  if (sub !== "dump" && sub !== "check") {
    console.error(`Unknown profile subcommand: ${sub}\n\n${USAGE}`);
    return 1;
  }

  let file: string | undefined;
  let json = false;
  let stalls = false;
  let frame: number | undefined;
  let limit = 12;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (arg === "--stalls") stalls = true;
    else if (arg === "--frame") frame = Number(argv[++i]);
    else if (arg === "--functions") limit = Number(argv[++i]);
    else if (arg.startsWith("-")) { console.error(`Unknown option: ${arg}\n\n${USAGE}`); return 1; }
    else if (file === undefined) file = arg;
    else { console.error(`Unexpected argument: ${arg}\n\n${USAGE}`); return 1; }
  }
  if (file === undefined) { console.error(`No file given.\n\n${USAGE}`); return 1; }

  let analysis: ProfileAnalysis;
  try {
    analysis = analyseProfile(new Uint8Array(readFileSync(file)), { stalls });
  } catch (err) {
    console.error(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  if (json) {
    // The manifest carries the whole disassembly (large, and already available via dump), so it's
    // trimmed out of the JSON — consumers want the analysis, not a re-encoding of the document.
    const { disassembly: _disassembly, ...manifest } = analysis.manifest;
    let { frames, findings } = analysis;
    // Only `dump` takes --frame/--functions (`check` has no such option — see USAGE — and always
    // reports every finding, since a finding already carries its own `frame` field). Applying
    // them here too, not just in renderDump's text path, matters for the JSON output specifically:
    // it's the form an automated caller is most likely to request scoped, e.g. "just frame 3's
    // costs" without pulling the whole capture over.
    if (sub === "dump") {
      if (frame !== undefined) {
        frames = frames.filter((f) => f.index === frame);
        findings = findings.filter((f) => f.frame === undefined || f.frame === frame);
      }
      if (limit > 0) frames = frames.map((f) => ({ ...f, functions: f.functions.slice(0, limit) }));
    }
    console.log(JSON.stringify({ ...analysis, manifest, frames, findings }, null, 2));
  } else {
    console.log(sub === "dump" ? renderDump(analysis, frame, limit) : renderCheck(analysis));
  }

  return sub === "check" && analysis.findings.some((f) => f.severity === "error") ? 1 : 0;
}
