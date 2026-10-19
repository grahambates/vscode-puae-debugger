// Costs per iteration of a program's own loop, rather than per video frame.
//
// A frame always adds up to the same 71051 colour clocks, so when the main loop's work takes more
// than a frame — an overrun — the per-frame tables just show it spread over two frames, and a
// routine's cost "per frame" stops being its cost per pass. Delimiting time by hits of a chosen
// address (the top of the main loop, say) gives the per-pass figures back, and an iteration
// longer than a frame is a missed frame, directly — whether or not the picture repeated.
//
// The capture's frames are consecutive, so their samples are walked as one stream. Only complete
// iterations are reported: the stretch before the first hit and after the last one is cut off.

import { DMA_HPOS, IComputedNode, IProfileModel } from "./shared/profilerTypes";
import { CaptureSummary, Stat, summarizeFunctions } from "./profileCompare";
import { FrameAnalysis, FunctionCost } from "./profileAnalysis";
import { resolveBreakpointSpec } from "./mcp/breakpointSpec";
import { SourceMap } from "./sourceMap";

const PAL_FRAME_CCK = 71051;
/**
 * How far past one frame an iteration may run and still count as fitting in it. A loop that waits
 * for the beam ends each pass a few colour clocks either side of the same position, so passes of a
 * loop that never misses a frame measure 71060, 71034, … — that's jitter, not an overrun, which
 * takes a whole extra frame.
 */
export const OVERRUN_TOLERANCE = 0.01;

export interface Iteration {
  index: number;
  /** Where it began: the frame, and the raster position in it (from cycle costs). */
  frame: number;
  line: number;
  hpos: number;
  /** Colour clocks from this hit to the next. */
  length: number;
  /** length in frames: over 1 means the pass took more than a frame. */
  frames: number;
}

export interface IterationAnalysis {
  /** As asked for, and what it resolved to. */
  query: string;
  address: number;
  iterations: Iteration[];
  length: Stat;
  /** Iterations that took longer than a frame, beyond OVERRUN_TOLERANCE. */
  overran: number;
  /** Colour clocks in a frame of this capture. */
  frameCycles: number;
  /** Per-function cost per iteration (min/avg/max, 0 where it didn't run in one). */
  summary: CaptureSummary;
}

function stat(values: number[]): Stat {
  if (values.length === 0) return { min: 0, avg: 0, max: 0 };
  return { min: Math.min(...values), avg: values.reduce((a, b) => a + b, 0) / values.length, max: Math.max(...values) };
}

/** The functions on sample k's stack, leaf first, as `name file` keys with their names. */
function stackOf(model: IProfileModel, k: number): { key: string; name: string; file?: string }[] {
  const out: { key: string; name: string; file?: string }[] = [];
  let node: IComputedNode | undefined = model.nodes[model.samples[k + 1]];
  while (node) {
    const loc = model.locations[node.locationId];
    if (loc) {
      const name = loc.callFrame.functionName;
      const file = loc.callFrame.url || undefined;
      out.push({ key: `${name} ${file ?? ""}`, name, file });
    }
    node = node.parent === undefined ? undefined : model.nodes[node.parent];
  }
  if (out.length === 0) {
    const name = `0x${(model.pcs[k] ?? 0).toString(16)}`;
    out.push({ key: name, name });
  }
  return out;
}

/**
 * Split the capture at each execution of `query` — an address, a symbol, or a source line, as
 * breakpoints take them (a local label like `.mainLoop` isn't in the symbol table; give its line).
 */
export function analyseIterations(models: IProfileModel[], sourceMap: SourceMap, query: string): IterationAnalysis {
  const address = resolveBreakpointSpec(query, sourceMap).address & 0xffffff;
  const frameCycles = models[0]?.dma?.owner.length || PAL_FRAME_CCK;

  const iterations: Iteration[] = [];
  const perIteration: FrameAnalysis[] = [];
  let open: { start: Iteration; length: number; costs: Map<string, FunctionCost> } | undefined;
  let previousStack = new Set<string>();

  models.forEach((model, frame) => {
    let offset = 0;
    for (let k = 0; k < model.pcs.length; k++) {
      const cost = model.timeDeltas[k] ?? 0;
      if (((model.pcs[k] ?? 0) & 0xffffff) === address) {
        if (open) {
          open.start.length = open.length;
          open.start.frames = open.length / frameCycles;
          iterations.push(open.start);
          perIteration.push({ index: open.start.index, functions: [...open.costs.values()] } as unknown as FrameAnalysis);
        }
        const start: Iteration = { index: iterations.length, frame, line: Math.floor(offset / DMA_HPOS), hpos: offset % DMA_HPOS, length: 0, frames: 0 };
        open = { start, length: 0, costs: new Map() };
      }
      if (open) {
        open.length += cost;
        const stack = stackOf(model, k);
        const seen = new Set<string>();
        stack.forEach((fn, depth) => {
          if (seen.has(fn.key)) return; // recursion counts once, as in the frame tables
          seen.add(fn.key);
          let c = open!.costs.get(fn.key);
          if (!c) {
            c = { name: fn.name, file: fn.file, samples: 0, selfCycles: 0, selfPct: 0, totalCycles: 0, totalPct: 0, widthPct: 0, calls: 0 };
            open!.costs.set(fn.key, c);
          }
          if (depth === 0) {
            c.samples++;
            c.selfCycles += cost;
          }
          c.totalCycles += cost;
          // Entered: on this stack, not on the one before. Good enough for a count per pass; the
          // frame tables' own count comes from the flame-graph layout.
          if (!previousStack.has(fn.key)) c.calls++;
        });
        previousStack = seen;
      }
      offset += cost;
    }
  });

  const lengths = iterations.map((it) => it.length);
  return {
    query,
    address,
    iterations,
    length: stat(lengths),
    overran: iterations.filter((it) => it.frames > 1 + OVERRUN_TOLERANCE).length,
    frameCycles,
    summary: summarizeFunctions(perIteration),
  };
}
