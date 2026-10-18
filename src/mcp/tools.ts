// The tools this MCP server exposes over saved .puaeprofile captures. The emulator-backed tools —
// the ones that produce a capture in the first place — live in emulatorTools.ts; `buildTools`
// below is what the server actually serves.
//
// Descriptions are written for a model deciding which tool to reach for, and they carry the one
// piece of judgement that matters most here: run `profile_check` before trusting any number from
// `profile_dump`. A capture's per-function percentages are easy to read and believe even when the
// frame they are a share of is itself wrong, which is exactly how three separate profiler bugs
// went unnoticed. The same instruction leads the puae-profiling skill, for the same reason.
//
// Output is the text the `profile` CLI subcommand prints, via the shared renderers in
// profileReport.ts, so a number discussed in a terminal and a number discussed over MCP are
// formatted identically.

import { readFileSync, statSync } from "fs";
import { analyseProfile, parseLineRange } from "../profileAnalysis";
import { renderCheck, renderDump } from "../profileReport";
import { emulatorTools, EmulatorToolContext } from "./emulatorTools";
import { ToolDefinition } from "./jsonRpc";
import { expandHome } from "./paths";

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) throw new Error(`"${key}" is required and must be a string`);
  return v;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`"${key}" must be a number`);
  return n;
}

type AnalysisOptions = NonNullable<Parameters<typeof analyseProfile>[1]>;

// Reading and decoding is the expensive part (gunzip, DWARF, model build, column layout), and a
// model typically calls check then dump on the same file. Cache the last one — keyed on the
// file's modification time too, since emulator_capture_profile may rewrite the same path.
let cache: { key: string; analysis: ReturnType<typeof analyseProfile> } | undefined;

function load(rawFile: string, opts: AnalysisOptions = {}): ReturnType<typeof analyseProfile> {
  const file = expandHome(rawFile);
  let bytes: Uint8Array;
  let key: string;
  try {
    key = JSON.stringify([file, statSync(file).mtimeMs, opts]);
    if (cache?.key === key) return cache.analysis;
    bytes = new Uint8Array(readFileSync(file));
  } catch (err) {
    throw new Error(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const analysis = analyseProfile(bytes, opts);
  cache = { key, analysis };
  return analysis;
}

export const TOOLS: ToolDefinition[] = [
  {
    name: "profile_check",
    description:
      "Verify a .puaeprofile capture against physical invariants before drawing any conclusion " +
      "from it: whether each frame's sampled cycles add up to the colour clocks a frame actually " +
      "contains, whether the flame graph's layout agrees with the measured costs, and whether " +
      "recording was truncated. ALWAYS run this before profile_dump — a capture's per-function " +
      "percentages look entirely plausible even when the frame total they are a share of is " +
      "impossible, and error-level findings mean the numbers underneath cannot be trusted.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to a .puaeprofile file." },
      },
      required: ["file"],
      additionalProperties: false,
    },
    run: (args) => renderCheck(load(requireString(args, "file"))),
  },
  {
    name: "profile_dump",
    description:
      "Per-frame cost tables for a .puaeprofile capture: self and total (including callees) cycles " +
      "and flame-graph width per function, plus a DMA bus census showing what the chipset was doing. " +
      "Set `callTree` for the top-down call tree (the profiler's Time view), or `callers` to a " +
      "function name to see every call path into it and what each costs — e.g. which caller makes " +
      "__udivsi3 expensive. Set `instructions` to a " +
      "function name to go a level deeper and get its per-instruction costs. Read the two together " +
      "— a routine can dominate CPU time while the census shows the frame was blitter-bound, in " +
      "which case optimising its code will not move the frame time. Set stalls:true to compare " +
      "measured cost against 68000 datasheet timings, which separates an instruction that is " +
      "inherently slow from one that was blocked waiting for the bus (68000 captures only; it " +
      "says so and declines otherwise).",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to a .puaeprofile file." },
        frame: { type: "number", description: "Restrict to one frame index. Omit for all frames." },
        functions: {
          type: "number",
          description: "How many functions to list per frame (default 12; 0 for all).",
        },
        stalls: {
          type: "boolean",
          description:
            "Include measured-vs-datasheet stall analysis, showing how much of each function's " +
            "time was spent blocked rather than working. 68000 captures only.",
        },
        sort: {
          type: "string",
          enum: ["self", "total"],
          description: 'Order the function table by self cycles (default) or by total cycles including callees ("total": which routine, with everything it calls, costs the most).',
        },
        callTree: {
          type: "boolean",
          description: "Include the top-down call tree: total% and self% per call path, calls under 1% of the frame folded.",
        },
        callers: {
          type: "string",
          description: "Name of a function to list every call path into, with the cycles spent in it (including callees) via each path.",
        },
        flame: {
          type: "boolean",
          description:
            "Include the flame graph as text: which functions run when, nested by call depth, with each box's " +
            "start and end as raster line:hpos — positioned exactly as the profiler's flame graph draws them. " +
            "Answers timing questions: does DrawBars finish before line 44, what runs during the blit.",
        },
        lines: {
          type: "string",
          description: 'Zoom the flame graph to raster lines "FROM-TO" (e.g. "40-80"), with finer folding and the DMA bus use in that window. Implies flame.',
        },
        instructions: {
          type: "string",
          description:
            "Name of one function to break down instruction by instruction: cycles, hits, cycles " +
            "per execution, and (68000) the datasheet cost and the stall against it. This is how " +
            "to find WHICH instruction in a slow routine costs the time — reach for it once the " +
            "function table has told you which routine to look at.",
        },
      },
      required: ["file"],
      additionalProperties: false,
    },
    run: (args) => {
      const file = requireString(args, "file");
      const stalls = args.stalls === true;
      const frame = optionalNumber(args, "frame");
      const functions = optionalNumber(args, "functions");
      const instructions = args.instructions === undefined ? undefined : requireString(args, "instructions");
      const callers = args.callers === undefined ? undefined : requireString(args, "callers");
      const callTree = args.callTree === true;
      const sort = args.sort === undefined ? "self" : args.sort;
      if (sort !== "self" && sort !== "total") throw new Error(`"sort" must be "self" or "total"`);
      const lines = args.lines === undefined ? undefined : parseLineRange(requireString(args, "lines"));
      const flame = lines ?? args.flame === true;
      return renderDump(load(file, { stalls, instructions, callTree, callers, flame }), frame, functions ?? 12, sort);
    },
  },
];

/**
 * Every tool the server serves, analysis and emulator alike, in the order a caller works through
 * them: capture, then verify, then read.
 */
export function buildTools(ctx: EmulatorToolContext): ToolDefinition[] {
  return [...emulatorTools(ctx), ...TOOLS];
}
