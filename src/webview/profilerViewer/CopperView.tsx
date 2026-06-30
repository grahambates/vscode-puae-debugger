import { useEffect, useMemo, useRef } from "react";
import { List, ListImperativeAPI, RowComponentProps } from "react-window";
import { getProfileModel } from "./modelStore";
import { disassembleCopperInstruction, CopperInstruction } from "../../shared/copperDisassembler";
import { DMA_HPOS } from "../../shared/profilerTypes";

interface CopperRow {
  slot: number; // DMA-grid cycle of this instruction's second-word fetch — the jump/highlight key
  insn: CopperInstruction;
}

// Props shared across every row via the v2 rowProps channel (must not contain
// ariaAttributes/index/style — see TimeView.tsx).
type RowListProps = {
  rows: CopperRow[];
  currentIndex: number;
  onJump: (slot: number) => void;
};

function RowRenderer({ index, style, rows, currentIndex, onJump }: RowComponentProps<RowListProps>) {
  const row = rows[index];
  if (!row) return null;
  const { insn } = row;
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
    </div>
  );
}

// Virtual list of the captured frame's executed copper instructions (the old vscode-amiga-debug
// debugger/copper.tsx, ported), linked to the shared time cursor: highlights whichever
// instruction is current at `selectedSlot` and auto-scrolls to it; clicking a row jumps the
// playhead there. Built from model.copper (PUAE's cop_record[] trace, see profilerTypes.ts).
export function CopperView({
  selectedSlot,
  onSelectSlot,
}: {
  selectedSlot: number | undefined;
  onSelectSlot: (slot: number) => void;
}) {
  const model = getProfileModel();
  const copper = model?.copper;
  const listRef = useRef<ListImperativeAPI>(null);

  const rows = useMemo<CopperRow[]>(() => {
    if (!copper) return [];
    const out: CopperRow[] = [];
    for (let i = 0; i < copper.addr.length; i++) {
      const slot = copper.vpos[i] * DMA_HPOS + copper.hpos[i];
      out.push({ slot, insn: disassembleCopperInstruction(copper.addr[i], copper.w1[i], copper.w2[i]) });
    }
    return out;
  }, [copper]);

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

  const rowProps = useMemo<RowListProps>(() => ({ rows, currentIndex, onJump: onSelectSlot }), [rows, currentIndex, onSelectSlot]);

  if (!model) return null;
  if (!copper || rows.length === 0) {
    return <div className="hint">No copper trace for this frame.</div>;
  }

  return (
    <div className="copperview">
      <List listRef={listRef} rowComponent={RowRenderer} rowProps={rowProps} rowCount={rows.length} rowHeight={20} />
    </div>
  );
}
