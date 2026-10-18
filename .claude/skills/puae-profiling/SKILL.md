---
name: puae-profiling
description: Investigate a .puaeprofile capture from the PUAE Amiga debugger/profiler — diagnose why a routine or frame is slow, verify a suspicious flame-graph reading, or check a capture is trustworthy before drawing conclusions from it. Use whenever a .puaeprofile file, a profiler/flame-graph reading, or "why is this function/frame slow" comes up in an Amiga project.
---

# Profiling .puaeprofile captures

This is a **playbook**, not a format spec. It assumes only that the `puae-debugger` npm package
is available (`npx puae-debugger ...`) and that you have a `.puaeprofile` file captured from the
PUAE debugger's profiler — you do not need its source checked out. If you do have it, the
container layout, sample encoding and DMA grid format are documented as header comments in
`src/profileFormat.ts`, `src/profilerManager.ts` (`decodeProfileStream`, `buildProfileModel`) and
`src/shared/dma.ts`; this file is instead about what to do with a capture, and the physical facts
that don't live in any one comment.

## First move, always: `profile check`, not a hand read

```
npx puae-debugger profile check <file.puaeprofile> [--json]
npx puae-debugger profile dump  <file.puaeprofile> [--frame N] [--functions N] [--stalls] [--json]
```

(Working inside a checkout of the debugger itself? `node out/standalone.js profile ...` is the
same binary before packaging. And if the `puae-debugger` MCP server is registered, its
`profile_check`/`profile_dump` tools are the same two commands with the same output — use those
instead of shelling out, and read the rest of this file as guidance on what they return.)

**No capture yet, but you have the program?** Make one rather than asking for it: the MCP
server's `emulator_capture_profile` boots a machine headlessly, injects the program and records
frames to a `.puaeprofile` you can then read with everything below (`emulator_screenshot` does
the same for the picture, when the question is what the program draws rather than what it
costs). Both need a Kickstart ROM — `PUAE_KICKSTART_ROM` in the server's environment, or a
`kickstartRom` argument. `warmupFrames` runs past loading/setup before recording starts; without
it you may capture nothing but the intro. When "the interesting frame" is a place in the code
rather than a number of frames in, `emulator_launch` + `emulator_continue` stop at a breakpoint
first, and `emulator_capture_profile` then records from exactly that state via its `session`
argument. Everything below applies unchanged to a capture made
this way, with one exception: it carries no filmstrip thumbnails, which nothing in the analysis
uses.

Run `check` **before** reading any per-function percentage by eye, and before proposing an
optimization based on what a flame graph looks like. A profile's numbers are easy to rationalize
even when they're wrong — a busy-wait spinning at 76% of a frame is a completely plausible
number to read off a flame graph and accept, right up until you notice the frame's own samples
sum to 157% of the color clocks a PAL frame can physically contain. `check` runs exactly that
kind of invariant, not a vibe check: it goes through the real decode → model-build → flame-graph
layout path (`src/profileAnalysis.ts` in the debugger's own sources) and reports anything that
disagrees with what's physically possible. Exit code is 1 iff an error-level finding fired, so it
also works as a gate in a script.

`dump` is the read side — per-frame cost tables (self cycles, flame-graph width, DMA bus
census) and a manifest summary. Use `--json` for anything you're going to reason over
programmatically rather than read; use `--frame N` to scope to one frame; `--functions 0` for
the full function list instead of the default top 12.

**`--instructions <function>` goes a level deeper**, and is the answer to "which instruction in
this routine costs the time" — cycles, hits and cycles-per-execution for every instruction in
one function, in address order, plus (on a 68000 capture) the datasheet cost of each and the
stall against it. Reach for it as soon as the function table has told you *which* routine to look
at: a function-level number tells you where to look, never what to change. Don't go reading the
source to guess at instruction costs — they are measured, and they are right here (but see the
frame-0 disassembly limit below before concluding a function is missing):

```
  address      cycles    %fn    hits  cyc/hit  sheet  stall  instruction
  0xc046d6         10  10.6%       2      5.0      5    0.0  lsr.l #1,d1
  0xc046d8         49  52.1%       2     24.5     10   14.5  lsr.w #7,d1
```

(that `lsr.w` is not a slow instruction — it is a 10-cycle instruction that spent 14.5 cycles per
execution blocked on the bus, which is a completely different fix.)

**"Does it drop frames?" is answered by repeated frames, not by cycle counts.** Every frame of a
capture fills the whole 71051-colour-clock budget whatever the program does — idle time is spent
in a wait loop, so it's sampled too — and a program has no "application frame" to measure
against. What *is* observable is the screen: `check` and `dump` mark each frame whose picture is
byte-identical to the previous one (the filmstrip's `=` badge) and summarise how long each
picture stayed up, e.g. `held for: 1 frame ×40 (50 fps), 2 frames ×3 (25 fps)` — a 50fps effect
that missed three updates. Capture enough frames to see the pattern (tens, not one), then compare
the frames around a repeat. A static screen repeats every frame and says nothing about timing.

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
  `src/webview/profilerViewer/columns.ts`).
- **Sample count is not proportional to elapsed time on a cached CPU.** A 68020+ instruction
  cache means most instructions never touch the bus at all — a busy frame can have far more
  fetch-cell-less samples than fetch cells in the grid. `dump`'s `anchored` figure (and `check`'s
  `low-anchor-rate` finding) tells you how much of a frame's layout is real vs. interpolated from
  cycle cost. This is normal, not a fault, but it means a spin loop and real work can retire
  wildly different numbers of samples for the same number of cycles — **never read "sample
  count" or "flame-graph width" as "time spent" directly; use self cycles (`selfCycles`/
  `selfPct`).** A `width-vs-cycles` finding is a bug **in the profiler's layout**, not in the
  program and not noise: self cycles are still right, so the analysis can proceed on them, but
  tell the user plainly that the flame graph they're looking at is misdrawn for that function
  (and that it's a debugger bug worth reporting) — don't quietly route around it. It has shipped
  twice: a busy-wait rendered at 91.5% of a frame's flame-graph width for 14.5% of its actual
  cycles (index-based interpolation crowding out real work in an unmatched run), and a
  scanline loop's `dbf` drawn at double its cycle share (68000 prefetch fetching an opcode
  before its instruction starts, so fetch-cell anchors in straight-line code ran early).
- **Time outside `[start, end)` doesn't vanish, it folds into the preceding sample.** ROM/OS/
  interrupt code is never itself sampled (see `syntheticLabel`/`trimToProgramRoot` in
  `src/profilerManager.ts`); its real cost shows up as one inflated `cycleDelta` on whichever
  in-program instruction ran right after it returned. `check`'s `out-of-range-instructions`
  finding tells you how much of the capture this affects — worth knowing before attributing a
  large single-sample cost to the instruction it landed on.
- **Only frame 0 carries a register trace** in a multi-frame capture (`WASM_PROFILE_REG_COUNT`/
  register cap in `puae_debug.c`). It can also be shorter than that frame's own sample count if
  the cap was reached mid-frame (`check`'s `registers-truncated`, info-level, not an error — it
  affects only the Disassembly view's register panel, not the CPU/DMA data).
- **One disassembly listing covers the whole capture, and per-instruction costs are per frame.**
  A capture decodes every function that executed in *any* of its frames (ordered by cost across
  the capture, against a 16k-instruction budget), stores that listing once, and reweights it with
  each frame's own hit/cycle counts (`fetchDisassembly`/`reweightDisassembly` in
  `src/profilerManager.ts`). So `--instructions` works for any function in any frame, and a
  routine that runs on an every-other-frame cadence reads as 0 hits in the frames that skip it —
  a real answer, not a gap.
  - **Captures taken before this** selected only frame 0's functions, so a routine that first ran
    in a later frame has no instruction text anywhere in that file. `--instructions` says exactly
    that when it happens (it names the frames the function did run in) — re-capture rather than
    falling back to estimating costs from the source.
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
  on an old capture means a stale file, not a live bug — re-capture before investigating. (The
  `template.puaeprofile` test fixture committed in the debugger's own repo is one of these.)

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

Both go through `analyseProfile`, which is deliberately the same decode → model →
flame-graph-layout path the extension's viewer uses (`loadProfile` → `buildFramesFromCaptures` →
`buildColumns`) — so its numbers are what a human would see in the viewer, not a reimplementation
that can drift from it.

`--json` is the widest view the CLI gives: the whole `ProfileAnalysis`, not just what the text
report prints, so reach for it before concluding the tool can't answer the question — and note
that per-instruction detail only appears in it when `--instructions` asked for it, so an absence
in the JSON is not evidence the data doesn't exist. Beyond that (a specific DMA cell, the copper
trace, register values at one sample) you need the debugger's own sources checked out, where
`loadProfile`/`decodeCapture` can be called from a small Node script. **Do not hand-parse the gzip/manifest/section format instead** — that reimplementation is
exactly what used to happen before this tool existed, and it's how a decode mistake gets mistaken
for a data bug. Ask for the numbers you need to be added to `dump` rather than reconstructing
them by eye.
