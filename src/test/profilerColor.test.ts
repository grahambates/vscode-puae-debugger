import { heatColor } from "../shared/profilerColor";

describe("heatColor", () => {
  it("returns undefined for zero or negative cycles", () => {
    expect(heatColor(0, 100)).toBeUndefined();
    expect(heatColor(-5, 100)).toBeUndefined();
  });

  it("returns undefined for zero or negative maxCycles", () => {
    expect(heatColor(10, 0)).toBeUndefined();
    expect(heatColor(10, -1)).toBeUndefined();
  });

  it("scales alpha proportionally to cycles/maxCycles", () => {
    expect(heatColor(50, 100)).toBe("rgba(255,140,0,0.250)"); // heat=0.5, alpha=0.5*0.5
    expect(heatColor(100, 100)).toBe("rgba(255,140,0,0.500)"); // heat=1.0, alpha=0.5*1.0
    expect(heatColor(25, 100)).toBe("rgba(255,140,0,0.125)"); // heat=0.25
  });

  it("clamps heat to 1 when cycles exceeds maxCycles", () => {
    expect(heatColor(200, 100)).toBe("rgba(255,140,0,0.500)");
  });

  it("respects a custom maxAlpha", () => {
    expect(heatColor(100, 100, 1)).toBe("rgba(255,140,0,1.000)");
  });
});
