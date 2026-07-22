import React, { useState, useEffect, useCallback } from "react";
import "@vscode-elements/elements";
import { VscodeCheckbox } from "@vscode-elements/elements";
import { useCombobox } from "downshift";
import { HexDump } from "./HexDump";
import { VisualView } from "./VisualView";
import { CopperView } from "./CopperView";
import { DisassemblyView } from "./DisassemblyView";
import "./App.css";
import {
  DownloadMemoryMessage,
  GetSuggestionsMessage,
  MemoryDataMessage,
  MemoryRange,
  MemoryRegion,
  Suggestion,
  SuggestionsDataMessage,
  UpdateStateMessage,
  ViewMode,
} from "../../shared/memoryViewerTypes";
import { createHostBridge, HostBridge } from "../shared/hostBridge";

const bridge: HostBridge =
  createHostBridge(`${location.pathname.replace(/\/$/, "")}/rpc`) ??
  (() => {
    throw new Error("Memory viewer webview requires a vscode or standalone host bridge");
  })();

function formatHex(value: number): string {
  return "0x" + value.toString(16).toUpperCase().padStart(8, "0");
}

const viewModes = ["hex", "visual", "disassembly", "copper"] as const;

export function App() {
  const [target, setTarget] = useState<MemoryRange | undefined>(undefined);
  const [symbols, setSymbols] = useState<Record<string, number>>({});
  const [symbolLengths, setSymbolLengths] = useState<Record<string, number>>(
    {},
  );
  const [availableRegions, setAvailableRegions] = useState<MemoryRegion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

  const [addressInput, setAddressInput] = useState<string>("");
  const [dereferencePointer, setDereferencePointer] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("hex");
  const [liveUpdate, setLiveUpdate] = useState<boolean>(false);
  const [colorCodeHexBytes, setColorCodeHexBytes] = useState<boolean>(true);
  const [watchedAddress, setWatchedAddress] = useState<number | undefined>(
    undefined,
  );
  const [selectedRegion, setSelectedRegion] = useState<
    MemoryRegion | undefined
  >();
  const [memoryChunks, setMemoryChunks] = useState<Map<number, Uint8Array>>(
    new Map(),
  );
  const [scrollResetTrigger, setScrollResetTrigger] = useState(0);

  // Send ready message on mount
  useEffect(() => {
    bridge.postMessage({ command: "ready" });
  }, []);

  // Listen for messages from extension
  useEffect(() => {
    let pendingUpdate: UpdateStateMessage | null = null;
    let rafScheduled = false;

    const applyPendingUpdate = () => {
      if (!pendingUpdate) {
        return;
      }
      if (pendingUpdate.viewMode !== undefined) {
        setViewMode(pendingUpdate.viewMode);
      }
      if (pendingUpdate.addressInput !== undefined) {
        setAddressInput(pendingUpdate.addressInput);
      }
      if (pendingUpdate.availableRegions !== undefined) {
        setAvailableRegions(pendingUpdate.availableRegions);
      }
      if (pendingUpdate.symbols !== undefined) {
        setSymbols(pendingUpdate.symbols);
      }
      if (pendingUpdate.symbolLengths !== undefined) {
        setSymbolLengths(pendingUpdate.symbolLengths);
      }
      if (pendingUpdate.liveUpdate !== undefined)
        setLiveUpdate(pendingUpdate.liveUpdate);
      if (pendingUpdate.colorCodeHexBytes !== undefined) {
        setColorCodeHexBytes(pendingUpdate.colorCodeHexBytes);
      }
      if (pendingUpdate.watchedAddress !== undefined) {
        setWatchedAddress(pendingUpdate.watchedAddress ?? undefined);
      }
      if (pendingUpdate.error !== undefined) {
        setError(pendingUpdate.error);
      }
      if (pendingUpdate.windowTitle !== undefined) {
        // No-op inside vscode (its webview tab label comes from the
        // WebviewPanel.title API, not this) — the standalone host's only
        // way to distinguish several simultaneous memory-viewer tabs.
        document.title = pendingUpdate.windowTitle;
      }
      if (pendingUpdate.target !== undefined) {
        const targetAddress = pendingUpdate.target.address;
        const targetEnd = targetAddress + pendingUpdate.target.size;

        // find region for target
        const regions = pendingUpdate.availableRegions || availableRegions;
        const region = regions.find(({ range }) => {
          const regionEnd = range.address + range.size;
          return targetAddress >= range.address && targetEnd < regionEnd;
        });

        if (targetAddress !== target?.address) {
          // Target changed - clear chunks
          setMemoryChunks(new Map());
        } else {
          // Force scroll to target, even if unchanged
          setScrollResetTrigger((prev) => prev + 1);
        }

        setTarget(pendingUpdate.target);
        setSelectedRegion(region);
      }
      pendingUpdate = null;
      rafScheduled = false;
    };

    const scheduleUpdate = () => {
      if (!rafScheduled) {
        rafScheduled = true;
        requestAnimationFrame(applyPendingUpdate);
      }
    };

    const handleMessage = (rawMessage: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const message = rawMessage as any;

      if (message.command === "updateState") {
        // Store latest update and schedule (combining with any previous to handle optional props) to render on next frame
        pendingUpdate = {
          ...pendingUpdate,
          ...(message as UpdateStateMessage),
        };
        scheduleUpdate();
      } else if (message.command === "suggestionsData") {
        const suggestionsMessage = message as SuggestionsDataMessage;
        setSuggestions(suggestionsMessage.suggestions || []);
      } else if (message.command === "memoryData") {
        const memData = message as MemoryDataMessage;
        setMemoryChunks((prev) => {
          const next = new Map(prev);
          next.set(memData.address, memData.data);
          return next;
        });
      } else if (message.command === "downloadMemory") {
        // Standalone host only — there's no native save dialog outside
        // vscode, so trigger a normal browser download instead.
        const downloadMsg = message as DownloadMemoryMessage;
        const bytes = Uint8Array.from(atob(downloadMsg.dataBase64), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = downloadMsg.fileName;
        a.click();
        URL.revokeObjectURL(url);
      }
    };

    const unsubscribe = bridge.onMessage(handleMessage);
    return () => {
      unsubscribe();
    };
  }, [target, availableRegions]);

  // Downshift combobox for autocomplete
  const {
    isOpen,
    getMenuProps,
    getInputProps,
    getToggleButtonProps,
    highlightedIndex,
    getItemProps,
  } = useCombobox({
    items: suggestions,
    itemToString: (item) => (item ? item.label : ""),
    inputValue: addressInput,
    onInputValueChange: ({ inputValue }) => {
      // Update local state
      setAddressInput(inputValue || "");

      // Request suggestions as user types (limited)
      if (inputValue && inputValue.length > 0) {
        bridge.postMessage({
          command: "getSuggestions",
          query: inputValue,
          showAll: false, // Use limit for autocomplete
        } as GetSuggestionsMessage);
      } else {
        setSuggestions([]);
      }
    },
    onSelectedItemChange: ({ selectedItem }) => {
      if (selectedItem) {
        const addressInput = selectedItem.label;
        setAddressInput(addressInput);
        bridge.postMessage({
          command: "changeAddress",
          addressInput,
          dereferencePointer,
        });
      }
    },
  });

  // Handler to show all symbols when dropdown button is clicked
  const handleToggleButton = () => {
    if (!isOpen) {
      // Request all symbols with showAll flag when opening
      bridge.postMessage({
        command: "getSuggestions",
        query: "", // Empty query to get all symbols
        showAll: true, // Bypass limit
      } as GetSuggestionsMessage);
    }
  };

  const goToAddress = () => {
    bridge.postMessage({
      command: "changeAddress",
      addressInput,
      dereferencePointer,
    });
  };

  // Custom key handler for "Go" button behavior
  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      // If no dropdown item is highlighted, check for a case-insensitive exact match and fix the casing
      if (highlightedIndex === -1) {
        const exactMatch = suggestions.find(
          (s) => s.label.toLowerCase() === addressInput.toLowerCase(),
        );
        if (exactMatch) {
          setAddressInput(exactMatch.label);
          bridge.postMessage({
            command: "changeAddress",
            addressInput: exactMatch.label,
            dereferencePointer,
          });
          return;
        }
      }
      goToAddress();
    }
  };

  const toggleLiveUpdate: React.FormEventHandler<VscodeCheckbox> = (e) => {
    const enabled = (e.target as HTMLInputElement).checked || false;
    setLiveUpdate(enabled);
    bridge.postMessage({
      command: "toggleLiveUpdate",
      enabled,
      dereferencePointer,
    });
  };

  const requestMemory = useCallback(({ address, size }: MemoryRange) => {
    bridge.postMessage({
      command: "requestMemory",
      address,
      size,
    });
  }, []);

  const goToSource = useCallback((address: number) => {
    bridge.postMessage({
      command: "goToSource",
      address,
    });
  }, []);

  const exportMemory = useCallback(({ address, size }: MemoryRange) => {
    bridge.postMessage({
      command: "exportMemory",
      address,
      size,
    });
  }, []);

  const toggleWatchpoint = useCallback((address: number) => {
    bridge.postMessage({
      command: "toggleWatchpoint",
      address,
    });
  }, []);

  const handleRegionChange: React.FormEventHandler<HTMLSelectElement> = (e) => {
    const addressValue = Number((e.target as HTMLSelectElement).value);
    if (isNaN(addressValue)) {
      setSelectedRegion(undefined);
      return;
    }
    const addressInput = formatHex(addressValue);
    setAddressInput(addressInput);
    bridge.postMessage({
      command: "changeAddress",
      addressInput,
      dereferencePointer,
    });
  };

  return (
    <div className="memory-viewer">
      <div className="address-input">
        <vscode-label htmlFor="address">Address:</vscode-label>
        <div className="autocomplete-container">
          <input
            {...getInputProps({
              id: "address",
              placeholder: "Type symbol name, address or expression...",
              onKeyDown: handleInputKeyDown,
            })}
            className="address-textfield"
            autoFocus
          />
          <button
            {...getToggleButtonProps({
              onClick: handleToggleButton,
            })}
            type="button"
            className="dropdown-button codicon codicon-chevron-down"
            aria-label="Show all symbols"
            tabIndex={-1}
          ></button>
          <ul {...getMenuProps()} className="autocomplete-dropdown">
            {isOpen &&
              suggestions.map((suggestion, index) => (
                <li
                  key={suggestion.label}
                  {...getItemProps({ item: suggestion, index })}
                  className={`autocomplete-item ${highlightedIndex === index ? "selected" : ""}`}
                >
                  <span className="suggestion-label">{suggestion.label}</span>
                  <span className="suggestion-address">
                    {suggestion.address}
                  </span>
                  {suggestion.description && (
                    <span className="suggestion-description">
                      {suggestion.description}
                    </span>
                  )}
                </li>
              ))}
          </ul>
        </div>
        <vscode-button onClick={goToAddress}>Go</vscode-button>
        <vscode-button
          onClick={() => target && exportMemory(target)}
          disabled={!target}
        >
          Save to Disk...
        </vscode-button>
      </div>

      {error ? <div className="error">{error}</div> : ""}

      <div className="options-container">
        <vscode-checkbox checked={liveUpdate} onChange={toggleLiveUpdate}>
          Live Update
        </vscode-checkbox>
        <vscode-checkbox
          checked={dereferencePointer}
          onChange={(e: React.FormEvent) => {
            const checked = (e.target as HTMLInputElement).checked;
            setDereferencePointer(checked);
            // Trigger update when checkbox changes
            bridge.postMessage({
              command: "changeAddress",
              addressInput,
              dereferencePointer: checked,
            });
          }}
        >
          Dereference pointer
        </vscode-checkbox>
      </div>

      {availableRegions.length > 0 && (
        <div className="region-selector">
          <vscode-label htmlFor="region">Region:</vscode-label>
          <select
            id="region"
            value={selectedRegion?.range.address}
            onChange={handleRegionChange}
            className="region-dropdown"
          >
            <option>Select memory region</option>
            {availableRegions.map(({ name, range }) => (
              <option key={range.address} value={range.address}>
                {name} ({formatHex(range.address)} -{" "}
                {formatHex(range.address + range.size - 1)})
              </option>
            ))}
          </select>
        </div>
      )}

      <vscode-divider></vscode-divider>

      {target !== undefined && selectedRegion ? (
        <vscode-tabs
          selectedIndex={viewModes.indexOf(viewMode)}
          onvsc-tabs-select={(e) => {
            setViewMode(viewModes[e.detail.selectedIndex]);
          }}
        >
          <vscode-tab-header>Hex Dump</vscode-tab-header>
          <vscode-tab-header>Visual</vscode-tab-header>
          <vscode-tab-header>Disassembly</vscode-tab-header>
          <vscode-tab-header>Copper</vscode-tab-header>

          <vscode-tab-panel>
            {viewMode === "hex" && (
              <HexDump
                target={target}
                range={selectedRegion.range}
                symbols={symbols}
                symbolLengths={symbolLengths}
                memoryChunks={memoryChunks}
                onRequestMemory={requestMemory}
                onGoToSource={goToSource}
                scrollResetTrigger={scrollResetTrigger}
                colorCodeBytes={colorCodeHexBytes}
                watchedAddress={watchedAddress}
                onToggleWatchpoint={toggleWatchpoint}
              />
            )}
          </vscode-tab-panel>
          <vscode-tab-panel>
            {viewMode === "visual" && (
              <VisualView
                target={target}
                range={selectedRegion.range}
                symbols={symbols}
                symbolLengths={symbolLengths}
                memoryChunks={memoryChunks}
                onRequestMemory={requestMemory}
                scrollResetTrigger={scrollResetTrigger}
              />
            )}
          </vscode-tab-panel>
          <vscode-tab-panel>
            {viewMode === "disassembly" && (
              <DisassemblyView
                target={target}
                range={selectedRegion.range}
                symbols={symbols}
                memoryChunks={memoryChunks}
                onRequestMemory={requestMemory}
                scrollResetTrigger={scrollResetTrigger}
              />
            )}
          </vscode-tab-panel>
          <vscode-tab-panel>
            {viewMode === "copper" && (
              <CopperView
                target={target}
                range={selectedRegion.range}
                symbols={symbols}
                symbolLengths={symbolLengths}
                memoryChunks={memoryChunks}
                onRequestMemory={requestMemory}
                scrollResetTrigger={scrollResetTrigger}
              />
            )}
          </vscode-tab-panel>
        </vscode-tabs>
      ) : (
        ""
      )}
    </div>
  );
}
