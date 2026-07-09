// Top-down function table — ported from vscode-amiga-debug `table/time-view.tsx`.
// Preact → React; preact-virtual-list → react-window v2 List (fixed rowHeight=20 for perf);
// shrinkler columns dropped; SVG icons replaced with Unicode chevrons;
// VsCodeApi.postMessage replaced with onOpenSource prop.

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { List, ListImperativeAPI, RowComponentProps } from "react-window";
import { IGraphNode } from "./topDownGraph";
import { compileFilter, IRichFilter } from "./filter";
import { dataName, DisplayUnit, formatValue, Timing } from "./display";
import { getProfileModel } from "./modelStore";
import { buildColumns, columnIndexAtX, columnIndexToSlot, findNextSample } from "./columns";

enum SortFn { Self, Agg }

interface NodeAtDepth { node: IGraphNode; depth: number; position: number }

// Props shared across every row via the v2 rowProps channel.
// Must NOT contain ariaAttributes, index, or style (react-window v2 constraint).
type RowListProps = {
  rows: NodeAtDepth[];
  expanded: ReadonlySet<IGraphNode>;
  onExpandChange: React.Dispatch<React.SetStateAction<ReadonlySet<IGraphNode>>>;
  onKeyDown: (e: React.KeyboardEvent, node: IGraphNode) => void;
  onFocus: (node: IGraphNode) => void;
  displayUnit: DisplayUnit;
  timing: Timing;
  onOpenSource: (file: string, line: number, toSide: boolean) => void;
  hideTotalTime: boolean;
  // Jump to the next (or Shift: previous) execution of the clicked function in the timeline,
  // and switch to the CPU tab. undefined if the trace data needed to do this isn't available
  // (mirrors DisassemblyView's onJumpToExecution).
  onJumpToExecution: ((locationId: number, prev: boolean) => void) | undefined;
};

const getGlobalUniqueId = (node: IGraphNode): string => {
  const parts = [node.id];
  for (let n = node.parent as IGraphNode | undefined; n; n = n.parent) parts.push(n.id);
  return parts.join("-");
};

const getSortedChildren = (node: IGraphNode, sortFn: SortFn): IGraphNode[] => {
  const children = Object.values(node.children) as IGraphNode[];
  if (sortFn === SortFn.Agg) children.sort((a, b) => b.aggregateTime - a.aggregateTime);
  else children.sort((a, b) => b.selfTime - a.selfTime);
  return children;
};

// Defined outside TimeView so the reference is stable across renders (v2 memoises by rowComponent identity).
// v2 injects ariaAttributes (listitem role) but our rows use treeitem — we don't spread it.
function RowRenderer({ index, style, rows, expanded, onExpandChange, onKeyDown, onFocus, displayUnit, timing, onOpenSource, hideTotalTime, onJumpToExecution }: RowComponentProps<RowListProps>) {
  const row = rows[index];
  if (!row) return null;
  const { node, depth, position } = row;
  return (
    <TimeViewRow
      key={getGlobalUniqueId(node)}
      node={node}
      depth={depth}
      position={position}
      expanded={expanded}
      onExpandChange={onExpandChange}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      displayUnit={displayUnit}
      timing={timing}
      onOpenSource={onOpenSource}
      hideTotalTime={hideTotalTime}
      onJumpToExecution={onJumpToExecution}
      style={style}
    />
  );
}

export function TimeView({
  data,
  filter,
  displayUnit,
  timing,
  onOpenSource,
  hideTotalTime = false,
  selectedSlot,
  onSelectSlot,
  onOpenCpuTab,
}: {
  data: readonly IGraphNode[];
  filter: IRichFilter;
  displayUnit: DisplayUnit;
  timing: Timing;
  onOpenSource: (file: string, line: number, toSide: boolean) => void;
  hideTotalTime?: boolean;
  selectedSlot: number | undefined;
  onSelectSlot: (slot: number) => void;
  onOpenCpuTab: () => void;
}) {
  // v2 ListImperativeAPI: scrollToRow({index, align}) — v2 auto-sizes the container via CSS.
  const listRef = useRef<ListImperativeAPI>(null);
  const [sortFn, setSortFn] = useState<SortFn>(SortFn.Agg);
  const [focused, setFocused] = useState<IGraphNode | undefined>(undefined);
  const [expanded, setExpanded] = useState<ReadonlySet<IGraphNode>>(new Set());
  // Filter: mutate node.filtered and derive filterExpanded in one pass so rendered/visibleRows
  // recompute in the same render (no setState lag).
  const filterExpanded = useMemo(() => {
    if (!filter.text.trim()) {
      const clearNode = (node: IGraphNode) => {
        node.filtered = true;
        for (const c of Object.values(node.children) as IGraphNode[]) clearNode(c);
      };
      for (const c of data) clearNode(c);
      return new Set<IGraphNode>();
    }

    const filterFn = compileFilter(filter);
    const newExpanded = new Set<IGraphNode>([...expanded]);

    const filterNode = (node: IGraphNode) => {
      node.filtered = filterFn(node.callFrame.functionName) || (!!node.callFrame.url && filterFn(node.callFrame.url));
      if (node.filtered) {
        for (let p = node.parent as IGraphNode | undefined; p; p = p.parent) {
          if (!p.filtered) newExpanded.add(p);
        }
      }
      for (const c of Object.values(node.children) as IGraphNode[]) filterNode(c);
    };

    for (const c of data) filterNode(c);
    return newExpanded;
  }, [data, filter, expanded]);

  // Sorted top-level list.
  const sorted = useMemo(() => {
    const s = data.slice();
    if (sortFn === SortFn.Agg) s.sort((a, b) => b.aggregateTime - a.aggregateTime);
    else s.sort((a, b) => b.selfTime - a.selfTime);
    return s;
  }, [data, sortFn]);

  // Flat visible list: expand nodes that are in expanded ∪ filterExpanded.
  const rendered = useMemo(() => {
    const output: NodeAtDepth[] = sorted.map((node) => ({ node, position: 1, depth: 0 }));
    for (let i = 0; i < output.length; i++) {
      const { node, depth } = output[i];
      if (expanded.has(node) || filterExpanded.has(node)) {
        const toAdd = getSortedChildren(node, sortFn).map((child, idx) => ({
          node: child, position: idx + 1, depth: depth + 1,
        }));
        output.splice(i + 1, 0, ...toAdd);
      }
    }
    return output;
  }, [sorted, expanded, filterExpanded, sortFn]);

  // Visible rows only (filter-hidden nodes are excluded from the virtual list).
  const visibleRows = useMemo(
    () => rendered.filter((n) => n.node.filtered || expanded.has(n.node) || filterExpanded.has(n.node)),
    [rendered, expanded, filterExpanded],
  );

  // Scroll focused row into view.
  useLayoutEffect(() => {
    if (!focused) return;
    const idx = visibleRows.findIndex((r) => r.node === focused);
    if (idx >= 0) listRef.current?.scrollToRow({ index: idx, align: "smart" });
  }, [focused, visibleRows]);

  const onKeyDown = useCallback(
    (evt: React.KeyboardEvent, node: IGraphNode) => {
      let nextFocus: IGraphNode | undefined;
      switch (evt.key) {
        case "Enter":
        case " ":
          setExpanded((prev) => toggleInSet(prev, node));
          evt.preventDefault();
          return;
        case "ArrowDown":
          nextFocus = visibleRows[visibleRows.findIndex((n) => n.node === node) + 1]?.node;
          break;
        case "ArrowUp":
          nextFocus = visibleRows[visibleRows.findIndex((n) => n.node === node) - 1]?.node;
          break;
        case "ArrowLeft":
          if (expanded.has(node)) {
            setExpanded((prev) => removeFromSet(prev, node));
          } else {
            nextFocus = node.parent as IGraphNode | undefined;
          }
          break;
        case "ArrowRight":
          if (node.childrenSize > 0 && !expanded.has(node)) {
            setExpanded((prev) => addToSet(prev, node));
          } else {
            nextFocus = visibleRows.find((n) => n.node.parent === node)?.node;
          }
          break;
        case "Home":
          listRef.current?.scrollToRow({ index: 0 });
          nextFocus = visibleRows[0]?.node;
          break;
        case "End":
          listRef.current?.scrollToRow({ index: visibleRows.length - 1 });
          nextFocus = visibleRows[visibleRows.length - 1]?.node;
          break;
        case "*": {
          const siblings = Object.values(focused?.parent?.children ?? {}) as IGraphNode[];
          setExpanded((prev) => { const s = new Set(prev); siblings.forEach((c) => s.add(c)); return s; });
          break;
        }
        default: return;
      }
      if (nextFocus) { setFocused(nextFocus); evt.preventDefault(); }
    },
    [visibleRows, expanded, focused],
  );

  // "Jump to next/previous execution of this function" (a function name click) — the Time
  // View's counterpart to DisassemblyView's per-instruction version, matching by location id
  // (any leaf execution of this exact function, anywhere in the tree) instead of an exact PC.
  // See findNextSample's comment for why the two share the scan; the model/columns/currentIdx
  // setup here directly mirrors DisassemblyView's own (kept local rather than lifted into
  // App.tsx — the extra buildColumns() call is cheap and memoised per model change).
  const model = getProfileModel();
  const columns = useMemo(() => (model ? buildColumns(model) : []), [model]);
  const dmaSlots = model?.dma?.owner.length;
  const currentIdx = useMemo(() => {
    if (selectedSlot === undefined || !dmaSlots || !model?.pcs.length) return undefined;
    return columnIndexAtX(columns, (selectedSlot + 0.5) / dmaSlots);
  }, [columns, selectedSlot, dmaSlots, model]);

  const jumpToExecution = useMemo(() => {
    if (!model?.pcs.length || !dmaSlots || columns.length === 0) return undefined;
    return (locationId: number, prev: boolean) => {
      const count = model.pcs.length;
      const from = currentIdx ?? (prev ? count - 1 : -1);
      // samples[i+1] pairs with pcs[i] (samples[0] is a dummy — see shared/profilerTypes.ts).
      const k = findNextSample(count, from, prev, (i) => model.nodes[model.samples[i + 1]].locationId === locationId);
      if (k !== undefined) {
        onSelectSlot(columnIndexToSlot(columns, k, dmaSlots));
        onOpenCpuTab();
      }
    };
  }, [model, currentIdx, columns, dmaSlots, onSelectSlot, onOpenCpuTab]);

  // Stable rowProps object — v2 re-renders rows only when this changes.
  const rowListProps = useMemo<RowListProps>(() => ({
    rows: visibleRows,
    expanded,
    onExpandChange: setExpanded,
    onKeyDown,
    onFocus: setFocused,
    displayUnit,
    timing,
    onOpenSource,
    hideTotalTime,
    onJumpToExecution: jumpToExecution,
  }), [visibleRows, expanded, onKeyDown, displayUnit, timing, onOpenSource, hideTotalTime, jumpToExecution]);

  return (
    <div className="time-view">
      <TimeViewHeader sortFn={sortFn} onChangeSort={setSortFn} displayUnit={displayUnit} hideTotalTime={hideTotalTime} />
      <div className="tv-rows">
        <List
          listRef={listRef}
          rowComponent={RowRenderer}
          rowProps={rowListProps}
          rowCount={visibleRows.length}
          rowHeight={20}
          overscanCount={10}
        />
      </div>
    </div>
  );
}

function TimeViewHeader({
  sortFn, onChangeSort, displayUnit, hideTotalTime,
}: { sortFn: SortFn; onChangeSort: (fn: SortFn) => void; displayUnit: DisplayUnit; hideTotalTime: boolean }) {
  return (
    <div className="tv-row tv-header">
      <div
        id="tv-self-header"
        className={"tv-duration tv-heading" + (sortFn === SortFn.Self || hideTotalTime ? " tv-sorted" : "")}
        onClick={() => !hideTotalTime && onChangeSort(sortFn === SortFn.Self ? SortFn.Agg : SortFn.Self)}
        style={hideTotalTime ? { cursor: "default" } : undefined}
      >
        {(sortFn === SortFn.Self || hideTotalTime) && <span className="codicon codicon-chevron-down" />}Self {dataName(displayUnit)}
      </div>
      {!hideTotalTime && (
        <div
          id="tv-total-header"
          className={"tv-duration tv-heading" + (sortFn === SortFn.Agg ? " tv-sorted" : "")}
          onClick={() => onChangeSort(sortFn === SortFn.Agg ? SortFn.Self : SortFn.Agg)}
        >
          {sortFn === SortFn.Agg && <span className="codicon codicon-chevron-down" />}Total {dataName(displayUnit)}
        </div>
      )}
      <div className="tv-location tv-heading">File</div>
    </div>
  );
}

function TimeViewRow({
  node, depth, position, expanded, onExpandChange, onKeyDown: onKeyDownRaw,
  onFocus: onFocusRaw, displayUnit, timing, onOpenSource, hideTotalTime, onJumpToExecution, style,
}: {
  node: IGraphNode; depth: number; position: number;
  expanded: ReadonlySet<IGraphNode>; onExpandChange: React.Dispatch<React.SetStateAction<ReadonlySet<IGraphNode>>>;
  onKeyDown: (e: React.KeyboardEvent, node: IGraphNode) => void;
  onFocus: (node: IGraphNode) => void;
  displayUnit: DisplayUnit; timing: Timing;
  onOpenSource: (file: string, line: number, toSide: boolean) => void;
  hideTotalTime: boolean;
  onJumpToExecution: ((locationId: number, prev: boolean) => void) | undefined;
  style: React.CSSProperties;
}) {
  // Basename only, not the full absolute path — matches DisassemblyView/CopperView's convention.
  const location = node.callFrame.url
    ? `${node.callFrame.url.split(/[/\\]/).pop()}${node.callFrame.lineNumber >= 0 ? `:${node.callFrame.lineNumber}` : ""}`
    : undefined;

  const onClickFile = (e: React.MouseEvent) => {
    e.preventDefault();
    // lineNumber is already 1-based (raw SourceMap.lookupAddress().line), matching what
    // openProfilerSource expects. Normalize unknown (-1) to 1.
    if (node.callFrame.url) onOpenSource(node.callFrame.url, node.callFrame.lineNumber >= 0 ? node.callFrame.lineNumber : 1, e.altKey);
  };

  // Only real functions (a genuine ILocation, id >= 0) are jumpable — synthetic rows (the
  // "(root)" node id -1, and topDownGraph's synthetic DMA/group rows, ids <= -1000) don't
  // correspond to any single instruction execution.
  const canJump = onJumpToExecution !== undefined && node.id >= 0;
  const onClickFn = (e: React.MouseEvent) => {
    e.stopPropagation();
    onJumpToExecution!(node.id, e.shiftKey);
  };

  const onToggleExpand = (e: React.MouseEvent) => {
    if (e.shiftKey) {
      onExpandChange((prev) => {
        const next = new Set(prev);
        if (prev.has(node)) {
          const collapse = (n: IGraphNode) => {
            for (const c of Object.values(n.children) as IGraphNode[]) { next.delete(c); collapse(c); }
          };
          next.delete(node); collapse(node);
        } else {
          const expand = (n: IGraphNode) => {
            for (const c of Object.values(n.children) as IGraphNode[]) { next.add(c); expand(c); }
          };
          next.add(node); expand(node);
        }
        return next;
      });
    } else {
      onExpandChange((prev) => toggleInSet(prev, node));
    }
  };

  const rootAgg = timing.duration || 1;
  return (
    <div
      className="tv-row"
      style={{ ...style, opacity: node.filtered ? 1 : 0.5 }}
      data-row-id={getGlobalUniqueId(node)}
      tabIndex={0}
      role="treeitem"
      aria-posinset={position}
      aria-setsize={node.parent?.childrenSize ?? 1}
      aria-level={depth + 1}
      aria-expanded={node.childrenSize > 0 ? expanded.has(node) : undefined}
      onKeyDown={(e) => onKeyDownRaw(e, node)}
      onFocus={() => onFocusRaw(node)}
    >
      <div className="tv-duration" aria-labelledby="tv-self-header">
        <ImpactBar impact={node.selfTime / rootAgg} />
        <span>{formatValue(node.selfTime, displayUnit, timing)}</span>
      </div>
      {!hideTotalTime && (
        <div className="tv-duration" aria-labelledby="tv-total-header">
          <ImpactBar impact={node.aggregateTime / rootAgg} />
          <span>{formatValue(node.aggregateTime, displayUnit, timing)}</span>
        </div>
      )}
      <div className="tv-location" style={{ paddingLeft: depth * 15 + 10 }}>
        <span className="tv-expander" onClick={onToggleExpand} onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); }}>
          {node.childrenSize > 0
            ? <span className={`codicon codicon-chevron-${expanded.has(node) ? "down" : "right"}`} />
            : null}
        </span>
        {node.dmaColor && <span className="dma-dot" style={{ background: node.dmaColor }} />}
        <span
          className={"tv-fn" + (canJump ? " tv-fn-clickable" : "")}
          onClick={canJump ? onClickFn : undefined}
          title={canJump ? "Click: next execution · Shift+Click: previous execution (opens CPU tab)" : undefined}
        >
          {node.callFrame.functionName}
        </span>
        {location && (
          <span className="tv-file">
            <a href="#" onClick={onClickFile}>{location}</a>
          </span>
        )}
      </div>
    </div>
  );
}

function ImpactBar({ impact }: { impact: number }) {
  return <div className="tv-impact-bar" style={{ transform: `scaleX(${Math.min(1, impact)})` }} />;
}

// Minimal set helpers (ported from old extension's array.ts).
function addToSet<T>(set: ReadonlySet<T>, item: T): ReadonlySet<T> {
  const next = new Set(set); next.add(item); return next;
}
function removeFromSet<T>(set: ReadonlySet<T>, item: T): ReadonlySet<T> {
  const next = new Set(set); next.delete(item); return next;
}
function toggleInSet<T>(set: ReadonlySet<T>, item: T): ReadonlySet<T> {
  return set.has(item) ? removeFromSet(set, item) : addToSet(set, item);
}
