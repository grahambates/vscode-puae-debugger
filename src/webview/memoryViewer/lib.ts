
// Re-exported so existing call sites in this module are unaffected — the implementation now
// lives in webview/shared/memoryFormat.ts (shared with the profiler's MemoryView).
export { convertToSigned } from "../shared/memoryFormat";

/**
 * Get formatted address string for value including offset from previous symbol
 */
export function formatAddress(
  address: number,
  symbols: Record<string, number>,
  symbolLengths: Record<string, number>,
): string {
  const addrHex = address.toString(16).toUpperCase().padStart(6, "0");

  // Find symbol offset (similar to findSymbolOffset in sourceMap.ts)
  // Find the closest symbol before this address
  let symbolOffset: { symbol: string; offset: number } | undefined;
  for (const symbol in symbols) {
    const symAddr = symbols[symbol];
    const offset = address - symAddr;
    // Address is at or after symbol
    if (offset >= 0 && offset < symbolLengths[symbol]) {
      // Keep the closest symbol (smallest offset)
      if (!symbolOffset || offset <= symbolOffset.offset) {
	symbolOffset = { symbol, offset };
      }
    }
  }

  // Build address string with symbol+offset if available
  let addressStr = addrHex;
  if (symbolOffset) {
    addressStr += ": " + symbolOffset.symbol;
    if (symbolOffset.offset > 0) {
      addressStr += "+" + symbolOffset.offset;
    }
  }
  return addressStr;
}

/**
 * Lightweight syntax highlighting for M68k/Copper operand strings.
 *
 * The disassemblers return operands as plain strings (e.g. "123(a0,d0),d3" or
 * "#$1234,d7"), so highlighting is done by tokenizing with a regex rather than
 * from structured data.
 */
export type OperandTokenType = "register" | "number" | "text";

export interface OperandToken {
  text: string;
  type: OperandTokenType;
}

export interface OperandColors {
  register: string;
  number: string;
  text: string;
}

const OPERAND_TOKEN_RE = /\b(?:[da][0-7]|sp|pc|sr|ccr|usp)\b|#?-?(?:\$[0-9a-f]+|\d+)\b/gi;
const REGISTER_RE = /^(?:[da][0-7]|sp|pc|sr|ccr|usp)$/i;

/**
 * Splits an operand string into registers, numbers/immediates, and the
 * surrounding punctuation/separators (parentheses, commas, +, -, *, size suffixes).
 */
export function tokenizeOperands(operands: string): OperandToken[] {
  const tokens: OperandToken[] = [];
  let lastIndex = 0;
  for (const match of operands.matchAll(OPERAND_TOKEN_RE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      tokens.push({ text: operands.slice(lastIndex, index), type: "text" });
    }
    const value = match[0];
    tokens.push({
      text: value,
      type: REGISTER_RE.test(value) ? "register" : "number",
    });
    lastIndex = index + value.length;
  }
  if (lastIndex < operands.length) {
    tokens.push({ text: operands.slice(lastIndex), type: "text" });
  }
  return tokens;
}

export interface MnemonicColors {
  mnemonic: string;
  qualifier: string;
}

/**
 * Draws an instruction mnemonic, coloring the optional ".b"/".w"/".l" size
 * qualifier separately from the base mnemonic (e.g. "move" + ".w").
 */
export function drawMnemonic(
  ctx: CanvasRenderingContext2D,
  mnemonic: string,
  x: number,
  y: number,
  colors: MnemonicColors,
): void {
  const dotIndex = mnemonic.indexOf(".");
  const base = dotIndex === -1 ? mnemonic : mnemonic.slice(0, dotIndex);
  const qualifier = dotIndex === -1 ? "" : mnemonic.slice(dotIndex);

  ctx.fillStyle = colors.mnemonic;
  ctx.fillText(base, x, y);

  if (qualifier) {
    ctx.fillStyle = colors.qualifier;
    ctx.fillText(qualifier, x + ctx.measureText(base).width, y);
  }
}

/**
 * Draws a tokenized operand string to a canvas, coloring each token by type.
 */
export function drawOperands(
  ctx: CanvasRenderingContext2D,
  operands: string,
  x: number,
  y: number,
  colors: OperandColors,
): void {
  let cursorX = x;
  for (const token of tokenizeOperands(operands)) {
    ctx.fillStyle = colors[token.type];
    ctx.fillText(token.text, cursorX, y);
    cursorX += ctx.measureText(token.text).width;
  }
}