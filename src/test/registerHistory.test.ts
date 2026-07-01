import { findRegSetSample, findPrevRegChangeSample, findRegNextChangeSample } from "../webview/profilerViewer/registerHistory";

const REG_COUNT = 19;
const D0 = 0;
const D1 = 1;

// 5 samples; D0 = [1,1,1,2,2], D1 = [9,9,9,9,9] (never changes).
function buildRegisters(): Uint32Array {
  const regs = new Uint32Array(5 * REG_COUNT);
  const d0 = [1, 1, 1, 2, 2];
  for (let i = 0; i < 5; i++) {
    regs[i * REG_COUNT + D0] = d0[i];
    regs[i * REG_COUNT + D1] = 9;
  }
  return regs;
}

describe("findRegSetSample", () => {
  it("walks back to the start of the run sharing the current value", () => {
    const regs = buildRegisters();
    expect(findRegSetSample(regs, REG_COUNT, 5, D0, 2)).toBe(0); // value 1 since sample 0
    expect(findRegSetSample(regs, REG_COUNT, 5, D0, 4)).toBe(3); // value 2 set at sample 3
  });

  it("returns the sample itself when the value changed exactly there", () => {
    const regs = buildRegisters();
    expect(findRegSetSample(regs, REG_COUNT, 5, D0, 3)).toBe(3);
  });

  it("returns sample 0 for a register that never changes", () => {
    const regs = buildRegisters();
    expect(findRegSetSample(regs, REG_COUNT, 5, D1, 4)).toBe(0);
  });

  it("clamps an out-of-range index into bounds", () => {
    const regs = buildRegisters();
    expect(findRegSetSample(regs, REG_COUNT, 5, D0, 999)).toBe(3);
    expect(findRegSetSample(regs, REG_COUNT, 5, D0, -1)).toBe(0);
  });

  it("returns 0 for an empty trace", () => {
    expect(findRegSetSample(new Uint32Array(0), REG_COUNT, 0, D0, 0)).toBe(0);
  });
});

describe("findPrevRegChangeSample", () => {
  // model.registers[k] is captured BEFORE instruction k executes. So if instruction k writes
  // D0=2, the new value first appears at sample k+1. findRegSetSample returns k+1 (the first
  // reader), and we subtract 1 to get k (the actual writer instruction).
  it("returns the sample whose instruction SET the current value (not the first reader)", () => {
    const regs = buildRegisters(); // D0 = [1,1,1,2,2]; instruction at sample 2 SET D0=2
    // atIdx=4 (value 2, first seen at sample 3 → writer is sample 2)
    expect(findPrevRegChangeSample(regs, REG_COUNT, 5, D0, 4)).toBe(2);
    // atIdx=2 (value 1, first seen at sample 0 — before the trace started) → undefined
    expect(findPrevRegChangeSample(regs, REG_COUNT, 5, D0, 2)).toBeUndefined();
  });

  it("repeatedly cycling backward lands on the writer instruction each time", () => {
    // D0 = [0, 1, 1, 2, 2, 3] — instruction at sample 0 sets D0=1 (seen at 1),
    //                              instruction at sample 2 sets D0=2 (seen at 3),
    //                              instruction at sample 4 sets D0=3 (seen at 5).
    const regs = new Uint32Array(6 * REG_COUNT);
    [0, 1, 1, 2, 2, 3].forEach((v, i) => { regs[i * REG_COUNT + D0] = v; });

    // from index 5 (D0=3): writer is sample 4; D0[4]=2 (before it ran)
    const a = findPrevRegChangeSample(regs, REG_COUNT, 6, D0, 5); expect(a).toBe(4);
    // from index 4 (D0=2): writer is sample 2; D0[2]=1 (before it ran)
    const b = findPrevRegChangeSample(regs, REG_COUNT, 6, D0, a!); expect(b).toBe(2);
    // from index 2 (D0=1): writer is sample 0; D0[0]=0 (before it ran — a truly first write)
    const c = findPrevRegChangeSample(regs, REG_COUNT, 6, D0, b!); expect(c).toBe(0);
    // from index 0 (D0=0): this value appeared before the trace started → undefined
    const d = findPrevRegChangeSample(regs, REG_COUNT, 6, D0, c!); expect(d).toBeUndefined();
  });

  it("returns undefined when already at or before the first run", () => {
    const regs = buildRegisters();
    expect(findPrevRegChangeSample(regs, REG_COUNT, 5, D0, 0)).toBeUndefined();
    expect(findPrevRegChangeSample(regs, REG_COUNT, 5, D1, 4)).toBeUndefined(); // D1 never changes
  });
});

describe("findRegNextChangeSample", () => {
  it("finds the next sample where the value differs", () => {
    const regs = buildRegisters();
    expect(findRegNextChangeSample(regs, REG_COUNT, 5, D0, 0)).toBe(3);
    expect(findRegNextChangeSample(regs, REG_COUNT, 5, D0, 1)).toBe(3);
  });

  it("returns undefined when the value never changes again", () => {
    const regs = buildRegisters();
    expect(findRegNextChangeSample(regs, REG_COUNT, 5, D0, 3)).toBeUndefined(); // last 2 samples both =2
    expect(findRegNextChangeSample(regs, REG_COUNT, 5, D1, 0)).toBeUndefined(); // D1 never changes
  });

  it("returns undefined at or past the last sample", () => {
    const regs = buildRegisters();
    expect(findRegNextChangeSample(regs, REG_COUNT, 5, D0, 4)).toBeUndefined();
    expect(findRegNextChangeSample(regs, REG_COUNT, 5, D0, 5)).toBeUndefined();
  });
});
