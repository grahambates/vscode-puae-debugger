import { Source, StackFrame } from "@vscode/debugadapter";
import { decodeInstruction as m68kDecode } from "m68kdecode";
import { CpuInfo } from "./emulatorProtocol";
import { Emulator } from "./emulator";
import { formatAddress, formatHex } from "./numbers";
import { basename } from "path";
import { SourceMap } from "./sourceMap";

/**
 * Manages stack frame analysis and generation for the debug adapter.
 *
 * Provides stack trace functionality by:
 * - Reading the emulator's live shadow call-stack (or unwinding via DWARF
 *   .debug_frame when available)
 * - Creating source-based or disassembly-based stack frames
 * - Handling pagination for large stack traces
 */
export class StackManager {
  private lastFrameRegs = new Map<number, Map<number, number>>();

 /**
   * Creates a new StackManager instance.
   *
   * @param emulator Emulator instance for reading CPU state and memory
   * @param sourceMap Source map for resolving addresses to source locations
   */
  constructor(
    private emulator: Emulator,
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
   * @returns Sliced stack frames plus the total frame count before slicing
   */
  public async getStackFrames(
    startFrame: number,
    maxLevels: number,
    exceptionInstruction: { address: number; isSupervisor: boolean } | null = null,
  ): Promise<{ frames: StackFrame[]; total: number }> {
    const endFrame = startFrame + maxLevels;

    const cpuInfo = await this.emulator.getCpuInfo();
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
      return this.buildRealCallstackFrames(pc, startFrame, endFrame);
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
  ): Promise<{ frames: StackFrame[]; total: number }> {
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

    return { frames: allFrames.slice(startFrame, endFrame), total: allFrames.length };
  }

  // Builds stack frames from the emulator's real shadow call-stack (see
  // getRealCallstack) rather than guessing from stack memory contents. This
  // supersedes buildGuessFrames as the non-DWARF path; no inline frames (no
  // DWARF), no register snapshots.
  private async buildRealCallstackFrames(
    pc: number,
    startFrame: number,
    endFrame: number,
  ): Promise<{ frames: StackFrame[]; total: number }> {
    const addresses = await this.getRealCallstack(pc, endFrame);
    this.lastFrameRegs.clear();
    const allFrames: StackFrame[] = [];
    let frameId = 0;

    for (const [addr] of addresses) {
      const loc = this.sourceMap?.lookupAddress(addr);
      if (loc) {
        const f = new StackFrame(frameId, formatAddress(addr, this.sourceMap), new Source(basename(loc.path), loc.path), loc.line);
        f.instructionPointerReference = formatHex(addr);
        allFrames.push(f);
      } else {
        const f = new StackFrame(frameId, formatAddress(addr, this.sourceMap));
        f.instructionPointerReference = formatHex(addr);
        allFrames.push(f);
      }
      frameId++;
    }

    return { frames: allFrames.slice(startFrame, endFrame), total: allFrames.length };
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
        retAddrBuf = await this.emulator.readMemory(cfaVal - 4, 4);
      } catch {
        break;
      }
      const returnAddress = retAddrBuf.readUInt32BE(0);
      if (!this.emulator.isValidAddress(returnAddress) || returnAddress <= 0x100 || returnAddress & 1) break;

      regs.set(15, cfaVal); // caller's SP = CFA
      // If CFA reg is not SP (DWARF r15 = A7), it was set by `link Ax, #N`,
      // which saves Ax on the stack; restore it from mem[CFA-8] for the next frame.
      if (cfa.reg !== 15) {
        try {
          const fpBuf = await this.emulator.readMemory(cfaVal - 8, 4);
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
   * Builds the call chain from the emulator's live shadow call-stack
   * (Emulator.getCallstack): a continuously self-correcting record of
   * JSR/BSR/exception-entry pushes and RTS/RTD/RTE/RTR pops maintained by
   * the C core from boot, kept correct across stepBack/continueReverse
   * restores. This is the primary non-DWARF path (buildRealCallstackFrames)
   * and also backs stepOutRequest.
   *
   * The C side only records each call site's PC, outermost-first, not the
   * return address — so the return address for each entry is derived
   * locally (returnAddressAfter) by decoding the instruction at the call
   * site and adding its length, then the array is reversed to this class's
   * innermost-first [callSiteAddress, returnAddress] convention, with frame
   * 0 always [pc, pc].
   *
   * @param pc Current PC (frame 0)
   * @param maxLength Maximum number of frames to return
   */
  public async getRealCallstack(pc: number, maxLength = 16): Promise<[number, number][]> {
    const addresses: [number, number][] = [[pc, pc]];
    let callSites = await this.emulator.getCallstack(); // outermost-first

    // puae_debug_exceptionEnter pushes the interrupted code's own PC using
    // the same call-site convention as JSR/BSR, so when the current stop is
    // an exception (pc here is the faulting instruction, not the raw PC),
    // the top entry duplicates frame 0 — drop it so it isn't shown twice.
    if (callSites.length > 0 && callSites[callSites.length - 1] === pc) {
      callSites = callSites.slice(0, -1);
    }

    for (let i = callSites.length - 1; i >= 0 && addresses.length < maxLength; i--) {
      const callSitePc = callSites[i];
      addresses.push([callSitePc, await this.returnAddressAfter(callSitePc)]);
    }
    return addresses;
  }

  // The shadow call-stack only records the call-site PC, not the return
  // address — derive it locally by decoding the instruction at the call site
  // and adding its byte length (mirrors doInstructionStepOver's approach in
  // debugAdapter.ts).
  private async returnAddressAfter(callSitePc: number): Promise<number> {
    try {
      const buf = await this.emulator.readMemory(callSitePc, 8);
      const mem = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      const bytesUsed = Math.max(m68kDecode(mem).bytesUsed, 2);
      return callSitePc + bytesUsed;
    } catch {
      return callSitePc;
    }
  }

}
