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
import { analyseProfile, parseLineRange, ProfileAnalysis, ProfileRequestError } from "../profileAnalysis";
import { diffProfiles, summarizeFunctions } from "../profileCompare";
import { analysisJson, renderCheck, renderDiff, renderDump, renderHeader, renderIterations, renderSummary } from "../profileReport";

const USAGE = `Usage:
  puae-debugger profile dump  <file.puaeprofile> [--frame N] [--functions N] [--sort self|total]
                                                  [--tree] [--callers NAME] [--flame]
                                                  [--lines FROM-TO] [--blits] [--copper]
                                                  [--stalls]
                                                  [--instructions NAME] [--summary]
                                                  [--iterations ADDRESS] [--json]
  puae-debugger profile check <file.puaeprofile> [--json]
  puae-debugger profile diff  <before.puaeprofile> <after.puaeprofile> [--functions N] [--json]

  dump   Per-frame cost tables: cycles, top functions by self and total time, DMA bus census.
  check  Verify the capture against physical invariants (frame length, flame-graph
         layout, buffer truncation). Exits 1 if any error-level finding is reported.
  diff   Compare two captures: each function's average cost per frame before and after,
         ordered by how much it changed.

  Times are colour clocks (1 cc = 2 68000 CPU cycles; a PAL frame is 71051 cc).

Options:
  --frame N            Restrict dump to one frame (default: all).
  --functions N        Functions to list per frame (default: 12, 0 for all).
  --sort self|total    Order functions by self cycles (default) or total including callees.
  --tree               Top-down call tree (total% and self% per call path).
  --callers NAME       Every call path into one function, with its cost via each.
  --flame              The flame graph as text: call stacks in time order, positions as
                       raster line:hpos, short boxes folded.
  --lines FROM-TO      Zoom the flame graph (and --copper) to these raster lines; implies --flame.
  --blits              Every blit: when it ran (line:hpos), size, channels, minterm,
                       pointers, and which CPU function started it.
  --copper             The copper instructions executed, with line:hpos and how long each
                       WAIT actually waited.
  --stalls             Compare measured cost against 68000 datasheet timings (68kcounter)
                       to separate slow instructions from bus-blocked ones. 68000 only.
  --instructions NAME  Per-instruction costs within one function: cycles, hits, cycles
                       per hit, and (68000) datasheet cost and stall per execution.
  --summary            Each function's min/avg/max cost per frame across the capture,
                       instead of a table per frame.
  --iterations ADDRESS Split the capture at each execution of ADDRESS (an address, symbol
                       or file:line, e.g. the top of the main loop): each iteration's length,
                       which ones took longer than a frame, and per-function cost per iteration.
  --json               Emit the full analysis as JSON instead of text.`;

// Returns the process exit code. `check` fails the run on any error-level finding so it can be
// used as a gate; `dump` is purely informational and always succeeds once the file parses.
export function runProfileCli(argv: string[]): number {
  const sub = argv[0];
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(USAGE);
    return sub ? 0 : 1;
  }
  if (sub === "diff") return runDiff(argv.slice(1));
  if (sub !== "dump" && sub !== "check") {
    console.error(`Unknown profile subcommand: ${sub}\n\n${USAGE}`);
    return 1;
  }

  let file: string | undefined;
  let json = false;
  let stalls = false;
  let instructions: string | undefined;
  let frame: number | undefined;
  let limit = 12;
  let sort: "self" | "total" = "self";
  let callTree = false;
  let callers: string | undefined;
  let flame = false;
  let blits = false;
  let copper = false;
  let lines: string | undefined;
  let summary = false;
  let iterations: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (arg === "--stalls") stalls = true;
    else if (arg === "--instructions") {
      instructions = argv[++i];
      if (instructions === undefined) { console.error(`--instructions needs a function name.\n\n${USAGE}`); return 1; }
    }
    else if (arg === "--sort") {
      const v = argv[++i];
      if (v !== "self" && v !== "total") { console.error(`--sort takes "self" or "total".\n\n${USAGE}`); return 1; }
      sort = v;
    }
    else if (arg === "--tree") callTree = true;
    else if (arg === "--summary") summary = true;
    else if (arg === "--iterations") {
      iterations = argv[++i];
      if (!iterations) { console.error(`--iterations needs an address, symbol or file:line.\n\n${USAGE}`); return 1; }
    }
    else if (arg === "--flame") flame = true;
    else if (arg === "--blits") blits = true;
    else if (arg === "--copper") copper = true;
    else if (arg === "--lines") {
      lines = argv[++i];
      if (!lines) { console.error(`--lines needs a range, e.g. 40-80.\n\n${USAGE}`); return 1; }
    }
    else if (arg === "--callers") {
      callers = argv[++i];
      if (!callers) { console.error(`--callers needs a function name.\n\n${USAGE}`); return 1; }
    }
    else if (arg === "--frame") frame = Number(argv[++i]);
    else if (arg === "--functions") limit = Number(argv[++i]);
    else if (arg.startsWith("-")) { console.error(`Unknown option: ${arg}\n\n${USAGE}`); return 1; }
    else if (file === undefined) file = arg;
    else { console.error(`Unexpected argument: ${arg}\n\n${USAGE}`); return 1; }
  }
  if (file === undefined) { console.error(`No file given.\n\n${USAGE}`); return 1; }
  if (instructions !== undefined && instructions.length === 0) {
    console.error(`--instructions needs a function name.\n\n${USAGE}`); return 1;
  }
  if (instructions !== undefined && sub !== "dump") {
    console.error(`--instructions applies to "dump", not "${sub}".\n\n${USAGE}`); return 1;
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(file));
  } catch (err) {
    console.error(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  let analysis: ProfileAnalysis;
  try {
    const flameOpt = lines !== undefined ? parseLineRange(lines) : flame;
    analysis = analyseProfile(bytes, { stalls, instructions, callTree, callers, flame: flameOpt, blits, copper, iterations });
  } catch (err) {
    // A request the capture can't satisfy (an unknown --instructions name) is reported on its own
    // terms: its message already names what the capture does contain, and a "could not read"
    // prefix would send the caller looking at the file instead of at their argument. Anything
    // else here is a damaged or unexpected file, which is exactly what that prefix is for.
    if (err instanceof ProfileRequestError) {
      console.error(err.message);
    } else {
      console.error(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return 1;
  }

  const across = summary ? summarizeFunctions(analysis.frames) : undefined;
  if (json) {
    // Only `dump` takes --frame/--functions (`check` has no such option — see USAGE — and always
    // reports every finding, since a finding already carries its own `frame` field). Applying
    // them here too, not just in renderDump's text path, matters for the JSON output specifically:
    // it's the form an automated caller is most likely to request scoped, e.g. "just frame 3's
    // costs" without pulling the whole capture over.
    const scope = sub === "dump" ? { frame, limit, sort, summary: across } : {};
    console.log(JSON.stringify(analysisJson(analysis, scope), null, 2));
  } else if (sub === "dump" && (across || analysis.iterations)) {
    const parts = [...renderHeader(analysis)];
    if (across) parts.push(renderSummary(across, limit));
    if (analysis.iterations) parts.push(renderIterations(analysis.iterations, limit));
    console.log(parts.join("\n"));
  } else {
    console.log(sub === "dump" ? renderDump(analysis, frame, limit, sort) : renderCheck(analysis));
  }

  return sub === "check" && analysis.findings.some((f) => f.severity === "error") ? 1 : 0;
}

function runDiff(argv: string[]): number {
  const files: string[] = [];
  let json = false;
  let limit = 20;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (arg === "--functions") limit = Number(argv[++i]);
    else if (arg.startsWith("-")) { console.error(`Unknown option: ${arg}\n\n${USAGE}`); return 1; }
    else files.push(arg);
  }
  if (files.length !== 2) { console.error(`diff takes two captures, before and after.\n\n${USAGE}`); return 1; }
  const analyses: ProfileAnalysis[] = [];
  for (const file of files) {
    try {
      analyses.push(analyseProfile(new Uint8Array(readFileSync(file))));
    } catch (err) {
      console.error(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  const diff = diffProfiles(analyses[0].frames, analyses[1].frames);
  console.log(json ? JSON.stringify(diff, null, 2) : renderDiff(diff, limit, [files[0], files[1]]));
  return 0;
}
