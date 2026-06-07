import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import "./App.css";
import { IProfileModel, ProfilerOutboundMessage, ISymbol } from "../../shared/profilerTypes";
import { FlameGraph } from "./FlameGraph";
import { TimeView } from "./TimeView";
import { createTopDownGraph } from "./topDownGraph";
import { DisplayUnit, unitOptions, Timing } from "./display";
import { IRichFilter } from "./filter";

const vscode = acquireVsCodeApi();

export function App() {
  const [model, setModel] = useState<IProfileModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Starts busy: the extension auto-captures one frame as soon as we signal "ready",
  // so we show "Capturing…" immediately rather than the click-to-capture hint.
  const [busy, setBusy] = useState(true);
  const [unit, setUnit] = useState<DisplayUnit>(DisplayUnit.PercentFrame);
  const [filterText, setFilterText] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
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
        if (m.model.symbols) symbolsRef.current = m.model.symbols;
        setModel(symbolsRef.current ? { ...m.model, symbols: symbolsRef.current } : m.model);
        setError(null);
        setBusy(false);
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
    () => (model ? Object.values(createTopDownGraph(model).children) : []),
    [model],
  );

  return (
    <div className="profiler">
      <div className="toolbar">
        {mode === "live" && (
          <>
            <button onClick={capture} disabled={busy}>
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
          <FlameGraph model={model} displayUnit={unit} filter={filter} onOpenSource={openSource} />
          <div className="split-divider" />
          <TimeView data={dataTable} filter={filter} displayUnit={unit} timing={timing} onOpenSource={openSource} />
        </div>
      ) : (
        !error && <div className="hint">{"Click \"Capture frame\" to profile one frame of CPU execution."}</div>
      )}
    </div>
  );
}
