import { DebugProtocol } from "@vscode/debugprotocol";
import { VAmiga } from "./vAmiga";
import { SourceMap, TypeDescriptor } from "./sourceMap";
import { VariablesManager } from "./variablesManager";
import { formatAddress, formatHex } from "./numbers";

/**
 * Evaluator for compound C/C++ expressions in the debug/hover/watch context.
 *
 * This is a typed-lvalue walker over the DWARF `TypeDescriptor` model: it resolves a name to an
 * address + type (via `VariablesManager.resolveNameToLValue`), applies the navigation operators
 * `.`  `->`  `[]`  `*`  `&` by adjusting the address and stepping the type, and renders the final
 * value with the same `VariablesManager.renderLValue` used by the Variables view. It is kept
 * deliberately separate from the assembly `expr-eval` numeric path: anything it cannot parse or
 * resolve as a C lvalue expression yields `undefined`, letting the caller fall back to that path.
 *
 * Scope: navigation operators only (no arithmetic / comparisons / casts), read-only.
 */

// --- Hover range detection (vscode-free, so it is unit-testable without the editor) ---

// A full C navigation chain: an identifier followed by any number of `.field`, `->field` or
// `[index]` segments. Indices are not nested-bracket aware (`arr[i]`, `arr[obj.n]`), which is
// sufficient for the navigation-only evaluator.
const CHAIN_RE = /[A-Za-z_]\w*(?:\s*(?:\.|->)\s*[A-Za-z_]\w*|\s*\[[^[\]]*\])*/g;
const WORD_RE = /[A-Za-z_]\w*/g;

function matchCovering(re: RegExp, line: string, col: number): RegExpExecArray | undefined {
  re.lastIndex = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (col >= m.index && col <= m.index + m[0].length) return m;
  }
  return undefined;
}

/**
 * Computes the C expression range to evaluate for a hover at `col` within `line`.
 *
 * Matches VS Code's behaviour for property chains: the expression is the navigation chain truncated
 * at the **end of the token under the cursor** — hovering `SysBase` in `SysBase->ColdCapture` yields
 * `SysBase`; hovering `ColdCapture` yields the whole `SysBase->ColdCapture`. A token that is an array
 * index (`arr[i]`, cursor on `i`) evaluates to just that token. Returns undefined when the cursor is
 * not on an identifier (e.g. on an operator), letting the editor fall back to its default word range.
 */
export function expressionRangeAt(
  line: string,
  col: number,
): { start: number; end: number; text: string } | undefined {
  const chain = matchCovering(CHAIN_RE, line, col);
  if (!chain) return undefined;
  const word = matchCovering(WORD_RE, line, col);
  if (!word) return undefined; // cursor on an operator/bracket, not an identifier

  const chainStart = chain.index;
  const wordStart = word.index;
  const wordEnd = word.index + word[0].length;

  // If the hovered token sits inside an index `[...]`, evaluate just that token (the index expr).
  let depth = 0;
  for (const ch of line.slice(chainStart, wordStart)) {
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
  }
  if (depth > 0) {
    return { start: wordStart, end: wordEnd, text: line.slice(wordStart, wordEnd) };
  }

  // Otherwise: the chain up to and including the hovered member (no rightward extension).
  return { start: chainStart, end: wordEnd, text: line.slice(chainStart, wordEnd) };
}

// --- AST ---

type Node =
  | { kind: "name"; name: string }
  | { kind: "num"; value: number }
  | { kind: "member"; obj: Node; field: string } //  obj.field
  | { kind: "arrow"; obj: Node; field: string } //   obj->field
  | { kind: "index"; obj: Node; index: Node } //      obj[index]
  | { kind: "deref"; obj: Node } //                   *obj
  | { kind: "addr"; obj: Node }; //                   &obj

// --- Tokenizer ---

type Punct = "." | "->" | "[" | "]" | "(" | ")" | "*" | "&";
type Token =
  | { t: "id"; v: string }
  | { t: "num"; v: number }
  | { t: "punct"; v: Punct };

function tokenize(input: string): Token[] | undefined {
  const tokens: Token[] = [];
  let i = 0;
  const isIdStart = (c: string) => /[A-Za-z_]/.test(c);
  const isIdPart = (c: string) => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < input.length && isIdPart(input[j])) j++;
      tokens.push({ t: "id", v: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const hex = input.slice(i).match(/^0x[0-9a-fA-F]+/);
      const dec = input.slice(i).match(/^[0-9]+/);
      const m = hex ?? dec;
      if (!m) return undefined;
      tokens.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (c === "-" && input[i + 1] === ">") {
      tokens.push({ t: "punct", v: "->" });
      i += 2;
      continue;
    }
    if (".[]()*&".includes(c)) {
      tokens.push({ t: "punct", v: c as Punct });
      i++;
      continue;
    }
    // Any other character (e.g. + - / arithmetic, $) is not part of the C navigation grammar.
    return undefined;
  }
  return tokens;
}

// --- Parser (recursive descent) ---
//   unary   := ('*' | '&') unary | postfix
//   postfix := primary ( '.' id | '->' id | '[' unary ']' )*
//   primary := id | num | '(' unary ')'

function parse(input: string): Node | undefined {
  const tokens = tokenize(input);
  if (!tokens || tokens.length === 0) return undefined;
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const isPunct = (v: Punct) => {
    const tok = peek();
    return tok?.t === "punct" && tok.v === v;
  };

  function parseUnary(): Node | undefined {
    if (isPunct("*")) {
      pos++;
      const obj = parseUnary();
      return obj && { kind: "deref", obj };
    }
    if (isPunct("&")) {
      pos++;
      const obj = parseUnary();
      return obj && { kind: "addr", obj };
    }
    return parsePostfix();
  }

  function parsePostfix(): Node | undefined {
    let node = parsePrimary();
    if (!node) return undefined;
    for (;;) {
      if (isPunct(".") || isPunct("->")) {
        const arrow = (peek() as { v: Punct }).v === "->";
        pos++;
        const tok = peek();
        if (tok?.t !== "id") return undefined;
        pos++;
        node = arrow
          ? { kind: "arrow", obj: node, field: tok.v }
          : { kind: "member", obj: node, field: tok.v };
        continue;
      }
      if (isPunct("[")) {
        pos++;
        const index = parseUnary();
        if (!index || !isPunct("]")) return undefined;
        pos++;
        node = { kind: "index", obj: node, index };
        continue;
      }
      break;
    }
    return node;
  }

  function parsePrimary(): Node | undefined {
    const tok = peek();
    if (!tok) return undefined;
    if (tok.t === "punct" && tok.v === "(") {
      pos++;
      const inner = parseUnary();
      if (!inner || !isPunct(")")) return undefined;
      pos++;
      return inner;
    }
    if (tok.t === "id") {
      pos++;
      return { kind: "name", name: tok.v };
    }
    if (tok.t === "num") {
      pos++;
      return { kind: "num", value: tok.v };
    }
    return undefined;
  }

  const node = parseUnary();
  if (!node || pos !== tokens.length) return undefined; // trailing tokens => not a valid C expression
  return node;
}

// --- Evaluation result types ---

type LValue = { kind: "lvalue"; address: number; type: TypeDescriptor };
type IntValue = { kind: "int"; value: number };
type AddressOf = { kind: "addressOf"; address: number; pointeeTypeName: string };
type EvalResult = LValue | IntValue | AddressOf;

// A type mismatch / unresolved name aborts evaluation; caught at the top → undefined (fallback).
class EvalError extends Error {}

export class CExpressionEvaluator {
  constructor(
    private vAmiga: VAmiga,
    private sourceMap: SourceMap,
    private variablesManager: VariablesManager,
  ) {}

  /**
   * Evaluates a compound C/C++ expression to a DAP evaluate-response body, or `undefined` if the
   * input is not a resolvable C navigation expression (parse failure, unknown name, type mismatch,
   * or a bare numeric literal — left to the assembly path).
   */
  public async evaluateToBody(
    expression: string,
    pc: number | null,
    regs: Map<number, number> | null,
  ): Promise<DebugProtocol.EvaluateResponse["body"] | undefined> {
    const result = await this.evaluate(expression, pc, regs);
    if (!result) return undefined;

    if (result.kind === "lvalue") {
      const { value, variablesReference } = await this.variablesManager.renderLValue(
        result.address,
        result.type,
      );
      return {
        result: value,
        type: result.type.typeName,
        memoryReference: formatHex(result.address),
        variablesReference,
      };
    }
    if (result.kind === "addressOf") {
      return {
        result: formatAddress(result.address, this.sourceMap),
        type: `${result.pointeeTypeName} *`,
        memoryReference: formatHex(result.address),
        variablesReference: 0,
      };
    }
    // Top-level integer result (shouldn't normally occur given the bare-num guard) → fall back.
    return undefined;
  }

  /**
   * Resolves a compound C/C++ expression to a writable lvalue (memory address + type), or
   * `undefined` if it is not an addressable value (a bare literal, `&x`, an unknown name, or a type
   * mismatch). This is the write-target resolver for `setExpression`, sharing the read navigator.
   */
  public async evaluateToLValue(
    expression: string,
    pc: number | null,
    regs: Map<number, number> | null,
  ): Promise<{ address: number; type: TypeDescriptor } | undefined> {
    const result = await this.evaluate(expression, pc, regs);
    if (result?.kind !== "lvalue") return undefined;
    return { address: result.address, type: result.type };
  }

  /**
   * Parses and navigates an expression to an EvalResult, or `undefined` for non-C input (parse
   * failure, a bare numeric literal, unknown name, or type mismatch). Shared by the read
   * (`evaluateToBody`) and write (`evaluateToLValue`) entry points.
   */
  private async evaluate(
    expression: string,
    pc: number | null,
    regs: Map<number, number> | null,
  ): Promise<EvalResult | undefined> {
    const ast = parse(expression);
    if (!ast) return undefined;
    // A bare numeric literal isn't program data — let the assembly path handle it.
    if (ast.kind === "num") return undefined;
    try {
      return await this.evalNode(ast, pc, regs);
    } catch (err) {
      if (err instanceof EvalError) return undefined;
      throw err;
    }
  }

  private async evalNode(
    node: Node,
    pc: number | null,
    regs: Map<number, number> | null,
  ): Promise<EvalResult> {
    switch (node.kind) {
      case "num":
        return { kind: "int", value: node.value };

      case "name": {
        const lv = await this.variablesManager.resolveNameToLValue(node.name, pc, regs);
        if (!lv) throw new EvalError(`unknown variable: ${node.name}`);
        return { kind: "lvalue", address: lv.address, type: lv.type };
      }

      case "member": {
        const obj = this.asLValue(await this.evalNode(node.obj, pc, regs));
        if (obj.type.kind !== "struct")
          throw new EvalError(`'.' applied to non-struct`);
        const field = obj.type.getFields().find((f) => f.name === node.field);
        if (!field) throw new EvalError(`no field '${node.field}'`);
        return { kind: "lvalue", address: obj.address + field.offset, type: field.type };
      }

      case "arrow": {
        const obj = this.asLValue(await this.evalNode(node.obj, pc, regs));
        if (obj.type.kind !== "pointer" || obj.type.pointee.kind !== "struct")
          throw new EvalError(`'->' applied to non-pointer-to-struct`);
        const base = await this.deref32(obj.address);
        const field = obj.type.pointee.getFields().find((f) => f.name === node.field);
        if (!field) throw new EvalError(`no field '${node.field}'`);
        return { kind: "lvalue", address: base + field.offset, type: field.type };
      }

      case "index": {
        const obj = this.asLValue(await this.evalNode(node.obj, pc, regs));
        const idx = await this.asInteger(await this.evalNode(node.index, pc, regs));
        if (obj.type.kind === "array") {
          return {
            kind: "lvalue",
            address: obj.address + idx * obj.type.elementType.byteSize,
            type: obj.type.elementType,
          };
        }
        if (obj.type.kind === "pointer") {
          const base = await this.deref32(obj.address);
          return {
            kind: "lvalue",
            address: base + idx * obj.type.pointee.byteSize,
            type: obj.type.pointee,
          };
        }
        throw new EvalError(`'[]' applied to non-array/pointer`);
      }

      case "deref": {
        const obj = this.asLValue(await this.evalNode(node.obj, pc, regs));
        if (obj.type.kind !== "pointer")
          throw new EvalError(`'*' applied to non-pointer`);
        const base = await this.deref32(obj.address);
        return { kind: "lvalue", address: base, type: obj.type.pointee };
      }

      case "addr": {
        const obj = this.asLValue(await this.evalNode(node.obj, pc, regs));
        return { kind: "addressOf", address: obj.address, pointeeTypeName: obj.type.typeName };
      }
    }
  }

  private asLValue(result: EvalResult): LValue {
    if (result.kind !== "lvalue")
      throw new EvalError(`expected an addressable value`);
    return result;
  }

  private async asInteger(result: EvalResult): Promise<number> {
    if (result.kind === "int") return result.value;
    if (result.kind === "addressOf") return result.address;
    // lvalue: read a scalar (e.g. an int index variable)
    const value = await this.variablesManager.readScalar(result.address, result.type);
    if (value === undefined) throw new EvalError(`index is not a scalar`);
    return value;
  }

  private async deref32(address: number): Promise<number> {
    if (!this.vAmiga.isValidAddress(address))
      throw new EvalError(`dereference of invalid address ${formatHex(address)}`);
    return this.vAmiga.peek32(address);
  }
}
