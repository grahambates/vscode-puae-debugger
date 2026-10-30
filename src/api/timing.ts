/** An emulated-time checkpoint. Reading one never advances execution. */
export interface TimingPoint {
  readonly colourClocks: number;
  readonly instructions: number;
  readonly sinceLaunchColourClocks: number;
  readonly pc: number;
  readonly location: string;
  readonly frame: number;
  /** Checkpoints are comparable only within the same machine and execution timeline. */
  readonly sessionId: string;
  readonly timeline: number;
}
export interface ElapsedTiming {
  colourClocks: number;
  instructions: number;
  start: TimingPoint;
  end: TimingPoint;
}
export interface TimingStats {
  min: number;
  mean: number;
  max: number;
  total: number;
}

export function elapsedTiming(
  start: TimingPoint,
  end: TimingPoint,
): ElapsedTiming {
  if (start.sessionId !== end.sessionId)
    throw new Error("Timing checkpoints belong to different emulator sessions");
  if (start.timeline !== end.timeline)
    throw new Error(
      "Execution was rewound or restored; take a new timing checkpoint",
    );
  const colourClocks = end.colourClocks - start.colourClocks;
  const instructions = end.instructions - start.instructions;
  if (
    ![colourClocks, instructions].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    )
  )
    throw new Error(
      "Timing checkpoints are out of order or exceed integer precision",
    );
  return { colourClocks, instructions, start, end };
}
export function timingStats(values: number[]): TimingStats {
  const total = values.reduce((a, b) => a + b, 0);
  return {
    min: Math.min(...values),
    mean: total / values.length,
    max: Math.max(...values),
    total,
  };
}
