import { Source, StackFrame } from "@vscode/debugadapter";
import { VAmiga, CpuInfo } from "./vAmiga";
import { formatAddress, formatHex } from "./numbers";
import { basename } from "path";
import { SourceMap } from "./sourceMap";

/**
 * Manages stack frame analysis and generation for the debug adapter.
 *
 * Provides stack trace functionality by:
 * - Analyzing stack memory to identify return addresses
 * - Detecting JSR/BSR call patterns in the stack
 * - Creating source-based or disassembly-based stack frames
 * - Handling pagination for large stack traces
 */
export class StackManager {
  private lastFrameRegs = new Map<number, Map<number, number>>();

 /**
   * Creates a new StackManager instance.
   *
   * @param vAmiga VAmiga instance for reading CPU state and memory
   * @param sourceMap Source map for resolving addresses to source locations
   */
  constructor(
    private vAmiga: VAmiga,
    private sourceMap: SourceMap,
  ) {}

  public getFrameRegs(frameId: number): Map<number, number> | undefined {
    return this.lastFrameRegs.get(frameId);
  }

  /**
   * Generates stack frames for the debug adapter.
   *
   * Creates stack frames by analyzing the stack memory and resolving addresses
   * to source locations when available. Falls back to disassembly frames
   * when source information is not available.
   *
   * @param startFrame Starting frame index for pagination
   * @param maxLevels Maximum number of frames to return
   * @returns Array of stack frames with source or disassembly information
   */
  public async getStackFrames(
    startFrame: number,
    maxLevels: number,
    exceptionInstruction: { address: number; isSupervisor: boolean } | null = null,
  ): Promise<StackFrame[]> {
    const endFrame = startFrame + maxLevels;

    const cpuInfo = await this.vAmiga.getCpuInfo();
    let pc = Number(cpuInfo.pc);
    let stackAddress = Number(cpuInfo.a7);
    if (exceptionInstruction) {
      // If we have an exception instruction, use its address as the top of stack
      pc = exceptionInstruction.address;
      //  If last instruction was user mode, use USP instead of SSP
      if (!exceptionInstruction.isSupervisor) {
        stackAddress = Number(cpuInfo.usp);
      }
    }

    if (this.sourceMap?.getCfaForPc?.(pc) !== undefined) {
      return this.buildDwarfFrames(pc, stackAddress, cpuInfo, startFrame, endFrame);
    } else {
      return this.buildGuessFrames(pc, stackAddress, startFrame, endFrame);
    }
  }

  // Builds stack frames using DWARF .debug_frame unwinding.
  // Expands inline frames and records register snapshots per frame.
  private async buildDwarfFrames(
    pc: number,
    stackAddress: number,
    cpuInfo: CpuInfo,
    startFrame: number,
    endFrame: number,
  ): Promise<StackFrame[]> {
    const { addresses, snapshots } = await this.dwarfUnwindStack(pc, stackAddress, cpuInfo, endFrame);
    this.lastFrameRegs.clear();
    const allFrames: StackFrame[] = [];
    let frameId = 0;

    for (let addrIdx = 0; addrIdx < addresses.length; addrIdx++) {
      const [addr] = addresses[addrIdx];
      const snapshot = snapshots[addrIdx];
      const inlines = this.sourceMap?.getInlineFramesForPc?.(addr) ?? [];

      // Synthetic inline frames — innermost (deepest nesting) first.
      // Frame k shows the kth inline function; its source location is either the
      // raw PC location (k=0) or the call site of the previous inline (k>0).
      for (let k = 0; k < inlines.length; k++) {
        const inlineLoc = k === 0
          ? this.sourceMap?.lookupAddress(addr)
          : { path: inlines[k - 1].callPath, line: inlines[k - 1].callLine };
        const inlineName = `${inlines[k].name} (inline)`;
        const f = inlineLoc
          ? new StackFrame(frameId, inlineName, new Source(basename(inlineLoc.path), inlineLoc.path), inlineLoc.line)
          : new StackFrame(frameId, inlineName);
        f.instructionPointerReference = formatHex(addr);
        allFrames.push(f);
        if (snapshot) this.lastFrameRegs.set(frameId, snapshot);
        frameId++;
      }

      // Real frame. If there are inlines, override its location with the outermost
      // inline's call site (where that inline was invoked in this function).
      const loc = inlines.length > 0
        ? { path: inlines[inlines.length - 1].callPath, line: inlines[inlines.length - 1].callLine }
        : this.sourceMap?.lookupAddress(addr);

      if (loc) {
        const f = new StackFrame(frameId, formatAddress(addr, this.sourceMap), new Source(basename(loc.path), loc.path), loc.line);
        f.instructionPointerReference = formatHex(addr);
        allFrames.push(f);
        if (snapshot) this.lastFrameRegs.set(frameId, snapshot);
      } else {
        const f = new StackFrame(frameId, formatAddress(addr, this.sourceMap));
        f.instructionPointerReference = formatHex(addr);
        allFrames.push(f);
        if (snapshot) this.lastFrameRegs.set(frameId, snapshot);
      }
      frameId++;
    }

    return allFrames.slice(startFrame, endFrame);
  }

  // Builds stack frames by heuristic guessing (no DWARF info available).
  // No inline frames, no register snapshots.
  private async buildGuessFrames(
    pc: number,
    stackAddress: number,
    startFrame: number,
    endFrame: number,
  ): Promise<StackFrame[]> {
    const addresses = await this.guessStack(pc, stackAddress, endFrame);
    this.lastFrameRegs.clear();
    const allFrames: StackFrame[] = [];
    let frameId = 0;
    let foundSource = false;

    for (const [addr] of addresses) {
      const loc = this.sourceMap?.lookupAddress(addr);
      if (loc) {
        const f = new StackFrame(frameId, formatAddress(addr, this.sourceMap), new Source(basename(loc.path), loc.path), loc.line);
        f.instructionPointerReference = formatHex(addr);
        allFrames.push(f);
        frameId++;
        foundSource = true;
      } else {
        if (foundSource && addr > 0x00e00000 && addr < 0x01000000) break;
        const f = new StackFrame(frameId, formatHex(addr));
        f.instructionPointerReference = formatHex(addr);
        allFrames.push(f);
        frameId++;
      }
    }

    return allFrames.slice(startFrame, endFrame);
  }

  private cpuInfoToRegs(cpuInfo: CpuInfo): Map<number, number> {
    const m = new Map<number, number>();
    for (let i = 0; i < 8; i++) {
      m.set(i, Number(cpuInfo[`d${i}` as keyof CpuInfo]));
      m.set(8 + i, Number(cpuInfo[`a${i}` as keyof CpuInfo]));
    }
    return m;
  }

  // Unwind the call stack using DWARF .debug_frame CFA information.
  // m68k convention: JSR pushes 4-byte return address; CFA is the caller's SP
  // before that push, so the return address sits at mem[CFA - 4].
  // When the frame uses something different as SP as the CFA register (link Ax case), 
  // the saved Ax is at mem[CFA - 8] and must be restored for the next unwind step.
  private async dwarfUnwindStack(
    pc: number,
    initialSp: number,
    cpuInfo: CpuInfo,
    maxLength: number,
  ): Promise<{ addresses: [number, number][]; snapshots: Map<number, number>[] }> {
    const addresses: [number, number][] = [[pc, pc]];
    const regs = this.cpuInfoToRegs(cpuInfo);
    regs.set(15, initialSp); // DWARF r15 = A7/SP; use caller-supplied value (handles exception USP)
    const snapshots: Map<number, number>[] = [new Map(regs)]; // frame 0 = live registers
    let currentPc = pc;

    while (addresses.length < maxLength) {
      const cfa = this.sourceMap.getCfaForPc(currentPc);
      if (!cfa) break;

      const cfaVal = (regs.get(cfa.reg) ?? 0) + cfa.offset;

      let retAddrBuf: Buffer;
      try {
        retAddrBuf = await this.vAmiga.readMemory(cfaVal - 4, 4);
      } catch {
        break;
      }
      const returnAddress = retAddrBuf.readUInt32BE(0);
      if (!this.vAmiga.isValidAddress(returnAddress) || returnAddress <= 0x100 || returnAddress & 1) break;

      regs.set(15, cfaVal); // caller's SP = CFA
      // If CFA reg is not SP (DWARF r15 = A7), it was set by `link Ax, #N`,
      // which saves Ax on the stack; restore it from mem[CFA-8] for the next frame.
      if (cfa.reg !== 15) {
        try {
          const fpBuf = await this.vAmiga.readMemory(cfaVal - 8, 4);
          regs.set(cfa.reg, fpBuf.readUInt32BE(0));
        } catch { /* ignore */ }
      }

      addresses.push([returnAddress, returnAddress]);
      snapshots.push(new Map(regs)); // register state restored to caller's perspective
      currentPc = returnAddress;
    }

    return { addresses, snapshots };
  }

  /**
   * Analyzes stack memory to guess call frames.
   *
   * Since VAmiga doesn't track stack frames, this method examines stack memory
   * looking for patterns that indicate return addresses from JSR/BSR instructions.
   *
   * Made protected to allow testing of the stack analysis algorithm.
   *
   * Algorithm:
   * 1. Reads stack memory from current SP
   * 2. Looks for 32-bit values that could be return addresses
   * 3. Validates by checking if previous instructions are JSR/BSR
   * 4. Builds list of [call_site, return_address] pairs
   *
   * @param maxLength Maximum number of stack frames to return
   * @returns Array of [call instruction address, return address] pairs
   */
  public async guessStack(pc: number, stackAddress: number, maxLength = 16): Promise<[number, number][]> {
    // vAmiga doesn't currently track stack frames, so we'll need to look at the stack data and guess...
    // Fetch data from sp, up to a reasonable length
    const maxSize = 128;
    const stackData = await this.vAmiga.readMemory(stackAddress, 128);

    const addresses: [number, number][] = [[pc, pc]]; // Start with at least the current frame

    // Look for values that could be a possible return address (as opposed to other data pushed to the stack)
    let offset = 0;
    addresses: while (offset <= maxSize - 4 && addresses.length < maxLength) {
      const addr = stackData.readInt32BE(offset);
      if (
        this.vAmiga.isValidAddress(addr) &&
        addr > 0x100 &&
        !(addr & 1) // even address
      ) {
        try {
          // Look at previous 3 words, and check if they look like a jsr or bsr
          const prevBytes = await this.vAmiga.readMemory(addr - 6, 6);
          for (let i = 0; i < 3; i++) {
            const w = prevBytes.readUInt16BE(i * 2);
            if (
              (w & 0xffc0) === 0x4e80 || // jsr
              (w & 0xff00) === 0x6100 // bsr
            ) {
              // found likely return
              addresses.push([addr - 6 + i * 2, addr]);
              offset += 4;
              continue addresses;
            }
          }
        } catch (_) {
          // probably failed to read mem at invalid address
        }
      }
      // next word if match not found
      offset += 2;
    }
    return addresses;
  }
}
