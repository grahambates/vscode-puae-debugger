import { useState, useEffect } from "react";
import "@vscode-elements/elements";
import "./App.css";
import {
  DisplayState,
  MemoryInfo,
  ShowErrorMessage,
  UpdateDisplayStateMessage,
  UpdateMemoryInfoMessage,
} from "../../shared/stateViewerTypes";
import { DisplayTab } from "./DisplayTab";
import { MemoryTab } from "./MemoryTab";

const vscode = acquireVsCodeApi();

export function App() {
  const [displayState, setDisplayState] = useState<DisplayState | null>(null);
  const [memoryInfo, setMemoryInfo] = useState<MemoryInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Send ready message on mount
  useEffect(() => {
    vscode.postMessage({ command: "ready" });
  }, []);

  // Listen for messages from extension
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;

      if (message.command === "updateDisplayState") {
        const updateMessage = message as UpdateDisplayStateMessage;
        setDisplayState(updateMessage.displayState);
        setError(null);
      } else if (message.command === "updateMemoryInfo") {
        const updateMessage = message as UpdateMemoryInfoMessage;
        setMemoryInfo(updateMessage.memoryInfo);
        setError(null);
      } else if (message.command === "showError") {
        const updateMessage = message as ShowErrorMessage;
        setError(updateMessage.error);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, []);

  return (
    <div className="state-viewer">
      {error ? <div className="error">{error}</div> : ""}

      <vscode-tabs>
        <vscode-tab-header>Display</vscode-tab-header>
        <vscode-tab-header>Memory Allocations</vscode-tab-header>
        <vscode-tab-panel>
          {displayState && <DisplayTab displayState={displayState} />}
        </vscode-tab-panel>
        <vscode-tab-panel>
          {memoryInfo && <MemoryTab memoryInfo={memoryInfo} vscode={vscode} />}
        </vscode-tab-panel>
      </vscode-tabs>
    </div>
  );
}
