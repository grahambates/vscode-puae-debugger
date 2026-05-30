import * as assert from "assert";
import * as sinon from "sinon";
import { VariablesManager } from "../variablesManager";
import { VAmiga, CpuInfo } from "../vAmiga";
import { SourceMap } from "../sourceMap";
import { MemoryType } from "../amigaHunkParser";

/**
 * Comprehensive test suite for VariablesManager
 * Tests all variable types: CPU registers, custom registers, vectors, symbols, segments
 */
describe("VariablesManager - Comprehensive Tests", () => {
  let variablesManager: VariablesManager;
  let mockVAmiga: sinon.SinonStubbedInstance<VAmiga>;
  let mockSourceMap: sinon.SinonStubbedInstance<SourceMap>;

  beforeEach(() => {
    mockVAmiga = sinon.createStubInstance(VAmiga);
    mockSourceMap = sinon.createStubInstance(SourceMap);
    mockSourceMap.getGlobalVariables.returns([]);
    variablesManager = new VariablesManager(mockVAmiga, mockSourceMap);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe("Scopes Management", () => {
    it("should return all scopes with Symbols when no DWARF globals", () => {
      const scopes = variablesManager.getScopes();

      assert.strictEqual(scopes.length, 5);
      assert.strictEqual(scopes[0].name, "CPU Registers");
      assert.strictEqual(scopes[1].name, "Custom Registers");
      assert.strictEqual(scopes[2].name, "Vectors");
      assert.strictEqual(scopes[3].name, "Symbols");
      assert.strictEqual(scopes[4].name, "Segments");
    });

    it("should show Globals scope after Locals and keep Symbols when DWARF globals are present", () => {
      mockSourceMap.getLocalsForPc.returns([{ name: 'x', byteSize: 4, typeName: 'int', location: { kind: 'addr', address: 0x1000 }, typeDescriptor: { kind: 'primitive', typeName: 'int', byteSize: 4 } }]);
      mockSourceMap.getGlobalVariables.returns([{
        name: 'global_int', typeName: 'int', byteSize: 4,
        location: { kind: 'addr', address: 0x2040 },
        typeDescriptor: { kind: 'primitive', typeName: 'int', byteSize: 4 },
      }]);
      const scopes = variablesManager.getScopes(0x1000);
      assert.strictEqual(scopes[0].name, 'Locals');
      assert.strictEqual(scopes[1].name, 'Globals');
      assert.ok(scopes.some(s => s.name === 'Symbols'), 'Expected Symbols scope to remain');
    });

    it("should expand Globals scope using type information", async () => {
      mockSourceMap.getGlobalVariables.returns([
        { name: 'global_int',   typeName: 'int',   byteSize: 4, location: { kind: 'addr', address: 0x2040 }, typeDescriptor: { kind: 'primitive', typeName: 'int',   byteSize: 4 } },
        { name: 'global_short', typeName: 'short', byteSize: 2, location: { kind: 'addr', address: 0x2044 }, typeDescriptor: { kind: 'primitive', typeName: 'short', byteSize: 2 } },
      ]);
      mockVAmiga.peek32.withArgs(0x2040).resolves(0x11111111);
      mockVAmiga.peek16.withArgs(0x2044).resolves(0x2222);
      mockSourceMap.findSymbolOffset.returns(undefined);

      const scopes = variablesManager.getScopes();
      const globalsScope = scopes.find(s => s.name === 'Globals');
      assert.ok(globalsScope);

      const vars = await variablesManager.getVariables(globalsScope!.variablesReference);
      assert.strictEqual(vars.length, 2);
      // sorted by name: global_int, global_short
      assert.strictEqual(vars[0].name, 'global_int');
      assert.ok(vars[0].value.includes('11111111'));
      assert.strictEqual(vars[0].type, 'int');
      assert.strictEqual(vars[1].name, 'global_short');
      assert.ok(vars[1].value.includes('2222'));
      assert.strictEqual(vars[1].type, 'short');
    });

    it("should expand a struct-typed global into its fields", async () => {
      const STRUCT_ADDR = 0x2050;
      mockSourceMap.getGlobalVariables.returns([{
        name: 's', typeName: 'struct Struct', byteSize: 7,
        location: { kind: 'addr', address: STRUCT_ADDR },
        typeDescriptor: {
          kind: 'struct', typeName: 'struct Struct', byteSize: 7,
          getFields: () => [
            { name: '_int',   offset: 0, type: { kind: 'primitive', typeName: 'int',   byteSize: 4 } },
            { name: '_short', offset: 4, type: { kind: 'primitive', typeName: 'short', byteSize: 2 } },
            { name: '_char',  offset: 6, type: { kind: 'primitive', typeName: 'char',  byteSize: 1 } },
          ],
        },
      }]);
      mockSourceMap.findSymbolOffset.returns(undefined);
      mockVAmiga.peek32.withArgs(STRUCT_ADDR + 0).resolves(0x99999999);
      mockVAmiga.peek16.withArgs(STRUCT_ADDR + 4).resolves(0x8888);
      mockVAmiga.peek8.withArgs(STRUCT_ADDR + 6).resolves(0x77);

      const scopes = variablesManager.getScopes();
      const globalsScope = scopes.find(s => s.name === 'Globals');
      assert.ok(globalsScope);

      const vars = await variablesManager.getVariables(globalsScope!.variablesReference);
      assert.strictEqual(vars.length, 1);
      assert.strictEqual(vars[0].name, 's');
      assert.ok(vars[0].variablesReference !== 0, 'Expected expandable handle for struct global');

      const fields = await variablesManager.getVariables(vars[0].variablesReference);
      assert.strictEqual(fields.length, 3);
      assert.strictEqual(fields[0].name, '_int');
      assert.ok(fields[0].value.includes('99999999'));
      assert.strictEqual(fields[1].name, '_short');
      assert.ok(fields[1].value.includes('8888'));
      assert.strictEqual(fields[2].name, '_char');
      assert.ok(fields[2].value.includes('77'));
    });

    it("should include Locals scope only when there are locals for the PC", () => {
      mockSourceMap.getLocalsForPc.returns([{ name: 'x', byteSize: 4, typeName: 'int', location: { kind: 'addr', address: 0x1000 }, typeDescriptor: { kind: 'primitive', typeName: 'int', byteSize: 4 } }]);
      const scopes = variablesManager.getScopes(0x1000);
      assert.strictEqual(scopes[0].name, "Locals");
      assert.strictEqual(scopes.length, 6);

      mockSourceMap.getLocalsForPc.returns([]);
      const emptyScopes = variablesManager.getScopes(0x2000);
      assert.ok(!emptyScopes.some(s => s.name === "Locals"));
    });

    it("should create unique variable handles for each scope", () => {
      const scopes = variablesManager.getScopes();

      const references = scopes.map((s) => s.variablesReference);
      const uniqueReferences = new Set(references);

      assert.strictEqual(
        references.length,
        uniqueReferences.size,
        "All references should be unique",
      );
    });
  });

  describe("Local Pointer Variables", () => {
    const mockCpuBase: CpuInfo = {
      pc: "0x1000", d0:"0", d1:"0", d2:"0", d3:"0", d4:"0", d5:"0", d6:"0", d7:"0",
      a0:"0", a1:"0", a2:"0", a3:"0", a4:"0", a5:"0", a6:"0", a7:"0x8000",
      sr:"0", usp:"0", msp:"0", isp:"0", vbr:"0", irc:"0", sfc:"0", dfc:"0", cacr:"0", caar:"0",
    };

    it("should show dereferenced value inline and create child handle for int*", async () => {
      mockVAmiga.getCpuInfo.resolves(mockCpuBase);
      mockVAmiga.isValidAddress.returns(true);
      mockSourceMap.getLocalsForPc.returns([{
        name: 'ptr', typeName: 'int *', byteSize: 4,
        location: { kind: 'addr', address: 0x3000 },
        typeDescriptor: { kind: 'pointer', typeName: 'int *', byteSize: 4,
                          pointee: { kind: 'primitive', typeName: 'int', byteSize: 4 } },
      }]);
      mockVAmiga.peek32.withArgs(0x3000).resolves(0x00001234);  // pointer value
      mockVAmiga.peek32.withArgs(0x00001234).resolves(0x22222222); // dereferenced value
      mockSourceMap.findSymbolOffset.returns(undefined);
      mockSourceMap.getCfaForPc.returns(undefined);

      const scopes = variablesManager.getScopes(0x1000);
      const localsRef = scopes[0].variablesReference;
      const vars = await variablesManager.getVariables(localsRef);

      assert.strictEqual(vars.length, 1);
      assert.ok(vars[0].value.includes('0x22222222'), `Expected dereffed value in "${vars[0].value}"`);
      assert.ok(vars[0].value.includes('(') && vars[0].value.includes(')'), `Expected parens in "${vars[0].value}"`);
      assert.ok(vars[0].variablesReference !== 0, 'Expected non-zero variablesReference for pointer');

      const children = await variablesManager.getVariables(vars[0].variablesReference);
      assert.strictEqual(children.length, 1);
      assert.strictEqual(children[0].name, 'value');
      assert.strictEqual(children[0].type, 'int');
      assert.ok(children[0].value.includes('22222222'));
    });

    it("should show plain pointer address for void*", async () => {
      mockVAmiga.getCpuInfo.resolves(mockCpuBase);
      mockVAmiga.isValidAddress.returns(true);
      mockSourceMap.getLocalsForPc.returns([{
        name: 'vp', typeName: 'void *', byteSize: 4,
        location: { kind: 'addr', address: 0x4000 },
        typeDescriptor: { kind: 'pointer', typeName: 'void *', byteSize: 4,
                          pointee: { kind: 'unknown', typeName: 'void', byteSize: 0 } },
      }]);
      mockVAmiga.peek32.withArgs(0x4000).resolves(0x00005678);
      mockSourceMap.findSymbolOffset.returns(undefined);

      const scopes = variablesManager.getScopes(0x1000);
      const localsRef = scopes[0].variablesReference;
      const vars = await variablesManager.getVariables(localsRef);

      assert.ok(!vars[0].value.includes('('), 'Expected no parens for void*');
      assert.strictEqual(vars[0].variablesReference, 0, 'Expected no child handle for void*');
    });

    it("should not dereference when pointer value is not a valid address", async () => {
      mockVAmiga.getCpuInfo.resolves(mockCpuBase);
      mockVAmiga.isValidAddress.returns(false);
      mockSourceMap.getLocalsForPc.returns([{
        name: 'ptr', typeName: 'int *', byteSize: 4,
        location: { kind: 'addr', address: 0x5000 },
        typeDescriptor: { kind: 'pointer', typeName: 'int *', byteSize: 4,
                          pointee: { kind: 'primitive', typeName: 'int', byteSize: 4 } },
      }]);
      mockVAmiga.peek32.withArgs(0x5000).resolves(0xDEADBEEF);

      const scopes = variablesManager.getScopes(0x1000);
      const localsRef = scopes[0].variablesReference;
      const vars = await variablesManager.getVariables(localsRef);

      assert.ok(!vars[0].value.includes('('), 'Expected no parens for invalid address');
      assert.strictEqual(vars[0].variablesReference, 0);
    });

    it("should show address and expand to fields for a pointer-to-struct", async () => {
      const PTR_ADDR = 0x6000;
      const STRUCT_ADDR = 0x2024;
      mockVAmiga.getCpuInfo.resolves(mockCpuBase);
      mockVAmiga.isValidAddress.returns(true);
      mockSourceMap.getLocalsForPc.returns([{
        name: 'ptr_struct',
        typeName: 'struct Struct *',
        byteSize: 4,
        location: { kind: 'addr', address: PTR_ADDR },
        typeDescriptor: {
          kind: 'pointer', typeName: 'struct Struct *', byteSize: 4,
          pointee: {
            kind: 'struct', typeName: 'struct Struct', byteSize: 7,
            getFields: () => [
              { name: '_int',   offset: 0, type: { kind: 'primitive', typeName: 'int',       byteSize: 4 } },
              { name: '_short', offset: 4, type: { kind: 'primitive', typeName: 'short int', byteSize: 2 } },
              { name: '_char',  offset: 6, type: { kind: 'primitive', typeName: 'char',      byteSize: 1 } },
            ],
          },
        },
      }]);
      mockSourceMap.findSymbolOffset.returns(undefined);
      mockVAmiga.peek32.withArgs(PTR_ADDR).resolves(STRUCT_ADDR);
      mockVAmiga.peek32.withArgs(STRUCT_ADDR + 0).resolves(0x99999999);
      mockVAmiga.peek16.withArgs(STRUCT_ADDR + 4).resolves(0x8888);
      mockVAmiga.peek8.withArgs(STRUCT_ADDR + 6).resolves(0x77);

      const scopes = variablesManager.getScopes(0x1000);
      const localsRef = scopes[0].variablesReference;
      const vars = await variablesManager.getVariables(localsRef);

      assert.strictEqual(vars.length, 1);
      assert.ok(vars[0].value.includes('0x00002024'), `Expected pointer address in "${vars[0].value}"`);
      assert.ok(vars[0].variablesReference !== 0, 'Expected non-zero variablesReference for struct pointer');

      const fields = await variablesManager.getVariables(vars[0].variablesReference);
      assert.strictEqual(fields.length, 3);
      assert.strictEqual(fields[0].name, '_int');
      assert.ok(fields[0].value.includes('99999999'));
      assert.strictEqual(fields[0].type, 'int');
      assert.strictEqual(fields[1].name, '_short');
      assert.ok(fields[1].value.includes('8888'));
      assert.strictEqual(fields[1].type, 'short int');
      assert.strictEqual(fields[2].name, '_char');
      assert.ok(fields[2].value.includes('77'));
      assert.strictEqual(fields[2].type, 'char');
    });

    it("should dereference a pointer field inside a struct", async () => {
      const PTR_VAR_ADDR = 0x6000;
      const STRUCT_ADDR  = 0x2028;
      const INT_ADDR     = 0x2024;
      mockVAmiga.getCpuInfo.resolves(mockCpuBase);
      mockVAmiga.isValidAddress.returns(true);
      mockSourceMap.getLocalsForPc.returns([{
        name: 'ptr_struct',
        typeName: 'struct Struct *',
        byteSize: 4,
        location: { kind: 'addr', address: PTR_VAR_ADDR },
        typeDescriptor: {
          kind: 'pointer', typeName: 'struct Struct *', byteSize: 4,
          pointee: {
            kind: 'struct', typeName: 'struct Struct', byteSize: 8,
            getFields: () => [
              { name: '_int_ptr', offset: 0, type: { kind: 'pointer', typeName: 'int *', byteSize: 4,
                                                     pointee: { kind: 'primitive', typeName: 'int', byteSize: 4 } } },
              { name: '_short',   offset: 4, type: { kind: 'primitive', typeName: 'short int', byteSize: 2 } },
              { name: '_char',    offset: 6, type: { kind: 'primitive', typeName: 'char',      byteSize: 1 } },
            ],
          },
        },
      }]);
      mockSourceMap.findSymbolOffset.returns(undefined);
      mockVAmiga.peek32.withArgs(PTR_VAR_ADDR).resolves(STRUCT_ADDR);
      mockVAmiga.peek32.withArgs(STRUCT_ADDR + 0).resolves(INT_ADDR);
      mockVAmiga.peek32.withArgs(INT_ADDR).resolves(0x99999999);
      mockVAmiga.peek16.withArgs(STRUCT_ADDR + 4).resolves(0x8888);
      mockVAmiga.peek8.withArgs(STRUCT_ADDR + 6).resolves(0x77);

      const scopes = variablesManager.getScopes(0x1000);
      const localsRef = scopes[0].variablesReference;
      const vars = await variablesManager.getVariables(localsRef);

      assert.strictEqual(vars.length, 1);
      assert.ok(vars[0].value.includes('0x00002028'), `Expected struct address in "${vars[0].value}"`);
      assert.ok(vars[0].variablesReference !== 0, 'Expected expandable handle for struct pointer');

      const fields = await variablesManager.getVariables(vars[0].variablesReference);
      assert.strictEqual(fields.length, 3);

      const intPtrField = fields.find(f => f.name === '_int_ptr');
      assert.ok(intPtrField, '_int_ptr field should exist');
      assert.ok(intPtrField!.value.includes('0x00002024'), `Expected pointer addr in "${intPtrField!.value}"`);
      assert.ok(intPtrField!.value.includes('('), `Expected dereffed value in parens: "${intPtrField!.value}"`);
      assert.ok(intPtrField!.variablesReference !== 0, 'Expected expandable handle for _int_ptr');

      const shortField = fields.find(f => f.name === '_short');
      assert.ok(shortField!.value.includes('8888'));
      const charField = fields.find(f => f.name === '_char');
      assert.ok(charField!.value.includes('77'));
    });

    it("should display char* as a quoted string inline", async () => {
      const PTR_ADDR = 0x7000;
      const STR_ADDR = 0x0000A1B0;
      mockVAmiga.getCpuInfo.resolves(mockCpuBase);
      mockVAmiga.isValidAddress.returns(true);
      mockSourceMap.getLocalsForPc.returns([{
        name: 'hello', typeName: 'const char *', byteSize: 4,
        location: { kind: 'addr', address: PTR_ADDR },
        typeDescriptor: { kind: 'pointer', typeName: 'const char *', byteSize: 4,
                          pointee: { kind: 'primitive', typeName: 'char', byteSize: 1 } },
      }]);
      mockVAmiga.peek32.withArgs(PTR_ADDR).resolves(STR_ADDR);
      mockSourceMap.findSymbolOffset.returns(undefined);
      // Spell out "hello!" then null terminator
      const str = 'hello!';
      for (let i = 0; i < str.length; i++)
        mockVAmiga.peek8.withArgs(STR_ADDR + i).resolves(str.charCodeAt(i));
      mockVAmiga.peek8.withArgs(STR_ADDR + str.length).resolves(0);

      const scopes = variablesManager.getScopes(0x1000);
      const localsRef = scopes[0].variablesReference;
      const vars = await variablesManager.getVariables(localsRef);

      assert.strictEqual(vars.length, 1);
      assert.ok(vars[0].value.includes('"hello!"'), `Expected quoted string in "${vars[0].value}"`);
      assert.strictEqual(vars[0].variablesReference, 0, 'Expected no child handle for string');
    });

    it("should truncate char* display at 256 bytes", async () => {
      const PTR_ADDR = 0x7100;
      const STR_ADDR = 0x0000B000;
      mockVAmiga.getCpuInfo.resolves(mockCpuBase);
      mockVAmiga.isValidAddress.returns(true);
      mockSourceMap.getLocalsForPc.returns([{
        name: 'longstr', typeName: 'char *', byteSize: 4,
        location: { kind: 'addr', address: PTR_ADDR },
        typeDescriptor: { kind: 'pointer', typeName: 'char *', byteSize: 4,
                          pointee: { kind: 'primitive', typeName: 'char', byteSize: 1 } },
      }]);
      mockVAmiga.peek32.withArgs(PTR_ADDR).resolves(STR_ADDR);
      mockSourceMap.findSymbolOffset.returns(undefined);
      // All 256 bytes are 'A' — no null terminator within the limit
      for (let i = 0; i < 256; i++)
        mockVAmiga.peek8.withArgs(STR_ADDR + i).resolves(0x41); // 'A'

      const scopes = variablesManager.getScopes(0x1000);
      const localsRef = scopes[0].variablesReference;
      const vars = await variablesManager.getVariables(localsRef);

      assert.ok(vars[0].value.endsWith('..."'), `Expected truncation ellipsis in "${vars[0].value}"`);
    });
  });

  describe("Local Array Variables", () => {
    const mockCpuBase: CpuInfo = {
      pc: "0x1000", d0:"0", d1:"0", d2:"0", d3:"0", d4:"0", d5:"0", d6:"0", d7:"0",
      a0:"0", a1:"0", a2:"0", a3:"0", a4:"0", a5:"0", a6:"0", a7:"0x8000",
      sr:"0", usp:"0", msp:"0", isp:"0", vbr:"0", irc:"0", sfc:"0", dfc:"0", cacr:"0", caar:"0",
    };

    it("should show element count and expand to indexed elements for int array", async () => {
      const ARRAY_ADDR = 0x7FD4;
      mockVAmiga.getCpuInfo.resolves(mockCpuBase);
      mockSourceMap.getLocalsForPc.returns([{
        name: 'array', typeName: 'int[]', byteSize: 40,
        location: { kind: 'addr', address: ARRAY_ADDR },
        typeDescriptor: {
          kind: 'array', typeName: 'int[]', byteSize: 40, elementCount: 10,
          elementType: { kind: 'primitive', typeName: 'int', byteSize: 4 },
        },
      }]);
      for (let i = 0; i < 10; i++) {
        mockVAmiga.peek32.withArgs(ARRAY_ADDR + i * 4).resolves(i + 1);
      }
      mockSourceMap.findSymbolOffset.returns(undefined);

      const scopes = variablesManager.getScopes(0x1000);
      const vars = await variablesManager.getVariables(scopes[0].variablesReference);

      assert.strictEqual(vars.length, 1);
      assert.strictEqual(vars[0].name, 'array');
      assert.ok(vars[0].value.includes('10'), `Expected element count in "${vars[0].value}"`);
      assert.ok(vars[0].variablesReference !== 0, 'Expected expandable handle for array');

      const elements = await variablesManager.getVariables(vars[0].variablesReference);
      assert.strictEqual(elements.length, 10);
      assert.strictEqual(elements[0].name, '[0]');
      assert.strictEqual(elements[0].type, 'int');
      assert.strictEqual(elements[9].name, '[9]');
    });

    it("should paginate arrays larger than 100 elements into page groups", async () => {
      const ARRAY_ADDR = 0x5000;
      mockVAmiga.getCpuInfo.resolves(mockCpuBase);
      mockSourceMap.getLocalsForPc.returns([{
        name: 'big', typeName: 'int[]', byteSize: 600,
        location: { kind: 'addr', address: ARRAY_ADDR },
        typeDescriptor: {
          kind: 'array', typeName: 'int[]', byteSize: 600, elementCount: 150,
          elementType: { kind: 'primitive', typeName: 'int', byteSize: 4 },
        },
      }]);
      mockSourceMap.findSymbolOffset.returns(undefined);
      mockVAmiga.peek32.resolves(0x42);

      const scopes = variablesManager.getScopes(0x1000);
      const vars = await variablesManager.getVariables(scopes[0].variablesReference);
      assert.ok(vars[0].value.includes('150'));

      const pages = await variablesManager.getVariables(vars[0].variablesReference);
      assert.strictEqual(pages.length, 2);
      assert.strictEqual(pages[0].name, '[0..99]');
      assert.strictEqual(pages[1].name, '[100..149]');
      assert.ok(pages[0].variablesReference !== 0);
      assert.ok(pages[1].variablesReference !== 0);

      const firstPage = await variablesManager.getVariables(pages[0].variablesReference);
      assert.strictEqual(firstPage.length, 100);
      assert.strictEqual(firstPage[0].name, '[0]');
      assert.strictEqual(firstPage[99].name, '[99]');

      const secondPage = await variablesManager.getVariables(pages[1].variablesReference);
      assert.strictEqual(secondPage.length, 50);
      assert.strictEqual(secondPage[0].name, '[100]');
      assert.strictEqual(secondPage[49].name, '[149]');
    });

    it("should paginate recursively for very large arrays", async () => {
      const ARRAY_ADDR = 0x5000;
      mockVAmiga.getCpuInfo.resolves(mockCpuBase);
      // 10001 elements: top-level pageSize=10000 → 2 pages; second level pageSize=100 → 100 sub-pages
      mockSourceMap.getLocalsForPc.returns([{
        name: 'huge', typeName: 'int[]', byteSize: 40004,
        location: { kind: 'addr', address: ARRAY_ADDR },
        typeDescriptor: {
          kind: 'array', typeName: 'int[]', byteSize: 40004, elementCount: 10001,
          elementType: { kind: 'primitive', typeName: 'int', byteSize: 4 },
        },
      }]);
      mockSourceMap.findSymbolOffset.returns(undefined);
      mockVAmiga.peek32.resolves(0x1);

      const scopes = variablesManager.getScopes(0x1000);
      const vars = await variablesManager.getVariables(scopes[0].variablesReference);

      const topPages = await variablesManager.getVariables(vars[0].variablesReference);
      assert.strictEqual(topPages.length, 2);
      assert.strictEqual(topPages[0].name, '[0..9999]');
      assert.strictEqual(topPages[1].name, '[10000..10000]');

      // [0..9999] has 10000 elements → 100 sub-pages of 100 each
      const midPages = await variablesManager.getVariables(topPages[0].variablesReference);
      assert.strictEqual(midPages.length, 100);
      assert.strictEqual(midPages[0].name, '[0..99]');
      assert.strictEqual(midPages[99].name, '[9900..9999]');

      // [0..99] has 100 elements → rendered directly
      const leafElements = await variablesManager.getVariables(midPages[0].variablesReference);
      assert.strictEqual(leafElements.length, 100);
      assert.strictEqual(leafElements[0].name, '[0]');
      assert.strictEqual(leafElements[99].name, '[99]');

      // [10000..10000] → single element
      const tailElements = await variablesManager.getVariables(topPages[1].variablesReference);
      assert.strictEqual(tailElements.length, 1);
      assert.strictEqual(tailElements[0].name, '[10000]');
    });
  });

  describe("CPU Register Variables", () => {
    it("should return all CPU register variables", async () => {
      const mockCpuInfo: CpuInfo = {
        pc: "0x1000",
        d0: "0x42",
        d1: "0x84",
        d2: "0x100",
        d3: "0x200",
        d4: "0x300",
        d5: "0x400",
        d6: "0x500",
        d7: "0x600",
        a0: "0x8000",
        a1: "0x8100",
        a2: "0x8200",
        a3: "0x8300",
        a4: "0x8400",
        a5: "0x8500",
        a6: "0x8600",
        a7: "0x8700",
        sr: "0x2000",
        usp: "0x9000",
        isp: "0x9100",
        msp: "0x9200",
        vbr: "0x0",
        irc: "0x4E71",
        sfc: "0x1",
        dfc: "0x1",
        cacr: "0x0",
        caar: "0x0",
      };
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);
      mockVAmiga.isValidAddress.returns(true);

      const variables = await variablesManager.registerVariables();

      assert.strictEqual(variables.length, Object.keys(mockCpuInfo).length);

      // Check data register has expandable reference
      const d0Var = variables.find((v) => v.name === "d0");
      assert.ok(d0Var);
      assert.strictEqual(d0Var.value, "0x42");
      assert.ok(d0Var.variablesReference > 0);

      // Check address register has memory reference and expandable
      const a0Var = variables.find((v) => v.name === "a0");
      assert.ok(a0Var);
      assert.strictEqual(a0Var.memoryReference, "0x8000");
      assert.ok(a0Var.variablesReference > 0);

      // Check SR has expandable flags
      const srVar = variables.find((v) => v.name === "sr");
      assert.ok(srVar);
      assert.ok(srVar.variablesReference > 0);
    });

    it("should format address registers with symbol information", async () => {
      const mockCpuInfo: CpuInfo = {
        pc: "0x1000",
        a0: "0x2000",
        d0: "0x0",
        d1: "0x0",
        d2: "0x0",
        d3: "0x0",
        d4: "0x0",
        d5: "0x0",
        d6: "0x0",
        d7: "0x0",
        a1: "0x0",
        a2: "0x0",
        a3: "0x0",
        a4: "0x0",
        a5: "0x0",
        a6: "0x0",
        a7: "0x0",
        sr: "0x0",
        usp: "0x0",
        isp: "0x0",
        msp: "0x0",
        vbr: "0x0",
        irc: "0x0",
        sfc: "0x0",
        dfc: "0x0",
        cacr: "0x0",
        caar: "0x0",
      };
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);
      mockVAmiga.isValidAddress.returns(true);
      mockSourceMap.findSymbolOffset
        .withArgs(0x2000)
        .returns({ symbol: "main", offset: 16 });

      const variables = await variablesManager.registerVariables();
      const a0Var = variables.find((v) => v.name === "a0");

      assert.ok(a0Var);
      assert.strictEqual(a0Var.value, "0x00002000 = main+16");
    });

    it("should handle invalid addresses without memory reference", async () => {
      const mockCpuInfo: CpuInfo = {
        pc: "0x1000",
        a0: "0xFFFFFFFF",
        d0: "0x0",
        d1: "0x0",
        d2: "0x0",
        d3: "0x0",
        d4: "0x0",
        d5: "0x0",
        d6: "0x0",
        d7: "0x0",
        a1: "0x0",
        a2: "0x0",
        a3: "0x0",
        a4: "0x0",
        a5: "0x0",
        a6: "0x0",
        a7: "0x0",
        sr: "0x0",
        usp: "0x0",
        isp: "0x0",
        msp: "0x0",
        vbr: "0x0",
        irc: "0x0",
        sfc: "0x0",
        dfc: "0x0",
        cacr: "0x0",
        caar: "0x0",
      };
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);
      mockVAmiga.isValidAddress.returns(false);

      const variables = await variablesManager.registerVariables();
      const a0Var = variables.find((v) => v.name === "a0");

      assert.ok(a0Var);
      assert.strictEqual(a0Var.memoryReference, undefined);
    });
  });

  describe("Data Register Detail Variables", () => {
    it("should return cast variations of data register value", async () => {
      const mockCpuInfo: CpuInfo = {
        d0: "0x80000042", // Negative 32-bit, positive others
        pc: "0x0",
        d1: "0x0",
        d2: "0x0",
        d3: "0x0",
        d4: "0x0",
        d5: "0x0",
        d6: "0x0",
        d7: "0x0",
        a0: "0x0",
        a1: "0x0",
        a2: "0x0",
        a3: "0x0",
        a4: "0x0",
        a5: "0x0",
        a6: "0x0",
        a7: "0x0",
        sr: "0x0",
        usp: "0x0",
        isp: "0x0",
        msp: "0x0",
        vbr: "0x0",
        irc: "0x0",
        sfc: "0x0",
        dfc: "0x0",
        cacr: "0x0",
        caar: "0x0",
      };
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);

      const variables = await variablesManager.dataRegVariables("data_reg_d0");

      assert.strictEqual(variables.length, 6);

      const i32Var = variables.find((v) => v.name === "i32");
      const u32Var = variables.find((v) => v.name === "u32");
      const i16Var = variables.find((v) => v.name === "i16");
      const u16Var = variables.find((v) => v.name === "u16");
      const i8Var = variables.find((v) => v.name === "i8");
      const u8Var = variables.find((v) => v.name === "u8");

      assert.ok(i32Var && u32Var && i16Var && u16Var && i8Var && u8Var);

      // Check signed vs unsigned interpretation
      assert.strictEqual(i32Var.value, (-2147483582).toString()); // Negative 32-bit
      assert.strictEqual(u32Var.value, "2147483714"); // Positive 32-bit
      assert.strictEqual(i16Var.value, "66"); // Positive 16-bit (0x0042)
      assert.strictEqual(u16Var.value, "66"); // Same for unsigned
      assert.strictEqual(i8Var.value, "66"); // Positive 8-bit (0x42)
      assert.strictEqual(u8Var.value, "66"); // Same for unsigned
    });
  });

  describe("Status Register Flag Variables", () => {
    it("should extract all CPU flags from status register", async () => {
      const mockCpuInfo: CpuInfo = {
        sr: "0xF71F", // All flags set + interrupt mask 7
        pc: "0x0",
        d0: "0x0",
        d1: "0x0",
        d2: "0x0",
        d3: "0x0",
        d4: "0x0",
        d5: "0x0",
        d6: "0x0",
        d7: "0x0",
        a0: "0x0",
        a1: "0x0",
        a2: "0x0",
        a3: "0x0",
        a4: "0x0",
        a5: "0x0",
        a6: "0x0",
        a7: "0x0",
        usp: "0x0",
        isp: "0x0",
        msp: "0x0",
        vbr: "0x0",
        irc: "0x0",
        sfc: "0x0",
        dfc: "0x0",
        cacr: "0x0",
        caar: "0x0",
      };
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);

      const variables = await variablesManager.srFlagVariables();

      assert.strictEqual(variables.length, 10); // 9 boolean flags + interrupt mask

      const carryFlag = variables.find((v) => v.name === "carry");
      const overflowFlag = variables.find((v) => v.name === "overflow");
      const zeroFlag = variables.find((v) => v.name === "zero");
      const negativeFlag = variables.find((v) => v.name === "negative");
      const extendFlag = variables.find((v) => v.name === "extend");
      const trace1Flag = variables.find((v) => v.name === "trace1");
      const supervisorFlag = variables.find((v) => v.name === "supervisor");
      const interruptMask = variables.find((v) => v.name === "interruptMask");

      assert.ok(carryFlag && overflowFlag && zeroFlag && negativeFlag);
      assert.ok(extendFlag && trace1Flag && supervisorFlag && interruptMask);

      assert.strictEqual(carryFlag.value, "true");
      assert.strictEqual(overflowFlag.value, "true");
      assert.strictEqual(zeroFlag.value, "true");
      assert.strictEqual(negativeFlag.value, "true");
      assert.strictEqual(extendFlag.value, "true");
      assert.strictEqual(trace1Flag.value, "true");
      assert.strictEqual(supervisorFlag.value, "true");
      assert.strictEqual(interruptMask.value, "0b00000111");

      // All flags should be read-only
      variables.forEach((v) => {
        assert.deepStrictEqual(v.presentationHint, {
          attributes: ["readOnly"],
        });
      });
    });

    it("should handle status register with no flags set", async () => {
      const mockCpuInfo: CpuInfo = {
        sr: "0x0000",
        pc: "0x0",
        d0: "0x0",
        d1: "0x0",
        d2: "0x0",
        d3: "0x0",
        d4: "0x0",
        d5: "0x0",
        d6: "0x0",
        d7: "0x0",
        a0: "0x0",
        a1: "0x0",
        a2: "0x0",
        a3: "0x0",
        a4: "0x0",
        a5: "0x0",
        a6: "0x0",
        a7: "0x0",
        usp: "0x0",
        isp: "0x0",
        msp: "0x0",
        vbr: "0x0",
        irc: "0x0",
        sfc: "0x0",
        dfc: "0x0",
        cacr: "0x0",
        caar: "0x0",
      };
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);

      const variables = await variablesManager.srFlagVariables();

      const booleanFlags = variables.filter((v) => v.name !== "interruptMask");
      booleanFlags.forEach((flag) => {
        assert.strictEqual(flag.value, "false");
      });

      const interruptMask = variables.find((v) => v.name === "interruptMask");
      assert.strictEqual(interruptMask?.value, "0b00000000");
    });
  });

  describe("Address Register Detail Variables", () => {
    it("should return cast variations and symbol offset for address register", async () => {
      const mockCpuInfo: CpuInfo = {
        a0: "0x00002010",
        pc: "0x0",
        d0: "0x0",
        d1: "0x0",
        d2: "0x0",
        d3: "0x0",
        d4: "0x0",
        d5: "0x0",
        d6: "0x0",
        d7: "0x0",
        a1: "0x0",
        a2: "0x0",
        a3: "0x0",
        a4: "0x0",
        a5: "0x0",
        a6: "0x0",
        a7: "0x0",
        sr: "0x0",
        usp: "0x0",
        isp: "0x0",
        msp: "0x0",
        vbr: "0x0",
        irc: "0x0",
        sfc: "0x0",
        dfc: "0x0",
        cacr: "0x0",
        caar: "0x0",
      };
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);
      mockSourceMap.findSymbolOffset
        .withArgs(0x2010)
        .returns({ symbol: "buffer", offset: 16 });

      const variables =
        await variablesManager.addressRegVariables("addr_reg_a0");

      assert.strictEqual(variables.length, 5); // offset + 4 cast variations

      const offsetVar = variables.find((v) => v.name === "offset");
      const i32Var = variables.find((v) => v.name === "i32");
      const u32Var = variables.find((v) => v.name === "u32");

      assert.ok(offsetVar && i32Var && u32Var);
      assert.strictEqual(offsetVar.value, "buffer+16");
      assert.strictEqual(i32Var.value, "8208");
      assert.strictEqual(u32Var.value, "8208");
    });

    it("should return only cast variations when no symbol found", async () => {
      const mockCpuInfo: CpuInfo = {
        a0: "0x00002010",
        pc: "0x0",
        d0: "0x0",
        d1: "0x0",
        d2: "0x0",
        d3: "0x0",
        d4: "0x0",
        d5: "0x0",
        d6: "0x0",
        d7: "0x0",
        a1: "0x0",
        a2: "0x0",
        a3: "0x0",
        a4: "0x0",
        a5: "0x0",
        a6: "0x0",
        a7: "0x0",
        sr: "0x0",
        usp: "0x0",
        isp: "0x0",
        msp: "0x0",
        vbr: "0x0",
        irc: "0x0",
        sfc: "0x0",
        dfc: "0x0",
        cacr: "0x0",
        caar: "0x0",
      };
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);
      mockSourceMap.findSymbolOffset.withArgs(0x2010).returns(undefined);

      const variables =
        await variablesManager.addressRegVariables("addr_reg_a0");

      assert.strictEqual(variables.length, 4); // Only cast variations
      const offsetVar = variables.find((v) => v.name === "offset");
      assert.strictEqual(offsetVar, undefined);
    });
  });

  describe("Custom Register Variables", () => {
    it("should return all custom registers with bit breakdown support", async () => {
      const mockCustomRegs = {
        DMACON: { value: "0x8200" },
        INTENA: { value: "0x4000" },
        UNKNOWN: { value: "0x1234" },
      };
      mockVAmiga.getAllCustomRegisters.resolves(mockCustomRegs);

      const variables = await variablesManager.customVariables();

      assert.strictEqual(variables.length, 3);

      // Should be sorted by name
      assert.strictEqual(variables[0].name, "DMACON");
      assert.strictEqual(variables[1].name, "INTENA");
      assert.strictEqual(variables[2].name, "UNKNOWN");

      // DMACON and INTENA should have expandable bit breakdown
      const dmaconVar = variables.find((v) => v.name === "DMACON");
      const intenaVar = variables.find((v) => v.name === "INTENA");
      const unknownVar = variables.find((v) => v.name === "UNKNOWN");

      assert.ok(dmaconVar && intenaVar && unknownVar);
      assert.ok(dmaconVar.variablesReference > 0);
      assert.ok(intenaVar.variablesReference > 0);
      assert.strictEqual(unknownVar.variablesReference, 0);
    });

    it("should handle longword values as memory addresses", async () => {
      const mockCustomRegs = {
        BPL1PTH: { value: "0x00020000" }, // Longword value
        DMACON: { value: "0x8200" }, // Word value
      };
      mockVAmiga.getAllCustomRegisters.resolves(mockCustomRegs);
      mockSourceMap.findSymbolOffset
        .withArgs(0x20000)
        .returns({ symbol: "chipram", offset: 0 });

      const variables = await variablesManager.customVariables();

      const bplVar = variables.find((v) => v.name === "BPL1PTH");
      const dmaVar = variables.find((v) => v.name === "DMACON");

      assert.ok(bplVar && dmaVar);
      assert.strictEqual(bplVar.memoryReference, "0x00020000");
      assert.strictEqual(bplVar.value, "0x00020000 = chipram");
      assert.strictEqual(dmaVar.memoryReference, undefined);
    });
  });

  describe("Custom Register Detail Variables", () => {
    it("should return bit breakdown for supported registers", async () => {
      const mockCustomRegs = {
        DMACON: { value: "0x8200" },
      };
      mockVAmiga.getAllCustomRegisters.resolves(mockCustomRegs);

      const variables =
        await variablesManager.customDetailVariables("custom_reg_DMACON");

      assert.ok(variables.length > 0);

      // Should have bit-prefixed field names
      const enableAllBit = variables.find((v) => v.name === "09: ENABLE_ALL");
      const bitplanesBit = variables.find((v) => v.name === "08: BITPLANES");

      assert.ok(enableAllBit && bitplanesBit);
      assert.strictEqual(enableAllBit.value, "true");
      assert.strictEqual(bitplanesBit.value, "false"); // 0x8200 doesn't have bit 8 set

      // All should be read-only
      variables.forEach((v) => {
        assert.deepStrictEqual(v.presentationHint, {
          attributes: ["readOnly"],
        });
      });
    });
  });

  describe("Vector Variables", () => {
    it("should return interrupt vectors with addresses", async () => {
      const mockCpuInfo: CpuInfo = {
        vbr: "0x00000000",
        pc: "0x0",
        d0: "0x0",
        d1: "0x0",
        d2: "0x0",
        d3: "0x0",
        d4: "0x0",
        d5: "0x0",
        d6: "0x0",
        d7: "0x0",
        a0: "0x0",
        a1: "0x0",
        a2: "0x0",
        a3: "0x0",
        a4: "0x0",
        a5: "0x0",
        a6: "0x0",
        a7: "0x0",
        sr: "0x0",
        usp: "0x0",
        isp: "0x0",
        msp: "0x0",
        irc: "0x0",
        sfc: "0x0",
        dfc: "0x0",
        cacr: "0x0",
        caar: "0x0",
      };

      // Mock vector table data - first few vectors
      const vectorData = Buffer.alloc(1024); // 256 vectors * 4 bytes
      vectorData.writeInt32BE(0x00001000, 0); // Reset SSP at vector 0
      vectorData.writeInt32BE(0x00001004, 4); // Reset PC at vector 1
      vectorData.writeInt32BE(0x00002000, 8); // Bus Error at vector 2
      vectorData.writeInt32BE(0x00003000, 12); // Address Error at vector 3

      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);
      mockVAmiga.readMemory.resolves(vectorData);
      mockSourceMap.findSymbolOffset
        .withArgs(0x1004)
        .returns({ symbol: "start", offset: 0 });

      const variables = await variablesManager.vectorVariables();

      // Should have variables for named vectors only
      assert.ok(variables.length > 0);

      const resetSSP = variables.find((v) => v.name.includes("RESET_SSP"));
      const resetPC = variables.find((v) => v.name.includes("RESET_PC"));

      assert.ok(resetSSP && resetPC);
      assert.strictEqual(resetSSP.value, "0x00001000");
      assert.strictEqual(resetPC.value, "0x00001004 = start");
      assert.strictEqual(resetSSP.memoryReference, "0x00001000");
      assert.strictEqual(resetPC.memoryReference, "0x00001004");
    });
  });

  describe("Symbol Variables", () => {
    it("should return symbols with pointer dereferencing for known sizes", async () => {
      const mockSymbols = {
        main: 0x1000,
        data_byte: 0x2000,
        data_word: 0x3000,
        data_long: 0x4000,
        unknown: 0x5000,
      };
      const mockSymbolLengths = {
        data_byte: 1,
        data_word: 2,
        data_long: 4,
        unknown: 10,
      };

      mockSourceMap.getSymbols.returns(mockSymbols);
      mockSourceMap.getSymbolLengths.returns(mockSymbolLengths);
      mockSourceMap.lookupAddress.withArgs(0x1000).returns({
        path: "main.c",
        line: 10,
        address: 0x1000,
        segmentIndex: 0,
        segmentOffset: 0,
      });

      mockVAmiga.peek8.withArgs(0x2000).resolves(0x42);
      mockVAmiga.peek16.withArgs(0x3000).resolves(0x1234);
      mockVAmiga.peek32.withArgs(0x4000).resolves(0x12345678);

      mockSourceMap.findSymbolOffset
        .withArgs(0x12345678)
        .returns({ symbol: "func", offset: 0 });

      const variables = await variablesManager.symbolVariables();

      assert.strictEqual(variables.length, Object.keys(mockSymbols).length);

      const mainVar = variables.find((v) => v.name === "main");
      const byteVar = variables.find((v) => v.name === "data_byte");
      const wordVar = variables.find((v) => v.name === "data_word");
      const longVar = variables.find((v) => v.name === "data_long");
      const unknownVar = variables.find((v) => v.name === "unknown");

      assert.ok(mainVar && byteVar && wordVar && longVar && unknownVar);

      // main should have location reference
      assert.ok(mainVar.declarationLocationReference);

      // Variables with known sizes should show dereferenced values
      assert.strictEqual(byteVar.value, "0x00002000 -> 0x42");
      assert.strictEqual(wordVar.value, "0x00003000 -> 0x1234");
      assert.strictEqual(longVar.value, "0x00004000 -> 0x12345678 = func");

      // Should have expandable references for pointer values
      assert.ok(byteVar.variablesReference > 0);
      assert.ok(wordVar.variablesReference > 0);
      assert.ok(longVar.variablesReference > 0);

      // Unknown size should not have expandable reference
      assert.strictEqual(unknownVar.variablesReference, 0);
    });
  });

  describe("Symbol Pointer Detail Variables", () => {
    it("should return cast variations for different pointer sizes", async () => {
      // Test 32-bit pointer
      let variables = variablesManager.symbolPointerVariables(
        "symbol_ptr_data_long:4:0x80000042",
      );
      assert.strictEqual(variables.length, 2);

      const u32Var = variables.find((v) => v.name === "u32");
      const i32Var = variables.find((v) => v.name === "i32");
      assert.ok(u32Var && i32Var);
      assert.strictEqual(u32Var.value, "2147483714");
      assert.strictEqual(i32Var.value, "-2147483582");

      // Test 16-bit pointer
      variables = variablesManager.symbolPointerVariables(
        "symbol_ptr_data_word:2:0x8042",
      );
      assert.strictEqual(variables.length, 2);

      const u16Var = variables.find((v) => v.name === "u16");
      const i16Var = variables.find((v) => v.name === "i16");
      assert.ok(u16Var && i16Var);
      assert.strictEqual(u16Var.value, "32834");
      assert.strictEqual(i16Var.value, "-32702");

      // Test 8-bit pointer
      variables = variablesManager.symbolPointerVariables(
        "symbol_ptr_data_byte:1:0x82",
      );
      assert.strictEqual(variables.length, 2);

      const u8Var = variables.find((v) => v.name === "u8");
      const i8Var = variables.find((v) => v.name === "i8");
      assert.ok(u8Var && i8Var);
      assert.strictEqual(u8Var.value, "130");
      assert.strictEqual(i8Var.value, "-126");
    });
  });

  describe("Segment Variables", () => {
    it("should return segment information", () => {
      const mockSegments = [
        {
          name: "CODE",
          address: 0x1000,
          size: 0x800,
          memType: MemoryType.CHIP,
        },
        {
          name: "DATA",
          address: 0x8000,
          size: 0x400,
          memType: MemoryType.FAST,
        },
        { name: "BSS", address: 0x8400, size: 0x200, memType: MemoryType.ANY },
      ];
      mockSourceMap.getSegmentsInfo.returns(mockSegments);

      const variables = variablesManager.segmentVariables();

      assert.strictEqual(variables.length, 3);

      const codeVar = variables.find((v) => v.name === "CODE");
      const dataVar = variables.find((v) => v.name === "DATA");
      const bssVar = variables.find((v) => v.name === "BSS");

      assert.ok(codeVar && dataVar && bssVar);
      assert.strictEqual(codeVar.value, "0x00001000");
      assert.strictEqual(dataVar.value, "0x00008000");
      assert.strictEqual(bssVar.value, "0x00008400");

      // All should have memory references and be read-only
      variables.forEach((v) => {
        assert.strictEqual(v.memoryReference, v.value);
        assert.deepStrictEqual(v.presentationHint, {
          attributes: ["readOnly"],
        });
      });
    });
  });

  describe("Variable Setting", () => {
    it("should set CPU register values", async () => {
      // Setup: Get a valid registers reference from scopes
      const scopes = variablesManager.getScopes();
      const registersScope = scopes.find((s) => s.name === "CPU Registers");
      assert.ok(registersScope);

      mockVAmiga.setRegister
        .withArgs("d0", 0x1234)
        .resolves({ value: "0x1234" });

      const result = await variablesManager.setVariable(
        registersScope.variablesReference,
        "d0",
        0x1234,
      );

      assert.strictEqual(result, "0x1234");
      assert.ok(mockVAmiga.setRegister.calledWith("d0", 0x1234));
    });

    it("should set custom register values", async () => {
      // Setup: Get a valid custom reference from scopes
      const scopes = variablesManager.getScopes();
      const customScope = scopes.find((s) => s.name === "Custom Registers");
      assert.ok(customScope);

      mockVAmiga.pokeCustom16.withArgs(0xdff09a, 0x8200).resolves();

      const result = await variablesManager.setVariable(
        customScope.variablesReference,
        "INTENA",
        0x8200,
      );

      assert.strictEqual(result, "0x8200");
      assert.ok(mockVAmiga.pokeCustom16.calledWith(0xdff09a, 0x8200));
    });

    it("should throw error for non-writable variables", async () => {
      try {
        await variablesManager.setVariable(125, "readonly", 0x1234);
        assert.fail("Should have thrown error");
      } catch (error: unknown) {
        assert.strictEqual(
          (error as Error).message,
          "Variable access error: Variable is not writeable",
        );
      }
    });
  });

  describe("Variable Reference Management", () => {
    it("should get unknown variable reference", async () => {
      try {
        await variablesManager.getVariables(999);
        assert.fail("Should have thrown error");
      } catch (error: unknown) {
        // Should throw an error for invalid handle
        assert.ok(error instanceof Error);
        // Just verify that an error was thrown, don't check specific message
      }
    });

    it("should manage variable and location handles", () => {
      const scopes = variablesManager.getScopes();
      const registerRef = scopes[0].variablesReference;

      const refId = variablesManager.getVariableReference(registerRef);
      assert.strictEqual(refId, "registers");
    });
  });

  describe("Edge Cases and Error Handling", () => {
    it("should handle empty custom registers", async () => {
      mockVAmiga.getAllCustomRegisters.resolves({});

      const variables = await variablesManager.customVariables();
      assert.strictEqual(variables.length, 0);
    });

    it("should handle memory read errors gracefully", async () => {
      const mockCpuInfo: CpuInfo = {
        vbr: "0x00000000",
        pc: "0x0",
        d0: "0x0",
        d1: "0x0",
        d2: "0x0",
        d3: "0x0",
        d4: "0x0",
        d5: "0x0",
        d6: "0x0",
        d7: "0x0",
        a0: "0x0",
        a1: "0x0",
        a2: "0x0",
        a3: "0x0",
        a4: "0x0",
        a5: "0x0",
        a6: "0x0",
        a7: "0x0",
        sr: "0x0",
        usp: "0x0",
        isp: "0x0",
        msp: "0x0",
        irc: "0x0",
        sfc: "0x0",
        dfc: "0x0",
        cacr: "0x0",
        caar: "0x0",
      };
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);
      mockVAmiga.readMemory.rejects(new Error("Memory read failed"));

      try {
        await variablesManager.vectorVariables();
        assert.fail("Should have thrown error");
      } catch (error: unknown) {
        assert.strictEqual((error as Error).message, "Memory read failed");
      }
    });

    it("should handle empty symbol table", async () => {
      mockSourceMap.getSymbols.returns({});
      mockSourceMap.getSymbolLengths.returns({});

      const variables = await variablesManager.symbolVariables();
      assert.strictEqual(variables.length, 0);
    });
  });
});
