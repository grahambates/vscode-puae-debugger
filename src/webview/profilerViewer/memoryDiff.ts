// Pure diff logic for MemoryView's change-fade highlighting, kept in a plain .ts module (not
// .tsx) so it's importable from jest tests — ts-jest's root tsconfig has no JSX support; webview
// JSX is type-checked separately (see src/webview/tsconfig.json), so a .tsx import fails to parse
// under the test runner.

// Mark every byte that differs between `prev` and `next` with `now` in `changed`, and evict
// entries older than `fadeMs`. Runs once per debounced reconstruction (not per render/frame), so
// a full-buffer (up to ~2MB) compare here is the same order of magnitude as the reconstruction
// that already just ran, not a new bottleneck class.
export function markChanges(prev: Uint8Array, next: Uint8Array, changed: Map<number, number>, now: number, fadeMs: number): void {
  const len = Math.min(prev.length, next.length);
  for (let i = 0; i < len; i++) {
    if (prev[i] !== next[i]) changed.set(i, now);
  }
  const cutoff = now - fadeMs;
  for (const [off, ts] of changed) {
    if (ts < cutoff) changed.delete(off);
  }
}
