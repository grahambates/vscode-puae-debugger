// Pure numeric helpers for memory-byte interpretation, shared across webviews (the live memory
// viewer's HexDump and the profiler's MemoryView) so a "what does this byte/word/long mean"
// helper has exactly one implementation rather than one per consumer.

// Convert an unsigned value to signed, based on its size in bytes (1/2/4).
export function convertToSigned(value: number, valueSize: number): number {
  if (valueSize === 1) {
    return value > 0x7f ? value - 0x100 : value;
  } else if (valueSize === 2) {
    return value > 0x7fff ? value - 0x1_0000 : value;
  } else {
    return value > 0x7fff_ffff ? value - 0x1_0000_0000 : value;
  }
}
