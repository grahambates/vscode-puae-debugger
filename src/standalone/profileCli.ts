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
import { analyseProfile, ProfileAnalysis, ProfileRequestError } from "../profileAnalysis";
import { renderCheck, renderDump } from "../profileReport";

const USAGE = `Usage:
  puae-debugger profile dump  <file.puaeprofile> [--frame N] [--functions N] [--stalls]
                                                  [--instructions NAME] [--json]
  puae-debugger profile check <file.puaeprofile> [--json]

  dump   Per-frame cost tables: cycles, top functions by self time, DMA bus census.
  check  Verify the capture against physical invariants (frame length, flame-graph
         layout, buffer truncation). Exits 1 if any error-level finding is reported.

Options:
  --frame N            Restrict dump to one frame (default: all).
  --functions N        Functions to list per frame (default: 12, 0 for all).
  --stalls             Compare measured cost against 68000 datasheet timings (68kcounter)
                       to separate slow instructions from bus-blocked ones. 68000 only.
  --instructions NAME  Per-instruction costs within one function: cycles, hits, cycles
                       per hit, and (68000) datasheet cost and stall per execution.
  --json               Emit the full analysis as JSON instead of text.`;

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
  let instructions: string | undefined;
  let frame: number | undefined;
  let limit = 12;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (arg === "--stalls") stalls = true;
    else if (arg === "--instructions") {
      instructions = argv[++i];
      if (instructions === undefined) { console.error(`--instructions needs a function name.\n\n${USAGE}`); return 1; }
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
    analysis = analyseProfile(bytes, { stalls, instructions });
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
