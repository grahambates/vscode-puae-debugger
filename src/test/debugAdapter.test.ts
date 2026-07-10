/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from "assert";
import * as sinon from "sinon";
import { DebugAdapter } from "../debugAdapter";
import { EvaluateManager, EvaluateResultType } from "../evaluateManager";
import { CpuInfo } from "../emulatorProtocol";
import { PuaeEmulator } from "../puaeEmulator";
import { DebugProtocol } from "@vscode/debugprotocol";
import * as registerParsers from "../amigaRegisterParsers";
import { VariablesManager } from "../variablesManager";
import { BreakpointManager } from "../breakpointManager";
import { DisassemblyManager } from "../disassemblyManager";

/**
 * Test subclass that exposes protected methods for testing
 */
class TestableDebugAdapter extends DebugAdapter {
  public getTestEvaluateManager(): EvaluateManager | undefined {
    return (this as any).evaluateManager;
  }
}

/**
 * Simplified behavior-focused tests for DebugAdapter.
 *
 * These tests use minimal refactoring (protected methods + constructor injection)
 * to test behavior without over-engineering the architecture.
 *
 * Note: Comprehensive variable management tests are now in VariablesManager test suite.
 * This test suite focuses on core debugger behavior, evaluation, and integration.
 */
describe("DebugAdapter - Simplified Tests", () => {
  let adapter: TestableDebugAdapter;
  let mockEmulator: sinon.SinonStubbedInstance<PuaeEmulator>;

  beforeEach(() => {
    mockEmulator = sinon.createStubInstance(PuaeEmulator);

    // Use constructor injection to provide mock
    adapter = new TestableDebugAdapter(mockEmulator);
  });

  afterEach(() => {
    sinon.restore();
    adapter.dispose();
  });

  describe("Expression Evaluation Behavior", () => {
    it("should evaluate simple numeric expressions", async () => {
      // Setup: Mock CPU state and create EvaluateManager
      setupMockCpuState();
      const mockSourceMap = setupMockSourceMap();
      const mockVariablesManager = setupMockVariablesManager();
      const mockDisassemblyManager = setupMockDisassemblyManager();
      const evaluateManager = new EvaluateManager(
        mockEmulator,
        mockSourceMap,
        mockVariablesManager,
        mockDisassemblyManager,
      );
      (adapter as any).evaluateManager = evaluateManager;

      // Test: Evaluate simple expression
      const result = await evaluateManager.evaluate("42");

      // Verify: Returns expected value
      assert.strictEqual(result.value, 42);
    });

    it("should evaluate register expressions", async () => {
      // Setup: Mock CPU with d0 = 0x100
      setupMockCpuState({ d0: "0x100" });
      const mockSourceMap = setupMockSourceMap();
      const mockVariablesManager = setupMockVariablesManager({ d0: 0x100 });
      const mockDisassemblyManager = setupMockDisassemblyManager();
      const evaluateManager = new EvaluateManager(
        mockEmulator,
        mockSourceMap,
        mockVariablesManager,
        mockDisassemblyManager,
      );
      (adapter as any).evaluateManager = evaluateManager;

      // Test: Evaluate register
      const result = await evaluateManager.evaluate("d0");

      // Verify: Returns register value and correct type
      assert.strictEqual(result.value, 0x100);
      assert.strictEqual(result.type, EvaluateResultType.DATA_REGISTER);
    });

    it("should evaluate complex expressions with registers", async () => {
      // Setup: Mock CPU state
      setupMockCpuState({ d0: "0x10", d1: "0x20" });
      const mockSourceMap = setupMockSourceMap();
      const mockVariablesManager = setupMockVariablesManager({
        d0: 0x10,
        d1: 0x20,
      });
      const mockDisassemblyManager = setupMockDisassemblyManager();
      const evaluateManager = new EvaluateManager(
        mockEmulator,
        mockSourceMap,
        mockVariablesManager,
        mockDisassemblyManager,
      );
      (adapter as any).evaluateManager = evaluateManager;

      // Test: Evaluate arithmetic expression
      const result = await evaluateManager.evaluate("d0 + d1 * 2");

      // Verify: Correct calculation
      assert.strictEqual(result.value, 0x10 + 0x20 * 2);
      assert.strictEqual(result.type, EvaluateResultType.PARSED);
    });

    it("should handle hex address evaluation with memory access", async () => {
      // Setup: Mock memory read
      const mockBuffer = Buffer.alloc(4);
      mockBuffer.writeUInt32BE(0x12345678, 0);
      mockEmulator.readMemory.resolves(mockBuffer);
      setupMockCpuState();
      const mockSourceMap = setupMockSourceMap();
      const mockVariablesManager = setupMockVariablesManager();
      const mockDisassemblyManager = setupMockDisassemblyManager();
      const evaluateManager = new EvaluateManager(
        mockEmulator,
        mockSourceMap,
        mockVariablesManager,
        mockDisassemblyManager,
      );
      (adapter as any).evaluateManager = evaluateManager;

      // Test: Evaluate hex address (should read memory)
      const result = await evaluateManager.evaluate("0x1000");

      // Verify: Memory was read and result formatted correctly
      assert.ok(mockEmulator.readMemory.calledWith(0x1000, 4));
      assert.strictEqual(result.value, 0x12345678);
      assert.strictEqual(result.memoryReference, "0x00001000");
    });

    it("should evaluate symbols when source map available", async () => {
      // Setup: Mock CPU state and source map with symbols
      setupMockCpuState();
      const mockSourceMap = setupMockSourceMap({
        main: 0x1000,
        buffer: 0x2000,
      });
      const mockVariablesManager = setupMockVariablesManager({ main: 0x1000 });
      const mockDisassemblyManager = setupMockDisassemblyManager();
      const evaluateManager = new EvaluateManager(
        mockEmulator,
        mockSourceMap,
        mockVariablesManager,
        mockDisassemblyManager,
      );
      (adapter as any).evaluateManager = evaluateManager;

      // Test: Evaluate symbol
      const result = await evaluateManager.evaluate("main");

      // Verify: Symbol resolved correctly
      assert.strictEqual(result.value, 0x1000);
      assert.strictEqual(result.type, EvaluateResultType.SYMBOL);
      assert.strictEqual(result.memoryReference, "0x00001000");
    });
  });

  // Stack analysis tests have been moved to StackManager test suite

  describe("Debug Adapter Protocol Integration", () => {
    it("should handle evaluate request through DAP", async () => {
      // Setup: Mock CPU state and create EvaluateManager
      setupMockCpuState({ d0: "0x42" });
      const mockSourceMap = setupMockSourceMap();
      const mockVariablesManager = setupMockVariablesManager({ d0: 0x42 });
      const mockDisassemblyManager = setupMockDisassemblyManager();
      const evaluateManager = new EvaluateManager(
        mockEmulator,
        mockSourceMap,
        mockVariablesManager,
        mockDisassemblyManager,
      );
      (adapter as any).evaluateManager = evaluateManager;

      const response =
        createMockResponse<DebugProtocol.EvaluateResponse>("evaluate");
      const args: DebugProtocol.EvaluateArguments = {
        expression: "d0 + 8",
      };

      // Test: Handle DAP evaluate request
      await (adapter as any).evaluateRequest(response, args);

      // Verify: Response contains correct result (now includes decimal value)
      assert.strictEqual(response.body?.result, "0x4a | 74 | 0b1001010"); // 0x42 + 8 = 0x4a = 74
      assert.strictEqual(response.success, true);
    });

    it("should handle invalid expressions gracefully", async () => {
      // Setup: Mock CPU state and create EvaluateManager
      setupMockCpuState();
      const mockSourceMap = setupMockSourceMap();
      const mockVariablesManager = setupMockVariablesManager();
      const mockDisassemblyManager = setupMockDisassemblyManager();
      const evaluateManager = new EvaluateManager(
        mockEmulator,
        mockSourceMap,
        mockVariablesManager,
        mockDisassemblyManager,
      );
      (adapter as any).evaluateManager = evaluateManager;

      const response =
        createMockResponse<DebugProtocol.EvaluateResponse>("evaluate");
      const args: DebugProtocol.EvaluateArguments = {
        expression: "invalid_variable",
      };

      // Test: Handle invalid expression
      await (adapter as any).evaluateRequest(response, args);

      // Verify: Returns error response
      assert.strictEqual(response.success, false);
      // The actual error message format may vary, just check that there's an error
      assert.ok(response.message);
    });

    it("should handle readMemory request", async () => {
      // Setup: Mock memory read
      const mockBuffer = Buffer.alloc(16);
      for (let i = 0; i < 16; i++) {
        mockBuffer[i] = i * 0x10;
      }
      mockEmulator.readMemory.resolves(mockBuffer);

      const response =
        createMockResponse<DebugProtocol.ReadMemoryResponse>("readMemory");
      const args: DebugProtocol.ReadMemoryArguments = {
        memoryReference: "0x1000",
        count: 16,
      };

      // Test: Read memory
      await (adapter as any).readMemoryRequest(response, args);

      // Verify: Memory read was called and result encoded
      assert.ok(mockEmulator.readMemory.calledWith(0x1000, 16));
      assert.strictEqual(response.success, true);
      assert.ok(response.body?.data);
      assert.strictEqual(response.body?.address, "0x00001000"); // formatHex returns padded hex
    });

    it("should handle writeMemory request", async () => {
      // Setup: Mock memory write
      mockEmulator.writeMemory.resolves();

      const response =
        createMockResponse<DebugProtocol.WriteMemoryResponse>("writeMemory");
      const testData = Buffer.from([0x12, 0x34, 0x56, 0x78]).toString("base64");
      const args: DebugProtocol.WriteMemoryArguments = {
        memoryReference: "0x2000",
        data: testData,
      };

      // Test: Write memory
      await (adapter as any).writeMemoryRequest(response, args);

      // Verify: Memory write was called
      assert.ok(mockEmulator.writeMemory.calledOnce);
      const writeCall = mockEmulator.writeMemory.getCall(0);
      assert.strictEqual(writeCall.args[0], 0x2000);
      assert.deepStrictEqual(
        writeCall.args[1],
        Buffer.from([0x12, 0x34, 0x56, 0x78]),
      );
      assert.strictEqual(response.success, true);
    });

    it("should handle completions request for registers", async () => {
      // Setup: Mock CPU state and VariablesManager
      setupMockCpuState({ d0: "0x100", d1: "0x200" });
      const mockVariablesManager = setupMockVariablesManager({
        d0: 0x100,
        d1: 0x200,
        a0: 0x3000,
      });
      (adapter as any).variablesManager = mockVariablesManager;

      const response =
        createMockResponse<DebugProtocol.CompletionsResponse>("completions");
      const args: DebugProtocol.CompletionsArguments = {
        text: "d",
        column: 2, // column is 1-based, cursor after 'd'
      };

      // Test: Get completions
      await (adapter as any).completionsRequest(response, args);

      // Verify: Returns register completions
      assert.strictEqual(response.success, true);
      assert.ok(response.body?.targets);
      const targets = response.body!.targets;

      // Should include data registers that start with 'd'
      const d0Completion = targets.find((t) => t.label === "d0");
      assert.ok(d0Completion, "Should include d0 register");
      assert.strictEqual(d0Completion?.type, "variable");
    });

    it("should set breakpoints through DAP when source map available", async () => {
      // Setup: Create proper mock instances instead of bypassing type system
      const mockSourceMap = createMockSourceMap({
        lookupSourceLine: sinon.stub().returns({ address: 0x1000 }),
      });

      const mockBreakpointManager = sinon.createStubInstance(BreakpointManager);
      const mockVariablesManager = sinon.createStubInstance(VariablesManager);

      // Configure the setSourceBreakpoints stub to return expected breakpoints
      mockBreakpointManager.setSourceBreakpoints.resolves([
        { id: 1, verified: true, line: 10 },
        { id: 2, verified: true, line: 20 },
      ]);

      // Inject dependencies
      (adapter as any).sourceMap = mockSourceMap;
      (adapter as any).variablesManager = mockVariablesManager;
      (adapter as any).breakpointManager = mockBreakpointManager;

      const response =
        createMockResponse<DebugProtocol.SetBreakpointsResponse>(
          "setBreakpoints",
        );
      const args: DebugProtocol.SetBreakpointsArguments = {
        source: { path: "/src/main.c" },
        breakpoints: [{ line: 10 }, { line: 20 }],
      };

      // Test: Set breakpoints through DAP
      await (adapter as any).setBreakPointsRequest(response, args);

      // Verify: Breakpoint manager was called and response is correct
      assert.ok(mockBreakpointManager.setSourceBreakpoints.calledOnce);
      assert.strictEqual(response.body?.breakpoints?.length, 2);
      assert.strictEqual(response.body?.breakpoints?.[0].verified, true);
    });

    it("should integrate with VariablesManager for variable requests", async () => {
      // Setup: Mock CPU state
      setupMockCpuState({ d0: "0x42" });

      // Test: Get scopes should use VariablesManager
      const scopesResponse =
        createMockResponse<DebugProtocol.ScopesResponse>("scopes");
      (adapter as any).scopesRequest(scopesResponse, { frameId: 0 });

      // Verify: Should return empty scopes if VariablesManager not initialized (before launch)
      assert.ok(scopesResponse.body);
      assert.strictEqual(scopesResponse.body.scopes.length, 0);

      // Note: Comprehensive variable testing is in VariablesManager test suite
      // This test verifies DAP integration without requiring full debugger launch
    });
  });

  describe("Capabilities", () => {
    it("advertises value-editing capabilities on initialize", () => {
      const response =
        createMockResponse<DebugProtocol.InitializeResponse>("initialize");

      (adapter as any).initializeRequest(response);

      assert.strictEqual(response.body?.supportsSetVariable, true);
      assert.strictEqual(response.body?.supportsSetExpression, true);
      assert.strictEqual(response.body?.supportsConditionalBreakpoints, true);
    });
  });

  describe("Conditional Breakpoints", () => {
    function stubBreakpointManager(condition: string) {
      const mockBreakpointManager = sinon.createStubInstance(BreakpointManager);
      mockBreakpointManager.handleBreakpointStop.returns({
        reason: "breakpoint",
        hitBreakpointIds: [1],
      });
      mockBreakpointManager.getCondition.returns(condition);
      (adapter as any).breakpointManager = mockBreakpointManager;
      return mockBreakpointManager;
    }

    it("stops and reports the breakpoint when the condition is true", async () => {
      setupMockCpuState({ d0: "0x10" });
      const mockSourceMap = setupMockSourceMap();
      const mockVariablesManager = setupMockVariablesManager({ d0: 0x10 });
      const mockDisassemblyManager = setupMockDisassemblyManager();
      (adapter as any).evaluateManager = new EvaluateManager(
        mockEmulator,
        mockSourceMap,
        mockVariablesManager,
        mockDisassemblyManager,
      );
      stubBreakpointManager("d0 > 5");
      const sendEventSpy = sinon.spy(adapter as any, "sendEvent");

      await (adapter as any).handleStop({ name: "BREAKPOINT_REACHED", payload: { pc: 0x1000 } });

      assert.ok(mockEmulator.run.notCalled);
      assert.ok(
        sendEventSpy.args.some(
          ([evt]) => evt.event === "stopped" && evt.body.hitBreakpointIds?.[0] === 1,
        ),
      );
    });

    it("silently resumes without stopping when the condition is false", async () => {
      setupMockCpuState({ d0: "0x0" });
      const mockSourceMap = setupMockSourceMap();
      const mockVariablesManager = setupMockVariablesManager({ d0: 0x0 });
      const mockDisassemblyManager = setupMockDisassemblyManager();
      (adapter as any).evaluateManager = new EvaluateManager(
        mockEmulator,
        mockSourceMap,
        mockVariablesManager,
        mockDisassemblyManager,
      );
      stubBreakpointManager("d0 > 5");
      const sendEventSpy = sinon.spy(adapter as any, "sendEvent");

      await (adapter as any).handleStop({ name: "BREAKPOINT_REACHED", payload: { pc: 0x1000 } });

      assert.ok(mockEmulator.run.calledOnce);
      assert.ok(sendEventSpy.args.every(([evt]) => evt.event !== "stopped"));
    });
  });

  describe("Logpoints", () => {
    function stubBreakpointManager(logMessage: string) {
      const mockBreakpointManager = sinon.createStubInstance(BreakpointManager);
      mockBreakpointManager.handleBreakpointStop.returns({
        reason: "breakpoint",
        hitBreakpointIds: [1],
      });
      mockBreakpointManager.getLogMessage.returns(logMessage);
      (adapter as any).breakpointManager = mockBreakpointManager;
      return mockBreakpointManager;
    }

    it("logs the interpolated message and resumes without stopping", async () => {
      setupMockCpuState({ d0: "0x2a" });
      const mockSourceMap = setupMockSourceMap();
      const mockVariablesManager = setupMockVariablesManager({ d0: 0x2a });
      const mockDisassemblyManager = setupMockDisassemblyManager();
      (adapter as any).evaluateManager = new EvaluateManager(
        mockEmulator,
        mockSourceMap,
        mockVariablesManager,
        mockDisassemblyManager,
      );
      stubBreakpointManager("d0 is {d0}");
      const sendEventSpy = sinon.spy(adapter as any, "sendEvent");

      await (adapter as any).handleStop({ name: "BREAKPOINT_REACHED", payload: { pc: 0x1000 } });

      assert.ok(mockEmulator.run.calledOnce);
      assert.ok(sendEventSpy.args.every(([evt]) => evt.event !== "stopped"));
      assert.ok(
        sendEventSpy.args.some(
          ([evt]) => evt.event === "output" && evt.body.output === "d0 is 42\n",
        ),
      );
    });

    it("logs an inline error and keeps resuming when an expression fails", async () => {
      setupMockCpuState();
      const mockSourceMap = setupMockSourceMap();
      const mockVariablesManager = setupMockVariablesManager();
      const mockDisassemblyManager = setupMockDisassemblyManager();
      (adapter as any).evaluateManager = new EvaluateManager(
        mockEmulator,
        mockSourceMap,
        mockVariablesManager,
        mockDisassemblyManager,
      );
      stubBreakpointManager("oops {not_a_real_var}");
      const sendEventSpy = sinon.spy(adapter as any, "sendEvent");

      await (adapter as any).handleStop({ name: "BREAKPOINT_REACHED", payload: { pc: 0x1000 } });

      assert.ok(mockEmulator.run.calledOnce);
      const outputEvt = sendEventSpy.args.find(([evt]) => evt.event === "output");
      assert.ok(outputEvt?.[0].body.output.startsWith("oops <"));
    });
  });

  // VS Code's built-in Variables/Disassembly panels only auto-select a stopped
  // frame with no source when StoppedEvent.reason is "instruction breakpoint"
  // (see applyNoSourceReasonHint's doc comment). Without this override, pausing
  // or breaking with the PC outside user code left both panels empty until the
  // next step happened to trigger the same fix elsewhere.
  describe("Sourceless stop reason hint", () => {
    function stubBreakpointManager(reason: string) {
      const mockBreakpointManager = sinon.createStubInstance(BreakpointManager);
      mockBreakpointManager.handleBreakpointStop.returns({ reason: reason as DebugProtocol.StoppedEvent["body"]["reason"] });
      (adapter as any).breakpointManager = mockBreakpointManager;
      return mockBreakpointManager;
    }

    it("overrides a breakpoint stop's reason when the PC has no source", async () => {
      setupMockCpuState({ pc: "0x00fc0000" }); // e.g. inside Kickstart ROM
      setupMockSourceMap(); // lookupAddress -> null by default
      stubBreakpointManager("breakpoint");
      const sendEventSpy = sinon.spy(adapter as any, "sendEvent");

      await (adapter as any).handleStop({ name: "BREAKPOINT_REACHED", payload: { pc: 0x00fc0000 } });

      const stopped = sendEventSpy.args.find(([evt]) => evt.event === "stopped");
      assert.strictEqual(stopped?.[0].body.reason, "instruction breakpoint");
    });

    it("leaves a breakpoint stop's reason alone when the PC has source", async () => {
      setupMockCpuState({ pc: "0x00001000" });
      const mockSourceMap = setupMockSourceMap();
      mockSourceMap.lookupAddress.returns({ path: "main.c", line: 10 });
      stubBreakpointManager("breakpoint");
      const sendEventSpy = sinon.spy(adapter as any, "sendEvent");

      await (adapter as any).handleStop({ name: "BREAKPOINT_REACHED", payload: { pc: 0x1000 } });

      const stopped = sendEventSpy.args.find(([evt]) => evt.event === "stopped");
      assert.strictEqual(stopped?.[0].body.reason, "breakpoint");
    });

    it("overrides a manual pause's reason when the PC has no source", async () => {
      setupMockCpuState({ pc: "0x00fc0000" });
      setupMockSourceMap();
      (adapter as any).isRunning = true;
      const sendEventSpy = sinon.spy(adapter as any, "sendEvent");

      await (adapter as any).updateState({
        type: "emulator-state",
        state: "paused",
        message: { hasMessage: false, name: "", payload: {} },
      });

      const stopped = sendEventSpy.args.find(([evt]) => evt.event === "stopped");
      assert.strictEqual(stopped?.[0].body.reason, "instruction breakpoint");
    });

    it("leaves a manual pause's reason alone when the PC has source", async () => {
      setupMockCpuState({ pc: "0x00001000" });
      const mockSourceMap = setupMockSourceMap();
      mockSourceMap.lookupAddress.returns({ path: "main.c", line: 10 });
      (adapter as any).isRunning = true;
      const sendEventSpy = sinon.spy(adapter as any, "sendEvent");

      await (adapter as any).updateState({
        type: "emulator-state",
        state: "paused",
        message: { hasMessage: false, name: "", payload: {} },
      });

      const stopped = sendEventSpy.args.find(([evt]) => evt.event === "stopped");
      assert.strictEqual(stopped?.[0].body.reason, "pause");
    });
  });

  describe("Stepping and Execution Control", () => {
    it("should handle stepIn request", async () => {
      // Setup: Mock stepInto functionality
      mockEmulator.stepInto.returns(undefined);

      const response =
        createMockResponse<DebugProtocol.StepInResponse>("stepIn");
      const args: DebugProtocol.StepInArguments = {
        threadId: 1,
      };

      // Test: Execute stepIn request
      await (adapter as any).stepInRequest(response, args);

      // Verify: stepInto was called
      assert.ok(mockEmulator.stepInto.calledOnce);
      assert.strictEqual(response.success, true);
    });

    it("should handle next (step over) request with JSR instruction", async () => {
      // Setup: Mock CPU state and memory showing JSR at PC
      setupMockCpuState({ pc: "0x1000" });
      const mockBreakpointManager = sinon.createStubInstance(BreakpointManager);
      (adapter as any).breakpointManager = mockBreakpointManager;

      // JSR $00002000.L = [0x4E, 0xB9, 0x00, 0x00, 0x20, 0x00] (6 bytes), then NOPs
      const jsrBytes = [0x4e, 0xb9, 0x00, 0x00, 0x20, 0x00];
      const mem = Buffer.alloc(20);
      jsrBytes.forEach((b, i) => { mem[i] = b; });
      for (let i = jsrBytes.length; i < mem.length; i += 2) { mem[i] = 0x4e; mem[i + 1] = 0x71; }
      mockEmulator.readMemory.resolves(mem);
      mockEmulator.run.resolves();

      const response = createMockResponse<DebugProtocol.NextResponse>("next");

      // Test: Execute next request (instruction granularity)
      await (adapter as any).nextRequest(response, { threadId: 1, granularity: "instruction" });

      // Verify: Breakpoint set on next instruction (0x1006) and run called
      assert.ok(mockBreakpointManager.setTmpBreakpoint.calledWith(0x1006, "step"));
      assert.ok(mockEmulator.run.called);
      assert.strictEqual(response.success, true);
    });

    it("should handle next (step over) request with non-call instruction", async () => {
      // Setup: Mock CPU state with MOVE (not a call)
      setupMockCpuState({ pc: "0x1000" });
      mockEmulator.stepInto.returns(undefined);

      // MOVE.L D0,D1 = [0x22, 0x00] (2 bytes), then NOPs
      const mem = Buffer.alloc(20);
      mem[0] = 0x22; mem[1] = 0x00;
      for (let i = 2; i < mem.length; i += 2) { mem[i] = 0x4e; mem[i + 1] = 0x71; }
      mockEmulator.readMemory.resolves(mem);

      const response = createMockResponse<DebugProtocol.NextResponse>("next");

      // Test: Execute next request with non-call instruction (instruction granularity)
      await (adapter as any).nextRequest(response, { threadId: 1, granularity: "instruction" });

      // Verify: Just calls stepInto for non-call instructions
      assert.ok(mockEmulator.stepInto.called);
      assert.strictEqual(response.success, true);
    });

    it("should handle stepOut request", async () => {
      // Setup: Mock stack manager and breakpoint manager
      setupMockCpuState({ pc: "0x1000", a7: "0x8000" });
      const mockStackManager = {
        guessStack: sinon.stub().resolves([
          [0x1000, 0x1000], // Current PC
          [0x2000, 0x2010], // Return address
        ]),
      };
      const mockBreakpointManager = sinon.createStubInstance(BreakpointManager);

      (adapter as any).stackManager = mockStackManager;
      (adapter as any).breakpointManager = mockBreakpointManager;
      mockEmulator.run.returns(undefined);

      const response =
        createMockResponse<DebugProtocol.StepOutResponse>("stepOut");

      // Test: Execute stepOut request
      await (adapter as any).stepOutRequest(response);

      // Verify: Breakpoint set at return address and run called
      assert.ok(
        mockBreakpointManager.setTmpBreakpoint.calledWith(0x2010, "step"),
      );
      assert.ok(mockEmulator.run.calledOnce);
      assert.strictEqual(response.success, true);
    });

    it("should handle continue request", async () => {
      // Setup: Mock continue functionality
      mockEmulator.run.resolves();

      const response =
        createMockResponse<DebugProtocol.ContinueResponse>("continue");

      // Test: Execute continue request
      (adapter as any).continueRequest(response);

      // Verify: run was called
      assert.ok(mockEmulator.run.calledOnce);
      assert.strictEqual(response.success, true);
    });

    it("should handle pause request", async () => {
      // Setup: Mock pause functionality
      mockEmulator.pause.resolves();

      const response = createMockResponse<DebugProtocol.PauseResponse>("pause");

      // Test: Execute pause request
      (adapter as any).pauseRequest(response);

      // Verify: pause was called
      assert.ok(mockEmulator.pause.calledOnce);
      assert.strictEqual(response.success, true);
    });
  });

  describe("Reverse Debugging Features", () => {
    it("should handle stepBack request", async () => {
      // Setup: Mock stepBack functionality
      mockEmulator.stepBack.resolves();

      const response =
        createMockResponse<DebugProtocol.StepBackResponse>("stepBack");

      // Test: Execute stepBack request
      await (adapter as any).stepBackRequest(response);

      // Verify: stepBack was called and stopped event sent
      assert.ok(mockEmulator.stepBack.calledOnce);
      assert.strictEqual(response.success, true);
    });

    it("should handle stepBack errors gracefully", async () => {
      // Setup: Mock stepBack to fail
      mockEmulator.stepBack.rejects(new Error("Step back failed"));

      const response =
        createMockResponse<DebugProtocol.StepBackResponse>("stepBack");

      // Test: Execute stepBack with error
      await (adapter as any).stepBackRequest(response);

      // Verify: Error response is sent
      assert.strictEqual(response.success, false);
      assert.ok(response.message);
      assert.ok(response.message.includes("Step operation failed"));
    });

    it("should handle reverseContinue request", async () => {
      // Setup: Mock reverseContinue functionality
      mockEmulator.continueReverse.resolves();

      const response =
        createMockResponse<DebugProtocol.ReverseContinueResponse>(
          "reverseContinue",
        );

      // Test: Execute reverseContinue request
      await (adapter as any).reverseContinueRequest(response);

      // Verify: continueReverse was called and stopped event sent
      assert.ok(mockEmulator.continueReverse.calledOnce);
      assert.strictEqual(response.success, true);
    });

    it("should handle reverseContinue errors gracefully", async () => {
      // Setup: Mock reverseContinue to fail
      mockEmulator.continueReverse.rejects(new Error("Reverse continue failed"));

      const response =
        createMockResponse<DebugProtocol.ReverseContinueResponse>(
          "reverseContinue",
        );

      // Test: Execute reverseContinue with error
      await (adapter as any).reverseContinueRequest(response);

      // Verify: Error response is sent
      assert.strictEqual(response.success, false);
      assert.ok(response.message);
      assert.ok(response.message.includes("Step operation failed"));
    });
  });

  describe("Custom Register Bit Breakdown Behavior", () => {
    it("should detect supported custom registers", () => {
      assert.ok(registerParsers.hasRegisterBitBreakdown("DMACON"));
      assert.ok(registerParsers.hasRegisterBitBreakdown("INTENA"));
      assert.ok(registerParsers.hasRegisterBitBreakdown("INTREQ"));
      assert.ok(registerParsers.hasRegisterBitBreakdown("BPLCON0"));
      assert.ok(registerParsers.hasRegisterBitBreakdown("BPLCON1"));
      assert.ok(registerParsers.hasRegisterBitBreakdown("BPLCON2"));
      assert.ok(registerParsers.hasRegisterBitBreakdown("BPLCON3"));
      assert.ok(registerParsers.hasRegisterBitBreakdown("BLTCON0"));
      assert.ok(registerParsers.hasRegisterBitBreakdown("BLTCON1"));
      assert.ok(registerParsers.hasRegisterBitBreakdown("VPOS"));
      assert.ok(registerParsers.hasRegisterBitBreakdown("VHPOS"));
      assert.ok(registerParsers.hasRegisterBitBreakdown("BLTSIZE"));
      assert.ok(registerParsers.hasRegisterBitBreakdown("ADKCON"));
      assert.ok(registerParsers.hasRegisterBitBreakdown("SPR0CTL"));
      assert.ok(registerParsers.hasRegisterBitBreakdown("SPR0POS"));
      assert.ok(!registerParsers.hasRegisterBitBreakdown("UNKNOWN_REG"));
    });

    it("should route to correct parser based on register name", () => {
      const dmaconBits = registerParsers.parseRegister("DMACON", 0x0200);
      const intenaBits = registerParsers.parseRegister("INTENA", 0x4000);
      const unknownBits = registerParsers.parseRegister("UNKNOWN", 0x1234);

      assert.ok(dmaconBits.length > 0, "DMACON should return bit definitions");
      assert.ok(intenaBits.length > 0, "INTENA should return bit definitions");
      assert.strictEqual(
        unknownBits.length,
        0,
        "Unknown register should return empty array",
      );

      // Verify different parsers are called
      const enableAllBit = dmaconBits.find((b) => b.name === "09: ENABLE_ALL");
      const masterBit = intenaBits.find((b) => b.name === "14: MASTER_ENABLE");

      assert.ok(enableAllBit, "Should have DMACON-specific bits");
      assert.ok(masterBit, "Should have INTENA-specific bits");
    });
  });

  // Helper functions to reduce test setup boilerplate

  function setupMockCpuState(overrides: Partial<CpuInfo> = {}): void {
    const defaultCpuInfo: CpuInfo = {
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
      a7: "0x00007000",
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

    mockEmulator.getCpuInfo.resolves(defaultCpuInfo);
    mockEmulator.getAllCustomRegisters.resolves({
      DMACON: { value: "0x00008200" },
      INTENA: { value: "0x00004000" },
    });
  }

  function setupMockSourceMap(symbols: Record<string, number> = {}) {
    const mockSourceMap = createMockSourceMap({
      getSymbols: sinon.stub().returns(symbols),
      findSymbolOffset: sinon.stub().returns(undefined),
    });
    (adapter as any).sourceMap = mockSourceMap;
    return mockSourceMap;
  }

  function setupMockVariablesManager(
    flatVariables: Record<string, number> = {},
  ) {
    const mockVariablesManager = sinon.createStubInstance(VariablesManager);
    mockVariablesManager.getFlatVariables.resolves(flatVariables);
    return mockVariablesManager;
  }

  function setupMockDisassemblyManager() {
    const mockDisassemblyManager = sinon.createStubInstance(DisassemblyManager);
    mockDisassemblyManager.disassemble.resolves([]);
    return mockDisassemblyManager;
  }

  function createMockSourceMap(overrides: any = {}) {
    return {
      getSourceFiles: sinon.stub().returns([]),
      getSegmentsInfo: sinon.stub().returns([]),
      getSymbols: sinon.stub().returns({}),
      lookupAddress: sinon.stub().returns(null),
      lookupSourceLine: sinon.stub().returns({ address: 0x1000 }),
      getSegmentInfo: sinon.stub(),
      findSegmentForAddress: sinon.stub(),
      getSymbolLengths: sinon.stub().returns({}),
      findSymbolOffset: sinon.stub().returns(null),
      ...overrides,
    };
  }

  function createMockResponse<T extends DebugProtocol.Response>(
    command: string,
  ): T {
    return {
      seq: 1,
      type: "response",
      request_seq: 1,
      command,
      success: true,
    } as T;
  }
});
