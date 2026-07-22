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
import { createHostBridge, HostBridge } from "../shared/hostBridge";
import { DisplayTab } from "./DisplayTab";
import { MemoryTab } from "./MemoryTab";

const bridge: HostBridge =
  createHostBridge("/state/rpc") ??
  (() => {
    throw new Error("State viewer webview requires a vscode or standalone host bridge");
  })();

export function App() {
  const [displayState, setDisplayState] = useState<DisplayState | null>(null);
  const [memoryInfo, setMemoryInfo] = useState<MemoryInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Send ready message on mount
  useEffect(() => {
    bridge.postMessage({ command: "ready" });
  }, []);

  // Listen for messages from extension
  useEffect(() => {
    const handleMessage = (rawMessage: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const message = rawMessage as any;

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

    return bridge.onMessage(handleMessage);
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
          {memoryInfo && <MemoryTab memoryInfo={memoryInfo} bridge={bridge} />}
        </vscode-tab-panel>
      </vscode-tabs>
    </div>
  );
}
