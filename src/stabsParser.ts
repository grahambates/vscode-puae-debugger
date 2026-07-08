/**
 * Decoder for GNU stabs debug information embedded in Amiga HUNK_DEBUG blocks
 * (magic 0x10b — see amigaHunkParser). Produces a structured StabProgram that
 * amigaHunkSourceMap turns into the shared SourceMap (lines, symbols, scopes,
 * globals, types) — the same shapes the DWARF path builds.
 *
 * Values (function/line/scope addresses) are hunk-relative offsets; the caller
 * adds the hunk's load address. Stabs carries no stack-unwind info, so nothing
 * here feeds SourceMap.debugFrame.
 *
 * @see https://sourceware.org/gdb/current/onlinedocs/stabs.html
 */

import { StabData } from "./amigaHunkParser";
import { TypeDescriptor, FieldDescriptor } from "./sourceMap";

/** stab n_type values (a.out / GNU). */
export const StabType = {
  GSYM: 0x20, // global symbol
  FUN: 0x24, // function name (or, empty name, function size)
  STSYM: 0x26, // initialised static (data)
  LCSYM: 0x28, // uninitialised static (bss)
  MAIN: 0x2a,
  BNSYM: 0x2e, // begin function symbol (marker)
  OPT: 0x3c, // compiler options ("gcc2_compiled.")
  RSYM: 0x40, // register variable
  SLINE: 0x44, // source line
  ENSYM: 0x4e, // end function symbol (marker)
  SO: 0x64, // source file / directory
  LSYM: 0x80, // local variable or type definition
  BINCL: 0x82, // begin include file
  SOL: 0x84, // switch source file (#include)
  PSYM: 0xa0, // function parameter
  EINCL: 0xa2, // end include file
  LBRAC: 0xc0, // left brace (scope open)
  EXCL: 0xc2, // excluded include (BINCL seen before)
  RBRAC: 0xe0, // right brace (scope close)
} as const;

/** One raw nlist record with its resolved string. */
export interface RawStab {
  strx: number;
  type: number;
  other: number;
  desc: number;
  value: number;
  str: string;
}

/** Where a local/parameter/static lives. Frame offsets are relative to A5. */
export type StabLocation =
  | { kind: "frame"; offset: number } // [A5 + offset] (signed)
  | { kind: "register"; reg: number } // m68k reg number (0-7 D, 8-15 A)
  | { kind: "static"; address: number } // absolute hunk-relative address
  | { kind: "unknown" };

export interface StabVariable {
  name: string;
  /** Type key into the program's type table (resolve via resolveType). */
  typeKey: string;
  location: StabLocation;
}

export interface StabScope {
  /** Hunk-relative range from N_LBRAC / N_RBRAC. */
  start: number;
  end: number;
  vars: StabVariable[];
}

export interface StabFunction {
  name: string;
  /** Hunk-relative start offset (N_FUN n_value). */
  address: number;
  /** Byte length, from the trailing empty-name N_FUN (if present). */
  size?: number;
  /** Stabs type reference for the return type (text after `F`/`f`). */
  returnTypeRef: string;
  /** `F` = external/global, `f` = static/local. */
  isGlobal: boolean;
  /** Source file in effect at the function. */
  file: string;
  params: StabVariable[];
  scopes: StabScope[];
}

export interface StabLine {
  line: number;
  /** Hunk-relative offset (N_SLINE n_value). */
  address: number;
  file: string;
}

export interface StabGlobal {
  name: string;
  typeKey: string;
  /** Address for file-statics (STSYM/LCSYM). N_GSYM globals carry no address —
   *  resolve those by name via the linker symbol table. */
  address?: number;
  file: string;
}

export interface StabProgram {
  /** Source files seen (from N_SO / N_SOL), normalised order of appearance. */
  files: string[];
  functions: StabFunction[];
  lines: StabLine[];
  globals: StabGlobal[];
  /** Resolve a type key (from a StabVariable/return type) to a TypeDescriptor. */
  resolveType(typeKey: string): TypeDescriptor;
}

/**
 * Decode a raw stabs section (nlist table + string table) into records.
 * The nlist is big-endian, 12 bytes/entry.
 */
export function decodeStabs(section: StabData): RawStab[] {
  const { stabs, strings } = section;
  const count = Math.floor(stabs.length / 12);
  const out: RawStab[] = [];
  for (let i = 0; i < count; i++) {
    const o = i * 12;
    const strx = stabs.readUInt32BE(o);
    out.push({
      strx,
      type: stabs.readUInt8(o + 4),
      other: stabs.readUInt8(o + 5),
      desc: stabs.readUInt16BE(o + 6),
      value: stabs.readUInt32BE(o + 8),
      str: readStabString(strings, strx),
    });
  }
  return out;
}

/** Read a NUL-terminated string from the string table at byte `offset`. */
function readStabString(strings: Buffer, offset: number): string {
  if (offset <= 0 || offset >= strings.length) return "";
  let end = offset;
  while (end < strings.length && strings[end] !== 0) end++;
  return strings.toString("latin1", offset, end);
}

/**
 * A stab string can be split across consecutive entries when it ends in a
 * backslash (GCC wraps long type definitions). Join such continuations.
 */
function joinContinuations(stabs: RawStab[]): RawStab[] {
  const out: RawStab[] = [];
  for (let i = 0; i < stabs.length; i++) {
    const s = stabs[i];
    if (s.str.endsWith("\\")) {
      let joined = s.str.slice(0, -1);
      let j = i + 1;
      while (j < stabs.length) {
        const cont = stabs[j].str;
        if (cont.endsWith("\\")) {
          joined += cont.slice(0, -1);
          j++;
        } else {
          joined += cont;
          break;
        }
      }
      out.push({ ...s, str: joined });
      i = j;
    } else {
      out.push(s);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Type-string grammar
//
// A stabs type string defines/references types by number, e.g.
//   int:t1=r1;-2147483648;2147483647;      range (base type)
//   Foo:t20=*21                            pointer to type 21
//   Bar:T30=s8a:1,0,32;b:1,32,32;;         struct, size 8, two int fields
//   arr:t40=ar1;0;9;1                       array [0..9] of type 1
//   e:T50=eA:0,B:1,;                        enum
//   p:T60=xs__foo:                          cross-reference to struct __foo
// Type numbers are either `N` or `(file,N)`; both are used verbatim as a key.
// ---------------------------------------------------------------------------

type TypeNode =
  | { kind: "ref"; ref: string }
  | { kind: "range"; ref: string; lo: string; hi: string }
  | { kind: "pointer"; ref: string }
  | { kind: "array"; index: string; elem: string }
  | {
      kind: "struct" | "union";
      size: number;
      fields: { name: string; type: string; bitOffset: number; bitSize: number }[];
    }
  | { kind: "enum"; values: { name: string; value: number }[] }
  | { kind: "xref"; tag: string; name: string }
  | { kind: "function"; returns: string }
  | { kind: "qualified"; ref: string }
  | { kind: "sized"; ref: string; byteSize: number }
  | { kind: "unknown" };

/** Standard m68k C type sizes, keyed by the typedef name. */
const NAMED_SIZES: Record<string, number> = {
  void: 0,
  char: 1,
  "signed char": 1,
  "unsigned char": 1,
  short: 2,
  "short int": 2,
  "short unsigned int": 2,
  int: 4,
  "unsigned int": 4,
  long: 4,
  "long int": 4,
  "long unsigned int": 4,
  "long long int": 8,
  "long long unsigned int": 8,
  float: 4,
  double: 8,
  "long double": 12,
  _Bool: 1,
};

/**
 * Accumulates stabs type definitions (keyed by type number) and resolves them
 * to the shared TypeDescriptor lazily (structs keep their fields behind a
 * closure so recursive/self-referential types don't loop).
 */
class StabTypeTable {
  private defs = new Map<string, TypeNode>();
  private names = new Map<string, string>(); // type key -> declared name
  private anonCounter = 0;
  private resolving = new Set<string>();
  private cache = new Map<string, TypeDescriptor>();

  /** Register a type name (from a `t`/`T` symbol descriptor). */
  setName(key: string, name: string): void {
    if (name && !this.names.has(key)) this.names.set(key, name);
  }

  /**
   * Parse a type reference/definition starting at `s[pos]`, registering any
   * inline definitions. Returns [typeKey, nextPos]. Defensive: on any parse
   * error the caller catches and the type degrades to `unknown`.
   */
  parseRef(s: string, pos: number): [string, number] {
    const r = new Cursor(s, pos);
    const key = this.parseTypeRef(r);
    return [key, r.pos];
  }

  private parseTypeRef(r: Cursor): string {
    const key = this.readTypeNumber(r);
    if (r.peek() === "=") {
      r.next();
      const node = this.parseTypeDef(r);
      if (!this.defs.has(key)) this.defs.set(key, node);
    }
    return key;
  }

  /** A type at a position that may be a ref (number) or a bare definition. */
  private parseType(r: Cursor): string {
    const c = r.peek();
    if (c === "(" || c === "-" || (c >= "0" && c <= "9")) {
      return this.parseTypeRef(r);
    }
    const key = `#${this.anonCounter++}`;
    this.defs.set(key, this.parseTypeDef(r));
    return key;
  }

  private readTypeNumber(r: Cursor): string {
    if (r.peek() === "(") {
      // (file,type)
      let s = r.next(); // '('
      while (!r.eof() && r.peek() !== ")") s += r.next();
      if (r.peek() === ")") s += r.next();
      return s;
    }
    let s = "";
    if (r.peek() === "-") s += r.next();
    while (!r.eof() && r.peek() >= "0" && r.peek() <= "9") s += r.next();
    return s;
  }

  private parseTypeDef(r: Cursor): TypeNode {
    const c = r.peek();
    // Chained ref / alias (e.g. 42=*43 → 42's body is the ref 43 with its def).
    if (c === "(" || c === "-" || (c >= "0" && c <= "9")) {
      return { kind: "ref", ref: this.parseTypeRef(r) };
    }
    switch (c) {
      case "r": {
        r.next();
        const ref = this.readTypeNumber(r);
        r.expect(";");
        const lo = r.readUntil(";");
        const hi = r.readUntil(";");
        return { kind: "range", ref, lo, hi };
      }
      case "*":
        r.next();
        return { kind: "pointer", ref: this.parseType(r) };
      case "a": {
        r.next();
        const index = this.parseType(r);
        const elem = this.parseType(r);
        return { kind: "array", index, elem };
      }
      case "s":
      case "u": {
        const kind = c === "s" ? "struct" : "union";
        r.next();
        const size = parseInt(r.readWhileDigits(), 10) || 0;
        const fields: {
          name: string;
          type: string;
          bitOffset: number;
          bitSize: number;
        }[] = [];
        while (!r.eof() && r.peek() !== ";") {
          const name = r.readUntil(":");
          const type = this.parseType(r);
          r.expect(",");
          const bitOffset = parseInt(r.readUntil(","), 10) || 0;
          const bitSize = parseInt(r.readUntil(";"), 10) || 0;
          fields.push({ name, type, bitOffset, bitSize });
        }
        if (r.peek() === ";") r.next();
        return { kind, size, fields };
      }
      case "e": {
        r.next();
        const values: { name: string; value: number }[] = [];
        while (!r.eof() && r.peek() !== ";") {
          const name = r.readUntil(":");
          const value = parseInt(r.readUntilAny(",;"), 10) || 0;
          if (r.peek() === ",") r.next();
          values.push({ name, value });
        }
        if (r.peek() === ";") r.next();
        return { kind: "enum", values };
      }
      case "x": {
        r.next();
        const tag = r.next(); // s | u | e
        const name = r.readUntil(":");
        return { kind: "xref", tag, name };
      }
      case "@": {
        // Type attributes, e.g. "@s128;" (size in bits). Consume attrs, then
        // the real definition follows.
        r.next();
        let byteSize = 0;
        while (r.peek() === "s" || r.peek() === "a") {
          const attr = r.next();
          const num = parseInt(r.readUntil(";"), 10) || 0;
          if (attr === "s") byteSize = num >> 3;
        }
        const ref = this.parseType(r);
        return byteSize ? { kind: "sized", ref, byteSize } : { kind: "ref", ref };
      }
      case "k": // const
      case "B": // volatile
      case "V": // volatile
        r.next();
        return { kind: "qualified", ref: this.parseType(r) };
      case "f":
        r.next();
        return { kind: "function", returns: this.parseType(r) };
      default:
        return { kind: "unknown" };
    }
  }

  /** Resolve a type key to a TypeDescriptor (memoised, recursion-safe). */
  resolve(key: string): TypeDescriptor {
    const cached = this.cache.get(key);
    if (cached) return cached;
    const name = this.names.get(key) ?? "";
    if (this.resolving.has(key)) {
      // Cycle (e.g. struct -> pointer -> same struct): return a light stand-in.
      return { kind: "unknown", typeName: name || `type${key}`, byteSize: 4 };
    }
    this.resolving.add(key);
    const desc = this.resolveNode(key, name);
    this.resolving.delete(key);
    this.cache.set(key, desc);
    return desc;
  }

  private resolveNode(key: string, name: string): TypeDescriptor {
    const node = this.defs.get(key);
    if (!node) {
      return { kind: "unknown", typeName: name || `type${key}`, byteSize: 4 };
    }
    switch (node.kind) {
      case "ref": {
        const inner = this.resolve(node.ref);
        return name ? { ...inner, typeName: name } : inner;
      }
      case "sized": {
        const inner = this.resolve(node.ref);
        return { ...inner, typeName: name || inner.typeName, byteSize: node.byteSize };
      }
      case "qualified": {
        const inner = this.resolve(node.ref);
        return name ? { ...inner, typeName: name } : inner;
      }
      case "range":
        return { kind: "primitive", typeName: name || "int", byteSize: rangeByteSize(name, node) };
      case "enum":
        return { kind: "primitive", typeName: name || "enum", byteSize: 4 };
      case "pointer": {
        const pointee = this.resolve(node.ref);
        return {
          kind: "pointer",
          typeName: name || `${pointee.typeName} *`,
          byteSize: 4,
          pointee,
        };
      }
      case "array": {
        const elementType = this.resolve(node.elem);
        const count = this.arrayCount(node.index);
        return {
          kind: "array",
          typeName: name || `${elementType.typeName}[${count}]`,
          byteSize: elementType.byteSize * count,
          elementCount: count,
          elementType,
        };
      }
      case "struct":
      case "union": {
        const fields = node.fields;
        return {
          kind: "struct",
          typeName: name || (node.kind === "union" ? "union" : "struct"),
          byteSize: node.size,
          getFields: (): FieldDescriptor[] =>
            fields.map((f) => ({
              name: f.name,
              offset: f.bitOffset >> 3,
              type: this.resolve(f.type),
            })),
        };
      }
      case "xref":
        return { kind: "unknown", typeName: name || node.name, byteSize: 4 };
      case "function":
        return { kind: "unknown", typeName: name || "function", byteSize: 0 };
      default:
        return { kind: "unknown", typeName: name || `type${key}`, byteSize: 4 };
    }
  }

  private arrayCount(indexKey: string): number {
    const node = this.defs.get(indexKey);
    if (node?.kind === "range") {
      const lo = parseStabInt(node.lo);
      const hi = parseStabInt(node.hi);
      const n = hi - lo + 1;
      return n > 0 ? n : 0;
    }
    return 0;
  }
}

/** Minimal cursor over a type string. */
class Cursor {
  constructor(
    private s: string,
    public pos: number = 0,
  ) {}
  peek(): string {
    return this.pos < this.s.length ? this.s[this.pos] : "";
  }
  next(): string {
    return this.pos < this.s.length ? this.s[this.pos++] : "";
  }
  eof(): boolean {
    return this.pos >= this.s.length;
  }
  expect(ch: string): void {
    if (this.peek() === ch) this.pos++;
  }
  readUntil(ch: string): string {
    let out = "";
    while (!this.eof() && this.peek() !== ch) out += this.next();
    if (this.peek() === ch) this.next();
    return out;
  }
  readUntilAny(chars: string): string {
    let out = "";
    while (!this.eof() && !chars.includes(this.peek())) out += this.next();
    return out;
  }
  readWhileDigits(): string {
    let out = "";
    while (!this.eof() && this.peek() >= "0" && this.peek() <= "9") out += this.next();
    return out;
  }
}

/** Parse a stabs integer bound (may be decimal, or octal with a leading 0). */
function parseStabInt(s: string): number {
  if (!s) return 0;
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  let v: number;
  if (body.length > 1 && body[0] === "0") v = parseInt(body, 8);
  else v = parseInt(body, 10);
  if (!Number.isFinite(v)) v = 0;
  return neg ? -v : v;
}

function rangeByteSize(name: string, node: { lo: string; hi: string }): number {
  if (name && NAMED_SIZES[name] !== undefined) return NAMED_SIZES[name];
  const lo = parseStabInt(node.lo);
  const hi = parseStabInt(node.hi);
  // GCC float encoding: `r<self>;<bytesize>;0;` (hi == 0, lo == size in bytes).
  if (hi === 0 && lo > 0 && lo <= 16) return lo;
  const max = Math.max(Math.abs(lo), Math.abs(hi));
  if (max <= 0x7f) return 1;
  if (max <= 0x7fff) return 2;
  return 4;
}

/** Interpret a u32 n_value as a signed 32-bit frame offset. */
function asSigned(v: number): number {
  return v > 0x7fffffff ? v - 0x100000000 : v;
}

/**
 * Interpret the stabs stream into files, functions (with params/scopes),
 * line records, globals and a resolvable type table.
 */
export function parseStabs(sections: StabData[]): StabProgram {
  const files: string[] = [];
  const functions: StabFunction[] = [];
  const lines: StabLine[] = [];
  const globals: StabGlobal[] = [];
  const types = new StabTypeTable();

  const noteFile = (f: string) => {
    if (f && !files.includes(f)) files.push(f);
  };

  // Parse `name:<descriptor><type...>` — registers any inline type definitions
  // and, for a `t`/`T` typedef, names the type. Returns the parsed variable
  // descriptor (or undefined for a pure type/tag definition).
  const parseSymbol = (
    str: string,
    value: number,
  ): { name: string; typeKey: string; location: StabLocation } | undefined => {
    const colon = str.indexOf(":");
    if (colon < 0) return undefined;
    const name = str.slice(0, colon);
    const rest = str.slice(colon + 1);
    const d = rest[0];

    // Descriptor letter (if any), then the type reference starts.
    let typeStart = colon + 1;
    let descriptor = "";
    if (d && !(d >= "0" && d <= "9") && d !== "-" && d !== "(") {
      descriptor = d;
      typeStart = colon + 2;
    }
    const [typeKey] = types.parseRef(str, typeStart);

    switch (descriptor) {
      case "t": // typedef
      case "T": // struct/union/enum tag
        types.setName(typeKey, name);
        return undefined;
      case "p": // parameter (stack)
        return { name, typeKey, location: { kind: "frame", offset: asSigned(value) } };
      case "r": // register variable
        return { name, typeKey, location: { kind: "register", reg: value } };
      case "G": // global (address resolved by symbol name)
        return { name, typeKey, location: { kind: "unknown" } };
      case "S": // file-static (initialised)
      case "V": // procedure-local static
        return { name, typeKey, location: { kind: "static", address: value } };
      case "": // plain local variable (auto, on stack)
        return { name, typeKey, location: { kind: "frame", offset: asSigned(value) } };
      default:
        return { name, typeKey, location: { kind: "unknown" } };
    }
  };

  for (const section of sections) {
    const stabs = joinContinuations(decodeStabs(section));

    // Current source context. N_SO sets the compilation dir (trailing '/') then
    // the main file; N_SOL switches to an include file for subsequent records.
    let mainFile = "";
    let currentFile = "";
    let lastFunc: StabFunction | undefined;
    // Open lexical scopes (N_LBRAC/N_RBRAC), innermost last.
    let scopeStack: StabScope[] = [];

    for (const s of stabs) {
      switch (s.type) {
        case StabType.SO: {
          if (s.str === "") {
            mainFile = currentFile = "";
            lastFunc = undefined;
            scopeStack = [];
          } else if (s.str.endsWith("/")) {
            // compilation directory — ignored (paths are absolute already)
          } else {
            mainFile = currentFile = s.str;
            noteFile(currentFile);
          }
          break;
        }
        case StabType.SOL: {
          currentFile = s.str || mainFile;
          noteFile(currentFile);
          break;
        }
        case StabType.FUN: {
          const colon = s.str.indexOf(":");
          if (s.str === "" || colon < 0) {
            if (lastFunc && lastFunc.size === undefined) lastFunc.size = s.value;
            break;
          }
          const name = s.str.slice(0, colon);
          const desc = s.str.slice(colon + 1); // "F17" (global) or "f17" (static)
          const isGlobal = desc[0] === "F";
          // The type ref after F/f may define the return type inline.
          const [returnTypeRef] = types.parseRef(s.str, colon + 2);
          const fn: StabFunction = {
            name,
            address: s.value,
            returnTypeRef,
            isGlobal,
            file: currentFile,
            params: [],
            scopes: [],
          };
          functions.push(fn);
          lastFunc = fn;
          scopeStack = [];
          break;
        }
        case StabType.SLINE:
          lines.push({ line: s.desc, address: s.value, file: currentFile });
          break;
        case StabType.PSYM: {
          const v = parseSymbol(s.str, s.value);
          if (v && lastFunc) lastFunc.params.push(v as StabVariable);
          break;
        }
        case StabType.LSYM:
        case StabType.RSYM: {
          const v = parseSymbol(s.str, s.value);
          if (v) {
            const scope = scopeStack[scopeStack.length - 1];
            if (scope) scope.vars.push(v as StabVariable);
            else if (lastFunc) lastFunc.params.push(v as StabVariable);
          }
          break;
        }
        case StabType.GSYM: {
          const v = parseSymbol(s.str, s.value);
          if (v) globals.push({ name: v.name, typeKey: v.typeKey, file: currentFile });
          break;
        }
        case StabType.STSYM:
        case StabType.LCSYM: {
          const v = parseSymbol(s.str, s.value);
          if (v)
            globals.push({
              name: v.name,
              typeKey: v.typeKey,
              address: s.value,
              file: currentFile,
            });
          break;
        }
        case StabType.LBRAC: {
          const scope: StabScope = { start: s.value, end: s.value, vars: [] };
          scopeStack.push(scope);
          if (lastFunc) lastFunc.scopes.push(scope);
          break;
        }
        case StabType.RBRAC: {
          const scope = scopeStack.pop();
          if (scope) scope.end = s.value;
          break;
        }
        default:
          break;
      }
    }
  }

  return {
    files,
    functions,
    lines,
    globals,
    resolveType: (key: string) => types.resolve(key),
  };
}
