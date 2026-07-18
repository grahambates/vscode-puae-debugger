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

// Cells to search ahead (in the DMA grid) before giving up on matching a given sample's fetch —
// bounded so a genuinely unmatchable sample (see below) can't turn this into an O(samples * N)
// scan; a real fetch, when there is one, shows up within a handful of cells of the previous match.
const CODE_MATCH_WINDOW = 512;

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

function buildSampleSlots(pcs: readonly number[], dma: IDmaModel): { slots: Int32Array; matched: number } {
  const { owner, flags, addr } = dma;
  const N = owner.length;
  const slots = new Int32Array(pcs.length).fill(-1);

  const findUnbounded = (pc: number): number => {
    let j = 0;
    while (j < N && !(owner[j] === BusOwner.CPU && flags[j] & DMA_CODE && addr[j] === pc)) j++;
    return j < N ? j : -1;
  };

  // Find the true starting anchor by checking the first few samples' addresses (each via an
  // unbounded scan — paid once per capture, negligible cost) and picking whichever yields the
  // EARLIEST grid position. A same-loop revisit of an earlier sample's address always resolves to
  // a LATER position than whichever sample genuinely executes first, so the minimum is correct —
  // this is what makes the fix robust without needing to special-case "sample 0 specifically".
  // A genuinely large gap before the first in-program instruction (interrupts/OS/Kickstart init —
  // see the header comment) still works: every early sample's earliest occurrence clusters around
  // that same real start, so the minimum still lands there.
  let anchorK = -1;
  let anchorSlot = -1;
  for (let k = 0; k < Math.min(ANCHOR_CANDIDATES, pcs.length); k++) {
    const j = findUnbounded(pcs[k]);
    if (j >= 0 && (anchorSlot < 0 || j < anchorSlot)) {
      anchorSlot = j;
      anchorK = k;
    }
  }

  let cell = 0;
  let matched = 0;
  let startK = 0;
  if (anchorK >= 0) {
    slots[anchorK] = anchorSlot;
    cell = anchorSlot + 1;
    matched = 1;
    startK = anchorK + 1;
    // Samples before the anchor never got a matchable fetch cell (that's the whole point of
    // picking the earliest candidate) — left unmatched, they're interpolated/clamped to the
    // anchor below, same as any other unmatched run.
  }
  for (let k = startK; k < pcs.length; k++) {
    const pc = pcs[k];
    // Bounded: steady-state gaps between consecutive samples are small (see the header comment);
    // a real fetch, when there is one, shows up within a handful of cells of the previous match.
    const limit = Math.min(N, cell + CODE_MATCH_WINDOW);
    let j = cell;
    while (j < limit && !(owner[j] === BusOwner.CPU && flags[j] & DMA_CODE && addr[j] === pc)) j++;
    if (j < limit) {
      slots[k] = j;
      cell = j + 1;
      matched++;
    }
    // else: leave unmatched (-1); `cell` stays put so the next sample can still match nearby —
    // this one just consumed no grid cell.
  }

  // Fill unmatched runs by interpolating between the nearest matched neighbours (linear in sample
  // index, which is what buildColumns needs — a straight line between two known points). A run
  // before the first match or after the last has no far endpoint to interpolate towards, so it
  // clamps to the nearest match instead of extrapolating off the grid.
  let prev = -1;
  for (let k = 0; k < slots.length; k++) {
    if (slots[k] < 0) continue;
    if (prev < 0) {
      for (let j = 0; j < k; j++) slots[j] = slots[k];
    } else if (k - prev > 1) {
      const s0 = slots[prev];
      const s1 = slots[k];
      const span = k - prev;
      for (let j = prev + 1; j < k; j++) slots[j] = s0 + Math.round(((s1 - s0) * (j - prev)) / span);
    }
    prev = k;
  }
  if (prev >= 0) {
    for (let j = prev + 1; j < slots.length; j++) slots[j] = slots[prev];
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
  const sampleSlots = dma && N && model.pcs.length ? buildSampleSlots(model.pcs, dma) : undefined;
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
export function findLineExecutionSlot(
  model: IProfileModel,
  file: string,
  line: number,
  currentSlot: number | undefined,
  isSameFile: (a: string, b: string) => boolean,
): number | undefined {
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
  return k !== undefined ? columnIndexToSlot(columns, k, dmaSlots) : undefined;
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
