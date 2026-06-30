// Where a per-sample CPU register (model.registers — REG_COUNT-wide slice per sample, see
// shared/profilerTypes.ts) last changed to its value at a given sample, or will next change away
// from it — the "jump to where this was set" / "jump to next write" pair for the Disassembly
// view's CPU Registers panel, mirroring Memory View's findPrevMemWrite/findNextMemWrite and
// Custom Registers' findPrevRegWrite/findNextRegWrite. CPU registers have no discrete DMA write
// events to search, just a continuous per-sample trace, so "where was this set" means "walk
// backward to the start of the run of samples sharing this exact value" instead.

// The sample index where `registers[atIdx]`'s value for `regIndex` started being held — walks
// backward from `atIdx` while the previous sample has the same value. Returns `atIdx` itself
// (clamped into range) if the register changed AT this sample, or has held this value since the
// start of the trace (sample 0).
export function findRegSetSample(
  registers: Uint32Array,
  regCount: number,
  sampleCount: number,
  regIndex: number,
  atIdx: number,
): number {
  if (sampleCount <= 0) return 0;
  const clamped = Math.max(0, Math.min(atIdx, sampleCount - 1));
  const value = registers[clamped * regCount + regIndex];
  let j = clamped;
  while (j > 0 && registers[(j - 1) * regCount + regIndex] === value) j--;
  return j;
}

// The next sample index after `atIdx` where `regIndex`'s value differs from its value at `atIdx`
// — i.e. where it's next "written" to something else. Undefined if it never changes again before
// the end of the trace.
export function findRegNextChangeSample(
  registers: Uint32Array,
  regCount: number,
  sampleCount: number,
  regIndex: number,
  atIdx: number,
): number | undefined {
  if (atIdx < 0 || atIdx >= sampleCount - 1) return undefined;
  const value = registers[atIdx * regCount + regIndex];
  for (let j = atIdx + 1; j < sampleCount; j++) {
    if (registers[j * regCount + regIndex] !== value) return j;
  }
  return undefined;
}
