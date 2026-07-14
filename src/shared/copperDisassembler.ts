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
  color?: [number, number, number];
}

/**
 * Disassemble a single Copper instruction from two words.
 *
 * `bplcon3`, when given, is the BPLCON3 register value in effect at this point in the copper
 * list — needed to render an accurate colour-swatch preview for a COLORxx MOVE on AGA, where
 * BPLCON3's LOCT bit changes what a COLORxx write even means (see below). Callers that don't
 * track running BPLCON3 state (or are disassembling a static list with no known runtime state)
 * can omit it; the swatch then falls back to the plain OCS/ECS interpretation, which is exactly
 * right unless LOCT happens to be set.
 */
export function disassembleCopperInstruction(
  address: number,
  word1: number,
  word2: number,
  bplcon3?: number,
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
    const regName = getRegisterName(regAddr);
    const value = word2;
    const isColor = regName.startsWith('COLOR');
    const valueLength = isColor ? 3 : 4;

    base.mnemonic = 'MOVE';
    base.operands = `#$${value.toString(16).toUpperCase().padStart(valueLength, '0')},`;
    base.operands += regName || ('$' + regAddr.toString(16).toUpperCase().padStart(3, '0'));

    // AGA's BPLCON3 LOCT bit (0x200) repurposes a COLORxx write to refine just the *low* nibble
    // of each channel (the high nibble comes from an earlier, separate write) — the plain 4-bit
    // nibble-per-channel swatch below would then show only that low nibble as if it were the
    // whole channel value, which is wrong without the running palette state this function
    // doesn't have. Skip the swatch rather than show a misleading one; the bank-select bits
    // (BPLCON3 bits 15-13) don't affect this write's own colour value, only which of the 256
    // AGA palette entries it targets, so they need no special-casing here.
    const loct = bplcon3 !== undefined && (bplcon3 & 0x200) !== 0;
    if (isColor && !loct) {
      const r = ((value >> 8) & 0xf) * 17;
      const g = ((value >> 4) & 0xf) * 17;
      const b = (value & 0xf) * 17;
      base.color = [r, g, b];
    }

    return base;
  }

  // WAIT or SKIP instruction (bit 0 = 1)
  const isSkip = (word2 & 0x0001) === 1;
  base.mnemonic = isSkip ? 'SKIP' : 'WAIT';

  const vp = (word1 >> 8) & 0xFF; // Vertical position
  const hp = word1 & 0xFE;        // Horizontal position
  const veMask = (word2 >> 8) & 0x7F; // Vertical enable mask
  const heMask = word2 & 0xFE;        // Horizontal enable mask
  const bfd = (word2 >> 15) & 0x01;   // Blitter finished disable
  const hasMask = veMask !== 0x7F || heMask !== 0xFE;

  // Check for end copper wait
  if (!isSkip && vp === 0xFF && hp === 0xFE && veMask === 0x7F && heMask === 0xFE) {
    base.operands = 'end';
    return base;
  }

  base.operands = `${vp},${hp}`;

  if (hasMask) {
    base.comment = `VE=$${veMask.toString(16).toUpperCase()}, HE=$${heMask.toString(16).toUpperCase()}`;
  }
  if (!bfd) {
    base.comment = (base.comment ? base.comment + ', ' : '') + 'Wait blitter';
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
