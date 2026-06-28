import * as vscode from "vscode";
import {
  CpuInfo,
  CpuTraceItem,
  CustomRegisters,
  Disassembly,
  EmulatorMessage,
  MemoryInfo,
  RegisterSetStatus,
} from "./vAmiga";
import { SourceMap } from "./sourceMap";

/**
 * Access-type filter and watched-region length for setWatchpoint. `length`
 * is rounded up to the next power of 2 by the backend (PUAE's
 * addr_mask_operand is a bitmask comparison, so it can only express
 * power-of-2-aligned ranges) — the effective watched region is
 * [address rounded down to that boundary, + the rounded-up size), which
 * may start slightly before `address` rather than exactly at it.
 */
export interface WatchpointOptions {
  /** Break on reads. Default true. */
  read?: boolean;
  /** Break on writes. Default true. */
  write?: boolean;
  /** Bytes to watch, rounded up to the next power of 2. Default 1. */
  length?: number;
}

/**
 * Generic interface for an Amiga 68k emulator backend running in a VS Code
 * webview. `VAmiga` is the current implementation; a future PUAE/ami9000
 * backend would also implement this interface.
 */
export interface Emulator {
  // --- Lifecycle ---

  /**
   * Opens the emulator webview panel
   */
  open(options?: Record<string, unknown>): void;

  /**
   * Brings the emulator webview panel to the foreground
   */
  reveal(): void;

  /**
   * Registers a listener for emulator messages
   * @param callback Function to call when messages are received
   * @returns Disposable to unregister the listener
   */
  onDidReceiveMessage(
    callback: (message: EmulatorMessage) => void,
  ): vscode.Disposable;

  onDidDispose(callback: () => void): vscode.Disposable | undefined;

  dispose(): void;

  /**
   * Gives the backend the session's active SourceMap, so it can symbolize
   * addresses for itself on webview request (e.g. PuaeEmulator's
   * copper-overlay hover tooltip resolving a copper-list address to
   * file:line — see WebviewEmulator's `symbolizeAddress` message handling).
   * Called once the debug session has built/loaded its SourceMap;
   * `undefined` clears it.
   */
  setSourceMap(sourceMap: SourceMap | undefined): void;

  // --- Execution control ---

  /**
   * Pause the emulator
   */
  pause(): void;

  /**
   * Resume running the emulator
   */
  run(): void;

  /**
   * Stop on next executed instruction
   */
  stepInto(): void;

  /**
   * Restore previous stopped state
   */
  stepBack(): Promise<boolean>;

  /**
   * Continue stepping back until breakpoint, or start of history
   */
  continueReverse(): Promise<boolean>;

  /**
   * Step back to the start of the current frame (previous vblank boundary).
   * PUAE-only; backends without checkpoint history resolve to false.
   */
  stepBackFrame(): Promise<boolean>;

  /**
   * Run to end of frame
   */
  eof(): void;

  /**
   * Run to end of line
   */
  eol(): void;

  // --- Breakpoints, watchpoints, catchpoints ---

  /**
   * True if this backend's `ignores` counts (passed to setBreakpoint/
   * setWatchpoint/setCatchpoint) are honored natively by the emulator
   * itself. False means the emulator fires on every hit regardless of
   * `ignores` - callers (BreakpointManager) emulate hit counting in TS
   * instead, on top of `condition` evaluation.
   */
  readonly supportsHitCounts: boolean;

  /**
   * Sets a breakpoint at the specified memory address
   * @param address Memory address for the breakpoint
   * @param ignores Number of times to ignore the breakpoint before stopping
   */
  setBreakpoint(address: number, ignores?: number): void;

  /**
   * Removes a breakpoint at the specified memory address
   * @param address Memory address of the breakpoint to remove
   */
  removeBreakpoint(address: number): void;

  /**
   * Sets a watchpoint at the specified memory address
   * @param address Memory address for the watchpoint
   * @param ignores Number of times to ignore the watchpoint before stopping
   * @param options Access-type filter and watched-region length. PUAE-only
   * for now — vamiga_rpc.js's "setWatchpoint" handler doesn't look at these
   * fields, so vAmiga always watches a single address for both read and
   * write regardless of what's passed here.
   */
  setWatchpoint(
    address: number,
    ignores?: number,
    options?: WatchpointOptions,
  ): void;

  /**
   * Removes a watchpoint at the specified memory address
   * @param address Memory address of the watchpoint to remove
   */
  removeWatchpoint(address: number): void;

  /**
   * Sets a register watch: break when the register's own value changes
   * (as opposed to setWatchpoint, which watches the memory a register's
   * *value* happens to point at). Data/address registers only (D0-D7 =
   * index 0-7, A0-A7 = index 8-15) — there's no hardware/hook equivalent
   * of a memory access function for registers, so this works by diffing
   * the register's value once per retired instruction, which also means
   * no read/write distinction (only "changed" is observable this way).
   * PUAE-only for now — vAmiga has no backend implementation yet, so this
   * is a no-op there.
   */
  setRegisterWatch(regIndex: number): void;

  /**
   * Removes a register watch set via setRegisterWatch.
   * @param regIndex D0-D7 = 0-7, A0-A7 = 8-15
   */
  removeRegisterWatch(regIndex: number): void;

  /**
   * Clears all watchpoints and register watches, in the engine itself —
   * not just BreakpointManager's own bookkeeping. Needed before loading a
   * program into a webview that may be reused from a previous debug
   * session: BreakpointManager starts fresh each session and has no record
   * of what an earlier session armed, so without this a stale watch from
   * before stays live and keeps firing even though it's no longer listed
   * anywhere.
   */
  resetWatchpoints(): void;

  /**
   * Sets a catchpoint for the specified exception vector
   * @param vector Exception vector number (e.g. 2 for bus error)
   * @param ignores Number of times to ignore the exception before stopping
   */
  setCatchpoint(vector: number, ignores?: number): void;

  /**
   * Removes a catchpoint for the specified exception vector
   * @param vector Exception vector number to remove
   */
  removeCatchpoint(vector: number): void;

  // --- Memory protection ---

  /**
   * Enables/disables breaking on writes to RAM outside the allow-list of
   * ranges set via addMemoryProtectionRange (excluding the low-memory
   * vector table, which is always allowed).
   */
  setMemoryProtectionEnabled(enabled: boolean): void;

  /** Clears the memory protection allow-list. */
  resetMemoryProtectionRanges(): void;

  /** Adds a range to the memory protection allow-list. */
  addMemoryProtectionRange(address: number, size: number): void;

  /**
   * Re-adds every currently-resident library (GfxBase, IntuitionBase,
   * DosBase, exec.library itself, ...) to the memory protection allow-list.
   * Library bases are bootstrapped by Kickstart before exec.library ever
   * makes a single trackable AllocMem call, so they're seeded once
   * automatically as soon as it's safe to do so (GfxBase confirmed set) —
   * but that seeding is wiped by a subsequent resetMemoryProtectionRanges()
   * call, so callers that reset the allow-list after boot (e.g. to seed a
   * fastLoad program's own hunks/stack) must call this again afterwards.
   */
  seedResidentLibraries(): void;

  // --- CPU / registers ---

  /**
   * Enables/disables CPU instruction logging
   * @param enabled True to enable logging, false to disable
   */
  enableCpuLogging(enabled: boolean): void;

  /**
   * Get CPU instruction trace log
   * @returns Promise resolving to array of CPU trace items
   */
  getCpuTrace(count?: number): Promise<CpuTraceItem[]>;

  /**
   * Gets the current CPU state including registers and flags
   * @returns Promise resolving to CPU information
   */
  getCpuInfo(): Promise<CpuInfo>;

  /**
   * Sets a CPU register to the specified value
   * @param name Register name (e.g. 'pc', 'd0', 'a7')
   * @param value New register value
   * @returns Promise resolving to set status
   */
  setRegister(name: string, value: number): Promise<RegisterSetStatus>;

  /**
   * Jump CPU to specified address
   * @param address Starting memory address
   */
  jump(address: number): Promise<void>;

  // --- Custom (chipset) registers ---

  /**
   * Gets all custom chip registers (e.g. DMACON, INTENA, etc.)
   * @returns Promise resolving to custom register values
   */
  getAllCustomRegisters(): Promise<CustomRegisters>;

  /**
   * Sets a custom chip register to the specified 16 bit value
   * @param address Register address (e.g. 0xdff180)
   * @param value New register value
   * @returns Promise resolving to set status
   */
  pokeCustom16(address: number, value: number): Promise<RegisterSetStatus>;

  /**
   * Sets a custom chip register to the specified 32 bit value
   * @param address Register address (e.g. 0xdff180)
   * @param value New register value
   * @returns Promise resolving to set status
   */
  pokeCustom32(address: number, value: number): Promise<RegisterSetStatus>;

  // --- Memory access ---

  /**
   * Reads memory from the specified address
   * @param address Starting memory address
   * @param count Number of bytes to read
   * @returns Promise resolving to memory data (Buffer)
   */
  readMemory(address: number, count: number): Promise<Buffer>;

  /**
   * Writes memory at the specified address
   * @param address Starting memory address
   * @param data Data buffer to write
   */
  writeMemory(address: number, data: Buffer): Promise<void>;

  /**
   * Reads longword at specified address
   * @param address Starting memory address
   * @returns Promise resolving to unsigned read result
   */
  peek32(address: number): Promise<number>;

  /**
   * Reads word at specified address
   * @param address Starting memory address
   * @returns Promise resolving to unsigned read result
   */
  peek16(address: number): Promise<number>;

  /**
   * Reads byte at specified address
   * @param address Starting memory address
   * @returns Promise resolving to unsigned read result
   */
  peek8(address: number): Promise<number>;

  /**
   * Writes longword at the specified address
   * @param address Starting memory address
   * @param value numeric value to write
   */
  poke32(address: number, value: number): Promise<void>;

  /**
   * Writes word at the specified address
   * @param address Starting memory address
   * @param value numeric value to write
   */
  poke16(address: number, value: number): Promise<void>;

  /**
   * Writes byte at the specified address
   * @param address Starting memory address
   * @param value numeric value to write
   */
  poke8(address: number, value: number): Promise<void>;

  /**
   * Gets the memory information from emulator
   * @returns Promise resolving to memory information
   */
  getMemoryInfo(): Promise<MemoryInfo>;

  /**
   * Returns the most recently fetched memory information, if any
   */
  getCachedMemoryInfo(): MemoryInfo | undefined;

  /**
   * Returns true if the given address is backed by memory
   */
  isValidAddress(address: number): boolean;

  /**
   * Get the contiguous memory region bounds for a given address
   * Returns the start and end addresses of the continuous block of the same memory type
   */
  getMemoryRegion(address: number): { start: number; end: number } | null;

  // --- Disassembly ---

  /**
   * Disassembles CPU instructions starting at the specified address
   * @param address Starting memory address
   * @param count Number of instructions to disassemble
   * @returns Promise resolving to disassembly result
   */
  disassemble(address: number, count: number): Promise<Disassembly>;
}
