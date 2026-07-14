import { useEffect, useMemo, useRef } from "react";
import { List, ListImperativeAPI, RowComponentProps } from "react-window";
import { getProfileModel } from "./modelStore";
import { disassembleCopperInstruction, CopperInstruction } from "../../shared/copperDisassembler";
import { DMA_HPOS } from "../../shared/profilerTypes";
import { CUSTOM_REGISTER_OFFSETS as R } from "../shared/customRegisters";
import { createSourceLookup, SourceLocation } from "./sourceLookup";

interface CopperRow {
  slot: number; // DMA-grid cycle of this instruction's second-word fetch — the jump/highlight key
  insn: CopperInstruction;
  loc: SourceLocation | undefined; // where this instruction's data was declared, if known
}

// Props shared across every row via the v2 rowProps channel (must not contain
// ariaAttributes/index/style — see TimeView.tsx).
type RowListProps = {
  rows: CopperRow[];
  currentIndex: number;
  onJump: (slot: number) => void;
  onOpenSource: (file: string, line: number, toSide: boolean) => void;
};

function RowRenderer({ index, style, rows, currentIndex, onJump, onOpenSource }: RowComponentProps<RowListProps>) {
  const row = rows[index];
  if (!row) return null;
  const { insn, loc } = row;
  return (
    <div
      className={"cop-row" + (index === currentIndex ? " cop-current" : "")}
      style={style}
      onClick={() => onJump(row.slot)}
    >
      <span className="cop-addr">${insn.address.toString(16).padStart(6, "0")}</span>
      <span className="cop-pos">
        {Math.floor(row.slot / DMA_HPOS)},{row.slot % DMA_HPOS}
      </span>
      <span className="cop-insn">
        {insn.color && <span className="dma-dot" style={{ background: `rgb(${insn.color.join(",")})` }} />}
        <span className="cop-mnemonic">{insn.mnemonic}</span> {insn.operands}
      </span>
      {insn.comment && <span className="cop-comment">{insn.comment}</span>}
      {loc && (
        <a
          href="#"
          className="disasm-src"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation(); // don't also trigger the row's jump-to-slot click
            onOpenSource(loc.file, loc.line, e.altKey); // loc.line is already 1-based
          }}
        >
          {loc.file.split(/[/\\]/).pop()}:{loc.line}
        </a>
      )}
    </div>
  );
}

// Virtual list of the captured frame's executed copper instructions (the old vscode-amiga-debug
// debugger/copper.tsx, ported), linked to the shared time cursor: highlights whichever
// instruction is current at `selectedSlot` and auto-scrolls to it; clicking a row jumps the
// playhead there. Built from model.copper (PUAE's cop_record[] trace, see profilerTypes.ts).
// Each instruction's source location, if known, is resolved via model.lineTable (the program's
// full address->line table — see sourceLookup.ts; this is how the live PUAE webview's copper DMA
// overlay does click-to-source too, just resolved here from the embedded model instead of a live
// round trip, so it also works for a saved .puaeprofile) and shown as a clickable "file:line".
export function CopperView({
  selectedSlot,
  onSelectSlot,
  onOpenSource,
}: {
  selectedSlot: number | undefined;
  onSelectSlot: (slot: number) => void;
  onOpenSource: (file: string, line: number, toSide: boolean) => void;
}) {
  const model = getProfileModel();
  const copper = model?.copper;
  const listRef = useRef<ListImperativeAPI>(null);
  const sourceLookup = useMemo(() => createSourceLookup(model?.lineTable, model?.segments), [model]);

  const rows = useMemo<CopperRow[]>(() => {
    if (!copper) return [];
    const out: CopperRow[] = [];
    // Running BPLCON3 state (for an accurate AGA COLORxx swatch preview — see
    // disassembleCopperInstruction's doc comment), seeded from the capture-start snapshot and
    // advanced by the trace's own BPLCON3 writes as we walk it in execution order.
    let bplcon3 = model?.dmaSnapshot?.custom?.[R.BPLCON3 >> 1] ?? 0;
    for (let i = 0; i < copper.addr.length; i++) {
      // Clamp hpos to [0, DMA_HPOS-1]: cop_record stores raw hardware hpos which can reach
      // up to NR_DMA_REC_HPOS-1 = 287 (e.g. COP1JMP/COP2JMP strobes fired during HBlank).
      // Without clamping, slot = vpos*227 + hpos would overflow into the *next* line's slot
      // space, making slots non-monotonic and breaking the binary floor search for currentIndex
      // (the strobe appears to come *after* the first instruction of the restarted list).
      const hpos = Math.min(copper.hpos[i], DMA_HPOS - 1);
      const slot = copper.vpos[i] * DMA_HPOS + hpos;
      const insn = disassembleCopperInstruction(copper.addr[i], copper.w1[i], copper.w2[i], bplcon3);
      const w1 = copper.w1[i];
      if (!(w1 & 1) && (w1 & 0x1fe) === R.BPLCON3) bplcon3 = copper.w2[i];
      out.push({ slot, insn, loc: sourceLookup(insn.address) });
    }
    // Sort by slot as a safety net: should already be ordered post-clamp, but if any other
    // edge cases cause non-monotonicity the binary floor search for currentIndex requires it.
    out.sort((a, b) => a.slot - b.slot);
    return out;
  }, [copper, sourceLookup, model?.dmaSnapshot?.custom]);

  // Latest row whose slot is <= selectedSlot (rows are in execution order, so slot is
  // monotonically non-decreasing — binary search for the floor).
  const currentIndex = useMemo(() => {
    if (selectedSlot === undefined || rows.length === 0) return -1;
    let lo = 0;
    let hi = rows.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (rows[mid].slot <= selectedSlot) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return idx;
  }, [rows, selectedSlot]);

  useEffect(() => {
    if (currentIndex >= 0) listRef.current?.scrollToRow({ index: currentIndex, align: "smart" });
  }, [currentIndex]);

  const rowProps = useMemo<RowListProps>(
    () => ({ rows, currentIndex, onJump: onSelectSlot, onOpenSource }),
    [rows, currentIndex, onSelectSlot, onOpenSource],
  );

  if (!model) return null;
  if (!copper || rows.length === 0) {
    return <div className="hint">No copper trace for this frame.</div>;
  }

  const stepTo = (idx: number) => {
    if (idx >= 0 && idx < rows.length) onSelectSlot(rows[idx].slot);
  };

  return (
    <div className="copperview">
      <div className="cop-toolbar">
        <span className="cr-nav">
          <button
            onClick={() => stepTo(currentIndex > 0 ? currentIndex - 1 : 0)}
            disabled={currentIndex <= 0}
            title="Previous copper instruction"
          >◀</button>
          <button
            onClick={() => stepTo(currentIndex < 0 ? 0 : currentIndex + 1)}
            disabled={currentIndex >= rows.length - 1}
            title="Next copper instruction"
          >▶</button>
        </span>
        <span className="cop-toolbar-pos">
          {currentIndex >= 0 ? `${currentIndex + 1} / ${rows.length}` : `— / ${rows.length}`}
        </span>
      </div>
      <List listRef={listRef} rowComponent={RowRenderer} rowProps={rowProps} rowCount={rows.length} rowHeight={20} />
    </div>
  );
}
