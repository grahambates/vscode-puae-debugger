/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from "assert";
import * as sinon from "sinon";
import { BreakpointManager } from "../breakpointManager";
import { Emulator } from "../emulator";

/**
 * Minimal fake satisfying only the Emulator methods BreakpointManager
 * actually calls. `supportsHitCounts` is the one property under test here:
 * true emulates vAmiga (native ignores), false emulates PUAE (TS-emulated
 * hit counting in BreakpointManager).
 */
function createFakeEmulator(supportsHitCounts: boolean) {
  const fake = {
    supportsHitCounts,
    setBreakpoint: sinon.stub(),
    removeBreakpoint: sinon.stub(),
    setWatchpoint: sinon.stub(),
    removeWatchpoint: sinon.stub(),
    setRegisterWatch: sinon.stub(),
    removeRegisterWatch: sinon.stub(),
    setCatchpoint: sinon.stub(),
    removeCatchpoint: sinon.stub(),
    setMemoryProtectionEnabled: sinon.stub(),
    getCpuInfo: sinon.stub().resolves({ vbr: "0x00000000" }),
  };
  return { fake, emulator: fake as unknown as Emulator };
}

function createFakeSourceMap(address = 0x1000) {
  return {
    lookupSourceLine: sinon.stub().returns({ address }),
    getSymbols: sinon.stub().returns({}),
    getGlobalVariables: sinon.stub().returns([]),
    lookupAddress: sinon.stub().returns(null),
    getSymbolLengths: sinon.stub().returns({}),
  } as any;
}

describe("BreakpointManager - hit counts", () => {
  it("passes ignores straight to the emulator when it counts natively", async () => {
    const { fake, emulator } = createFakeEmulator(true);
    const bpManager = new BreakpointManager(emulator, createFakeSourceMap());

    await bpManager.setSourceBreakpoints("/test.s", [
      { line: 10, hitCondition: "3" },
    ]);

    // hitCondition "3" => ignore the first 2 hits => ignores = 2
    assert.ok(fake.setBreakpoint.calledWith(0x1000, 2));
    // consumeIgnore never has anything to consume on a native backend.
    assert.strictEqual(bpManager.consumeIgnore(0), false);
    assert.strictEqual(bpManager.consumeIgnore(0), false);
  });

  it("emulates ignores in TS when the backend fires on every hit", async () => {
    const { fake, emulator } = createFakeEmulator(false);
    const bpManager = new BreakpointManager(emulator, createFakeSourceMap());

    const [bp] = await bpManager.setSourceBreakpoints("/test.s", [
      { line: 10, hitCondition: "3" },
    ]);

    // The backend never sees a nonzero ignores count - it would otherwise
    // fire on every hit regardless and warn about it (PUAE).
    assert.ok(fake.setBreakpoint.calledWith(0x1000, 0));

    // First 2 hits ignored, 3rd (and every one after) stops.
    assert.strictEqual(bpManager.consumeIgnore(bp.id!), true);
    assert.strictEqual(bpManager.consumeIgnore(bp.id!), true);
    assert.strictEqual(bpManager.consumeIgnore(bp.id!), false);
    assert.strictEqual(bpManager.consumeIgnore(bp.id!), false);
  });

  it("consumeIgnore is a no-op for ids with no hit condition", async () => {
    const { fake, emulator } = createFakeEmulator(false);
    const bpManager = new BreakpointManager(emulator, createFakeSourceMap());

    const [bp] = await bpManager.setSourceBreakpoints("/test.s", [{ line: 10 }]);

    assert.ok(fake.setBreakpoint.calledWith(0x1000, 0));
    assert.strictEqual(bpManager.consumeIgnore(bp.id!), false);
  });
});

describe("BreakpointManager - conditions", () => {
  it("stores and retrieves a breakpoint's condition expression", async () => {
    const { emulator } = createFakeEmulator(true);
    const bpManager = new BreakpointManager(emulator, createFakeSourceMap());

    const [bp] = await bpManager.setSourceBreakpoints("/test.s", [
      { line: 10, condition: "d0 > 5" },
    ]);

    assert.strictEqual(bpManager.getCondition(bp.id!), "d0 > 5");
  });

  it("returns undefined when no condition was set", async () => {
    const { emulator } = createFakeEmulator(true);
    const bpManager = new BreakpointManager(emulator, createFakeSourceMap());

    const [bp] = await bpManager.setSourceBreakpoints("/test.s", [{ line: 10 }]);

    assert.strictEqual(bpManager.getCondition(bp.id!), undefined);
  });
});
