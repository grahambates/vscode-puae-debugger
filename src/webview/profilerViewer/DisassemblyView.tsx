import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { List, ListImperativeAPI, RowComponentProps } from "react-window";
import { getProfileModel } from "./modelStore";
import { buildColumns, columnIndexAtX, columnIndexToSlot, findNextSample, IColumn } from "./columns";
import { IDisassembledInstruction, REG_COUNT, REG_D0, REG_A0, REG_SR, REG_PC, REG_USP } from "../../shared/profilerTypes";
import { heatColor } from "../../shared/profilerColor";
import { srFlags } from "../shared/cpuFlags";
import { createSymbolizer, Symbolizer } from "./symbols";
import { interpretDataReg, interpretAddressReg } from "./registerInterpret";
import { findPrevRegChangeSample, findRegNextChangeSample } from "./registerHistory";
import { Tooltip } from "./Tooltip";

const ROW_H = 18; // instruction row height (px)
const SRC_H = 15; // source-line header row height (px)
const LANE_W = 8; // px per arrow lane
const MAX_LANES = 5;
const GUTTER_W = MAX_LANES * LANE_W + 4; // 44px total width

type Row =
  | { kind: "source"; file: string; line: number; text: string }
  | { kind: "instruction"; ins: IDisassembledInstruction };

interface Arrow {
  fromIdx: number;
  toIdx: number;
  lane: number;
  isBackward: boolean;
}

function computeArrows(instructions: IDisassembledInstruction[]): Arrow[] {
  const addrToIdx = new Map(instructions.map((ins, i) => [ins.address, i]));
  const arrows: Arrow[] = [];
  for (let i = 0; i < instructions.length; i++) {
    const target = instructions[i].jumpTarget;
    if (target === undefined) continue;
    const toIdx = addrToIdx.get(target);
    if (toIdx === undefined) continue;
    arrows.push({ fromIdx: i, toIdx, lane: 0, isBackward: toIdx < i });
  }
  // Shorter spans get inner (rightmost) lanes so they don't cross wider arrows.
  arrows.sort((a, b) => Math.abs(a.toIdx - a.fromIdx) - Math.abs(b.toIdx - b.fromIdx));
  const laneOccupied: Array<[number, number][]> = [];
  for (const arrow of arrows) {
    const lo = Math.min(arrow.fromIdx, arrow.toIdx);
    const hi = Math.max(arrow.fromIdx, arrow.toIdx);
    let lane = 0;
    for (;;) {
      const occupied = laneOccupied[lane] ?? [];
      if (!occupied.some(([a, b]) => a <= hi && b >= lo)) {
        arrow.lane = lane;
        if (!laneOccupied[lane]) laneOccupied[lane] = [];
        laneOccupied[lane].push([lo, hi]);
        break;
      }
      lane++;
    }
  }
  return arrows;
}

function ArrowGutter({ arrows, instructionRowY, scrollTop }: { arrows: Arrow[]; instructionRowY: number[]; scrollTop: number }) {
  // instructionRowY[i] = top pixel of instruction row i in content (pre-scroll) coordinates.
  const rowMid = (idx: number) => (instructionRowY[idx] ?? idx * ROW_H) + ROW_H / 2 - scrollTop;
  const laneX = (lane: number) => GUTTER_W - 2 - (lane + 1) * LANE_W;
  const rightX = GUTTER_W - 1;
  const AH = 3; // arrowhead half-height in px
  return (
    <svg className="disasm-arrow-gutter" width={GUTTER_W}>
      {arrows.map((arrow, i) => {
        const fromY = rowMid(arrow.fromIdx);
        const toY = rowMid(arrow.toIdx);
        const x = laneX(Math.min(arrow.lane, MAX_LANES - 1));
        const color = arrow.isBackward
          ? "var(--vscode-charts-blue, #75beff)"
          : "var(--vscode-charts-green, #89d185)";
        return (
          <g key={i} stroke={color} fill={color} strokeWidth={1}>
            <line x1={rightX} y1={fromY} x2={x} y2={fromY} />
            <line x1={x} y1={fromY} x2={x} y2={toY} />
            <line x1={x} y1={toY} x2={rightX - AH * 2} y2={toY} />
            <polygon
              points={`${rightX},${toY} ${rightX - AH * 2},${toY - AH} ${rightX - AH * 2},${toY + AH}`}
              stroke="none"
            />
          </g>
        );
      })}
    </svg>
  );
}

// Props shared across every row via the v2 rowProps channel (must not contain
// ariaAttributes/index/style — see TimeView.tsx).
type RowListProps = {
  rows: Row[];
  maxCycles: number;
  currentAddress: number | undefined;
  onOpenSource: (file: string, line: number, toSide: boolean) => void;
  // Jump to the next (or Shift: previous) execution of the clicked instruction in the trace.
  onJumpToExecution: ((address: number, prev: boolean) => void) | undefined;
  // When source lines are interleaved, the file:line link lives on the source row itself
  // (once per source line) instead of repeating on every instruction compiled from it.
  showSource: boolean;
};

function RowRenderer({ index, style, rows, maxCycles, currentAddress, onOpenSource, onJumpToExecution, showSource }: RowComponentProps<RowListProps>) {
  const row = rows[index];
  if (row.kind === "source") {
    return (
      <div className="disasm-src-line" style={style}>
        <span className="disasm-src-text">{row.text || " "}</span>
        <a
          href="#"
          className="disasm-src"
          onClick={(e) => {
            e.preventDefault();
            onOpenSource(row.file, row.line, e.altKey);
          }}
        >
          {row.file.split(/[/\\]/).pop()}:{row.line}
        </a>
      </div>
    );
  }
  const ins = row.ins;
  // Hot/cold tint: background alpha proportional to this instruction's share of the function's
  // hottest instruction (not the frame total) — keeps the heat map meaningful within a function
  // that's individually cold relative to the rest of the program.
  return (
    <div
      className={"disasm-row" + (ins.address === currentAddress ? " disasm-current" : "") + (onJumpToExecution ? " disasm-clickable" : "")}
      style={{ ...style, background: heatColor(ins.cycles, maxCycles) }}
      onClick={onJumpToExecution ? (e) => onJumpToExecution(ins.address, e.shiftKey) : undefined}
      title={onJumpToExecution ? "Click: next execution · Shift+Click: previous execution" : undefined}
    >
      <span className="disasm-hits" title="Executions this frame">{ins.hits > 0 ? `${ins.hits}×` : ""}</span>
      <span className="disasm-cycles" title="Total cycles this frame">{ins.cycles > 0 ? `${ins.cycles}cy` : ""}</span>
      <span className="disasm-addr">${ins.address.toString(16).padStart(6, "0")}</span>
      <span className="disasm-text">{ins.text}</span>
      {!showSource && ins.file && (
        <a
          href="#"
          className="disasm-src"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation(); // don't also trigger the row's jump-to-execution click
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
//
// Click jumps the playhead to where this register's CURRENT value was set (walking the per-sample
// trace backward to the start of the run — see registerHistory.ts); Shift+click jumps forward to
// where it next changes — mirroring Memory View's click-for-previous-write (and, per its own
// request, the asymmetry it pointed out: Custom Registers' ◀▶ already go both ways, this and
// Memory View didn't). `registers`/`currentIdx`/`columns`/`dmaSlots` are the whole-trace context
// needed to do that lookup and convert the resulting sample index back into a DMA slot.
function RegistersPanel({
  regs, prev, symbolize, registers, currentIdx, columns, dmaSlots, onSelectSlot,
}: {
  regs: Uint32Array;
  prev: Uint32Array | undefined;
  symbolize: Symbolizer;
  registers: Uint32Array | undefined;
  currentIdx: number | undefined;
  columns: IColumn[];
  dmaSlots: number | undefined;
  onSelectSlot: (slot: number) => void;
}) {
  const [hover, setHover] = useState<RegHover | undefined>(undefined);
  const changed = (i: number) => prev !== undefined && regs[i] !== prev[i];
  const onEnter = (kind: RegKind, i: number) => (e: { clientX: number; clientY: number }) =>
    setHover({ kind, value: regs[i], x: e.clientX, y: e.clientY });
  const onLeave = () => setHover(undefined);

  const canNavigate = registers !== undefined && currentIdx !== undefined && !!dmaSlots;
  const sampleCount = registers ? registers.length / REG_COUNT : 0;
  // Prevent the browser from setting a text-selection anchor on mousedown — without this,
  // clicking cell A then Shift+clicking cell B extends a selection across the panel.
  // preventDefault on click alone is too late; the selection starts on mousedown.
  const preventSelect = (e: { preventDefault(): void }) => e.preventDefault();

  const onCellClick = (i: number) => (e: { shiftKey: boolean; preventDefault(): void }) => {
    if (!canNavigate) return;
    const target = e.shiftKey
      ? findRegNextChangeSample(registers, REG_COUNT, sampleCount, i, currentIdx)
      : findPrevRegChangeSample(registers, REG_COUNT, sampleCount, i, currentIdx);
    if (target === undefined) return;
    onSelectSlot(columnIndexToSlot(columns, target, dmaSlots));
  };

  const cell = (label: string, i: number, kind: RegKind, digits = 8) => (
    <div
      key={label}
      className={"reg-cell" + (changed(i) ? " reg-changed" : "") + " reg-hoverable"}
      onMouseEnter={onEnter(kind, i)}
      onMouseLeave={onLeave}
      onMouseDown={preventSelect}
      onClick={onCellClick(i)}
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
        onMouseDown={preventSelect}
        onClick={onCellClick(REG_PC)}
      >
        <span className="reg-label">PC</span>
        <span className="reg-val">{hex(regs[REG_PC], 6)}</span>
      </div>
      <div
        className="reg-flags reg-hoverable"
        onMouseEnter={onEnter("address", REG_USP)}
        onMouseLeave={onLeave}
        onMouseDown={preventSelect}
        onClick={onCellClick(REG_USP)}
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
          {canNavigate && (
            <>
              <div className="tt-hint">Click: jump where set</div>
              <div className="tt-hint">Shift+Click: next change</div>
            </>
          )}
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
// fetchDisassembly) — see model.disassembly.
export function DisassemblyView({
  selectedSlot,
  onSelectSlot,
  onOpenSource,
  sourceFiles,
  onRequestSourceFile,
}: {
  selectedSlot: number | undefined;
  onSelectSlot: (slot: number) => void;
  onOpenSource: (file: string, line: number, toSide: boolean) => void;
  sourceFiles: Map<string, string[] | null>;
  onRequestSourceFile: (file: string) => void;
}) {
  const model = getProfileModel();
  const disassembly = model?.disassembly;
  const [selectedFn, setSelectedFn] = useState<number | undefined>(undefined); // index into `functions`
  const [follow, setFollow] = useState(true);
  const [showRegs, setShowRegs] = useState(true);
  const [showSource, setShowSource] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const listRef = useRef<ListImperativeAPI>(null);
  const symbolize = useMemo(() => createSymbolizer(model?.symbols), [model]);

  // Functions sorted by total cycles descending (hottest first — matches the old extension's
  // "jump to the hottest function" default). `fn.totalCycles` is exact (from the full per-PC hit
  // list) rather than a sum of `instructions[].cycles`: a function's decoded instructions can be a
  // truncated subset of its real range (MAX_DISASSEMBLE_INSTRUCTIONS), which would otherwise
  // silently undercount.
  const functions = useMemo(() => {
    if (!disassembly) return [];
    return [...disassembly].sort((a, b) => b.totalCycles - a.totalCycles);
  }, [disassembly]);

  // The instruction executing at the selected DMA cycle, if any — drives "Follow timeline".
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

  // Which function (by index into `functions`) currentAddress falls within, if any. Uses the
  // function's real end address (`fn.end`, the symbol's full range) rather than its last decoded
  // instruction: when the decode budget truncates a function (MAX_DISASSEMBLE_INSTRUCTIONS), the
  // last decoded instruction sits well before the symbol's true end, which would otherwise make
  // "Follow timeline" silently stop updating once the playhead moved past whatever got decoded.
  const currentFnIndex = useMemo(() => {
    if (currentAddress === undefined) return undefined;
    return functions.findIndex((fn) => currentAddress >= fn.address && currentAddress < fn.end);
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
  // True if `active`'s decode stopped before reaching its real end — the total-frame decode budget
  // (MAX_DISASSEMBLE_INSTRUCTIONS, see profilerManager.ts's fetchDisassembly) ran out mid-function.
  // Surfaced rather than left silent: a truncated function's tail instructions simply don't exist
  // in `instructions`, so e.g. scrolling/"Follow timeline" past the shown portion won't find them.
  const activeTruncated = (() => {
    if (!active) return false;
    const last = active.instructions[active.instructions.length - 1];
    const decodedEnd = last ? last.address + last.length : active.address;
    return decodedEnd < active.end;
  })();

  // Fetch source files for the active function when "Show source" is on.
  useEffect(() => {
    if (!showSource || !active) return;
    const needed = [...new Set(active.instructions.flatMap(ins => ins.file ? [ins.file] : []))]
      .filter(f => !sourceFiles.has(f));
    for (const file of needed) onRequestSourceFile(file);
  }, [showSource, active, sourceFiles, onRequestSourceFile]);

  // Build the flat rows array and instructionRowY (top-of-row pixel in content coordinates
  // for each instruction) together — instructionRowY is used by the arrow gutter to compute
  // correct Y positions when source rows are interleaved.
  const { rows, instructionRowY } = useMemo(() => {
    if (!active) return { rows: [] as Row[], instructionRowY: [] as number[] };
    const instructions = active.instructions;
    if (!showSource) {
      return {
        rows: instructions.map(ins => ({ kind: "instruction" as const, ins })),
        instructionRowY: instructions.map((_, i) => i * ROW_H),
      };
    }
    const result: Row[] = [];
    const rowY: number[] = [];
    let y = 0;
    let lastKey = "";
    for (const ins of instructions) {
      if (ins.file && ins.line !== undefined) {
        const key = `${ins.file}:${ins.line}`;
        if (key !== lastKey) {
          lastKey = key;
          const fileLines = sourceFiles.get(ins.file);
          const text = fileLines != null ? (fileLines[ins.line - 1] ?? "") : "…";
          result.push({ kind: "source", file: ins.file, line: ins.line, text });
          y += SRC_H;
        }
      } else {
        lastKey = ""; // gap in source map resets grouping
      }
      rowY.push(y);
      result.push({ kind: "instruction", ins });
      y += ROW_H;
    }
    return { rows: result, instructionRowY: rowY };
  }, [active, showSource, sourceFiles]);

  // Deferred TWO frames (nested requestAnimationFrame): calling List's scrollToRow synchronously
  // in a mount-time effect is a known failure mode for virtualized lists — the List's own internal
  // scroll-container sizing isn't always settled at that exact point, even though useEffect runs
  // after paint (this matters right after a tab switch, when this is a freshly-mounted List, not
  // an already-stable one — see MemoryView's/CopperView's identical comment on the same issue). A
  // single rAF wasn't quite enough on its own — the panel's flex-sized container can still take an
  // extra frame to reach its final height, so "smart" alignment computed against that still-too-
  // short container left the target row landing partially above the (subsequently taller)
  // viewport. Waiting a second frame lets that resize settle first.
  useEffect(() => {
    if (!active || currentAddress === undefined) return;
    const listRowIdx = rows.findIndex(r => r.kind === "instruction" && r.ins.address === currentAddress);
    if (listRowIdx < 0) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => listRef.current?.scrollToRow({ index: listRowIdx, align: "smart" }));
    });
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, [active, currentAddress, rows]);

  const maxCycles = useMemo(() => (active ? Math.max(0, ...active.instructions.map((i) => i.cycles)) : 0), [active]);
  const arrows = useMemo(() => computeArrows(active?.instructions ?? []), [active]);

  // Scan model.pcs forward (prev=false) or backward (prev=true) from currentIdx to find the
  // next/previous execution of a specific instruction address, then jump the playhead there.
  // Wraps around the frame so repeated clicks cycle through all executions.
  const jumpToExecution = useMemo(() => {
    if (!model?.pcs.length || !dmaSlots || columns.length === 0) return undefined;
    return (address: number, prev: boolean) => {
      const pcs = model.pcs;
      const from = currentIdx ?? (prev ? pcs.length - 1 : -1);
      const k = findNextSample(pcs.length, from, prev, (i) => pcs[i] === address);
      if (k !== undefined) onSelectSlot(columnIndexToSlot(columns, k, dmaSlots));
    };
  }, [model, currentIdx, columns, dmaSlots, onSelectSlot]);

  const rowProps = useMemo<RowListProps>(
    () => ({ rows, maxCycles, currentAddress, onOpenSource, onJumpToExecution: jumpToExecution, showSource }),
    [rows, maxCycles, currentAddress, onOpenSource, jumpToExecution, showSource],
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
          {functions.map((fn, i) => (
            <option key={fn.address} value={i}>
              {fn.name} ({fn.totalCycles} cy)
            </option>
          ))}
        </select>
        <label className="disasm-follow">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Follow timeline
        </label>
        <label className="disasm-follow">
          <input type="checkbox" checked={showRegs} onChange={(e) => setShowRegs(e.target.checked)} />
          Registers
        </label>
        <label className="disasm-follow">
          <input type="checkbox" checked={showSource} onChange={(e) => setShowSource(e.target.checked)} />
          Source
        </label>
        {activeTruncated && (
          <span className="disasm-truncated-hint" title="This function's decoded range was cut short by the disassembly work budget — its tail instructions aren't shown.">
            ⚠ disassembly truncated ({active!.instructions.length} instructions shown)
          </span>
        )}
        {columns.length > 0 && dmaSlots && (
          <span className="cr-nav">
            <button
              onClick={() => {
                const target = currentIdx !== undefined ? currentIdx - 1 : columns.length - 1;
                if (target >= 0) onSelectSlot(columnIndexToSlot(columns, target, dmaSlots));
              }}
              title="Previous instruction"
            >◀</button>
            <button
              onClick={() => {
                const target = currentIdx !== undefined ? currentIdx + 1 : 0;
                if (target < columns.length) onSelectSlot(columnIndexToSlot(columns, target, dmaSlots));
              }}
              title="Next instruction"
            >▶</button>
          </span>
        )}
      </div>
      <div className="disasm-body">
        <div className="disasm-rows">
          <ArrowGutter arrows={arrows} instructionRowY={instructionRowY} scrollTop={scrollTop} />
          <List
            style={{ flex: 1, minWidth: 0, minHeight: 0 }}
            listRef={listRef}
            rowComponent={RowRenderer}
            rowProps={rowProps}
            rowCount={rows.length}
            rowHeight={(index) => rows[index]?.kind === "source" ? SRC_H : ROW_H}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          />
        </div>
        {currentRegs && showRegs && (
          <RegistersPanel
            regs={currentRegs}
            prev={prevRegs}
            symbolize={symbolize}
            registers={model.registers}
            currentIdx={currentIdx}
            columns={columns}
            dmaSlots={dmaSlots}
            onSelectSlot={onSelectSlot}
          />
        )}
      </div>
    </div>
  );
}
