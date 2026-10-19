// Function costs across a capture's frames, and between two captures — the measuring a caller
// otherwise does by exporting both to JSON and lining the frames up by hand.
//
// Across frames, a function that didn't run in a frame counts as 0 there, not as missing: "Draw
// costs 0 in frame 4" is the fact a cadence or a dropped frame shows up as, and averaging only
// over the frames it ran in would hide it.
//
// Pure: takes analyses, returns numbers. profileReport.ts renders them.

import { FrameAnalysis } from "./profileAnalysis";

export interface Stat {
  min: number;
  avg: number;
  max: number;
}

export interface FunctionSummary {
  name: string;
  file?: string;
  /** Frames it ran in, of the capture's. */
  frames: number;
  /** Colour clocks per frame, over every frame of the capture. */
  self: Stat;
  total: Stat;
  /** Calls per frame (FunctionCost.calls). */
  calls: Stat;
}

export interface CaptureSummary {
  frames: number;
  functions: FunctionSummary[]; // descending by average self time
}

const key = (name: string, file?: string) => `${name}\0${file ?? ""}`;

function stat(values: number[]): Stat {
  if (values.length === 0) return { min: 0, avg: 0, max: 0 };
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { min, avg: sum / values.length, max };
}

export function summarizeFunctions(frames: FrameAnalysis[]): CaptureSummary {
  const byKey = new Map<string, { name: string; file?: string; self: number[]; total: number[]; calls: number[] }>();
  frames.forEach((frame, i) => {
    for (const fn of frame.functions) {
      const k = key(fn.name, fn.file);
      let entry = byKey.get(k);
      if (!entry) {
        const zeros = () => new Array<number>(frames.length).fill(0);
        entry = { name: fn.name, file: fn.file, self: zeros(), total: zeros(), calls: zeros() };
        byKey.set(k, entry);
      }
      entry.self[i] += fn.selfCycles;
      entry.total[i] += fn.totalCycles;
      entry.calls[i] += fn.calls ?? 0;
    }
  });
  const functions = [...byKey.values()].map((e) => ({
    name: e.name,
    file: e.file,
    frames: e.self.filter((v, i) => v > 0 || e.total[i] > 0).length,
    self: stat(e.self),
    total: stat(e.total),
    calls: stat(e.calls),
  }));
  functions.sort((a, b) => b.self.avg - a.self.avg || b.total.avg - a.total.avg);
  return { frames: frames.length, functions };
}

export interface FunctionDelta {
  name: string;
  file?: string;
  /** Absent when the function never ran in that capture. */
  before?: FunctionSummary;
  after?: FunctionSummary;
  /** Change in average colour clocks per frame, after minus before. */
  selfDelta: number;
  totalDelta: number;
}

export interface ProfileDiff {
  before: CaptureSummary;
  after: CaptureSummary;
  functions: FunctionDelta[]; // descending by the size of the change in self time
}

/**
 * Per-function change in average cost per frame between two captures. Averages per frame rather
 * than frame-by-frame differences: two builds rarely keep their frames in step (an optimisation
 * that saves a frame shifts everything after it), and per-frame averages compare either way.
 */
export function diffProfiles(before: FrameAnalysis[], after: FrameAnalysis[]): ProfileDiff {
  const a = summarizeFunctions(before);
  const b = summarizeFunctions(after);
  const keys = new Map<string, { name: string; file?: string }>();
  for (const f of [...a.functions, ...b.functions]) keys.set(key(f.name, f.file), { name: f.name, file: f.file });
  const find = (s: CaptureSummary, k: string) => s.functions.find((f) => key(f.name, f.file) === k);
  const functions = [...keys.entries()].map(([k, { name, file }]) => {
    const was = find(a, k);
    const now = find(b, k);
    return {
      name,
      file,
      before: was,
      after: now,
      selfDelta: (now?.self.avg ?? 0) - (was?.self.avg ?? 0),
      totalDelta: (now?.total.avg ?? 0) - (was?.total.avg ?? 0),
    };
  });
  functions.sort((x, y) => Math.abs(y.selfDelta) - Math.abs(x.selfDelta) || Math.abs(y.totalDelta) - Math.abs(x.totalDelta));
  return { before: a, after: b, functions };
}
