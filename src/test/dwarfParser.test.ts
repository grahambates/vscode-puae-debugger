/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'fs';
import { DW_AT, DW_ATE, DW_FORM, DW_TAG, formatSectionFlags, parseDwarf } from '../dwarfParser';
import * as path from 'path';

type DebugInfoEntry = {
  abbrevCode: number;
  tag: number | undefined;
  attributes: Array<{ name: number; form: number; value: any }>;
  children: DebugInfoEntry[];
};

type CompilationUnit = {
  length: number;
  version: number;
  abbrevOffset: number;
  addressSize: number;
  offset: number;
  dies: DebugInfoEntry[];
};

function dwName(map: Record<string, number>, code: number | undefined): string {
  if (code === undefined) {
    return 'undefined';
  }

  const entry = Object.entries(map).find(([, value]) => value === code);
  return entry ? `${entry[0]} (0x${code.toString(16)})` : `0x${code.toString(16)}`;
}

function formatAttrValue(value: any, attrName?: number): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (typeof value === 'string') {
    return `"${value}"`;
  }
  if (typeof value === 'number') {
    if (attrName === DW_AT.encoding) {
      return dwName(DW_ATE, value);
    }
    return value < 0 ? `-0x${(-value).toString(16)}` : `0x${value.toString(16)}`;
  }
  // If this is a parsed location/frame_base value, format contained DW_OP
  // operands (addresses) as hex for human-friendly dumps.
  if (value && typeof value === 'object' && Array.isArray(value.ops)) {
    const ops = value.ops
      .map((o: any) => {
        if (o && typeof o.value === 'number') {
          const v = o.value as number;
          const sval = v < 0 ? `-0x${(-v).toString(16)}` : `0x${v.toString(16)}`;
          return `{op:${o.op},value:${sval}}`;
        }
        if (o && 'op' in o) {
          return `{op:${o.op}}`;
        }
        return JSON.stringify(o);
      })
      .join(', ');
    return `{raw:${value.raw?.length ?? 0} bytes, ops:[${ops}]}`;
  }

  return JSON.stringify(value);
}

function dumpAttributeLines(attr: { name: number; form: number; value: any }, attrDepth: number, visited: Set<DebugInfoEntry>): string[] {
  // returns an array of lines: first line is the attribute line (no leading indent),
  // subsequent lines (if any) are pre-indented lines (e.g., an embedded DIE dump)
  const base = `name=${dwName(DW_AT, attr.name)} form=${dwName(DW_FORM, attr.form)} value=`;

  // Handle ref objects that may include a resolved `.die`
  if (attr && attr.value && typeof attr.value === 'object' && 'ref' in attr.value) {
    const refObj = attr.value as any;
    const refLine = `${base}{ref:0x${refObj.ref.toString(16)}}`;
    if (refObj.die) {
      // Reuse the existing DIE dumper to render the referenced DIE one level deeper
      const dieDump = dumpDIE(refObj.die as DebugInfoEntry, attrDepth + 1, visited);
      const dieLines = dieDump.split('\n');
      return [refLine, ...dieLines];
    }
    return [refLine];
  }

  // Fallback: single-line attribute
  return [`${base}${formatAttrValue(attr.value, attr.name)}`];
}

function dumpDIE(die: DebugInfoEntry, depth = 0, visited: Set<DebugInfoEntry> = new Set()): string {
  const indent = '  '.repeat(depth);

  if (visited.has(die)) {
    return `${indent}- DIE(code=0x${die.abbrevCode.toString(16)}, tag=${dwName(DW_TAG, die.tag)}) [circular]`;
  }
  visited.add(die);

  const attrIndent = '  '.repeat(depth + 1);

  const attrsLines: string[] = [];
  for (const attr of die.attributes) {
    const lines = dumpAttributeLines(attr, depth + 1, visited);
    // Prefix the first line with the attribute indent; subsequent lines are
    // assumed to already contain proper indentation from dumpDIE output.
    attrsLines.push(`${attrIndent}${lines[0]}`);
    if (lines.length > 1) {
      attrsLines.push(...lines.slice(1));
    }
  }

  const attrs = attrsLines.join('\n');
  const header = `${indent}- DIE(code=0x${die.abbrevCode.toString(16)}, tag=${dwName(DW_TAG, die.tag)})`;
  const body = attrs.length ? `\n${attrs}` : '';

  if (!die.children || die.children.length === 0) {
    visited.delete(die);
    return `${header}${body}`;
  }

  const childrenDump = die.children.map((child) => dumpDIE(child, depth + 1, visited)).join('\n');
  visited.delete(die);
  return `${header}${body}\n${childrenDump}`;
}

function dumpCompilationUnit(cu: CompilationUnit): string {
  const header = `CU(offset=${cu.offset}, length=${cu.length}, version=${cu.version}, addressSize=${cu.addressSize}, abbrevOffset=${cu.abbrevOffset})`;
  const diesDump = cu.dies.map((die) => dumpDIE(die)).join('\n');
  return `${header}\n${diesDump}`;
}

describe('dwarfParser', () => {
  it('should parse example.elf without errors', () => {
    const testFile = path.join(__dirname, 'fixtures/amigaPrograms/example.elf');
    const buffer = readFileSync(testFile);

    const result = parseDwarf(buffer);

    // Verify basic structure was parsed
    expect(result).toBeDefined();
    expect(result.compilationUnits).toBeDefined();
    expect(result.lineNumberPrograms).toBeDefined();
    expect(result.sections).toBeDefined();

    // Verify we got some data
    expect(result.compilationUnits.length).toBeGreaterThan(0);
    expect(result.lineNumberPrograms.length).toBeGreaterThan(0);

    // Verify endianness detection
    expect(result.isLittleEndian).toBe(false); // Amiga binaries are big-endian
    expect(result.is64bit).toBe(false); // Amiga 68k is 32-bit

    // Verify sections were found
    expect(result.sections.has('.debug_info')).toBe(true);
    expect(result.sections.has('.debug_abbrev')).toBe(true);
    expect(result.sections.has('.debug_line')).toBe(true);
  });

  it('should parse c_prog.elf with DWARF 5 line number programs', () => {
    const testFile = path.join(__dirname, 'fixtures/amigaPrograms/c_prog.elf');
    const buffer = readFileSync(testFile);

    const result = parseDwarf(buffer);

    // Verify basic structure was parsed
    expect(result).toBeDefined();
    expect(result.lineNumberPrograms).toBeDefined();
    expect(result.lineNumberPrograms.length).toBeGreaterThan(0);

    // Get the first line number program
    const program = result.lineNumberPrograms[0];

    // Verify it's DWARF 5
    expect(program.version).toBe(5);

    // Verify directories were parsed
    expect(program.includeDirectories).toBeDefined();
    expect(program.includeDirectories.length).toBeGreaterThan(0);

    // Verify file names were parsed and contain C source files
    expect(program.fileNames).toBeDefined();
    expect(program.fileNames.length).toBeGreaterThan(0);

    // Check that we have C source files in the list
    const cFiles = program.fileNames.filter(f => f.name.endsWith('.c'));
    expect(cFiles.length).toBeGreaterThan(0);

    // Specifically look for main.c
    const mainC = program.fileNames.find(f => f.name === 'main.c');
    expect(mainC).toBeDefined();

    // Verify that special DWARF markers are included (they'll be filtered when creating locations)
    const artificialFiles = program.fileNames.filter(f =>
      f.name === '<artificial>' ||
      f.name === '<built-in>' ||
      (f.name.startsWith('<') && f.name.endsWith('>'))
    );
    // These should exist in the raw parsed data
    expect(artificialFiles.length).toBeGreaterThan(0);
  });

  it('should get DIEs from simple_c.elf', () => {
    const testFile = path.join(__dirname, 'fixtures/amigaPrograms/simple_c/simple_c.elf');
    const buffer = readFileSync(testFile);

    const result = parseDwarf(buffer);
 
    let i = 0;
    let output = 'Sections:\n';
    output += "Idx Name          Size      VMA       LMA       File off  Algn\n";
    for(const section of result.sections.values()) {
      output += `${i.toString().padStart(3)} ${section.name.padEnd(12)}  ${section.size.toString(16).padStart(8, '0')}  ${section.addr.toString(16).padStart(8, '0')}  ${section.addr.toString(16).padStart(8, '0')}  ${section.offset.toString(16).padStart(8, '0')}\n`;
      output += `                  ${formatSectionFlags(section.flags)}\n`;
      i++;
    }
    console.log(output);
    console.log(dumpCompilationUnit(result.compilationUnits[0]));

    const rootDie = result.compilationUnits[0]?.dies[0];
    expect(rootDie).toBeDefined();
    expect(rootDie?.children).toBeDefined();
    expect(rootDie?.children.length).toBeGreaterThan(0);

    // Ensure at least one nested child was parsed under the root DIE
    const nestedChild = rootDie?.children[0];
    expect(nestedChild).toBeDefined();
    expect(nestedChild?.children).toBeDefined();
  });
});
