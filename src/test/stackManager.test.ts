/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from "assert";
import * as sinon from "sinon";
import { StackManager } from "../stackManager";
import { VAmiga, CpuInfo } from "../vAmiga";

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
  let mockVAmiga: sinon.SinonStubbedInstance<VAmiga>;
  let mockSourceMap: any;

  beforeEach(() => {
    mockVAmiga = sinon.createStubInstance(VAmiga);
    mockSourceMap = {
      lookupAddress: sinon.stub(),
      getSymbols: () => ({ main: 0x1000, sub1: 0x2000 }),
      getSegmentsInfo: () => [],
      getSymbolLengths: () => ({}),
      lookupSourceLine: sinon.stub(),
      findSymbolOffset: sinon.stub(),
      getCfaForPc: sinon.stub().returns(undefined), // no DWARF frame info → use guessStack
      getInlineFramesForPc: sinon.stub().returns([]), // no inline frames by default
    };

    stackManager = new StackManager(mockVAmiga, mockSourceMap);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe("Stack Frame Generation", () => {
    it("should return current PC as first stack frame", async () => {
      // Setup: Mock CPU state and empty stack
      const mockCpuInfo = createMockCpuInfo({ pc: "0x1000", a7: "0x8000" });
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);
      mockVAmiga.readMemory.resolves(Buffer.alloc(128));
      mockVAmiga.isValidAddress.returns(false); // No valid return addresses in stack

      // Test: Get stack frames
      const frames = await stackManager.getStackFrames(0, 5);

      // Verify: Current PC is included as first frame
      assert.strictEqual(frames.length, 1);
      assert.strictEqual(frames[0].instructionPointerReference, "0x00001000");
    });

    it("should create source-based frames when debug info available", async () => {
      // Setup: Mock CPU state, stack, and source map
      const mockCpuInfo = createMockCpuInfo({ pc: "0x1000", a7: "0x8000" });
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);
      mockVAmiga.readMemory.resolves(Buffer.alloc(128));

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
      const frames = await stackManager.getStackFrames(0, 1);

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
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);
      mockVAmiga.readMemory.resolves(Buffer.alloc(128));

      // No source location found
      mockSourceMap.lookupAddress.returns(null);

      // Test: Get stack frames
      const frames = await stackManager.getStackFrames(0, 1);

      // Verify: Frame is disassembly-only
      assert.strictEqual(frames.length, 1);
      assert.strictEqual(frames[0].name, "0x00001000");
      assert.strictEqual(frames[0].source, undefined);
      assert.strictEqual(frames[0].line, 0); // StackFrame constructor defaults to 0
      assert.strictEqual(frames[0].instructionPointerReference, "0x00001000");
    });

    it("should stop at ROM calls after finding user code", async () => {
      // Setup: Mock stack analysis that finds ROM address after user code
      const mockCpuInfo = createMockCpuInfo({ pc: "0x1000", a7: "0x8000" });
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);

      // Mock guessStack to return user code then ROM
      sinon.stub(stackManager, "guessStack").resolves([
        [0x1000, 0x1000], // User code PC
        [0x2000, 0x2000], // User code
        [0xe80000, 0xe80000], // ROM code - should stop here
      ]);

      // Mock source lookup - first two have source, third is ROM
      mockSourceMap.lookupAddress
        .withArgs(0x1000)
        .returns({ path: "/src/main.asm", line: 10 });
      mockSourceMap.lookupAddress
        .withArgs(0x2000)
        .returns({ path: "/src/sub.c", line: 20 });
      mockSourceMap.lookupAddress.withArgs(0xe80000).returns(null);

      // Test: Get all stack frames
      const frames = await stackManager.getStackFrames(0, 10);

      // Verify: Stops after user code, doesn't include ROM frame
      assert.strictEqual(frames.length, 2);
      assert.strictEqual(frames[1].instructionPointerReference, "0x00002000");
    });

    it("should handle pagination with startFrame and maxLevels", async () => {
      // Setup: Mock CPU info and stub guessStack with multiple frames
      const mockCpuInfo = createMockCpuInfo({ pc: "0x1000", a7: "0x8000" });
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);
      sinon.stub(stackManager, "guessStack").resolves([
        [0x1000, 0x1000], // Frame 0
        [0x2000, 0x2000], // Frame 1
        [0x3000, 0x3000], // Frame 2
        [0x4000, 0x4000], // Frame 3
        [0x5000, 0x5000], // Frame 4
      ]);

      mockSourceMap.lookupAddress.returns(null); // All disassembly frames

      // Test: Get frames 1-2 (skip first, take 2)
      const frames = await stackManager.getStackFrames(1, 2);

      // Verify: Returns correct slice of frames
      assert.strictEqual(frames.length, 2);
      assert.strictEqual(frames[0].instructionPointerReference, "0x00002000");
      assert.strictEqual(frames[1].instructionPointerReference, "0x00003000");
    });
  });

  describe("Stack Analysis Algorithm", () => {
    it("should include current PC as first frame", async () => {
      // Setup: Mock CPU state
      mockVAmiga.readMemory.resolves(Buffer.alloc(128));
      mockVAmiga.isValidAddress.returns(false);

      // Test: Analyze stack with explicit pc and stackAddress
      const addresses = await stackManager.guessStack(0x1000, 0x8000, 5);

      // Verify: Current PC is first entry
      assert.strictEqual(addresses.length, 1);
      assert.deepStrictEqual(addresses[0], [0x1000, 0x1000]);
    });

    it("should detect JSR return addresses in stack memory", async () => {
      // Setup: Mock stack containing return address
      // Create stack buffer with return address at offset 0
      const stackBuffer = Buffer.alloc(128);
      stackBuffer.writeInt32BE(0x2000, 0); // Return address to 0x2000
      mockVAmiga.readMemory.withArgs(0x8000, 128).resolves(stackBuffer);

      // Mock valid address check
      mockVAmiga.isValidAddress.withArgs(0x2000).returns(true);

      // Mock instruction bytes showing JSR at 0x2000-2
      const instrBuffer = Buffer.alloc(6);
      instrBuffer.writeUInt16BE(0x4e80, 4); // JSR instruction at offset 4 (0x2000-2)
      mockVAmiga.readMemory.withArgs(0x2000 - 6, 6).resolves(instrBuffer);

      // Test: Analyze stack with explicit pc and stackAddress
      const addresses = await stackManager.guessStack(0x1000, 0x8000, 5);

      // Verify: Finds JSR call site and return address
      assert.strictEqual(addresses.length, 2);
      assert.deepStrictEqual(addresses[0], [0x1000, 0x1000]); // Current PC
      assert.deepStrictEqual(addresses[1], [0x2000 - 2, 0x2000]); // JSR call site -> return
    });

    it("should detect BSR return addresses in stack memory", async () => {
      // Setup: Mock stack containing BSR return
      const stackBuffer = Buffer.alloc(128);
      stackBuffer.writeInt32BE(0x2004, 0); // Return address after BSR
      mockVAmiga.readMemory.withArgs(0x8000, 128).resolves(stackBuffer);

      mockVAmiga.isValidAddress.withArgs(0x2004).returns(true);

      // Mock BSR instruction bytes
      const instrBuffer = Buffer.alloc(6);
      instrBuffer.writeUInt16BE(0x6100, 2); // BSR instruction at offset 2
      mockVAmiga.readMemory.withArgs(0x2004 - 6, 6).resolves(instrBuffer);

      // Test: Analyze stack with explicit pc and stackAddress
      const addresses = await stackManager.guessStack(0x1000, 0x8000, 5);

      // Verify: Finds BSR call site
      assert.strictEqual(addresses.length, 2);
      assert.deepStrictEqual(addresses[1], [0x2004 - 4, 0x2004]); // BSR call site
    });

    it("should skip invalid addresses and odd addresses", async () => {
      // Setup: Mock stack with invalid data
      const stackBuffer = Buffer.alloc(128);
      stackBuffer.writeInt32BE(0x1001, 0); // Odd address - should skip
      stackBuffer.writeInt32BE(0x2000, 4); // Valid even address
      stackBuffer.writeUInt32BE(0xffffffff, 8); // Invalid address (use unsigned)
      mockVAmiga.readMemory.withArgs(0x8000, 128).resolves(stackBuffer);

      // Mock address validation
      mockVAmiga.isValidAddress.withArgs(0x1001).returns(false); // Odd
      mockVAmiga.isValidAddress.withArgs(0x2000).returns(true); // Valid
      mockVAmiga.isValidAddress.withArgs(0xffffffff).returns(false); // Invalid

      // Mock JSR for valid address
      const instrBuffer = Buffer.alloc(6);
      instrBuffer.writeUInt16BE(0x4e80, 4);
      mockVAmiga.readMemory.withArgs(0x2000 - 6, 6).resolves(instrBuffer);

      // Test: Analyze stack with explicit pc and stackAddress
      const addresses = await stackManager.guessStack(0x1000, 0x8000, 5);

      // Verify: Only processes valid even addresses
      assert.strictEqual(addresses.length, 2);
      assert.deepStrictEqual(addresses[1], [0x2000 - 2, 0x2000]);
    });

    it("should handle memory read errors gracefully", async () => {
      // Setup: Mock stack with return address
      const stackBuffer = Buffer.alloc(128);
      stackBuffer.writeInt32BE(0x2000, 0);
      mockVAmiga.readMemory.withArgs(0x8000, 128).resolves(stackBuffer);

      mockVAmiga.isValidAddress.withArgs(0x2000).returns(true);

      // Mock memory read failure when checking for JSR/BSR
      mockVAmiga.readMemory
        .withArgs(0x2000 - 6, 6)
        .rejects(new Error("Invalid memory"));

      // Test: Analyze stack (should not throw)
      const addresses = await stackManager.guessStack(0x1000, 0x8000, 5);

      // Verify: Gracefully handles error, returns at least current PC
      assert.strictEqual(addresses.length, 1);
      assert.deepStrictEqual(addresses[0], [0x1000, 0x1000]);
    });

    it("should respect maxLength parameter", async () => {
      // Setup: Mock stack with many potential return addresses
      const stackBuffer = Buffer.alloc(128);
      // Fill with many valid return addresses
      for (let i = 0; i < 20; i++) {
        stackBuffer.writeInt32BE(0x2000 + i * 4, i * 4);
      }
      mockVAmiga.readMemory.withArgs(0x8000, 128).resolves(stackBuffer);

      // Mock all as valid with JSR instructions
      mockVAmiga.isValidAddress.returns(true);
      const instrBuffer = Buffer.alloc(6);
      instrBuffer.writeUInt16BE(0x4e80, 4); // JSR instruction at position 4

      // Mock instruction reads for each potential return address
      for (let i = 0; i < 20; i++) {
        const retAddr = 0x2000 + i * 4;
        mockVAmiga.readMemory.withArgs(retAddr - 6, 6).resolves(instrBuffer);
      }

      // Test: Limit to 3 frames with explicit pc and stackAddress
      const addresses = await stackManager.guessStack(0x1000, 0x8000, 3);

      // Verify: Respects limit (1 current + 2 from stack = 3)
      assert.strictEqual(addresses.length, 3);
    });
  });

  describe("Integration with Source Maps", () => {
    it("should use source map for frame naming when available", async () => {
      // Setup: Mock CPU info and stub guessStack
      const mockCpuInfo = createMockCpuInfo({ pc: "0x1000", a7: "0x8000" });
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);
      sinon.stub(stackManager, "guessStack").resolves([[0x1000, 0x1000]]);

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
      const frames = await stackManager.getStackFrames(0, 1);

      // Verify: Uses source map for naming and location
      assert.strictEqual(frames.length, 1);
      assert.strictEqual(frames[0].name, "0x00001000 = main");
      assert.strictEqual(frames[0].source?.name, "main.asm");
      assert.strictEqual(frames[0].source?.path, "/project/src/main.asm");
      assert.strictEqual(frames[0].line, 25);
    });

    it("should fall back to disassembly frames when source map has no info", async () => {
      // Setup: Mock CPU info and stub guessStack
      const mockCpuInfo = createMockCpuInfo({ pc: "0x1000", a7: "0x8000" });
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);
      sinon.stub(stackManager, "guessStack").resolves([[0x1000, 0x1000]]);

      // Mock source map returns null (no debug info for this address)
      mockSourceMap.lookupAddress.withArgs(0x1000).returns(null);

      // Test: Get frames when source map has no info for address
      const frames = await stackManager.getStackFrames(0, 1);

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
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);
      mockVAmiga.isValidAddress.returns(true);
      mockSourceMap.lookupAddress.returns(null);

      mockSourceMap.getCfaForPc.withArgs(0x1000).returns({ reg: 15, offset: 4 });
      mockSourceMap.getCfaForPc.withArgs(0x2000).returns({ reg: 15, offset: 4 });
      // getCfaForPc for 0x3000 returns undefined (default stub behaviour) → unwind stops

      const buf1 = Buffer.alloc(4); buf1.writeUInt32BE(0x2000, 0);
      const buf2 = Buffer.alloc(4); buf2.writeUInt32BE(0x3000, 0);
      mockVAmiga.readMemory.withArgs(0x8000, 4).resolves(buf1); // CFA-4 for frame 0
      mockVAmiga.readMemory.withArgs(0x8004, 4).resolves(buf2); // CFA-4 for frame 1

      const frames = await stackManager.getStackFrames(0, 10);

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
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);
      mockVAmiga.isValidAddress.returns(true);
      mockSourceMap.lookupAddress.returns(null);

      mockSourceMap.getCfaForPc.withArgs(0x1000).returns({ reg: 13, offset: 8 }); // A5 = DWARF r13

      const retBuf = Buffer.alloc(4); retBuf.writeUInt32BE(0x2000, 0);
      const a5Buf = Buffer.alloc(4); a5Buf.writeUInt32BE(0x7000, 0);
      mockVAmiga.readMemory.withArgs(0x7FFC, 4).resolves(retBuf); // CFA-4 = 0x7FFC
      mockVAmiga.readMemory.withArgs(0x7FF8, 4).resolves(a5Buf); // CFA-8 = 0x7FF8 (saved A5)

      const frames = await stackManager.getStackFrames(0, 10);

      assert.strictEqual(frames.length, 2);
      assert.strictEqual(frames[0].instructionPointerReference, "0x00001000");
      assert.strictEqual(frames[1].instructionPointerReference, "0x00002000");
    });

    it("should insert synthetic inline frames before the real frame (DWARF path only)", async () => {
      const mockCpuInfo = createMockCpuInfo({ pc: "0x1000", a7: "0x8000" });
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);
      mockVAmiga.isValidAddress.returns(true);

      // DWARF CFA at 0x1000: SP+4 → CFA=0x8004, return address at mem[0x8000]=0x2000
      mockSourceMap.getCfaForPc.withArgs(0x1000).returns({ reg: 15, offset: 4 });
      const retBuf = Buffer.alloc(4); retBuf.writeUInt32BE(0x2000, 0);
      mockVAmiga.readMemory.withArgs(0x8000, 4).resolves(retBuf);
      // No DWARF info at 0x2000 → unwind stops
      mockSourceMap.lookupAddress.withArgs(0x2000).returns(null);

      // Real frame 0x1000 has a source location
      mockSourceMap.lookupAddress.withArgs(0x1000).returns({ path: "/src/outer.c", line: 10 });
      // One inline function wraps the code at 0x1000, called from line 20
      mockSourceMap.getInlineFramesForPc.withArgs(0x1000).returns([
        { name: "inline_func", callPath: "/src/outer.c", callLine: 20 },
      ]);

      const frames = await stackManager.getStackFrames(0, 10);

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

    it("should fall back to guessStack when getCfaForPc returns undefined for current PC", async () => {
      const mockCpuInfo = createMockCpuInfo({ pc: "0x1000", a7: "0x8000" });
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);
      // getCfaForPc returns undefined (default stub) → guessStack path
      sinon.stub(stackManager, "guessStack").resolves([[0x1000, 0x1000], [0x2000, 0x2000]]);
      mockSourceMap.lookupAddress.returns(null);

      const frames = await stackManager.getStackFrames(0, 10);

      assert.strictEqual(frames.length, 2);
      assert.strictEqual(frames[0].instructionPointerReference, "0x00001000");
      assert.strictEqual(frames[1].instructionPointerReference, "0x00002000");
    });
  });
});
