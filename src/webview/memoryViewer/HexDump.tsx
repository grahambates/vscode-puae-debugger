import React, { useState, useRef, useEffect, useCallback } from "react";
import "./HexDump.css";
import { MemoryRange } from "../../shared/memoryViewerTypes";
import { Tooltip, TooltipProps } from "./Tooltip";
import { ContextMenu, ContextMenuItem } from "./ContextMenu";
import { convertToSigned, formatAddress } from "./lib";

export interface HexDumpProps {
  target: MemoryRange;
  range: MemoryRange;
  symbols: Record<string, number>;
  symbolLengths: Record<string, number>;
  memoryChunks: Map<number, Uint8Array>;
  onRequestMemory: (range: MemoryRange) => void;
  onGoToSource: (address: number) => void;
  scrollResetTrigger?: number;
  colorCodeBytes: boolean;
  watchedAddress?: number;
  onToggleWatchpoint: (address: number) => void;
}

/**
 * Reference to Hex or ASCII value drawn on canvas
 * used for tooltips and context menus
 */
interface RenderedValue {
  value: number;
  address: number;
  isAscii: boolean;
  // Canvas location
  x: number;
  y: number;
  width: number;
}

const BUFFER_LINES = 20; // Lines beyond visible range to fetch

const LINE_HEIGHT = 20;
const CHAR_WIDTH = 8.4; // Monospace character width (adjusted for 14px font)
const ADDRESS_OFFSET = 10;
const HEX_OFFSET = 80;
const CHUNK_SIZE = 1024; // Request 1KB chunks
const BYTES_PER_LINE = 16;

// ASCII section: gap (2 chars) + | (1) + gap (1.5) + 16 ASCII chars + | (1)
const ASCII_WIDTH =
  CHAR_WIDTH * 2 +
  CHAR_WIDTH +
  CHAR_WIDTH * 1.5 +
  BYTES_PER_LINE * CHAR_WIDTH +
  CHAR_WIDTH;

const dpr = window.devicePixelRatio || 1;

// One distinct hue per nibble value (0-F), evenly spread for maximum differentiation
const NIBBLE_COLORS = Array.from(
  { length: 16 },
  (_, n) => `hsl(${(n * 360) / 16}, 70%, 65%)`,
);

export function HexDump({
  target,
  range,
  symbols,
  symbolLengths,
  memoryChunks,
  onRequestMemory,
  onGoToSource,
  scrollResetTrigger,
  colorCodeBytes,
  watchedAddress,
  onToggleWatchpoint,
}: HexDumpProps) {
  const [tooltip, setTooltip] = useState<TooltipProps | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    address: number;
  } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [visibleRange, setVisibleRange] = useState({
    firstLine: 0,
    lastLine: 0,
  });
  const renderedValuesRef = useRef<RenderedValue[]>([]);
  const previousDataRef = useRef<Map<number, Uint8Array> | null>(null);
  const changedBytesRef = useRef<Map<number, number>>(new Map()); // byte offset -> timestamp
  const requestedChunksRef = useRef<Set<number>>(new Set()); // Track requested chunks to avoid duplicates

  // Align to 16-byte boundary for clean row display
  const alignedRangeStart =
    Math.floor(range.address / BYTES_PER_LINE) * BYTES_PER_LINE;
  const alignedRangeEnd =
    Math.ceil((range.address + range.size) / BYTES_PER_LINE) * BYTES_PER_LINE;
  const viewableRangeTotal = alignedRangeEnd - alignedRangeStart;

  const totalLines = Math.ceil(viewableRangeTotal / BYTES_PER_LINE);

  // Get byte from loaded chunks - shared by canvas rendering and tooltips
  const getByte = useCallback(
    (address: number): number | undefined => {
      const chunkOffset = Math.floor(address / CHUNK_SIZE) * CHUNK_SIZE;
      const chunk = memoryChunks.get(chunkOffset);
      if (!chunk) {
        return undefined;
      }
      // Calculate byte index within chunk (handle negative offsets)
      const byteIndex = address - chunkOffset;
      return byteIndex >= 0 && byteIndex < chunk.length
        ? chunk[byteIndex]
        : undefined;
    },
    [memoryChunks],
  );

  // Byte/word/longword interpretations of the value(s) starting at an
  // address - shared by the tooltip and the "Copy ..." context menu items.
  // Word/longword reads must start at an even address on the 68000, so an
  // odd address can only ever be interpreted as a byte; sizes are also only
  // included when their underlying bytes are loaded.
  const getValueInterpretations = useCallback(
    (address: number): { label: string; value: number; size: 1 | 2 | 4 }[] => {
      const interpretations: { label: string; value: number; size: 1 | 2 | 4 }[] =
        [];

      const byte0 = getByte(address);
      if (byte0 === undefined) return interpretations;
      interpretations.push({ label: "Byte", value: byte0, size: 1 });

      if (address % 2 !== 0) return interpretations;

      const byte1 = getByte(address + 1);
      if (byte1 === undefined) return interpretations;
      interpretations.push({
        label: "Word",
        value: (byte0 << 8) | byte1,
        size: 2,
      });

      const byte2 = getByte(address + 2);
      const byte3 = getByte(address + 3);
      if (byte2 === undefined || byte3 === undefined) return interpretations;
      interpretations.push({
        label: "Longword",
        value: ((byte0 << 24) | (byte1 << 16) | (byte2 << 8) | byte3) >>> 0,
        size: 4,
      });

      return interpretations;
    },
    [getByte],
  );

  // Render canvas
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Get colors from CSS variables / theme
    const styles = getComputedStyle(document.documentElement);
    const foregroundColor =
      styles.getPropertyValue("--vscode-editor-foreground").trim() || "#d4d4d4";
    const commentColor =
      styles.getPropertyValue("--vscode-editorLineNumber-foreground").trim() ||
      "#858585";
    const backgroundColor =
      styles.getPropertyValue("--vscode-editor-background").trim() || "#1e1e1e";
    const selectionBackground =
      styles.getPropertyValue("--vscode-editor-selectionBackground").trim() ||
      "rgba(0, 120, 215, 0.3)";
    // Same red used for breakpoint dots in the editor gutter, so a watched
    // byte reads as "this is a breakpoint-like marker"
    const watchpointColor =
      styles.getPropertyValue("--vscode-debugIcon-breakpointForeground").trim() ||
      "#e51400";

    // Don't render if no visible range
    if (visibleRange.firstLine >= visibleRange.lastLine) return;

    const canvasHeight =
      (visibleRange.lastLine - visibleRange.firstLine) * LINE_HEIGHT;

    // Calculate hex section width (same logic as rendering loop) - always
    // grouped by individual bytes, since longwords/words can start at any
    // even address and a fixed grouping would misrepresent the data
    let hexWidth = 0;
    for (let j = 0; j < BYTES_PER_LINE; j++) {
      hexWidth += 2 * CHAR_WIDTH + CHAR_WIDTH; // value + space
      if (j === 3 || j === 7 || j === 11) {
        hexWidth += CHAR_WIDTH; // extra spacing every 4 bytes (longword groups)
      }
    }

    const canvasWidth = HEX_OFFSET + hexWidth + ASCII_WIDTH;

    canvas.width = canvasWidth * dpr;
    canvas.height = canvasHeight * dpr;
    canvas.style.width = `${canvasWidth}px`;
    canvas.style.height = `${canvasHeight}px`;

    ctx.scale(dpr, dpr);
    ctx.font = "14px monospace";
    ctx.textBaseline = "top";

    // Clear background
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    const renderedValues: RenderedValue[] = [];

    // Range of addresses covered by the target symbol/address, used to dim
    // values outside it. Default to at least one byte if size is 0/undefined.
    const targetEndAddress = target.address + (target.size || 1);
    const isInTarget = (byteAddress: number) =>
      byteAddress >= target.address && byteAddress < targetEndAddress;

    for (let i = visibleRange.firstLine; i < visibleRange.lastLine; i++) {
      // Calculate line address (aligned to 16-byte boundaries)
      const lineAddress = alignedRangeStart + i * BYTES_PER_LINE;

      const y = (i - visibleRange.firstLine) * LINE_HEIGHT;

      // Draw address
      ctx.fillStyle = commentColor;
      const addrStr = lineAddress.toString(16).toUpperCase().padStart(6, "0");
      ctx.fillText(addrStr, ADDRESS_OFFSET, y + 2);

      // Draw hex values - always grouped by individual bytes, since
      // words/longwords can start at any even address and a fixed grouping
      // would misrepresent the data
      let x = HEX_OFFSET;
      for (let j = 0; j < BYTES_PER_LINE; j++) {
        const byteAddress = lineAddress + j;
        const inRange =
          byteAddress >= range.address &&
          byteAddress < range.address + range.size;

        let xInc = 2 * CHAR_WIDTH + CHAR_WIDTH;
        // Extra spacing every 4 bytes (longword groups)
        if (j === 3 || j === 7 || j === 11) {
          xInc += CHAR_WIDTH;
        }

        const value = getByte(byteAddress);
        if (value === undefined || !inRange) {
          // Show placeholder for missing data
          ctx.fillStyle = commentColor;
          ctx.fillText("..", x, y + 2);
          x += xInc;
          continue;
        }

        const hex = value.toString(16).toUpperCase().padStart(2, "0");

        // Highlight changed bytes within the last second
        const mostRecentChange = changedBytesRef.current.get(byteAddress) ?? 0;
        const isChanged =
          mostRecentChange > 0 && Date.now() - mostRecentChange < 1000;
        if (isChanged) {
          // Fade from yellow to transparent
          const elapsed = Date.now() - mostRecentChange;
          const changeFactor = 1 - elapsed / 1000; // 1.0 at start, 0.0 at end
          const opacity = 0.5 * changeFactor;
          ctx.fillStyle = `rgba(255, 200, 0, ${opacity})`;
          ctx.fillRect(x, y, hex.length * CHAR_WIDTH, LINE_HEIGHT);
        }

        if (colorCodeBytes) {
          if (value === 0) {
            // Zero values are common "filler" - call them out distinctly rather
            // than lumping them in with the 0x0-led nibble color
            ctx.fillStyle = commentColor;
          } else {
            const nibble = (value >>> 4) & 0xf;
            ctx.fillStyle = NIBBLE_COLORS[nibble];
          }
        } else {
          ctx.fillStyle = foregroundColor;
        }
        // Dim values outside the target symbol/address rather than
        // highlighting the target, so the text (and color-coding) stays legible
        ctx.globalAlpha = isInTarget(byteAddress) ? 1 : 0.5;
        ctx.fillText(hex, x, y + 2);
        ctx.globalAlpha = 1;

        // Outline the watched byte so the user can find it again to remove it
        if (byteAddress === watchedAddress) {
          ctx.strokeStyle = watchpointColor;
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 0.5, y + 0.5, hex.length * CHAR_WIDTH, LINE_HEIGHT - 1);
        }

        // Store hex value
        renderedValues.push({
          value,
          address: byteAddress,
          x,
          y,
          width: hex.length * CHAR_WIDTH,
          isAscii: false,
        });

        x += xInc;
      }

      // Draw ASCII - calculate offset based on actual hex width
      const asciiOffset = x + CHAR_WIDTH * 2;
      ctx.fillStyle = commentColor;
      ctx.fillText("|", asciiOffset, y + 2);

      let asciiX = asciiOffset + CHAR_WIDTH * 1.5;
      for (let j = 0; j < BYTES_PER_LINE; j++) {
        const byteAddress = lineAddress + j;
        const byte = getByte(byteAddress);

        const inRange =
          byteAddress >= range.address &&
          byteAddress < range.address + range.size;

        if (byte === undefined || !inRange) {
          ctx.fillStyle = commentColor;
          ctx.fillText(".", asciiX, y + 2);
          asciiX += CHAR_WIDTH;
          continue;
        }

        const char =
          byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".";

        // Highlight symbol range in ASCII section
        if (isInTarget(byteAddress)) {
          ctx.fillStyle = selectionBackground;
          ctx.fillRect(asciiX, y, CHAR_WIDTH, LINE_HEIGHT);
        }

        ctx.fillStyle = commentColor;
        ctx.fillText(char, asciiX, y + 2);

        // Outline the watched byte so the user can find it again to remove it
        if (byteAddress === watchedAddress) {
          ctx.strokeStyle = watchpointColor;
          ctx.lineWidth = 1;
          ctx.strokeRect(asciiX + 0.5, y + 0.5, CHAR_WIDTH, LINE_HEIGHT - 1);
        }

        // Store ASCII value
        renderedValues.push({
          value: byte,
          address: lineAddress + j,
          x: asciiX,
          y,
          width: CHAR_WIDTH,
          isAscii: true,
        });

        asciiX += CHAR_WIDTH;
      }

      ctx.fillStyle = commentColor;
      ctx.fillText("|", asciiX, y + 2);
    }

    renderedValuesRef.current = renderedValues;
  }, [alignedRangeStart, colorCodeBytes, target, getByte, visibleRange, range, watchedAddress]);

  // Clear requested on address
  useEffect(() => {
    requestedChunksRef.current.clear();
  }, [target.address]);

  // Scroll to target
  useEffect(() => {
    if (containerRef.current) {
      const scrollTop =
        Math.floor((target.address - alignedRangeStart) / BYTES_PER_LINE) *
        LINE_HEIGHT;
      containerRef.current.scrollTop = scrollTop;
    }
  }, [target.address, alignedRangeStart, scrollResetTrigger]);

  // Track changed bytes with timestamps
  useEffect(() => {
    const now = Date.now();
    let hasChanges = false;

    // Compare each chunk with previous version
    memoryChunks.forEach((chunk, offset) => {
      const prevChunk = previousDataRef.current?.get(offset);
      if (prevChunk) {
        for (let i = 0; i < chunk.length; i++) {
          if (prevChunk[i] !== chunk[i]) {
            changedBytesRef.current.set(offset + i, now);
            hasChanges = true;
          }
        }
      }
    });

    // Update previous data
    previousDataRef.current = new Map(memoryChunks);

    // Clean up old change markers (older than 1 second)
    const cutoff = now - 1000;
    for (const [index, time] of changedBytesRef.current.entries()) {
      if (time < cutoff) {
        changedBytesRef.current.delete(index);
      }
    }

    // Set up animation frame loop to fade out highlights
    if (hasChanges || changedBytesRef.current.size > 0) {
      let animationId: number;
      const animate = () => {
        const currentTime = Date.now();
        const cutoffTime = currentTime - 1000;

        // Remove expired highlights
        for (const [index, time] of changedBytesRef.current.entries()) {
          if (time < cutoffTime) {
            changedBytesRef.current.delete(index);
          }
        }

        // Re-render to update fade
        renderCanvas();

        // Continue animation if there are still active highlights
        if (changedBytesRef.current.size > 0) {
          animationId = requestAnimationFrame(animate);
        }
      };

      animationId = requestAnimationFrame(animate);
      return () => cancelAnimationFrame(animationId);
    }
  }, [memoryChunks, renderCanvas]);

  // Calculate visible range on scroll and request missing chunks
  useEffect(() => {
    const handleScroll = () => {
      if (!containerRef.current) return;

      // Calculate range of lines that should be available - visible range + buffer
      const scrollTop = containerRef.current.scrollTop;
      const scrollBottom = scrollTop + containerRef.current.clientHeight;
      const firstLine = Math.max(
        0,
        Math.floor(scrollTop / LINE_HEIGHT) - BUFFER_LINES,
      );
      const lastLine = Math.min(
        totalLines,
        Math.ceil(scrollBottom / LINE_HEIGHT) + BUFFER_LINES,
      );
      setVisibleRange({ firstLine, lastLine });

      // Get byte offsets of chunks
      const firstChunk =
        Math.floor(
          (alignedRangeStart + firstLine * BYTES_PER_LINE) / CHUNK_SIZE,
        ) * CHUNK_SIZE;
      const lastChunk =
        Math.floor(
          (alignedRangeStart + lastLine * BYTES_PER_LINE) / CHUNK_SIZE,
        ) * CHUNK_SIZE;

      // Fetch any missing chunks in range:
      for (let c = firstChunk; c <= lastChunk; c += CHUNK_SIZE) {
        const alreadyHaveChunk = memoryChunks.has(c);
        const alreadyRequested = requestedChunksRef.current.has(c);
        if (alreadyHaveChunk || alreadyRequested) {
          continue;
        }
        requestedChunksRef.current.add(c);
        onRequestMemory({ address: c, size: CHUNK_SIZE });
      }
    };

    // Call immediately when baseAddress changes or component mounts
    handleScroll();

    // Call max once per frame
    let ticking = false;
    const handleScrollPerFrame = () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          handleScroll();
          ticking = false;
        });
        ticking = true;
      }
    };

    const container = containerRef.current;
    if (container) {
      container.addEventListener("scroll", handleScrollPerFrame);
      return () => {
        container.removeEventListener("scroll", handleScrollPerFrame);
      };
    }
  }, [
    totalLines,
    onRequestMemory,
    target.address,
    alignedRangeStart,
    memoryChunks,
  ]);

  // Render canvas when content changes:
  useEffect(() => {
    renderCanvas();
  }, [renderCanvas]);

  // Locate the rendered hex/ASCII value under a given page coordinate, used
  // by the tooltip, click-to-source and context menu handlers
  const findRenderedValueAt = (
    clientX: number,
    clientY: number,
  ): RenderedValue | undefined => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    return renderedValuesRef.current.find(
      (info) =>
        x >= info.x &&
        x <= info.x + info.width &&
        y >= info.y &&
        y <= info.y + LINE_HEIGHT,
    );
  };

  // Handle mouse move for tooltips
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const byteInfo = findRenderedValueAt(e.clientX, e.clientY);

    if (byteInfo) {
      const interpretations = getValueInterpretations(byteInfo.address);

      const text = (
        <>
          {interpretations.map(({ label, value, size }) => {
            const signedValue = convertToSigned(value, size);
            return (
              <div key={label}>
                {label}: {value}
                {signedValue !== value ? `, ${signedValue}` : ""}
              </div>
            );
          })}
        </>
      );

      setTooltip({
        x: e.clientX,
        y: e.clientY,
        heading: formatAddress(byteInfo.address, symbols, symbolLengths),
        text,
      });
    } else {
      setTooltip(null);
    }
  };

  const handleMouseLeave = () => {
    setTooltip(null);
  };

  const copyToClipboard = (value: number, byteLength: 1 | 2 | 4) => {
    const hexValue =
      "0x" + value.toString(16).toUpperCase().padStart(byteLength * 2, "0");
    navigator.clipboard
      .writeText(hexValue)
      .then(() => {
        if (contextMenu) {
          setTooltip({
            x: contextMenu.x,
            y: contextMenu.y,
            text: `Copied: ${hexValue}`,
          });
          setTimeout(() => setTooltip(null), 1000);
        }
      })
      .catch((err) => {
        console.error("Failed to copy to clipboard:", err);
      });
  };

  const buildContextMenuItems = (address: number): ContextMenuItem[] => {
    const items: ContextMenuItem[] = getValueInterpretations(address).map(
      ({ label, value, size }) => ({
        label: `Copy ${label}`,
        onSelect: () => copyToClipboard(value, size),
      }),
    );

    items.push({ separator: true });
    items.push({
      label: "Go to Source",
      onSelect: () => onGoToSource(address),
    });

    items.push({ separator: true });
    items.push({
      label: address === watchedAddress ? "Remove Watchpoint" : "Set Watchpoint",
      onSelect: () => onToggleWatchpoint(address),
    });

    return items;
  };

  const handleContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();

    const byteInfo = findRenderedValueAt(e.clientX, e.clientY);
    if (byteInfo) {
      setContextMenu({ x: e.clientX, y: e.clientY, address: byteInfo.address });
    }
  };

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const byteInfo = findRenderedValueAt(e.clientX, e.clientY);
    if (byteInfo) {
      onGoToSource(byteInfo.address);
    }
  };

  return (
    <div className="hexDump">
      <div className="hex-scroll-container" ref={containerRef}>
        <div
          style={{
            height: `${totalLines * LINE_HEIGHT}px`,
            position: "relative",
          }}
        >
          <canvas
            className="hex-canvas"
            ref={canvasRef}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            onClick={handleClick}
            onContextMenu={handleContextMenu}
            style={{
              top: `${visibleRange.firstLine * LINE_HEIGHT}px`,
            }}
          />
        </div>
      </div>
      {tooltip && <Tooltip {...tooltip} />}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildContextMenuItems(contextMenu.address)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
