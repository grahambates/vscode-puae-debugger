import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import "./App.css";
import { ProfilerOutboundMessage, ISymbol, IProfileModel, IDmaModel, ComputeRangeMessage, DMA_HPOS, DMA_VPOS, ReadSourceFileMessage, BusOwner } from "../../shared/profilerTypes";
import { unpackBulk } from "../../profilerBulk";
import { createHostBridge, HostBridge } from "../shared/hostBridge";
import { setProfileModel, getProfileModel, useModelVersion } from "./modelStore";
import { FlameGraph } from "./FlameGraph";
import { TimeView } from "./TimeView";
import { CustomRegsView } from "./CustomRegsView";
import { CopperView } from "./CopperView";
import { BlitterView } from "./BlitterView";
import { MemoryView } from "./MemoryView";
import { DisassemblyView } from "./DisassemblyView";
import { ResourcesView } from "./ResourcesView";
import { createTopDownGraph } from "./topDownGraph";
import { createBottomUpGraph } from "./bottomUpGraph";
import { DisplayUnit, unitOptions, Timing } from "./display";
import { IRichFilter } from "./filter";
import { findLineExecutionSlot } from "./columns";

const bridge: HostBridge =
  createHostBridge("/profiler/rpc") ??
  (() => {
    throw new Error("Profiler webview requires a vscode or standalone host bridge");
  })();

type TabId = "time" | "customregs" | "copper" | "blitter" | "memory" | "disasm" | "screen";
const TAB_LABELS: Record<TabId, string> = {
  time: "Time View", customregs: "Custom Registers", copper: "Copper",
  blitter: "Blitter", memory: "Memory", disasm: "CPU", screen: "Screen",
};
const ALL_TABS: TabId[] = ["time", "disasm", "copper", "blitter", "memory", "customregs", "screen"];

interface FrameInfo {
  model: IProfileModel;
  thumbUrl?: string;     // blob: URL of the small filmstrip JPEG
  fullFrameUrl?: string; // blob: URL of the full-resolution JPEG (for hover-to-enlarge)
  dmaBar?: Array<{ color: string; flex: number }>; // precomputed stacked bar segments
  // True iff this frame's pixels are byte-identical to the previous frame's — flagged in the
  // filmstrip so a slower-than-refresh-rate effect's real update rate is visible at a glance.
  duplicateOfPrevious?: boolean;
}

// Compute stacked DMA bar segments from a frame's owner array (BusOwner ordinals).
// Grouped: BLITTER, BPL1-8, SPRITE0-7, AUD0-3, COPPER, CPU, REFRESH, DISK, idle (NONE/BLOCKED).
// Colors match dma.ts's OWNER_STYLE/CPU_CODE — one representative color per group rather than
// per-channel (e.g. every bitplane shares BPL1's color) since this is a coarse thumbnail-sized bar.
function computeDmaBar(owner: Uint8Array | undefined): Array<{ color: string; flex: number }> | undefined {
  if (!owner || owner.length === 0) return undefined;
  const c = new Int32Array(8); // [blitter, bpl, spr, aud, cop, cpu, refresh, disk]
  let idle = 0;
  for (let i = 0; i < owner.length; i++) {
    const o = owner[i];
    if      (o === BusOwner.BLITTER)                          c[0]++;
    else if (o >= BusOwner.BPL1 && o <= BusOwner.BPL8)        c[1]++;
    else if (o >= BusOwner.SPRITE0 && o <= BusOwner.SPRITE7)  c[2]++;
    else if (o >= BusOwner.AUD0 && o <= BusOwner.AUD3)        c[3]++;
    else if (o === BusOwner.COPPER)                           c[4]++;
    else if (o === BusOwner.CPU)                              c[5]++;
    else if (o === BusOwner.REFRESH)                          c[6]++;
    else if (o === BusOwner.DISK)                             c[7]++;
    else                                                       idle++; // NONE, BLOCKED
  }
  const COLORS = ["rgb(0,136,136)","rgb(0,0,255)","rgb(255,0,255)","rgb(255,0,0)",
                  "rgb(238,238,0)","rgb(162,83,66)","rgb(68,68,68)","rgb(255,255,255)"];
  const segs: Array<{ color: string; flex: number }> = [];
  for (let i = 0; i < 8; i++) {
    if (c[i] > 0) segs.push({ color: COLORS[i], flex: c[i] });
  }
  if (idle > 0) segs.push({ color: "rgba(255,255,255,0.07)", flex: idle });
  return segs.length > 0 ? segs : undefined;
}

// Loose path equality for matching a jumpToExecutionAtLine message's file (VS Code's
// editor.document.uri.fsPath, sent as-is from the extension) against IDisassembledInstruction.file
// (resolved by the extension-side SourceMap) — no Node "path" module in the webview bundle, so
// this just tolerates separator/case differences rather than doing full path normalization.
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

export function App() {
  useModelVersion(); // re-render when the model changes (the model lives in modelStore, not state)
  const model = getProfileModel();
  const [error, setError] = useState<string | null>(null);
  // Starts busy: the extension auto-captures one frame as soon as we signal "ready",
  // so we show "Capturing…" immediately rather than the click-to-capture hint.
  const [busy, setBusy] = useState(true);
  const [unit, setUnit] = useState<DisplayUnit>(DisplayUnit.PercentFrame);
  const [filterText, setFilterText] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  // The pinned DMA-cycle cursor, shared between the flame graph (which sets it on click) and the
  // custom-registers view (which reads it). Reset on a fresh capture, below.
  const [selectedSlot, setSelectedSlot] = useState<number | undefined>(undefined);
  // "Latest ref" for selectedSlot — the jumpToExecutionAtLine message handler (registered once,
  // [] deps, see the message-listener effect below) needs the CURRENT slot to search forward
  // from, not whatever it was when the listener was first attached.
  const selectedSlotRef = useRef(selectedSlot);
  useEffect(() => { selectedSlotRef.current = selectedSlot; }, [selectedSlot]);
  const [leftTab, setLeftTab] = useState<TabId>("time");
  const [rightTab, setRightTab] = useState<TabId>("memory");
  // Split mode for the right pane: "none" = single panel, "h" = side-by-side, "v" = stacked.
  const [splitMode, setSplitMode] = useState<"none" | "h" | "v">("none");
  const [splitRatio, setSplitRatio] = useState(0.5); // fraction of first dimension (width or height)
  const panelContainerRef = useRef<HTMLDivElement>(null);
  // Manual override for the flame graph's height (px), set by dragging .split-divider.
  // undefined = FlameGraph auto-sizes to the (capped) call-stack depth, as before.
  const [flameHeightPx, setFlameHeightPx] = useState<number | undefined>(undefined);
  const splitPaneRef = useRef<HTMLDivElement>(null);
  // Time View's tree direction: top-down (call-tree, "what does main() spend time in") or
  // bottom-up (leaf→callers, "what does Foo's time actually come from").
  const [treeMode, setTreeMode] = useState<"top" | "bottom">("top");
  // "file" = a loaded .puaeprofile (read-only): no live Capture/Save. The host bakes the
  // mode into #root so it's known at init and holds even if no model ever arrives.
  const [mode] = useState<"live" | "file">(() =>
    document.getElementById("root")?.dataset.mode === "file" ? "file" : "live",
  );
  // Symbols are session-constant, so the host sends them only on the first capture; cache
  // them here and merge into every model so the rest of the webview always sees model.symbols.
  const symbolsRef = useRef<ISymbol[] | undefined>(undefined);
  // The workspace folder's fsPath (sent with every captureResult), for displaying source paths
  // relative to it in the flame graph hover — see FlameGraph's `workspaceRoot` prop.
  const [workspaceRoot, setWorkspaceRoot] = useState<string | undefined>(undefined);
  // One-shot "jump to this address in the Memory tab's visual mode" request, set by clicking a
  // channel pointer in the Blitter view's detail pane. A fresh object every time (even a repeat
  // address) so MemoryView's effect re-fires — see its `jumpRequest` prop. `bytesPerRow` is that
  // channel's actual row stride (BlitDetail.tsx's channelStrideBytes), for aligning visual mode.
  const [memoryJumpRequest, setMemoryJumpRequest] = useState<{ address: number; bytesPerRow?: number } | undefined>(undefined);

  // Multi-frame filmstrip state.
  const [frames, setFrames] = useState<FrameInfo[]>([]);
  // frameIndex is the anchor for shift-click selection (last frame explicitly clicked).
  const [frameIndex, setFrameIndex] = useState(0);
  // selectedRange: null = single frame (frameIndex), [a,b] = inclusive range of frames.
  // [0, N-1] = all frames (uses pre-built combinedModel); any other range = partial (uses rangeModel).
  const [selectedRange, setSelectedRange] = useState<[number, number] | null>(null);
  const [numFrames, setNumFrames] = useState(1);
  const [numFramesText, setNumFramesText] = useState("1");
  // Combined model built server-side from all N frames' InstructionSamples. Can't be derived
  // client-side from IProfileModel.samples because those are call-tree node IDs local to each
  // model's own nodes[] array — concatenating them would reference wrong nodes.
  const [combinedModel, setCombinedModel] = useState<IProfileModel | null>(null);
  // Model built server-side for a partial frame range (shift-click selection).
  const [rangeModel, setRangeModel] = useState<IProfileModel | null>(null);
  // Cache of source file content for the disassembly "Show source" toggle.
  // null = requested but not yet received; string[] = loaded lines (0-indexed).
  const [sourceFiles, setSourceFiles] = useState<Map<string, string[] | null>>(new Map());
  // Track blob URLs so we can revoke them when frames are replaced (prevents memory leaks).
  const prevThumbUrlsRef = useRef<string[]>([]);
  // Filmstrip hover-to-enlarge state: which rect the pointer is over + the full-res JPEG URL.
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const [hoveredFullFrameUrl, setHoveredFullFrameUrl] = useState<string | null>(null);

  // Concatenate the selected range's DMA grids into one continuous timeline, matching the
  // combined flame-graph x-axis. Each frame contributes DMA_HPOS*DMA_VPOS slots.
  const combinedDma = useMemo<IDmaModel | undefined>(() => {
    if (!selectedRange) return undefined;
    const [a, b] = selectedRange;
    const grids = frames.slice(a, b + 1).map(f => f.model.dma).filter((d): d is IDmaModel => !!d);
    if (!grids.length) return undefined;
    if (grids.length === 1) return grids[0];
    const total = grids.reduce((s, d) => s + d.owner.length, 0);
    const owner  = new Uint8Array(total);
    const flags  = new Uint8Array(total);
    const addr   = new Uint32Array(total);
    const value  = new Uint16Array(total);
    const events = grids.every(d => d.events) ? new Uint32Array(total) : undefined;
    let off = 0;
    for (const d of grids) {
      owner.set(d.owner, off);
      flags.set(d.flags, off);
      addr.set(d.addr, off);
      value.set(d.value, off);
      if (events && d.events) events.set(d.events, off);
      off += d.owner.length;
    }
    return { owner, flags, addr, value, events };
  }, [selectedRange, frames]);

  // Switch the active model when frame selection or range changes.
  useEffect(() => {
    if (!selectedRange) {
      const m = frames[frameIndex]?.model;
      if (!m) return;
      // Multi-frame captures: snapshot (2.5 MB) and copper trace are only stored on the last
      // frame to avoid per-frame duplication. Propagate them to whichever frame is selected so
      // Copper / Screen / Custom Registers tabs remain usable across the whole filmstrip.
      const lastFrame = frames[frames.length - 1]?.model;
      const needsMerge = lastFrame && lastFrame !== m && (!m.dmaSnapshot || !m.copper);
      setProfileModel(needsMerge
        ? { ...m, dmaSnapshot: m.dmaSnapshot ?? lastFrame.dmaSnapshot, copper: m.copper ?? lastFrame.copper }
        : m
      );
      return;
    }
    const [a, b] = selectedRange;
    const isAll = a === 0 && b === frames.length - 1;
    const baseModel = isAll ? combinedModel : rangeModel;
    if (!baseModel) return; // waiting for rangeResult
    // Snapshot and copper live only on the last frame (too large to duplicate per frame).
    // Prefer frames[b] (end of selected range) then fall back to the last captured frame
    // so partial ranges that don't include the last frame still have working views.
    const lastFrame = frames[frames.length - 1]?.model;
    const m = {
      ...baseModel,
      dma: combinedDma,
      dmaSnapshot: frames[b]?.model.dmaSnapshot ?? lastFrame?.dmaSnapshot,
      copper:      frames[b]?.model.copper      ?? lastFrame?.copper,
    };
    setProfileModel(m);
  }, [selectedRange, combinedModel, rangeModel, combinedDma, frameIndex, frames]);

  // When a partial range is selected, request the combined model from the extension host.
  // All-frames range [0, N-1] reuses the pre-built combinedModel instead.
  useEffect(() => {
    if (!selectedRange) return;
    const [a, b] = selectedRange;
    if (a === 0 && b === frames.length - 1) return; // all-frames: use combinedModel
    setRangeModel(null); // eslint-disable-line react-hooks/set-state-in-effect
    bridge.postMessage({ command: "computeRange", range: [a, b] } as ComputeRangeMessage);
  }, [selectedRange, frames.length]);

  useEffect(() => {
    bridge.postMessage({ command: "ready" });
  }, []);

  useEffect(() => {
    const handle = (message: unknown) => {
      const m = message as ProfilerOutboundMessage;
      if (m.command === "captureResult") {
        setSelectedSlot(0);
        setWorkspaceRoot(m.workspaceRoot);
        // Symbols are sent only in frames[0] on the first post; cache and merge into all frames.
        const firstModel = m.frames[0]?.model;
        if (firstModel?.symbols) symbolsRef.current = firstModel.symbols;

        // Revoke previous thumbnail and full-frame blob URLs before replacing them.
        for (const url of prevThumbUrlsRef.current) URL.revokeObjectURL(url);
        prevThumbUrlsRef.current = [];

        // Fetch all frame bulk blobs in parallel, then update state once all are ready.
        const framePromises = m.frames.map((fi) => {
          const base = symbolsRef.current ? { ...fi.model, symbols: symbolsRef.current } : fi.model;
          const duplicateOfPrevious = fi.duplicateOfPrevious;
          if (!fi.bulkUri) return Promise.resolve({ model: base, duplicateOfPrevious });
          return fetch(fi.bulkUri)
            .then((r) => r.arrayBuffer())
            .then((buf) => {
              const { dma, dmaSnapshot, copper, registers, thumbnail, fullFrame } = unpackBulk(buf);
              let thumbUrl: string | undefined;
              if (thumbnail) {
                // thumbnail.data is a fresh Uint8Array copy (byteOffset 0), so its .buffer
                // is a standalone ArrayBuffer — cast is safe and avoids a redundant copy.
                thumbUrl = URL.createObjectURL(new Blob([thumbnail.data.buffer as ArrayBuffer], { type: "image/jpeg" }));
              }
              let fullFrameUrl: string | undefined;
              if (fullFrame) {
                fullFrameUrl = URL.createObjectURL(new Blob([fullFrame.data.buffer as ArrayBuffer], { type: "image/jpeg" }));
              }
              return { model: { ...base, dma, dmaSnapshot, copper, registers } as IProfileModel, thumbUrl, fullFrameUrl, dmaBar: computeDmaBar(dma?.owner), duplicateOfPrevious };
            })
            .catch((e) => {
              console.warn("[profiler] bulk fetch failed:", e);
              return { model: base, duplicateOfPrevious }; // render without DMA rather than nothing
            });
        });

        Promise.all(framePromises)
          .then((results) => {
            const newFrames: FrameInfo[] = results;
            // A duplicate frame's own thumbnail/full-frame JPEGs are (deterministically)
            // byte-identical to the previous frame's — reuse that frame's blob URLs instead of
            // holding a second live Blob for pixel data that's already showing on screen.
            for (let i = 1; i < newFrames.length; i++) {
              if (!newFrames[i].duplicateOfPrevious) continue;
              if (newFrames[i].thumbUrl && newFrames[i - 1].thumbUrl) {
                URL.revokeObjectURL(newFrames[i].thumbUrl!);
                newFrames[i].thumbUrl = newFrames[i - 1].thumbUrl;
              }
              if (newFrames[i].fullFrameUrl && newFrames[i - 1].fullFrameUrl) {
                URL.revokeObjectURL(newFrames[i].fullFrameUrl!);
                newFrames[i].fullFrameUrl = newFrames[i - 1].fullFrameUrl;
              }
            }
            // Track all blob URLs for revocation — both small thumbnails and full frames.
            // (De-duped via Set: reused URLs above would otherwise appear multiple times, which
            // is harmless for revokeObjectURL but pointless.)
            prevThumbUrlsRef.current = [...new Set(newFrames.flatMap((f) =>
              [f.thumbUrl, f.fullFrameUrl].filter(Boolean) as string[]
            ))];
            setFrames(newFrames);
            setFrameIndex(0);
            setSelectedRange(null);
            setRangeModel(null);
            // Merge symbols into the server-built combined model (symbols are cached in
            // symbolsRef and omitted from subsequent posts to save bandwidth).
            if (m.combinedModel) {
              const syms = symbolsRef.current;
              setCombinedModel(syms ? { ...m.combinedModel, symbols: syms } : m.combinedModel);
            } else {
              setCombinedModel(null);
            }
            // modelStore update is handled by the frameIndex/frames effect above, but trigger it
            // now for the first frame to avoid a render with stale model.
            if (newFrames[0]) setProfileModel(newFrames[0].model);
          })
          .finally(() => {
            setError(null);
            setBusy(false);
          });
      } else if (m.command === "rangeResult") {
        const syms = symbolsRef.current;
        setRangeModel(syms ? { ...m.model, symbols: syms } : m.model);
      } else if (m.command === "showError") {
        setError(m.error);
        setBusy(false);
      } else if (m.command === "capturing") {
        setBusy(true);
        setError(null);
      } else if (m.command === "sourceFile") {
        setSourceFiles(prev => new Map(prev).set(m.file, m.lines));
      } else if (m.command === "jumpToExecutionAtLine") {
        // "Jump to Next Execution in Profiler" editor context-menu command (extension.ts /
        // profilerLineDecorationProvider.ts). Always opens in the left panel, same as TimeView's
        // own function-name jump.
        const curModel = getProfileModel();
        const slot = curModel
          ? findLineExecutionSlot(curModel, m.file, m.line, selectedSlotRef.current, (a, b) => normalizePath(a) === normalizePath(b))
          : undefined;
        if (slot !== undefined) {
          setSelectedSlot(slot);
          setLeftTab("disasm");
        }
      } else if (m.command === "downloadProfile") {
        // Standalone host only (StandaloneProfilerViewerProvider) — there's no native save
        // dialog outside vscode, so trigger a normal browser download instead.
        const bytes = Uint8Array.from(atob(m.dataBase64), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = m.fileName;
        a.click();
        URL.revokeObjectURL(url);
      }
    };
    return bridge.onMessage(handle);
  }, []);

  // Revoke thumbnail blob URLs on unmount.
  useEffect(() => {
    return () => {
      for (const url of prevThumbUrlsRef.current) URL.revokeObjectURL(url);
    };
  }, []);

  const capture = () => {
    setBusy(true);
    bridge.postMessage({ command: "capture" });
  };

  const save = () => bridge.postMessage({ command: "saveProfile" });

  const openSource = useCallback(
    (file: string, line: number, toSide: boolean) =>
      bridge.postMessage({ command: "openDocument", file, line, toSide }),
    [],
  );

  // Request source file content from the extension host. Marks the file as pending (null)
  // immediately so repeat calls (e.g. from re-renders before the response arrives) are no-ops.
  const requestSourceFile = useCallback((file: string) => {
    setSourceFiles(prev => {
      if (prev.has(file)) return prev; // already requested or loaded
      bridge.postMessage({ command: "readSourceFile", file } as ReadSourceFileMessage);
      return new Map(prev).set(file, null);
    });
  }, []);

  const filter = useMemo<IRichFilter>(
    () => ({ text: filterText, caseSensitive, regex: useRegex }),
    [filterText, caseSensitive, useRegex],
  );

  // Screen reconstruction always uses the single frame at frameIndex, regardless of
  // range selection — combining N frames' DMA grids produces N stacked screens.
  const screenModel = useMemo(() => {
    const base = frames[frameIndex]?.model;
    if (!base) return null;
    const lastFrame = frames[frames.length - 1]?.model;
    const needsMerge = lastFrame && lastFrame !== base && (!base.dmaSnapshot || !base.copper);
    return needsMerge
      ? { ...base, dmaSnapshot: base.dmaSnapshot ?? lastFrame.dmaSnapshot, copper: base.copper ?? lastFrame.copper }
      : base;
  }, [frames, frameIndex]);

  const timing = useMemo<Timing>(
    () => model
      ? { cyclesPerMicroSecond: model.cyclesPerMicroSecond, duration: model.duration, numFrames: selectedRange ? (selectedRange[1] - selectedRange[0] + 1) : 1 }
      : { cyclesPerMicroSecond: 7.09379, duration: 1 },
    [model, selectedRange],
  );

  const dataTable = useMemo(
    () =>
      model
        ? Object.values((treeMode === "top" ? createTopDownGraph(model) : createBottomUpGraph(model)).children)
        : [],
    [model, treeMode],
  );

  // Drag the panel divider to resize the split. Works for both h (col-resize) and v (row-resize).
  const onPanelDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = panelContainerRef.current;
    if (!container) return;
    const isH = splitMode === "h";
    document.body.style.cursor = isH ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    const rect = container.getBoundingClientRect();
    const origin = isH ? rect.left : rect.top;
    const size = isH ? rect.width : rect.height;
    const onMove = (me: MouseEvent) => {
      const pos = isH ? me.clientX : me.clientY;
      setSplitRatio(Math.max(0.2, Math.min(0.8, (pos - origin) / size)));
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [splitMode]);

  // Drag the divider between the flame graph and the tabs below it. Sets an explicit pixel
  // height (clamped to [15%, 85%] of the split-pane) that overrides FlameGraph's own
  // content-driven auto height until the panel is reset by a fresh capture.
  const onFlameDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = splitPaneRef.current;
    if (!container) return;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    const rect = container.getBoundingClientRect();
    const onMove = (me: MouseEvent) => {
      const h = Math.max(rect.height * 0.15, Math.min(rect.height * 0.85, me.clientY - rect.top));
      setFlameHeightPx(h);
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  // Render the content for a given tab (shared between left and right panels). `setTab` is the
  // specific panel's own tab-setter, so a click-to-jump feature (Time View's function names)
  // opens the CPU tab in whichever panel it was clicked from, not always a fixed one.
  const renderTabContent = (tab: TabId, setTab: (t: TabId) => void) => {
    if (tab === "time") return (
      <div className="time-mode-wrap">
        <div className="time-mode-toggle">
          <button
            className={"time-mode-btn" + (treeMode === "top" ? " active" : "")}
            onClick={() => setTreeMode("top")}
            title="Call tree from the root down — what each function spends its time in"
          >
            Top Down
          </button>
          <button
            className={"time-mode-btn" + (treeMode === "bottom" ? " active" : "")}
            onClick={() => setTreeMode("bottom")}
            title="Reversed call tree from each leaf up — where each function's time actually comes from"
          >
            Bottom Up
          </button>
        </div>
        <TimeView
          data={dataTable}
          filter={filter}
          displayUnit={unit}
          timing={timing}
          onOpenSource={openSource}
          hideTotalTime={treeMode === "bottom"}
          selectedSlot={selectedSlot}
          onSelectSlot={setSelectedSlot}
          onOpenCpuTab={() => setTab("disasm")}
        />
      </div>
    );
    if (tab === "customregs") return <CustomRegsView selectedSlot={selectedSlot} onSelectSlot={setSelectedSlot} />;
    if (tab === "copper") {
      // In combined multi-frame mode, selectedSlot spans N × frameSlots. The copper
      // trace is from one frame, but the copper list restarts at vpos 0 each frame —
      // so every frame shares the same slot-space layout. Modulo maps any frame's
      // playhead to the equivalent position in the single-frame copper trace.
      // On row-click, map back into the frame band the playhead was already in.
      const frameSlots = DMA_HPOS * DMA_VPOS;
      const copperSlot = selectedSlot !== undefined && selectedRange
        ? selectedSlot % frameSlots
        : selectedSlot;
      const onCopperSelectSlot = (slot: number) => {
        if (!selectedRange || selectedSlot === undefined) { setSelectedSlot(slot); return; }
        setSelectedSlot(Math.floor(selectedSlot / frameSlots) * frameSlots + slot);
      };
      return <CopperView selectedSlot={copperSlot} onSelectSlot={onCopperSelectSlot} onOpenSource={openSource} />;
    }
    if (tab === "blitter") return (
      <BlitterView
        selectedSlot={selectedSlot}
        onSelectSlot={setSelectedSlot}
        displayUnit={unit}
        timing={timing}
        onOpenMemory={(address, bytesPerRow) => {
          setMemoryJumpRequest({ address, bytesPerRow });
          setTab("memory");
        }}
      />
    );
    if (tab === "memory") return <MemoryView selectedSlot={selectedSlot} onSelectSlot={setSelectedSlot} onOpenSource={openSource} jumpRequest={memoryJumpRequest} />;
    if (tab === "screen") return <ResourcesView selectedSlot={selectedSlot} model={screenModel} />;
    return <DisassemblyView selectedSlot={selectedSlot} onSelectSlot={setSelectedSlot} onOpenSource={openSource} sourceFiles={sourceFiles} onRequestSourceFile={requestSourceFile} />;
  };

  // Render a single tab panel (tab bar + content). `isLeft` controls which panel
  // carries the split toggle button (only the left/only panel should show it).
  // `panelStyle` sets the panel's width (explicit % when split, flex:1 otherwise).
  const renderPanel = (tab: TabId, setTab: (t: TabId) => void, isLeft: boolean, panelStyle?: React.CSSProperties) => (
    <div className="right-panel" style={panelStyle}>
      <div className="right-tabs">
        {ALL_TABS.map((id) => (
          <button
            key={id}
            className={"right-tab" + (tab === id ? " active" : "")}
            onClick={() => setTab(id)}
          >
            {TAB_LABELS[id]}
          </button>
        ))}
        {isLeft && (
          <div className="right-tabs-split-group">
            <button
              className={"right-tab right-tab-split" + (splitMode === "h" ? " active" : "")}
              onClick={() => setSplitMode((m) => m === "h" ? "none" : "h")}
              title={splitMode === "h" ? "Close split" : "Split side by side"}
            >
              <span className="codicon codicon-split-horizontal" />
            </button>
            <button
              className={"right-tab right-tab-split" + (splitMode === "v" ? " active" : "")}
              onClick={() => setSplitMode((m) => m === "v" ? "none" : "v")}
              title={splitMode === "v" ? "Close split" : "Split top and bottom"}
            >
              <span className="codicon codicon-split-vertical" />
            </button>
          </div>
        )}
      </div>
      {renderTabContent(tab, setTab)}
    </div>
  );

  return (
    <div className="profiler">
      <div className="toolbar">
        {mode === "live" && (
          <>
            <div className="capture-group">
              <button className="capture-btn" onClick={capture} disabled={busy}>
                Capture
              </button>
              <input
                className="frames-input"
                type="number"
                min={1}
                max={500}
                value={numFramesText}
                disabled={busy}
                onChange={(e) => {
                  setNumFramesText(e.target.value);
                  const n = parseInt(e.target.value, 10);
                  if (!Number.isNaN(n) && n >= 1 && n <= 500) {
                    setNumFrames(n);
                    bridge.postMessage({ command: "setNumFrames", numFrames: n });
                  }
                }}
                onBlur={() => setNumFramesText(String(numFrames))}
              />
              <label className="frames-label" title="Number of frames to capture per click">frame(s)</label>
            </div>
          </>
        )}
        {model && (
          <>
            <div className="filter-box">
              <input
                className="filter"
                type="text"
                placeholder="Filter functions or files"
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
              />
              <button
                className={"toggle" + (caseSensitive ? " active" : "")}
                title="Match Case"
                onClick={() => setCaseSensitive((v) => !v)}
              >
                Aa
              </button>
              <button
                className={"toggle" + (useRegex ? " active" : "")}
                title="Use Regular Expression"
                onClick={() => setUseRegex((v) => !v)}
              >
                .*
              </button>
            </div>
            <select
              className="unit"
              value={unit}
              onChange={(e) => setUnit(Number(e.target.value) as DisplayUnit)}
            >
              {unitOptions.map((o) => (
                <option key={o.unit} value={o.unit}>
                  {o.label}
                </option>
              ))}
            </select>
            {mode === "live" && (
              <button onClick={save} disabled={busy || !model} title="Save this capture to a .puaeprofile file">
                Save profile
              </button>
            )}
          </>
        )}
      </div>
      {hoveredFullFrameUrl && hoverRect && (
        <div
          className="filmstrip-fullframe-popup"
          style={{ left: 4, top: hoverRect.bottom + 8 }}
        >
          <img src={hoveredFullFrameUrl} alt="" />
        </div>
      )}
      {frames.length > 1 && (
        <div className="filmstrip" role="listbox" aria-label="Captured frames">
          {(() => {
            const isAllSelected = selectedRange !== null && selectedRange[0] === 0 && selectedRange[1] === frames.length - 1;
            return (
              <>
                <button
                  className={"filmstrip-frame" + (isAllSelected ? " active" : "")}
                  title="Combine all frames — totals in flame graph, time view and disassembly"
                  role="option"
                  aria-selected={isAllSelected}
                  onClick={() => setSelectedRange([0, frames.length - 1])}
                >
                  <span className="filmstrip-no-thumb">All</span>
                </button>
                {frames.map((f, i) => {
                  const inRange = selectedRange !== null
                    ? i >= selectedRange[0] && i <= selectedRange[1]
                    : i === frameIndex;
                  return (
                    <button
                      key={i}
                      className={"filmstrip-frame" + (inRange ? " active" : "")}
                      title={`Frame ${i + 1}${f.duplicateOfPrevious ? " — identical to previous frame" : ""}${frames.length > 1 ? " (Shift-click to select a range)" : ""}`}
                      role="option"
                      aria-selected={inRange}
                      onClick={(e) => {
                        if (e.shiftKey && frames.length > 1) {
                          const a = Math.min(frameIndex, i);
                          const b = Math.max(frameIndex, i);
                          setSelectedRange(a === b ? null : [a, b]);
                          if (a === b) setFrameIndex(i);
                        } else {
                          setSelectedRange(null);
                          setFrameIndex(i);
                        }
                      }}
                      onMouseEnter={f.fullFrameUrl ? (e) => {
                        setHoverRect((e.currentTarget as HTMLElement).getBoundingClientRect());
                        setHoveredFullFrameUrl(f.fullFrameUrl!);
                      } : undefined}
                      onMouseLeave={f.fullFrameUrl ? () => {
                        setHoverRect(null);
                        setHoveredFullFrameUrl(null);
                      } : undefined}
                    >
                      {f.thumbUrl
                        ? <img src={f.thumbUrl} alt={`Frame ${i + 1}`} />
                        : <span className="filmstrip-no-thumb">{i + 1}</span>}
                      {f.duplicateOfPrevious && <span className="dup-badge" aria-hidden="true">=</span>}
                      <div className="dma-bar" aria-hidden="true">
                        {f.dmaBar?.map((s, si) => <div key={si} style={{ background: s.color, flex: s.flex }} />)}
                      </div>
                    </button>
                  );
                })}
              </>
            );
          })()}
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {(model && !busy) ? (
        <div className="split-pane" ref={splitPaneRef}>
          <FlameGraph
            displayUnit={unit}
            filter={filter}
            onOpenSource={openSource}
            selectedSlot={selectedSlot}
            onSelectSlot={setSelectedSlot}
            onOpenBlitterTab={() => setLeftTab("blitter")}
            onOpenMemory={(address, bytesPerRow) => {
              setMemoryJumpRequest({ address, bytesPerRow });
              setLeftTab("memory");
            }}
            heightOverridePx={flameHeightPx}
            workspaceRoot={workspaceRoot}
          />
          <div className="split-divider" onMouseDown={onFlameDividerMouseDown} />
          <div
            className={"right-pane" + (splitMode === "v" ? " right-pane-v" : "")}
            ref={panelContainerRef}
          >
            {renderPanel(leftTab, setLeftTab, true, splitMode !== "none"
              ? (splitMode === "h" ? { width: `${splitRatio * 100}%` } : { height: `${splitRatio * 100}%` })
              : { flex: 1 })}
            {splitMode !== "none" && (
              <>
                <div
                  className={"panel-divider-v" + (splitMode === "v" ? " panel-divider-h" : "")}
                  onMouseDown={onPanelDividerMouseDown}
                />
                {renderPanel(rightTab, setRightTab, false, { flex: 1 })}
              </>
            )}
          </div>
        </div>
      ) : (
        !error && (
          <div className="hint">
            {busy
              ? mode === "file"
                ? "Loading profile…"
                : numFrames === 1
                  ? "Capturing one frame of CPU execution…"
                  : `Capturing ${numFrames} frames of CPU execution…`
              : mode === "file"
                ? "No profile loaded."
                : "Click \"Capture frame\" to profile CPU execution."}
          </div>
        )
      )}
    </div>
  );
}
