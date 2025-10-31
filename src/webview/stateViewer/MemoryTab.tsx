import { MemoryInfo } from "../../shared/stateViewerTypes";
import "./MemoryTab.css";

interface MemoryTabProps {
  memoryInfo: MemoryInfo;
  vscode: ReturnType<typeof acquireVsCodeApi>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  } else {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
}

function formatAddress(address: number): string {
  return `0x${address.toString(16).toUpperCase().padStart(6, "0")}`;
}

export function MemoryTab({ memoryInfo, vscode }: MemoryTabProps) {
  const openMemoryViewer = (address: number) => {
    vscode.postMessage({
      command: "openMemoryViewer",
      address,
    });
  };
  const chipUsed = memoryInfo.totalChip - memoryInfo.freeChip;
  const slowUsed = memoryInfo.totalSlow - memoryInfo.freeSlow;
  const fastUsed = memoryInfo.totalFast - memoryInfo.freeFast;
  const chipPercent =
    memoryInfo.totalChip > 0
      ? ((chipUsed / memoryInfo.totalChip) * 100).toFixed(1)
      : "0.0";
  const slowPercent =
    memoryInfo.totalSlow > 0
      ? ((slowUsed / memoryInfo.totalSlow) * 100).toFixed(1)
      : "0.0";
  const fastPercent =
    memoryInfo.totalFast > 0
      ? ((fastUsed / memoryInfo.totalFast) * 100).toFixed(1)
      : "0.0";

  // Group blocks by type and sort by address
  const chipBlocks = memoryInfo.blocks
    .filter((b) => b.attributes & 0x02)
    .sort((a, b) => a.address - b.address);
  const slowBlocks = memoryInfo.blocks
    .filter((b) => !(b.attributes & 0x02) && b.address >= 0xc00000 && b.address < 0xe00000)
    .sort((a, b) => a.address - b.address);
  const fastBlocks = memoryInfo.blocks
    .filter((b) => !(b.attributes & 0x02) && (b.address < 0xc00000 || b.address >= 0xe00000))
    .sort((a, b) => a.address - b.address);

  return (
    <div className="memory-tab">
      <div className="memory-summary">
        <div className="memory-info-grid">
          <div className="info-item">
            <span className="label">ExecBase:</span>
            <span className="value">{formatAddress(memoryInfo.execBase)}</span>
          </div>
          <div className="info-item">
            <span className="label">MemList:</span>
            <span className="value">{formatAddress(memoryInfo.memList)}</span>
          </div>
        </div>

        <div className="memory-regions">
          <div className="memory-region chip-memory">
            <h3>CHIP Memory</h3>
            <div className="memory-stats">
              <div className="stat-row">
                <span className="label">Total:</span>
                <span className="value">{formatBytes(memoryInfo.totalChip)}</span>
              </div>
              <div className="stat-row">
                <span className="label">Free:</span>
                <span className="value">{formatBytes(memoryInfo.freeChip)}</span>
              </div>
              <div className="stat-row">
                <span className="label">Used:</span>
                <span className="value">
                  {formatBytes(chipUsed)} ({chipPercent}%)
                </span>
              </div>
            </div>
            <div className="memory-bar">
              <div
                className="memory-bar-fill chip"
                style={{ width: `${chipPercent}%` }}
              ></div>
            </div>
          </div>

          {memoryInfo.totalSlow > 0 && (
            <div className="memory-region slow-memory">
              <h3>SLOW Memory</h3>
              <div className="memory-stats">
                <div className="stat-row">
                  <span className="label">Total:</span>
                  <span className="value">{formatBytes(memoryInfo.totalSlow)}</span>
                </div>
                <div className="stat-row">
                  <span className="label">Free:</span>
                  <span className="value">{formatBytes(memoryInfo.freeSlow)}</span>
                </div>
                <div className="stat-row">
                  <span className="label">Used:</span>
                  <span className="value">
                    {formatBytes(slowUsed)} ({slowPercent}%)
                  </span>
                </div>
              </div>
              <div className="memory-bar">
                <div
                  className="memory-bar-fill slow"
                  style={{ width: `${slowPercent}%` }}
                ></div>
              </div>
            </div>
          )}

          <div className="memory-region fast-memory">
            <h3>FAST Memory</h3>
            <div className="memory-stats">
              <div className="stat-row">
                <span className="label">Total:</span>
                <span className="value">{formatBytes(memoryInfo.totalFast)}</span>
              </div>
              <div className="stat-row">
                <span className="label">Free:</span>
                <span className="value">{formatBytes(memoryInfo.freeFast)}</span>
              </div>
              <div className="stat-row">
                <span className="label">Used:</span>
                <span className="value">
                  {formatBytes(fastUsed)} ({fastPercent}%)
                </span>
              </div>
            </div>
            <div className="memory-bar">
              <div
                className="memory-bar-fill fast"
                style={{ width: `${fastPercent}%` }}
              ></div>
            </div>
          </div>
        </div>
      </div>

      <div className="memory-blocks">

        {/* CHIP Memory Section */}
        {chipBlocks.length > 0 && (
          <div className="memory-type-section">
            <h3 className="memory-type-header">CHIP Memory</h3>
            <table className="blocks-table">
              <thead>
                <tr>
                  <th>Address</th>
                  <th>Size</th>
                  <th>Segment</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {chipBlocks.map((block, idx) => (
                  <tr key={idx} className={block.free ? "free-row" : "allocated-row"}>
                    <td className="address">
                      <button
                        className="address-link"
                        onClick={() => openMemoryViewer(block.address)}
                        title="Open in Memory Viewer"
                      >
                        {formatAddress(block.address)}
                      </button>
                    </td>
                    <td className="size">{formatBytes(block.size)}</td>
                    <td className="segment">
                      {block.segments && block.segments.length > 0 ? (
                        <>
                          {block.segments.map((segment, segIdx) => (
                            <span key={segIdx}>
                              {segIdx > 0 && ", "}
                              <button
                                className="segment-link"
                                onClick={() => openMemoryViewer(segment.address)}
                                title="Open in Memory Viewer"
                              >
                                {segment.name}
                              </button>
                            </span>
                          ))}
                        </>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className={`status ${block.free ? "free" : "allocated"}`}>
                      {block.free ? "Free" : "Allocated"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* SLOW Memory Section */}
        {slowBlocks.length > 0 && (
          <div className="memory-type-section">
            <h3 className="memory-type-header">SLOW Memory</h3>
            <table className="blocks-table">
              <thead>
                <tr>
                  <th>Address</th>
                  <th>Size</th>
                  <th>Segment</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {slowBlocks.map((block, idx) => (
                  <tr key={idx} className={block.free ? "free-row" : "allocated-row"}>
                    <td className="address">
                      <button
                        className="address-link"
                        onClick={() => openMemoryViewer(block.address)}
                        title="Open in Memory Viewer"
                      >
                        {formatAddress(block.address)}
                      </button>
                    </td>
                    <td className="size">{formatBytes(block.size)}</td>
                    <td className="segment">
                      {block.segments && block.segments.length > 0 ? (
                        <>
                          {block.segments.map((segment, segIdx) => (
                            <span key={segIdx}>
                              {segIdx > 0 && ", "}
                              <button
                                className="segment-link"
                                onClick={() => openMemoryViewer(segment.address)}
                                title="Open in Memory Viewer"
                              >
                                {segment.name}
                              </button>
                            </span>
                          ))}
                        </>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className={`status ${block.free ? "free" : "allocated"}`}>
                      {block.free ? "Free" : "Allocated"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* FAST Memory Section */}
        {fastBlocks.length > 0 && (
          <div className="memory-type-section">
            <h3 className="memory-type-header">FAST Memory</h3>
            <table className="blocks-table">
              <thead>
                <tr>
                  <th>Address</th>
                  <th>Size</th>
                  <th>Segment</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {fastBlocks.map((block, idx) => (
                  <tr key={idx} className={block.free ? "free-row" : "allocated-row"}>
                    <td className="address">
                      <button
                        className="address-link"
                        onClick={() => openMemoryViewer(block.address)}
                        title="Open in Memory Viewer"
                      >
                        {formatAddress(block.address)}
                      </button>
                    </td>
                    <td className="size">{formatBytes(block.size)}</td>
                    <td className="segment">
                      {block.segments && block.segments.length > 0 ? (
                        <>
                          {block.segments.map((segment, segIdx) => (
                            <span key={segIdx}>
                              {segIdx > 0 && ", "}
                              <button
                                className="segment-link"
                                onClick={() => openMemoryViewer(segment.address)}
                                title="Open in Memory Viewer"
                              >
                                {segment.name}
                              </button>
                            </span>
                          ))}
                        </>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className={`status ${block.free ? "free" : "allocated"}`}>
                      {block.free ? "Free" : "Allocated"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {chipBlocks.length === 0 &&
          slowBlocks.length === 0 &&
          fastBlocks.length === 0 && (
            <div className="no-blocks">No memory blocks found</div>
          )}
      </div>
    </div>
  );
}
