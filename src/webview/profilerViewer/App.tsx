import { useState, useEffect } from "react";
import "./App.css";
import { ProfileResult, ProfilerOutboundMessage } from "../../shared/profilerTypes";
import { FlameGraph } from "./FlameGraph";

const vscode = acquireVsCodeApi();

export function App() {
  const [result, setResult] = useState<ProfileResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Starts busy: the extension auto-captures one frame as soon as we signal "ready",
  // so we show "Capturing…" immediately rather than the click-to-capture hint.
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    vscode.postMessage({ command: "ready" });
  }, []);

  useEffect(() => {
    const handle = (event: MessageEvent) => {
      const m = event.data as ProfilerOutboundMessage;
      if (m.command === "captureResult") {
        setResult(m.result);
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

  return (
    <div className="profiler">
      <div className="toolbar">
        <button onClick={capture} disabled={busy}>
          {busy ? "Capturing…" : "Capture frame"}
        </button>
        {result && (
          <span className="summary">
            {result.sampleCount.toLocaleString()} samples · {result.totalCycles.toLocaleString()} cycles ·{" "}
            {result.uniqueFrames.length} functions
          </span>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      {result ? (
        <FlameGraph result={result} />
      ) : (
        !error && <div className="hint">Click “Capture frame” to profile one frame of CPU execution.</div>
      )}
    </div>
  );
}
