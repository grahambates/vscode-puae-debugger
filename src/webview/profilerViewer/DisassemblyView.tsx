import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { List, ListImperativeAPI, RowComponentProps } from "react-window";
import { getProfileModel } from "./modelStore";
import { buildColumns, columnIndexAtX, columnIndexToSlot, findNextSample } from "./columns";
import { IDisassembledFunction, IDisassembledInstruction, REG_COUNT, REG_D0, REG_A0, REG_SR, REG_PC, REG_USP } from "../../shared/profilerTypes";
import { heatColor } from "../../shared/profilerColor";
import { srFlags } from "../shared/cpuFlags";
import { createSymbolizer, Symbolizer } from "./symbols";
import { interpretDataReg, interpretAddressReg } from "./registerInterpret";
import { AccessList, useAccessContext, useRegisterChanges } from "./AccessList";
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
  // Whether measured cost may be compared against each instruction's datasheet cost for THIS
  // capture (68000 only — see theoreticalTimings.ts). False hides the stall column entirely
  // rather than showing a figure that would be fiction.
  datasheetApplicable: boolean;
};

// Cycles this instruction spent waiting rather than working: what it actually cost, minus what
// the 68000 datasheet says those same executions cost with the bus to itself. Undefined when
// there's nothing to compare (never executed, untimeable instruction, or wrong CPU).
function stallOf(ins: IDisassembledInstruction, applicable: boolean): number | undefined {
  if (!applicable || ins.hits === 0 || ins.theoreticalCycles === undefined) return undefined;
  return ins.cycles - ins.theoreticalCycles * ins.hits;
}

function RowRenderer({ index, style, rows, maxCycles, currentAddress, onOpenSource, onJumpToExecution, showSource, datasheetApplicable }: RowComponentProps<RowListProps>) {
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
      <span className="disasm-cycles" title="Total time this frame, in colour clocks (1 cc = 2 68000 CPU cycles)">{ins.cycles > 0 ? `${ins.cycles}cc` : ""}</span>
      {datasheetApplicable && (() => {
        const stall = stallOf(ins, true);
        if (stall === undefined) return <span className="disasm-stall" />;
        const theoretical = ins.theoreticalCycles! * ins.hits;
        return (
          <span
            className={"disasm-stall" + (stall > 0 ? " disasm-stalled" : "")}
            title={`Measured ${ins.cycles}cc vs 68000 datasheet ${theoretical}cc for ${ins.hits} execution(s), in colour clocks (1 cc = 2 CPU cycles)`
              + ` — ${stall > 0 ? `${stall}cy waiting for the bus` : "no contention"}`
              + (ins.busAccesses ? `, ${ins.busAccesses * ins.hits} bus accesses` : "")}
          >
            {stall > 0 ? `+${stall}` : ""}
          </span>
        );
      })()}
      <span className="disasm-addr">${ins.address.toString(16).padStart(6, "0")}</span>
      <span className="disasm-text">{ins.text}{ins.comment && <span className="disasm-comment">  ; {ins.comment}</span>}</span>
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

// ── Sorted (hot-instruction) view ───────────────────────────────────────────────────────────
// A flat, whole-program list of every instruction that actually executed this frame (hits > 0 —
// ranking never-executed code is meaningless), sortable by cycle cost or execution count instead
// of the Linear view's per-function address order. Complements Linear rather than replacing it:
// this is where you find "what's actually hot", Linear is where you read it in its real context.

type SortKey = "cycles" | "hits";

interface FlatIns {
  fn: IDisassembledFunction;
  ins: IDisassembledInstruction;
}

type SortedRowListProps = {
  rows: FlatIns[];
  totalCycles: number;
  currentAddress: number | undefined;
  maxCycles: number;
  onOpenSource: (file: string, line: number, toSide: boolean) => void;
  onJump: (fn: IDisassembledFunction, address: number) => void;
};

function SortedRowRenderer({ index, style, rows, totalCycles, currentAddress, maxCycles, onOpenSource, onJump }: RowComponentProps<SortedRowListProps>) {
  const { fn, ins } = rows[index];
  const pct = totalCycles > 0 ? (ins.cycles / totalCycles) * 100 : 0;
  return (
    <div
      className={"disasm-row disasm-clickable" + (ins.address === currentAddress ? " disasm-current" : "")}
      style={{ ...style, background: heatColor(ins.cycles, maxCycles) }}
      onClick={() => onJump(fn, ins.address)}
      title="Click: view in context"
    >
      <span className="disasm-hits" title="Executions this frame">{ins.hits}×</span>
      <span className="disasm-cycles" title="Total time this frame, in colour clocks (1 cc = 2 68000 CPU cycles)">{ins.cycles}cc</span>
      <span className="disasm-pct" title="Share of all executed instructions' total time this frame">{pct.toFixed(1)}%</span>
      <span className="disasm-addr">${ins.address.toString(16).padStart(6, "0")}</span>
      <span className="disasm-fn" title={fn.name}>{fn.name}</span>
      <span className="disasm-text">{ins.text}{ins.comment && <span className="disasm-comment">  ; {ins.comment}</span>}</span>
      {ins.file && (
        <a
          href="#"
          className="disasm-src"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation(); // don't also trigger the row's jump-to-context click
            onOpenSource(ins.file!, ins.line !== undefined && ins.line >= 0 ? ins.line : 1, e.altKey);
          }}
        >
          {ins.file.split(/[/\\]/).pop()}:{ins.line ?? 1}
        </a>
      )}
    </div>
  );
}

function SortedHeader({ sortKey, onChangeSort }: { sortKey: SortKey; onChangeSort: (k: SortKey) => void }) {
  const heading = (key: SortKey, cls: string, label: string) => (
    <div
      className={cls + " tv-heading" + (sortKey === key ? " tv-sorted" : "")}
      style={{ cursor: "pointer" }}
      onClick={() => onChangeSort(key)}
    >
      {sortKey === key && <span className="codicon codicon-chevron-down" />}{label}
    </div>
  );
  return (
    <div className="disasm-row disasm-sorted-header">
      {heading("hits", "disasm-hits", "Hits")}
      {heading("cycles", "disasm-cycles", "Time (cc)")}
      <div className="disasm-pct tv-heading">%</div>
      <div className="disasm-addr tv-heading">Address</div>
      <div className="disasm-fn tv-heading">Function</div>
      <div className="disasm-text tv-heading">Instruction</div>
    </div>
  );
}

const hex = (v: number, digits = 8) => `$${(v >>> 0).toString(16).padStart(digits, "0")}`;

// Names by register-trace index (REG_COUNT layout).
const REG_LABELS = ["D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7", "A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "SR", "PC", "USP"];

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
// Click selects a register: its change history is listed under the disassembly (AccessList), the
// counterpart of Memory's and Custom Registers' "click: access history" (a register's trace
// records its value, so it's the changes to it that can be listed, not every read).
function RegistersPanel({
  regs, prev, symbolize, selectedReg, onSelectReg,
}: {
  regs: Uint32Array;
  prev: Uint32Array | undefined;
  symbolize: Symbolizer;
  /** The register whose changes are listed under the disassembly — the last one clicked. */
  selectedReg: number | undefined;
  onSelectReg: (reg: number) => void;
}) {
  const [hover, setHover] = useState<RegHover | undefined>(undefined);
  const changed = (i: number) => prev !== undefined && regs[i] !== prev[i];
  const onEnter = (kind: RegKind, i: number) => (e: { clientX: number; clientY: number }) =>
    setHover({ kind, value: regs[i], x: e.clientX, y: e.clientY });
  const onLeave = () => setHover(undefined);

  // Prevent the browser from setting a text-selection anchor on mousedown — without this,
  // clicking cell A then Shift+clicking cell B extends a selection across the panel.
  // preventDefault on click alone is too late; the selection starts on mousedown.
  const preventSelect = (e: { preventDefault(): void }) => e.preventDefault();

  // Click: the register's change history, listed under the disassembly.
  const onCellClick = (i: number) => () => onSelectReg(i);

  const cell = (label: string, i: number, kind: RegKind, digits = 8) => (
    <div
      key={label}
      className={"reg-cell" + (changed(i) ? " reg-changed" : "") + (i === selectedReg ? " reg-selected" : "") + " reg-hoverable"}
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
      <div
        className={"reg-flags reg-hoverable" + (changed(REG_SR) ? " reg-changed" : "") + (selectedReg === REG_SR ? " reg-selected" : "")}
        onMouseDown={preventSelect}
        onClick={onCellClick(REG_SR)}
        title="Click: change history"
      >
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
          <div className="tt-hint">Click: change history</div>
        </Tooltip>
      )}
    </div>
  );
}

// Persisted toolbar options, across mounts within this webview session (module-level, not React
// state — a tab switch unmounts/remounts DisassemblyView, which would otherwise reset these
// checkboxes back to their hardcoded defaults every time). Same pattern as MemoryView's own
// `savedView`. Reset on a full webview reload, same as everything else in module scope.
let savedOptions: { follow: boolean; showRegs: boolean; showSource: boolean; globalHeat: boolean; viewMode: "linear" | "sorted"; sortKey: SortKey } | undefined;

// Per-instruction disassembly for every function that executed this frame, annotated with exact
// per-PC hit/cycle counts (this profiler traces every retired instruction — not statistical
// sampling), linked to the shared selectedSlot playhead and to source. The vscode-amiga-debug
// equivalent (objdump.tsx) parsed pre-built objdump text; we have no host-side disassembler, so
// the text/bytes/stats come from the live wasm session right after capture (profilerManager.ts's
// fetchDisassembly) — see model.disassembly.
export function DisassemblyView({
  selectedSlot,
  selectedSampleIdx,
  onSelectSlot,
  onOpenSource,
  sourceFiles,
  onRequestSourceFile,
  onSetGlobalHeat,
}: {
  selectedSlot: number | undefined;
  // The exact sample the cursor means, when whatever moved it knew (see App.tsx's selectSlot).
  // Takes precedence over re-deriving one from selectedSlot, which cannot distinguish samples
  // that share a slot.
  selectedSampleIdx: number | undefined;
  onSelectSlot: (slot: number, sampleIdx?: number) => void;
  onOpenSource: (file: string, line: number, toSide: boolean) => void;
  sourceFiles: Map<string, string[] | null>;
  onRequestSourceFile: (file: string) => void;
  // Mirrors the "Global heat" toggle onto the real-editor source line decorations
  // (ProfilerLineDecorationProvider), which live host-side and are otherwise independent of this
  // view — so the two heat maps read the same way. Optional: absent in any context that doesn't
  // want this view driving the real editor's decorations.
  onSetGlobalHeat?: (enabled: boolean) => void;
}) {
  const model = getProfileModel();
  // The CPU register whose changes are listed under the disassembly (picked in the Registers panel).
  const [selectedReg, setSelectedReg] = useState<number | undefined>(undefined);
  const accessContext = useAccessContext(model);
  const registerChanges = useRegisterChanges(model, accessContext, selectedReg);
  const disassembly = model?.disassembly;
  const [selectedFn, setSelectedFn] = useState<number | undefined>(undefined); // index into `functions`
  const [follow, setFollow] = useState(savedOptions?.follow ?? true);
  const [showRegs, setShowRegs] = useState(savedOptions?.showRegs ?? true);
  const [showSource, setShowSource] = useState(savedOptions?.showSource ?? false);
  // Heat map scale: per-function (its own hottest instruction, the default) or global (the
  // hottest instruction across every executed function this frame) — see maxCycles below.
  const [globalHeat, setGlobalHeat] = useState(savedOptions?.globalHeat ?? true);
  // Linear (per-function, address order — the original view) vs Sorted (flat, whole-program,
  // ranked by cycle cost or execution count — see the SortedRowRenderer/SortedHeader doc comment).
  const [viewMode, setViewMode] = useState<"linear" | "sorted">(savedOptions?.viewMode ?? "linear");
  const [sortKey, setSortKey] = useState<SortKey>(savedOptions?.sortKey ?? "cycles");
  const [scrollTop, setScrollTop] = useState(0);
  const listRef = useRef<ListImperativeAPI>(null);
  const sortedListRef = useRef<ListImperativeAPI>(null);
  const symbolize = useMemo(() => createSymbolizer(model?.symbols), [model]);

  // Keep savedOptions current as the toolbar toggles change, so the next mount (e.g. switching
  // back to this tab) restores them instead of resetting to the hardcoded defaults.
  useEffect(() => {
    savedOptions = { follow, showRegs, showSource, globalHeat, viewMode, sortKey };
  }, [follow, showRegs, showSource, globalHeat, viewMode, sortKey]);

  // Also re-notify on mount (not just when the user toggles it) so a restored `globalHeat` from
  // savedOptions keeps the real-editor decorations in sync after switching back to this tab.
  useEffect(() => {
    onSetGlobalHeat?.(globalHeat);
  }, [globalHeat, onSetGlobalHeat]);

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
    if (!model?.pcs.length) return undefined;
    // An exact sample index beats re-deriving one from the slot. A slot cannot identify a sample:
    // instructions the CPU model measured at zero color clocks (68020+ lumped accounting) share
    // their slot with whichever neighbour carried the lump, so columnIndexAtX below resolves that
    // whole group to one column — the widest. Navigation that knows its target therefore hands the
    // index over rather than round-tripping through a slot that would land somewhere else.
    if (selectedSampleIdx !== undefined && selectedSampleIdx < model.pcs.length) return selectedSampleIdx;
    if (selectedSlot === undefined || !dmaSlots) return undefined;
    return columnIndexAtX(columns, (selectedSlot + 0.5) / dmaSlots);
  }, [columns, selectedSlot, selectedSampleIdx, dmaSlots, model]);
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

  // Heat map scale. Global (default): the hottest instruction across every executed function this
  // frame — a manual loop rather than Math.max(0, ...spread) since the total instruction count
  // here can reach MAX_DISASSEMBLE_INSTRUCTIONS (profilerManager.ts), too many args to safely
  // spread. Per-function: the active function's own hottest instruction instead, so the gradient
  // stays meaningful even for a function that's individually cold relative to the rest of the
  // program — useful when comparing hot spots within one routine rather than across the frame.
  // Sorted view always uses the global scale (it spans every function at once, so "per function"
  // wouldn't mean anything) regardless of the Linear-only "Global heat" checkbox's own state.
  const maxCycles = useMemo(() => {
    if (!globalHeat && viewMode === "linear") return active ? Math.max(0, ...active.instructions.map((i) => i.cycles)) : 0;
    let max = 0;
    for (const fn of disassembly ?? []) {
      for (const ins of fn.instructions) if (ins.cycles > max) max = ins.cycles;
    }
    return max;
  }, [globalHeat, viewMode, disassembly, active]);
  const arrows = useMemo(() => computeArrows(active?.instructions ?? []), [active]);

  // Sorted view's data: every instruction that actually executed this frame (hits > 0), across
  // every function, ranked by whichever of cycles/hits is currently the sort key. Kept separate
  // from `functions` (which is per-function totals, sorted for the Linear picker) — this is
  // per-instruction and flat.
  const { sortedRows, sortedTotalCycles } = useMemo(() => {
    if (!disassembly) return { sortedRows: [] as FlatIns[], sortedTotalCycles: 0 };
    const flat: FlatIns[] = [];
    let totalCycles = 0;
    for (const fn of disassembly) {
      for (const ins of fn.instructions) {
        if (ins.hits <= 0) continue;
        flat.push({ fn, ins });
        totalCycles += ins.cycles;
      }
    }
    flat.sort((a, b) => (sortKey === "cycles" ? b.ins.cycles - a.ins.cycles : b.ins.hits - a.ins.hits) || a.ins.address - b.ins.address);
    return { sortedRows: flat, sortedTotalCycles: totalCycles };
  }, [disassembly, sortKey]);

  // Scan model.pcs forward (prev=false) or backward (prev=true) from currentIdx to find the
  // next/previous execution of a specific instruction address, then jump the playhead there.
  // Wraps around the frame so repeated clicks cycle through all executions.
  const jumpToExecution = useMemo(() => {
    if (!model?.pcs.length || !dmaSlots || columns.length === 0) return undefined;
    return (address: number, prev: boolean) => {
      const pcs = model.pcs;
      const from = currentIdx ?? (prev ? pcs.length - 1 : -1);
      const k = findNextSample(pcs.length, from, prev, (i) => pcs[i] === address);
      if (k !== undefined) onSelectSlot(columnIndexToSlot(columns, k, dmaSlots), k);
    };
  }, [model, currentIdx, columns, dmaSlots, onSelectSlot]);

  const datasheetApplicable = !!model?.datasheet?.applicable;
  const rowProps = useMemo<RowListProps>(
    () => ({ rows, maxCycles, currentAddress, onOpenSource, onJumpToExecution: jumpToExecution, showSource, datasheetApplicable }),
    [rows, maxCycles, currentAddress, onOpenSource, jumpToExecution, showSource, datasheetApplicable],
  );

  // "View in context": switch to Linear, select the clicked instruction's own function (so it's
  // guaranteed visible regardless of "Follow"), and jump the shared playhead to this instruction's
  // first execution this frame — findNextSample(..., -1, false, ...) is the same recipe
  // jumpToExecution above uses, just starting fresh from the beginning rather than continuing from
  // wherever the playhead currently sits. Every row here has hits > 0 (see sortedRows above), so a
  // matching sample always exists — the existing scroll-to-row effect (keyed off currentAddress)
  // then does the rest once `active`/`rows` update to the newly-selected function.
  const jumpFromSorted = useMemo(() => {
    return (fn: IDisassembledFunction, address: number) => {
      setFollow(false);
      const fnIndex = functions.findIndex(f => f.address === fn.address);
      if (fnIndex >= 0) setSelectedFn(fnIndex);
      setViewMode("linear");
      if (model?.pcs.length && dmaSlots && columns.length > 0) {
        const k = findNextSample(model.pcs.length, -1, false, (i) => model.pcs[i] === address);
        if (k !== undefined) onSelectSlot(columnIndexToSlot(columns, k, dmaSlots), k);
      }
    };
  }, [functions, model, dmaSlots, columns, onSelectSlot]);

  const sortedRowProps = useMemo<SortedRowListProps>(
    () => ({ rows: sortedRows, totalCycles: sortedTotalCycles, currentAddress, maxCycles, onOpenSource, onJump: jumpFromSorted }),
    [sortedRows, sortedTotalCycles, currentAddress, maxCycles, onOpenSource, jumpFromSorted],
  );

  if (!model) return null;
  if (!disassembly || functions.length === 0) {
    return <div className="hint">No disassembly captured for this frame.</div>;
  }

  return (
    <div className="disassemblyview">
      <div className="disasm-toolbar">
        <span className="time-mode-toggle disasm-view-toggle">
          <button
            className={"time-mode-btn" + (viewMode === "linear" ? " active" : "")}
            onClick={() => setViewMode("linear")}
            title="Per-function disassembly in address order, interleaved with source"
          >Linear</button>
          <button
            className={"time-mode-btn" + (viewMode === "sorted" ? " active" : "")}
            onClick={() => setViewMode("sorted")}
            title="Every executed instruction this frame, whole-program, ranked by time or execution count"
          >Sorted</button>
        </span>
        {viewMode === "linear" ? (
          <>
            <select
              value={activeFnIndex}
              onChange={(e) => { setFollow(false); setSelectedFn(Number(e.target.value)); }}
            >
              {functions.map((fn, i) => (
                <option key={fn.address} value={i}>
                  {fn.name} ({fn.totalCycles} cc)
                </option>
              ))}
            </select>
            <label className="disasm-option">
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
              Follow
            </label>
            <label className="disasm-option">
              <input type="checkbox" checked={showRegs} onChange={(e) => setShowRegs(e.target.checked)} />
              Registers
            </label>
            <label className="disasm-option">
              <input type="checkbox" checked={showSource} onChange={(e) => setShowSource(e.target.checked)} />
              Source
            </label>
            <label className="disasm-option" title="Scale the heat map by the hottest instruction across every executed function this frame, instead of just the function currently shown — also applies to the real editor's source line decorations.">
              <input type="checkbox" checked={globalHeat} onChange={(e) => setGlobalHeat(e.target.checked)} />
              Global heat
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
                    if (target >= 0) onSelectSlot(columnIndexToSlot(columns, target, dmaSlots), target);
                  }}
                  title="Previous instruction"
                >◀</button>
                <button
                  onClick={() => {
                    const target = currentIdx !== undefined ? currentIdx + 1 : 0;
                    if (target < columns.length) onSelectSlot(columnIndexToSlot(columns, target, dmaSlots), target);
                  }}
                  title="Next instruction"
                >▶</button>
              </span>
            )}
          </>
        ) : (
          <span className="disasm-option">{sortedRows.length} executed instructions this frame</span>
        )}
      </div>
      {viewMode === "linear" ? (
        <>
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
              selectedReg={selectedReg}
              onSelectReg={setSelectedReg}
            />
          )}
        </div>
        {showRegs && selectedReg !== undefined && (
          <AccessList
            title={`Changes to ${REG_LABELS[selectedReg]}`}
            note={model.registers?.length ? undefined : "this frame has no register trace (a capture records one for its first frame)"}
            rows={registerChanges}
            selectedSlot={selectedSlot}
            onSelect={(row) => onSelectSlot(row.slot, row.sample)}
            onOpenSource={onOpenSource}
            onClose={() => setSelectedReg(undefined)}
            empty={model.registers?.length ? "It didn't change this frame." : "No register trace for this frame."}
          />
        )}
        </>
      ) : (
        <div className="disasm-sorted-rows">
          <SortedHeader sortKey={sortKey} onChangeSort={setSortKey} />
          <List
            style={{ flex: 1, minWidth: 0, minHeight: 0 }}
            listRef={sortedListRef}
            rowComponent={SortedRowRenderer}
            rowProps={sortedRowProps}
            rowCount={sortedRows.length}
            rowHeight={ROW_H}
          />
        </div>
      )}
    </div>
  );
}
