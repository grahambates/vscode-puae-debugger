import * as vscode from "vscode";
import { DebugProtocol } from "@vscode/debugprotocol";
import { logger } from "@vscode/debugadapter";
import { CpuInfo, StopMessage } from "./vAmiga";
import { Emulator } from "./emulator";
import { SourceMap } from "./sourceMap";
import { formatHex } from "./numbers";
import { exceptionBreakpointFilters, MEMORY_PROTECTION_VECTOR } from "./hardware";
import { symbolDeclaredSize } from "./sourceParsing";

/**
 * Internal reference to a breakpoint set in the emulator.
 */
export interface BreakpointRef {
  /** Unique identifier for this breakpoint */
  id: number;
  /** Memory address where the breakpoint is set */
  address: number;
}

/**
 * Temporary breakpoint used for step operations.
 * These are not visible to the client and are automatically removed when hit.
 */
export interface TmpBreakpoint {
  /** Description of why this breakpoint was set (e.g., "step", "entry") */
  reason: string;
  /** Memory address where the temporary breakpoint is set */
  address: number;
}

/**
 * Result of handling a breakpoint stop event
 */
export interface BreakpointStopResult {
  reason: string;
  text?: string;
  hitBreakpointIds?: number[];
}

/**
 * Manages all types of breakpoints for the debug adapter.
 *
 * Handles different breakpoint types:
 * - Source breakpoints: Line-based breakpoints in source files
 * - Instruction breakpoints: Address-based breakpoints in disassembly
 * - Exception breakpoints: Break on specific CPU exceptions/interrupts
 * - Data breakpoints: Break on memory read/write access
 * - Function breakpoints: Break when entering named functions
 * - Temporary breakpoints: Internal breakpoints for stepping operations
 */
export class BreakpointManager {
  private sourceBreakpoints: Map<string, BreakpointRef[]> = new Map();
  private instructionBreakpoints: BreakpointRef[] = [];
  private exceptionBreakpoints: BreakpointRef[] = [];
  private dataBreakpoints: BreakpointRef[] = [];
  private functionBreakpoints: BreakpointRef[] = [];
  private tmpBreakpoints: TmpBreakpoint[] = [];
  private bpId = 0;

  /**
   * Creates a new BreakpointManager instance.
   *
   * @param vAmiga VAmiga instance for setting hardware breakpoints
   * @param sourceMap Source map for resolving source locations to addresses
   */
  constructor(
    private emulator: Emulator,
    private sourceMap: SourceMap,
  ) {}

  /**
   * Parses a hit condition and returns the number of times to ignore the breakpoint.
   * Currently supports numeric values, but can be extended to support expressions.
   *
   * @param hitCondition The hit condition string from the breakpoint
   * @returns Number of times to ignore the breakpoint (0 if invalid)
   */
  private parseHitCondition(hitCondition: string | undefined): number {
    if (!hitCondition) {
      return 0;
    }

    // For now, support numeric values only
    // TODO: Extend to support expressions when needed
    const ignores = Number(hitCondition) - 1;
    if (isNaN(ignores) || ignores < 0) {
      return 0;
    }
    return ignores;
  }

  /**
   * Derives a watched-region length for a symbol: a real DWARF type size
   * when available, otherwise inferred from the data-declaration
   * directive at the symbol's own source line (see
   * sourceParsing.ts's symbolDeclaredSize) — deliberately *not*
   * sourceMap.getSymbolLengths()'s inter-label distance, which is too
   * unreliable here (no end-label often means a wildly over-broad watch,
   * and two labels aliasing the same address give exactly 0). Falls back
   * to undefined — caller then watches a single address, same as before
   * this feature existed — whenever neither source gives a confident
   * answer.
   */
  private async resolveSymbolLength(
    name: string,
    address: number,
  ): Promise<number | undefined> {
    const dwarfSize = this.sourceMap
      .getGlobalVariables()
      .find((v) => v.name === name)?.byteSize;
    if (dwarfSize) {
      return dwarfSize;
    }

    const loc = this.sourceMap.lookupAddress(address);
    if (!loc) {
      return undefined;
    }

    try {
      const document = await vscode.workspace.openTextDocument(loc.path);
      const size = symbolDeclaredSize(document.lineAt(loc.line - 1).text);
      if (size !== undefined) {
        return size;
      }
      // A bare label line (directive on the next physical line) parses
      // with no mnemonic at all — check there too before giving up.
      if (loc.line < document.lineCount) {
        return symbolDeclaredSize(document.lineAt(loc.line).text);
      }
    } catch {
      // Source file not available — fall back to no length.
    }
    return undefined;
  }

  /**
   * Sets source breakpoints for a specific file
   */
  public async setSourceBreakpoints(
    path: string,
    breakpoints: DebugProtocol.SourceBreakpoint[],
  ): Promise<DebugProtocol.Breakpoint[]> {
    logger.log(`Set breakpoints request: ${path}`);

    // Remove existing breakpoints for source
    const existing = this.sourceBreakpoints.get(path);
    if (existing) {
      for (const ref of existing) {
        logger.log(
          `Breakpoint #${ref.id} removed at ${formatHex(ref.address)}`,
        );
        this.emulator.removeBreakpoint(ref.address);
      }
    }

    const refs: BreakpointRef[] = [];
    this.sourceBreakpoints.set(path, refs);
    const resultBreakpoints: DebugProtocol.Breakpoint[] = [];

    // Add new breakpoints
    for (const bp of breakpoints) {
      try {
        const location = this.sourceMap.lookupSourceLine(path, bp.line);
        const address = location.address;
        const instructionReference = formatHex(address);
        const id = this.bpId++;
        const ignores = this.parseHitCondition(bp.hitCondition);

        refs.push({ id, address });
        this.emulator.setBreakpoint(address, ignores);
        logger.log(
          `Breakpoint #${id} at ${path}:${bp.line} set at ${instructionReference}`,
        );

        resultBreakpoints.push({
          id,
          instructionReference,
          verified: true,
          line: bp.line,
          column: bp.column,
        });
      } catch (error) {
        logger.log(`Failed to set breakpoint at ${path}:${bp.line} - ${error}`);
        resultBreakpoints.push({
          id: this.bpId++,
          verified: false,
          line: bp.line,
          column: bp.column,
          message: `Cannot set breakpoint: ${error}`,
        });
      }
    }

    return resultBreakpoints;
  }

  /**
   * Sets instruction breakpoints at memory addresses
   */
  public async setInstructionBreakpoints(
    breakpoints: DebugProtocol.InstructionBreakpoint[],
  ): Promise<DebugProtocol.Breakpoint[]> {
    // Remove existing
    for (const ref of this.instructionBreakpoints) {
      logger.log(
        `Instruction breakpoint #${ref.id} removed at ${formatHex(ref.address)}`,
      );
      this.emulator.removeBreakpoint(ref.address);
    }
    this.instructionBreakpoints = [];

    const resultBreakpoints: DebugProtocol.Breakpoint[] = [];

    // Add new breakpoints
    for (const bp of breakpoints) {
      const address = Number(bp.instructionReference) + (bp.offset ?? 0);
      const id = this.bpId++;
      const ignores = this.parseHitCondition(bp.hitCondition);

      this.instructionBreakpoints.push({ id, address });
      this.emulator.setBreakpoint(address, ignores);
      logger.log(
        `Instruction breakpoint #${id} set at ${bp.instructionReference}`,
      );

      resultBreakpoints.push({
        id,
        verified: true,
        ...bp,
      });
    }

    return resultBreakpoints;
  }

  /**
   * Sets function breakpoints by symbol name
   */
  public setFunctionBreakpoints(
    breakpoints: DebugProtocol.FunctionBreakpoint[],
  ): DebugProtocol.Breakpoint[] {
    // Remove existing
    for (const ref of this.functionBreakpoints) {
      logger.log(
        `Function breakpoint #${ref.id} removed at ${formatHex(ref.address)}`,
      );
      this.emulator.removeBreakpoint(ref.address);
    }
    this.functionBreakpoints = [];

    const resultBreakpoints: DebugProtocol.Breakpoint[] = [];

    // Add new breakpoints
    for (const bp of breakpoints) {
      const id = this.bpId++;
      const address = this.sourceMap.getSymbols()?.[bp.name];

      if (address) {
        const ignores = this.parseHitCondition(bp.hitCondition);

        this.functionBreakpoints.push({ id, address });
        this.emulator.setBreakpoint(address, ignores);
        logger.log(
          `Function breakpoint #${id} set at ${formatHex(address)} for ${bp.name}`,
        );
      }

      resultBreakpoints.push({
        id,
        verified: Boolean(address),
        message: address ? undefined : `Symbol '${bp.name}' not found`,
        ...bp,
      });
    }

    return resultBreakpoints;
  }

  /**
   * Gets data breakpoint info for a variable
   */
  public getDataBreakpointInfo(
    scope: string,
    name: string,
  ):
    | {
        dataId: string | null;
        description: string;
        accessTypes: DebugProtocol.DataBreakpointAccessType[];
        canPersist: boolean;
      }
    | undefined {
    // Handle variables that have memory references
    if (scope === "registers" || scope === "symbols") {
      // For registers and symbols, we can create data breakpoints
      const dataId = `${scope}:${name}`;
      return {
        dataId,
        description: `Break on access to ${name}`,
        accessTypes: ["read", "write", "readWrite"],
        canPersist: false,
      };
    }
  }

  /**
   * Sets data breakpoints (watchpoints)
   */
  public async setDataBreakpoints(
    breakpoints: DebugProtocol.DataBreakpoint[],
  ): Promise<DebugProtocol.Breakpoint[]> {
    logger.log(`Set data breakpoints request`);

    // Remove existing data breakpoints
    for (const ref of this.dataBreakpoints) {
      logger.log(
        `Data breakpoint #${ref.id} removed at ${formatHex(ref.address)}`,
      );
      this.emulator.removeWatchpoint(ref.address);
    }
    this.dataBreakpoints = [];

    const resultBreakpoints: DebugProtocol.Breakpoint[] = [];

    // Add new data breakpoints
    for (const bp of breakpoints) {
      try {
        let address: number | undefined;
        // Symbols get a derived length (see resolveSymbolLength) so the
        // whole variable is watched, not just its first byte/word.
        // Registers resolve to whatever address their current value holds
        // (i.e. "break when the memory this pointer refers to changes") —
        // there's no associated type/size for that, so length stays at the
        // single-address default.
        let length: number | undefined;
        const parts = bp.dataId.split(":");

        if (parts.length === 2) {
          const [type, name] = parts;
          if (type === "registers") {
            const cpuInfo = await this.emulator.getCpuInfo();
            address = Number(cpuInfo[name as keyof CpuInfo]);
          } else if (type === "symbols") {
            const symbols = this.sourceMap.getSymbols();
            address = symbols?.[name];
            if (address !== undefined) {
              length = await this.resolveSymbolLength(name, address);
            }
          }
        }

        if (address !== undefined) {
          const id = this.bpId++;
          const accessType = bp.accessType || "readWrite";
          this.dataBreakpoints.push({ id, address });
          const ignores = this.parseHitCondition(bp.hitCondition);

          this.emulator.setWatchpoint(address, ignores, {
            read: accessType !== "write",
            write: accessType !== "read",
            length,
          });
          logger.log(
            `Data breakpoint #${id} set at ${formatHex(address)} (${accessType})` +
              (length ? `, length ${length}` : ""),
          );

          resultBreakpoints.push({
            id,
            verified: true,
          });
        } else {
          resultBreakpoints.push({
            id: this.bpId++,
            verified: false,
            message: "Invalid memory address for data breakpoint",
          });
        }
      } catch (error) {
        resultBreakpoints.push({
          id: this.bpId++,
          verified: false,
          message: `Error setting data breakpoint: ${error}`,
        });
      }
    }

    return resultBreakpoints;
  }

  /**
   * Sets exception breakpoints
   */
  public setExceptionBreakpoints(
    filters: string[],
  ): DebugProtocol.Breakpoint[] {
    for (const ref of this.exceptionBreakpoints) {
      if (ref.address === MEMORY_PROTECTION_VECTOR) {
        this.emulator.setMemoryProtectionEnabled(false);
      } else {
        this.emulator.removeCatchpoint(ref.address);
      }
    }
    this.exceptionBreakpoints = [];

    const breakpoints: DebugProtocol.Breakpoint[] = [];

    for (const filter of filters) {
      const id = this.bpId++;

      if (filter === "memoryProtection") {
        this.emulator.setMemoryProtectionEnabled(true);
        this.exceptionBreakpoints.push({
          id,
          address: MEMORY_PROTECTION_VECTOR,
        });
        breakpoints.push({ id, verified: true });
        continue;
      }

      const vector = Number(filter);
      this.emulator.setCatchpoint(vector);
      this.exceptionBreakpoints.push({ id, address: vector });
      breakpoints.push({ id, verified: true });
    }

    return breakpoints;
  }

  /**
   * Sets a temporary breakpoint at the specified address.
   *
   * Temporary breakpoints are used for step operations and are automatically
   * removed when hit. They are not visible to the client.
   *
   * @param address Memory address for the temporary breakpoint
   * @param reason Description of why the breakpoint was set (e.g., "step", "entry")
   */
  public setTmpBreakpoint(address: number, reason: string): void {
    const existing = this.findUserBreakpointAt(address);
    if (existing) {
      logger.log(`Breakpoint already exists at ${formatHex(address)}`);
      return;
    }
    logger.log(
      `Setting temporary breakpoint at ${formatHex(address)} (${reason})`,
    );
    this.tmpBreakpoints.push({ address, reason });
    this.emulator.setBreakpoint(address);
  }

  /**
   * Handles a breakpoint stop event from the emulator
   */
  public handleBreakpointStop(message: StopMessage): BreakpointStopResult {
    let bpMatch: BreakpointRef | undefined;

    if (message.name === "WATCHPOINT_REACHED") {
      const result: BreakpointStopResult = {
        reason: "data breakpoint",
      };
      bpMatch = this.dataBreakpoints.find(
        (bp) => bp.address === message.payload.pc,
      );
      if (bpMatch) {
        result.hitBreakpointIds = [bpMatch.id];
      }
      return result;
    }

    if (message.name === "MEMORY_PROTECTION_VIOLATION") {
      // source is PUAE-only (vAmiga's hooks only cover CPU writes) — when
      // absent, the write is necessarily from the CPU, so omit the
      // qualifier rather than print a misleading "(source=CPU)" for a
      // backend that can't tell the difference yet. For a DMA write, "pc"
      // is whatever the CPU happens to be running concurrently, not the
      // instruction that configured the blit (which ran earlier,
      // asynchronously) — labelled "concurrent pc" to avoid implying
      // otherwise.
      const isDma = message.payload.source === 1;
      const source = isDma
        ? " from the Blitter/disk DMA"
        : message.payload.source === 0
          ? " from the CPU"
          : "";
      const pcLabel = isDma ? "concurrent pc" : "pc";
      const result: BreakpointStopResult = {
        reason: "exception",
        text:
          `Write${source} to unallocated memory at ${formatHex(message.payload.addr ?? 0)}` +
          ` (${pcLabel}=${formatHex(message.payload.pc ?? 0)})`,
      };
      bpMatch = this.exceptionBreakpoints.find(
        (bp) => bp.address === MEMORY_PROTECTION_VECTOR,
      );
      if (bpMatch) {
        result.hitBreakpointIds = [bpMatch.id];
      }
      return result;
    }

    if (message.name === "CATCHPOINT_REACHED") {
      const result: BreakpointStopResult = {
        reason: "exception",
      };
      result.text = exceptionBreakpointFilters.find(
        (f) => Number(f.filter) === message.payload.vector,
      )?.label;
      bpMatch = this.exceptionBreakpoints.find(
        (bp) => bp.address === message.payload.vector,
      );
      if (bpMatch) {
        result.hitBreakpointIds = [bpMatch.id];
      }
      return result;
    }

    if (message.name === "BREAKPOINT_REACHED") {
      // First check tmp breakpoints
      const tmpMatch = this.tmpBreakpoints.find(
        (bp) => bp.address === message.payload.pc,
      );
      if (tmpMatch) {
        logger.log(
          `Matched tmp breakpoint at ${formatHex(message.payload.pc)}`,
        );
        this.tmpBreakpoints = this.tmpBreakpoints.filter(
          (bp) => bp.address !== message.payload.pc,
        );
        // If a user breakpoint also lives at this address (set after the tmp),
        // keep the hardware breakpoint and report the user's BP instead.
        const userBp = this.findUserBreakpointAt(tmpMatch.address);
        if (userBp) {
          const isInstruction = this.instructionBreakpoints.includes(userBp);
          return {
            reason: isInstruction ? "instruction breakpoint" : "breakpoint",
            hitBreakpointIds: [userBp.id],
          };
        }
        this.emulator.removeBreakpoint(tmpMatch.address);
        return {
          reason: tmpMatch.reason,
        };
      } else {
        // check instruction breakpoints
        bpMatch = this.instructionBreakpoints.find(
          (bp) => bp.address === message.payload.pc,
        );
        if (bpMatch) {
          return {
            reason: "instruction breakpoint",
            hitBreakpointIds: [bpMatch.id],
          };
        }

        // check function breakpoints
        bpMatch = this.functionBreakpoints.find(
          (bp) => bp.address === message.payload.pc,
        );
        if (bpMatch) {
          return {
            reason: "function breakpoint",
            hitBreakpointIds: [bpMatch.id],
          };
        }

        // check source breakpoints
        bpMatch = this.findSourceBreakpoint(message.payload.pc);
        if (bpMatch) {
          return {
            reason: "breakpoint",
            hitBreakpointIds: [bpMatch.id],
          };
        }
      }
    }

    // Default fallback
    return {
      reason: "breakpoint",
    };
  }

  /**
   * Gets temporary breakpoints (for testing/debugging)
   */
  public getTmpBreakpoints(): TmpBreakpoint[] {
    return [...this.tmpBreakpoints];
  }

  /**
   * Clears all breakpoints
   */
  public clearAll(): void {
    // Clear source breakpoints
    for (const refs of this.sourceBreakpoints.values()) {
      for (const ref of refs) {
        this.emulator.removeBreakpoint(ref.address);
      }
    }
    this.sourceBreakpoints.clear();

    // Clear instruction breakpoints
    for (const ref of this.instructionBreakpoints) {
      this.emulator.removeBreakpoint(ref.address);
    }
    this.instructionBreakpoints = [];

    // Clear function breakpoints
    for (const ref of this.functionBreakpoints) {
      this.emulator.removeBreakpoint(ref.address);
    }
    this.functionBreakpoints = [];

    // Clear data breakpoints
    for (const ref of this.dataBreakpoints) {
      this.emulator.removeWatchpoint(ref.address);
    }
    this.dataBreakpoints = [];

    // Clear exception breakpoints
    for (const ref of this.exceptionBreakpoints) {
      this.emulator.removeCatchpoint(ref.address);
    }
    this.exceptionBreakpoints = [];

    // Clear temporary breakpoints
    for (const tmp of this.tmpBreakpoints) {
      this.emulator.removeBreakpoint(tmp.address);
    }
    this.tmpBreakpoints = [];
  }

  /**
   * Finds a source breakpoint at the specified address.
   */
  private findSourceBreakpoint(address: number): BreakpointRef | undefined {
    for (const bps of this.sourceBreakpoints.values()) {
      const bpMatch = bps.find((bp) => bp.address === address);
      if (bpMatch) {
        return bpMatch;
      }
    }
    return undefined;
  }

  /**
   * Returns the first user-set breakpoint (source, instruction, or function)
   * at the given address, or undefined if none exists.
   */
  private findUserBreakpointAt(address: number): BreakpointRef | undefined {
    return (
      this.findSourceBreakpoint(address) ??
      this.instructionBreakpoints.find((bp) => bp.address === address) ??
      this.functionBreakpoints.find((bp) => bp.address === address)
    );
  }
}
