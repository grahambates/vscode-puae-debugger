// Shared hot/cold tint formula for profiler cycle counts — no vscode/node imports, so both the
// webview (DisassemblyView.tsx's per-instruction heat map) and the extension host
// (profilerLineDecorationProvider.ts's per-source-line heat map) render identically.

// Background alpha proportional to `cycles`' share of `maxCycles` — deliberately scaled to
// whatever `maxCycles` the caller passes (e.g. the hottest instruction within one function, or
// the hottest line within one file), not a global capture-wide max, so a function/file that's
// individually cold relative to the rest of the program still shows a meaningful gradient.
export function heatColor(cycles: number, maxCycles: number, maxAlpha = 0.5): string | undefined {
  if (maxCycles <= 0 || cycles <= 0) return undefined;
  const heat = Math.min(1, cycles / maxCycles);
  return `rgba(255,140,0,${(heat * maxAlpha).toFixed(3)})`;
}
