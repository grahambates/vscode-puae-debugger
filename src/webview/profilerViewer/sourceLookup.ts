// Resolves an arbitrary memory address to a source file/line, for "jump to source" features
// across the profiler (Memory View's Ctrl/Cmd+click, Copper View's source link, ...). Backed by
// model.lineTable — the program's full address->line table (SourceMap.getLineTable(), every
// address transition the assembler/compiler's line info covers, code AND data, e.g. a copper
// list's `dc.w` lines) — floor-searched the same way SourceMap.lookupAddress does host-side,
// bounded by model.segments so a floor match doesn't cross into a different (or unloaded) segment.
// An address outside any loaded segment, or past the last line-table entry in its segment,
// resolves to undefined, i.e. "not applicable" — not every byte has a source location.

import { ILineTableEntry, ISegmentRange } from "../../shared/profilerTypes";

export interface SourceLocation {
  file: string;
  line: number; // 1-based — pass directly to onOpenSource, no +1 (see ProfileFrame.line)
}

export type SourceLookup = (addr: number) => SourceLocation | undefined;

function findSegment(segments: readonly ISegmentRange[], addr: number): ISegmentRange | undefined {
  return segments.find((s) => s.address <= addr && s.address + s.size > addr);
}

export function createSourceLookup(
  lineTable: readonly ILineTableEntry[] | undefined,
  segments: readonly ISegmentRange[] | undefined,
): SourceLookup {
  if (!lineTable || lineTable.length === 0) return () => undefined;

  const sorted = [...lineTable].sort((a, b) => a.address - b.address);
  const addrs = Int32Array.from(sorted, (e) => e.address | 0);
  const segs = segments ?? [];

  return (addr: number): SourceLocation | undefined => {
    const a = addr >>> 0;

    // Binary floor search: the largest line-table address <= a.
    let lo = 0;
    let hi = addrs.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if ((addrs[mid] >>> 0) <= a) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (idx < 0) return undefined;
    const entry = sorted[idx];
    const floorAddr = entry.address >>> 0;
    if (a === floorAddr) return { file: entry.file, line: entry.line };

    // Mirrors SourceMap.lookupAddress: a non-exact floor match only counts if `a` and the floor
    // entry fall in the same loaded segment (guards against addresses in a gap between segments,
    // or past the last entry's segment, incorrectly inheriting a far-away preceding line).
    const curSeg = findSegment(segs, a);
    if (curSeg === undefined || curSeg !== findSegment(segs, floorAddr)) return undefined;
    return { file: entry.file, line: entry.line };
  };
}
