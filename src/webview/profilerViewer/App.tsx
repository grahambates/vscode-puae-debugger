import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import "./App.css";
import { ProfilerOutboundMessage, ISymbol } from "../../shared/profilerTypes";
import { unpackBulk } from "../../profilerBulk";
import { setProfileModel, getProfileModel, useModelVersion } from "./modelStore";
import { FlameGraph } from "./FlameGraph";
import { TimeView } from "./TimeView";
import { CustomRegsView } from "./CustomRegsView";
import { CopperView } from "./CopperView";
import { BlitterView } from "./BlitterView";
import { MemoryView } from "./MemoryView";
import { DisassemblyView } from "./DisassemblyView";
import { createTopDownGraph } from "./topDownGraph";
import { createBottomUpGraph } from "./bottomUpGraph";
import { DisplayUnit, unitOptions, Timing } from "./display";
import { IRichFilter } from "./filter";

const vscode = acquireVsCodeApi();

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
  const [rightTab, setRightTab] = useState<"time" | "customregs" | "copper" | "blitter" | "memory" | "disasm">("time");
  // Time View's tree direction: top-down (call-tree, "what does main() spend time in") or
  // bottom-up (leaf→callers, "what does Foo's time actually come from").
  const [treeMode, setTreeMode] = useState<"top" | "bottom">("top");
  // "file" = a loaded .vamigaprofile (read-only): no live Capture/Save. The host bakes the
  // mode into #root so it's known at init and holds even if no model ever arrives.
  const [mode] = useState<"live" | "file">(() =>
    document.getElementById("root")?.dataset.mode === "file" ? "file" : "live",
  );
  // Symbols are session-constant, so the host sends them only on the first capture; cache
  // them here and merge into every model so the rest of the webview always sees model.symbols.
  const symbolsRef = useRef<ISymbol[] | undefined>(undefined);

  useEffect(() => {
    vscode.postMessage({ command: "ready" });
  }, []);

  useEffect(() => {
    const handle = (event: MessageEvent) => {
      const m = event.data as ProfilerOutboundMessage;
      if (m.command === "captureResult") {
        setSelectedSlot(undefined);
        if (m.model.symbols) symbolsRef.current = m.model.symbols;
        const base = symbolsRef.current ? { ...m.model, symbols: symbolsRef.current } : m.model;
        const bulkUri = m.bulkUri;
        if (!bulkUri) {
          setProfileModel(base);
          setError(null);
          setBusy(false);
          return;
        }
        // The big arrays (DMA grid + snapshot) arrive via a fast resource fetch, not postMessage.
        void fetch(bulkUri)
          .then((r) => r.arrayBuffer())
          .then((buf) => {
            const { dma, dmaSnapshot, copper, registers } = unpackBulk(buf);
            setProfileModel({ ...base, dma, dmaSnapshot, copper, registers });
          })
          .catch((e) => {
            console.warn("[profiler] bulk fetch failed:", e);
            setProfileModel(base); // render without DMA rather than nothing
          })
          .finally(() => {
            setError(null);
            setBusy(false);
          });
      } else if (m.command === "showError") {
        setError(m.error);
        setBusy(false);
      } else if (m.command === "capturing") {
        setBusy(true);
        setError(null);
      }
    };
    window.addEventListener("message", handle);
    return () => window.removeEventListener("message", handle);
  }, []);

  const capture = () => {
    setBusy(true);
    vscode.postMessage({ command: "capture" });
  };

  const save = () => vscode.postMessage({ command: "saveProfile" });

  const openSource = useCallback(
    (file: string, line: number, toSide: boolean) =>
      vscode.postMessage({ command: "openDocument", file, line, toSide }),
    [],
  );

  const filter = useMemo<IRichFilter>(
    () => ({ text: filterText, caseSensitive, regex: useRegex }),
    [filterText, caseSensitive, useRegex],
  );

  const timing = useMemo<Timing>(
    () => model ? { cyclesPerMicroSecond: model.cyclesPerMicroSecond, duration: model.duration } : { cyclesPerMicroSecond: 7.09379, duration: 1 },
    [model],
  );

  const dataTable = useMemo(
    () =>
      model
        ? Object.values((treeMode === "top" ? createTopDownGraph(model) : createBottomUpGraph(model)).children)
        : [],
    [model, treeMode],
  );

  return (
    <div className="profiler">
      <div className="toolbar">
        {mode === "live" && (
          <>
            <button className="capture-btn" onClick={capture} disabled={busy}>
              {busy ? "Capturing…" : "Capture frame"}
            </button>
            <button onClick={save} disabled={busy || !model} title="Save this capture to a .vamigaprofile file">
              Save
            </button>
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
          </>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      {model ? (
        <div className="split-pane">
          <FlameGraph
            displayUnit={unit}
            filter={filter}
            onOpenSource={openSource}
            selectedSlot={selectedSlot}
            onSelectSlot={setSelectedSlot}
          />
          <div className="split-divider" />
          <div className="right-pane">
            <div className="right-tabs">
              <button
                className={"right-tab" + (rightTab === "time" ? " active" : "")}
                onClick={() => setRightTab("time")}
              >
                Time View
              </button>
              <button
                className={"right-tab" + (rightTab === "customregs" ? " active" : "")}
                onClick={() => setRightTab("customregs")}
              >
                Custom Registers
              </button>
              <button
                className={"right-tab" + (rightTab === "copper" ? " active" : "")}
                onClick={() => setRightTab("copper")}
              >
                Copper
              </button>
              <button
                className={"right-tab" + (rightTab === "blitter" ? " active" : "")}
                onClick={() => setRightTab("blitter")}
              >
                Blitter
              </button>
              <button
                className={"right-tab" + (rightTab === "memory" ? " active" : "")}
                onClick={() => setRightTab("memory")}
              >
                Memory
              </button>
              <button
                className={"right-tab" + (rightTab === "disasm" ? " active" : "")}
                onClick={() => setRightTab("disasm")}
              >
                Disassembly
              </button>
            </div>
            {rightTab === "time" ? (
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
                <TimeView data={dataTable} filter={filter} displayUnit={unit} timing={timing} onOpenSource={openSource} />
              </div>
            ) : rightTab === "customregs" ? (
              <CustomRegsView selectedSlot={selectedSlot} onSelectSlot={setSelectedSlot} />
            ) : rightTab === "copper" ? (
              <CopperView selectedSlot={selectedSlot} onSelectSlot={setSelectedSlot} onOpenSource={openSource} />
            ) : rightTab === "blitter" ? (
              <BlitterView selectedSlot={selectedSlot} onSelectSlot={setSelectedSlot} displayUnit={unit} timing={timing} />
            ) : rightTab === "memory" ? (
              <MemoryView selectedSlot={selectedSlot} onSelectSlot={setSelectedSlot} onOpenSource={openSource} />
            ) : (
              <DisassemblyView selectedSlot={selectedSlot} onSelectSlot={setSelectedSlot} onOpenSource={openSource} />
            )}
          </div>
        </div>
      ) : (
        !error && (
          <div className="hint">
            {busy
              ? mode === "file"
                ? "Loading profile…"
                : "Capturing one frame of CPU execution…"
              : mode === "file"
                ? "No profile loaded."
                : "Click \"Capture frame\" to profile one frame of CPU execution."}
          </div>
        )
      )}
    </div>
  );
}
