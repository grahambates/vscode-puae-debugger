/**
 * Lightweight syntax highlighting for M68k/Copper instruction text, shared by the memory viewer
 * (canvas-drawn) and the profiler (DOM spans).
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

// A number mustn't start mid-word: the digits of COLOR00 or BPL1PTH are part of a name.
const OPERAND_TOKEN_RE = /\b(?:[da][0-7]|sp|pc|sr|ccr|usp)\b|(?<!\w)#?-?(?:\$[0-9a-f]+|\d+)\b/gi;
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

export interface InstructionParts {
  /** Base mnemonic, e.g. "move". */
  mnemonic: string;
  /** Size qualifier including its dot (".w"), or "". */
  qualifier: string;
  /** Whitespace between the mnemonic and operands, kept so the text reads as it came. */
  gap: string;
  operands: string;
  /** Everything from a trailing ";" on, including the ";" itself and the spacing before it, or "". */
  comment: string;
}

/**
 * Splits a whole instruction line ("move.w #$4000,d0  ; comment") into mnemonic, size qualifier,
 * operands and trailing comment. The parts concatenate back to the original text.
 */
export function splitInstruction(text: string): InstructionParts {
  const semi = text.indexOf(";");
  let body = semi === -1 ? text : text.slice(0, semi);
  let comment = semi === -1 ? "" : text.slice(semi);
  // Spacing before the ";" belongs with the comment, so operands carry no trailing blank.
  const trailing = /\s*$/.exec(body)![0];
  if (comment && trailing) {
    body = body.slice(0, body.length - trailing.length);
    comment = trailing + comment;
  }
  const m = /^(\S*)(\s*)([\s\S]*)$/.exec(body)!;
  const word = m[1];
  const dot = word.indexOf(".");
  return {
    mnemonic: dot === -1 ? word : word.slice(0, dot),
    qualifier: dot === -1 ? "" : word.slice(dot),
    gap: m[2],
    operands: m[3],
    comment,
  };
}
