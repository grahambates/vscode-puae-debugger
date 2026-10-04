// Time-ordered column model for the flame chart. Ported from the old
// vscode-amiga-debug `flame/stacks.tsx` (`buildColumns`), adapted to our shared
// IProfileModel types (no devtools-protocol / Cdp dependency). Pure + testable.
//
// One column per captured instruction (in execution order); each column's `rows`
// holds the call stack outermost-first. Adjacent columns with an identical frame at
// a given row are coalesced: a numeric cell `n` means "merge with the cell at column
// n, same row", which is how runs of the same function become a single wide box.

import { IProfileModel, ILocation, IDmaModel, BusOwner, DMA_CODE } from "../../shared/profilerTypes";
import { binarySearch } from "./array";

export interface IColumnLocation extends ILocation {
  graphId: number; // unique id of this cell in the graph (for hover/focus/colour)
  filtered: boolean;
}

export interface IColumn {
  x1: number; // left edge, 0..1 of the frame duration
  x2: number; // right edge, 0..1
  rows: (IColumnLocation | number)[];
}

// How far either side of a sample's PREDICTED grid position to look for its fetch cell. Bounded so
// a genuinely unmatchable sample (see below) can't turn this into an O(samples * N) scan.
//
// The prediction is what makes a small window workable. Searching blindly forward from the last
// match instead — which this did originally — fails as soon as anything runs for longer than the
// window without emitting a fetch cell, and then fails permanently: the cursor is left further
// behind the raster than the window reaches, so every subsequent sample looks unmatchable too. One
// raster busy-wait is enough to trigger it. Measured on a real 68020 capture, matching died at
// sample 1,907 of 31,078 and never recovered, leaving 2.5% of samples anchored to observed
// positions and the rest riding on extrapolation alone.
//
// Keep this TIGHT. It is a tolerance on how far the grid may disagree with the cycle clock, not a
// search budget, and widening it past what that disagreement actually is starts matching the wrong
// lap of a loop — the same PC, a different iteration. A wrong match is worse than no match: it
// pins a sample to a position it never occupied and desynchronises everything after it. Swept
// against the width-vs-cycles invariant (profileAnalysis.ts) on a real capture, worst divergence
// between a function's flame-graph width and its measured cycle share:
//
//     window     4      8     16     32     64     96    128    192    512
//     matched  679   3973   5744   5911   5934   5948   5959   5955   3452
//     worst   0.0pp  0.1pp  0.2pp  0.2pp  0.2pp  0.2pp  0.2pp  0.1pp  6.8pp
//
// 512 matching FEWER samples than 128 is the wrong-lap cascade, not noise. 128 sits at the plateau.
const CODE_MATCH_WINDOW = 128;

// Anchor each CPU sample to the DMA grid's own record of its instruction fetch (owner==CPU,
// DMA_CODE flag, real bus address) — ground truth for "when did this instruction actually run,"
// walked in execution order alongside the samples via a single forward pointer into the grid
// (both streams are monotonic, so this is O(samples + dmaSlots), not quadratic).
//
// The CPU-cycle-cost timeline (model.duration / timeDeltas) and the DMA grid's raster-slot
// timeline are two independent clocks: the former only starts counting from the first sampled
// (in-program) instruction of the capture and silently drops any real time spent executing
// out-of-program code (interrupts/OS calls) in between samples, while the grid always starts at
// the true frame origin (line 0, color clock 0). Normalizing both by their own totals — as
// buildColumns' fallback path below does — makes CPU boxes drift from where the DMA/blitter bands
// (which use the grid slot directly, see FlameGraph.tsx's spanX) place the very same instant.
// Matching each sample directly against the grid sidesteps that mismatch instead of estimating it.
//
// A sample can go unmatched (no fresh fetch cell) when its opcode word was already sitting in the
// 68000's prefetch queue from an earlier fetch — mostly tight loops/branches; rare in practice.
// Those are filled in by interpolating between the nearest matched neighbours.
//
// Sample 0 specifically is *always* at risk of exactly this prefetch-queue miss: it's whatever
// instruction was already being fetched the instant recording turned on, so there was never a
// recording-enabled fetch cycle for its own opcode. In a long-running loop (this program's own
// bug report case: a multi-scanline-per-iteration loop), that same address doesn't come around
// again until the *next* lap — many lines later — while the very next sample (0x2 or 0x4 bytes
// on) gets fetched normally right away and shows up within a handful of cells of the true start.
// Naively searching for sample 0's own address across the whole grid (see below) would then latch
// onto that later lap instead of the true start, rendering a large, spurious empty gap at the
// left edge of the flame graph even though real samples begin almost immediately.
const ANCHOR_CANDIDATES = 32;

// Exported for profileAnalysis.ts, which reports how much of a frame's layout is anchored to a
// real instruction fetch versus interpolated from cycle cost. That has to be the matcher's own
// count: inferring it from column widths can't tell an anchored column from an interpolated one
// that merely happens to be a slot wide, and (since zero-cost samples collapse to zero width) it
// systematically overstates anchoring.
export function buildSampleSlots(pcs: readonly number[], timeDeltas: readonly number[], dma: IDmaModel): { slots: Int32Array; matched: number } {
  const { owner, flags, addr } = dma;
  const N = owner.length;
  const slots = new Int32Array(pcs.length).fill(-1);

  const numCandidates = Math.min(ANCHOR_CANDIDATES, pcs.length);

  // Resolve all ANCHOR_CANDIDATES samples' addresses in a single O(N) pass over the grid (instead
  // of one independent O(N) scan per candidate) — a candidate PC can repeat across k (e.g. a
  // 2-byte NOP loop), so track every k waiting on a given address, not just one.
  const pcToKs = new Map<number, number[]>();
  for (let k = 0; k < numCandidates; k++) {
    const pc = pcs[k];
    let ks = pcToKs.get(pc);
    if (!ks) { ks = []; pcToKs.set(pc, ks); }
    ks.push(k);
  }
  const candidateSlot = new Int32Array(numCandidates).fill(-1);
  for (let j = 0; j < N && pcToKs.size > 0; j++) {
    if (owner[j] !== BusOwner.CPU || !(flags[j] & DMA_CODE)) continue;
    const ks = pcToKs.get(addr[j]);
    if (!ks) continue;
    for (const k of ks) candidateSlot[k] = j;
    pcToKs.delete(addr[j]);
  }

  // Confirm a candidate anchor by checking that at least one of its next few samples also
  // resolves nearby — a genuine run of real execution has consecutive samples close together in
  // the grid; an isolated coincidental match (e.g. a shared subroutine an interrupt handler also
  // happens to call, whose address collides with one of the profiled program's own early samples)
  // won't have anything nearby confirming it. Tolerates an occasional individual miss among the
  // lookahead samples (the same prefetch-queue effect can affect any sample, not just the anchor
  // itself), by accepting as soon as any of them matches rather than requiring all to.
  const confirms = (k: number, slot: number): boolean => {
    const lookahead = Math.min(pcs.length, k + 5);
    const cell = slot + 1;
    for (let m = k + 1; m < lookahead; m++) {
      const limit = Math.min(N, cell + CODE_MATCH_WINDOW);
      let j = cell;
      while (j < limit && !(owner[j] === BusOwner.CPU && flags[j] & DMA_CODE && addr[j] === pcs[m])) j++;
      if (j < limit) return true;
    }
    return k + 1 >= pcs.length; // nothing left to confirm against (anchor is at/near the very end)
  };

  // Find the true starting anchor: among the resolved candidates, ordered earliest grid position
  // first, pick the first one that's confirmed by a nearby run (see confirms). A same-loop revisit
  // of an earlier sample's address always resolves to a LATER position than whichever sample
  // genuinely executes first, so trying candidates in ascending order is what makes the fix robust
  // without needing to special-case "sample 0 specifically". A genuinely large gap before the
  // first in-program instruction (interrupts/OS/Kickstart init — see the header comment) still
  // works: every early sample's earliest occurrence clusters around that same real start.
  const ordered: { k: number; slot: number }[] = [];
  for (let k = 0; k < numCandidates; k++) {
    if (candidateSlot[k] >= 0) ordered.push({ k, slot: candidateSlot[k] });
  }
  ordered.sort((a, b) => a.slot - b.slot);
  let anchorK = -1;
  let anchorSlot = -1;
  for (const c of ordered) {
    if (confirms(c.k, c.slot)) {
      anchorK = c.k;
      anchorSlot = c.slot;
      break;
    }
  }
  // Nothing passed confirmation (extremely unlikely — would need every candidate to be an
  // isolated coincidental match) — anchoring on the unvalidated earliest is still better than not
  // anchoring at all.
  if (anchorK < 0 && ordered.length > 0) {
    anchorK = ordered[0].k;
    anchorSlot = ordered[0].slot;
  }

  // Cumulative cycle cost, used to predict where a sample should be before looking for it. A grid
  // slot is one color clock and timeDeltas are color clocks, so cycles elapsed since the last
  // confirmed match convert straight into slots travelled — the two are the same axis.
  const cum = new Float64Array(pcs.length + 1);
  for (let k = 0; k < pcs.length; k++) cum[k + 1] = cum[k] + (timeDeltas[k] ?? 0);

  let cell = 0;
  let matched = 0;
  let startK = 0;
  // The most recent confirmed (sample, slot) pair — the origin every prediction is measured from,
  // so drift can't accumulate across a frame the way it would from a single fixed origin.
  let refK = 0;
  let refSlot = 0;
  if (anchorK >= 0) {
    slots[anchorK] = anchorSlot;
    cell = anchorSlot + 1;
    matched = 1;
    startK = anchorK + 1;
    refK = anchorK;
    refSlot = anchorSlot;
    // Samples before the anchor never got a matchable fetch cell (that's the whole point of
    // picking the earliest candidate) — left unmatched, they're interpolated/clamped to the
    // anchor below, same as any other unmatched run.
  }
  for (let k = startK; k < pcs.length; k++) {
    const pc = pcs[k];
    // Where this sample should be if the cycle clock and the grid agree. Never search behind
    // `cell`: slots must come out non-decreasing for the interpolation and every binary search
    // downstream (columnIndexAtX) to hold.
    const predicted = refSlot + (cum[k] - cum[refK]);
    const from = Math.max(cell, Math.min(N, Math.floor(predicted) - CODE_MATCH_WINDOW));
    const limit = Math.min(N, Math.ceil(predicted) + CODE_MATCH_WINDOW);
    let j = from;
    while (j < limit && !(owner[j] === BusOwner.CPU && flags[j] & DMA_CODE && addr[j] === pc)) j++;
    if (j < limit) {
      slots[k] = j;
      cell = j + 1;
      matched++;
      refK = k;
      refSlot = j;
    }
    // else: leave unmatched (-1); `cell` stays put so the next sample can still match nearby —
    // this one just consumed no grid cell. The prediction keeps tracking the raster meanwhile, so
    // a long unmatchable stretch no longer strands the search behind it.
  }

  // A fetch cell marks when an opcode was FETCHED, not when its instruction started, and the gap
  // between the two is the prefetch queue's lead. After a taken branch/jump flushes the queue that
  // lead is ~0 (the target is fetched as the transfer completes); in straight-line code the opcode
  // was prefetched an instruction or two earlier. So positions anchored on sequential samples are
  // shifted copies of the truth: within one function the shift cancels, but wherever the lead
  // changes it moves cost across a function boundary. Measured on a 68000 texture mapper, a
  // `move.b (a3),-(a2)` falling through into the `dbf d7,loop` that closes each scanline handed
  // the dbf 13.4 color clocks of width per execution for 6.6 measured, doubling its flame-graph
  // share. Keep only matches on control-transfer targets (or the start anchor), where fetch ≈
  // start; the cycle-weighted fill below places everything between them, and cycleDeltas are
  // exact hook-to-hook durations, so that loses nothing. "Sequential" is a forward step of at
  // most one maximal 68000 instruction (10 bytes): a short forward branch misread as sequential
  // only costs an anchor, never a wrong one. `matched` keeps counting every match — it reports
  // whether the matcher is tracking the raster (profileAnalysis' low-anchor-rate), not this.
  for (let k = startK; k < pcs.length; k++) {
    const step = pcs[k] - pcs[k - 1];
    if (slots[k] >= 0 && step >= 2 && step <= 10) slots[k] = -1;
  }

  // Fill unmatched runs by interpolating between the nearest matched neighbours — weighted by
  // each sample's CYCLE COST, not by its index in the run.
  //
  // Sample index is not proportional to elapsed time, and on a cached CPU the error is enormous
  // rather than marginal. Instructions running out of the 68020's I-cache emit no fetch cell at
  // all, so a tight loop is invisible to the matcher above: measured on a real capture, a whole
  // frame offered 10,028 fetch cells for 31,078 executed instructions, and the WaitRaster spin
  // loop contributed 17 cells for 11,806 samples. Worse, one such spin puts `cell` more than
  // CODE_MATCH_WINDOW behind the raster, and the bounded forward search can never catch back up
  // — so matching died at sample 1,907 of 31,078 and the remaining 29,170 samples (91% of the
  // frame's cycles) became one interpolated run. Spread by index, a spin loop retiring ~0.9
  // cycles per sample crowds out the real work at ~3.9, and the flame graph handed WaitRaster
  // 91.5% of its width for 14.5% of the frame's actual cycles — the busy-wait appearing to eat a
  // frame that the DMA band plainly shows driving blits.
  //
  // Cycles are the right weight because the two clocks are the same clock: a grid slot is one
  // color clock, and timeDeltas are color clocks that now sum to the frame (see
  // wasm_profile_instrHook's cycleDelta accounting). That also makes the trailing run — which has
  // no far endpoint to interpolate towards — extrapolable at 1 cycle per slot from the last
  // match, instead of clamping 29,170 samples onto a single slot and letting the final column
  // stretch across everything they should have covered. The leading run keeps the old clamp: it
  // spans at most the handful of samples before the anchor (which is chosen from the first
  // ANCHOR_CANDIDATES), and extrapolating backwards off the grid buys nothing at that size.
  // (cum, above, is the same cycles-elapsed-before-sample-k prefix the matcher predicts with.)
  let prev = -1;
  for (let k = 0; k < slots.length; k++) {
    if (slots[k] < 0) continue;
    if (prev < 0) {
      for (let j = 0; j < k; j++) slots[j] = slots[k];
    } else if (k - prev > 1) {
      const s0 = slots[prev];
      const s1 = slots[k];
      // Zero-cycle span (every sample in the run measured sub-color-clock, which the 68020's
      // lumped accounting does produce) carries no timing information — fall back to index.
      const cycleSpan = cum[k] - cum[prev];
      const span = cycleSpan > 0 ? cycleSpan : k - prev;
      const at = (j: number) => (cycleSpan > 0 ? cum[j] - cum[prev] : j - prev);
      for (let j = prev + 1; j < k; j++) slots[j] = s0 + Math.round(((s1 - s0) * at(j)) / span);
    }
    prev = k;
  }
  if (prev >= 0) {
    for (let j = prev + 1; j < slots.length; j++) {
      slots[j] = Math.min(N - 1, slots[prev] + Math.round(cum[j] - cum[prev]));
    }
  }
  return { slots, matched };
}

export const buildColumns = (model: IProfileModel): IColumn[] => {
  const columns: IColumn[] = [];
  const duration = model.duration || 1;
  let graphIdCounter = 0;

  // Prefer DMA-grid-anchored positions (see buildSampleSlots) over the cycle-cost fallback below —
  // but only once at least one sample has actually matched a real fetch cell. `matched === 0`
  // means the grid has no CPU/CODE cells to anchor to at all (e.g. DMA tracking captured nothing
  // useful), so every column would otherwise collapse to the same interpolated position; the
  // cycle-cost estimate is strictly better than that.
  const dma = model.dma;
  const N = dma ? dma.owner.length : 0;
  const sampleSlots = dma && N && model.pcs.length ? buildSampleSlots(model.pcs, model.timeDeltas, dma) : undefined;
  const anchored = !!sampleSlots && sampleSlots.matched > 0;
  const slotX = (k: number): number =>
    k < sampleSlots!.slots.length ? sampleSlots!.slots[k] / N : 1;

  // 1. One column per instruction, deepest (leaf) frame at rows[bottom]. The leaf row's
  // `address` is overridden with model.pcs[i-1] — the exact PC for THIS sample — rather than
  // the spread location's own `address`, which is deduped per function (every sample sharing a
  // function shares one location object, frozen to whichever PC first created it; see pcs'
  // comment in shared/profilerTypes.ts). Needed for "what instruction is executing at x"
  // (the Disassembly view's time-cursor link) to be instruction-accurate, not just function-
  // accurate. Coalescing two adjacent same-function columns into one box (step 2 below) still
  // collapses to the run's first exact PC, the same approximation the box itself represents.
  let timeOffset = 0;
  for (let i = 1; i < model.samples.length; i++) {
    const leaf = model.nodes[model.samples[i]];
    const selfTime = model.timeDeltas[i - 1];
    const rows: (IColumnLocation | number)[] = [
      {
        ...model.locations[leaf.locationId],
        graphId: graphIdCounter++,
        filtered: true,
        selfTime,
        aggregateTime: 0,
        address: model.pcs?.[i - 1] ?? model.locations[leaf.locationId].address,
      },
    ];

    // Walk the parent chain up to (not including) the synthetic root (node 0,
    // falsy id), unshifting so the outermost frame ends up at rows[0].
    for (let id = leaf.parent; id; id = model.nodes[id].parent) {
      rows.unshift({
        ...model.locations[model.nodes[id].locationId],
        graphId: graphIdCounter++,
        filtered: true,
        selfTime: 0,
        aggregateTime: selfTime,
      });
    }

    const k = i - 1;
    const x1 = anchored ? slotX(k) : timeOffset / duration;
    const x2 = anchored ? slotX(k + 1) : (selfTime + timeOffset) / duration;
    columns.push({ x1, x2, rows });
    timeOffset += selfTime;
  }

  // 2. Merge adjacent columns sharing the same frame at a row (top-down, stopping
  //    at the first row that differs) so contiguous runs render as one wide box.
  for (let x = 1; x < columns.length; x++) {
    const col = columns[x];
    for (let y = 0; y < col.rows.length; y++) {
      const current = col.rows[y] as IColumnLocation;
      const prevOrNumber = columns[x - 1]?.rows[y];
      if (typeof prevOrNumber === "number") {
        if (current.id !== (columns[prevOrNumber].rows[y] as IColumnLocation).id) {
          break;
        }
        col.rows[y] = prevOrNumber;
      } else if (prevOrNumber?.id === current.id) {
        col.rows[y] = x - 1;
      } else {
        break;
      }

      const prev =
        typeof prevOrNumber === "number"
          ? (columns[prevOrNumber].rows[y] as ILocation)
          : prevOrNumber;
      prev.selfTime += current.selfTime;
      prev.aggregateTime += current.aggregateTime;
    }
  }

  return columns;
};

// Index of the column covering normalized x (0..1). Column x1/x2 boundaries are set once in
// buildColumns' first pass and never touched by its merge pass, so this index is NOT affected by
// run-coalescing — unlike resolving through `.rows` (see resolveStackAtX), which collapses an
// entire contiguous same-function run (e.g. every iteration of a hot loop) down to that run's
// first column. Use this directly against a per-sample array (model.pcs/timeDeltas) when you need
// the real value for THIS exact x, not whatever a flame box's merge happened to keep.
export function columnIndexAtX(columns: IColumn[], x: number): number {
  let col = binarySearch(columns, (c) => c.x2 - x);
  if (col < 0) col = -col - 1;
  return col;
}

// Inverse of columnIndexAtX(columns, (slot+0.5)/dmaSlots): given a column/sample index, find a
// DMA slot that maps back to (a column containing) it — used by the CPU Registers panel to turn
// a "jump to sample N" register-history result (see registerHistory.ts) back into a DMA-grid slot
// for onSelectSlot. Picks the slot at the column's left edge; any slot within [x1, x2) would do.
export function columnIndexToSlot(columns: IColumn[], idx: number, dmaSlots: number): number {
  if (columns.length === 0 || dmaSlots <= 0) return 0;
  const col = columns[Math.max(0, Math.min(idx, columns.length - 1))];
  // Use the column midpoint rather than left edge (x1): floor(x1*dmaSlots) can resolve back to
  // column idx-1 when x1 sits close to a slot boundary, breaking the round-trip. The midpoint is
  // safely inside [x1, x2) for any column whose width >= 1 DMA-slot (the common case), giving
  // columnIndexAtX((slot+0.5)/dmaSlots) == idx as required for cycling navigation to step forward.
  const mid = (col.x1 + col.x2) / 2;
  return Math.max(0, Math.min(dmaSlots - 1, Math.floor(mid * dmaSlots)));
}

// Scans samples forward (prev=false) or backward (prev=true) from `from`, wrapping around
// `count`, for the first index satisfying `matches`. Shared by the Disassembly view's "jump to
// next/previous execution of this instruction" (matches an exact PC) and the Time view's
// "jump to next/previous execution of this function" (matches a location id) — both cycle
// through every matching sample the same way.
export function findNextSample(
  count: number,
  from: number,
  prev: boolean,
  matches: (index: number) => boolean,
): number | undefined {
  for (let d = 1; d < count; d++) {
    const k = prev ? (from - d + count) % count : (from + d) % count;
    if (matches(k)) return k;
  }
  return undefined;
}

// Finds the DMA slot of the next execution (searching forward from currentSlot, wrapping) of
// any instruction on the given (file, line), for the "Jump to Next Execution in Profiler" editor
// context-menu command (see profilerLineDecorationProvider.ts / App.tsx's jumpToExecutionAtLine
// message handler). Matches by LINE — unlike DisassemblyView's exact-PC match or TimeView's
// location-id match — since a source line commonly compiles to several instructions and any of
// them executing counts as "this line ran". Returns undefined if there's no data for the line or
// the model lacks the DMA trace needed to search it. `isSameFile` lets the caller supply its own
// path-equality (the webview has no Node "path" module — see App.tsx's normalizePath).
//
// Returns the sample index alongside the slot, because a slot alone can't identify a sample: a
// zero-cost sample (68020+ lumped accounting — see buildSampleSlots) shares its slot with the
// neighbour that carried the lump, so mapping the slot back through columnIndexAtX would land on
// a different instruction than the one searched for. The caller keeps the slot as the shared
// cursor and uses sampleIdx for anything that needs THIS sample exactly.
export function findLineExecutionSlot(
  model: IProfileModel,
  file: string,
  line: number,
  currentSlot: number | undefined,
  isSameFile: (a: string, b: string) => boolean,
): { slot: number; sampleIdx: number } | undefined {
  const dmaSlots = model.dma?.owner.length;
  if (!model.pcs.length || !dmaSlots) return undefined;
  const addrs = new Set(
    (model.disassembly ?? [])
      .flatMap((fn) => fn.instructions)
      .filter((ins) => ins.file && ins.line === line && isSameFile(ins.file, file))
      .map((ins) => ins.address),
  );
  if (addrs.size === 0) return undefined;
  const columns = buildColumns(model);
  if (columns.length === 0) return undefined;
  const from = currentSlot !== undefined ? columnIndexAtX(columns, (currentSlot + 0.5) / dmaSlots) : -1;
  const k = findNextSample(model.pcs.length, from, false, (i) => addrs.has(model.pcs[i]));
  return k !== undefined ? { slot: columnIndexToSlot(columns, k, dmaSlots), sampleIdx: k } : undefined;
}

// Resolve the call stack (outermost→leaf) executing at normalized x (0..1) — the column covering
// x, its rows resolved through the "merged with column n" indirection. Shared by the DMA
// tooltip's call-stack line (FlameGraph's stackAtX, which maps this to function names — coalescing
// is fine there, a run IS one function the whole way through) and (for the function name only,
// not the address) the Disassembly view's function-selection. For the exact current instruction,
// use columnIndexAtX against model.pcs instead — see that function's comment for why.
export function resolveStackAtX(columns: IColumn[], x: number): IColumnLocation[] {
  const col = columnIndexAtX(columns, x);
  const column = columns[col];
  if (!column) return [];
  const stack: IColumnLocation[] = [];
  for (let y = 0; y < column.rows.length; y++) {
    let cell = column.rows[y];
    if (typeof cell === "number") cell = columns[cell].rows[y];
    if (cell !== undefined && typeof cell !== "number") stack.push(cell);
  }
  return stack;
}
