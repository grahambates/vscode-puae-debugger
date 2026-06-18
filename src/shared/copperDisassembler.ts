/**
 * Copper instruction disassembler for Amiga
 *
 * The Copper is a coprocessor that manipulates custom chip registers in sync with the video beam.
 * All Copper instructions are exactly 2 words (4 bytes) long.
 */

import { customRegisterLabel } from "../webview/shared/customRegisters";

export interface CopperInstruction {
  address: number;
  word1: number;
  word2: number;
  mnemonic: string;
  operands: string;
  comment?: string;
}

/**
 * Disassemble a single Copper instruction from two words
 */
export function disassembleCopperInstruction(
  address: number,
  word1: number,
  word2: number
): CopperInstruction {
  const base: CopperInstruction = {
    address,
    word1,
    word2,
    mnemonic: '',
    operands: '',
  };

  // Check if it's a MOVE instruction (bit 0 of first word = 0)
  if ((word1 & 0x0001) === 0) {
    // MOVE instruction: Move word2 to register at word1[15:1]
    const regAddr = word1 & 0x01FE; // Bits 8:1 (register address)
    const value = word2;

    base.mnemonic = 'MOVE';
    base.operands = `#$${value.toString(16).toUpperCase().padStart(4, '0')}, $${regAddr.toString(16).toUpperCase().padStart(3, '0')}`;
    base.comment = getRegisterName(regAddr);

    return base;
  }

  // WAIT or SKIP instruction (bit 0 = 1)
  const isSkip = (word2 & 0x0001) === 1;

  if (isSkip) {
    // SKIP instruction
    const vp = (word1 >> 8) & 0xFF; // Vertical position
    const hp = word1 & 0xFE;        // Horizontal position
    const veMask = (word2 >> 8) & 0x7F; // Vertical enable mask
    const heMask = word2 & 0xFE;        // Horizontal enable mask
    const bfd = (word2 >> 15) & 0x01;   // Blitter finished disable

    base.mnemonic = 'SKIP';
    base.operands = `${vp}, ${hp}`;

    if (veMask !== 0x7F || heMask !== 0xFE) {
      base.comment = `VE=$${veMask.toString(16).toUpperCase()}, HE=$${heMask.toString(16).toUpperCase()}`;
    }
    if (bfd) {
      base.comment = (base.comment ? base.comment + ', ' : '') + 'BFD';
    }

    return base;
  }

  // WAIT instruction
  const vp = (word1 >> 8) & 0xFF; // Vertical position
  const hp = word1 & 0xFE;        // Horizontal position
  const veMask = (word2 >> 8) & 0x7F; // Vertical enable mask
  const heMask = word2 & 0xFE;        // Horizontal enable mask
  const bfd = (word2 >> 15) & 0x01;   // Blitter finished disable

  // Check for common wait patterns
  if (vp === 0xFF && hp === 0xFE && veMask === 0x7F && heMask === 0xFE) {
    base.mnemonic = 'WAIT';
    base.operands = 'end';
    base.comment = 'Wait for impossible position (end of copperlist)';
    return base;
  }

  base.mnemonic = 'WAIT';
  base.operands = `${vp}, ${hp}`;

  if (veMask !== 0x7F || heMask !== 0xFE) {
    base.comment = `VE=$${veMask.toString(16).toUpperCase()}, HE=$${heMask.toString(16).toUpperCase()}`;
  }
  if (bfd) {
    base.comment = (base.comment ? base.comment + ', ' : '') + 'BFD';
  }

  return base;
}

/**
 * Get human-readable register name from custom chip register address.
 * Table lives in the shared customRegisters module (reused by the DMA profiler tooltip).
 */
function getRegisterName(addr: number): string {
  return customRegisterLabel(addr);
}
