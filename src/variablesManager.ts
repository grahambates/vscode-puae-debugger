import { DebugProtocol } from "@vscode/debugprotocol";
import { CpuInfo, VAmiga } from "./vAmiga";
import { SourceMap, Location, LocalLocation, TypeDescriptor, FieldDescriptor } from "./sourceMap";
import { Handles, Scope } from "@vscode/debugadapter";
import { vectors, customAddresses } from "./hardware";
import {
  formatHex,
  u32,
  u16,
  u8,
  i32,
  i16,
  i8,
  formatAddress,
  formatBin,
  formatNumber,
} from "./numbers";
import * as registerParsers from "./amigaRegisterParsers";
import { DisassemblyValue, MemoryArrayValue } from "./evaluateManager";

/**
 * Manages variable inspection and scoping for the debug adapter.
 *
 * Provides hierarchical variable views including:
 * - CPU registers (data, address, status, and special registers)
 * - Custom chip registers with bit-field breakdowns
 * - Interrupt vectors with address resolution
 * - Source symbols with pointer dereferencing
 * - Memory segments information
 */
// Type for array values from evaluate manager
export interface ArrayValue {
  type: "memArray" | "disassembly";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

export class VariablesManager {
  private variableHandles = new Handles<string | ArrayValue>();
  private locationHandles = new Handles<Location>();
  private localsContextByRef = new Map<number, { pc: number | null; regs: Map<number, number> | null }>();
  private structPtrByRef = new Map<number, { ptrAddress: number; getFields: () => FieldDescriptor[] }>();
  private arrayByRef = new Map<number, { baseAddress: number; elementCount: number; elementType: TypeDescriptor; rangeStart: number; rangeEnd: number }>();
  private static readonly ARRAY_PAGE_SIZE = 100;
  private static readonly MAX_STRING_PEEK = 256;

  /**
   * Creates a new VariablesManager instance.
   *
   * @param vAmiga VAmiga instance for reading registers and memory
   * @param sourceMap Source map for symbol resolution and address formatting
   */
  constructor(
    private vAmiga: VAmiga,
    private sourceMap: SourceMap,
  ) {}

  public getScopes(pc: number | null = null, regs: Map<number, number> | null = null): DebugProtocol.Scope[] {
    const scopes: DebugProtocol.Scope[] = [];
    const hasLocals = pc !== null && ((this.sourceMap?.getLocalsForPc(pc)?.length ?? 0) > 0);
    if (hasLocals) {
      const localsRef = this.variableHandles.create('locals');
      this.localsContextByRef.set(localsRef, { pc, regs });
      scopes.push(new Scope("Locals", localsRef, false));
    }
    const hasGlobals = (this.sourceMap?.getGlobalVariables()?.length ?? 0) > 0;
    if (hasGlobals) {
      scopes.push(new Scope("Globals", this.variableHandles.create("globals"), false));
    }
    scopes.push(
      new Scope("CPU Registers", this.variableHandles.create("registers"), false),
      new Scope("Custom Registers", this.variableHandles.create("custom"), false),
      new Scope("Vectors", this.variableHandles.create("vectors"), false),
      new Scope("Symbols", this.variableHandles.create("symbols"), false),
      new Scope("Segments", this.variableHandles.create("segments"), false),
    );
    return scopes;
  }

  public async getVariables(
    variableReference: number,
  ): Promise<DebugProtocol.Variable[]> {
    const id = this.variableHandles.get(variableReference);

    // Check if this is an array value from evaluate manager
    if (typeof id === "object" && id !== null) {
      return this.getArrayVariables(id as ArrayValue);
    }

    if (id === "registers") {
      return await this.registerVariables();
    } else if (id.startsWith("data_reg_")) {
      return await this.dataRegVariables(id);
    } else if (id.startsWith("addr_reg_")) {
      return await this.addressRegVariables(id);
    } else if (id === "sr_flags") {
      return await this.srFlagVariables();
    } else if (id === "custom") {
      return await this.customVariables();
    } else if (id.startsWith("custom_reg_")) {
      return await this.customDetailVariables(id);
    } else if (id === "vectors") {
      return await this.vectorVariables();
    } else if (id === "globals") {
      return await this.globalVariables();
    } else if (id === "symbols") {
      return await this.symbolVariables();
    } else if (id.startsWith("symbol_ptr_")) {
      return this.symbolPointerVariables(id);
    } else if (id === 'locals') {
      const ctx = this.localsContextByRef.get(variableReference);
      return await this.localVariables(ctx?.pc ?? null, ctx?.regs ?? null);
    } else if (id.startsWith('local_ptr:')) {
      return this.localPtrVariables(id);
    } else if (id === 'struct_ptr') {
      const ctx = this.structPtrByRef.get(variableReference);
      return ctx ? await this.renderStructFields(ctx.ptrAddress, ctx.getFields()) : [];
    } else if (id === 'array') {
      const ctx = this.arrayByRef.get(variableReference);
      if (!ctx) return [];
      const count = ctx.rangeEnd - ctx.rangeStart + 1;
      return count > VariablesManager.ARRAY_PAGE_SIZE
        ? this.renderArrayPages(ctx)
        : await this.renderArrayElements(ctx);
    } else if (id === "segments") {
      return this.segmentVariables();
    }
    throw new Error(`Variable access error: Unknown variable ID: ${id}`);
  }

  public async setVariable(
    variableReference: number,
    name: string,
    value: number,
  ): Promise<string> {
    const id = this.variableHandles.get(variableReference);
    let res;
    if (id === "registers") {
      res = await this.vAmiga.setRegister(name, value);
      return res.value;
    } else if (id === "custom") {
      const custom = customAddresses[name as keyof typeof customAddresses];
      if (custom.long) {
        await this.vAmiga.pokeCustom32(custom.address, value);
        return formatHex(value);
      } else {
        await this.vAmiga.pokeCustom16(custom.address, value);
        return formatHex(value, 4);
      }
    } else {
      throw new Error("Variable access error: Variable is not writeable");
    }
  }

  public async registerVariables(): Promise<DebugProtocol.Variable[]> {
    const info = await this.vAmiga.getCpuInfo();
    return Object.keys(info).map((name) => {
      let value = String(info[name as keyof CpuInfo]);
      let variablesReference = 0;
      let memoryReference: string | undefined;

      if (name === "sr") {
        variablesReference = this.variableHandles.create(`sr_flags`);
      } else if (name.startsWith("d")) {
        variablesReference = this.variableHandles.create(`data_reg_${name}`);
      } else if (name.match(/(a[0-9]|pc|usp|msp|isp|vbr)/)) {
        variablesReference = this.variableHandles.create(`addr_reg_${name}`);
        const numVal = Number(value);
        if (this.vAmiga.isValidAddress(numVal)) {
          memoryReference = value;
          value = formatAddress(numVal, this.sourceMap);
        }
      }

      return {
        name,
        value,
        variablesReference,
        memoryReference,
      };
    });
  }

  public async dataRegVariables(id: string): Promise<DebugProtocol.Variable[]> {
    const info = await this.vAmiga.getCpuInfo();
    const name = id.replace("data_reg_", "");
    const value = Number(info[name as keyof CpuInfo]);
    return [
      this.castIntVar(value, i32, 'i32'),
      this.castIntVar(value, u32, 'u32'),
      this.castIntVar(value, i16, 'i16'),
      this.castIntVar(value, u16, 'u16'),
      this.castIntVar(value, i8, 'i8'),
      this.castIntVar(value, u8, 'u8'),
    ];
  }

  public async srFlagVariables(): Promise<DebugProtocol.Variable[]> {
    const info = await this.vAmiga.getCpuInfo();
    const sr = Number(info.sr);

    // Extract individual CPU flags from status register (68000 format)
    const boolFlags = [
      { name: "carry", value: (sr & 0x0001) !== 0 }, // C flag (bit 0)
      { name: "overflow", value: (sr & 0x0002) !== 0 }, // V flag (bit 1)
      { name: "zero", value: (sr & 0x0004) !== 0 }, // Z flag (bit 2)
      { name: "negative", value: (sr & 0x0008) !== 0 }, // N flag (bit 3)
      { name: "extend", value: (sr & 0x0010) !== 0 }, // X flag (bit 4)
      { name: "trace1", value: (sr & 0x8000) !== 0 }, // T1 flag (bit 15)
      { name: "trace0", value: (sr & 0x4000) !== 0 }, // T0 flag (bit 14) - 68020+
      { name: "supervisor", value: (sr & 0x2000) !== 0 }, // S flag (bit 13)
      { name: "master", value: (sr & 0x1000) !== 0 }, // M flag (bit 12) - 68020+
    ];
    const interruptMask = (sr >> 8) & 0x07; // IPL (bits 8-10)
    return [
      ...boolFlags.map(({ name, value }) => ({
        name,
        value: String(value),
        variablesReference: 0,
        presentationHint: { attributes: ["readOnly"] },
      })),
      {
        name: "interruptMask",
        value: formatBin(interruptMask),
        variablesReference: 0,
        presentationHint: { attributes: ["readOnly"] },
      },
    ];
  }

  public async addressRegVariables(
    id: string,
  ): Promise<DebugProtocol.Variable[]> {
    const info = await this.vAmiga.getCpuInfo();
    const name = id.replace("addr_reg_", "");
    const value = Number(info[name as keyof CpuInfo]);
    const variables = [
      this.castIntVar(value, i32, 'i32'),
      this.castIntVar(value, u32, 'u32'),
      this.castIntVar(value, i16, 'i16'),
      this.castIntVar(value, u16, 'u16'),
    ];
    const symbolOffset = this.sourceMap?.findSymbolOffset(value);
    if (symbolOffset) {
      let value = symbolOffset.symbol;
      if (symbolOffset.offset) {
        value += "+" + symbolOffset.offset;
      }
      variables.unshift({
        name: "offset",
        value,
        variablesReference: 0,
        presentationHint: { attributes: ["readOnly"] },
      });
    }
    return variables;
  }

  public async customVariables(): Promise<DebugProtocol.Variable[]> {
    const info = await this.vAmiga.getAllCustomRegisters();
    const variables = Object.keys(info).map((name): DebugProtocol.Variable => {
      let value = info[name].value;
      let memoryReference: string | undefined;
      let variablesReference = 0;

      // Check if this register has bit breakdown support
      if (registerParsers.hasRegisterBitBreakdown(name)) {
        variablesReference = this.variableHandles.create(`custom_reg_${name}`);
      }

      // Handle longword values as addresses
      if (value.length > 6) {
        memoryReference = value;
        value = formatAddress(Number(value), this.sourceMap);
      }
      return {
        name,
        value,
        variablesReference,
        memoryReference,
      };
    });
    // Sort by name
    // TODO: could make this a setting
    variables.sort((a, b) => (a.name < b.name ? -1 : 1));
    return variables;
  }

  public async customDetailVariables(id: string) {
    const info = await this.vAmiga.getAllCustomRegisters();
    const regName = id.replace("custom_reg_", "");
    const regValue = Number(info[regName].value);
    const bits = registerParsers.parseRegister(regName, regValue);
    return bits.map(({ name, value }) => ({
      name,
      value: String(value),
      variablesReference: 0,
      presentationHint: { attributes: ["readOnly"] },
    }));
  }

  public async vectorVariables() {
    const variables: DebugProtocol.Variable[] = [];
    const cpuInfo = await this.vAmiga.getCpuInfo();
    const mem = await this.vAmiga.readMemory(
      Number(cpuInfo.vbr),
      vectors.length * 4,
    );
    for (let i = 0; i < vectors.length; i++) {
      const name = vectors[i];
      if (name) {
        const value = mem.readInt32BE(i * 4);
        variables.push({
          name: `${formatHex(i * 4, 2).replace("0x", "")}: ${name}`,
          value: formatAddress(value, this.sourceMap),
          memoryReference: formatHex(value),
          variablesReference: 0,
        });
      }
    }
    return variables;
  }

  private async globalVariables(): Promise<DebugProtocol.Variable[]> {
    const globals = this.sourceMap.getGlobalVariables();
    const result = await Promise.all(globals.map(async (v) => {
      let value = '???';
      let variablesReference = 0;
      if (v.location.kind === 'addr') {
        try {
          ({ value, variablesReference } = await this.renderTypedValue(v.location.address, v.typeDescriptor));
        } catch { /* leave as ??? */ }
      }
      return {
        name: v.name,
        value,
        type: v.typeName,
        variablesReference,
        presentationHint: { attributes: ['readOnly'] },
      };
    }));
    result.sort((a, b) => (a.name < b.name ? -1 : 1));
    return result;
  }

  public async symbolVariables(): Promise<DebugProtocol.Variable[]> {
    const symbolLengths = this.sourceMap.getSymbolLengths();
    const symbols = this.sourceMap.getSymbols();
    const variables = await Promise.all(
      Object.keys(symbols).map(async (name) => {
        let value = formatHex(symbols[name]);
        const length = symbolLengths?.[name] ?? 0;
        let variablesReference = 0;
        const memoryReference = value;

        if (length === 1 || length === 2 || length === 4) {
          let ptrVal: number;
          if (length === 4) {
            ptrVal = await this.vAmiga.peek32(symbols[name]);
          } else if (length === 2) {
            ptrVal = await this.vAmiga.peek16(symbols[name]);
          } else {
            ptrVal = await this.vAmiga.peek8(symbols[name]);
          }
          if (length === 4) {
            value += " -> " + formatAddress(ptrVal, this.sourceMap);
          } else {
            value += " -> " + formatHex(ptrVal, length * 2);
          }
          variablesReference = this.variableHandles.create(
            `symbol_ptr_${name}:${length}:${ptrVal}`,
          );
        }

        const variable: DebugProtocol.Variable = {
          name,
          value,
          memoryReference,
          presentationHint: { attributes: ["readOnly"] },
          variablesReference,
        };
        const loc = this.sourceMap?.lookupAddress(symbols[name]);
        if (loc) {
          variable.declarationLocationReference = loc
            ? this.locationHandles.create(loc)
            : undefined;
        }
        return variable;
      }),
    );
  // Sort by name
  // TODO: could make this a setting
    variables.sort((a, b) => (a.name < b.name ? -1 : 1));
    return variables;
  }

  public symbolPointerVariables(id: string): DebugProtocol.Variable[] {
    const [_name, lengthStr, valueStr] = id
      .replace("symbol_ptr_", "")
      .split(":");
    const length = Number(lengthStr);
    const value = Number(valueStr);

    if (length === 4) {
      return [this.castIntVar(value, u32, 'u32'), this.castIntVar(value, i32, 'i32')];
    } else if (length === 2) {
      return [this.castIntVar(value, u16, 'u16'), this.castIntVar(value, i16, 'i16')];
    } else {
      return [this.castIntVar(value, u8, 'u8'), this.castIntVar(value, i8, 'i8')];
    }
  }

  private locationToAddress(
    location: LocalLocation,
    cpuInfo: CpuInfo,
    pc: number,
    regs: Map<number, number> | null,
  ): number | undefined {
    const getReg = (index: number): number => {
      if (regs) return regs.get(index) ?? 0;
      if (index < 8) return Number(cpuInfo[`d${index}` as keyof CpuInfo]);
      return Number(cpuInfo[`a${index - 8}` as keyof CpuInfo]);
    };
    switch (location.kind) {
      case 'fbreg': return getReg(13) + location.offset; // A5 = DWARF reg 13
      case 'breg': return getReg(location.reg) + location.offset;
      case 'addr': return location.address;
      case 'cfa': {
        const cfa = this.sourceMap.getCfaForPc(pc);
        if (!cfa) return undefined;
        return getReg(cfa.reg) + cfa.offset + location.offset;
      }
      default: return undefined;
    }
  }

  private async peekBySize(address: number, byteSize: number): Promise<number | undefined> {
    if (byteSize === 4) return this.vAmiga.peek32(address);
    if (byteSize === 2) return this.vAmiga.peek16(address);
    if (byteSize === 1) return this.vAmiga.peek8(address);
    return undefined;
  }

  private async peekFormatted(address: number, byteSize: number): Promise<string> {
    const val = await this.peekBySize(address, byteSize);
    return val !== undefined ? formatNumber(val, byteSize * 2) : '???';
  }

  private async peekString(address: number): Promise<{ content: string; truncated: boolean }> {
    const chars: string[] = [];
    for (let i = 0; i < VariablesManager.MAX_STRING_PEEK; i++) {
      const byte = await this.vAmiga.peek8(address + i);
      if (byte === undefined || byte === 0) break;
      if (byte === 0x5c)                           chars.push('\\\\');
      else if (byte === 0x22)                      chars.push('\\"');
      else if (byte === 0x0a)                      chars.push('\\n');
      else if (byte === 0x0d)                      chars.push('\\r');
      else if (byte === 0x09)                      chars.push('\\t');
      else if (byte >= 0x20 && byte <= 0x7e)       chars.push(String.fromCharCode(byte));
      else                                          chars.push(`\\x${byte.toString(16).padStart(2, '0')}`);
    }
    return { content: chars.join(''), truncated: chars.length === VariablesManager.MAX_STRING_PEEK };
  }

  public async localVariables(pc: number | null = null, regs: Map<number, number> | null = null): Promise<DebugProtocol.Variable[]> {
    const cpuInfo = await this.vAmiga.getCpuInfo();
    const effectivePc = pc ?? Number(cpuInfo.pc);
    const rawLocals = this.sourceMap.getLocalsForPc(effectivePc);
    const locals = await Promise.all(rawLocals.map(async (v) => {
      let value = '???';
      let variablesReference = 0;
      const address = this.locationToAddress(v.location, cpuInfo, effectivePc, regs);
      if (address !== undefined) {
        try {
          ({ value, variablesReference } = await this.renderTypedValue(address, v.typeDescriptor));
        } catch {
          value = '???';
        }
      }
      return {
        name: v.name,
        value,
        type: v.typeName,
        variablesReference,
        presentationHint: { attributes: ["readOnly"] },
      };
    }));
  // Sort by name
  // TODO: could make this a setting
    locals.sort((a, b) => (a.name < b.name ? -1 : 1));
    return locals;
  }

  private async renderTypedValue(address: number, type: TypeDescriptor): Promise<{ value: string; variablesReference: number }> {
    switch (type.kind) {
      case 'primitive':
      case 'unknown':
        return { value: await this.peekFormatted(address, type.byteSize), variablesReference: 0 };
      case 'struct': {
        const ref = this.variableHandles.create('struct_ptr');
        this.structPtrByRef.set(ref, { ptrAddress: address, getFields: type.getFields });
        return { value: formatAddress(address, this.sourceMap), variablesReference: ref };
      }
      case 'array': {
        const ref = this.variableHandles.create('array');
        this.arrayByRef.set(ref, { baseAddress: address, elementCount: type.elementCount, elementType: type.elementType, rangeStart: 0, rangeEnd: type.elementCount - 1 });
        return { value: `[${type.elementCount} elements]`, variablesReference: ref };
      }
      case 'pointer': {
        const ptrVal = await this.vAmiga.peek32(address);
        const ptrStr = formatAddress(ptrVal, this.sourceMap);
        if (!this.vAmiga.isValidAddress(ptrVal))
          return { value: ptrStr, variablesReference: 0 };
        const pointee = type.pointee;
        if (pointee.kind === 'struct') {
          const ref = this.variableHandles.create('struct_ptr');
          this.structPtrByRef.set(ref, { ptrAddress: ptrVal, getFields: pointee.getFields });
          return { value: ptrStr, variablesReference: ref };
        }
        if (pointee.kind === 'primitive' && [1, 2, 4].includes(pointee.byteSize)) {
          if (pointee.byteSize === 1 && ['char', 'unsigned char', 'signed char'].includes(pointee.typeName)) {
            const str = await this.peekString(ptrVal);
            const quoted = str.truncated ? `"${str.content}..."` : `"${str.content}"`;
            return { value: `${ptrStr} ${quoted}`, variablesReference: 0 };
          }
          let derefVal: number | undefined;
          try { derefVal = await this.peekBySize(ptrVal, pointee.byteSize); } catch { /* leave undefined */ }
          if (derefVal !== undefined) {
            const ref = this.variableHandles.create(`local_ptr:${pointee.typeName}:${pointee.byteSize}:${derefVal}`);
            return { value: `${ptrStr} (${formatNumber(derefVal, pointee.byteSize * 2)})`, variablesReference: ref };
          }
        }
        return { value: ptrStr, variablesReference: 0 };
      }
    }
  }

  private arrayPageSize(count: number): number {
    // Returns the page size that gives at most ARRAY_PAGE_SIZE pages per level.
    // Grows by powers of ARRAY_PAGE_SIZE so pagination is naturally recursive.
    let ps = VariablesManager.ARRAY_PAGE_SIZE;
    while (Math.ceil(count / ps) > VariablesManager.ARRAY_PAGE_SIZE) {
      ps *= VariablesManager.ARRAY_PAGE_SIZE;
    }
    return ps;
  }

  private renderArrayPages(ctx: { baseAddress: number; elementCount: number; elementType: TypeDescriptor; rangeStart: number; rangeEnd: number }): DebugProtocol.Variable[] {
    const ps = this.arrayPageSize(ctx.rangeEnd - ctx.rangeStart + 1);
    const pages: DebugProtocol.Variable[] = [];
    for (let start = ctx.rangeStart; start <= ctx.rangeEnd; start += ps) {
      const end = Math.min(start + ps - 1, ctx.rangeEnd);
      const ref = this.variableHandles.create('array');
      this.arrayByRef.set(ref, { ...ctx, rangeStart: start, rangeEnd: end });
      pages.push({
        name: `[${start}..${end}]`,
        value: `[${end - start + 1} elements]`,
        type: ctx.elementType.typeName,
        variablesReference: ref,
        presentationHint: { attributes: ['readOnly'] },
      });
    }
    return pages;
  }

  private async renderArrayElements(ctx: { baseAddress: number; elementType: TypeDescriptor; rangeStart: number; rangeEnd: number }): Promise<DebugProtocol.Variable[]> {
    const { baseAddress, rangeStart, rangeEnd, elementType } = ctx;
    return Promise.all(Array.from({ length: rangeEnd - rangeStart + 1 }, async (_, i) => {
      const idx = rangeStart + i;
      let value = '???'; let variablesReference = 0;
      try {
        ({ value, variablesReference } = await this.renderTypedValue(baseAddress + idx * elementType.byteSize, elementType));
      } catch { /* leave as ??? */ }
      return {
        name: `[${idx}]`,
        value,
        type: elementType.typeName,
        variablesReference,
        presentationHint: { attributes: ['readOnly'] },
      };
    }));
  }

  private async renderStructFields(baseAddress: number, fields: FieldDescriptor[]): Promise<DebugProtocol.Variable[]> {
    return Promise.all(fields.map(async (field) => {
      let value = '???';
      let variablesReference = 0;
      try {
        ({ value, variablesReference } = await this.renderTypedValue(baseAddress + field.offset, field.type));
      } catch { /* leave as ??? */ }
      return {
        name: field.name,
        value,
        type: field.type.typeName,
        variablesReference,
        presentationHint: { attributes: ['readOnly'] },
      };
    }));
  }

  private localPtrVariables(id: string): DebugProtocol.Variable[] {
    const parts = id.split(':');
    const typeName = parts[1];
    const size = Number(parts[2]);
    const value = Number(parts[3]);
    return [{
      name: 'value',
      value: formatNumber(value, size * 2),
      type: typeName,
      variablesReference: 0,
      presentationHint: { attributes: ['readOnly'] },
    }];
  }

  public segmentVariables(): DebugProtocol.Variable[] {
    const segments = this.sourceMap.getSegmentsInfo();
    return segments.map((seg) => {
      const value = formatHex(seg.address);
      return {
        name: seg.name,
        value,
        memoryReference: value,
        variablesReference: 0,
        presentationHint: { attributes: ["readOnly"] },
      };
    });
  }

  /**
   * Builds a complete variable lookup table for expression evaluation.
   *
   * @returns Record mapping variable names to their numeric values
   */
  public async getFlatVariables(): Promise<Record<string, number>> {
    const variables: Record<string, number> = {};
    const cpuInfo = await this.vAmiga.getCpuInfo();
    const customRegs = await this.vAmiga.getAllCustomRegisters();
    const symbols = this.sourceMap?.getSymbols() ?? {};
    for (const k in cpuInfo) {
      variables[k] = Number(cpuInfo[k as keyof CpuInfo]);
    }
    for (const k in customRegs) {
      variables[k] = Number(customRegs[k]?.value);
    }
    for (const k in symbols) {
      variables[k] = Number(symbols[k]);
    }
    variables.sp = variables.a7;
    return variables;
  }

  public getVariableReference(variableReference: number): string | ArrayValue {
    return this.variableHandles.get(variableReference);
  }

  public getLocationReference(locationReference: number): Location {
    return this.locationHandles.get(locationReference);
  }

  /**
   * Creates a handle for array values from evaluate manager.
   * @param arrayValue The array value to register
   * @returns The variables reference handle
   */
  public createArrayHandle(arrayValue: ArrayValue): number {
    return this.variableHandles.create(arrayValue);
  }

  /**
   * Gets variables for an array value registered by evaluate manager.
   */
  private getArrayVariables(arrayValue: ArrayValue): DebugProtocol.Variable[] {
    if (arrayValue.type === "disassembly") {
      return this.getDisassemblyVariables(arrayValue.data);
    } else if (arrayValue.type === "memArray") {
      return this.getMemArrayVariables(arrayValue.data);
    }
    return [];
  }

  private castIntVar(
    value: number,
    fn: (v: number) => number,
    name: string,
  ): DebugProtocol.Variable {
    return {
      name,
      value: fn(value).toString(),
      variablesReference: 0,
      presentationHint: { attributes: ["readOnly"] },
    };
  }

  private getDisassemblyVariables(
    arrayData: DisassemblyValue,
  ): DebugProtocol.Variable[] {
    const variables: DebugProtocol.Variable[] = [];
    // Find the maximum width of instruction bytes for alignment
    const maxHexWidth = Math.max(
      ...arrayData.instructions.map(
        (instr) => (instr.instructionBytes || "").length,
      ),
    );

    for (let i = 0; i < arrayData.instructions.length; i++) {
      const instr = arrayData.instructions[i];
      const address = instr.address;
      const hexBytes = (instr.instructionBytes || "").padEnd(maxHexWidth, " ");

      variables.push({
        name: address,
        value: `${hexBytes} ${instr.instruction}`,
        memoryReference: address,
        variablesReference: 0,
        presentationHint: { attributes: ["readOnly"] },
      });
    }

    return variables;
  }

  private getMemArrayVariables(
    arrayData: MemoryArrayValue,
  ): DebugProtocol.Variable[] {
    // Handle array results
    const { elements, elementSize, baseAddress, valuesPerLine = 1 } = arrayData;
    if (!elements || !elementSize) {
      return [];
    }

    const variables: DebugProtocol.Variable[] = [];

    // Group elements by valuesPerLine
    for (let i = 0; i < elements.length; i += valuesPerLine) {
      const groupElements = elements.slice(i, i + valuesPerLine);
      const groupStartAddr = baseAddress + i * elementSize;

      if (valuesPerLine === 1) {
        // Single element per line - show both hex and decimal for better debugging
        const value = groupElements[0];

        let displayValue: string;
        if (elementSize === 4 && this.vAmiga.isValidAddress(value)) {
          displayValue = formatAddress(value, this.sourceMap);
        } else {
          displayValue = formatNumber(value, elementSize * 2);
        }

        variables.push({
          name: `[${i}]`,
          value: displayValue,
          memoryReference: formatHex(groupStartAddr),
          variablesReference: 0,
          presentationHint: { attributes: ["readOnly"] },
        });
      } else {
        // Multiple elements per line - traditional hex listing style
        const groupValues = groupElements.map((value) => {
          if (elementSize === 4 && this.vAmiga.isValidAddress(value)) {
            return formatAddress(value, this.sourceMap);
          } else {
            // Remove 0x prefix for cleaner table view
            return value
              .toString(16)
              .padStart(elementSize * 2, "0")
              .toUpperCase();
          }
        });

        // Use hex offset as label for traditional hex dump style
        const offsetLabel = groupStartAddr
          .toString(16)
          .padStart(8, "0")
          .toUpperCase();
        const groupValue = groupValues.join(" ");

        variables.push({
          name: offsetLabel,
          value: groupValue,
          memoryReference: formatHex(groupStartAddr),
          variablesReference: 0,
          presentationHint: { attributes: ["readOnly"], kind: "virtual" },
        });
      }
    }
    return variables;
  }
}
