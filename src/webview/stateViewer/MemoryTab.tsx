import { MemoryInfo } from "../../shared/stateViewerTypes";
import "./MemoryTab.css";

interface MemoryTabProps {
  memoryInfo: MemoryInfo;
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

function getMemoryTypeName(attributes: number): string {
  const MEMF_CHIP = 0x00000002;
  const MEMF_FAST = 0x00000004;

  if (attributes & MEMF_CHIP) {
    return "CHIP";
  } else if (attributes & MEMF_FAST) {
    return "FAST";
  }
  return "OTHER";
}

export function MemoryTab({ memoryInfo }: MemoryTabProps) {
  const chipUsed = memoryInfo.totalChip - memoryInfo.freeChip;
  const fastUsed = memoryInfo.totalFast - memoryInfo.freeFast;
  const chipPercent =
    memoryInfo.totalChip > 0
      ? ((chipUsed / memoryInfo.totalChip) * 100).toFixed(1)
      : "0.0";
  const fastPercent =
    memoryInfo.totalFast > 0
      ? ((fastUsed / memoryInfo.totalFast) * 100).toFixed(1)
      : "0.0";

  // Group blocks by type and status
  const chipFreeBlocks = memoryInfo.blocks
    .filter((b) => b.free && (b.attributes & 0x02))
    .sort((a, b) => a.address - b.address);
  const chipAllocatedBlocks = memoryInfo.blocks
    .filter((b) => !b.free && (b.attributes & 0x02))
    .sort((a, b) => a.address - b.address);
  const fastFreeBlocks = memoryInfo.blocks
    .filter((b) => b.free && (b.attributes & 0x04))
    .sort((a, b) => a.address - b.address);
  const fastAllocatedBlocks = memoryInfo.blocks
    .filter((b) => !b.free && (b.attributes & 0x04))
    .sort((a, b) => a.address - b.address);

  return (
    <div className="memory-tab">
      <div className="memory-summary">
        <h2>Memory Summary</h2>
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
        <h2>Memory Blocks</h2>

        {/* CHIP Memory Section */}
        {(chipFreeBlocks.length > 0 || chipAllocatedBlocks.length > 0) && (
          <div className="memory-type-section">
            <h3 className="memory-type-header">CHIP Memory</h3>

            {chipAllocatedBlocks.length > 0 && (
              <div className="blocks-section">
                <h4 className="blocks-subsection-header">
                  Allocated Blocks ({chipAllocatedBlocks.length})
                </h4>
                <table className="blocks-table">
                  <thead>
                    <tr>
                      <th>Address</th>
                      <th>End Address</th>
                      <th>Size</th>
                      <th>Segment</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chipAllocatedBlocks.map((block, idx) => (
                      <tr key={idx} className="allocated-row">
                        <td className="address">{formatAddress(block.address)}</td>
                        <td className="address">
                          {formatAddress(block.address + block.size)}
                        </td>
                        <td className="size">{formatBytes(block.size)}</td>
                        <td className="segment">
                          {block.segmentName || "-"}
                        </td>
                        <td className="status allocated">Allocated</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {chipFreeBlocks.length > 0 && (
              <div className="blocks-section">
                <h4 className="blocks-subsection-header">
                  Free Blocks ({chipFreeBlocks.length})
                </h4>
                <table className="blocks-table">
                  <thead>
                    <tr>
                      <th>Address</th>
                      <th>End Address</th>
                      <th>Size</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chipFreeBlocks.map((block, idx) => (
                      <tr key={idx} className="free-row">
                        <td className="address">{formatAddress(block.address)}</td>
                        <td className="address">
                          {formatAddress(block.address + block.size)}
                        </td>
                        <td className="size">{formatBytes(block.size)}</td>
                        <td className="status free">Free</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* FAST Memory Section */}
        {(fastFreeBlocks.length > 0 || fastAllocatedBlocks.length > 0) && (
          <div className="memory-type-section">
            <h3 className="memory-type-header">FAST Memory</h3>

            {fastAllocatedBlocks.length > 0 && (
              <div className="blocks-section">
                <h4 className="blocks-subsection-header">
                  Allocated Blocks ({fastAllocatedBlocks.length})
                </h4>
                <table className="blocks-table">
                  <thead>
                    <tr>
                      <th>Address</th>
                      <th>End Address</th>
                      <th>Size</th>
                      <th>Segment</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fastAllocatedBlocks.map((block, idx) => (
                      <tr key={idx} className="allocated-row">
                        <td className="address">{formatAddress(block.address)}</td>
                        <td className="address">
                          {formatAddress(block.address + block.size)}
                        </td>
                        <td className="size">{formatBytes(block.size)}</td>
                        <td className="segment">
                          {block.segmentName || "-"}
                        </td>
                        <td className="status allocated">Allocated</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {fastFreeBlocks.length > 0 && (
              <div className="blocks-section">
                <h4 className="blocks-subsection-header">
                  Free Blocks ({fastFreeBlocks.length})
                </h4>
                <table className="blocks-table">
                  <thead>
                    <tr>
                      <th>Address</th>
                      <th>End Address</th>
                      <th>Size</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fastFreeBlocks.map((block, idx) => (
                      <tr key={idx} className="free-row">
                        <td className="address">{formatAddress(block.address)}</td>
                        <td className="address">
                          {formatAddress(block.address + block.size)}
                        </td>
                        <td className="size">{formatBytes(block.size)}</td>
                        <td className="status free">Free</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {chipFreeBlocks.length === 0 &&
          chipAllocatedBlocks.length === 0 &&
          fastFreeBlocks.length === 0 &&
          fastAllocatedBlocks.length === 0 && (
            <div className="no-blocks">No memory blocks found</div>
          )}
      </div>
    </div>
  );
}
