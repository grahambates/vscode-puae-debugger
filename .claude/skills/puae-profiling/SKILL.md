---
name: puae-profiling
description: Investigate a .puaeprofile capture from this repo (vscode-puae-debugger) — diagnose why a routine looks slow, verify a suspicious flame-graph reading, or check a capture is trustworthy before drawing conclusions from it. Use whenever a .puaeprofile file, a profiler/flame-graph reading, or "why is this function/frame slow" comes up for this project.
---

# Profiling .puaeprofile captures

This is a **playbook**, not a format spec — the container layout, sample encoding, and DMA
grid format are already documented as header comments in [src/profileFormat.ts](../../../src/profileFormat.ts),
[src/profilerManager.ts](../../../src/profilerManager.ts) (`decodeProfileStream`,
`buildProfileModel`), and [src/shared/dma.ts](../../../src/shared/dma.ts). Read those if you need
the byte layout; this file is about what to do with a capture, and the physical facts that don't
live in any one comment.

## First move, always: `profile check`, not a hand read

```
node out/standalone.js profile check <file.puaeprofile> [--json]
node out/standalone.js profile dump  <file.puaeprofile> [--frame N] [--functions N] [--stalls] [--json]
```

(Or `npx puae-debugger profile check|dump ...` once the package is installed — same binary,
`profile` is a subcommand of the existing `puae-debugger` CLI, dispatched before the DAP/HTTP
server starts.)

Run `check` **before** reading any per-function percentage by eye, and before proposing an
optimization based on what a flame graph looks like. A profile's numbers are easy to rationalize
even when they're wrong — a busy-wait spinning at 76% of a frame is a completely plausible
number to read off a flame graph and accept, right up until you notice the frame's own samples
sum to 157% of the color clocks a PAL frame can physically contain. `check` runs exactly that
kind of invariant, not a vibe check: it goes through the real decode → model-build → flame-graph
layout path ([src/profileAnalysis.ts](../../../src/profileAnalysis.ts)) and reports anything that
disagrees with what's physically possible. Exit code is 1 iff an error-level finding fired, so it
also works as a gate in a script.

`dump` is the read side — per-frame cost tables (self cycles, flame-graph width, DMA bus
census) and a manifest summary. Use `--json` for anything you're going to reason over
programmatically rather than read; use `--frame N` to scope to one frame; `--functions 0` for
the full function list instead of the default top 12.

If `check` reports nothing, the numbers below can be read at face value. If it reports
something, **fix or account for the finding before trusting anything downstream of it** — an
over-budget frame's per-function percentages are not "slightly off," they're derived from a
denominator that's already wrong.

## Physical facts worth knowing (not obvious from one file)

- **A PAL frame is exactly 71051 color clocks** (`227 × 313`, the DMA grid's fixed geometry —
  `DMA_HPOS × DMA_VPOS`). This is the ground truth every cycle figure is measured against, not
  a display convention. A frame's sampled cycles should sum to ~71051, ± the last frame's known
  ~1% overrun (see below).
- **A DMA grid slot IS one color clock.** The CPU's `timeDeltas` (from `cycleDelta` in
  `wasm_profile_instrHook`, `puae-wasm/puae_debug.c`) and the grid's slot index are the same
  clock, just two different ways of walking it — which is what makes the DMA grid usable as
  ground truth for where a CPU sample actually happened (`buildSampleSlots`,
  [src/webview/profilerViewer/columns.ts](../../../src/webview/profilerViewer/columns.ts)).
- **Sample count is not proportional to elapsed time on a cached CPU.** A 68020+ instruction
  cache means most instructions never touch the bus at all — a busy frame can have far more
  fetch-cell-less samples than fetch cells in the grid. `dump`'s `anchored` figure (and `check`'s
  `low-anchor-rate` finding) tells you how much of a frame's layout is real vs. interpolated from
  cycle cost. This is normal, not a fault, but it means a spin loop and real work can retire
  wildly different numbers of samples for the same number of cycles — **never read "sample
  count" or "flame-graph width" as "time spent" directly; use self cycles (`selfCycles`/
  `selfPct`), and treat a width/cycle-share mismatch (`check`'s `width-vs-cycles`) as a real bug,
  not noise.** This exact failure mode shipped once: a busy-wait rendered at 91.5% of a frame's
  flame-graph width for 14.5% of its actual cycles, because index-based interpolation crowded out
  the real work in an unmatched run.
- **Time outside `[start, end)` doesn't vanish, it folds into the preceding sample.** ROM/OS/
  interrupt code is never itself sampled (see `syntheticLabel`/`trimToProgramRoot` in
  `src/profilerManager.ts`); its real cost shows up as one inflated `cycleDelta` on whichever
  in-program instruction ran right after it returned. `check`'s `out-of-range-instructions`
  finding tells you how much of the capture this affects — worth knowing before attributing a
  large single-sample cost to the instruction it landed on.
- **Only frame 0 carries a register trace and disassembly** in a multi-frame capture
  (`WASM_PROFILE_REG_COUNT`/register cap in `puae_debug.c`; `ProfileManifest.disassembly` in
  `src/profileFormat.ts`). A register trace can also be shorter than a frame's own sample count
  if the register cap was reached mid-frame (`check`'s `registers-truncated`, info-level, not an
  error — it doesn't affect the CPU/DMA data, only the Disassembly view's register panel).
- **The last frame of any capture legitimately overruns by ~1%** (`check`'s
  `last-frame-overrun`, info-level) — `retro_run()` returns a few scanlines past the true frame
  boundary and nothing bounds the final frame the way inter-frame markers bound every earlier
  one. Don't chase this; it's expected. An earlier (non-last) frame doing the same thing is not
  expected — that's `frame-over-budget`, error-level.
- **A capture predating `g_wprofArmPending`** (the mechanism that makes a capture discard
  `wasm_profile_start`'s throwaway alignment `retro_run()` rather than record across it) reports
  roughly 2× a frame's cycles, because its frame 0 spans the alignment frame plus the counted one.
  Its stream will also hold more samples than its own `inRange` counter. Both are fixed in the
  current build — verified across whole/narrow address ranges, one and two frames, several capture
  start phases, and running vs paused: `samples == inRange` exactly, `frameCycles` one frame. So a
  `frame-over-budget` finding with **zero `zeroCostSamples`** (ruling out the `cycleDelta` floor)
  on an old capture means a stale file, not a live bug — re-capture before investigating. The
  committed `template.puaeprofile` test fixture is one of these.

## Don't conflate "CPU time in a function" with "the CPU was busy"

`selfCycles`/`selfPct` measure CPU sample attribution — they say nothing about whether the CPU
was doing useful work or blocked waiting for the bus. Two things disambiguate that, and both
matter before recommending an optimization:

**The DMA bus census.** `dump`'s `dmaOwners` (CPU/BLITTER/BITPLANE/COPPER/… /IDLE, from the same
frame's grid) separates "CPU driving blits" from "CPU idling in a raster wait" from "genuinely
idle frame." A routine can dominate self-cycle share while the census shows the frame was mostly
BLITTER/BITPLANE-bound, in which case speeding up its CPU code won't move the frame time at all.

**`dump --stalls`** goes further, per function: it compares measured cost against the 68000
datasheet cost of the same executions (via the `68kcounter` library) and reports the difference.
Contention can only ever add cycles, so the excess is time the CPU spent waiting rather than
working — a high `stall%` means "blocked, look at the bus", a low one means "genuinely this
expensive, look at the algorithm". `bus` shows the read/write accesses those executions demand,
i.e. what the contention is competing for.

Two guards make this refuse rather than mislead, and it will tell you which one fired:
68kcounter models the **68000 only**, so a capture containing sub-color-clock samples (the 020+
cycle-exact path) is rejected outright; and any capture whose measured cost comes in *below* the
datasheet is rejected too, since no amount of contention can subtract cycles — that catches a
68020 capture old enough to predate the `cycleDelta` fix and so carry no stored zeros to give
itself away. If it says NOT APPLICABLE, believe it; the numbers underneath would be fiction.

## When `check`/`dump` aren't enough

Both go through `analyseProfile` (`src/profileAnalysis.ts`), which is deliberately the same
decode → model → flame-graph-layout path the extension's viewer uses
(`loadProfile` → `buildFramesFromCaptures` → `buildColumns`) — so its numbers are what a human
would see in the viewer, not a reimplementation that can drift from it. If you need something
the CLI doesn't surface (a specific DMA cell, the copper trace, register values at one sample),
call `loadProfile`/`decodeCapture` yourself from a small Node script rather than hand-parsing the
gzip/manifest/section format from scratch — that hand-reimplementation is exactly what used to
happen before this tool existed, and it's how a decode mistake gets mistaken for a data bug.
