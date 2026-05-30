// Converted to Typescript from: https://github.com/rjaegers/demangler-js 
// (c) 2018 Arthur Mendes, MIT License

// Demangler for C++ function names mangled according to the Itanium C++ ABI
// Material: https://itanium-cxx-abi.github.io/cxx-abi/abi.html#mangling

interface Qualifiers {
  isRef: boolean;
  isRValueRef: boolean;
  isRestrict: boolean;
  isVolatile: boolean;
  isConst: boolean;
  numPtr: number;
}

interface ParsedType {
  typeNode: TypeNode | null;
  remaining: string;
}

interface ParsedName {
  name: string;
  str: string;
  isConst: boolean;
  templateArgs: TypeNode[];
}

interface ParsedSegment {
  segment: string;
  remaining: string;
}

interface ParseContext {
  char: string;
  remaining: string;
  qualifiers: Qualifiers;
  substitutions: TypeNode[];
  templateParams: TypeNode[];
}

interface TypeParser {
  matches: (char: string) => boolean;
  parse: (ctx: ParseContext) => ParsedType;
}

interface SegmentParser {
  matches: (str: string) => boolean;
  parse: (str: string, ctx?: { className: string }) => ParsedSegment;
}

// ---------------------------------------------------------------------------
// Type node hierarchy
// ---------------------------------------------------------------------------

abstract class TypeNode {
  abstract accept(visitor: TypeVisitor): string;
}

class NamedType extends TypeNode {
  constructor(public readonly name: string) { super(); }
  accept(visitor: TypeVisitor): string { return visitor.visitNamedType(this); }
}

class QualifiedType extends TypeNode {
  public readonly isConst: boolean;
  public readonly isVolatile: boolean;
  public readonly isRestrict: boolean;
  public readonly numPtr: number;
  public readonly isRef: boolean;
  public readonly isRValueRef: boolean;

  constructor(public readonly baseType: TypeNode, qualifiers: Partial<Qualifiers> = {}) {
    super();
    this.isConst     = qualifiers.isConst     ?? false;
    this.isVolatile  = qualifiers.isVolatile  ?? false;
    this.isRestrict  = qualifiers.isRestrict  ?? false;
    this.numPtr      = qualifiers.numPtr      ?? 0;
    this.isRef       = qualifiers.isRef       ?? false;
    this.isRValueRef = qualifiers.isRValueRef ?? false;
  }

  accept(visitor: TypeVisitor): string { return visitor.visitQualifiedType(this); }
}

class ArrayType extends TypeNode {
  constructor(
    public readonly elementType: TypeNode,
    public readonly dimensions: string[] = [],
  ) { super(); }
  accept(visitor: TypeVisitor): string { return visitor.visitArrayType(this); }
}

class FunctionPointerType extends TypeNode {
  constructor(
    public readonly returnType: TypeNode,
    public readonly paramTypes: TypeNode[] = [],
  ) { super(); }
  accept(visitor: TypeVisitor): string { return visitor.visitFunctionPointerType(this); }
}

class MemberFunctionPointerType extends TypeNode {
  constructor(
    public readonly classType: TypeNode,
    public readonly returnType: TypeNode,
    public readonly paramTypes: TypeNode[] = [],
    public readonly isConst: boolean = false,
  ) { super(); }
  accept(visitor: TypeVisitor): string { return visitor.visitMemberFunctionPointerType(this); }
}

class MemberPointerType extends TypeNode {
  constructor(
    public readonly classType: TypeNode,
    public readonly memberType: TypeNode,
  ) { super(); }
  accept(visitor: TypeVisitor): string { return visitor.visitMemberPointerType(this); }
}

class TemplateType extends TypeNode {
  constructor(
    public readonly baseName: string,
    public readonly templateArgs: TypeNode[] = [],
  ) { super(); }
  accept(visitor: TypeVisitor): string { return visitor.visitTemplateType(this); }
}

// ---------------------------------------------------------------------------
// Visitor
// ---------------------------------------------------------------------------

abstract class TypeVisitor {
  abstract visitNamedType(node: NamedType): string;
  abstract visitQualifiedType(node: QualifiedType): string;
  abstract visitArrayType(node: ArrayType): string;
  abstract visitFunctionPointerType(node: FunctionPointerType): string;
  abstract visitMemberFunctionPointerType(node: MemberFunctionPointerType): string;
  abstract visitMemberPointerType(node: MemberPointerType): string;
  abstract visitTemplateType(node: TemplateType): string;
}

class FormatVisitor extends TypeVisitor {
  visitNamedType(node: NamedType): string {
    return node.name;
  }

  visitQualifiedType(node: QualifiedType): string {
    let result = '';
    if (node.isConst)   result += 'const ';
    if (node.isVolatile) result += 'volatile ';
    result += node.baseType.accept(this);
    result += this.formatPointers(node);
    if (node.isRestrict) result += ' restrict';
    if (node.isRef)      result += '&';
    if (node.isRValueRef) result += '&&';
    return result;
  }

  visitArrayType(node: ArrayType): string {
    return node.elementType.accept(this) + node.dimensions.map(d => `[${d}]`).join('');
  }

  visitFunctionPointerType(node: FunctionPointerType): string {
    return `${node.returnType.accept(this)} (*)(${this.formatParameterList(node.paramTypes)})`;
  }

  visitMemberFunctionPointerType(node: MemberFunctionPointerType): string {
    return `${node.returnType.accept(this)} (${node.classType.accept(this)}::*)(${this.formatParameterList(node.paramTypes)})${node.isConst ? ' const' : ''}`;
  }

  visitMemberPointerType(node: MemberPointerType): string {
    return `${node.memberType.accept(this)} ${node.classType.accept(this)}::**`;
  }

  visitTemplateType(node: TemplateType): string {
    return `${node.baseName}<${node.templateArgs.map(a => a.accept(this)).join(', ')}>`;
  }

  private formatPointers(node: QualifiedType): string {
    if (node.baseType instanceof FunctionPointerType ||
        node.baseType instanceof MemberFunctionPointerType ||
        node.baseType instanceof MemberPointerType) {
      return '';
    }
    return '*'.repeat(node.numPtr);
  }

  formatParameterList(types: TypeNode[]): string {
    if (types.length === 1 && types[0].accept(this) === 'void') return '';
    return types.map(t => t.accept(this)).join(', ');
  }

  formatFunctionSignature(
    functionName: string,
    parameterTypes: TypeNode[],
    isConst = false,
    returnType: TypeNode | null = null,
  ): string {
    const params = this.formatParameterList(parameterTypes);
    const ret = returnType ? `${returnType.accept(this)} ` : '';
    return `${ret}${functionName}(${params})${isConst ? ' const' : ''}`;
  }
}

// ---------------------------------------------------------------------------
// Operator name table
// ---------------------------------------------------------------------------

const OPERATOR_NAMES: Record<string, string> = {
  nw: 'operator new',   na: 'operator new[]',
  dl: 'operator delete', da: 'operator delete[]',
  ps: 'operator+',  ng: 'operator-',  ad: 'operator&',  de: 'operator*',
  co: 'operator~',  pl: 'operator+',  mi: 'operator-',  ml: 'operator*',
  dv: 'operator/',  rm: 'operator%',  an: 'operator&',  or: 'operator|',
  eo: 'operator^',  aS: 'operator=',  pL: 'operator+=', mI: 'operator-=',
  mL: 'operator*=', dV: 'operator/=', rM: 'operator%=', aN: 'operator&=',
  oR: 'operator|=', eO: 'operator^=', ls: 'operator<<', rs: 'operator>>',
  lS: 'operator<<=', rS: 'operator>>=', eq: 'operator==', ne: 'operator!=',
  lt: 'operator<',  gt: 'operator>',  le: 'operator<=', ge: 'operator>=',
  ss: 'operator<=>',nt: 'operator!',  aa: 'operator&&', oo: 'operator||',
  pp: 'operator++', mm: 'operator--', cm: 'operator,',  pm: 'operator->*',
  pt: 'operator->',  cl: 'operator()', ix: 'operator[]', qu: 'operator?',
  cv: 'operator',   li: 'operator""',
};

function getOperatorName(code: string): string | null {
  return OPERATOR_NAMES[code] ?? null;
}

// ---------------------------------------------------------------------------
// Basic type table
// ---------------------------------------------------------------------------

const BASIC_TYPES: Record<string, string> = {
  v: 'void',        w: 'wchar_t',       b: 'bool',
  c: 'char',        a: 'signed char',   h: 'unsigned char',
  s: 'short',       t: 'unsigned short',i: 'int',
  j: 'unsigned int',l: 'long',          m: 'unsigned long',
  x: 'long long',   y: 'unsigned long long', n: '__int128',
  o: 'unsigned __int128', f: 'float',   d: 'double',
  e: 'long double', g: '__float128',    z: '...',
};

// ---------------------------------------------------------------------------
// Parser helpers
// ---------------------------------------------------------------------------

function parseVendorPostfix(name: string): { remaining: string; vendorPostfix: string | null } {
  const dotIndex = name.indexOf('.');
  if (dotIndex < 0) return { remaining: name, vendorPostfix: null };
  return { remaining: name.slice(0, dotIndex), vendorPostfix: name.slice(dotIndex) };
}

function parseSpecialName(encoding: string): string | null {
  if (encoding.length < 2) return null;
  const prefix = encoding.slice(0, 2);
  const remaining = encoding.slice(2);
  const specialNames: Record<string, string> = {
    TI: 'typeinfo for ',     TS: 'typeinfo name for ',
    TV: 'vtable for ',       TT: 'VTT for ',
    TC: 'construction vtable for ', GV: 'guard variable for ',
    TH: 'TLS init function for ',  TW: 'TLS wrapper function for ',
  };
  const specialPrefix = specialNames[prefix];
  if (!specialPrefix) return null;
  const { name: typeName } = parseEncodedName(remaining);
  return `${specialPrefix}${typeName}`;
}

function parseLengthPrefixed(str: string): { value: string; remaining: string } {
  const m = /(\d+)/.exec(str);
  if (!m?.[0]) return { value: '', remaining: str };
  const length = parseInt(m[0], 10);
  const afterLength = str.slice(m[0].length);
  return { value: afterLength.slice(0, length), remaining: afterLength.slice(length) };
}

function buildSubstitutions(functionName: string, templateParams: TypeNode[]): TypeNode[] {
  const substitutions: TypeNode[] = [];
  if (functionName.includes('::')) {
    const lastColon = functionName.lastIndexOf('::');
    substitutions.push(new NamedType(functionName.substring(0, lastColon)));
  }
  return [...substitutions, ...templateParams];
}

function parseReturnTypeIfNeeded(
  remaining: string,
  templateParams: TypeNode[],
  substitutions: TypeNode[],
): { returnType: TypeNode | null; remaining: string } {
  if (templateParams.length > 0 && remaining.length > 0) {
    const result = parseSingleType(remaining, substitutions, templateParams);
    return { returnType: result.typeNode, remaining: result.remaining };
  }
  return { returnType: null, remaining };
}

// ---------------------------------------------------------------------------
// Name segment parsers
// ---------------------------------------------------------------------------

const SEGMENT_PARSERS: SegmentParser[] = [
  {
    matches: (str) => /^C[123]/.test(str),
    parse: (str, ctx) => ({ segment: ctx?.className ?? '', remaining: str.slice(2) }),
  },
  {
    matches: (str) => /^D[012]/.test(str),
    parse: (str, ctx) => ({ segment: '~' + (ctx?.className ?? ''), remaining: str.slice(2) }),
  },
  {
    matches: (str) => /^[a-z][a-zA-Z]/.test(str) && getOperatorName(str.slice(0, 2)) !== null,
    parse: (str) => ({ segment: getOperatorName(str.slice(0, 2))!, remaining: str.slice(2) }),
  },
  {
    matches: () => true,
    parse: (str) => {
      const { value, remaining } = parseLengthPrefixed(str);
      return { segment: value === '_GLOBAL__N_1' ? '(anonymous namespace)' : value, remaining };
    },
  },
];

function parseNameSegment(str: string, className = ''): ParsedSegment {
  for (const parser of SEGMENT_PARSERS) {
    if (parser.matches(str)) return parser.parse(str, { className });
  }
  return { segment: '', remaining: str };
}

function parseConstQualifier(str: string): { isConst: boolean; remaining: string } {
  return str[0] === 'K'
    ? { isConst: true, remaining: str.slice(1) }
    : { isConst: false, remaining: str };
}

function parseStdPrefix(originalStr: string, remaining: string): { segments: string[]; remaining: string } {
  return originalStr.slice(1, 3) === 'St'
    ? { segments: ['std'], remaining: remaining.replace('St', '') }
    : { segments: [], remaining };
}

function parseSegmentWithTemplate(remaining: string, className: string): ParsedSegment {
  const { segment, remaining: afterSegment } = parseNameSegment(remaining, className);
  if (!segment) return { segment: '', remaining };
  const { args, str } = parseTemplateArgs(afterSegment, []);
  if (!args) return { segment, remaining: afterSegment };
  const visitor = new FormatVisitor();
  return { segment: new TemplateType(segment, args).accept(visitor), remaining: str };
}

const isValidSegmentStart = (char: string): boolean => /[\da-zCD]/.test(char);
const isNamespaceTerminator = (char: string): boolean => char === 'E' || char === 'I';

function getCurrentClassName(segments: string[]): string {
  return segments.length > 0 ? segments[segments.length - 1].replace(/^operator.*/, '').trim() : '';
}

function parseNamespaceSegments(remaining: string, initialSegments: string[] = []): { segments: string[]; remaining: string } {
  const segments = [...initialSegments];
  while (remaining.length > 0) {
    if (isNamespaceTerminator(remaining[0]) || !isValidSegmentStart(remaining[0])) break;
    const className = getCurrentClassName(segments);
    const { segment, remaining: newRemaining } = parseSegmentWithTemplate(remaining, className);
    if (!segment) break;
    segments.push(segment);
    remaining = newRemaining;
  }
  return { segments, remaining };
}

function parseEncodedName(str: string): ParsedName {
  if (str[0] !== 'N') {
    const { segment, remaining } = parseNameSegment(str);
    if (!segment) return { name: '', str, isConst: false, templateArgs: [] };
    const { args, str: after } = parseTemplateArgs(remaining, []);
    if (args && args.length > 0) {
      const visitor = new FormatVisitor();
      return { name: new TemplateType(segment, args).accept(visitor), str: after, isConst: false, templateArgs: args };
    }
    return { name: segment, str: remaining, isConst: false, templateArgs: [] };
  }

  const remaining = str.slice(1);
  const { isConst, remaining: afterConst } = parseConstQualifier(remaining);
  const { segments: stdSegments, remaining: afterStd } = parseStdPrefix(str, afterConst);
  const { segments, remaining: afterSegments } = parseNamespaceSegments(afterStd, stdSegments);
  const finalRemaining = afterSegments[0] === 'E' ? afterSegments.slice(1) : afterSegments;
  return { name: segments.join('::'), str: finalRemaining, isConst, templateArgs: [] };
}

// ---------------------------------------------------------------------------
// Template / type list parsers
// ---------------------------------------------------------------------------

type ParseArgFn = (remaining: string) => { typeNode: TypeNode | null; remaining: string };

function parseArgsUntil(
  remaining: string,
  endChar: string,
  parseArgFn: ParseArgFn,
): { args: TypeNode[]; str: string } {
  const args: TypeNode[] = [];
  while (remaining.length > 0 && remaining[0] !== endChar) {
    const { typeNode, remaining: after } = parseArgFn(remaining);
    if (!typeNode) break;
    args.push(typeNode);
    remaining = after;
  }
  return { args, str: remaining[0] === endChar ? remaining.slice(1) : remaining };
}

function parseTemplateArgs(str: string, substitutions: TypeNode[] = []): { args: TypeNode[] | null; str: string } {
  if (str[0] !== 'I') return { args: null, str };
  const isLengthPrefixed = str[1] !== undefined && /\d/.test(str[1]);
  const parseArgFn: ParseArgFn = isLengthPrefixed
    ? (remaining) => {
        const { value, remaining: after } = parseLengthPrefixed(remaining);
        return { typeNode: value ? new NamedType(value) : null, remaining: after };
      }
    : (remaining) => parseSingleType(remaining, substitutions, []);
  return parseArgsUntil(str.slice(1), 'E', parseArgFn);
}

function parseTemplatePlaceholders(str: string): { templateParams: TypeNode[]; str: string } {
  if (str[0] !== 'I') return { templateParams: [], str };
  const templateParams: TypeNode[] = [];
  let remaining = str.slice(1);
  while (remaining.length > 0 && remaining[0] !== 'E') {
    const { typeNode, remaining: newRemaining } = parseSingleType(remaining, [], []);
    if (typeNode) templateParams.push(typeNode);
    remaining = newRemaining;
  }
  return { templateParams, str: remaining[0] === 'E' ? remaining.slice(1) : remaining };
}

function parseTypeList(encoding: string, substitutions: TypeNode[] = [], templateParams: TypeNode[] = []): { types: TypeNode[] } {
  const types: TypeNode[] = [];
  let remaining = encoding;
  while (remaining.length > 0) {
    const { typeNode, remaining: newRemaining } = parseSingleType(remaining, substitutions, templateParams);
    if (typeNode) {
      types.push(typeNode);
      substitutions.push(typeNode);
      remaining = newRemaining;
    } else {
      remaining = remaining.slice(1);
    }
  }
  return { types };
}

// ---------------------------------------------------------------------------
// Complex type parsers
// ---------------------------------------------------------------------------

function parseArrayType(str: string, substitutions: TypeNode[] = [], templateParams: TypeNode[] = []): ParsedType {
  const sizeMatch = /^(\d+)_/.exec(str);
  if (!sizeMatch) return { typeNode: null, remaining: str };
  const { typeNode: innerType, remaining } = parseSingleType(str.slice(sizeMatch[0].length), substitutions, templateParams);
  if (!innerType) return { typeNode: null, remaining: str };

  const dimensions = [sizeMatch[1]];
  let elementType = innerType;
  let actualInner: TypeNode = innerType;
  if (innerType instanceof QualifiedType) actualInner = innerType.baseType;
  if (actualInner instanceof ArrayType) {
    dimensions.push(...actualInner.dimensions);
    elementType = actualInner.elementType;
  }
  return { typeNode: new ArrayType(elementType, dimensions), remaining };
}

function parseFunctionSignature(
  str: string,
  substitutions: TypeNode[] = [],
  templateParams: TypeNode[] = [],
): { returnType: TypeNode | null; params: TypeNode[]; remaining: string } {
  const { typeNode: returnType, remaining: afterReturn } = parseSingleType(str, substitutions, templateParams);
  if (!returnType) return { returnType: null, params: [], remaining: str };
  const params: TypeNode[] = [];
  let remaining = afterReturn;
  while (remaining.length > 0 && remaining[0] !== 'E') {
    const { typeNode, remaining: afterParam } = parseSingleType(remaining, substitutions, templateParams);
    if (typeNode) params.push(typeNode);
    remaining = afterParam;
  }
  return { returnType, params, remaining: remaining[0] === 'E' ? remaining.slice(1) : remaining };
}

function parseFunctionType(str: string, substitutions: TypeNode[] = [], templateParams: TypeNode[] = []): ParsedType {
  const { returnType, params, remaining } = parseFunctionSignature(str, substitutions, templateParams);
  if (!returnType) return { typeNode: null, remaining: str };
  return { typeNode: new FunctionPointerType(returnType, params), remaining };
}

function parseMemberFunctionPointer(str: string, substitutions: TypeNode[] = [], templateParams: TypeNode[] = []): ParsedType {
  const { typeNode: classType, remaining: afterClass } = parseSingleType(str, substitutions, templateParams);
  if (!classType) return { typeNode: null, remaining: str };
  let remaining = afterClass;
  const isConst = remaining[0] === 'K';
  if (isConst) remaining = remaining.slice(1);
  if (remaining[0] === 'F') {
    const { returnType, params, remaining: afterSig } = parseFunctionSignature(remaining.slice(1), substitutions, templateParams);
    if (!returnType) return { typeNode: null, remaining: str };
    return { typeNode: new MemberFunctionPointerType(classType, returnType, params, isConst), remaining: afterSig };
  }
  const { typeNode: memberType, remaining: afterMember } = parseSingleType(remaining, substitutions, templateParams);
  if (!memberType) return { typeNode: null, remaining: str };
  return { typeNode: new MemberPointerType(classType, memberType), remaining: afterMember };
}

function parseTemplateParam(str: string, templateParams: TypeNode[] = []): ParsedType {
  if (str[0] === '_') return { typeNode: templateParams[0] ?? null, remaining: str.slice(1) };
  const match = /^(\d+)_/.exec(str);
  if (match) {
    const index = parseInt(match[1], 10);
    return { typeNode: index < templateParams.length ? templateParams[index] : null, remaining: str.slice(match[0].length) };
  }
  return { typeNode: null, remaining: str };
}

const STD_TYPE_MAP: Record<string, string> = {
  a: 'std::allocator',
  b: 'std::basic_string',
  s: 'std::basic_string<char, std::char_traits<char>, std::allocator<char>>',
  i: 'std::basic_istream<char, std::char_traits<char>>',
  o: 'std::basic_ostream<char, std::char_traits<char>>',
  d: 'std::basic_iostream<char, std::char_traits<char>>',
};

function parseStdType(str: string, substitutions: TypeNode[] = []): ParsedType {
  if (str[0] === '_') return { typeNode: substitutions[0] ?? null, remaining: str.slice(1) };
  const subMatch = /^(\d+)_/.exec(str);
  if (subMatch) {
    const index = parseInt(subMatch[1], 10);
    return { typeNode: substitutions[index] ?? null, remaining: str.slice(subMatch[0].length) };
  }
  if (str[0] === 't') {
    const { name, str: remaining } = parseEncodedName(str.slice(1));
    return { typeNode: new NamedType(`std::${name}`), remaining };
  }
  if (STD_TYPE_MAP[str[0]]) return { typeNode: new NamedType(STD_TYPE_MAP[str[0]]), remaining: str.slice(1) };
  if (!isNaN(parseInt(str[0], 10))) {
    const { name, str: remaining } = parseEncodedName(str);
    return { typeNode: new NamedType(`std::${name}`), remaining };
  }
  return { typeNode: null, remaining: str };
}

function parseQualifiers(str: string): { qualifiers: Qualifiers; remaining: string } {
  const qualifiers: Qualifiers = { isRef: false, isRValueRef: false, isRestrict: false, isVolatile: false, isConst: false, numPtr: 0 };
  const actions: Record<string, () => void> = {
    R: () => { qualifiers.isRef = true; },
    O: () => { qualifiers.isRValueRef = true; },
    r: () => { qualifiers.isRestrict = true; },
    V: () => { qualifiers.isVolatile = true; },
    K: () => { qualifiers.isConst = true; },
    P: () => { qualifiers.numPtr++; },
  };
  let remaining = str;
  while (actions[remaining[0]]) {
    actions[remaining[0]]();
    remaining = remaining.slice(1);
  }
  return { qualifiers, remaining };
}

// ---------------------------------------------------------------------------
// Type parser dispatch table
// ---------------------------------------------------------------------------

const TYPE_PARSERS: TypeParser[] = [
  {
    matches: (char) => BASIC_TYPES[char] !== undefined,
    parse: (ctx) => ({
      typeNode: new QualifiedType(new NamedType(BASIC_TYPES[ctx.char]), ctx.qualifiers),
      remaining: ctx.remaining,
    }),
  },
  {
    matches: (char) => char === 'A',
    parse: (ctx) => {
      const result = parseArrayType(ctx.remaining, ctx.substitutions, ctx.templateParams);
      return { typeNode: result.typeNode ? new QualifiedType(result.typeNode, ctx.qualifiers) : null, remaining: result.remaining };
    },
  },
  {
    matches: (char) => char === 'F',
    parse: (ctx) => {
      const result = parseFunctionType(ctx.remaining, ctx.substitutions, ctx.templateParams);
      return { typeNode: result.typeNode ? new QualifiedType(result.typeNode, ctx.qualifiers) : null, remaining: result.remaining };
    },
  },
  {
    matches: (char) => char === 'M',
    parse: (ctx) => {
      const result = parseMemberFunctionPointer(ctx.remaining, ctx.substitutions, ctx.templateParams);
      return { typeNode: result.typeNode ? new QualifiedType(result.typeNode, ctx.qualifiers) : null, remaining: result.remaining };
    },
  },
  {
    matches: (char) => char === 'T',
    parse: (ctx) => {
      const result = parseTemplateParam(ctx.remaining, ctx.templateParams);
      return { typeNode: result.typeNode ? new QualifiedType(result.typeNode, ctx.qualifiers) : null, remaining: result.remaining };
    },
  },
  {
    matches: (char) => char === 'S',
    parse: (ctx) => {
      const result = parseStdType(ctx.remaining, ctx.substitutions);
      if (!result.typeNode) return { typeNode: null, remaining: result.remaining };
      const { args, str } = parseTemplateArgs(result.remaining, ctx.substitutions);
      let baseType: TypeNode;
      if (args && args.length > 0) {
        const visitor = new FormatVisitor();
        baseType = new TemplateType(result.typeNode.accept(visitor), args);
      } else {
        baseType = result.typeNode;
      }
      return { typeNode: new QualifiedType(baseType, ctx.qualifiers), remaining: str };
    },
  },
  {
    matches: (char) => !isNaN(parseInt(char, 10)) || char === 'N',
    parse: (ctx) => {
      const { name, str } = parseEncodedName(ctx.char + ctx.remaining);
      const typeNode = new QualifiedType(new NamedType(name), ctx.qualifiers);
      ctx.substitutions.push(typeNode);
      return { typeNode, remaining: str };
    },
  },
  {
    matches: () => true,
    parse: (ctx) => ({ typeNode: null, remaining: ctx.remaining }),
  },
];

function parseSingleType(encoding: string, substitutions: TypeNode[] = [], templateParams: TypeNode[] = []): ParsedType {
  const { qualifiers, remaining } = parseQualifiers(encoding);
  const currentChar = remaining[0];
  const remainder = remaining.slice(1);
  for (const parser of TYPE_PARSERS) {
    if (parser.matches(currentChar)) {
      return parser.parse({ char: currentChar, remaining: remainder, qualifiers, substitutions, templateParams });
    }
  }
  return { typeNode: null, remaining: encoding };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isMangled(name: string): boolean {
  return name.startsWith('_Z');
}

export function demangle(fname: string): string {
  if (!isMangled(fname)) return fname;

  const { remaining: afterVendorPostfix } = parseVendorPostfix(fname.slice(2));

  if (afterVendorPostfix[0] === 'T' || afterVendorPostfix[0] === 'G') {
    const specialResult = parseSpecialName(afterVendorPostfix);
    if (specialResult) return specialResult;
  }

  const { name: functionName, str: afterName, isConst = false, templateArgs = [] } = parseEncodedName(afterVendorPostfix);
  const { templateParams, str: afterTemplate } = parseTemplatePlaceholders(afterName);
  const allTemplateParams = templateArgs.length > 0 ? templateArgs : templateParams;
  const substitutions = buildSubstitutions(functionName, allTemplateParams);
  const { returnType, remaining } = parseReturnTypeIfNeeded(afterTemplate, allTemplateParams, substitutions);
  const { types } = parseTypeList(remaining, substitutions, allTemplateParams);

  return new FormatVisitor().formatFunctionSignature(functionName, types, isConst, returnType);
}
