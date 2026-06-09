import * as vscode from "vscode";
import {
  CpuInfo,
  CpuTraceItem,
  CustomRegisters,
  Disassembly,
  EmulatorMessage,
  MemoryInfo,
  OpenOptions,
  RegisterSetStatus,
} from "./vAmiga";

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
  open(options?: OpenOptions): void;

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
   * Run to end of frame
   */
  eof(): void;

  /**
   * Run to end of line
   */
  eol(): void;

  // --- Breakpoints, watchpoints, catchpoints ---

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
   */
  setWatchpoint(address: number, ignores?: number): void;

  /**
   * Removes a watchpoint at the specified memory address
   * @param address Memory address of the watchpoint to remove
   */
  removeWatchpoint(address: number): void;

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

  /**
   * Disassembles copper instructions starting at the specified address
   * @param address Starting memory address
   * @param count Number of instructions to disassemble
   * @returns Promise resolving to disassembly result
   */
  disassembleCopper(address: number, count: number): Promise<Disassembly>;
}
