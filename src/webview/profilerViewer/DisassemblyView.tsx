import { useEffect, useMemo, useRef, useState } from "react";
import { List, ListImperativeAPI, RowComponentProps } from "react-window";
import { getProfileModel } from "./modelStore";
import { buildColumns, resolveStackAtX } from "./columns";
import { IDisassembledInstruction } from "../../shared/profilerTypes";

// Props shared across every row via the v2 rowProps channel (must not contain
// ariaAttributes/index/style — see TimeView.tsx).
type RowListProps = {
  instructions: IDisassembledInstruction[];
  maxCycles: number;
  currentAddress: number | undefined;
  onOpenSource: (file: string, line: number, toSide: boolean) => void;
};

function RowRenderer({ index, style, instructions, maxCycles, currentAddress, onOpenSource }: RowComponentProps<RowListProps>) {
  const ins = instructions[index];
  // Hot/cold tint: background alpha proportional to this instruction's share of the function's
  // hottest instruction (not the frame total) — keeps the heat map meaningful within a function
  // that's individually cold relative to the rest of the program.
  const heat = maxCycles > 0 ? ins.cycles / maxCycles : 0;
  return (
    <div
      className={"disasm-row" + (ins.address === currentAddress ? " disasm-current" : "")}
      style={{ ...style, background: heat > 0 ? `rgba(255,140,0,${(heat * 0.5).toFixed(3)})` : undefined }}
    >
      <span className="disasm-cycles">{ins.cycles > 0 ? ins.cycles : ""}</span>
      <span className="disasm-addr">${ins.address.toString(16).padStart(6, "0")}</span>
      <span className="disasm-hex">{ins.hex}</span>
      <span className="disasm-text">{ins.text}</span>
      {ins.file && (
        <a
          href="#"
          className="disasm-src"
          onClick={(e) => {
            e.preventDefault();
            onOpenSource(ins.file!, ins.line !== undefined && ins.line >= 0 ? ins.line + 1 : 1, e.altKey);
          }}
        >
          {ins.file.split(/[/\\]/).pop()}:{(ins.line ?? 0) + 1}
        </a>
      )}
    </div>
  );
}

// Per-instruction disassembly for every function that executed this frame, annotated with exact
// per-PC hit/cycle counts (this profiler traces every retired instruction — not statistical
// sampling), linked to the shared selectedSlot playhead and to source. The vscode-amiga-debug
// equivalent (objdump.tsx) parsed pre-built objdump text; we have no host-side disassembler, so
// the text/bytes/stats come from the live wasm session right after capture (profilerManager.ts's
// fetchDisassembly) — see model.disassembly. Jump-arrow visualization isn't ported.
export function DisassemblyView({
  selectedSlot,
  onOpenSource,
}: {
  selectedSlot: number | undefined;
  onOpenSource: (file: string, line: number, toSide: boolean) => void;
}) {
  const model = getProfileModel();
  const disassembly = model?.disassembly;
  const [selectedFn, setSelectedFn] = useState<number | undefined>(undefined); // index into `functions`
  const [follow, setFollow] = useState(true);
  const listRef = useRef<ListImperativeAPI>(null);

  // Functions sorted by total cycles descending (hottest first — matches the old extension's
  // "jump to the hottest function" default).
  const functions = useMemo(() => {
    if (!disassembly) return [];
    return [...disassembly]
      .map((fn) => ({ fn, totalCycles: fn.instructions.reduce((s, i) => s + i.cycles, 0) }))
      .sort((a, b) => b.totalCycles - a.totalCycles);
  }, [disassembly]);

  // The instruction executing at the selected DMA cycle, if any — drives "Follow execution".
  const columns = useMemo(() => (model ? buildColumns(model) : []), [model]);
  const dmaSlots = model?.dma?.owner.length;
  const currentAddress = useMemo(() => {
    if (selectedSlot === undefined || !dmaSlots) return undefined;
    const stack = resolveStackAtX(columns, (selectedSlot + 0.5) / dmaSlots);
    return stack[stack.length - 1]?.address;
  }, [columns, selectedSlot, dmaSlots]);

  // Which function (by index into `functions`) currentAddress falls within, if any.
  const currentFnIndex = useMemo(() => {
    if (currentAddress === undefined) return undefined;
    return functions.findIndex(({ fn }) => {
      const last = fn.instructions[fn.instructions.length - 1];
      return last && currentAddress >= fn.address && currentAddress <= last.address;
    });
  }, [functions, currentAddress]);

  // "Follow execution": jump the selected function to wherever the playhead currently is.
  // Adjusted during render (not an effect — see MemoryView's comment on react-hooks/set-state-in-
  // effect) by detecting the change against the last-seen address.
  const [lastFollowed, setLastFollowed] = useState<number | undefined>(undefined);
  if (follow && currentAddress !== lastFollowed) {
    setLastFollowed(currentAddress);
    if (currentFnIndex !== undefined && currentFnIndex >= 0) setSelectedFn(currentFnIndex);
  }

  const activeFnIndex = selectedFn !== undefined && selectedFn < functions.length ? selectedFn : 0;
  const active = functions[activeFnIndex];

  useEffect(() => {
    if (!active || currentAddress === undefined) return;
    const idx = active.fn.instructions.findIndex((i) => i.address === currentAddress);
    if (idx >= 0) listRef.current?.scrollToRow({ index: idx, align: "smart" });
  }, [active, currentAddress]);

  const maxCycles = useMemo(() => (active ? Math.max(0, ...active.fn.instructions.map((i) => i.cycles)) : 0), [active]);

  const rowProps = useMemo<RowListProps>(
    () => ({ instructions: active?.fn.instructions ?? [], maxCycles, currentAddress, onOpenSource }),
    [active, maxCycles, currentAddress, onOpenSource],
  );

  if (!model) return null;
  if (!disassembly || functions.length === 0) {
    return <div className="hint">No disassembly captured for this frame.</div>;
  }

  return (
    <div className="disassemblyview">
      <div className="disasm-toolbar">
        <select
          value={activeFnIndex}
          onChange={(e) => { setFollow(false); setSelectedFn(Number(e.target.value)); }}
        >
          {functions.map(({ fn, totalCycles }, i) => (
            <option key={fn.address} value={i}>
              {fn.name} ({totalCycles} cy)
            </option>
          ))}
        </select>
        <label className="disasm-follow">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Follow execution
        </label>
      </div>
      <div className="disasm-rows">
        <List
          listRef={listRef}
          rowComponent={RowRenderer}
          rowProps={rowProps}
          rowCount={active?.fn.instructions.length ?? 0}
          rowHeight={18}
        />
      </div>
    </div>
  );
}
