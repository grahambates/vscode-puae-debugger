// "Who touched it": every access to a memory range or custom register, or every change to a CPU
// register, during the frame (see accesses.ts), as one list, access by access. Shared by the
// Memory, Custom Registers and CPU views; a row click moves the shared timeline there, and
// the row at (or last before) the current position is highlighted and kept in view.

import { useEffect, useMemo, useRef, useState } from "react";
import { List, ListImperativeAPI, RowComponentProps } from "react-window";
import { accessListRows, AccessListRow, findAccesses, findRegisterChanges, readCodeFromListing, ReadCode, registerChangeRows, SourceAt } from "./accesses";
import { customRegisterName } from "../shared/customRegisters";
import { DMA_HPOS, IProfileModel } from "../../shared/profilerTypes";
import { Blit, getBlits } from "./blits";
import { createSourceLookup } from "./sourceLookup";

// The panel's height, shared by the views that show one and kept across remounts — resized by
// dragging its top edge.
let savedHeight = 220;
const MIN_HEIGHT = 80;

const pos = (slot: number) => `${Math.floor(slot / DMA_HPOS)}:${String(slot % DMA_HPOS).padStart(3, "0")}`;

type RowListProps = {
  rows: AccessListRow[];
  current: number;
  onSelect: (row: AccessListRow) => void;
  onOpenSource: (file: string, line: number, toSide: boolean) => void;
};

function Row({ index, style, rows, current, onSelect, onOpenSource }: RowComponentProps<RowListProps>) {
  const r = rows[index];
  if (!r) return null;
  return (
    <div className={"al-row" + (index === current ? " al-current" : "")} style={style} onClick={() => onSelect(r)}>
      <span className="al-pos">{pos(r.slot)}</span>
      {r.kind && <span className={"al-kind" + (r.kind.startsWith("W") ? " al-write" : "")}>{r.kind}</span>}
      <span className="al-value">{r.value}</span>
      {r.offset && <span className="al-offset">{r.offset}</span>}
      <span className="al-who" title={r.unverified ? "Placed by timing only — not checked against the instruction's operand (this frame has no register trace)" : undefined}>
        {r.who}{r.unverified ? " ~" : ""}
      </span>
      {r.detail && <span className="al-detail">{r.detail}</span>}
      {r.source && (
        <a
          href="#"
          className="al-source"
          title="Open source (Alt: to the side)"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation(); // opening the source isn't selecting the row
            onOpenSource(r.source!.file, r.source!.line, e.altKey);
          }}
        >
          {r.source.file.split(/[\\/]/).pop()}:{r.source.line}
        </a>
      )}
    </div>
  );
}

export function AccessList({
  title, note, rows, selectedSlot, onSelect, onOpenSource, onClose, empty,
}: {
  title: string;
  /** A caveat under the title (e.g. fast RAM isn't on the chip bus). */
  note?: string;
  rows: AccessListRow[];
  selectedSlot: number | undefined;
  onSelect: (row: AccessListRow) => void;
  onOpenSource: (file: string, line: number, toSide: boolean) => void;
  onClose: () => void;
  /** Shown instead of the list when there are no rows. */
  empty: string;
}) {
  const listRef = useRef<ListImperativeAPI>(null);
  const [height, setHeight] = useState(savedHeight);
  const drag = useRef<{ startY: number; startHeight: number; max: number } | undefined>(undefined);
  const onResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    // Leave the view above it some room, too.
    const container = e.currentTarget.parentElement?.parentElement;
    drag.current = { startY: e.clientY, startHeight: height, max: Math.max(MIN_HEIGHT, (container?.clientHeight ?? 600) - MIN_HEIGHT) };
  };
  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const next = Math.min(d.max, Math.max(MIN_HEIGHT, d.startHeight + d.startY - e.clientY));
    savedHeight = next;
    setHeight(next);
  };
  const onResizeEnd = () => { drag.current = undefined; };
  // The row at the current position, or the last one before it.
  const current = useMemo(() => {
    if (selectedSlot === undefined) return -1;
    let lo = 0, hi = rows.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].slot <= selectedSlot) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
  }, [rows, selectedSlot]);
  useEffect(() => {
    if (current >= 0) listRef.current?.scrollToRow({ index: current, align: "smart" });
  }, [current]);
  const rowProps = useMemo<RowListProps>(() => ({ rows, current, onSelect, onOpenSource }), [rows, current, onSelect, onOpenSource]);

  return (
    <div className="access-list" style={{ height }}>
      <div
        className="al-resize"
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onLostPointerCapture={onResizeEnd}
        title="Drag to resize"
      />
      <div className="al-title">
        <span className="al-title-text">
          {title}: {rows.length}
          {note && <span className="al-note"> — {note}</span>}
        </span>
        <button className="al-close codicon codicon-close" onClick={onClose} title="Close" aria-label="Close" />
      </div>
      {rows.length === 0 ? (
        <div className="hint">{empty}</div>
      ) : (
        <div className="al-rows">
          <List listRef={listRef} rowComponent={Row} rowProps={rowProps} rowCount={rows.length} rowHeight={18} overscanCount={10} />
        </div>
      )}
    </div>
  );
}

/** What the views need to describe accesses: code bytes, instruction text, source lines, blits. */
export function useAccessContext(model: IProfileModel | null | undefined): {
  readCode: ReadCode;
  instructionText: (pc: number) => string | undefined;
  sourceAt: SourceAt;
  blits: Blit[] | undefined;
} {
  return useMemo(() => {
    const texts = new Map<number, string>();
    for (const fn of model?.disassembly ?? []) {
      for (const ins of fn.instructions) texts.set(ins.address, ins.comment ? `${ins.text}  ; ${ins.comment}` : ins.text);
    }
    const lookup = createSourceLookup(model?.lineTable, model?.segments);
    const baseline = model?.dmaSnapshot?.atFrameStart ? model.dmaSnapshot.custom : undefined;
    return {
      readCode: model ? readCodeFromListing(model) : () => undefined,
      instructionText: (pc) => texts.get(pc),
      sourceAt: (address) => lookup(address),
      blits: model?.dma ? getBlits(model.dma, baseline).blits : undefined,
    };
  }, [model]);
}

type AccessContext = ReturnType<typeof useAccessContext>;

/** Accesses to [start, end) this frame, as rows. */
export function useMemoryAccesses(model: IProfileModel | null | undefined, ctx: AccessContext, target: { start: number; end: number } | undefined): AccessListRow[] {
  return useMemo(() => {
    if (!model || !target) return [];
    const accesses = findAccesses(model, target.start, target.end, ctx.readCode, ctx.blits);
    return accessListRows(model, accesses, target.start, ctx.instructionText, ctx.sourceAt, customRegisterName);
  }, [model, ctx, target]);
}

/** Changes to a CPU register (REG_COUNT index) this frame, as rows. */
export function useRegisterChanges(model: IProfileModel | null | undefined, ctx: AccessContext, reg: number | undefined): AccessListRow[] {
  return useMemo(() => {
    if (!model || reg === undefined) return [];
    return registerChangeRows(findRegisterChanges(model, reg, ctx.readCode), ctx.instructionText, ctx.sourceAt);
  }, [model, ctx, reg]);
}
