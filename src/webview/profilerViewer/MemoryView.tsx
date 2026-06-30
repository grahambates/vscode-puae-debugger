import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { List, ListImperativeAPI, RowComponentProps } from "react-window";
import { getProfileModel } from "./modelStore";
import { reconstructMemoryAt, resolveMemoryRegion, findPrevMemWrite, SLOW_BASE } from "./reconstruct";
import { DMA_WRITE, dmaIsCustomReg } from "../../shared/profilerTypes";

const BYTES_PER_ROW = 16;

type Region = "chip" | "slow";

// Props shared across every row via the v2 rowProps channel (must not contain
// ariaAttributes/index/style — see TimeView.tsx).
//
// CRITICAL: never put the reconstructed Uint8Array (up to ~2MB) directly in this object. React's
// *development* build deep-walks every prop value on every render for its DevTools/profiler
// instrumentation (see modelStore.ts's comment — the whole reason the big profile model lives
// outside React state/props in the first place); a multi-megabyte typed array sitting in a prop
// costs ~1-2s PER RENDER to walk, not just when it changes, which made this tab appear to hang
// while scrubbing. `getByte`/`bufVersion` give rows fresh data through a stable function + a
// cheap version number instead, so the actual bytes never enter React's prop tree.
type RowListProps = {
  getByte: (off: number) => number | undefined; // reads the *current* reconstructed buffer
  bufLength: number;
  bufVersion: number; // changes exactly when the reconstructed buffer's contents change, to force a row repaint
  baseAddr: number; // address of offset 0 in the buffer (0 for chip, SLOW_BASE for slow)
  highlightOffset: number | undefined; // byte written at the selected cycle, if any, in this region
  onByteClick: (addr: number) => void;
};

const toAscii = (b: number): string => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".");

function RowRenderer({ index, style, getByte, baseAddr, highlightOffset, onByteClick }: RowComponentProps<RowListProps>) {
  const rowOff = index * BYTES_PER_ROW;
  const addr = baseAddr + rowOff;
  const cells: { hex: string; ascii: string; off: number; present: boolean }[] = [];
  for (let i = 0; i < BYTES_PER_ROW; i++) {
    const off = rowOff + i;
    const b = getByte(off);
    cells.push({
      hex: b !== undefined ? b.toString(16).padStart(2, "0") : "  ",
      ascii: b !== undefined ? toAscii(b) : " ",
      off,
      present: b !== undefined,
    });
  }
  return (
    <div className="mem-row" style={style}>
      <span className="mem-addr">${addr.toString(16).padStart(6, "0")}</span>
      <span className="mem-hex">
        {cells.map((c) => (
          <span
            key={c.off}
            className={"mem-byte" + (c.off === highlightOffset ? " mem-hit" : "")}
            onClick={c.present ? () => onByteClick(baseAddr + c.off) : undefined}
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
// jumps the playhead to the most recent write that produced it.
export function MemoryView({
  selectedSlot,
  onSelectSlot,
}: {
  selectedSlot: number | undefined;
  onSelectSlot: (slot: number) => void;
}) {
  const model = getProfileModel();
  const dma = model?.dma;
  const snapshot = model?.dmaSnapshot;
  const [region, setRegion] = useState<Region>("chip");
  const [follow, setFollow] = useState(true);
  const [goTo, setGoTo] = useState("");
  const listRef = useRef<ListImperativeAPI>(null);

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

  // The reconstructed buffers, kept OUT of props (see RowListProps' comment) behind a ref that
  // rows read through `getByte`. Refs may only be written in effects/handlers, not during render
  // (react-hooks/refs) — a plain ref write with no setState call avoids the cascading-render
  // problem that motivated dropping the separate bufVersion state below. `debouncedSlot` stands in
  // for a version number in rowProps: it's guaranteed to change exactly when `recon` does (recon's
  // only non-stable dependency), so it forces a row repaint without a separate counter.
  const chipRef = useRef<Uint8Array>(new Uint8Array(0));
  const slowRef = useRef<Uint8Array>(new Uint8Array(0));
  useEffect(() => {
    chipRef.current = recon?.chip ?? chipRef.current;
    slowRef.current = recon?.slow ?? slowRef.current;
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
  // last-seen currentWrite; the user can still override `region` manually via the dropdown.
  const [lastWrite, setLastWrite] = useState(currentWrite);
  if (currentWrite !== lastWrite) {
    setLastWrite(currentWrite);
    if (follow && currentWrite) setRegion(currentWrite.region);
  }

  useEffect(() => {
    if (follow && currentWrite && currentWrite.region === region) {
      listRef.current?.scrollToRow({ index: Math.floor(currentWrite.offset / BYTES_PER_ROW), align: "smart" });
    }
  }, [follow, currentWrite, region]);

  const bufLength = region === "chip" ? recon?.chip.length : recon?.slow.length;
  const baseAddr = region === "chip" ? 0 : SLOW_BASE;
  const rowCount = bufLength ? Math.ceil(bufLength / BYTES_PER_ROW) : 0;

  const getByte = useCallback(
    (off: number): number | undefined => {
      const buf = region === "chip" ? chipRef.current : slowRef.current;
      return off < buf.length ? buf[off] : undefined;
    },
    [region],
  );

  const onByteClick = useCallback(
    (addr: number) => {
      if (!dma) return;
      const found = findPrevMemWrite(dma, addr, slot + 1);
      if (found !== undefined) onSelectSlot(found);
    },
    [dma, slot, onSelectSlot],
  );

  const rowProps = useMemo<RowListProps>(
    () => ({
      getByte,
      bufLength: bufLength ?? 0,
      bufVersion: debouncedSlot,
      baseAddr,
      highlightOffset: currentWrite && currentWrite.region === region ? currentWrite.offset : undefined,
      onByteClick,
    }),
    [getByte, bufLength, debouncedSlot, baseAddr, currentWrite, region, onByteClick],
  );

  const jumpTo = () => {
    if (!snapshot) return;
    const addr = parseInt(goTo.replace(/^\$|^0x/i, ""), 16);
    if (Number.isNaN(addr)) return;
    const resolved = resolveMemoryRegion(addr, snapshot);
    if (!resolved) return;
    setRegion(resolved.region);
    listRef.current?.scrollToRow({ index: Math.floor(resolved.offset / BYTES_PER_ROW), align: "start" });
  };

  if (!model) return null;
  if (!dma || !snapshot || !bufLength) {
    return <div className="hint">No memory snapshot for this frame.</div>;
  }

  return (
    <div className="memoryview">
      <div className="mem-toolbar">
        <select value={region} onChange={(e) => setRegion(e.target.value as Region)}>
          <option value="chip">Chip RAM</option>
          {snapshot.slow.length > 0 && <option value="slow">Slow RAM</option>}
        </select>
        <input
          className="mem-goto"
          placeholder="Go to address ($..)"
          value={goTo}
          onChange={(e) => setGoTo(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && jumpTo()}
        />
        <label className="mem-follow">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Follow writes
        </label>
      </div>
      <div className="mem-rows">
        <List listRef={listRef} rowComponent={RowRenderer} rowProps={rowProps} rowCount={rowCount} rowHeight={18} />
      </div>
    </div>
  );
}
