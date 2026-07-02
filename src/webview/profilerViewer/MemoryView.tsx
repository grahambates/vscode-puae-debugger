import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { List, ListImperativeAPI, RowComponentProps } from "react-window";
import { useCombobox } from "downshift";
import { getProfileModel } from "./modelStore";
import { reconstructMemoryAt, resolveMemoryRegion, findPrevMemWrite, findNextMemWrite, SLOW_BASE } from "./reconstruct";
import { createSymbolizer } from "./symbols";
import { createSourceLookup } from "./sourceLookup";
import { buildAddressSuggestions, parseAddressInput, AddressSuggestion, Region } from "./addressSuggestions";
import { MemoryVisual, MemoryVisualAPI } from "./MemoryVisual";
import { Tooltip } from "./Tooltip";
import { markChanges } from "./memoryDiff";
import { convertToSigned } from "../shared/memoryFormat";
import { isMac } from "../shared/platform";
import { DMA_WRITE, dmaIsCustomReg, ISymbol } from "../../shared/profilerTypes";

const BYTES_PER_ROW = 16;
// Change-fade duration, matching the live memory viewer's HexDump (rgba(255,200,0,opacity),
// opacity = 0.5*(1-elapsed/FADE_MS)) for a consistent visual language between the two viewers.
const FADE_MS = 1000;

// Props shared across every row via the v2 rowProps channel (must not contain
// ariaAttributes/index/style — see TimeView.tsx).
//
// CRITICAL: never put the reconstructed Uint8Array (up to ~2MB) directly in this object. React's
// *development* build deep-walks every prop value on every render for its DevTools/profiler
// instrumentation (see modelStore.ts's comment — the whole reason the big profile model lives
// outside React state/props in the first place); a multi-megabyte typed array sitting in a prop
// costs ~1-2s PER RENDER to walk, not just when it changes, which made this tab appear to hang
// while scrubbing. `getByte`/`getFadeOpacity` give rows fresh data through stable functions
// instead, so the actual bytes (and the change-timestamp map) never enter React's prop tree.
type RowListProps = {
  getByte: (off: number) => number | undefined; // reads the *current* reconstructed buffer
  getFadeOpacity: (off: number) => number; // 0..0.5, decaying — see FADE_MS
  bufLength: number;
  bufVersion: number; // changes exactly when the reconstructed buffer's contents change, to force a row repaint
  fadeTick: number; // bumped every animation frame while a fade is in progress, same purpose
  baseAddr: number; // address of offset 0 in the buffer (0 for chip, SLOW_BASE for slow)
  highlightOffset: number | undefined; // byte written at the selected cycle, if any, in this region
  colorCode: boolean; // "Color bytes" toggle — one hue per leading hex digit, see .mem-nib-* in App.css
  onByteClick: (addr: number, jumpToSource: boolean, toSide: boolean, forward: boolean) => void;
  onByteHover: (addr: number, x: number, y: number) => void;
  onByteLeave: () => void;
};

// For visual mode: find the symbol whose extent covers absAddr and return its start offset
// relative to base (= baseAddr). This keeps the row grid aligned to the label rather than
// the exact write address so "Screen+4" doesn't shift the image left by 4 pixels.
function symAlignOff(absAddr: number, base: number, symbols: ISymbol[] | undefined): number {
  if (!symbols?.length) return absAddr - base;
  let best: number | undefined;
  for (const s of symbols) {
    if (s.address < base || s.address > absAddr) continue; // out of region or past target
    if (s.size > 0 && absAddr >= s.address + s.size) continue; // address beyond symbol extent
    if (best === undefined || s.address > best) best = s.address;
  }
  return (best ?? absAddr) - base;
}

// Last-viewed region/options/scroll position, kept at module scope — NOT React state — so it
// survives MemoryView unmounting. The right pane only ever renders the active tab (see
// App.tsx's tab ternary), so switching away and back fully remounts this component; without
// this, every return trip would reset to region=chip/address $0 regardless of where the user
// last looked. Same "outside React" trick modelStore.ts uses for the profile model itself.
let savedView: { region: Region; follow: boolean; colorCode: boolean; topAddress: number | undefined } | undefined;

const toAscii = (b: number): string => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".");

// Nibble color-coding class for a byte value, or undefined when color-coding is off — only the
// hex column is colored (the ASCII column stays the dim description color either way), matching
// HexDump.
const nibbleClass = (value: number, colorCode: boolean): string | undefined => {
  if (!colorCode) return undefined;
  return value === 0 ? "mem-nib-zero" : `mem-nib-${(value >>> 4) & 0xf}`;
};

function RowRenderer({
  index, style, getByte, getFadeOpacity, baseAddr, highlightOffset, colorCode, onByteClick, onByteHover, onByteLeave,
}: RowComponentProps<RowListProps>) {
  const rowOff = index * BYTES_PER_ROW;
  const addr = baseAddr + rowOff;
  const cells: { hex: string; ascii: string; off: number; present: boolean; fade: number; value: number }[] = [];
  for (let i = 0; i < BYTES_PER_ROW; i++) {
    const off = rowOff + i;
    const b = getByte(off);
    cells.push({
      hex: b !== undefined ? b.toString(16).padStart(2, "0") : "  ",
      ascii: b !== undefined ? toAscii(b) : " ",
      off,
      present: b !== undefined,
      fade: getFadeOpacity(off),
      value: b ?? 0,
    });
  }
  return (
    <div className="mem-row" style={style}>
      <span className="mem-addr">${addr.toString(16).padStart(6, "0")}</span>
      <span className="mem-hex">
        {cells.map((c) => (
          <span
            key={c.off}
            className={[
              "mem-byte",
              c.off === highlightOffset ? "mem-hit" : undefined,
              c.present ? nibbleClass(c.value, colorCode) : undefined,
            ].filter(Boolean).join(" ")}
            style={c.fade > 0 ? { background: `rgba(255,200,0,${c.fade.toFixed(3)})` } : undefined}
            onClick={c.present ? (e) => onByteClick(baseAddr + c.off, e.ctrlKey || e.metaKey, e.altKey, e.shiftKey) : undefined}
            onMouseEnter={c.present ? (e) => onByteHover(baseAddr + c.off, e.clientX, e.clientY) : undefined}
            onMouseLeave={onByteLeave}
          >
            {c.hex}
          </span>
        ))}
      </span>
      <span className="mem-ascii">{cells.map((c) => c.ascii).join("")}</span>
    </div>
  );
}

// Reconstructed chip/slow RAM at the selected DMA cycle (the old vscode-amiga-debug
// debugger/memory.tsx, ported as a read-only hex+ASCII dump — region select + a "Follow writes"
// toggle instead of the old pixel/heatmap view). Reconstruction comes from the already-wired
// reconstructMemoryAt; "Follow writes" auto-switches region and scrolls to whatever address the
// selected cycle wrote, mirroring Custom Registers' changed-this-cycle highlight. Clicking a byte
// jumps the playhead to the most recent write that produced it; Ctrl/Cmd+click instead jumps to
// source via the program's full line table (model.lineTable — see sourceLookup.ts), which covers
// code and data addresses alike (e.g. a byte inside a "Screen" buffer resolves to wherever that
// line was declared) — same modifier convention as FlameGraph/DisassemblyView. Hovering a byte
// shows its
// address/symbol and byte/word/long interpretations, formatted to match the live memory viewer's
// HexDump tooltip; bytes that changed value since the last debounced reconstruction fade out over
// FADE_MS, also mirroring HexDump.
export function MemoryView({
  selectedSlot,
  onSelectSlot,
  onOpenSource,
}: {
  selectedSlot: number | undefined;
  onSelectSlot: (slot: number) => void;
  onOpenSource: (file: string, line: number, toSide: boolean) => void;
}) {
  const model = getProfileModel();
  const dma = model?.dma;
  const snapshot = model?.dmaSnapshot;
  // Captured once, on this instance's first render, before any of its own effects can touch
  // `savedView` — the stable "what to restore on mount" snapshot (see the restore effect below).
  const initialSavedViewRef = useRef(savedView);
  const [region, setRegion] = useState<Region>(savedView?.region ?? "chip");
  const [follow, setFollow] = useState(savedView?.follow ?? true);
  const [colorCode, setColorCode] = useState(savedView?.colorCode ?? true); // live memory viewer's default
  const [viewMode, setViewMode] = useState<"hex" | "visual">("hex");
  const visualRef = useRef<MemoryVisualAPI>(null);
  // Keep a ref so scrollToByteOffset stays stable (no viewMode dep → no callback cascade).
  const viewModeRef = useRef(viewMode);
  useEffect(() => { viewModeRef.current = viewMode; }, [viewMode]);

  // Unified scroller: routes to the hex List or visual canvas depending on current view mode.
  // Declared early (before any effects that call it) so it's in scope throughout.
  const scrollToByteOffset = useCallback((off: number, align: "start" | "smart" = "start", alignOff?: number) => {
    if (viewModeRef.current === "visual") {
      visualRef.current?.scrollToOffset(off, alignOff);
    } else {
      listRef.current?.scrollToRow({ index: Math.floor(off / BYTES_PER_ROW), align });
    }
  }, []);

  const [comboQuery, setComboQuery] = useState("");
  const [browseAll, setBrowseAll] = useState(false); // dropdown-button click: bypass the suggestion cap
  const [hover, setHover] = useState<{ addr: number; x: number; y: number } | undefined>(undefined);
  const listRef = useRef<ListImperativeAPI>(null);

  // Keep savedView's region/follow/colorCode current as they change (topAddress is updated
  // separately, by the List's onRowsRendered below, since it changes far more often).
  useEffect(() => {
    savedView = { region, follow, colorCode, topAddress: savedView?.topAddress };
  }, [region, follow, colorCode]);

  const slot = selectedSlot ?? (dma ? dma.owner.length - 1 : 0);

  // reconstructMemoryAt copies the full chip+slow buffers and replays the whole DMA grid — too
  // heavy to run on every `slot` change while the user is dragging the flame graph's scrubbable
  // playhead (selectedSlot fires on every pointermove, easily dozens of times/sec). Debounce it
  // so the expensive recompute only runs once the slot settles, instead of stacking up behind a
  // fast drag.
  const [debouncedSlot, setDebouncedSlot] = useState(slot);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSlot(slot), 80);
    return () => clearTimeout(t);
  }, [slot]);
  const recon = useMemo(
    () => (dma && snapshot ? reconstructMemoryAt(dma, snapshot, debouncedSlot + 1) : undefined),
    [dma, snapshot, debouncedSlot],
  );

  // The reconstructed buffers, kept OUT of props (see RowListProps' comment) behind refs that
  // rows read through `getByte`/`getFadeOpacity`. Refs may only be written in effects/handlers,
  // not during render (react-hooks/refs) — so updating them alone does NOT trigger a repaint;
  // `chipVersion` is bumped in the same effect, right after the refs are updated, to force one.
  // (A previous version relied on `debouncedSlot` for this, on the assumption that it "changes
  // exactly when recon does" — true after mount, but NOT on the very first render, where both
  // settle together with no further transition to repaint from. That left the view showing
  // blank rows — chipRef.current still its empty initial value — until something else happened
  // to force a render, e.g. scrubbing to a slot whose markChanges diff was non-empty, which is
  // what fed the fade-tick loop below. Bumping chipVersion directly removes that dependency.)
  const chipRef = useRef<Uint8Array>(new Uint8Array(0));
  const slowRef = useRef<Uint8Array>(new Uint8Array(0));
  const chipChangedRef = useRef<Map<number, number>>(new Map());
  const slowChangedRef = useRef<Map<number, number>>(new Map());
  const hasReconciledRef = useRef(false); // skip diffing against the initial empty buffers
  const [chipVersion, setChipVersion] = useState(0);
  useEffect(() => {
    if (!recon) return;
    if (hasReconciledRef.current) {
      const now = Date.now();
      markChanges(chipRef.current, recon.chip, chipChangedRef.current, now, FADE_MS);
      markChanges(slowRef.current, recon.slow, slowChangedRef.current, now, FADE_MS);
    } else {
      hasReconciledRef.current = true;
    }
    chipRef.current = recon.chip;
    slowRef.current = recon.slow;
    setChipVersion((v) => v + 1);
  }, [recon]);

  // Animation tick for the change-fade: self-restarting requestAnimationFrame loop that bumps
  // `fadeTick` (forcing visible rows to repaint with the decayed opacity) only while a fade is
  // actually in progress, so it doesn't burn CPU the rest of the time. Restarts whenever `recon`
  // changes, since that's the only thing that can add new fades.
  const [fadeTick, setFadeTick] = useState(0);
  useEffect(() => {
    let raf: number | undefined;
    const tick = () => {
      if (chipChangedRef.current.size > 0 || slowChangedRef.current.size > 0) {
        setFadeTick((t) => t + 1);
        raf = requestAnimationFrame(tick);
      } else {
        raf = undefined;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => { if (raf !== undefined) cancelAnimationFrame(raf); };
  }, [recon]);

  // The write at the selected cycle, if any, resolved to a region+offset — drives "Follow writes".
  // Resolved against `snapshot` (buffer lengths only, never changes) rather than the debounced
  // `recon`, so the highlight/auto-scroll tracks the playhead immediately even while the actual
  // byte values in the row list briefly lag behind during a fast drag.
  const currentWrite = useMemo(() => {
    if (!dma || !snapshot || selectedSlot === undefined) return undefined;
    if (selectedSlot < 0 || selectedSlot >= dma.owner.length) return undefined;
    const flags = dma.flags[selectedSlot];
    if (!(flags & DMA_WRITE) || dmaIsCustomReg(dma.owner[selectedSlot], flags, dma.addr[selectedSlot])) return undefined;
    return resolveMemoryRegion(dma.addr[selectedSlot], snapshot);
  }, [dma, snapshot, selectedSlot]);

  // "Follow writes": sync `region` to wherever the playhead just wrote. Adjusted during render
  // (React's recommended pattern for state derived from a changing value — see
  // react-hooks/set-state-in-effect) rather than in an effect, by detecting the change against the
  // last-seen currentWrite; the user can still override `region` manually via the combo box.
  // Also clears the combo box's text: it auto-jumped here from a write, not from selecting that
  // text, so leaving e.g. a stale symbol name showing would misleadingly imply the view is still
  // parked on that symbol.
  const [lastWrite, setLastWrite] = useState(currentWrite);
  if (currentWrite !== lastWrite) {
    setLastWrite(currentWrite);
    if (follow && currentWrite) {
      setRegion(currentWrite.region);
      setComboQuery("");
    }
  }

  const bufLength = region === "chip" ? recon?.chip.length : recon?.slow.length;
  const baseAddr = region === "chip" ? 0 : SLOW_BASE;

  useEffect(() => {
    if (follow && currentWrite && currentWrite.region === region) {
      scrollToByteOffset(
        currentWrite.offset, "smart",
        symAlignOff(baseAddr + currentWrite.offset, baseAddr, model?.symbols),
      );
    }
  }, [follow, currentWrite, region, scrollToByteOffset, baseAddr, model]);
  const rowCount = bufLength ? Math.ceil(bufLength / BYTES_PER_ROW) : 0;

  // On first mount: restore the previous scroll position if this tab has been opened before
  // this session (initialSavedViewRef — region was already restored via the state initializers
  // above). Otherwise (genuinely first-ever open), if Follow Writes is on but there's no current
  // write at the selected slot (e.g. no slot selected yet), scan backward from the current
  // position to find the last RAM write in the frame and scroll there — much more useful than
  // defaulting to address 0. Intentionally mount-only: subsequent follow/region changes are
  // handled by the effect above; re-running this on every slot change would fight the user
  // whenever they scrub to a non-write slot. Defers entirely to the effect above when there's an
  // actively-pinned write (currentWrite) — that's more relevant right now than either a stale
  // saved position or the "last write in the frame" fallback.
  //
  // The scroll itself is deferred a frame (requestAnimationFrame): calling List's scrollToRow
  // synchronously in a mount-time effect is a known failure mode for virtualized lists — the
  // List's own internal scroll-container sizing isn't always settled at that exact point, even
  // though useEffect runs after paint (this is a freshly-mounted List, right after a tab switch,
  // not an already-stable one) — whereas the identical scrollToRow call from a user-initiated
  // combo-box jump (after the List has been live for a while) works fine.
  useEffect(() => {
    if (currentWrite) return; // existing effect already handles the "is a write" case
    const saved = initialSavedViewRef.current;
    if (saved?.topAddress !== undefined && saved.region === region) {
      const off = saved.topAddress - baseAddr;
      if (off >= 0 && off < (bufLength ?? 0)) {
        const raf = requestAnimationFrame(() => scrollToByteOffset(off));
        return () => cancelAnimationFrame(raf);
      }
    }
    if (!follow || !dma || !snapshot) return;
    for (let i = Math.min(slot, dma.owner.length) - 1; i >= 0; i--) {
      const flags = dma.flags[i];
      if (!(flags & DMA_WRITE)) continue;
      if (dmaIsCustomReg(dma.owner[i], flags, dma.addr[i])) continue;
      const resolved = resolveMemoryRegion(dma.addr[i], snapshot);
      if (!resolved || resolved.region !== region) continue;
      const syms = model?.symbols;
      const absAddr = dma.addr[i];
      const base = resolved.region === "chip" ? 0 : SLOW_BASE;
      const raf = requestAnimationFrame(() =>
        scrollToByteOffset(resolved.offset, "smart", symAlignOff(absAddr, base, syms)));
      return () => cancelAnimationFrame(raf);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getByte = useCallback(
    (off: number): number | undefined => {
      const buf = region === "chip" ? chipRef.current : slowRef.current;
      return off < buf.length ? buf[off] : undefined;
    },
    [region],
  );

  const getFadeOpacity = useCallback(
    (off: number): number => {
      const map = region === "chip" ? chipChangedRef.current : slowChangedRef.current;
      const ts = map.get(off);
      if (ts === undefined) return 0;
      const elapsed = Date.now() - ts;
      return elapsed >= FADE_MS ? 0 : 0.5 * (1 - elapsed / FADE_MS);
    },
    [region],
  );

  const sourceLookup = useMemo(() => createSourceLookup(model?.lineTable, model?.segments), [model]);

  const onByteClick = useCallback(
    (addr: number, jumpToSource: boolean, toSide: boolean, forward: boolean) => {
      if (jumpToSource) {
        const loc = sourceLookup(addr);
        if (loc) onOpenSource(loc.file, loc.line, toSide); // loc.line is already 1-based
        return;
      }
      if (!dma) return;
      // Shift+click jumps forward to the NEXT write, plain click backward to the previous one.
      // Both use strict "before/after current slot" semantics (matching findPrevRegWrite's ◀ in
      // CustomRegsView) — using slot+1 as the backward ceiling would find the current slot itself
      // and re-select it on every click, causing the navigation to stick. When the first search
      // reaches the beginning/end without a match, wrap around to the other end of the frame
      // (same wrapping behaviour as CPU register and instruction navigation).
      const found = forward
        ? (findNextMemWrite(dma, addr, slot) ?? findNextMemWrite(dma, addr, -1))
        : (findPrevMemWrite(dma, addr, slot) ?? findPrevMemWrite(dma, addr, dma.owner.length));
      if (found !== undefined) onSelectSlot(found);
    },
    [dma, slot, onSelectSlot, sourceLookup, onOpenSource],
  );

  const onByteHover = useCallback((addr: number, x: number, y: number) => setHover({ addr, x, y }), []);
  const onByteLeave = useCallback(() => setHover(undefined), []);

  const rowProps = useMemo<RowListProps>(
    () => ({
      getByte,
      getFadeOpacity,
      bufLength: bufLength ?? 0,
      bufVersion: chipVersion,
      fadeTick,
      baseAddr,
      highlightOffset: currentWrite && currentWrite.region === region ? currentWrite.offset : undefined,
      colorCode,
      onByteClick,
      onByteHover,
      onByteLeave,
    }),
    [getByte, getFadeOpacity, bufLength, chipVersion, fadeTick, baseAddr, currentWrite, region, colorCode, onByteClick, onByteHover, onByteLeave],
  );

  // Address/symbol + byte/word/long (signed and unsigned) interpretations for the hovered byte,
  // read straight from the live buffer (getByte) — recomputed only when the hovered address (or
  // the underlying data) changes, not on every pointer move within the same byte. Word/longword
  // reads must start at an even address on the 68000 (matches HexDump's getValueInterpretations),
  // so an odd address only ever gets a Byte interpretation.
  const symbolize = useMemo(() => createSymbolizer(model?.symbols), [model]);
  const hoverInfo = useMemo(() => {
    if (!hover) return undefined;
    const off = hover.addr - baseAddr;
    const b0 = getByte(off);
    if (b0 === undefined) return undefined;
    if (hover.addr % 2 !== 0) return { byte: b0, word: undefined, long: undefined };
    const b1 = getByte(off + 1);
    const b2 = getByte(off + 2);
    const b3 = getByte(off + 3);
    const word = b1 !== undefined ? (b0 << 8) | b1 : undefined;
    const long = b1 !== undefined && b2 !== undefined && b3 !== undefined ? (((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0) : undefined;
    return { byte: b0, word, long };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-reads on chipVersion (data changed), not just hover
  }, [hover, baseAddr, getByte, chipVersion]);

  const hoverSourceLoc = useMemo(
    () => (hover ? sourceLookup(hover.addr) : undefined),
    [hover, sourceLookup],
  );
  const hoverSymbol = useMemo(() => (hover ? symbolize(hover.addr) : undefined), [hover, symbolize]);

  const jumpToAddress = useCallback(
    (addr: number) => {
      if (!snapshot) return;
      const resolved = resolveMemoryRegion(addr, snapshot);
      if (!resolved) return;
      setRegion(resolved.region);
      const base = resolved.region === "chip" ? 0 : SLOW_BASE;
      scrollToByteOffset(resolved.offset, "start", symAlignOff(addr, base, model?.symbols));
    },
    [snapshot, scrollToByteOffset, model],
  );

  const jumpToRegion = useCallback((r: Region) => {
    setRegion(r);
    scrollToByteOffset(0);
  }, [scrollToByteOffset]);

  // Address combo box: replaces a separate "region" <select> and a free-text "go to address"
  // input with one Downshift autocomplete listing both RAM regions and the program's symbols
  // (model.symbols — code and data alike), plus accepting a raw hex address typed directly.
  // browseAll mirrors the live memory viewer's dropdown-button behavior: bypass the per-keystroke
  // suggestion cap and show everything, ignoring whatever's currently typed.
  const comboSuggestions = useMemo(
    () => buildAddressSuggestions(browseAll ? "" : comboQuery, model?.symbols, !!snapshot && snapshot.slow.length > 0),
    [browseAll, comboQuery, model, snapshot],
  );

  const selectSuggestion = useCallback(
    (item: AddressSuggestion) => {
      if (item.kind === "region") jumpToRegion(item.region);
      else jumpToAddress(item.address);
    },
    [jumpToRegion, jumpToAddress],
  );

  const {
    isOpen: comboOpen,
    getMenuProps,
    getInputProps,
    getToggleButtonProps,
    highlightedIndex,
    getItemProps,
  } = useCombobox<AddressSuggestion>({
    items: comboSuggestions,
    itemToString: (item) => item?.label ?? "",
    inputValue: comboQuery,
    onInputValueChange: ({ inputValue }) => {
      setComboQuery(inputValue ?? "");
      setBrowseAll(false);
    },
    onSelectedItemChange: ({ selectedItem }) => {
      if (!selectedItem) return;
      setComboQuery(selectedItem.label);
      selectSuggestion(selectedItem);
    },
  });

  // Enter with nothing highlighted (downshift handles Enter-on-a-highlighted-item itself): try
  // an exact case-insensitive label match first (fixes casing, matches the live viewer), then
  // fall back to parsing the typed text as a raw hex address.
  const commitComboInput = useCallback(() => {
    const exact = comboSuggestions.find((s) => s.label.toLowerCase() === comboQuery.trim().toLowerCase());
    if (exact) {
      setComboQuery(exact.label);
      selectSuggestion(exact);
      return;
    }
    const addr = parseAddressInput(comboQuery);
    if (addr !== undefined) jumpToAddress(addr);
  }, [comboSuggestions, comboQuery, selectSuggestion, jumpToAddress]);

  if (!model) return null;
  if (!dma || !snapshot || !bufLength) {
    return <div className="hint">No memory snapshot for this frame.</div>;
  }

  return (
    <div className="memoryview">
      <div className="mem-toolbar">
        <div className="mem-combo-container">
          <input
            {...getInputProps({
              placeholder: "Region, symbol, or address ($..)",
              onKeyDown: (e) => {
                if (e.key === "Enter" && highlightedIndex === -1) {
                  e.preventDefault();
                  commitComboInput();
                }
              },
            })}
            className="mem-combo-input"
          />
          <button
            {...getToggleButtonProps({
              // Let downshift's own built-in toggle (already wired by getToggleButtonProps) open
              // /close the menu — calling openMenu() here too would race it. Only layer in the
              // "show everything, ignoring the cap" behavior, mirroring the live viewer's
              // dropdown-button (which also only runs its side effect, not the open itself).
              onClick: () => { if (!comboOpen) setBrowseAll(true); },
            })}
            type="button"
            className="mem-combo-toggle codicon codicon-chevron-down"
            aria-label="Show all regions and symbols"
            tabIndex={-1}
          />
          <ul {...getMenuProps()} className="mem-combo-dropdown">
            {comboOpen && comboSuggestions.map((s, index) => (
              <li
                key={s.kind === "region" ? `region:${s.region}` : `symbol:${s.label}`}
                {...getItemProps({ item: s, index })}
                className={"mem-combo-item" + (s.kind === "region" ? " mem-combo-region" : "") + (highlightedIndex === index ? " active" : "")}
              >
                <span className="mem-combo-label">{s.label}</span>
                {s.kind === "symbol" && (
                  <span className="mem-combo-address">${s.address.toString(16).padStart(6, "0")}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
        <label className="mem-follow">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Follow writes
        </label>
        {viewMode === "hex" && (
          <label className="mem-follow">
            <input type="checkbox" checked={colorCode} onChange={(e) => setColorCode(e.target.checked)} />
            Color bytes
          </label>
        )}
        <div className="mem-view-toggle">
          <button
            className={"mem-view-btn" + (viewMode === "hex" ? " active" : "")}
            onClick={() => setViewMode("hex")}
            title="Hex view"
          >Hex</button>
          <button
            className={"mem-view-btn" + (viewMode === "visual" ? " active" : "")}
            onClick={() => setViewMode("visual")}
            title="Visual (bitmap) view"
          >Visual</button>
        </div>
      </div>
      {viewMode === "hex" ? (
        <div className="mem-rows">
          <List
            listRef={listRef}
            rowComponent={RowRenderer}
            rowProps={rowProps}
            rowCount={rowCount}
            rowHeight={18}
            onRowsRendered={(visible) => {
              savedView = { region, follow, colorCode, topAddress: baseAddr + visible.startIndex * BYTES_PER_ROW };
            }}
          />
        </div>
      ) : (
        <MemoryVisual
          ref={visualRef}
          getByte={getByte}
          getFadeOpacity={getFadeOpacity}
          bufLength={bufLength ?? 0}
          bufVersion={chipVersion}
          fadeTick={fadeTick}
          baseAddr={baseAddr}
          highlightOffset={currentWrite && currentWrite.region === region ? currentWrite.offset : undefined}
          onByteClick={onByteClick}
          onByteHover={onByteHover}
          onByteLeave={onByteLeave}
        />
      )}
      {hover && hoverInfo && (
        <Tooltip x={hover.x} y={hover.y} width={220}>
          <div className="tt-func">
            {hover.addr.toString(16).toUpperCase().padStart(6, "0")}
            {hoverSymbol ? `: ${hoverSymbol}` : ""}
          </div>
          <div className="tip-grid">
            {([
              ["Byte", hoverInfo.byte, 1],
              ...(hoverInfo.word !== undefined ? [["Word", hoverInfo.word, 2]] as const : []),
              ...(hoverInfo.long !== undefined ? [["Longword", hoverInfo.long, 4]] as const : []),
            ] as const).map(([label, value, size]) => {
              const signed = convertToSigned(value, size);
              return (
                <span key={label} style={{ display: "contents" }}>
                  <span className="tip-label">{label}</span>
                  <span className="tip-val">
                    {value}
                    {signed !== value ? `, ${signed}` : ""}
                  </span>
                </span>
              );
            })}
          </div>
          <div className="tt-hint">Click: jump to previous write</div>
          <div className="tt-hint">Shift+Click: jump to next write</div>
          {hoverSourceLoc && (
            <div className="tt-hint">{isMac ? "Cmd" : "Ctrl"}+Click to open source</div>
          )}
        </Tooltip>
      )}
    </div>
  );
}
