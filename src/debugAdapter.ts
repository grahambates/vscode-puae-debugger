// TODO: bugs
// - exception breakpoints need useful stack trace
// - step on first instruction in non-fast mode
// TODO: features
// - trace
// - memory to disk?
// - beamtraps?
// - Constants/symbols browser in variables view
// - Copper debugging support
// - Custom register offset prefix display
// - Profiler
// - Control warp from Amiga
// - conditional breakpoints

import {
  logger,
  LoggingDebugSession,
  InitializedEvent,
  TerminatedEvent,
  StoppedEvent,
  ContinuedEvent,
  OutputEvent,
  ThreadEvent,
  Thread,
  Source,
} from "@vscode/debugadapter";
import { LogLevel } from "@vscode/debugadapter/lib/logger";
import { DebugProtocol } from "@vscode/debugprotocol";
import * as path from "path";
import { readFile } from "fs/promises";

import {
  EmulatorMessage,
  isAttachedMessage,
  isEmulatorStateMessage,
  isEmulatorOutputMessage,
  EmulatorStateMessage,
  StopMessage,
  isExecReadyMessage,
} from "./emulatorProtocol";
import { Disposable, Emulator } from "./emulator";
import { Hunk, parseHunks, StabData } from "./amigaHunkParser";
import { DWARFData, parseDwarf } from "./dwarfParser";
import { loadAmigaProgram } from "./amigaHunkLoader";
import { LoadedProgram } from "./amigaMemoryMapper";
import { sourceMapFromDwarf } from "./dwarfSourceMap";
import { sourceMapFromHunks } from "./amigaHunkSourceMap";
import { extractElfStabs, sourceMapFromElfStabs } from "./elfStabsSourceMap";
import {
  detectContainer,
  hasDwarfSections,
  hasElfStabsSections,
} from "./debugSymbolFormat";
import { SourceMap } from "./sourceMap";
import { kickstartSymbolModule, KickstartSymbolModule } from "./kickstart";
import { formatHex } from "./numbers";
import {
  allFunctions,
  consoleCommands,
  functionsText,
  helpText,
  initOutput,
  syntaxText,
} from "./repl";
import { exceptionBreakpointFilters } from "./hardware";
import { VariablesManager } from "./variablesManager";
import { ProfilerRpcClient } from "./profilerManager";
import { BreakpointManager } from "./breakpointManager";
import { StackManager } from "./stackManager";
import { DisassemblyManager } from "./disassemblyManager";
import { EvaluateManager } from "./evaluateManager";
import { decodeInstruction as m68kDecode, instructionToString } from "m68kdecode";

/**
 * Launch configuration arguments for starting a debug session.
 * Extends the standard DAP launch arguments with PUAE-specific options.
 */
interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
  /** Path to the Amiga program executable to debug */
  program: string;
  /** Optional path to separate file containing debug symbols (defaults to program path) */
  debugProgram?: string | null;
  /** Whether to automatically stop on program entry point */
  stopOnEntry?: boolean;
  /** Enable verbose logging of debug adapter protocol messages */
  trace?: boolean;
  /** Inject program directly into memory */
  fastLoad?: boolean;
  /** Path to the Kickstart ROM file */
  kickstartRom?: string;
  /** Non-fastLoad only: host directory to mount as DH0: instead of the auto-generated
   * single-exe disk — must be self-contained (program + its own s/startup-sequence). */
  hardDrivePath?: string;
  /** Path to a .uae config file loaded as the base configuration */
  emulatorConfigFile?: string;
  /** Options to pass when opening the emulator */
  emulatorOptions?: Record<string, unknown>;
  /** Runs the emulator this many frames ahead of what's displayed, so occasional
   * slow ticks don't cause visible/audible jank — at the cost of added latency.
   * Unset/0 disables it (the default). Automatically suspended during active
   * debugging (breakpoints, stepping, pause) and while warp mode is engaged.
   * Intended for passively watching a demo/game, not interactive debugging. */
  bufferFrames?: number;
}

/**
 * Categorized error codes for debug adapter operations.
 * Organized by functional area with reserved number ranges.
 */
export enum ErrorCode {
  // Launch/initialization errors (2000-2099)
  /** Program path not specified in launch configuration */
  PROGRAM_NOT_SPECIFIED = 2001,
  /** Failed to read or parse debug symbols */
  DEBUG_SYMBOLS_READ_ERROR = 2002,
  /** Failed to start the emulator */
  EMULATOR_START_ERROR = 2003,
  /** Launch configuration is invalid for the selected emulator backend */
  INVALID_LAUNCH_CONFIG = 2004,

  // Runtime/execution errors (3000-3099)
  /** RPC call to emulator timed out */
  RPC_TIMEOUT = 3001,
  /** Error during step operation */
  STEP_ERROR = 3002,
  /** Error during continue operation */
  CONTINUE_ERROR = 3003,
  /** Error during pause operation */
  PAUSE_ERROR = 3004,
  /** Error during session termination */
  TERMINATE_ERROR = 3005,

  // Variable/expression errors (4000-4099)
  /** Failed to read variable values */
  VARIABLE_READ_ERROR = 4001,
  /** Failed to update variable value */
  VARIABLE_UPDATE_ERROR = 4002,
  /** Error evaluating expression */
  EXPRESSION_EVALUATION_ERROR = 4003,
  /** Error getting stack trace */
  STACK_TRACE_ERROR = 4004,
  /** Error generating completions */
  COMPLETIONS_ERROR = 4005,

  // Memory errors (5000-5099)
  /** Failed to read memory */
  MEMORY_READ_ERROR = 5001,
  /** Failed to write memory */
  MEMORY_WRITE_ERROR = 5002,
  /** Failed to disassemble instructions */
  DISASSEMBLE_ERROR = 5003,

  // Breakpoint errors (6000-6099)
  /** Failed to set breakpoint */
  BREAKPOINT_SET_ERROR = 6001,
  /** Failed to remove breakpoint */
  BREAKPOINT_REMOVE_ERROR = 6002,
  /** Source location not found in debug symbols */
  SOURCE_LOCATION_ERROR = 6003,
  /** Error getting breakpoint info */
  BREAKPOINT_INFO_ERROR = 6004,
}

/**
 * Debug adapter for the PUAE emulator backend, implementing the Debug Adapter
 * Protocol (DAP). Provides debugging capabilities for Amiga programs running
 * in the emulator.
 *
 * Features:
 * - Source-level debugging with DWARF or Amiga hunk debug symbols
 * - Breakpoints, watchpoints, and exception breakpoints
 * - CPU register and custom chip register inspection
 * - Memory viewing and editing
 * - Disassembly view
 * - Expression evaluation with custom functions
 */
export class DebugAdapter extends LoggingDebugSession {
  private static THREAD_ID = 1;
  private static activeAdapter?: DebugAdapter;

  private trace = false;
  private fastLoad = false;
  private programPath = "";
  private debugProgramPath = ""; // file the debug symbols (ELF/hunks) were read from
  private segmentOffsets: number[] = []; // loaded segment base addresses (relocation)
  private sourceBaseDir = ""; // baseDir passed to sourceMapFromDwarf (ELF source paths)

  private isRunning = false;
  private stopOnEntry = false;
  private loadedProgram: LoadedProgram | null = null;
  private stepping = false;
  private lastStepGranularity: DebugProtocol.SteppingGranularity | undefined;
  // Non-null while a line-granularity step is in progress; cleared when the source line changes.
  // isOver: true = step-over (doInstructionStepOver loop), false = step-in (stepInto loop).
  private lineStepStart: { path: string; line: number; isOver: boolean } | null = null;

  private variablesManager?: VariablesManager;
  private breakpointManager?: BreakpointManager;
  private stackManager?: StackManager;
  private disassemblyManager?: DisassemblyManager;
  private evaluateManager?: EvaluateManager;
  // setExceptionBreakpoints can arrive before attach() has constructed
  // breakpointManager (VS Code doesn't wait on our own boot/inject sequence
  // before sending it) — stashed here so attach() can apply it once ready,
  // instead of silently dropping the request (see setExceptionBreakPointsRequest).
  private pendingExceptionFilters?: string[];

  // Hunks needed to inject the program into memory (fastLoad) — always parsed
  // from `programPath` (the bootable Amiga executable, always hunk-format).
  // Also doubles as the debug-info source when debugFormat is 'hunk' and
  // debugProgram === programPath (the common case), avoiding a second parse.
  private hunks: Hunk[] = [];
  private dwarfData?: DWARFData;
  // Which debug format debugProgram actually contains, decided by content
  // (container magic + section presence — see debugSymbolFormat.ts), never by
  // filename extension. 'hunk' covers both "LINE" and hunk-embedded stabs
  // (auto-detected per-block in amigaHunkParser); dwarfData carries the parsed
  // ELF section/symbol table for both 'elf-dwarf' and 'elf-stabs' (parseDwarf
  // always parses sections+symtab regardless of which debug sections exist).
  private debugFormat?: "hunk" | "elf-dwarf" | "elf-stabs";
  private elfStabs?: StabData;
  private sourceMap?: SourceMap;
  // Resolved Kickstart ROM symbols (if the loaded ROM matched), merged into the source map on attach.
  private kickstartSymbols?: KickstartSymbolModule;
  private exceptionInstruction: {
    address: number;
    isSupervisor: boolean;
  } | null = null;
  private frameIdToPc = new Map<number, number>();

  private disposables: Disposable[] = [];

  /**
   * Gets the currently active debug adapter instance.
   * Returns undefined if no debug session is active.
   */
  public static getActiveAdapter(): DebugAdapter | undefined {
    return DebugAdapter.activeAdapter;
  }

  public getEmulator(): Emulator {
    return this.emulator;
  }

  public getProfilerClient(): ProfilerRpcClient {
    return this.emulator as unknown as ProfilerRpcClient;
  }

  public notifySteppedBack(): void {
    this.sendEvent(new StoppedEvent("step", DebugAdapter.THREAD_ID));
  }

  /**
   * Creates a new DebugAdapter instance.
   *
   * Initializes the debug adapter with:
   * - Zero-based line and column numbering
   * - Emulator interface for program execution and debugging
   * - Manager classes for evaluation, variables, breakpoints, etc.
   *
   * @param emulator Emulator instance for dependency injection (primarily for testing)
   * @param openProfiler Backs the "openProfiler" customRequest (see customRequest below) — the
   * standalone server binds this to opening the profiler's URL in a browser (there's no vscode
   * command palette outside vscode to put an "openProfiler" command in); the vscode extension
   * binds it to `ProfilerViewerProvider.show()` for parity, though it also already has a debug
   * toolbar button for the same thing.
   */
  public constructor(
    private emulator: Emulator,
    private readonly openProfiler?: () => void,
  ) {
    super();
    this.setDebuggerLinesStartAt1(false);
    this.setDebuggerColumnsStartAt1(false);
  }

  /**
   * Shuts down the debug adapter and cleans up resources.
   */
  public shutdown(): void {
    this.dispose();
  }

  /**
   * Disposes of all resources used by the debug adapter.
   */
  public dispose(): void {
    // Clear active adapter if this was the active one
    if (DebugAdapter.activeAdapter === this) {
      DebugAdapter.activeAdapter = undefined;
    }
    void Promise.resolve(this.emulator.run()).catch(() => undefined); // best effort while disposing
    if (this.breakpointManager) {
      void Promise.resolve(this.breakpointManager.clearAll()).catch(() => undefined);
    }
    this.disposables.forEach((d) => d?.dispose());
    this.disposables = [];
  }

  // Request handlers:

  protected initializeRequest(
    response: DebugProtocol.InitializeResponse,
  ): void {
    response.body = response.body || {};
    response.body.supportsConfigurationDoneRequest = true;
    response.body.supportsSetVariable = true;
    response.body.supportsSetExpression = true;
    response.body.supportsReadMemoryRequest = true;
    response.body.supportsWriteMemoryRequest = true;
    response.body.supportsDisassembleRequest = true;
    response.body.supportsInstructionBreakpoints = true;
    response.body.supportsDataBreakpoints = true;
    response.body.supportsConfigurationDoneRequest = true;
    response.body.supportsHitConditionalBreakpoints = true;
    response.body.supportsConditionalBreakpoints = true;
    response.body.supportsLogPoints = true;
    response.body.supportsEvaluateForHovers = true;
    response.body.supportsCompletionsRequest = true;
    response.body.supportsFunctionBreakpoints = true;
    response.body.supportsStepBack = true;

    response.body.exceptionBreakpointFilters = exceptionBreakpointFilters;

    this.sendResponse(response);
  }

  protected async launchRequest(
    response: DebugProtocol.LaunchResponse,
    args: LaunchRequestArguments,
  ) {
    // Register this as the active adapter
    DebugAdapter.activeAdapter = this;

    // Validate the program path
    this.programPath = args.program;
    if (!this.programPath) {
      this.sendError(
        response,
        ErrorCode.PROGRAM_NOT_SPECIFIED,
        "program not specified",
      );
      this.sendEvent(new TerminatedEvent());
      return;
    }

    this.sendEvent(new OutputEvent(initOutput));

    // Initialize logger:
    logger.init((e) => this.sendEvent(e));
    logger.setup(args.trace ? LogLevel.Verbose : LogLevel.Warn);

    this.trace = args.trace ?? false;
    this.fastLoad = args.fastLoad ?? false;

    const debugProgram = args.debugProgram || this.programPath;
    this.debugProgramPath = debugProgram;
    logger.log(`Reading debug symbols from ${debugProgram}`);

    // Read debug symbols. Container (ELF vs Amiga hunk) and, within ELF, debug
    // format (DWARF vs GNU stabs) are both detected from file content — never
    // from the filename — since vasm/vbcc/GCC can each target either container
    // independently of which debug format they emit (see debugSymbolFormat.ts).
    // Hunk-embedded debug info (vasm/vbcc "LINE", or GCC stabs) is
    // auto-detected per-HUNK_DEBUG-block inside parseHunks/sourceMapFromHunks.
    // ELF is also useful for compatibility with bartman's profiler in a single build.
    try {
      const buffer = await readFile(debugProgram);
      const container = detectContainer(buffer);
      if (container === "elf") {
        this.dwarfData = parseDwarf(buffer); // always parses sections + .symtab
        if (hasDwarfSections(this.dwarfData)) {
          logger.log("Interpreting as ELF/DWARF debug data");
          this.debugFormat = "elf-dwarf";
        } else if (hasElfStabsSections(this.dwarfData)) {
          logger.log("Interpreting as ELF/stabs debug data");
          this.debugFormat = "elf-stabs";
          this.elfStabs = extractElfStabs(buffer, this.dwarfData);
        } else {
          throw new Error(
            `ELF file "${debugProgram}" contains neither DWARF (.debug_info) nor ` +
              "GNU stabs (.stab/.stabstr) debug sections",
          );
        }
        // Program loading always needs the (always hunk-format) bootable executable.
        if (this.fastLoad) {
          const hunkExeBuffer = await readFile(this.programPath);
          this.hunks = parseHunks(hunkExeBuffer);
        }
      } else {
        logger.log("Interpreting as Amiga hunk debug data");
        this.debugFormat = "hunk";
        this.hunks = parseHunks(buffer);
      }
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.DEBUG_SYMBOLS_READ_ERROR,
        "error reading debug symbols",
        err,
      );
    }

    // Load Kickstart ROM symbols if the configured ROM is one we have symbols for.
    // Best-effort: a missing/unreadable/unknown ROM must not abort the launch.
    const kickstartRomPath = args.kickstartRom ?? args.emulatorOptions?.kickstartRomPath;
    if (kickstartRomPath) {
      try {
        const romBuffer = await readFile(kickstartRomPath as string);
        this.kickstartSymbols = kickstartSymbolModule(romBuffer);
        if (this.kickstartSymbols) {
          const symbolCount = Object.keys(this.kickstartSymbols.symbols).length;
          this.sendEvent(
            new OutputEvent(
              `Loaded symbols for ${this.kickstartSymbols.name}\n`,
            ),
          );
          logger.log(
            `Loaded ${symbolCount} Kickstart symbols ` +
              `(${this.kickstartSymbols.name}) at base 0x${this.kickstartSymbols.base.toString(16)}`,
          );
        } else {
          logger.log(`No Kickstart symbols available for ROM ${kickstartRomPath}`);
        }
      } catch (err) {
        logger.warn(`Could not read Kickstart ROM for symbols: ${this.errorString(err)}`);
      }
    }

    try {
      logger.log(`Starting emulator with program ${this.programPath}`);

      const kickstartRom =
        args.kickstartRom ??
        (args.emulatorOptions?.kickstartRomPath as string | undefined);

      if (this.fastLoad) {
        logger.log("Using fast memory injection mode");
        this.emulator.open({
          kickstartRom,
          emulatorConfigFile: args.emulatorConfigFile,
          bufferFrames: args.bufferFrames,
          ...args.emulatorOptions,
        });
      } else {
        this.emulator.open({
          programPath: this.programPath,
          hardDrivePath: args.hardDrivePath,
          kickstartRom,
          emulatorConfigFile: args.emulatorConfigFile,
          bufferFrames: args.bufferFrames,
          ...args.emulatorOptions,
        });
      }

      // Add listeners to emulator
      this.disposables.push(
        this.emulator.onDidDispose(() => this.sendEvent(new TerminatedEvent())),
      );
      this.disposables.push(
        this.emulator.onDidReceiveMessage(async (message) => {
          try {
            await this.handleMessageFromEmulator(message);
          } catch (err) {
            console.error(
              `Error while processing ${message.type} message:`,
              err,
            );
            this.sendEvent(
              new OutputEvent(
                `Error while processing ${message.type} message: ${this.errorString(err)}\n`,
                "stderr",
              ),
            );
            this.sendEvent(new TerminatedEvent());
          }
        }),
      );

      this.isRunning = true;
      this.stopOnEntry = args.stopOnEntry ?? false;
      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.EMULATOR_START_ERROR,
        "Failed to start emulator",
        err,
      );
      this.sendEvent(new TerminatedEvent());
    }
  }

  protected async configurationDoneRequest(
    response: DebugProtocol.ConfigurationDoneResponse,
  ): Promise<void> {
    // All breakpoints etc are set by client now and we can continue...
    if (this.stopOnEntry && this.fastLoad) {
      // Fast load: send stop on entry event - we're already at this address
      const evt: DebugProtocol.StoppedEvent = new StoppedEvent(
        "entry",
        DebugAdapter.THREAD_ID,
      );
      evt.body.allThreadsStopped = true;
      this.sendEvent(evt);
    } else {
      // Resume emulator
      // even if stopOnEntry is set, we need to run to hit the temporary breakpoin in normal mode
      this.sendEvent(new OutputEvent(`Program started\n`));
      await this.emulator.run();
    }
    this.sendResponse(response);
  }

  protected async continueRequest(response: DebugProtocol.ContinueResponse): Promise<void> {
    try {
      await this.emulator.run();
      response.body = { allThreadsContinued: true };
      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.CONTINUE_ERROR,
        "Continue operation failed",
        err,
      );
    }
  }

  protected async pauseRequest(response: DebugProtocol.PauseResponse): Promise<void> {
    try {
      await this.emulator.pause();
      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.PAUSE_ERROR,
        "Pause operation failed",
        err,
      );
    }
  }

  protected disconnectRequest(
    response: DebugProtocol.DisconnectResponse,
  ): void {
    this.dispose();
    this.sendEvent(new TerminatedEvent());
    this.sendResponse(response);
  }

  protected async threadsRequest(
    response: DebugProtocol.ThreadsResponse,
  ): Promise<void> {
    response.body = {
      threads: [new Thread(DebugAdapter.THREAD_ID, "Main")],
    };
    this.sendResponse(response);
  }

  protected async stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    args: DebugProtocol.StackTraceArguments,
  ): Promise<void> {
    const startFrame = args.startFrame ?? 0;
    const maxLevels = args.levels ?? 16;

    try {
      const { frames: stk, total: totalFrames } = await this.getStackManager().getStackFrames(
        startFrame,
        maxLevels,
        this.exceptionInstruction,
      );
      this.exceptionInstruction = null; // clear after using it once
      this.frameIdToPc.clear();
      // A variablesReference is only valid until the next stop (DAP spec); VS Code always
      // re-fetches scopes after a stop rather than reusing a stale reference, so this can be
      // dropped for the new stop too -- otherwise every scope/struct/array/pointer expansion
      // grows VariablesManager's handle maps unbounded over a long session.
      this.variablesManager?.reset();
      for (const f of stk) {
        if (f.instructionPointerReference)
          this.frameIdToPc.set(f.id, parseInt(f.instructionPointerReference, 16));
      }
      response.body = {
        stackFrames: stk,
        totalFrames,
      };
      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.STACK_TRACE_ERROR,
        "Error getting stack trace",
        err,
      );
    }
  }

  protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
    const pc = this.frameIdToPc.get(args.frameId) ?? null;
    const regs = this.stackManager?.getFrameRegs(args.frameId) ?? null;
    const scopes = this.variablesManager?.getScopes(pc, regs) ?? [];
    response.body = { scopes };
    this.sendResponse(response);
  }

  protected async variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments,
  ): Promise<void> {
    try {
      // VariablesManager now handles all variable references including arrays from EvaluateManager
      const variables = await this.getVariablesManager().getVariables(
        args.variablesReference,
      );

      response.body = { variables };
      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.VARIABLE_READ_ERROR,
        `Error fetching variables`,
        err,
      );
    }
  }

  protected async setVariableRequest(
    response: DebugProtocol.SetVariableResponse,
    args: DebugProtocol.SetVariableArguments,
  ): Promise<void> {
    try {
      const value = await this.getVariablesManager().setVariable(
        args.variablesReference,
        args.name,
        Number(args.value),
      );
      response.body = { value };
      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.VARIABLE_UPDATE_ERROR,
        `Error updating variable`,
        err,
      );
    }
  }

  protected async setExpressionRequest(
    response: DebugProtocol.SetExpressionResponse,
    args: DebugProtocol.SetExpressionArguments,
  ): Promise<void> {
    try {
      // Resolve the frame's pc and register snapshot (same as evaluateRequest) so the C/C++
      // expression evaluator can locate locals for the write target.
      const pc =
        args.frameId !== undefined
          ? (this.frameIdToPc.get(args.frameId) ?? null)
          : null;
      const regs =
        args.frameId !== undefined
          ? (this.stackManager?.getFrameRegs(args.frameId) ?? null)
          : null;
      response.body = await this.getEvaluateManager().setExpression(
        args.expression,
        args.value,
        pc,
        regs,
      );
      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.VARIABLE_UPDATE_ERROR,
        `Error setting '${args.expression}'`,
        err,
      );
    }
  }

  protected async stepInRequest(
    response: DebugProtocol.StepInResponse,
    args: DebugProtocol.StepInArguments,
  ): Promise<void> {
    try {
      this.lastStepGranularity = args.granularity;
      if (args.granularity !== "instruction") {
        // Record start location so handleStep can loop until the source line changes.
        const cpuInfo = await this.emulator.getCpuInfo();
        const loc = this.sourceMap?.lookupAddress(Number(cpuInfo.pc));
        if (loc) this.lineStepStart = { path: loc.path, line: loc.line, isOver: false };
      }
      this.stepping = true;
      this.isRunning = true;
      try {
        await this.emulator.stepInto();
      } catch (err) {
        // A rejected stepInto() never produces a "stopped" state message, so nothing else
        // resets these — left true, the next unrelated stop (e.g. a real breakpoint) would be
        // misrouted through handleStep() instead of handleStop() (see updateState's dispatch).
        this.stepping = false;
        this.isRunning = false;
        throw err;
      }
      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.STEP_ERROR,
        "Step operation failed",
        err,
      );
    }
  }

  // Performs one instruction-level step-over. The Emulator interface has no native
  // stepOver — implemented here by decoding the instruction at PC and, for a
  // call/branch-type instruction, setting a temporary breakpoint just past it instead
  // of single-stepping into it.
  private async doInstructionStepOver(): Promise<void> {
    const cpuInfo = await this.emulator.getCpuInfo();
    const pc = Number(cpuInfo.pc);
    // Read enough bytes for 2 worst-case instructions and decode locally.
    const memBuf = await this.emulator.readMemory(pc, 20);
    const mem = new Uint8Array(memBuf.buffer, memBuf.byteOffset, memBuf.byteLength);
    const instrs: { addr: number; text: string }[] = [];
    let off = 0;
    while (off < mem.length && instrs.length < 2) {
      const slice = mem.subarray(off);
      if (slice.length < 2) break;
      let bytesUsed = 2;
      let text = "";
      try {
        const d = m68kDecode(slice);
        bytesUsed = Math.max(d.bytesUsed, 2);
        text = instructionToString(d.instruction).trim();
      } catch { /* unknown opcode */ }
      instrs.push({ addr: pc + off, text });
      off += bytesUsed;
    }
    const currInst = instrs[0]?.text ?? "";
    const nextAddr = instrs[1]?.addr;

    // If current instruction is one of these i.e. it should eventually reach the next line,
    // set tmp breakpoint on next instruction, otherwise just use built-in stepInto.
    const isBranch = currInst.match(/^(jsr|bsr|dbra)/i);
    if (nextAddr !== undefined && isBranch) {
      await this.getBreakpointManager().setTmpBreakpoint(nextAddr, "step");
      await this.emulator.run();
    } else {
      this.stepping = true;
      try {
        await this.emulator.stepInto();
      } catch (err) {
        // See stepInRequest's matching catch: a rejected stepInto() leaves `stepping` stuck
        // true with nothing else to reset it, misrouting the next unrelated stop event.
        this.stepping = false;
        throw err;
      }
    }
    this.isRunning = true;
  }

  protected async nextRequest(
    response: DebugProtocol.NextResponse,
    args: DebugProtocol.NextArguments,
  ): Promise<void> {
    try {
      if (args.granularity !== "instruction") {
        const cpuInfo = await this.emulator.getCpuInfo();
        const pc = Number(cpuInfo.pc);
        const loc = this.sourceMap?.lookupAddress(pc);
        if (loc) {
          // Line granularity: loop doInstructionStepOver until the source line changes.
          // This correctly skips function bodies because doInstructionStepOver detects
          // JSR/BSR and sets a temp BP at the return address (never entering the callee).
          this.lineStepStart = { path: loc.path, line: loc.line, isOver: true };
          await this.doInstructionStepOver();
          this.sendResponse(response);
          return;
        }
        // No source info at current PC — fall through to instruction granularity
      }
      await this.doInstructionStepOver();
      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.STEP_ERROR,
        "Step operation failed",
        err,
      );
    }
  }

  protected async stepOutRequest(
    response: DebugProtocol.StepOutResponse,
  ): Promise<void> {
    try {
      // The Emulator interface has no native stepOut, so use the real shadow
      // call-stack (StackManager.getRealCallstack) to set a tmp breakpoint
      // at the immediate caller's return address instead.
      const cpuInfo = await this.emulator.getCpuInfo();
      const pc = Number(cpuInfo.pc);
      const stack = await this.getStackManager().getRealCallstack(pc);

      // stack 0 is pc
      if (stack[1]) {
        await this.getBreakpointManager().setTmpBreakpoint(stack[1][1], "step");
        this.isRunning = true;
        await this.emulator.run();
      } else {
        this.stepping = true;
        this.isRunning = true;
        await this.emulator.stepInto();
      }
      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.STEP_ERROR,
        "Step operation failed",
        err,
      );
    }
  }

  protected async stepBackRequest(
    response: DebugProtocol.StepBackResponse,
  ): Promise<void> {
    try {
      const moved = await this.emulator.stepBack();
      if (!moved) {
        this.sendEvent(
          new OutputEvent(
            "Cannot step back further: reached start of rewind history\n",
            "important",
          ),
        );
      }
      this.sendEvent(new StoppedEvent("step", DebugAdapter.THREAD_ID));
      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.STEP_ERROR,
        "Step operation failed",
        err,
      );
    }
  }

  protected async reverseContinueRequest(
    response: DebugProtocol.ReverseContinueResponse,
  ): Promise<void> {
    try {
      const moved = await this.emulator.continueReverse();
      if (!moved) {
        this.sendEvent(
          new OutputEvent(
            "Cannot continue reverse: reached start of rewind history\n",
            "important",
          ),
        );
      }
      this.sendEvent(new StoppedEvent("step", DebugAdapter.THREAD_ID));
      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.STEP_ERROR,
        "Step operation failed",
        err,
      );
    }
  }

  protected async setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments,
  ): Promise<void> {
    try {
      const path = args.source.path!;
      const breakpoints =
        await this.getBreakpointManager().setSourceBreakpoints(
          path,
          args.breakpoints ?? [],
        );

      response.body = { breakpoints };
      this.sendResponse(response);
    } catch (err) {
      return this.sendError(
        response,
        ErrorCode.BREAKPOINT_SET_ERROR,
        `Error setting breakpoint`,
        err,
      );
    }
  }

  protected async setInstructionBreakpointsRequest(
    response: DebugProtocol.SetInstructionBreakpointsResponse,
    args: DebugProtocol.SetInstructionBreakpointsArguments,
  ): Promise<void> {
    try {
      const breakpoints =
        await this.getBreakpointManager().setInstructionBreakpoints(
          args.breakpoints ?? [],
        );

      response.body = { breakpoints };
      this.sendResponse(response);
    } catch (err) {
      return this.sendError(
        response,
        ErrorCode.BREAKPOINT_SET_ERROR,
        `Error setting breakpoint`,
        err,
      );
    }
  }

  protected async setFunctionBreakPointsRequest(
    response: DebugProtocol.SetFunctionBreakpointsResponse,
    args: DebugProtocol.SetFunctionBreakpointsArguments,
  ): Promise<void> {
    try {
      const breakpoints = await this.getBreakpointManager().setFunctionBreakpoints(
        args.breakpoints ?? [],
      );

      response.body = { breakpoints };
      this.sendResponse(response);
    } catch (err) {
      return this.sendError(
        response,
        ErrorCode.BREAKPOINT_SET_ERROR,
        `Error setting breakpoint`,
        err,
      );
    }
  }

  protected dataBreakpointInfoRequest(
    response: DebugProtocol.DataBreakpointInfoResponse,
    args: DebugProtocol.DataBreakpointInfoArguments,
  ): void {
    try {
      // Handle variables that have memory references
      // TODO: handle expressions as args.name, and args.asAddress
      if (args.variablesReference) {
        const id = this.getVariablesManager().getVariableReference(
          args.variablesReference,
        );
        // Only string IDs support data breakpoints (not array values)
        if (typeof id === "string") {
          const result = this.getBreakpointManager().getDataBreakpointInfo(
            id,
            args.name,
          );
          if (result) {
            response.body = result;
            this.sendResponse(response);
            return;
          }
        }
      }

      response.body = {
        dataId: null,
        description: "Data breakpoint not supported for this variable",
      };
      this.sendResponse(response);
    } catch (err) {
      return this.sendError(
        response,
        ErrorCode.BREAKPOINT_INFO_ERROR,
        `Error getting breakpoint info`,
        err,
      );
    }
  }

  protected async setDataBreakpointsRequest(
    response: DebugProtocol.SetDataBreakpointsResponse,
    args: DebugProtocol.SetDataBreakpointsArguments,
  ): Promise<void> {
    try {
      const breakpoints = await this.getBreakpointManager().setDataBreakpoints(
        args.breakpoints,
      );

      response.body = { breakpoints };
      this.sendResponse(response);
    } catch (err) {
      return this.sendError(
        response,
        ErrorCode.BREAKPOINT_SET_ERROR,
        `Error setting breakpoint`,
        err,
      );
    }
  }

  /**
   * Handles custom (non-DAP-standard) requests. "setWatchpointLength"/
   * "getWatchpointLength" back the "Set Watchpoint Length..." variable
   * context-menu command (extension.ts) — DAP has no native field for an
   * editable watchpoint length, so this is a side channel for it.
   * "stepBackFrame"/"eof"/"eol" back the corresponding debug-toolbar
   * commands (extension.ts) and are also how a non-vscode DAP client (e.g.
   * nvim-dap, talking to the standalone server) drives the same actions —
   * there's no in-process `DebugAdapter.getActiveAdapter()` shortcut to
   * reach for outside the vscode extension host. "openProfiler" is the same
   * idea for opening the profiler — see the `openProfiler` constructor
   * param's doc comment.
   */
  protected async customRequest(
    command: string,
    response: DebugProtocol.Response,
    args: { dataId?: string; length?: number },
  ): Promise<void> {
    try {
      if (command === "setWatchpointLength") {
        await this.getBreakpointManager().setWatchpointLengthOverride(
          args.dataId as string,
          args.length,
        );
        this.sendResponse(response);
        return;
      }
      if (command === "getWatchpointLength") {
        response.body = await this.getBreakpointManager().getWatchpointLengthInfo(
          args.dataId as string,
        );
        this.sendResponse(response);
        return;
      }
      if (command === "stepBackFrame") {
        const moved = await this.emulator.stepBackFrame();
        if (!moved) {
          this.sendEvent(
            new OutputEvent(
              "Cannot step back further: reached start of rewind history\n",
              "important",
            ),
          );
        } else {
          this.notifySteppedBack();
        }
        this.sendResponse(response);
        return;
      }
      if (command === "eof") {
        await this.emulator.eof();
        this.sendResponse(response);
        return;
      }
      if (command === "eol") {
        await this.emulator.eol();
        this.sendResponse(response);
        return;
      }
      if (command === "openProfiler") {
        this.openProfiler?.();
        this.sendResponse(response);
        return;
      }
      super.customRequest(command, response, args);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.BREAKPOINT_INFO_ERROR,
        `Custom request '${command}' failed`,
        err,
      );
    }
  }

  protected async evaluateRequest(
    response: DebugProtocol.EvaluateResponse,
    args: DebugProtocol.EvaluateArguments,
  ): Promise<void> {
    logger.log(`Evaluate request: ${args.expression}`);
    // 'watch' | 'repl' | 'hover' | 'clipboard' | 'variables' | string;
    const context = args.context;

    // Check for commands first in console
    if (context === "repl") {
      const [firstWord, ...cmdArgs] = args.expression
        .trim()
        .toLowerCase()
        .split(/\s+/g);

      // Help command:
      if (["help", "?", "h"].includes(firstWord)) {
        if (cmdArgs[0] === "syntax") {
          this.sendEvent(new OutputEvent(syntaxText));
        } else if (cmdArgs[0] === "functions") {
          this.sendEvent(new OutputEvent(functionsText));
        } else {
          this.sendEvent(new OutputEvent(helpText));
        }
        this.sendResponse(response);
        return;
      }
    }

    try {
      // Resolve the hovered/evaluated frame's pc and register snapshot (same as scopesRequest) so
      // the evaluate path can look up C/C++ locals/globals by name.
      const pc =
        args.frameId !== undefined
          ? (this.frameIdToPc.get(args.frameId) ?? null)
          : null;
      const regs =
        args.frameId !== undefined
          ? (this.stackManager?.getFrameRegs(args.frameId) ?? null)
          : null;
      response.body = await this.getEvaluateManager().evaluateFormatted(
        args,
        pc,
        regs,
      );
      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.EXPRESSION_EVALUATION_ERROR,
        `Error evaluating '${args.expression}'`,
        err,
      );
    }
  }

  protected async readMemoryRequest(
    response: DebugProtocol.ReadMemoryResponse,
    args: DebugProtocol.ReadMemoryArguments,
  ): Promise<void> {
    logger.log(
      `Read memory request: ${args.memoryReference}, offset: ${args.offset}, count: ${args.count}`,
    );
    try {
      const address = Number(args.memoryReference) + (args.offset || 0);
      const count = Math.min(4096, args.count);
      if (count) {
        const result = await this.emulator.readMemory(address, count);
        response.body = {
          address: formatHex(address),
          data: result.toString("base64"),
          unreadableBytes: 0,
        };
      }
      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.MEMORY_READ_ERROR,
        "Failed to read memory",
        err,
      );
    }
  }

  protected async writeMemoryRequest(
    response: DebugProtocol.WriteMemoryResponse,
    args: DebugProtocol.WriteMemoryArguments,
  ): Promise<void> {
    logger.log(
      `Write memory request: ${args.memoryReference}, offset: ${args.offset}`,
    );
    try {
      const address = Number(args.memoryReference) + (args.offset || 0);
      const buf = Buffer.from(args.data, "base64");
      await this.emulator.writeMemory(address, buf); // Pass base64 data directly
      response.body = {
        offset: args.offset,
        bytesWritten: buf.length,
      };
      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.MEMORY_WRITE_ERROR,
        "Failed to write memory",
        err,
      );
    }
  }

  protected async disassembleRequest(
    response: DebugProtocol.DisassembleResponse,
    args: DebugProtocol.DisassembleArguments,
  ): Promise<void> {
    logger.log(
      `Disassemble request: ${args.memoryReference}, instructionOffset: ${args.instructionOffset}, count: ${args.instructionCount}`,
    );
    try {
      const baseAddress = Number(args.memoryReference) + (args.offset ?? 0);
      const instructionOffset = args.instructionOffset ?? 0;
      const count = args.instructionCount;
      const instructions = await this.getDisassemblyManager().disassemble(
        baseAddress,
        instructionOffset,
        count,
      );
      response.body = { instructions };
      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.DISASSEMBLE_ERROR,
        "Failed to disassemble",
        err,
      );
    }
  }

  protected locationsRequest(
    response: DebugProtocol.LocationsResponse,
    args: DebugProtocol.LocationsArguments,
  ): void {
    try {
      const location = this.getVariablesManager().getLocationReference(
        args.locationReference,
      );
      if (location) {
        response.body = {
          source: new Source(path.basename(location.path), location.path),
          line: location.line,
        };
      }
      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.DEBUG_SYMBOLS_READ_ERROR,
        "Failed to get location",
        err,
      );
    }
  }

  protected async setExceptionBreakPointsRequest(
    response: DebugProtocol.SetExceptionBreakpointsResponse,
    args: DebugProtocol.SetExceptionBreakpointsArguments,
  ): Promise<void> {
    try {
      if (!this.breakpointManager) {
        // attach() hasn't constructed breakpointManager yet (it can race
        // with our own boot/inject sequence) — stash the filters so attach()
        // can apply them once it has, rather than silently dropping this
        // request (which would leave e.g. memory protection enforcement
        // never enabled for the whole session, with no further retry from
        // VS Code).
        this.pendingExceptionFilters = args.filters;
        response.body = {
          breakpoints: args.filters.map(() => ({ verified: true })),
        };
        this.sendResponse(response);
        return;
      }

      const breakpoints = await this.breakpointManager.setExceptionBreakpoints(
        args.filters,
      );

      response.body = { breakpoints };
      this.sendResponse(response);
    } catch (err) {
      return this.sendError(
        response,
        ErrorCode.BREAKPOINT_SET_ERROR,
        `Error setting exception breakpoint`,
        err,
      );
    }
  }

  protected async completionsRequest(
    response: DebugProtocol.CompletionsResponse,
    args: DebugProtocol.CompletionsArguments,
  ): Promise<void> {
    try {
      response.body = { targets: [] };

      // Get the prefix part (what's before the cursor) for matching
      const beforeCursor = args.text.substring(0, args.column - 1);
      const beforeMatch = beforeCursor.match(/\b[a-zA-Z0-9_$]*$/);

      if (beforeMatch) {
        const prefix = beforeMatch[0];
        const vars = await this.getVariablesManager().getFlatVariables();
        const varMatches = Object.keys(vars).filter((name) =>
          name.toLowerCase().startsWith(prefix.toLowerCase()),
        );
        varMatches.forEach((varName) => {
          response.body.targets.push({
            label: varName,
            start: args.text.length - prefix.length + 1,
            length: prefix.length,
            type: "variable",
          });
        });

        const functionMatches = Object.keys(allFunctions).filter((name) =>
          name.toLowerCase().startsWith(prefix.toLowerCase()),
        );
        functionMatches.forEach((varName) => {
          response.body.targets.push({
            label: varName,
            text: varName + "()",
            detail: allFunctions[varName as keyof typeof allFunctions][1],
            selectionLength: 0,
            selectionStart: varName.length + 1,
            start: args.text.length - prefix.length + 1,
            length: prefix.length,
            type: "function",
          });
        });

        const commandMatches = Object.keys(consoleCommands).filter((name) =>
          name.toLowerCase().startsWith(prefix.toLowerCase()),
        );
        commandMatches.forEach((varName) => {
          response.body.targets.push({
            label: varName,
            detail: consoleCommands[varName as keyof typeof consoleCommands][1],
            start: args.text.length - prefix.length + 1,
            length: prefix.length,
            type: "keyword",
          });
        });
      }

      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.COMPLETIONS_ERROR,
        "Error generating completions",
        err,
      );
    }
  }

  // Helpers:

  /**
   * Handles messages received from the emulator.
   *
   * Processes different message types:
   * - Attached messages: Sets up source mapping when emulator attaches to program
   * - State messages: Updates debug session state (running/paused/stopped)
   * - Output messages: Forwards emulator output to debug console
   *
   * @param message The message received from the emulator
   */

  private async handleMessageFromEmulator(message: EmulatorMessage) {
    logger.log(`Received message: ${message.type}`);

    if (isAttachedMessage(message)) {
      return this.attach(message.segments.map((s) => s.start));
    } else if (isEmulatorStateMessage(message)) {
      return this.updateState(message);
    } else if (isEmulatorOutputMessage(message)) {
      this.sendEvent(new OutputEvent(message.data + "\n"));
    } else if (isExecReadyMessage(message)) {
      if (this.fastLoad) {
        await this.injectProgram();
      }
    }
  }

  /**
   * Injects the program into emulator memory for fast loading.
   *
   * Uses the AmigaHunkLoader to load the program directly into memory
   * without requiring floppy disk emulation. Sets up memory segments
   * and calls attach() with the loaded program offsets.
   */
  private async injectProgram() {
    logger.log("Injecting program into memory");
    try {
      // Ensure the CPU is halted before poking memory/registers — the emulator is
      // still running freely at this point (right after exec-ready). Silent:
      // this is internal housekeeping, not a real user-visible stop — a
      // non-silent pause here races a StoppedEvent (and the client's
      // resulting stackTrace/scopes/variables requests) against the rest of
      // this method and attach() below, which haven't set up stackManager
      // etc. yet. Reproduced end-to-end against the standalone server: a
      // real WebSocket round-trip apparently batches the "paused" state
      // message and this pause() call's own RPC response differently than
      // vscode's postMessage bridge does, timing-wise, making the race fire
      // reliably instead of rarely.
      await this.emulator.pause(true);
      // Clear any watchpoints/register watches left armed from a previous
      // debug session — the webview (and its emulator state) can be reused
      // across sessions, but this session's BreakpointManager starts fresh
      // and has no record of what an earlier one set, so without this a
      // stale watch keeps firing despite not being listed anywhere. Must
      // happen before attach() below (which sends InitializedEvent, the
      // signal that lets VS Code start sending this session's own
      // setDataBreakpoints requests) so it can't undo what this session
      // just armed.
      await this.emulator.resetWatchpoints();
      this.loadedProgram = await loadAmigaProgram(this.emulator, this.hunks);
      logger.log(
        `Program loaded at ${formatHex(this.loadedProgram.entryPoint)}`,
      );
      // Seed the memory protection allow-list with this program's own hunks +
      // stack budget. Enablement itself is controlled separately, via the
      // "Write to unallocated memory" exception breakpoint filter (see
      // breakpointManager.ts's setExceptionBreakpoints).
      await this.emulator.resetMemoryProtectionRanges();
      for (const alloc of this.loadedProgram.allocations) {
        await this.emulator.addMemoryProtectionRange(alloc.address, alloc.size);
      }
      if (this.loadedProgram.stackRange) {
        await this.emulator.addMemoryProtectionRange(
          this.loadedProgram.stackRange.address,
          this.loadedProgram.stackRange.size,
        );
      }
      this.sendEvent(
        new OutputEvent(
          `Memory protection ranges seeded: ` +
            `hunks=${JSON.stringify(this.loadedProgram.allocations.map((a) => ({ address: formatHex(a.address), size: a.size })))} ` +
            `stackRange=${
              this.loadedProgram.stackRange
                ? JSON.stringify({
                    address: formatHex(this.loadedProgram.stackRange.address),
                    size: this.loadedProgram.stackRange.size,
                  })
                : "undefined"
            }\n`,
        ),
      );
      // resetMemoryProtectionRanges() above also wiped the resident-library
      // ranges seeded automatically at boot (see webviewEmulator.ts) — put
      // them back so writes into GfxBase/IntuitionBase/DosBase/etc. (e.g. a
      // LoadView call) aren't misflagged alongside this program's own hunks.
      await this.emulator.seedResidentLibraries();
      const offsets = this.loadedProgram.allocations.map((s) => s.address);
      await this.attach(offsets);
    } catch (error) {
      this.sendEvent(
        new OutputEvent(
          `Fatal error during attach: ${this.errorString(error)}\n`,
          "stderr",
        ),
      );
    }
  }

  /**
   * Handles emulator attachment to a program.
   *
   * Sets up source mapping based on loaded segments and debug symbol format.
   * Creates source maps from either DWARF debug info or Amiga hunk debug data.
   * Sets entry breakpoint if stopOnEntry is enabled.
   */
  private async attach(offsets: number[]): Promise<void> {
    try {
      this.segmentOffsets = offsets;
      switch (this.debugFormat) {
        case "elf-dwarf": {
          // Elf doesn't contain absolute path of sources. Assume it's one level up e.g. `out/a.elf`
          // TODO: find a better way to do this, add launch option, check files exist there
          const baseDir = path.dirname(path.dirname(this.programPath));
          this.sourceBaseDir = baseDir;
          this.sourceMap = sourceMapFromDwarf(this.dwarfData!, offsets, baseDir);
          break;
        }
        case "elf-stabs":
          this.sourceMap = sourceMapFromElfStabs(this.dwarfData!, this.elfStabs!, offsets);
          break;
        case "hunk":
          this.sourceMap = sourceMapFromHunks(this.hunks, offsets);
          break;
        default:
          throw new Error("No debug symbols");
      }

      // Merge Kickstart ROM symbols (if resolved) so OS calls show names in stack/disassembly.
      if (this.kickstartSymbols) {
        this.sourceMap.addSymbolModule(
          this.kickstartSymbols.segment,
          this.kickstartSymbols.symbols,
        );
      }

      // Lets the emulator backend symbolize addresses for itself on webview
      // request (e.g. PuaeEmulator's copper-overlay hover tooltip).
      this.emulator.setSourceMap(this.sourceMap);

      // Initialize specialized manager classes for debugging functionality:
      this.variablesManager = new VariablesManager(this.emulator, this.sourceMap);
      this.breakpointManager = new BreakpointManager(
        this.emulator,
        this.sourceMap,
      );
      if (this.pendingExceptionFilters) {
        await this.breakpointManager.setExceptionBreakpoints(
          this.pendingExceptionFilters,
        );
        this.pendingExceptionFilters = undefined;
      }
      this.stackManager = new StackManager(this.emulator, this.sourceMap);
      this.disassemblyManager = new DisassemblyManager(
        this.emulator,
        this.sourceMap,
      );
      this.evaluateManager = new EvaluateManager(
        this.emulator,
        this.sourceMap,
        this.variablesManager,
        this.disassemblyManager,
      );

      if (this.stopOnEntry && !this.fastLoad) {
        await this.breakpointManager.setTmpBreakpoint(offsets[0], "entry");
      }
      // Announces the (single, fixed) thread before any stop happens. DAP
      // clients commonly only populate their local thread list in response
      // to a `stopped` event — without this, a client that hasn't seen one
      // yet (e.g. launched with stopOnEntry: false, still freely running)
      // has no known threadId to pause, and refuses to send the request at
      // all (nvim-dap: "No thread to stop. Not pausing...").
      this.sendEvent(new ThreadEvent("started", DebugAdapter.THREAD_ID));
      this.sendEvent(new InitializedEvent());
    } catch (error) {
      this.sendEvent(
        new OutputEvent(
          `Fatal error during attach: ${this.errorString(error)}\n`,
          "stderr",
        ),
      );
      this.sendEvent(new TerminatedEvent());
    }
  }

  /**
   * Updates the debug session state based on emulator state changes.
   *
   * Handles transitions between running, paused, and stopped states.
   * Manages cache invalidation and sends appropriate events to VS Code.
   *
   * @param msg State message from the emulator
   */
  private async updateState(msg: EmulatorStateMessage) {
    const { state, message } = msg;
    logger.log(`State: ${state}, ${JSON.stringify(message)}`);
    if (state === "paused") {
      if (this.isRunning) {
        this.isRunning = false;
        const evt: DebugProtocol.StoppedEvent = new StoppedEvent(
          "pause",
          DebugAdapter.THREAD_ID,
        );
        // There's only ever one (real) thread here, and pausing genuinely
        // does stop it — but nvim-dap's own stopped-event handler treats
        // reason:"pause" specially: it skips the frame jump *and* the
        // resulting scopes/variables fetch entirely unless
        // allThreadsStopped is set (`should_jump = reason ~= 'pause' or
        // allThreadsStopped`, session.lua). handleStop()'s breakpoint path
        // and the fastLoad entry-stop already set this; this was the one
        // stop reason that didn't.
        evt.body.allThreadsStopped = true;
        await this.applyNoSourceReasonHint(evt);
        this.sendEvent(evt);
      }
    } else if (state === "running") {
      if (!this.isRunning) {
        this.isRunning = true;
        this.sendEvent(new ContinuedEvent(DebugAdapter.THREAD_ID));
      }
    } else if (state === "stopped") {
      if (this.stepping) {
        await this.handleStep();
      } else {
        this.handleStop(message);
      }
    }
  }

  /**
   * VS Code's built-in Variables/Disassembly panels only auto-select (and
   * therefore query, via scopesRequest/variablesRequest/disassembleRequest)
   * the top stack frame on a stop when that frame has no source IF
   * StoppedEvent.reason is "instruction breakpoint" — see
   * https://github.com/microsoft/vscode/pull/143649/files. Without this,
   * pausing or breaking with the PC outside user code (Kickstart ROM,
   * unmapped memory, ...) leaves both panels empty until the next step
   * happens to trigger this same override elsewhere.
   *
   * Overrides `evt`'s reason to "instruction breakpoint" when `pc` (or, if
   * omitted, the emulator's current PC) has no source-map coverage. No-op if
   * the reason is already "instruction breakpoint" (a real instruction
   * breakpoint already gets this reason) or the PC can't be determined.
   */
  private async applyNoSourceReasonHint(
    evt: DebugProtocol.StoppedEvent,
    pc?: number,
  ): Promise<void> {
    if (evt.body.reason === "instruction breakpoint") return;
    if (pc === undefined) {
      try {
        const cpuInfo = await this.emulator.getCpuInfo();
        pc = Number(cpuInfo.pc);
      } catch {
        return;
      }
    }
    if (!this.sourceMap?.lookupAddress(pc)) {
      evt.body.reason = "instruction breakpoint";
    }
  }

  /**
   * Handles completion of a step operation.
   *
   * Called when the emulator stops after a step-in operation.
   * Sets appropriate stop reason for disassembly view when no source is available.
   */
  private async handleStep() {
    // Special case for built-in stepIn function. No actual breakpoints used.
    this.isRunning = false;
    this.stepping = false;

    // Fetch PC once; reused for both the line-step loop check and the disassembly-view hint below.
    let pc: number | undefined;
    try {
      const cpuInfo = await this.emulator.getCpuInfo();
      pc = Number(cpuInfo.pc);
    } catch (error) {
      // If we can't get CPU info, still send the step event to avoid hanging the debugger
      console.warn(
        "Failed to get CPU info during step, defaulting to step reason:",
        error,
      );
    }

    // Line-granularity loop: keep stepping until the source line changes.
    if (this.lineStepStart && pc !== undefined) {
      const loc = this.sourceMap?.lookupAddress(pc);
      if (loc?.path === this.lineStepStart.path && loc?.line === this.lineStepStart.line) {
        // Still on the same source line — fire another step of the appropriate kind.
        if (this.lineStepStart.isOver) {
          await this.doInstructionStepOver();
        } else {
          this.stepping = true;
          this.isRunning = true;
          try {
            await this.emulator.stepInto();
          } catch (err) {
            // See stepInRequest's matching catch: a rejected stepInto() leaves `stepping`
            // stuck true with nothing else to reset it, misrouting the next unrelated stop.
            this.stepping = false;
            this.isRunning = false;
            throw err;
          }
        }
        return;
      }
      this.lineStepStart = null;
    }

    const evt = new StoppedEvent("step", DebugAdapter.THREAD_ID);

    // Don't need this for step with instruction granularity — VS Code already
    // selects a sourceless top frame fine for a plain "step" reason there.
    if (this.lastStepGranularity !== "instruction") {
      await this.applyNoSourceReasonHint(evt, pc);
    }

    this.sendEvent(evt);
  }

  /**
   * Handles emulator stop events (breakpoints, watchpoints, exceptions).
   *
   * Determines the reason for stopping and matches it to the appropriate
   * breakpoint type. Handles temporary breakpoints specially.
   *
   * @param message Stop message containing stop details
   */
  private async handleStop(message: StopMessage) {
    const evt: DebugProtocol.StoppedEvent = new StoppedEvent(
      "breakpoint",
      DebugAdapter.THREAD_ID,
    );
    evt.body.allThreadsStopped = true;

    this.isRunning = false;

    if (!this.breakpointManager) {
      this.lineStepStart = null;
      this.sendEvent(evt);
      return;
    }

    const result = await this.breakpointManager.handleBreakpointStop(message);

    // Line-granularity step-over: the JSR/BSR return temp BP fired ("step").
    // Check whether the source line has changed; if not, keep looping.
    if (result.reason === "step" && this.lineStepStart?.isOver) {
      let continueLoop = false;
      try {
        const cpuInfo = await this.emulator.getCpuInfo();
        const pc = Number(cpuInfo.pc);
        const loc = this.sourceMap?.lookupAddress(pc);

        continueLoop = loc?.path === this.lineStepStart.path && loc?.line === this.lineStepStart.line;
      } catch { /* fall through and stop */ }
      if (continueLoop) {
        await this.doInstructionStepOver();
        return;
      }
      // Line changed (or no source) — done with the step-over.
      this.lineStepStart = null;
      this.sendEvent(new StoppedEvent("step", DebugAdapter.THREAD_ID));
      return;
    }

    // Conditional breakpoints: evaluated here (rather than emulator-side)
    // since PUAE has no native condition support and fires every hit
    // regardless - same REPL expression syntax as the Debug Console.
    // A falsy result resumes silently, before any StoppedEvent reaches the
    // client, so the user never sees the emulator stop.
    if (result.hitBreakpointIds?.length === 1) {
      const hitId = result.hitBreakpointIds[0];
      const condition = this.breakpointManager.getCondition(hitId);
      if (condition) {
        let shouldStop = true;
        try {
          const { value } = await this.getEvaluateManager().evaluate(condition);
          shouldStop = Boolean(value);
        } catch (error) {
          this.sendEvent(
            new OutputEvent(`Breakpoint condition error: ${this.errorString(error)}\n`),
          );
        }
        if (!shouldStop) {
          this.lineStepStart = null;
          await this.emulator.run();
          return;
        }
      }

      // Hit-count (hitCondition): a no-op on backends where the emulator
      // already counts ignores natively (consumeIgnore only has an entry
      // to consume on backends like PUAE that don't - see
      // Emulator.supportsHitCounts). Checked after condition so a
      // condition-false hit never counts against the hit count, per DAP's
      // setBreakpoints semantics.
      if (this.breakpointManager.consumeIgnore(hitId)) {
        this.lineStepStart = null;
        await this.emulator.run();
        return;
      }

      // Logpoints: condition/hitCondition (above) have already passed, so
      // this hit "counts" - but a logMessage means never actually stopping.
      // Log to the Debug Console and resume immediately instead.
      const logMessage = this.breakpointManager.getLogMessage(hitId);
      if (logMessage !== undefined) {
        this.sendEvent(
          new OutputEvent(`${await this.formatLogMessage(logMessage)}\n`),
        );
        this.lineStepStart = null;
        await this.emulator.run();
        return;
      }
    }

    // Any other stop: clear line-step state.
    this.lineStepStart = null;

    evt.body.reason = result.reason;
    if (result.text) {
      evt.body.text = result.text;
      // StoppedEvent.body.text isn't reliably surfaced anywhere visible by
      // VS Code's built-in UI — also write it to the Debug Console, which
      // is guaranteed to show up, for cases like a DMA/Copper-sourced
      // watchpoint hit where the call stack alone would be misleading.
      this.sendEvent(new OutputEvent(`${result.text}\n`));
    }
    if (result.hitBreakpointIds) {
      evt.body.hitBreakpointIds = result.hitBreakpointIds;
    }

    if (result.reason === "exception") {
      try {
        // Get last instruction executed before exception
        // The current PC is the exception vector handler, so we need to step back one instruction
        // If the previous instruction is not in supervisor mode, we need to use the user stack for the next stack frame request
        const trace = await this.emulator.getCpuTrace(1);
        if (trace[0]) {
          const lastInst = trace[0];
          const isSupervisor = lastInst.flags.includes("S");
          const address = parseInt(lastInst.pc, 16);
          this.exceptionInstruction = { address, isSupervisor };
        }
      } catch (error) {
        console.warn("Failed to get CPU trace:", error);
      }
    }

    // For an exception stop, frame 0 is built from exceptionInstruction.address
    // (the faulting instruction, not the raw PC which sits inside the exception
    // vector handler) — see getStackFrames' use of it below. Check source there
    // instead of re-fetching the current (always-no-source, in-ROM-vector) PC.
    // Other reasons: let the helper fetch the (still-current) PC itself.
    await this.applyNoSourceReasonHint(
      evt,
      result.reason === "exception" ? this.exceptionInstruction?.address : undefined,
    );

    this.sendEvent(evt);
  }

  /**
   * Formats a DAP logpoint message: each `{expr}` run is evaluated with the
   * same REPL syntax as the Debug Console and substituted with its value.
   * An expression that fails to evaluate is replaced with an inline error
   * rather than aborting the whole message, so one bad `{...}` doesn't
   * silently swallow the rest of the log line.
   */
  private async formatLogMessage(message: string): Promise<string> {
    const evaluateManager = this.getEvaluateManager();
    let result = "";
    let lastIndex = 0;
    for (const match of message.matchAll(/\{([^}]*)\}/g)) {
      result += message.slice(lastIndex, match.index);
      try {
        const { value } = await evaluateManager.evaluate(match[1]);
        result += value === undefined ? "" : String(value);
      } catch (error) {
        result += `<${this.errorString(error)}>`;
      }
      lastIndex = match.index + match[0].length;
    }
    return result + message.slice(lastIndex);
  }

  /**
   * Converts an error to a string representation.
   *
   * @param err Error object or other value
   * @returns String representation, including stack trace if trace mode is enabled
   */
  private errorString(err: unknown): string {
    if (err instanceof Error) {
      return this.trace ? err.stack || err.message : err.message;
    }
    return String(err);
  }

  /**
   * Sends an error response back to VS Code.
   *
   * @param response The response object to populate with error information
   * @param errorId Categorized error code for the error type
   * @param message Human-readable error message
   * @param cause Optional underlying cause of the error
   */
  private sendError(
    response: DebugProtocol.Response,
    errorId: ErrorCode,
    message: string,
    cause?: unknown,
  ): void {
    const formattedCause = cause ? `: ${this.errorString(cause)}` : "";
    this.sendErrorResponse(response, {
      id: errorId,
      format: `${message}${formattedCause}`,
    });
  }

  public getStackManager(): StackManager {
    if (!this.stackManager) {
      throw new Error("Not initialized");
    }
    return this.stackManager;
  }

  public getBreakpointManager(): BreakpointManager {
    if (!this.breakpointManager) {
      throw new Error("Not initialized");
    }
    return this.breakpointManager;
  }

  public getVariablesManager(): VariablesManager {
    if (!this.variablesManager) {
      throw new Error("Not initialized");
    }
    return this.variablesManager;
  }

  public getDisassemblyManager(): DisassemblyManager {
    if (!this.disassemblyManager) {
      throw new Error("Not initialized");
    }
    return this.disassemblyManager;
  }

  public getEvaluateManager(): EvaluateManager {
    if (!this.evaluateManager) {
      throw new Error("Not initialized");
    }
    return this.evaluateManager;
  }

  public getSourceMap(): SourceMap {
    if (!this.sourceMap) {
      throw new Error("Not initialized");
    }
    return this.sourceMap;
  }

  /** Path to the file the debug symbols were read from (the ELF, or the program itself). */
  public getDebugProgramPath(): string {
    return this.debugProgramPath;
  }

  /** Relocation used to build the SourceMap, so a saved profile can rebuild an identical one. */
  public getRelocation(): { segmentOffsets: number[]; baseDir: string } {
    return { segmentOffsets: this.segmentOffsets, baseDir: this.sourceBaseDir };
  }

  /**
   * Kickstart ROM identity, so a saved profile can re-merge the `.kick` symbol module on load and
   * symbolicate ROM/OS leaves as [Kick] <name>. The empty sentinel means no ROM symbols were
   * resolved (unset/unknown ROM) — the loader then leaves ROM addresses as flat [Kickstart].
   */
  public getKickstartInfo(): { sha1: string; name: string } {
    return this.kickstartSymbols
      ? { sha1: this.kickstartSymbols.sha1, name: this.kickstartSymbols.name }
      : { sha1: "", name: "" };
  }
}
