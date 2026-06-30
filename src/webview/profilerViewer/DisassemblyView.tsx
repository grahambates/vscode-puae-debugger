import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { List, ListImperativeAPI, RowComponentProps } from "react-window";
import { getProfileModel } from "./modelStore";
import { buildColumns, columnIndexAtX } from "./columns";
import { IDisassembledInstruction, REG_COUNT, REG_D0, REG_A0, REG_SR, REG_PC, REG_USP } from "../../shared/profilerTypes";
import { srFlags } from "../shared/cpuFlags";
import { createSymbolizer, Symbolizer } from "./symbols";
import { interpretDataReg, interpretAddressReg } from "./registerInterpret";
import { Tooltip } from "./Tooltip";

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
      <span className="disasm-hits" title="Executions this frame">{ins.hits > 0 ? `${ins.hits}×` : ""}</span>
      <span className="disasm-cycles" title="Total cycles this frame">{ins.cycles > 0 ? `${ins.cycles}cy` : ""}</span>
      <span className="disasm-addr">${ins.address.toString(16).padStart(6, "0")}</span>
      <span className="disasm-hex">{ins.hex}</span>
      <span className="disasm-text">{ins.text}</span>
      {ins.file && (
        <a
          href="#"
          className="disasm-src"
          onClick={(e) => {
            e.preventDefault();
            // ins.line is already 1-based (raw SourceMap.lookupAddress().line), matching what
            // onOpenSource expects. Normalize unknown (undefined/-1) to 1.
            onOpenSource(ins.file!, ins.line !== undefined && ins.line >= 0 ? ins.line : 1, e.altKey);
          }}
        >
          {ins.file.split(/[/\\]/).pop()}:{ins.line ?? 1}
        </a>
      )}
    </div>
  );
}

const hex = (v: number, digits = 8) => `$${(v >>> 0).toString(16).padStart(digits, "0")}`;

type RegKind = "data" | "address";
type RegHover = { kind: RegKind; value: number; x: number; y: number };

// D0-D7/A0-A7/SR/PC/USP at the current sample, with changed-since-the-previous-sample highlighted
// (mirroring Custom Registers' changed-this-cycle highlight). `regs`/`prev` are REG_COUNT-length
// slices of model.registers (see shared/profilerTypes.ts's REG_* layout) — `prev` is undefined at
// the very first sample (nothing to diff against). Hovering a register shows a tooltip with its
// value interpreted at every width (the same i8/u8/i16/u16/i32/u32 breakdown the live Variables
// view shows as expandable child items — see registerInterpret.ts) — a tooltip rather than
// expandable rows, since this panel isn't a tree view. Address-like registers (A0-A7, PC, USP)
// skip the byte-sized interpretations (no byte-sized address arithmetic on the 68000) and get a
// symbol+offset line instead, when the value resolves to one. The register name itself isn't
// repeated in the tooltip (already shown on the cell being hovered).
function RegistersPanel({ regs, prev, symbolize }: { regs: Uint32Array; prev: Uint32Array | undefined; symbolize: Symbolizer }) {
  const [hover, setHover] = useState<RegHover | undefined>(undefined);
  const changed = (i: number) => prev !== undefined && regs[i] !== prev[i];
  const onEnter = (kind: RegKind, i: number) => (e: { clientX: number; clientY: number }) =>
    setHover({ kind, value: regs[i], x: e.clientX, y: e.clientY });
  const onLeave = () => setHover(undefined);

  const cell = (label: string, i: number, kind: RegKind, digits = 8) => (
    <div
      key={label}
      className={"reg-cell" + (changed(i) ? " reg-changed" : "") + " reg-hoverable"}
      onMouseEnter={onEnter(kind, i)}
      onMouseLeave={onLeave}
    >
      <span className="reg-label">{label}</span>
      <span className="reg-val">{hex(regs[i], digits)}</span>
    </div>
  );

  const interp = hover ? (hover.kind === "data" ? interpretDataReg(hover.value) : interpretAddressReg(hover.value)) : undefined;
  const offset = hover && hover.kind === "address" ? symbolize(hover.value) : undefined;

  return (
    <div className="registerspanel">
      <div className="reg-grid">
        {Array.from({ length: 8 }, (_, n) => cell(`D${n}`, REG_D0 + n, "data"))}
        {Array.from({ length: 8 }, (_, n) => cell(`A${n}`, REG_A0 + n, "address"))}
      </div>
      <div
        className="reg-flags reg-hoverable"
        onMouseEnter={onEnter("address", REG_PC)}
        onMouseLeave={onLeave}
      >
        <span className="reg-label">PC</span>
        <span className="reg-val">{hex(regs[REG_PC], 6)}</span>
      </div>
      <div
        className="reg-flags reg-hoverable"
        onMouseEnter={onEnter("address", REG_USP)}
        onMouseLeave={onLeave}
      >
        <span className="reg-label">USP</span>
        <span className="reg-val">{hex(regs[REG_USP], 6)}</span>
      </div>
      <div className={"reg-flags" + (changed(REG_SR) ? " reg-changed" : "")}>
        <span className="reg-label">SR</span>
        <span className="reg-val reg-sr">{srFlags(regs[REG_SR])}</span>
      </div>
      {hover && interp && (
        <Tooltip x={hover.x} y={hover.y} width={180}>
          {offset && <div className="tt-offset">{offset}</div>}
          <div className="tip-grid">
            {interp.map((r) => (
              <Fragment key={r.label}>
                <span className="tip-label">{r.label}</span>
                <span className="tip-val">{r.value}</span>
              </Fragment>
            ))}
          </div>
        </Tooltip>
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
  const symbolize = useMemo(() => createSymbolizer(model?.symbols), [model]);

  // Functions sorted by total cycles descending (hottest first — matches the old extension's
  // "jump to the hottest function" default).
  const functions = useMemo(() => {
    if (!disassembly) return [];
    return [...disassembly]
      .map((fn) => ({ fn, totalCycles: fn.instructions.reduce((s, i) => s + i.cycles, 0) }))
      .sort((a, b) => b.totalCycles - a.totalCycles);
  }, [disassembly]);

  // The instruction executing at the selected DMA cycle, if any — drives "Follow execution".
  // Reads model.pcs directly via the column boundaries (columnIndexAtX), NOT through the
  // columns' merged `.rows` (resolveStackAtX): buildColumns coalesces every contiguous run of
  // the same function into one box for flame-graph rendering (e.g. an entire hot loop's
  // iterations, all in one function, merge into a single box), so resolving through `.rows`
  // would freeze on that run's first instruction for the whole run — never moving as you scrub
  // within it. model.pcs has no such collapsing; indexing it directly gives the real PC for
  // this exact x every time.
  const columns = useMemo(() => (model ? buildColumns(model) : []), [model]);
  const dmaSlots = model?.dma?.owner.length;
  const currentIdx = useMemo(() => {
    if (selectedSlot === undefined || !dmaSlots || !model?.pcs.length) return undefined;
    return columnIndexAtX(columns, (selectedSlot + 0.5) / dmaSlots);
  }, [columns, selectedSlot, dmaSlots, model]);
  const currentAddress = currentIdx !== undefined ? model?.pcs[currentIdx] : undefined;

  // D0-D7/A0-A7/SR/PC/USP at currentIdx, for the CPU Registers panel — bounds-checked since
  // model.registers can be undefined (unsupported backend/older capture) or, rarely, shorter
  // than model.pcs (buildModelFromCapture clips it defensively; see that function's comment).
  const regsAt = (idx: number | undefined): Uint32Array | undefined => {
    if (idx === undefined || !model?.registers) return undefined;
    const off = idx * REG_COUNT;
    return off + REG_COUNT <= model.registers.length ? model.registers.subarray(off, off + REG_COUNT) : undefined;
  };
  const currentRegs = regsAt(currentIdx);
  const prevRegs = currentIdx !== undefined ? regsAt(currentIdx - 1) : undefined;

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
      <div className="disasm-body">
        <div className="disasm-rows">
          <List
            listRef={listRef}
            rowComponent={RowRenderer}
            rowProps={rowProps}
            rowCount={active?.fn.instructions.length ?? 0}
            rowHeight={18}
          />
        </div>
        {currentRegs && <RegistersPanel regs={currentRegs} prev={prevRegs} symbolize={symbolize} />}
      </div>
    </div>
  );
}
