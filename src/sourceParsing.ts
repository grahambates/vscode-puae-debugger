export type Size = "s" | "b" | "w" | "l";

export interface ParsedLine {
  label?: Component;
  mnemonic?: Component;
  size?: Component;
  operands?: Component[];
  comment?: Component;
}

export interface Component {
  start: number;
  end: number;
  value: string;
}

export enum ComponentType {
  Label,
  Mnemonic,
  Size,
  Operand,
  Comment,
}

export interface ComponentInfo {
  type: ComponentType;
  component: Component;
  index?: number;
}

// Helper to strip comments and normalize whitespace from regex strings
function rx(template: string): string {
  return template
    .replace(/\s*#.*$/gm, "") // Remove comments (# to end of line)
    .replace(/\s+/g, ""); // Remove all whitespace
}

// Assembly line parsing regex - built from documented components
const labelGroup = rx(String.raw`
  (?<label>
    ([^:\s;*=]+:?:?)           # anything at start of line - optional colon
    |                          # or...
    (\s+[^:\s;*=]+::?)         # can have leading whitespace with colon present
  )?
`);

const noOperandMnemonics = rx(String.raw`
  (?<mnemonic1>\.?(nop|reset|rte|rtr|rts|trapv|illegal|clrfo|clrso|comment|einline|even|inline|list|mexit|nolist|nopage|odd|page|popsection|pushsection|rsreset|endif|endc|else|elseif|endm|endr|erem))
  (?<size1>\.[a-z0-9_.]*)?     # Size qualifier
`);

const operandPattern = rx(String.raw`
  "([^"]*)"?|                  # double quoted
  '([^']*)'?|                  # single quoted  
  <([^>]*)>?|                  # chevron quoted
  [^\s;,]+                     # anything else
`);

const operandPatternForSecond = rx(String.raw`
  "([^"]*)"?|                  # double quoted
  '([^']*)'?|                  # single quoted  
  <([^>]*)>?|                  # chevron quoted
  [^\s;,]*                     # anything else (can be empty)
`);

const regularMnemonic = rx(String.raw`
  (?<mnemonic>([^\s.,;*=]+|=)) # Mnemonic
  (?<size>\.[^\s.,;*]*)?       # Size qualifier
  (\s*(?<operands>             # Operand list:
    (?<op1>${operandPattern})  # First operand
    (?<op2>,\s*(${operandPatternForSecond}))* # Additional comma separated operands
  ))?
`);

const instructionGroup = rx(String.raw`
  (\s*                         # Instruction or directive:
    (
      (${noOperandMnemonics})  # No-operand mnemonics
      |
      (${regularMnemonic})     # Any other mnemonic
    )
  )?
`);

const commentGroup = rx(String.raw`
  (\s*(?<comment>.+))?         # Comment (any trailing text)
`);

const pattern = new RegExp(
  `^${labelGroup}${instructionGroup}${commentGroup}$`,
  "i",
);

/**
 * Parse a single line of source code into positional components
 *
 * This is much simpler than the syntax tree returned by Tree Sitter but is
 * also less strict and useful for parsing incomplete lines as you type.
 */
export function parseLine(text: string): ParsedLine {
  const line: ParsedLine = {};
  const groups = pattern.exec(text)?.groups;
  if (groups) {
    let end = 0;

    if (groups.label) {
      let value = groups.label.trim();
      while (value.endsWith(":")) {
        value = value.substring(0, value.length - 1);
      }
      const start = text.indexOf(value);
      end = start + value.length;
      line.label = { start, end, value };
    }

    if (groups.mnemonic || groups.mnemonic1) {
      const value = groups.mnemonic || groups.mnemonic1;
      const start = end + text.substring(end).indexOf(value);
      end = start + value.length;
      line.mnemonic = { start, end, value };
    }

    if (groups.size || groups.size1) {
      let value = groups.size || groups.size1;
      const start = end + text.substring(end).indexOf(value) + 1;
      value = value.substring(1);
      end = start + value.length;
      line.size = { start, end, value };
    }

    if (groups.operands) {
      // Split on comma, unless in parens
      const values = groups.operands.split(/,\s*(?![^()<>]*[)>])/);

      const operands: Component[] = [];
      for (const value of values) {
        const start = value
          ? end + text.substring(end).indexOf(value)
          : end + 1;
        end = start + value.length;
        operands.push({ start, end, value });
      }

      line.operands = operands;
    }

    if (groups.comment && groups.comment.trim()) {
      const value = groups.comment;
      const start = end + text.substring(end).indexOf(value);
      end = start + value.length;
      line.comment = { start, end, value };
    }
  }

  return line;
}

const longDefault = ["moveq", "exg", "lea", "pea"];
const byteDefault = [
  "nbcd",
  "abcd",
  "sbcd",
  "tas",
  "scc",
  "scs",
  "seq",
  "sge",
  "sgt",
  "shi",
  "sle",
  "slt",
  "smi",
  "sne",
  "spl",
  "svc",
  "svs",
  "st",
  "sf",
  "sls",
];
const bitOps = ["bchg", "bset", "bclr", "btst"];

/**
 * Determines the byte length and signedness attributes of an assembly instruction.
 *
 * Analyzes the instruction size suffix (.b, .w, .l) and mnemonic to determine
 * the appropriate data size and whether the operation is signed or unsigned.
 * Used for proper formatting of expression evaluation results.
 *
 * @param line Assembly source line to analyze
 * @returns Object containing byteLength (1, 2, or 4) and signed (boolean)
 */
export function instructionAttrs(line: string): {
  byteLength: number;
  signed: boolean;
} {
  let byteLength = 2;
  let signed = false;
  const parsed = parseLine(line);
  const size = parsed.size?.value;
  const mnemonic = parsed.mnemonic?.value.toLowerCase();
  // TODO: edge case where op doesn't match instruction size: divu/divs dest, any others?
  if (size) {
    // Map size to byte length:
    const sizeMap: Record<Size, number> = {
      s: 1,
      b: 1,
      w: 2,
      l: 4,
    };
    byteLength = sizeMap[size as Size];
  } else {
    // default to word
    byteLength = 2;

    // Instruction specific defaults:
    if (mnemonic) {
      if (longDefault.includes(mnemonic)) {
        byteLength = 4;
      } else if (byteDefault.includes(mnemonic)) {
        byteLength = 1;
      } else if (bitOps.includes(mnemonic)) {
        // depends on dest type -- parsed.operands may have fewer than 2 entries for an
        // incomplete/as-you-type line (see parseLine's own tolerance for that), so the
        // destination operand itself, not just the array, needs an optional guard.
        byteLength = parsed.operands?.[1]?.value.match(/^d[0-7]$/i) ? 4 : 1;
      }
    }
  }
  // Check for signed instructions
  if (mnemonic) {
    signed = ["muls", "divs", "asr", "asl"].includes(mnemonic);
  }

  return { byteLength, signed };
}

const dataDirectiveSizes: Record<Size, number> = { s: 1, b: 1, w: 2, l: 4 };

/**
 * Determines the byte size of a data declaration line (dc/ds/dcb), for
 * inferring how much memory a label covers. Unlike instructionAttrs()
 * (which sizes an *instruction referencing* a symbol), this sizes a
 * symbol's *own declaration* — used for watchpoint length, not value
 * formatting.
 *
 * Returns undefined for anything that isn't a recognized data directive
 * (a real instruction, an unrecognized directive, or a bare label with no
 * mnemonic at all) — callers should fall back to a safe default (e.g. a
 * single address) rather than guess further.
 *
 * @param line Assembly source line to analyze
 * @returns Declared size in bytes, or undefined if not a sizeable directive
 */
export function symbolDeclaredSize(line: string): number | undefined {
  const parsed = parseLine(line);
  const mnemonic = parsed.mnemonic?.value.toLowerCase();
  if (!mnemonic) return undefined;

  // dc(.b/.w/.l) defaults to word-sized elements when no suffix is given,
  // matching real 68k assemblers.
  const size = (parsed.size?.value.toLowerCase() as Size) || "w";
  const unitSize = dataDirectiveSizes[size];
  if (!unitSize) return undefined;

  if (mnemonic === "dc") {
    if (!parsed.operands?.length) return undefined;
    let total = 0;
    for (const op of parsed.operands) {
      // A quoted string in a dc.b is one byte per character, not one
      // unit per operand (e.g. dc.b 'Hello',0 is 6 bytes, not 2).
      const quoted =
        unitSize === 1 && op.value.match(/^(?:"([^"]*)"|'([^']*)')$/);
      total += quoted
        ? Math.max(1, (quoted[1] ?? quoted[2] ?? "").length)
        : unitSize;
    }
    return total;
  }

  if (mnemonic === "ds" || mnemonic === "dcb") {
    // ds.x <count> reserves <count> units; dcb.x <count>,<fill> likewise
    // (the fill value doesn't affect size).
    const count = Number(parsed.operands?.[0]?.value);
    return Number.isFinite(count) && count > 0 ? count * unitSize : undefined;
  }

  return undefined;
}
