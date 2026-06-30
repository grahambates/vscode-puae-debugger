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
  it("jumps to the start of the run immediately before atIdx's run (one transition back)", () => {
    const regs = buildRegisters(); // D0 = [1,1,1,2,2]
    // atIdx=4 (value 2, run starts at 3) → previous run starts at 0
    expect(findPrevRegChangeSample(regs, REG_COUNT, 5, D0, 4)).toBe(0);
    // atIdx=2 (value 1, run starts at 0) → no run before → undefined
    expect(findPrevRegChangeSample(regs, REG_COUNT, 5, D0, 2)).toBeUndefined();
  });

  it("repeatedly cycling backward visits every run in order", () => {
    // D0 = [0, 1, 1, 2, 2, 3] — three distinct runs
    const regs = new Uint32Array(6 * REG_COUNT);
    [0, 1, 1, 2, 2, 3].forEach((v, i) => { regs[i * REG_COUNT + D0] = v; });

    // start from run [3] at index 5
    const a = findPrevRegChangeSample(regs, REG_COUNT, 6, D0, 5); expect(a).toBe(3); // start of run [2,2]
    const b = findPrevRegChangeSample(regs, REG_COUNT, 6, D0, a!); expect(b).toBe(1); // start of run [1,1]
    const c = findPrevRegChangeSample(regs, REG_COUNT, 6, D0, b!); expect(c).toBe(0); // start of run [0]
    const d = findPrevRegChangeSample(regs, REG_COUNT, 6, D0, c!); expect(d).toBeUndefined(); // before beginning
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
