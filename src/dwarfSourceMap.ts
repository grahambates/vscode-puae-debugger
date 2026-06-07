import { join, isAbsolute } from "path";
import {
  DW_AT, DW_FORM, DW_TAG,
  DWARFData,
  DebugInfoEntry,
  CompilationUnit,
  LineNumberState,
  LineNumberInstruction,
  LineNumberProgram,
} from "./dwarfParser";
import { SourceMap, ScopeEntry, Variable, LocalLocation, Location, Segment, InlineFrame, InlineEntry, TypeDescriptor, FieldDescriptor } from "./sourceMap";
import { DebugFrame } from "./dwarfParser";
import { MemoryType } from "./amigaHunkParser";
import { demangle } from "./demangle";

/**
 * Creates a source map from DWARF debug information.
 *
 * Processes DWARF debug data to create a mapping between memory addresses
 * and source file locations. Handles line number tables, compilation units,
 * and symbol information from DWARF debugging format.
 *
 * @param dwarfData Parsed DWARF debug information
 * @param offsets Memory offset addresses for loaded sections
 * @param baseDir Base directory for resolving relative source paths
 * @returns SourceMap instance for address-to-source resolution
 */
export function sourceMapFromDwarf(
  dwarfData: DWARFData,
  offsets: number[],
  baseDir: string,
): SourceMap {
  const sources = new Set<string>();
  const symbols: Record<string, number> = {};
  // Keyed by final address. C/C++ source files (.c* / .h*) use last-wins so the
  // compiler's prologue line is overwritten by the first real statement at the same
  // address. Everything else (assembly, unknown) keeps first-wins.
  const locationMap = new Map<number, Location>();
  const segments: Segment[] = [];

  // Section offsets matching original, unfiltered indexes
  const sectionOffsets: ({ loaded: true; offset: number } | { loaded: false })[] = [];
  let i = 0;

  // Build sections from ELF section headers
  for (const [originalName, header] of dwarfData.sections) {
    // Extract memory type and clean section name
    const memTypeMap = {
      MEMF_CHIP: MemoryType.CHIP,
      MEMF_FAST: MemoryType.FAST,
      MEMF_ANY: MemoryType.ANY,
    };
    let memType: MemoryType = MemoryType.ANY;
    let name = originalName;

    for (const suffix in memTypeMap) {
      if (name.endsWith("." + suffix)) {
        memType = memTypeMap[suffix as keyof typeof memTypeMap];
        name = name.replace("." + suffix, "");
        break;
      }
    }

    // Filter sections: must have size > 0 AND either addr > 0 OR be a special section
    if (
      header.size > 0 &&
      (header.addr > 0 ||
        name === ".text" ||
        name === ".data" ||
        name === ".bss" ||
        name === ".rodata")
    ) {
      segments.push({
        name: originalName,
        address: offsets[i],
        size: header.size,
        memType,
      });
      sectionOffsets.push({ loaded: true, offset: offsets[i++] - header.addr });
    } else {
      sectionOffsets.push({ loaded: false });
    }
  }

  // Process line number programs, prioritizing C/C++ files over assembly files
  // Assembly files often have confusing line info (macro expansions, etc.)
  // Sort by: 1) Non-assembly files first, 2) Higher DWARF version first (within same category)
  const sortedPrograms = [...dwarfData.lineNumberPrograms].sort((a, b) => {
    // Check if programs contain assembly files
    const aHasAsm = a.fileNames.some(f => f.name.endsWith('.s') || f.name.endsWith('.S'));
    const bHasAsm = b.fileNames.some(f => f.name.endsWith('.s') || f.name.endsWith('.S'));

    // Non-assembly programs come first
    if (aHasAsm !== bHasAsm) {
      return aHasAsm ? 1 : -1;
    }

    // Within same category, prefer higher DWARF version
    return b.version - a.version;
  });

  for (const program of sortedPrograms) {
    const state: LineNumberState = {
      address: 0,
      file: 1,
      line: 1,
      column: 0,
      isStmt: program.defaultIsStmt,
      basicBlock: false,
      endSequence: false,
    };

    for (const instruction of program.instructions) {
      executeLineNumberInstruction(instruction, state, program);

      // Create location entries for statements
      const shouldEmitLocation =
        (instruction.type === "standard" && instruction.name === "copy") ||
        instruction.type === "special";

      // DWARF 5 uses 0-based file indices, DWARF 2-4 uses 1-based
      const fileIndex = program.version >= 5 ? state.file : state.file - 1;

      if (
        shouldEmitLocation &&
        fileIndex >= 0 &&
        fileIndex < program.fileNames.length
      ) {
        const fileEntry = program.fileNames[fileIndex];
        if (fileEntry) {
          // Skip special DWARF markers that don't correspond to real source files
          // These are compiler-generated code locations that should show disassembly
          if (
            fileEntry.name === "<artificial>" ||
            fileEntry.name === "<built-in>" ||
            fileEntry.name.startsWith("<") && fileEntry.name.endsWith(">")
          ) {
            continue;
          }

          // Build full path
          let path = fileEntry.name;

          // Handle directory indexing - DWARF 5 uses 0-based, DWARF 2-4 uses 1-based
          let dirIndex = -1;

          if (program.version >= 5) {
            // DWARF 5: directory indices are 0-based, directly index into the array
            if (fileEntry.directoryIndex >= 0 && fileEntry.directoryIndex < program.includeDirectories.length) {
              dirIndex = fileEntry.directoryIndex;
            }
          } else {
            // DWARF 2-4: directory index 0 means current directory (no prefix)
            // Directory index 1+ means index into the directory table (subtract 1 for array index)
            if (fileEntry.directoryIndex > 0 && fileEntry.directoryIndex <= program.includeDirectories.length) {
              dirIndex = fileEntry.directoryIndex - 1;
            }
          }

          if (dirIndex >= 0 && dirIndex < program.includeDirectories.length) {
            const directory = program.includeDirectories[dirIndex];
            path = join(directory, fileEntry.name);
          }
          // Only prepend baseDir if path is not already absolute
          if (!isAbsolute(path)) {
            path = join(baseDir, path);
          }

          // Find which ELF section this DWARF address belongs to
          // state.address is from the line number program and represents an address
          // in the ELF file's address space (usually section virtual address + offset)
          let sectionIndex = 0;
          let sectionOffset = 0;
          let found = false;

          // Need to compare against original ELF section addresses, not loaded addresses
          let elfSectionIndex = 0;
          for (const [sectionName, header] of dwarfData.sections) {
            // Extract clean section name (remove memory type suffix if present)
            let cleanName = sectionName;
            if (cleanName.endsWith(".MEMF_CHIP") || cleanName.endsWith(".MEMF_FAST") || cleanName.endsWith(".MEMF_ANY")) {
              cleanName = cleanName.substring(0, cleanName.lastIndexOf('.'));
            }

            // Check if this section was included in segments (has size > 0 and valid addr)
            const isIncluded = header.size > 0 && (header.addr > 0 ||
              cleanName === ".text" || cleanName === ".data" ||
              cleanName === ".bss" || cleanName === ".rodata");

            if (isIncluded) {
              // Check if state.address falls within this ELF section's address range
              if (state.address >= header.addr &&
                  state.address < header.addr + header.size) {
                sectionIndex = elfSectionIndex;
                sectionOffset = state.address - header.addr;
                found = true;
                break;
              }
              elfSectionIndex++;
            }
          }

          if (!found) {
            // Address doesn't belong to any known section, skip it
            continue;
          }

          // Calculate final loaded address: base address + offset within section
          const finalAddress = offsets[sectionIndex] + sectionOffset;

          const location: Location = {
            path,
            line: state.line,
            address: finalAddress,
            segmentIndex: sectionIndex,
            segmentOffset: sectionOffset,
          };
          const isCpp = /\.[ch]\w*$/i.test(path);
          if (isCpp || !locationMap.has(finalAddress))
            locationMap.set(finalAddress, location);

          // Add to sources set
          sources.add(path);
        }
      }

      // Reset state on end sequence
      if (state.endSequence) {
        state.address = 0;
        state.file = 1;
        state.line = 1;
        state.column = 0;
        state.isStmt = program.defaultIsStmt;
        state.basicBlock = false;
        state.endSequence = false;
      }
    }
  }

  // Extract symbols from ELF symbol table
  for (const elfSymbol of dwarfData.elfSymbols) {
    const section = sectionOffsets[elfSymbol.sectionIndex];
    if (section?.loaded) {
      symbols[elfSymbol.name] = elfSymbol.value + section.offset;
    }
  }

  const relocate = makeRelocate(dwarfData, sectionOffsets);
  const scopeTable = buildScopeTable(dwarfData, relocate);
  const relocatedDebugFrame = dwarfData.debugFrame
    ? relocateDebugFrame(dwarfData.debugFrame, relocate)
    : undefined;
  const inlineTable = buildInlineTable(dwarfData, relocate, baseDir);
  const globalVars = buildGlobalsTable(dwarfData, relocate);
  return new SourceMap(segments, sources, symbols, [...locationMap.values()], scopeTable, relocatedDebugFrame, inlineTable, globalVars);
}

function relocateDebugFrame(
  debugFrame: DebugFrame,
  relocate: (addr: number) => number | undefined,
): DebugFrame {
  const fdes = debugFrame.fdes.map(fde => {
    const newPcStart = relocate(fde.pcStart);
    return newPcStart !== undefined ? { ...fde, pcStart: newPcStart } : fde;
  });
  return { cies: debugFrame.cies, fdes };
}

// Returns a function that maps an ELF-space address to its loaded address,
// or undefined if the address doesn't fall within any loaded section.
function makeRelocate(
  dwarfData: DWARFData,
  sectionOffsets: Array<{ loaded: true; offset: number } | { loaded: false }>,
): (addr: number) => number | undefined {
  const sectionList = [...dwarfData.sections.values()];
  return (addr: number) => {
    for (let i = 0; i < sectionList.length; i++) {
      const header = sectionList[i];
      const so = sectionOffsets[i];
      if (so?.loaded && addr >= header.addr && addr < header.addr + header.size) {
        // so.offset = loadedBase - header.addr, so result = loadedBase + (addr - header.addr)
        return so.offset + addr;
      }
    }
    return undefined;
  };
}

// --- Scope table (locals lookup) ---

function findAttribute(die: DebugInfoEntry, name: number) {
  return die.attributes.find((attr) => attr.name === name);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && !Number.isNaN(value);
}

// Resolve a DIE's source-level name, following the indirections GCC uses for inlined
// and out-of-line C/C++ functions: DW_AT_name on the DIE, else its DW_AT_specification
// (declaration) or DW_AT_abstract_origin (abstract instance), else the (demangled)
// DW_AT_linkage_name. Returns undefined only when nothing names it.
function resolveDieName(die: DebugInfoEntry | undefined, depth = 0): string | undefined {
  if (!die || depth > 8) return undefined;
  const direct = findAttribute(die, DW_AT.name)?.value;
  if (typeof direct === 'string') return direct;
  const spec = findAttribute(die, DW_AT.specification)?.value?.die as DebugInfoEntry | undefined;
  const fromSpec = resolveDieName(spec, depth + 1);
  if (fromSpec) return fromSpec;
  const origin = findAttribute(die, DW_AT.abstract_origin)?.value?.die as DebugInfoEntry | undefined;
  const fromOrigin = resolveDieName(origin, depth + 1);
  if (fromOrigin) return fromOrigin;
  const linkage = findAttribute(die, DW_AT.linkage_name)?.value;
  if (typeof linkage === 'string') return demangle(linkage);
  return undefined;
}

function getDieRange(die: DebugInfoEntry): { low: number; high: number } | undefined {
  const lowAttr = findAttribute(die, DW_AT.low_pc);
  const highAttr = findAttribute(die, DW_AT.high_pc);
  if (!lowAttr || !highAttr) return undefined;
  if (!isNumber(lowAttr.value) || !isNumber(highAttr.value)) return undefined;
  const low = lowAttr.value;
  const highValue = highAttr.value;
  const high = highAttr.form === DW_FORM.addr ? highValue : low + highValue;
  return { low, high };
}

interface CuCtx {
  debugRanges: Uint8Array | undefined;
  debugRnglists: Uint8Array | undefined; // DWARF5
  version: number;
  addressSize: number;
  cuBasePc: number;
  isLittleEndian: boolean;
}

function readULEB128At(view: DataView, off: number): { value: number; size: number } {
  let result = 0, shift = 0, size = 0, byte: number;
  do {
    byte = view.getUint8(off + size);
    result |= (byte & 0x7f) << shift;
    shift += 7;
    size++;
  } while (byte & 0x80);
  return { value: result >>> 0, size };
}

// DWARF5 .debug_rnglists range-list entry kinds (DWARF5 §7.28). The *x variants index
// .debug_addr, which this toolchain doesn't emit, so they're intentionally unhandled.
const DW_RLE = {
  end_of_list: 0x00,
  base_addressx: 0x01,
  startx_endx: 0x02,
  startx_length: 0x03,
  offset_pair: 0x04,
  base_address: 0x05,
  start_end: 0x06,
  start_length: 0x07,
} as const;

// DWARF5 .debug_rnglists range list (DW_RLE_* entries) at byte offset `listOffset`
// (a DW_FORM_sec_offset into the section). Yields absolute [low, high) intervals.
// Only the non-indexed forms are handled — this toolchain emits no .debug_addr, so the
// addrx variants (base_addressx/startx_*) never appear; an unknown code stops the list.
function* iterDebugRnglists(
  rnglists: Uint8Array,
  listOffset: number,
  cuBasePc: number,
  addressSize: number,
  isLittleEndian: boolean,
): Generator<{ low: number; high: number }> {
  const view = new DataView(rnglists.buffer, rnglists.byteOffset, rnglists.byteLength);
  const readAddr = (off: number): number => view.getUint32(off, isLittleEndian);
  let base = cuBasePc;
  let off = listOffset;
  while (off < rnglists.byteLength) {
    const code = view.getUint8(off); off += 1;
    switch (code) {
      case DW_RLE.end_of_list:
        return;
      case DW_RLE.base_address: { // addr (sets the base for following offset_pairs)
        base = readAddr(off); off += addressSize;
        break;
      }
      case DW_RLE.offset_pair: { // ULEB start, ULEB end (relative to base)
        const s = readULEB128At(view, off); off += s.size;
        const e = readULEB128At(view, off); off += e.size;
        yield { low: base + s.value, high: base + e.value };
        break;
      }
      case DW_RLE.start_end: { // addr start, addr end
        const lo = readAddr(off); off += addressSize;
        const hi = readAddr(off); off += addressSize;
        yield { low: lo, high: hi };
        break;
      }
      case DW_RLE.start_length: { // addr start, ULEB length
        const lo = readAddr(off); off += addressSize;
        const len = readULEB128At(view, off); off += len.size;
        yield { low: lo, high: lo + len.value };
        break;
      }
      default:
        // base_addressx / startx_* need .debug_addr (not parsed by this toolchain's
        // output); any other code is corrupt input. Either way we can't trust the rest
        // of the list, so fail loud instead of silently truncating it.
        throw new Error("DWARF parsing error: unimplemented DW_RLE 0x" + code.toString(16) + " in .debug_rnglists");
    }
  }
}

function* iterDebugRanges(
  debugRanges: Uint8Array,
  rangesOffset: number,
  cuBasePc: number,
  addressSize: number,
  isLittleEndian: boolean,
): Generator<{ low: number; high: number }> {
  const view = new DataView(debugRanges.buffer, debugRanges.byteOffset, debugRanges.byteLength);
  const readAddr = (off: number): number => {
    if (addressSize === 8) {
      const lo = view.getUint32(off, isLittleEndian);
      const hi = view.getUint32(off + 4, isLittleEndian);
      return isLittleEndian ? lo + hi * 0x100000000 : hi + lo * 0x100000000;
    }
    return view.getUint32(off, isLittleEndian);
  };
  const baseSentinel = addressSize === 4 ? 0xffffffff : Number.MAX_SAFE_INTEGER;
  let base = cuBasePc;
  let offset = rangesOffset;
  while (offset + addressSize * 2 <= debugRanges.byteLength) {
    const begin = readAddr(offset);
    const end = readAddr(offset + addressSize);
    offset += addressSize * 2;
    if (begin === 0 && end === 0) break;
    if (begin >= baseSentinel) { base = end; continue; }
    yield { low: base + begin, high: base + end };
  }
}

function* getDieIntervals(die: DebugInfoEntry, ctx: CuCtx): Generator<{ low: number; high: number }> {
  const range = getDieRange(die);
  if (range) { yield range; return; }
  const rangesAttr = findAttribute(die, DW_AT.ranges);
  if (!rangesAttr || !isNumber(rangesAttr.value)) return;
  // DWARF5: DW_AT_ranges is a sec_offset into .debug_rnglists (DW_RLE_* encoding);
  // DWARF<5: an offset into .debug_ranges (begin/end address pairs). A DIE carrying
  // DW_AT_ranges without the matching section is a parser gap, not valid-but-empty —
  // fail loud rather than silently dropping the DIE's address ranges.
  if (ctx.version >= 5) {
    if (!ctx.debugRnglists) throw new Error("DWARF parsing error: DW_AT_ranges present but .debug_rnglists is missing (DWARF5)");
    yield* iterDebugRnglists(ctx.debugRnglists, rangesAttr.value, ctx.cuBasePc, ctx.addressSize, ctx.isLittleEndian);
  } else {
    if (!ctx.debugRanges) throw new Error("DWARF parsing error: DW_AT_ranges present but .debug_ranges is missing");
    yield* iterDebugRanges(ctx.debugRanges, rangesAttr.value, ctx.cuBasePc, ctx.addressSize, ctx.isLittleEndian);
  }
}

function getCuBasePc(cu: CompilationUnit): number {
  for (const die of cu.dies) {
    const lowAttr = findAttribute(die, DW_AT.low_pc);
    if (isNumber(lowAttr?.value)) return lowAttr!.value;
  }
  return 0;
}

function getTypeDie(die: DebugInfoEntry): DebugInfoEntry | undefined {
  const attr = findAttribute(die, DW_AT.type);
  return attr?.value?.die as DebugInfoEntry | undefined;
}

function getFrameBase(die: DebugInfoEntry): 'cfa' | 'other' {
  const attr = findAttribute(die, DW_AT.frame_base);
  if (!attr || typeof attr.value !== 'object' || attr.value === null) return 'other';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ops = (attr.value as any).ops as Array<any> | undefined;
  if (ops && ops.length > 0 && ops[0].op === 'DW_OP_call_frame_cfa') return 'cfa';
  return 'other';
}

function typeNameFromDie(die: DebugInfoEntry, depth = 0): string {
  if (depth > 8) return '<...>';
  const tagName = (): string => findAttribute(die, DW_AT.name)?.value as string ?? '<anonymous>';
  switch (die.tag) {
    case DW_TAG.base_type:
    case DW_TAG.typedef:
      return findAttribute(die, DW_AT.name)?.value as string ?? '<unknown>';
    case DW_TAG.pointer_type: {
      const inner = getTypeDie(die);
      return (inner ? typeNameFromDie(inner, depth + 1) : 'void') + ' *';
    }
    case DW_TAG.const_type: {
      const inner = getTypeDie(die);
      return 'const ' + (inner ? typeNameFromDie(inner, depth + 1) : 'void');
    }
    case DW_TAG.array_type: {
      const inner = getTypeDie(die);
      return (inner ? typeNameFromDie(inner, depth + 1) : '<unknown>') + '[]';
    }
    case DW_TAG.structure_type:   return 'struct ' + tagName();
    case DW_TAG.union_type:       return 'union '  + tagName();
    case DW_TAG.enumeration_type: return 'enum '   + tagName();
    default: return '<unknown>';
  }
}

function resolveLocation(
  die: DebugInfoEntry,
  relocate: (addr: number) => number | undefined,
  frameBase: 'cfa' | 'other' = 'other',
): LocalLocation {
  const attr = findAttribute(die, DW_AT.location);
  if (!attr || typeof attr.value !== 'object' || attr.value === null) return { kind: 'unknown' };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ops = attr.value.ops as Array<any> | undefined;
  if (!ops || ops.length === 0) return { kind: 'unknown' };
  const op = ops[0];
  if (op.op === 'DW_OP_fbreg' && op.value !== undefined) {
    if (frameBase === 'cfa') return { kind: 'cfa', offset: op.value };
    return { kind: 'fbreg', offset: op.value };
  }
  if (op.op.startsWith('DW_OP_breg') && op.reg !== undefined && op.value !== undefined)
    return { kind: 'breg', reg: op.reg, offset: op.value };
  if (op.op === 'DW_OP_addr' && op.value !== undefined) {
    const address = relocate(op.value) ?? op.value;
    return { kind: 'addr', address };
  }
  return { kind: 'unknown' };
}

function resolveByteSize(typeDie: DebugInfoEntry | undefined, addressSize: number, depth = 0): number {
  if (!typeDie || depth > 8) return 0;
  const byteSizeAttr = findAttribute(typeDie, DW_AT.byte_size);
  if (byteSizeAttr && isNumber(byteSizeAttr.value)) return byteSizeAttr.value;
  switch (typeDie.tag) {
    case DW_TAG.pointer_type: return addressSize;
    case DW_TAG.typedef:
    case DW_TAG.const_type: {
      const inner = getTypeDie(typeDie);
      return resolveByteSize(inner, addressSize, depth + 1);
    }
    default: return 0;
  }
}

function buildTypeDescriptor(typeDie: DebugInfoEntry | undefined, addressSize: number, depth = 0): TypeDescriptor {
  if (!typeDie || depth > 8) return { kind: 'unknown', typeName: '?', byteSize: 0 };
  const typeName = typeNameFromDie(typeDie);
  const byteSize = resolveByteSize(typeDie, addressSize);
  switch (typeDie.tag) {
    case DW_TAG.base_type:
      return { kind: 'primitive', typeName, byteSize };
    case DW_TAG.pointer_type: {
      const pointeeDie = getTypeDie(typeDie);
      const pointee = buildTypeDescriptor(pointeeDie, addressSize, depth + 1);
      return { kind: 'pointer', typeName, byteSize: addressSize, pointee };
    }
    case DW_TAG.structure_type:
      // Fields are resolved lazily via a closure — avoids upfront cost and handles
      // self-referential structs (e.g. struct Struct { Struct* next; }) naturally.
      return { kind: 'struct', typeName, byteSize, getFields: () => buildFieldDescriptors(typeDie, addressSize) };
    case DW_TAG.array_type: {
      const elementDie = getTypeDie(typeDie);
      const elementType = buildTypeDescriptor(elementDie, addressSize, depth + 1);
      const subrange = typeDie.children.find(c => c.tag === DW_TAG.subrange_type);
      const upperBound = subrange ? findAttribute(subrange, DW_AT.upper_bound)?.value : undefined;
      const elementCount = isNumber(upperBound) ? upperBound + 1 : 0;
      return { kind: 'array', typeName, byteSize: elementCount * elementType.byteSize, elementCount, elementType };
    }
    case DW_TAG.typedef:
    case DW_TAG.const_type:
    case DW_TAG.volatile_type:
    case DW_TAG.restrict_type:
      return buildTypeDescriptor(getTypeDie(typeDie), addressSize, depth + 1);
    default:
      return { kind: 'primitive', typeName, byteSize };
  }
}

function buildFieldDescriptors(structDie: DebugInfoEntry, addressSize: number): FieldDescriptor[] {
  return structDie.children
    .filter(m => m.tag === DW_TAG.member)
    .map(member => {
      const name = findAttribute(member, DW_AT.name)?.value as string ?? '???';
      const type = buildTypeDescriptor(getTypeDie(member), addressSize);
      const rawOffset = findAttribute(member, DW_AT.data_member_location)?.value;
      return { name, offset: typeof rawOffset === 'number' ? rawOffset : 0, type };
    });
}

function dieToLocalVar(
  die: DebugInfoEntry,
  relocate: (addr: number) => number | undefined,
  addressSize: number,
  frameBase: 'cfa' | 'other' = 'other',
): Variable {
  const name = findAttribute(die, DW_AT.name)?.value as string | undefined ?? '???';
  const typeDie = getTypeDie(die);
  const typeName = typeDie ? typeNameFromDie(typeDie) : '<unknown>';
  const byteSize = resolveByteSize(typeDie, addressSize);
  const location = resolveLocation(die, relocate, frameBase);
  const typeDescriptor = buildTypeDescriptor(typeDie, addressSize);
  return { name, typeName, byteSize, location, typeDescriptor };
}

function buildScopeTable(
  dwarfData: DWARFData,
  relocate: (addr: number) => number | undefined,
): ScopeEntry[] {
  const entries: ScopeEntry[] = [];

  for (const cu of dwarfData.compilationUnits) {
    const ctx: CuCtx = {
      debugRanges: dwarfData.debugRanges,
      debugRnglists: dwarfData.debugRnglists,
      version: cu.version,
      addressSize: cu.addressSize,
      cuBasePc: getCuBasePc(cu),
      isLittleEndian: dwarfData.isLittleEndian,
    };

    function visit(die: DebugInfoEntry, inSubprogram: boolean, frameBase: 'cfa' | 'other' = 'other') {
      const currentInSubprogram = inSubprogram || die.tag === DW_TAG.subprogram;
      const currentFrameBase = die.tag === DW_TAG.subprogram ? getFrameBase(die) : frameBase;

      if (currentInSubprogram && (die.tag === DW_TAG.subprogram || die.tag === DW_TAG.lexical_block)) {
        const vars = die.children
          .filter((c) => c.tag === DW_TAG.variable || c.tag === DW_TAG.formal_parameter)
          .map((c) => dieToLocalVar(c, relocate, ctx.addressSize, currentFrameBase));
        if (vars.length > 0) {
          for (const interval of getDieIntervals(die, ctx)) {
            const relocLow = relocate(interval.low);
            if (relocLow === undefined) continue;
            const delta = relocLow - interval.low;
            entries.push({ low: relocLow, high: interval.high + delta, vars });
          }
        }
      }

      for (const child of die.children) {
        visit(child, currentInSubprogram, currentFrameBase);
      }
    }

    for (const die of cu.dies) {
      visit(die, false);
    }
  }

  entries.sort((a, b) => a.low - b.low);
  return entries;
}

function buildGlobalsTable(
  dwarfData: DWARFData,
  relocate: (addr: number) => number | undefined,
): Variable[] {
  const globals: Variable[] = [];
  for (const cu of dwarfData.compilationUnits) {
    const root = cu.dies[0];
    if (!root) continue;
    for (const die of root.children) {
      if (die.tag !== DW_TAG.variable) continue;
      const location = resolveLocation(die, relocate);
      if (location.kind !== 'addr') continue;
      // A C/C++ definition may carry only the location and point back (via
      // DW_AT_specification) to a separate declaration DIE that holds the name
      // and type. Fall back to that DIE when they're absent on the definition.
      const specDie = findAttribute(die, DW_AT.specification)?.value?.die as DebugInfoEntry | undefined;
      const name = (findAttribute(die, DW_AT.name)?.value
        ?? (specDie && findAttribute(specDie, DW_AT.name)?.value)) as string ?? '???';
      const typeDie = getTypeDie(die) ?? (specDie ? getTypeDie(specDie) : undefined);
      const typeName = typeDie ? typeNameFromDie(typeDie) : '<unknown>';
      const byteSize = resolveByteSize(typeDie, cu.addressSize);
      const typeDescriptor = buildTypeDescriptor(typeDie, cu.addressSize);
      globals.push({ name, typeName, byteSize, location, typeDescriptor });
    }
  }
  return globals;
}

function buildInlineTable(
  dwarfData: DWARFData,
  relocate: (addr: number) => number | undefined,
  baseDir: string,
): InlineEntry[] {
  const entries: InlineEntry[] = [];

  for (const cu of dwarfData.compilationUnits) {
    const stmtListAttr = findAttribute(cu.dies[0], DW_AT.stmt_list);
    const stmtList = isNumber(stmtListAttr?.value) ? stmtListAttr.value : undefined;
    const program = stmtList !== undefined
      ? dwarfData.lineNumberPrograms.find(p => p.sectionOffset === stmtList)
      : dwarfData.lineNumberPrograms[0];

    const ctx: CuCtx = {
      debugRanges: dwarfData.debugRanges,
      debugRnglists: dwarfData.debugRnglists,
      version: cu.version,
      addressSize: cu.addressSize,
      cuBasePc: getCuBasePc(cu),
      isLittleEndian: dwarfData.isLittleEndian,
    };

    function resolveCallPath(callFile: number): string {
      if (!program) return '';
      const fileIndex = program.version >= 5 ? callFile : callFile - 1;
      const fileEntry = program.fileNames[fileIndex];
      if (!fileEntry) return '';
      let filePath = fileEntry.name;
      const dirIndex = program.version >= 5
        ? fileEntry.directoryIndex
        : fileEntry.directoryIndex > 0 ? fileEntry.directoryIndex - 1 : -1;
      if (dirIndex >= 0 && dirIndex < program.includeDirectories.length) {
        filePath = join(program.includeDirectories[dirIndex], filePath);
      }
      if (!isAbsolute(filePath)) filePath = join(baseDir, filePath);
      return filePath;
    }

    function visit(die: DebugInfoEntry, depth: number) {
      if (die.tag === DW_TAG.inlined_subroutine) {
        // The inlined function's name lives on the abstract instance the inlined_subroutine
        // points to (DW_AT_abstract_origin), which may itself only carry the name via a
        // specification/linkage_name — resolveDieName chases the whole chain.
        const name = resolveDieName(die) ?? '???';
        const callFile = findAttribute(die, DW_AT.call_file)?.value as number | undefined ?? 0;
        const callLine = findAttribute(die, DW_AT.call_line)?.value as number | undefined ?? 0;
        const callPath = resolveCallPath(callFile);

        for (const interval of getDieIntervals(die, ctx)) {
          const relocLow = relocate(interval.low);
          if (relocLow === undefined) continue;
          const delta = relocLow - interval.low;
          entries.push({ low: relocLow, high: interval.high + delta, depth, frame: { name, callPath, callLine } as InlineFrame });
        }

        for (const child of die.children) visit(child, depth + 1);
      } else {
        for (const child of die.children) visit(child, depth);
      }
    }

    for (const die of cu.dies) visit(die, 0);
  }

  return entries;
}

function executeLineNumberInstruction(
  instruction: LineNumberInstruction,
  state: LineNumberState,
  program: LineNumberProgram,
): void {
  switch (instruction.type) {
    case "extended":
      if (
        instruction.name === "set_address" &&
        instruction.address !== undefined
      ) {
        state.address = instruction.address;
      } else if (instruction.name === "end_sequence") {
        state.endSequence = true;
      }
      break;

    case "standard":
      switch (instruction.name) {
        case "advance_pc":
          if (instruction.advance !== undefined) {
            state.address +=
              instruction.advance * program.minimumInstructionLength;
          }
          break;
        case "advance_line":
          if (instruction.advance !== undefined) {
            state.line += instruction.advance;
          }
          break;
        case "set_file":
          if (instruction.file !== undefined) {
            state.file = instruction.file;
          }
          break;
        case "set_column":
          if (instruction.column !== undefined) {
            state.column = instruction.column;
          }
          break;
        case "negate_stmt":
          state.isStmt = !state.isStmt;
          break;
        case "set_basic_block":
          state.basicBlock = true;
          break;
        case "const_add_pc": {
          const adjustedOpcode = 255 - program.opcodeBase;
          state.address +=
            Math.floor(adjustedOpcode / program.lineRange) *
            program.minimumInstructionLength;
          break;
        }
        case "fixed_advance_pc":
          if (instruction.advance !== undefined) {
            state.address += instruction.advance;
          }
          break;
      }
      break;

    case "special":
      if (instruction.addressAdvance !== undefined) {
        state.address +=
          instruction.addressAdvance * program.minimumInstructionLength;
      }
      if (instruction.lineAdvance !== undefined) {
        state.line += instruction.lineAdvance;
      }
      break;
  }
}
