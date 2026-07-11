/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from "assert";
import * as sinon from "sinon";
import { StackManager } from "../stackManager";
import { CpuInfo } from "../emulatorProtocol";
import { PuaeEmulator } from "../puaeEmulator";

// Helper function to create mock CPU info with required properties
function createMockCpuInfo(overrides: Partial<CpuInfo> = {}): CpuInfo {
  return {
    pc: "0x00001000",
    d0: "0x00000000",
    d1: "0x00000000",
    d2: "0x00000000",
    d3: "0x00000000",
    d4: "0x00000000",
    d5: "0x00000000",
    d6: "0x00000000",
    d7: "0x00000000",
    a0: "0x00000000",
    a1: "0x00000000",
    a2: "0x00000000",
    a3: "0x00000000",
    a4: "0x00000000",
    a5: "0x00000000",
    a6: "0x00000000",
    a7: "0x00008000",
    sr: "0x00000000",
    usp: "0x00000000",
    isp: "0x00000000",
    msp: "0x00000000",
    vbr: "0x00000000",
    irc: "0x00000000",
    sfc: "0x00000000",
    dfc: "0x00000000",
    cacr: "0x00000000",
    caar: "0x00000000",
    ...overrides,
  };
}

/**
 * Comprehensive tests for StackManager
 * Tests the stack frame analysis and DAP integration
 */
describe("StackManager - Comprehensive Tests", () => {
  let stackManager: StackManager;
  let mockEmulator: sinon.SinonStubbedInstance<PuaeEmulator>;
  let mockSourceMap: any;

  beforeEach(() => {
    mockEmulator = sinon.createStubInstance(PuaeEmulator);
    mockEmulator.getCallstack.resolves([]); // no active calls by default → just the leaf frame
    mockSourceMap = {
      lookupAddress: sinon.stub(),
      getSymbols: () => ({ main: 0x1000, sub1: 0x2000 }),
      getSegmentsInfo: () => [],
      getSymbolLengths: () => ({}),
      lookupSourceLine: sinon.stub(),
      findSymbolOffset: sinon.stub(),
      getCfaForPc: sinon.stub().returns(undefined), // no DWARF frame info → use the real callstack
      getInlineFramesForPc: sinon.stub().returns([]), // no inline frames by default
    };

    stackManager = new StackManager(mockEmulator, mockSourceMap);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe("Stack Frame Generation", () => {
    it("should return current PC as first stack frame", async () => {
      // Setup: Mock CPU state and empty stack
      const mockCpuInfo = createMockCpuInfo({ pc: "0x1000", a7: "0x8000" });
      mockEmulator.getCpuInfo.resolves(mockCpuInfo);
      mockEmulator.readMemory.resolves(Buffer.alloc(128));
      mockEmulator.isValidAddress.returns(false); // No valid return addresses in stack

      // Test: Get stack frames
      const { frames } = await stackManager.getStackFrames(0, 5);

      // Verify: Current PC is included as first frame
      assert.strictEqual(frames.length, 1);
      assert.strictEqual(frames[0].instructionPointerReference, "0x00001000");
    });

    it("should create source-based frames when debug info available", async () => {
      // Setup: Mock CPU state, stack, and source map
      const mockCpuInfo = createMockCpuInfo({ pc: "0x1000", a7: "0x8000" });
      mockEmulator.getCpuInfo.resolves(mockCpuInfo);
      mockEmulator.readMemory.resolves(Buffer.alloc(128));

      // Mock source location lookup
      mockSourceMap.lookupAddress.withArgs(0x1000).returns({
        path: "/src/main.asm",
        line: 42,
      });

      // Mock symbol offset lookup for formatAddress
      mockSourceMap.findSymbolOffset.withArgs(0x1000).returns({
        symbol: "main",
        offset: 0,
      });

      // Test: Get stack frames
      const { frames } = await stackManager.getStackFrames(0, 1);

      // Verify: Frame has source information
      assert.strictEqual(frames.length, 1);
      assert.strictEqual(frames[0].name, "0x00001000 = main");
      assert.strictEqual(frames[0].source?.path, "/src/main.asm");
      assert.strictEqual(frames[0].line, 42);
      assert.strictEqual(frames[0].instructionPointerReference, "0x00001000");
    });

    it("should create disassembly frames when no debug info available", async () => {
      // Setup: Mock CPU state with no source mapping
      const mockCpuInfo = createMockCpuInfo({ pc: "0x1000", a7: "0x8000" });
      mockEmulator.getCpuInfo.resolves(mockCpuInfo);
      mockEmulator.readMemory.resolves(Buffer.alloc(128));

      // No source location found
      mockSourceMap.lookupAddress.returns(null);

      // Test: Get stack frames
      const { frames } = await stackManager.getStackFrames(0, 1);

      // Verify: Frame is disassembly-only
      assert.strictEqual(frames.length, 1);
      assert.strictEqual(frames[0].name, "0x00001000");
      assert.strictEqual(frames[0].source, undefined);
      assert.strictEqual(frames[0].line, 0); // StackFrame constructor defaults to 0
      assert.strictEqual(frames[0].instructionPointerReference, "0x00001000");
    });

    it("should include ROM call frames (real callstack is authoritative, not heuristically truncated)", async () => {
      // Setup: shadow stack has a user-code caller and a ROM caller. Unlike the old
      // guessStack-based heuristic (which stopped at ROM addresses to avoid false
      // positives from a noisy memory scan), the real callstack is ground truth, so
      // ROM frames are legitimate and must not be dropped.
      const mockCpuInfo = createMockCpuInfo({ pc: "0x1000", a7: "0x8000" });
      mockEmulator.getCpuInfo.resolves(mockCpuInfo);
      // C side stores call sites outermost-first: 0x2000 was the first (outer) call,
      // 0xe80000 (ROM) is the most recent (immediate caller of pc).
      mockEmulator.getCallstack.resolves([0x2000, 0xe80000]);

      mockSourceMap.lookupAddress
        .withArgs(0x1000)
        .returns(null);
      mockSourceMap.lookupAddress
        .withArgs(0xe80000)
        .returns(null);
      mockSourceMap.lookupAddress
        .withArgs(0x2000)
        .returns({ path: "/src/sub.c", line: 20 });

      // Test: Get all stack frames
      const { frames } = await stackManager.getStackFrames(0, 10);

      // Verify: leaf, then immediate ROM caller, then outer user-code caller
      assert.strictEqual(frames.length, 3);
      assert.strictEqual(frames[0].instructionPointerReference, "0x00001000");
      assert.strictEqual(frames[1].instructionPointerReference, "0x00e80000");
      assert.strictEqual(frames[2].instructionPointerReference, "0x00002000");
    });

    it("should handle pagination with startFrame and maxLevels", async () => {
      // Setup: Mock CPU info and stub the shadow call-stack with multiple frames.
      // C side order is outermost-first: 0x5000 was the very first call, 0x2000 the
      // most recent — reversed by getRealCallstack to innermost-first for display.
      const mockCpuInfo = createMockCpuInfo({ pc: "0x1000", a7: "0x8000" });
      mockEmulator.getCpuInfo.resolves(mockCpuInfo);
      mockEmulator.getCallstack.resolves([0x5000, 0x4000, 0x3000, 0x2000]);

      mockSourceMap.lookupAddress.returns(null); // All disassembly frames

      // Test: Get frames 1-2 (skip first, take 2)
      const { frames } = await stackManager.getStackFrames(1, 2);

      // Verify: Returns correct slice of frames
      assert.strictEqual(frames.length, 2);
      assert.strictEqual(frames[0].instructionPointerReference, "0x00002000");
      assert.strictEqual(frames[1].instructionPointerReference, "0x00003000");
    });
  });

  describe("Real Callstack (shadow stack)", () => {
    it("returns just the current PC when the shadow stack is empty", async () => {
      mockEmulator.getCallstack.resolves([]);

      const addresses = await stackManager.getRealCallstack(0x1000, 5);

      assert.deepStrictEqual(addresses, [[0x1000, 0x1000]]);
    });

    it("reverses the C side's outermost-first order to innermost-first", async () => {
      // 0x3000 = outermost (oldest) call, 0x2000 = innermost (immediate caller)
      mockEmulator.getCallstack.resolves([0x3000, 0x2000]);
      mockEmulator.readMemory.resolves(Buffer.alloc(8)); // unknown bytes → return-address derivation falls back gracefully

      const addresses = await stackManager.getRealCallstack(0x1000, 5);

      assert.strictEqual(addresses.length, 3);
      assert.strictEqual(addresses[0][0], 0x1000);
      assert.strictEqual(addresses[1][0], 0x2000); // immediate caller shown first
      assert.strictEqual(addresses[2][0], 0x3000); // outermost caller shown last
    });

    it("derives the return address by decoding the call-site instruction", async () => {
      mockEmulator.getCallstack.resolves([0x2000]);
      // BSR.W #$10 = 61 00 00 10 (4 bytes)
      const bsrBytes = Buffer.from([0x61, 0x00, 0x00, 0x10, 0, 0, 0, 0]);
      mockEmulator.readMemory.withArgs(0x2000, 8).resolves(bsrBytes);

      const addresses = await stackManager.getRealCallstack(0x1000, 5);

      assert.deepStrictEqual(addresses[1], [0x2000, 0x2004]);
    });

    it("falls back to the call-site address as the return address on a decode/read failure", async () => {
      mockEmulator.getCallstack.resolves([0x2000]);
      mockEmulator.readMemory.withArgs(0x2000, 8).rejects(new Error("Invalid memory"));

      const addresses = await stackManager.getRealCallstack(0x1000, 5);

      assert.deepStrictEqual(addresses[1], [0x2000, 0x2000]);
    });

    it("drops the top shadow-stack entry when it duplicates the exception-adjusted leaf PC", async () => {
      // puae_debug_exceptionEnter pushes the interrupted instruction's own PC using
      // the same call-site convention as JSR/BSR, so when pc is the exception-
      // adjusted faulting address, the top (innermost/most recent) entry duplicates
      // frame 0 and must not be shown twice.
      mockEmulator.getCallstack.resolves([0x2000, 0x1000]);
      mockEmulator.readMemory.resolves(Buffer.alloc(8));

      const addresses = await stackManager.getRealCallstack(0x1000, 5);

      assert.strictEqual(addresses.length, 2);
      assert.strictEqual(addresses[0][0], 0x1000);
      assert.strictEqual(addresses[1][0], 0x2000);
    });

    it("respects maxLength", async () => {
      mockEmulator.getCallstack.resolves([0x5000, 0x4000, 0x3000, 0x2000]);
      mockEmulator.readMemory.resolves(Buffer.alloc(8));

      const addresses = await stackManager.getRealCallstack(0x1000, 3);

      assert.strictEqual(addresses.length, 3);
    });
  });

  describe("Integration with Source Maps", () => {
    it("should use source map for frame naming when available", async () => {
      // Setup: Mock CPU info (default getCallstack stub → just the leaf frame)
      const mockCpuInfo = createMockCpuInfo({ pc: "0x1000", a7: "0x8000" });
      mockEmulator.getCpuInfo.resolves(mockCpuInfo);

      mockSourceMap.lookupAddress.withArgs(0x1000).returns({
        path: "/project/src/main.asm",
        line: 25,
      });

      // Mock symbol offset lookup for formatAddress
      mockSourceMap.findSymbolOffset.withArgs(0x1000).returns({
        symbol: "main",
        offset: 0,
      });

      // Test: Get frames
      const { frames } = await stackManager.getStackFrames(0, 1);

      // Verify: Uses source map for naming and location
      assert.strictEqual(frames.length, 1);
      assert.strictEqual(frames[0].name, "0x00001000 = main");
      assert.strictEqual(frames[0].source?.name, "main.asm");
      assert.strictEqual(frames[0].source?.path, "/project/src/main.asm");
      assert.strictEqual(frames[0].line, 25);
    });

    it("should fall back to disassembly frames when source map has no info", async () => {
      // Setup: Mock CPU info (default getCallstack stub → just the leaf frame)
      const mockCpuInfo = createMockCpuInfo({ pc: "0x1000", a7: "0x8000" });
      mockEmulator.getCpuInfo.resolves(mockCpuInfo);

      // Mock source map returns null (no debug info for this address)
      mockSourceMap.lookupAddress.withArgs(0x1000).returns(null);

      // Test: Get frames when source map has no info for address
      const { frames } = await stackManager.getStackFrames(0, 1);

      // Verify: Falls back to disassembly frame
      assert.strictEqual(frames.length, 1);
      assert.strictEqual(frames[0].name, "0x00001000");
      assert.strictEqual(frames[0].source, undefined);
      assert.strictEqual(frames[0].line, 0); // StackFrame constructor defaults to 0
      assert.strictEqual(frames[0].instructionPointerReference, "0x00001000");
    });
  });

  describe("DWARF Stack Unwinding", () => {
    it("should unwind frames using DWARF CFA when available (SP-relative)", async () => {
      // Scenario: two nested calls, no frame pointer (-fomit-frame-pointer).
      // Frame 0: PC=0x1000, SP=0x8000, CFA=SP+4=0x8004, return addr at mem[0x8000]=0x2000
      // Frame 1: PC=0x2000, SP=0x8004, CFA=SP+4=0x8008, return addr at mem[0x8004]=0x3000
      // Frame 2: PC=0x3000, no DWARF info → stop
      const mockCpuInfo = createMockCpuInfo({ pc: "0x1000", a7: "0x8000" });
      mockEmulator.getCpuInfo.resolves(mockCpuInfo);
      mockEmulator.isValidAddress.returns(true);
      mockSourceMap.lookupAddress.returns(null);

      mockSourceMap.getCfaForPc.withArgs(0x1000).returns({ reg: 15, offset: 4 });
      mockSourceMap.getCfaForPc.withArgs(0x2000).returns({ reg: 15, offset: 4 });
      // getCfaForPc for 0x3000 returns undefined (default stub behaviour) → unwind stops

      const buf1 = Buffer.alloc(4); buf1.writeUInt32BE(0x2000, 0);
      const buf2 = Buffer.alloc(4); buf2.writeUInt32BE(0x3000, 0);
      mockEmulator.readMemory.withArgs(0x8000, 4).resolves(buf1); // CFA-4 for frame 0
      mockEmulator.readMemory.withArgs(0x8004, 4).resolves(buf2); // CFA-4 for frame 1

      const { frames } = await stackManager.getStackFrames(0, 10);

      assert.strictEqual(frames.length, 3);
      assert.strictEqual(frames[0].instructionPointerReference, "0x00001000");
      assert.strictEqual(frames[1].instructionPointerReference, "0x00002000");
      assert.strictEqual(frames[2].instructionPointerReference, "0x00003000");
    });

    it("should restore the frame-pointer register when CFA is not SP-relative (link Ax case)", async () => {
      // Scenario: function entered via `link a5, #N`.
      // A5=0x7FF8, CFA = A5+8 = 0x8000 (DWARF reg 13 = A5)
      // Return address at mem[CFA-4] = mem[0x7FFC] = 0x2000
      // Saved old A5   at mem[CFA-8] = mem[0x7FF8] = 0x7000
      // After unwind: SP=0x8000, A5=0x7000; no DWARF info at 0x2000→ stop
      const mockCpuInfo = createMockCpuInfo({ pc: "0x1000", a5: "0x7FF8", a7: "0x7FEC" });
      mockEmulator.getCpuInfo.resolves(mockCpuInfo);
      mockEmulator.isValidAddress.returns(true);
      mockSourceMap.lookupAddress.returns(null);

      mockSourceMap.getCfaForPc.withArgs(0x1000).returns({ reg: 13, offset: 8 }); // A5 = DWARF r13

      const retBuf = Buffer.alloc(4); retBuf.writeUInt32BE(0x2000, 0);
      const a5Buf = Buffer.alloc(4); a5Buf.writeUInt32BE(0x7000, 0);
      mockEmulator.readMemory.withArgs(0x7FFC, 4).resolves(retBuf); // CFA-4 = 0x7FFC
      mockEmulator.readMemory.withArgs(0x7FF8, 4).resolves(a5Buf); // CFA-8 = 0x7FF8 (saved A5)

      const { frames } = await stackManager.getStackFrames(0, 10);

      assert.strictEqual(frames.length, 2);
      assert.strictEqual(frames[0].instructionPointerReference, "0x00001000");
      assert.strictEqual(frames[1].instructionPointerReference, "0x00002000");
    });

    it("should insert synthetic inline frames before the real frame (DWARF path only)", async () => {
      const mockCpuInfo = createMockCpuInfo({ pc: "0x1000", a7: "0x8000" });
      mockEmulator.getCpuInfo.resolves(mockCpuInfo);
      mockEmulator.isValidAddress.returns(true);

      // DWARF CFA at 0x1000: SP+4 → CFA=0x8004, return address at mem[0x8000]=0x2000
      mockSourceMap.getCfaForPc.withArgs(0x1000).returns({ reg: 15, offset: 4 });
      const retBuf = Buffer.alloc(4); retBuf.writeUInt32BE(0x2000, 0);
      mockEmulator.readMemory.withArgs(0x8000, 4).resolves(retBuf);
      // No DWARF info at 0x2000 → unwind stops
      mockSourceMap.lookupAddress.withArgs(0x2000).returns(null);

      // Real frame 0x1000 has a source location
      mockSourceMap.lookupAddress.withArgs(0x1000).returns({ path: "/src/outer.c", line: 10 });
      // One inline function wraps the code at 0x1000, called from line 20
      mockSourceMap.getInlineFramesForPc.withArgs(0x1000).returns([
        { name: "inline_func", callPath: "/src/outer.c", callLine: 20 },
      ]);

      const { frames } = await stackManager.getStackFrames(0, 10);

      // inline frame + real outer (0x1000) + no-source frame (0x2000)
      assert.strictEqual(frames.length, 3);
      // Inline frame: name = function name, location = raw PC location (lookupAddress)
      assert.strictEqual(frames[0].name, "inline_func (inline)");
      assert.strictEqual(frames[0].line, 10);
      assert.strictEqual(frames[0].instructionPointerReference, "0x00001000");
      // Real frame: location overridden to call site of the inline
      assert.strictEqual(frames[1].line, 20);
      assert.strictEqual(frames[1].instructionPointerReference, "0x00001000");
    });

    it("should fall back to the real callstack when getCfaForPc returns undefined for current PC", async () => {
      const mockCpuInfo = createMockCpuInfo({ pc: "0x1000", a7: "0x8000" });
      mockEmulator.getCpuInfo.resolves(mockCpuInfo);
      // getCfaForPc returns undefined (default stub) → real-callstack path
      mockEmulator.getCallstack.resolves([0x2000]);
      mockSourceMap.lookupAddress.returns(null);

      const { frames } = await stackManager.getStackFrames(0, 10);

      assert.strictEqual(frames.length, 2);
      assert.strictEqual(frames[0].instructionPointerReference, "0x00001000");
      assert.strictEqual(frames[1].instructionPointerReference, "0x00002000");
    });
  });
});
