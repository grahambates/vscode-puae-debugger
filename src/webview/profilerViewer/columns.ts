// Time-ordered column model for the flame chart. Ported from the old
// vscode-amiga-debug `flame/stacks.tsx` (`buildColumns`), adapted to our shared
// IProfileModel types (no devtools-protocol / Cdp dependency). Pure + testable.
//
// One column per captured instruction (in execution order); each column's `rows`
// holds the call stack outermost-first. Adjacent columns with an identical frame at
// a given row are coalesced: a numeric cell `n` means "merge with the cell at column
// n, same row", which is how runs of the same function become a single wide box.

import { IProfileModel, ILocation } from "../../shared/profilerTypes";

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

  // 1. One column per instruction, deepest (leaf) frame at rows[bottom].
  let timeOffset = 0;
  for (let i = 1; i < model.samples.length; i++) {
    const leaf = model.nodes[model.samples[i]];
    const selfTime = model.timeDeltas[i - 1];
    const rows: (IColumnLocation | number)[] = [
      { ...model.locations[leaf.locationId], graphId: graphIdCounter++, filtered: true, selfTime, aggregateTime: 0 },
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
