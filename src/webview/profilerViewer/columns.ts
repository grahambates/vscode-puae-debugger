// Time-ordered column model for the flame chart. Ported from the old
// vscode-amiga-debug `flame/stacks.tsx` (`buildColumns`), adapted to our shared
// IProfileModel types (no devtools-protocol / Cdp dependency). Pure + testable.
//
// One column per captured instruction (in execution order); each column's `rows`
// holds the call stack outermost-first. Adjacent columns with an identical frame at
// a given row are coalesced: a numeric cell `n` means "merge with the cell at column
// n, same row", which is how runs of the same function become a single wide box.

import { IProfileModel, ILocation } from "../../shared/profilerTypes";
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

export const buildColumns = (model: IProfileModel): IColumn[] => {
  const columns: IColumn[] = [];
  const duration = model.duration || 1;
  let graphIdCounter = 0;

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

    columns.push({ x1: timeOffset / duration, x2: (selfTime + timeOffset) / duration, rows });
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
