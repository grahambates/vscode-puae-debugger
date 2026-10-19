---
name: puae-profiling
description: Profile an Amiga program with the PUAE debugger — capture frames with the puae-debugger MCP tools or read a .puaeprofile saved from the profiler, then diagnose why a routine or frame is slow, verify a suspicious flame-graph reading, check a capture is trustworthy, or measure whether an optimization helped. Use whenever "why is this function/frame slow", frame-rate or overrun questions, a .puaeprofile file or a profiler/flame-graph reading comes up in an Amiga project.
---

# Profiling Amiga programs with puae-debugger

This is a **playbook**, not a format spec. It assumes only that the `puae-debugger` npm package
is available (`npx puae-debugger ...`) — you do not need its source checked out. If you do have
it, the container layout, sample encoding and DMA grid format are documented as header comments
in `src/profileFormat.ts`, `src/profilerManager.ts` (`decodeProfileStream`, `buildProfileModel`)
and `src/shared/dma.ts`; this file is instead about what to do with a capture, and the physical
facts that don't live in any one comment.

## Getting a capture

Everything below works on a `.puaeprofile` file, which comes from one of two places:

- **The user saved one** from the profiler panel in VS Code or the standalone debugger. Use it
  as is.
- **You make one** with the `puae-debugger` MCP server (`npx puae-debugger mcp`), when it's
  registered and you have the program. Don't ask for a capture you can make yourself.

Making one: `emulator_capture_profile` boots a machine headlessly, injects the program and
records frames to a `.puaeprofile` (`emulator_screenshot` does the same for the picture, when
the question is what the program draws rather than what it costs). Both need a Kickstart ROM —
`PUAE_KICKSTART_ROM` in the server's environment, or a `kickstartRom` argument.
- **Choose the frames.** `warmupFrames` runs past loading/setup before recording starts; without
  it you may capture nothing but the intro. When "the interesting frame" is a place in the code
  or a moment in the program rather than a number of frames in, get there in a session first —
  `emulator_launch`, then `emulator_continue` to a breakpoint, or `emulator_input` to press past
  a title screen — and pass `session` to `emulator_capture_profile` to record from exactly that
  state. The **puae-debugging** skill covers those session tools.
- **Measure a change.** Capturing runs the session on, so save the starting point first:
  `emulator_snapshot { "save": "before" }`, capture, then `{ "restore": "before" }`,
  `emulator_write` the patch (a constant, a table, a few bytes of code) and capture again. Or
  rebuild and capture the new binary with the same arguments. The emulator is deterministic, so
  the two captures differ only by the change: `profile_diff` (CLI `profile diff <before> <after>`)
  lines them up function by function — average cost per frame before and after, and the change.
- Several frames at once (`frames`, up to 100) is how to see a cadence: routines that run every
  other frame, and repeated frames where the picture didn't change (see `check`/`dump` below).
  `profile_dump { "summary": true }` reads one quickly: each function's min/avg/max per frame, how
  many frames it ran in, and its calls per frame. `out` writes the whole analysis as JSON, for
  anything longer.
- **Overruns: count iterations, not repeated frames.** A frame always adds up to 71051 colour
  clocks, so when the main loop takes longer than a frame its work just spreads over two, and
  per-frame costs stop being per-pass costs. `profile_dump { "iterations": "main.s:204" }` (the
  first instruction of the main loop — a local label like `.mainLoop` isn't a symbol, so give its
  line) splits the capture at each pass instead: each pass's length, which ones took longer than a
  frame, and per-function cost per pass. A repeated picture is only a hint — a dropped frame whose
  picture changes anyway (a buffer cleared while on screen) doesn't repeat. The function table's
  `calls` column (RotateBuffers ×0 in a frame) is the other quick signal.

A capture made this way is the same format as a saved one, with one exception: it carries no
filmstrip thumbnails, which nothing in the analysis uses.

## First move, always: `profile check`, not a hand read

```
npx puae-debugger profile check <file.puaeprofile> [--json]
npx puae-debugger profile dump  <file.puaeprofile> [--frame N] [--functions N] [--sort self|total]
                                [--tree] [--callers NAME] [--flame] [--lines FROM-TO] [--blits]
                                [--copper] [--instructions NAME] [--stalls] [--summary]
                                [--iterations ADDRESS] [--json]
npx puae-debugger profile diff  <before.puaeprofile> <after.puaeprofile> [--functions N] [--json]
```

(Working inside a checkout of the debugger itself? `node out/standalone.js profile ...` is the
same binary before packaging. And if the `puae-debugger` MCP server is registered, its
`profile_check`/`profile_dump` tools are the same two commands with the same output — use those
instead of shelling out, and read the rest of this file as guidance on what they return.
`emulator_capture_profile` already runs `check` on what it records and includes the result.)

Run `check` **before** reading any per-function percentage by eye, and before proposing an
optimization based on what a flame graph looks like. A profile's numbers are easy to rationalize
even when they're wrong — a busy-wait spinning at 76% of a frame is a completely plausible
number to read off a flame graph and accept, right up until you notice the frame's own samples
sum to 157% of the color clocks a PAL frame can physically contain. `check` runs exactly that
kind of invariant, not a vibe check: it goes through the real decode → model-build → flame-graph
layout path (`src/profileAnalysis.ts` in the debugger's own sources) and reports anything that
disagrees with what's physically possible. Exit code is 1 iff an error-level finding fired, so it
also works as a gate in a script.

`dump` is the read side — per-frame cost tables (self cycles, total cycles including callees,
flame-graph width, DMA bus census) and a manifest summary. Use `--json` for anything you're going
to reason over programmatically rather than read; use `--frame N` to scope to one frame;
`--functions 0` for the full function list instead of the default top 12.

Self time says where the CPU *is*; total time says which of *your* routines is responsible.
`--sort total` ranks routines by everything they call — a frame loop with 0% self time can be
the answer. `--tree` prints the top-down call tree (the profiler's Time view), and
`--callers NAME` lists every call path into one function with its cost via each — the way to
find out which caller makes `__udivsi3` or a blitter wait expensive.

**`--flame` is the flame graph as text, and the answer to *when* questions** — "does DrawBars
finish before line 44", "what is the CPU doing while the blit runs". Boxes are in time order,
nested by call depth, each with start and end as raster `line:hpos`, positioned from the same
DMA-anchored layout the flame graph draws. Short boxes fold into `+ name ×count` lines and a
repeating loop body prints once as `×N [...], every ~K lines`. `--lines 40-80` zooms in (finer
folding, and the DMA bus use within just those lines).

**`--blits` lists every blit** (the Blitter view): start and end as `line:hpos`, duration in
slots, operation and size, minterm, symbolicated channel pointers and modulos, and which CPU
function started it. Blitter registers are write-only, so a value the program set *before* the
frame comes from the capture's frame-start register snapshot — for BLTCON0/1, the masks and the
modulos, which only the CPU writes. Channel pointers can't be filled in that way (the blitter
advances them as it runs), so an unwritten pointer is listed as "set before the capture, not
recorded"; so is everything in a capture made before the snapshot was recorded at the frame's
start, where an unknown BLTCON0 prints the operation as `?`. Don't reason from those fields;
recapture with the current build, or read the registers live with `emulator_inspect { chipset: true }`.

**`--copper` is what the copper actually did** this frame: each executed instruction with its
`line:hpos`, and for every WAIT how long it really waited. That differs from decoding the list
in memory (`emulator_inspect { copper: true }`) whenever a SKIP, a jump or a late WAIT changes
what runs. `--lines` narrows it to a window, together with the flame graph.

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

- **Every "cycles" figure is colour clocks, not CPU cycles** — `selfCycles`, `totalCycles`, the
  `cc` and `cc/hit` columns, and the datasheet column of `--instructions`/`--stalls` alike. One
  colour clock is two 68000 cycles, so a `move.b` reading 6 took 12 CPU cycles. Halve a timing
  table's figure before comparing, never double the profile's.
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

Stall is charged to whichever instruction was running when the bus made it wait — including for
its own instruction fetch. So in code running from chip or slow RAM, register-only instructions
(`subq`, `add.w d0,d1`) show stalls too: that's the prefetch queueing behind bitplane or blitter
DMA, not the instruction's operands. Read a block's total stall; don't pin it on one line of it.

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
in the JSON is not evidence the data doesn't exist. Beyond that (a specific DMA cell, register
values at one sample) you need the debugger's own sources checked out, where
`loadProfile`/`decodeCapture` can be called from a small Node script. **Do not hand-parse the gzip/manifest/section format instead** — that reimplementation is
exactly what used to happen before this tool existed, and it's how a decode mistake gets mistaken
for a data bug. Ask for the numbers you need to be added to `dump` rather than reconstructing
them by eye.
