import { basename } from "path";
import * as vscode from "vscode";
import { DebugProtocol } from "@vscode/debugprotocol";
import { logger } from "@vscode/debugadapter";
import { StopMessage } from "./emulatorProtocol";
import { Emulator } from "./emulator";
import { SourceMap } from "./sourceMap";
import { formatHex } from "./numbers";
import {
  customAddresses,
  exceptionBreakpointFilters,
  isCustomRegisterAddress,
  MEMORY_PROTECTION_VECTOR,
} from "./hardware";
import { symbolDeclaredSize } from "./sourceParsing";

/**
 * Internal reference to a breakpoint set in the emulator.
 */
export interface BreakpointRef {
  /** Unique identifier for this breakpoint */
  id: number;
  /** Memory address where the breakpoint is set */
  address: number;
  /** Conditional breakpoint expression (REPL syntax), evaluated on hit */
  condition?: string;
  /**
   * Logpoint message (source breakpoints only - DAP doesn't define this
   * field for instruction/function breakpoints). When set, a hit never
   * stops execution: the message is logged (with `{expr}` runs evaluated
   * via the REPL syntax) and the emulator resumes immediately.
   */
  logMessage?: string;
}

/**
 * Internal reference to an active data breakpoint, with enough state to
 * recreate its underlying watchpoint(s) when its length override changes
 * without waiting for the next full setDataBreakpoints resync.
 *
 * Usually a single address (symbols, registers-as-pointer), but custom
 * chipset registers can need two: several have a read side and a write
 * side at *different* physical addresses, merged into one DAP variable
 * name (e.g. DMACON's write address is $DFF096; its read counterpart is
 * $DFF002) — "readWrite"/access on one of those arms a watchpoint at each.
 */
interface DataBreakpointRef {
  id: number;
  addresses: number[];
  /** The "scope:name" dataId this breakpoint was created from, e.g. "symbols:Frame". */
  dataId: string;
  accessType: DebugProtocol.DataBreakpointAccessType;
  ignores: number;
  /** Conditional breakpoint expression (REPL syntax), evaluated on hit */
  condition?: string;
}

/**
 * Internal reference to an active register watch (break when a register's
 * own value changes — see Emulator.setRegisterWatch). Data/address
 * registers only; matches UAE's regs.regs[] layout.
 */
interface RegisterWatchRef {
  id: number;
  regIndex: number;
  dataId: string;
  /** Conditional breakpoint expression (REPL syntax), evaluated on hit */
  condition?: string;
}

const REGISTER_WATCH_INDEX: Record<string, number> = {
  d0: 0, d1: 1, d2: 2, d3: 3, d4: 4, d5: 5, d6: 6, d7: 7,
  a0: 8, a1: 9, a2: 10, a3: 11, a4: 12, a5: 13, a6: 14, a7: 15,
};
const REGISTER_WATCH_NAME: string[] = Object.entries(REGISTER_WATCH_INDEX).reduce(
  (names, [name, index]) => {
    names[index] = name.toUpperCase();
    return names;
  },
  [] as string[],
);

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
  private dataBreakpoints: DataBreakpointRef[] = [];
  private registerWatchpoints: RegisterWatchRef[] = [];
  private functionBreakpoints: BreakpointRef[] = [];
  private tmpBreakpoints: TmpBreakpoint[] = [];
  private bpId = 0;
  // Manual watchpoint-length overrides, keyed by dataId ("scope:name"), set
  // via the "Set Watchpoint Length..." variable context-menu command —
  // takes precedence over the auto-derived length (resolveSymbolLength).
  // Lives independently of any specific breakpoint instance so it survives
  // setDataBreakpoints' full remove-and-recreate cycle, and can be set
  // before a watchpoint exists yet.
  private lengthOverrides = new Map<string, number>();
  // Remaining ignore counts for backends where the emulator itself doesn't
  // honor `ignores` (see Emulator.supportsHitCounts, e.g. PUAE) - keyed by
  // breakpoint id, populated only for breakpoints with a hitCondition on
  // such a backend. Checked/decremented by consumeIgnore() on every hit;
  // never populated (so always a no-op) when the backend counts natively.
  private hitCounters = new Map<number, number>();

  /**
   * Creates a new BreakpointManager instance.
   *
   * @param emulator Emulator instance for setting hardware breakpoints
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
   * Arms a hit count for breakpoint `id`: on backends that count natively
   * (Emulator.supportsHitCounts), returns `ignores` unchanged for the
   * caller to pass straight to the emulator. On backends that don't (PUAE
   * fires on every hit), instead stashes it in `hitCounters` for
   * consumeIgnore() to decrement at stop time, and returns 0 so the
   * emulator doesn't see a count it would otherwise ignore-and-warn-about.
   */
  private armHitCount(id: number, ignores: number): number {
    if (ignores <= 0) return 0;
    if (this.emulator.supportsHitCounts) return ignores;
    this.hitCounters.set(id, ignores);
    return 0;
  }

  /**
   * Called once per matched hit (from handleStop, after any `condition` has
   * already evaluated true) for breakpoint `id`. Returns true if this hit
   * should be silently ignored (TS-emulated hit count not yet exhausted),
   * decrementing the remaining count; returns false (every time, including
   * for ids with no entry) once it's time to actually stop.
   */
  public consumeIgnore(id: number): boolean {
    const remaining = this.hitCounters.get(id);
    if (!remaining) return false;
    this.hitCounters.set(id, remaining - 1);
    return true;
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
        await this.emulator.removeBreakpoint(ref.address);
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

        refs.push({ id, address, condition: bp.condition, logMessage: bp.logMessage });
        await this.emulator.setBreakpoint(address, this.armHitCount(id, ignores));
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
      await this.emulator.removeBreakpoint(ref.address);
    }
    this.instructionBreakpoints = [];

    const resultBreakpoints: DebugProtocol.Breakpoint[] = [];

    // Add new breakpoints
    for (const bp of breakpoints) {
      const address = Number(bp.instructionReference) + (bp.offset ?? 0);
      const id = this.bpId++;
      const ignores = this.parseHitCondition(bp.hitCondition);

      this.instructionBreakpoints.push({ id, address, condition: bp.condition });
      await this.emulator.setBreakpoint(address, this.armHitCount(id, ignores));
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
  public async setFunctionBreakpoints(
    breakpoints: DebugProtocol.FunctionBreakpoint[],
  ): Promise<DebugProtocol.Breakpoint[]> {
    // Remove existing
    for (const ref of this.functionBreakpoints) {
      logger.log(
        `Function breakpoint #${ref.id} removed at ${formatHex(ref.address)}`,
      );
      await this.emulator.removeBreakpoint(ref.address);
    }
    this.functionBreakpoints = [];

    const resultBreakpoints: DebugProtocol.Breakpoint[] = [];

    // Add new breakpoints
    for (const bp of breakpoints) {
      const id = this.bpId++;
      const address = this.sourceMap.getSymbols()?.[bp.name];

      if (address) {
        const ignores = this.parseHitCondition(bp.hitCondition);

        this.functionBreakpoints.push({ id, address, condition: bp.condition });
        await this.emulator.setBreakpoint(address, this.armHitCount(id, ignores));
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
    // Registers: break when the register's own value changes. Only data/
    // address registers are supported — there's no hook point for "register
    // read", so unlike symbols, only "write" (i.e. "changed") makes sense.
    // PC/SR/USP/etc. aren't in REGISTER_WATCH_INDEX, so they fall through
    // to "not supported" below, same as any other unrecognized variable.
    if (scope === "registers" && name in REGISTER_WATCH_INDEX) {
      return {
        dataId: `${scope}:${name}`,
        description: `Break when ${name.toUpperCase()} changes`,
        accessTypes: ["write"],
        canPersist: false,
      };
    }
    if (scope === "symbols") {
      const dataId = `${scope}:${name}`;
      return {
        dataId,
        description: `Break on access to ${name}`,
        accessTypes: ["read", "write", "readWrite"],
        canPersist: false,
      };
    }
    // Custom (chipset) registers: offer only the access types that are
    // actually meaningful for this specific register — several have a
    // read side and write side at different physical addresses merged
    // into one variable name (see customAddresses' doc comment), and a
    // purely write-only or read-only register shouldn't offer the
    // direction it doesn't have.
    if (scope === "custom") {
      const custom = customAddresses[name];
      if (custom) {
        const accessTypes: DebugProtocol.DataBreakpointAccessType[] = [];
        if (custom.readAddress !== undefined) accessTypes.push("read");
        if (custom.writeAddress !== undefined) accessTypes.push("write");
        if (accessTypes.length === 2) accessTypes.push("readWrite");
        return {
          dataId: `${scope}:${name}`,
          description: `Break on access to ${name}`,
          accessTypes,
          canPersist: false,
        };
      }
    }
    // Exception vector table entries: nothing special about these vs. any
    // other memory address — variablesManager.ts's vectorVariables()
    // names each one "NN: NAME" (NN = hex byte offset from VBR), so the
    // offset is parsed back out of that rather than re-deriving it from a
    // separate lookup table.
    if (scope === "vectors") {
      const offset = parseInt(name.split(":")[0], 16);
      if (!Number.isNaN(offset)) {
        return {
          dataId: `${scope}:${offset}`,
          description: `Break on access to ${name}`,
          accessTypes: ["read", "write", "readWrite"],
          canPersist: false,
        };
      }
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
        `Data breakpoint #${ref.id} removed at ${ref.addresses.map(formatHex).join(", ")}`,
      );
      for (const address of ref.addresses) {
        await this.emulator.removeWatchpoint(address);
      }
    }
    this.dataBreakpoints = [];
    for (const ref of this.registerWatchpoints) {
      logger.log(`Register watch #${ref.id} removed (reg index ${ref.regIndex})`);
      await this.emulator.removeRegisterWatch(ref.regIndex);
    }
    this.registerWatchpoints = [];

    const resultBreakpoints: DebugProtocol.Breakpoint[] = [];

    // Add new data breakpoints
    for (const bp of breakpoints) {
      try {
        const parts = bp.dataId.split(":");

        // Registers: a fundamentally different mechanism (break when the
        // register's own value changes, not when memory it points to
        // changes — see Emulator.setRegisterWatch) with no address/length
        // concept, so it's handled as its own path rather than forced
        // through the address-based logic below.
        if (parts.length === 2 && parts[0] === "registers") {
          const regIndex = REGISTER_WATCH_INDEX[parts[1]];
          if (regIndex === undefined) {
            resultBreakpoints.push({
              id: this.bpId++,
              verified: false,
              message: "Register watches are only supported for data/address registers",
            });
            continue;
          }
          const id = this.bpId++;
          // setRegisterWatch has no native ignores concept on either
          // backend (it's PUAE-only and the wasm call takes no count) -
          // hit counting for it is always TS-side.
          const ignores = this.parseHitCondition(bp.hitCondition);
          if (ignores > 0) this.hitCounters.set(id, ignores);
          this.registerWatchpoints.push({ id, regIndex, dataId: bp.dataId, condition: bp.condition });
          await this.emulator.setRegisterWatch(regIndex);
          logger.log(`Register watch #${id} set on ${parts[1]} (index ${regIndex})`);
          resultBreakpoints.push({ id, verified: true });
          continue;
        }

        // Custom (chipset) registers: a single DAP variable can need up
        // to two underlying watchpoints, since several merge a read
        // address and a write address (different physical locations)
        // into one name — see customAddresses' doc comment. "write"/
        // "read" arm just the relevant one; "readWrite" (or no
        // accessType) arms whichever of the two actually exist.
        if (parts.length === 2 && parts[0] === "custom") {
          const custom = customAddresses[parts[1]];
          const accessType = bp.accessType || "readWrite";
          const plans: { addr: number; read: boolean; write: boolean }[] = [];
          if (custom) {
            if (accessType !== "read" && custom.writeAddress !== undefined) {
              plans.push({ addr: custom.writeAddress, read: false, write: true });
            }
            if (accessType !== "write" && custom.readAddress !== undefined) {
              plans.push({ addr: custom.readAddress, read: true, write: false });
            }
          }
          if (plans.length === 0) {
            resultBreakpoints.push({
              id: this.bpId++,
              verified: false,
              message: "Unknown or unsupported custom register",
            });
            continue;
          }
          const id = this.bpId++;
          const ignores = this.parseHitCondition(bp.hitCondition);
          const nativeIgnores = this.armHitCount(id, ignores);
          const length = custom!.long ? 4 : 2;
          for (const plan of plans) {
            await this.emulator.setWatchpoint(plan.addr, nativeIgnores, {
              read: plan.read,
              write: plan.write,
              length,
            });
          }
          this.dataBreakpoints.push({
            id,
            addresses: plans.map((p) => p.addr),
            dataId: bp.dataId,
            accessType,
            ignores,
            condition: bp.condition,
          });
          logger.log(
            `Data breakpoint #${id} set on ${parts[1]} (${accessType}) at ` +
              plans.map((p) => formatHex(p.addr)).join(", "),
          );
          resultBreakpoints.push({ id, verified: true });
          continue;
        }

        let address: number | undefined;
        // Symbols get a derived length (see resolveSymbolLength) so the
        // whole variable is watched, not just its first byte/word.
        let length: number | undefined;

        if (parts.length === 2 && parts[0] === "symbols") {
          const [, name] = parts;
          const symbols = this.sourceMap.getSymbols();
          address = symbols?.[name];
          if (address !== undefined) {
            length = await this.resolveSymbolLength(name, address);
          }
        } else if (parts.length === 2 && parts[0] === "vectors") {
          // Vector table entries are just memory addresses (VBR + a fixed
          // byte offset, per the offset encoded in getDataBreakpointInfo)
          // — nothing to guess: every entry is a 4-byte address.
          const offset = Number(parts[1]);
          const cpuInfo = await this.emulator.getCpuInfo();
          address = Number(cpuInfo.vbr) + offset;
          length = 4;
        }
        // A manual override (set via "Set Watchpoint Length...") always
        // wins over the auto-derived guess.
        length = this.lengthOverrides.get(bp.dataId) ?? length;

        if (address !== undefined) {
          const id = this.bpId++;
          const accessType = bp.accessType || "readWrite";
          const ignores = this.parseHitCondition(bp.hitCondition);
          this.dataBreakpoints.push({
            id,
            addresses: [address],
            dataId: bp.dataId,
            accessType,
            ignores,
            condition: bp.condition,
          });

          await this.emulator.setWatchpoint(address, this.armHitCount(id, ignores), {
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
   * Reports the current manual override (if any) and the auto-derived
   * guess for the given "scope:name" dataId, so the "Set Watchpoint
   * Length..." command can pre-fill its input with whichever is currently
   * in effect rather than starting blank. Registers have no static size
   * info, so `auto` is only ever populated for symbols.
   */
  public async getWatchpointLengthInfo(
    dataId: string,
  ): Promise<{ override?: number; auto?: number }> {
    const override = this.lengthOverrides.get(dataId);
    const parts = dataId.split(":");
    let auto: number | undefined;
    if (parts.length === 2 && parts[0] === "symbols") {
      const name = parts[1];
      const address = this.sourceMap.getSymbols()?.[name];
      if (address !== undefined) {
        auto = await this.resolveSymbolLength(name, address);
      }
    }
    return { override, auto };
  }

  /**
   * Sets (or clears, if `length` is undefined) a manual watchpoint-length
   * override for the given "scope:name" dataId, used by the
   * "Set Watchpoint Length..." variable context-menu command. Takes effect
   * immediately if a data breakpoint for this dataId is currently active —
   * otherwise it's picked up the next time setDataBreakpoints creates one.
   */
  public async setWatchpointLengthOverride(dataId: string, length: number | undefined): Promise<void> {
    if (length === undefined) {
      this.lengthOverrides.delete(dataId);
    } else {
      this.lengthOverrides.set(dataId, length);
    }

    const ref = this.dataBreakpoints.find((bp) => bp.dataId === dataId);
    if (!ref) return;

    // Only reachable for symbols today (the "Set Watchpoint Length..."
    // command is restricted to the Symbols scope — custom registers have
    // a fixed, known length and registers-as-pointer have no length
    // concept at all), so this is always a single address in practice,
    // but loop generically rather than assuming.
    for (const address of ref.addresses) {
      await this.emulator.removeWatchpoint(address);
      await this.emulator.setWatchpoint(address, this.armHitCount(ref.id, ref.ignores), {
        read: ref.accessType !== "write",
        write: ref.accessType !== "read",
        length,
      });
    }
    logger.log(
      `Data breakpoint #${ref.id} at ${ref.addresses.map(formatHex).join(", ")} length override: ${length ?? "auto"}`,
    );
  }

  /**
   * Sets exception breakpoints
   */
  public async setExceptionBreakpoints(
    filters: string[],
  ): Promise<DebugProtocol.Breakpoint[]> {
    for (const ref of this.exceptionBreakpoints) {
      if (ref.address === MEMORY_PROTECTION_VECTOR) {
        await this.emulator.setMemoryProtectionEnabled(false);
      } else {
        await this.emulator.removeCatchpoint(ref.address);
      }
    }
    this.exceptionBreakpoints = [];

    const breakpoints: DebugProtocol.Breakpoint[] = [];

    for (const filter of filters) {
      const id = this.bpId++;

      if (filter === "memoryProtection") {
        await this.emulator.setMemoryProtectionEnabled(true);
        this.exceptionBreakpoints.push({
          id,
          address: MEMORY_PROTECTION_VECTOR,
        });
        breakpoints.push({ id, verified: true });
        continue;
      }

      const vector = Number(filter);
      await this.emulator.setCatchpoint(vector);
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
  public async setTmpBreakpoint(address: number, reason: string): Promise<void> {
    const existing = this.findUserBreakpointAt(address);
    if (existing) {
      logger.log(`Breakpoint already exists at ${formatHex(address)}`);
      return;
    }
    logger.log(
      `Setting temporary breakpoint at ${formatHex(address)} (${reason})`,
    );
    this.tmpBreakpoints.push({ address, reason });
    await this.emulator.setBreakpoint(address);
  }

  /**
   * Handles a breakpoint stop event from the emulator
   */
  public async handleBreakpointStop(message: StopMessage): Promise<BreakpointStopResult> {
    let bpMatch: { id: number } | undefined;

    if (message.name === "WATCHPOINT_REACHED") {
      // source is PUAE-only (emulator doesn't track it for watchpoints) — when
      // absent, omit the qualifier rather than print a misleading
      // "(source=CPU)" for a backend that can't tell the difference.
      // Custom chipset registers and chip RAM each have a distinct, fixed
      // set of possible non-CPU writers — registers can only ever be
      // written by the Copper (Blitter/disk DMA target chip RAM, not
      // registers), so a DMA-sourced hit there is unambiguous. For either,
      // the CPU is just whatever it happens to be running concurrently
      // when a non-CPU source hits, not the thing that configured the
      // access (which ran earlier, asynchronously) — labelled
      // "concurrent pc" so the call stack/disassembly the user lands on
      // isn't mistaken for the actual cause.
      const isDma = message.payload.source === 1;
      const isCopper = isDma && isCustomRegisterAddress(message.payload.pc);
      const dmaSource = isCopper ? "the Copper" : "the Blitter/disk DMA";
      const source = isDma
        ? ` from ${dmaSource}`
        : message.payload.source === 0
          ? " from the CPU"
          : "";
      // copperPc, when present, is the actual Copper list address that wrote
      // the register — unlike cpuPc/"concurrent pc" (whatever the CPU
      // happens to be running at the same time), this is the real cause, so
      // it gets its own unqualified "pc=" label plus a source-line if one
      // resolves.
      const copperPc = isCopper ? message.payload.copperPc : undefined;
      const copperLoc =
        copperPc !== undefined ? this.sourceMap.lookupAddress(copperPc) : undefined;
      const copperLabel =
        copperPc !== undefined
          ? ` (copperLoc=${formatHex(copperPc)}${
              copperLoc ? ` ${basename(copperLoc.path)}:${copperLoc.line}` : ""
            })`
          : "";
      const pcLabel = isDma ? "concurrent pc" : "pc";
      const result: BreakpointStopResult = {
        reason: "data breakpoint",
        text: source
          ? `Data breakpoint hit${source} (${pcLabel}=${formatHex(message.payload.cpuPc ?? 0)})${copperLabel}`
          : undefined,
      };
      bpMatch = this.dataBreakpoints.find((bp) =>
        bp.addresses.includes(message.payload.pc),
      );
      if (bpMatch) {
        result.hitBreakpointIds = [bpMatch.id];
      }
      return result;
    }

    if (message.name === "REGISTER_WATCHPOINT_REACHED") {
      const regIndex = message.payload.regIndex ?? -1;
      const regName = REGISTER_WATCH_NAME[regIndex] ?? `reg${regIndex}`;
      const result: BreakpointStopResult = {
        reason: "data breakpoint",
        text:
          `${regName} changed from ${formatHex(message.payload.oldValue ?? 0)}` +
          ` to ${formatHex(message.payload.newValue ?? 0)}`,
      };
      bpMatch = this.registerWatchpoints.find((bp) => bp.regIndex === regIndex);
      if (bpMatch) {
        result.hitBreakpointIds = [bpMatch.id];
      }
      return result;
    }

    if (message.name === "MEMORY_PROTECTION_VIOLATION") {
      // source is PUAE-only (emulator's hooks only cover CPU writes) — when
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
        await this.emulator.removeBreakpoint(tmpMatch.address);
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
   * Returns the conditional-breakpoint expression (REPL evaluation syntax)
   * for the given breakpoint id, if one was set - searched across every
   * breakpoint kind that carries a `condition` field (source, instruction,
   * function, data, and register watches). Temporary/step breakpoints
   * never have one.
   */
  public getCondition(id: number): string | undefined {
    for (const refs of this.sourceBreakpoints.values()) {
      const ref = refs.find((bp) => bp.id === id);
      if (ref) return ref.condition;
    }
    return (
      this.instructionBreakpoints.find((bp) => bp.id === id)?.condition ??
      this.functionBreakpoints.find((bp) => bp.id === id)?.condition ??
      this.dataBreakpoints.find((bp) => bp.id === id)?.condition ??
      this.registerWatchpoints.find((bp) => bp.id === id)?.condition
    );
  }

  /**
   * Returns the logpoint message for the given breakpoint id, if one was
   * set - source breakpoints only, per DAP (`SourceBreakpoint.logMessage`
   * has no equivalent on instruction/function/data breakpoints).
   */
  public getLogMessage(id: number): string | undefined {
    for (const refs of this.sourceBreakpoints.values()) {
      const ref = refs.find((bp) => bp.id === id);
      if (ref) return ref.logMessage;
    }
    return undefined;
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
  public async clearAll(): Promise<void> {
    // Clear source breakpoints
    for (const refs of this.sourceBreakpoints.values()) {
      for (const ref of refs) {
        await this.emulator.removeBreakpoint(ref.address);
      }
    }
    this.sourceBreakpoints.clear();

    // Clear instruction breakpoints
    for (const ref of this.instructionBreakpoints) {
      await this.emulator.removeBreakpoint(ref.address);
    }
    this.instructionBreakpoints = [];

    // Clear function breakpoints
    for (const ref of this.functionBreakpoints) {
      await this.emulator.removeBreakpoint(ref.address);
    }
    this.functionBreakpoints = [];

    // Clear data breakpoints
    for (const ref of this.dataBreakpoints) {
      for (const address of ref.addresses) {
        await this.emulator.removeWatchpoint(address);
      }
    }
    this.dataBreakpoints = [];

    // Clear register watches
    for (const ref of this.registerWatchpoints) {
      await this.emulator.removeRegisterWatch(ref.regIndex);
    }
    this.registerWatchpoints = [];

    // Clear exception breakpoints
    for (const ref of this.exceptionBreakpoints) {
      await this.emulator.removeCatchpoint(ref.address);
    }
    this.exceptionBreakpoints = [];

    // Clear temporary breakpoints
    for (const tmp of this.tmpBreakpoints) {
      await this.emulator.removeBreakpoint(tmp.address);
    }
    this.tmpBreakpoints = [];

    this.hitCounters.clear();
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
