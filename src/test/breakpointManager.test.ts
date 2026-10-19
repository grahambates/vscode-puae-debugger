/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from "assert";
import * as sinon from "sinon";
import { BreakpointManager } from "../breakpointManager";
import { Emulator } from "../emulator";
import { copperMoveBefore } from "../hardware";

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
    findSymbolOffset: sinon.stub().returns(undefined),
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

describe("BreakpointManager - logpoints", () => {
  it("stores and retrieves a source breakpoint's logMessage", async () => {
    const { emulator } = createFakeEmulator(true);
    const bpManager = new BreakpointManager(emulator, createFakeSourceMap());

    const [bp] = await bpManager.setSourceBreakpoints("/test.s", [
      { line: 10, logMessage: "d0 is {d0}" },
    ]);

    assert.strictEqual(bpManager.getLogMessage(bp.id!), "d0 is {d0}");
  });

  it("returns undefined when no logMessage was set", async () => {
    const { emulator } = createFakeEmulator(true);
    const bpManager = new BreakpointManager(emulator, createFakeSourceMap());

    const [bp] = await bpManager.setSourceBreakpoints("/test.s", [{ line: 10 }]);

    assert.strictEqual(bpManager.getLogMessage(bp.id!), undefined);
  });
});

describe("BreakpointManager - copper-sourced watchpoint attribution", () => {
  it("names the copper MOVE that wrote the register, one instruction behind the list pointer", async () => {
    const { fake, emulator } = createFakeEmulator(true);
    // MOVE #$0F00,COLOR00 at $3FFC; the copper's list pointer has already moved on to $4000.
    (fake as Record<string, unknown>).readMemory = sinon.stub().withArgs(0x3ffc, 2).resolves(Buffer.from([0x01, 0x80]));
    const sourceMap = createFakeSourceMap();
    sourceMap.lookupAddress = sinon
      .stub()
      .withArgs(0x3ffc)
      .returns({ path: "/copperlist.s", line: 41 });
    const bpManager = new BreakpointManager(emulator, sourceMap);

    const result = await bpManager.handleBreakpointStop({
      hasMessage: true,
      name: "WATCHPOINT_REACHED",
      payload: { pc: 0xdff180, addr: 0xdff180, accessKind: 2, sizeBits: 16, value: 0x0f00, oldValue: 0x0349, vector: 0, source: 1, cpuPc: 0x1234, copperPc: 0x4000 },
    });

    // What was written, where, what it was before, and the MOVE that did it, with its source line.
    assert.ok(result.text?.includes("write.w $0f00 to 0x00dff180 (COLOR00), was $0349"), result.text);
    assert.ok(result.text?.includes("by the copper MOVE at 0x00003ffc"), result.text);
    assert.ok(result.text?.includes("copperlist.s:41"), result.text);
    // The CPU's PC is incidental to a copper write, and labelled so.
    assert.ok(result.text?.includes("which is not the cause"), result.text);
  });

  it("shows the raw list pointer, as such, when the MOVE can't be confirmed", async () => {
    const { fake, emulator } = createFakeEmulator(true);
    // The instruction before the pointer is a WAIT, not a MOVE to COLOR00.
    (fake as Record<string, unknown>).readMemory = sinon.stub().resolves(Buffer.from([0x2c, 0x07]));
    const bpManager = new BreakpointManager(emulator, createFakeSourceMap());

    const result = await bpManager.handleBreakpointStop({
      hasMessage: true,
      name: "WATCHPOINT_REACHED",
      payload: { pc: 0xdff180, vector: 0, source: 1, cpuPc: 0x1234, copperPc: 0x4000 },
    });

    assert.ok(result.text?.includes("by the copper (list pointer at 0x00004000"), result.text);
    assert.ok(!result.text?.includes("copper MOVE"), result.text);
  });

  it("omits the copper pc/source-line for a Blitter/disk-sourced chip RAM write", async () => {
    const { emulator } = createFakeEmulator(true);
    const sourceMap = createFakeSourceMap();
    const bpManager = new BreakpointManager(emulator, sourceMap);

    const result = await bpManager.handleBreakpointStop({
      hasMessage: true,
      name: "WATCHPOINT_REACHED",
      payload: { pc: 0x2000, vector: 0, source: 1, cpuPc: 0x1234 },
    });

    assert.ok(result.text?.includes("by DMA (blitter or disk), not the CPU"), result.text);
    assert.ok(!result.text?.includes("copper"), result.text);
  });
});

describe("BreakpointManager - data breakpoint ranges", () => {
  it("watches exactly the variable's bytes, as aligned blocks, and matches a hit on any of them", async () => {
    const { fake, emulator } = createFakeEmulator(false);
    const sourceMap = createFakeSourceMap();
    sourceMap.getSymbols = sinon.stub().returns({ table: 0x1006 });
    const bpManager = new BreakpointManager(emulator, sourceMap);
    // A 12-byte variable at $1006: one watchpoint would have to cover $1000-$100f or more,
    // taking in its neighbours. Three blocks cover it exactly.
    await bpManager.setWatchpointLengthOverride("symbols:table", 12);
    const [bp] = await bpManager.setDataBreakpoints([{ dataId: "symbols:table", accessType: "write" }]);

    const armed = fake.setWatchpoint.getCalls().map((c) => [c.args[0], c.args[2].length]);
    assert.deepStrictEqual(armed, [[0x1006, 2], [0x1008, 8], [0x1010, 2]]);
    assert.ok(fake.setWatchpoint.getCalls().every((c) => c.args[2].write && !c.args[2].read));

    const hit = await bpManager.handleBreakpointStop({
      hasMessage: true,
      name: "WATCHPOINT_REACHED",
      payload: { pc: 0x1008, addr: 0x100a, accessKind: 2, sizeBits: 16, value: 7, oldValue: 3, vector: 0, source: 0, cpuPc: 0x2000 },
    });
    assert.deepStrictEqual(hit.hitBreakpointIds, [bp.id]);
    assert.ok(hit.text?.includes("write.w $0007 to"), hit.text);
    assert.ok(hit.text?.includes("was $0003 — by the CPU at 0x00002000"), hit.text);
  });

  it("re-splits the range when its length is changed", async () => {
    const { fake, emulator } = createFakeEmulator(false);
    const sourceMap = createFakeSourceMap();
    sourceMap.getSymbols = sinon.stub().returns({ table: 0x1006 });
    const bpManager = new BreakpointManager(emulator, sourceMap);
    await bpManager.setWatchpointLengthOverride("symbols:table", 2);
    await bpManager.setDataBreakpoints([{ dataId: "symbols:table" }]);
    fake.setWatchpoint.resetHistory();
    await bpManager.setWatchpointLengthOverride("symbols:table", 4);
    assert.deepStrictEqual(fake.removeWatchpoint.getCalls().map((c) => c.args[0]), [0x1006]);
    assert.deepStrictEqual(fake.setWatchpoint.getCalls().map((c) => [c.args[0], c.args[2].length]), [[0x1006, 2], [0x1008, 2]]);
  });
});

describe("copperMoveBefore", () => {
  const read = (bytes: number[]) => async () => Uint8Array.from(bytes);

  it("returns the MOVE one instruction behind the pointer when it targets the written register", async () => {
    assert.strictEqual(await copperMoveBefore(0x4000, 0xdff180, read([0x01, 0x80])), 0x3ffc);
  });

  it("refuses a MOVE to a different register, a WAIT, or an unreadable address", async () => {
    assert.strictEqual(await copperMoveBefore(0x4000, 0xdff180, read([0x01, 0x82])), undefined);
    assert.strictEqual(await copperMoveBefore(0x4000, 0xdff180, read([0x2c, 0x07])), undefined);
    assert.strictEqual(await copperMoveBefore(0x4000, 0xdff180, async () => { throw new Error("no"); }), undefined);
    assert.strictEqual(await copperMoveBefore(undefined, 0xdff180, read([0x01, 0x80])), undefined);
  });
});
