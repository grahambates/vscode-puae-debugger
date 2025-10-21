import { useState, useEffect } from "react";
import "@vscode-elements/elements";
import "./App.css";
import {
  DisplayState,
  MemoryInfo,
  UpdateDisplayStateMessage,
  UpdateMemoryInfoMessage,
} from "../../shared/stateViewerTypes";
import { DisplayTab } from "./DisplayTab";
import { MemoryTab } from "./MemoryTab";

const vscode = acquireVsCodeApi();

export function App() {
  const [displayState, setDisplayState] = useState<DisplayState | null>(null);
  const [memoryInfo, setMemoryInfo] = useState<MemoryInfo | null>(null);

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
      } else if (message.command === "updateMemoryInfo") {
        const updateMessage = message as UpdateMemoryInfoMessage;
        setMemoryInfo(updateMessage.memoryInfo);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, []);

  return (
    <div className="state-viewer">
      {displayState ? (
        <vscode-tabs>
          <vscode-tab-header>Display</vscode-tab-header>
          <vscode-tab-header>Memory Allocations</vscode-tab-header>
          {/* <vscode-tab-header>Sprites</vscode-tab-header> */}

          <vscode-tab-panel>
            <DisplayTab displayState={displayState} />
          </vscode-tab-panel>
          <vscode-tab-panel>
            {memoryInfo ? (
              <MemoryTab memoryInfo={memoryInfo} />
            ) : (
              <div className="loading">Loading memory info...</div>
            )}
          </vscode-tab-panel>
          <vscode-tab-panel>
            <div className="coming-soon">
              Coming soon...
            </div>
          </vscode-tab-panel>
        </vscode-tabs>
      ) : (
        <div className="loading">Loading state...</div>
      )}
    </div>
  );
}
