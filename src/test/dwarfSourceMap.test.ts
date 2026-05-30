import { readFileSync } from 'fs';
import { ELFSectionHeader, parseDwarf } from '../dwarfParser';
import { sourceMapFromDwarf } from '../dwarfSourceMap';
import { FieldDescriptor, Variable, SourceMap, TypeDescriptor } from '../sourceMap';
import * as path from 'path';

function isSectionIncluded(header: ELFSectionHeader): boolean {
  return header.size > 0 && (header.addr > 0 ||
    header.name.startsWith(".text") || header.name.startsWith(".data") ||
    header.name.startsWith(".bss") || header.name.startsWith(".rodata"));
}

function loadSourceMap(fixture: string): SourceMap {
  const buffer = readFileSync(path.join(__dirname, 'fixtures/amigaPrograms', fixture));
  const dwarf = parseDwarf(buffer);
  const offsets = [...dwarf.sections.values()].filter(s => isSectionIncluded(s)).map(s => s.addr);
  return sourceMapFromDwarf(dwarf, offsets, '');
}

function getLocalsAtLine(sourceMap: SourceMap, line: number): Variable[] {
  const mainC = sourceMap.getSourceFiles().find(s => s.includes('simple_c.c'));
  expect(mainC).toBeDefined();
  const loc = sourceMap.lookupSourceLine(mainC!, line);
  return sourceMap.getLocalsForPc(loc.address);
}

function assertKind<K extends TypeDescriptor['kind']>(td: TypeDescriptor, kind: K): Extract<TypeDescriptor, { kind: K }> {
  expect(td.kind).toBe(kind);
  return td as Extract<TypeDescriptor, { kind: K }>;
}

describe('dwarfSourceMap', () => {
  it('should correctly resolve directory paths for DWARF 5 files', () => {
    const testFile = path.join(__dirname, 'fixtures/amigaPrograms/c_prog.elf');
    const buffer = readFileSync(testFile);
    const dwarfData = parseDwarf(buffer);

    // Create source map with empty offsets and base directory
    const offsets = new Array(dwarfData.sections.size).fill(0);
    const baseDir = '';

    const sourceMap = sourceMapFromDwarf(dwarfData, offsets, baseDir);

    // Get all source files and normalize separators for cross-platform assertions
    const sources = sourceMap.getSourceFiles();
    const normalizedSources = sources.map(s => s.replace(/\\/g, '/'));

    // Verify we have some sources
    expect(normalizedSources.length).toBeGreaterThan(0);

    // Verify main.c uses the correct directory (not support/)
    const mainCPaths = normalizedSources.filter(s => s.includes('main.c'));
    expect(mainCPaths.length).toBeGreaterThan(0);

    // Should have the correct path: /amiga-c-1/main.c (not /amiga-c-1/support/main.c)
    const correctMainPath = mainCPaths.find(s =>
      s.includes('/amiga-c-1/main.c') && !s.includes('/support/main.c')
    );
    expect(correctMainPath).toBeDefined();
    expect(correctMainPath).toContain('/amiga-c-1/main.c');

    // Should NOT have incorrect path with /support
    const incorrectMainPath = mainCPaths.find(s =>
      s.includes('/amiga-c-1/support/main.c')
    );
    expect(incorrectMainPath).toBeUndefined();

    // Verify <artificial> and <built-in> are NOT in sources
    const artificialFiles = normalizedSources.filter(s =>
      s.includes('<artificial>') || s.includes('<built-in>')
    );
    expect(artificialFiles.length).toBe(0);

    // Verify assembly file (DWARF 2) uses correct directory
    const asmFile = normalizedSources.find(s => s.includes('gcc8_a_support.s'));
    if (asmFile) {
      // Should be in the support directory
      expect(asmFile).toContain('/support/gcc8_a_support.s');
      // Should NOT be in the root project directory
      expect(asmFile).not.toMatch(/amiga-c-1\/gcc8_a_support\.s$/);
    }
  });

  it('should return inline frames for a PC inside an inlined function', () => {
    const sourceMap = loadSourceMap('simple_c/01_inline/simple_c.elf');

    // Inline 'func_inline' at ELF [0x10,0x18), call_line=8
    const frames = sourceMap.getInlineFramesForPc(0x10);
    expect(frames.length).toBe(1);
    expect(frames[0].name).toBe('func_inline');
    expect(frames[0].callLine).toBe(9);
    expect(frames[0].callPath).toContain('simple_c.c');

    // Exclusive upper bound: 0x18 is not inside the range
    expect(sourceMap.getInlineFramesForPc(0x18).length).toBe(0);

    // Second inline at [0x26,0x30), call_line=11
    const frames2 = sourceMap.getInlineFramesForPc(0x2e);
    expect(frames2.length).toBe(1);
    expect(frames2[0].callLine).toBe(12);

    // Third inline at [0x3e,0x48), call_line=14
    const frames3 = sourceMap.getInlineFramesForPc(0x46);
    expect(frames3.length).toBe(1);
    expect(frames3[0].callLine).toBe(15);
  });

  it('should return variable DIEs for a PC inside a function range', () => {
    const sourceMap = loadSourceMap('simple_c/01_inline/simple_c.elf');
    const results = getLocalsAtLine(sourceMap, 14);

    expect(results.length).toBe(3);
    const names = results.map((v) => v.name).sort();
    expect(names).toEqual(['local_a', 'local_b', 'local_c']);
  });

  it('should build pointer typeDescriptors for simple_c (02_pointer fixture)', () => {
    const locals = getLocalsAtLine(loadSourceMap('simple_c/02_pointer/simple_c.elf'), 6);

    const ptrInt = locals.find(v => v.name === 'ptr_int');
    expect(ptrInt).toBeDefined();
    const tdInt = assertKind(ptrInt!.typeDescriptor, 'pointer');
    expect(tdInt.pointee.kind).toBe('primitive');
    expect(tdInt.pointee.typeName).toBe('int');
    expect(tdInt.pointee.byteSize).toBe(4);

    const ptrShort = locals.find(v => v.name === 'ptr_short');
    expect(ptrShort).toBeDefined();
    const tdShort = assertKind(ptrShort!.typeDescriptor, 'pointer');
    expect(tdShort.pointee.kind).toBe('primitive');
    expect(tdShort.pointee.byteSize).toBe(2);

    const ptrChar = locals.find(v => v.name === 'ptr_char');
    expect(ptrChar).toBeDefined();
    const tdChar = assertKind(ptrChar!.typeDescriptor, 'pointer');
    expect(tdChar.pointee.kind).toBe('primitive');
    expect(tdChar.pointee.byteSize).toBe(1);
  });

  it('should build array typeDescriptor for simple_c (04_array fixture)', () => {
    const locals = getLocalsAtLine(loadSourceMap('simple_c/04_array/simple_c.elf'), 16);
    const arrayVar = locals.find(v => v.name === 'array');
    expect(arrayVar).toBeDefined();

    const td = assertKind(arrayVar!.typeDescriptor, 'array');
    expect(td.elementCount).toBe(130);
    expect(td.elementType.kind).toBe('primitive');
    expect(td.elementType.typeName).toBe('int');
    expect(td.elementType.byteSize).toBe(4);
    expect(td.byteSize).toBe(520);
  });

  it('should build typeDescriptor with pointer-in-struct for simple_c (03_struct fixture)', () => {
    const locals = getLocalsAtLine(loadSourceMap('simple_c/03_struct/simple_c.elf'), 16);
    const ptrVar = locals.find(v => v.name === 'ptr_struct');
    expect(ptrVar).toBeDefined();

    const td = assertKind(ptrVar!.typeDescriptor, 'pointer');
    const pointee = assertKind(td.pointee, 'struct');
    const fields = pointee.getFields();
    const intPtrField = fields.find((f: FieldDescriptor) => f.name === '_int_ptr');
    expect(intPtrField).toBeDefined();
    expect(intPtrField!.type.kind).toBe('pointer');
    expect(intPtrField!.offset).toBe(0);

    const shortField = fields.find((f: FieldDescriptor) => f.name === '_short');
    expect(shortField).toBeDefined();
    expect(shortField!.type.kind).toBe('primitive');

    const charField = fields.find((f: FieldDescriptor) => f.name === '_char');
    expect(charField).toBeDefined();
    expect(charField!.type.kind).toBe('primitive');
  });

});
