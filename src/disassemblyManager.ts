import { DebugProtocol } from "@vscode/debugprotocol";
import { basename } from "path";
import { SourceMap } from "./sourceMap";
import { Emulator } from "./emulator";
import { Source } from "@vscode/debugadapter";
import { disassembleCopperInstruction } from "./shared/copperDisassembler";
import { decodeInstruction, instructionToString } from "m68kdecode";
import { libraryCallComments } from "./libraryCalls";

/**
 * Manages instruction disassembly for the debug adapter.
 *
 * Handles disassembly requests with support for:
 * - Variable-length instruction handling
 * - Positive and negative instruction offsets
 * - Source map integration for symbol information
 * - Padding for missing instructions at negative boundaries
 */
export class DisassemblyManager {
  /**
   * Creates a new DisassemblyManager instance.
   *
   * @param emulator Emulator instance for disassembly operations
   * @param sourceMap Source map for adding symbol information to instructions
   */
  constructor(
    private emulator: Emulator,
    private sourceMap: SourceMap,
  ) {}

  /**
   * Disassembles instructions at the specified address with offset support.
   *
   * Handles complex offset calculations for variable-length instructions:
   * - Negative offsets: Estimates start address using worst-case instruction lengths
   * - Positive offsets: Fetches extra instructions and trims to requested range
   * - Padding: Adds invalid instructions when negative offset exceeds available code
   *
   * @param baseAddress Base memory address for disassembly
   * @param instructionOffset Instruction offset from base address (can be negative)
   * @param count Number of instructions to disassemble
   * @returns Array of disassembled instructions with optional source information
   */
  public async disassemble(
    baseAddress: number,
    instructionOffset: number,
    count: number,
  ): Promise<DebugProtocol.DisassembledInstruction[]> {
    // True 68k worst case (e.g. MOVE.L $12345678.L,$12345678.L -- long-absolute source AND
    // destination): not actually rare in real code that references hardware registers directly
    // by address. Undersizing this both under-fetches the backward-estimate buffer (below) and
    // can make startIndex's search fail to find baseAddress at all for otherwise-valid code.
    const MAX_BYTES_PER_INSTRUCTION = 10;
    const MIN_BYTES_PER_INSTRUCTION = 2;
    let requestCount = count;
    let startAddress = baseAddress;

    if (instructionOffset < 0) {
      startAddress += instructionOffset * MAX_BYTES_PER_INSTRUCTION;
      startAddress = Math.max(startAddress, 0);
      requestCount += -instructionOffset * (MAX_BYTES_PER_INSTRUCTION / MIN_BYTES_PER_INSTRUCTION);
    } else {
      requestCount += instructionOffset;
    }

    const memBuf = await this.emulator.readMemory(startAddress, requestCount * MAX_BYTES_PER_INSTRUCTION);
    const mem = new Uint8Array(memBuf.buffer, memBuf.byteOffset, memBuf.byteLength);

    type RawInstr = { addr: number; instruction: string; hex: string };
    const decoded: RawInstr[] = [];
    let byteOffset = 0;
    while (byteOffset < mem.length && decoded.length < requestCount * 2) {
      const slice = mem.subarray(byteOffset);
      if (slice.length < 2) break;
      let bytesUsed = 2;
      let text = "dc.w $" + ((slice[0] << 8 | slice[1]) >>> 0).toString(16).toUpperCase().padStart(4, "0");
      try {
        const d = decodeInstruction(slice);
        bytesUsed = Math.max(d.bytesUsed, 2);
        text = instructionToString(d.instruction).trim();
      } catch { /* unknown opcode — keep dc.w fallback */ }
      const hexStr = Array.from(slice.subarray(0, bytesUsed), (b: number) => b.toString(16).padStart(2, "0")).join(" ");
      decoded.push({ addr: startAddress + byteOffset, instruction: text, hex: hexStr });
      byteOffset += bytesUsed;
    }

    // Library calls named in a comment — `jsr -198(a6)  ; exec.library AllocMem` (libraryCalls.ts).
    // Worked out over everything decoded, not just the rows returned, so a call near the top can
    // still see the a6 load above it.
    const libraryCalls = await this.libraryCallComments(decoded);
    for (const instr of decoded) {
      const comment = libraryCalls.get(instr.addr);
      if (comment) instr.instruction += `  ; ${comment}`;
    }

    const startIndex = decoded.findIndex(i => i.addr === baseAddress);
    if (startIndex === -1) {
      throw new Error("Disassembly failed: Start instruction not found");
    }
    let realStart = startIndex + instructionOffset;

    // Total returned must be exactly `count` (the DAP `disassemble` request contract) --
    // padding rows count against that budget too, capped at `count` itself in case the
    // negative offset is large enough that padding alone would exceed it.
    const includedInstructions: RawInstr[] = [];
    if (realStart < 0) {
      const paddingCount = Math.min(-realStart, count);
      for (let i = 0; i < paddingCount; i++) {
        includedInstructions.push({ addr: 0, instruction: "invalid", hex: "00 00 00 00" });
      }
      realStart = 0;
    }
    const remaining = count - includedInstructions.length;
    includedInstructions.push(...decoded.slice(realStart, realStart + remaining));

    return includedInstructions.map(instr => {
      const disasm: DebugProtocol.DisassembledInstruction = {
        address: "0x" + instr.addr.toString(16),
        instruction: instr.instruction,
        instructionBytes: instr.hex,
      };
      const isPadding = instr.instruction === "invalid";
      if (isPadding || instr.instruction.startsWith("dc.")) {
        disasm.presentationHint = "invalid";
      }
      // Padding rows carry a placeholder addr:0, not a real address (see the padding loop
      // above) -- address 0 is meaningful on the Amiga memory map (reset SP/PC vectors), so a
      // symbol/line lookup there could attach a plausible-looking but bogus location to a row
      // that's supposed to represent unavailable data.
      if (this.sourceMap && !isPadding) {
        const loc = this.sourceMap.lookupAddress(instr.addr);
        if (loc) {
          disasm.symbol = basename(loc.path) + ":" + loc.line;
          disasm.location = new Source(basename(loc.path), loc.path);
          disasm.line = loc.line;
        }
      }
      return disasm;
    });
  }

  /** Never fails the disassembly: without a readable a6 or memory, calls just go unnamed. */
  private async libraryCallComments(decoded: { addr: number; hex: string }[]): Promise<Map<number, string>> {
    try {
      const cpu = await this.emulator.getCpuInfo();
      return await libraryCallComments(
        decoded.map((d) => ({ address: d.addr, hex: d.hex })),
        (address, length) => this.emulator.readMemory(address, length),
        (address) => {
          const sym = this.sourceMap?.findSymbolOffset(address);
          return sym && sym.offset === 0 ? sym.symbol : undefined;
        },
        { live: { pc: parseInt(cpu.pc, 16), a6: parseInt(cpu.a6, 16) } },
      );
    } catch {
      return new Map();
    }
  }

  /**
   * Disassembles Copper instructions starting at the specified address.
   *
   * Reads raw memory and decodes it locally with `copperDisassembler`
   * (shared with the Memory Viewer's Copper view) rather than relying on
   * an emulator-side disassembler RPC, so this works identically across
   * backends. Each Copper instruction is exactly 2 words (4 bytes).
   */
  public async disassembleCopper(
    address: number,
    instructionCount: number,
  ): Promise<DebugProtocol.DisassembledInstruction[]> {
    const data = await this.emulator.readMemory(address, instructionCount * 4);

    const result: DebugProtocol.DisassembledInstruction[] = [];
    for (let i = 0; i < instructionCount; i++) {
      const addr = address + i * 4;
      const word1 = data.readUInt16BE(i * 4);
      const word2 = data.readUInt16BE(i * 4 + 2);
      const { mnemonic, operands, comment } = disassembleCopperInstruction(
        addr,
        word1,
        word2,
      );

      const hex =
        word1.toString(16).toUpperCase().padStart(4, "0") +
        " " +
        word2.toString(16).toUpperCase().padStart(4, "0");

      let instruction = `${mnemonic} ${operands}`.trim();
      if (comment) {
        instruction += `  ; ${comment}`;
      }

      const disasm: DebugProtocol.DisassembledInstruction = {
        address: "0x" + addr.toString(16).toUpperCase().padStart(6, "0"),
        instruction,
        instructionBytes: hex,
      };

      // Add symbol lookup if we have source map
      if (this.sourceMap) {
        const loc = this.sourceMap.lookupAddress(addr);
        if (loc) {
          disasm.symbol = basename(loc.path) + ":" + loc.line;
          disasm.location = new Source(basename(loc.path), loc.path);
          disasm.line = loc.line;
        }
      }
      result.push(disasm);
    }
    return result;
  }
}
