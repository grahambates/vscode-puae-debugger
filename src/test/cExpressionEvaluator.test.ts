import * as assert from "assert";
import * as sinon from "sinon";
import { CExpressionEvaluator, expressionRangeAt } from "../cExpressionEvaluator";
import { VAmiga, CpuInfo } from "../vAmiga";
import { VariablesManager } from "../variablesManager";
import { SourceMap, Variable } from "../sourceMap";

/**
 * Tests for the C/C++ compound expression evaluator: parser + typed-lvalue navigator.
 * Uses a real VariablesManager (so renderLValue / resolveNameToLValue behave realistically) over a
 * stubbed VAmiga + SourceMap, mirroring the variablesManager.test.ts mocking patterns.
 */
describe("CExpressionEvaluator", () => {
  let evaluator: CExpressionEvaluator;
  let mockVAmiga: sinon.SinonStubbedInstance<VAmiga>;
  let mockSourceMap: sinon.SinonStubbedInstance<SourceMap>;
  let variablesManager: VariablesManager;

  const cpu: CpuInfo = {
    pc: "0x1000", d0: "0", d1: "0", d2: "0", d3: "0", d4: "0", d5: "0", d6: "0", d7: "0",
    a0: "0", a1: "0", a2: "0", a3: "0", a4: "0", a5: "0", a6: "0", a7: "0x8000",
    sr: "0", usp: "0", msp: "0", isp: "0", vbr: "0", irc: "0", sfc: "0", dfc: "0", cacr: "0", caar: "0",
  };

  // A struct { int _int @0; short _short @4; char _char @6; } at byteSize 7.
  const structType = (): Variable["typeDescriptor"] => ({
    kind: "struct", typeName: "struct S", byteSize: 7,
    getFields: () => [
      { name: "_int", offset: 0, type: { kind: "primitive", typeName: "int", byteSize: 4 } },
      { name: "_short", offset: 4, type: { kind: "primitive", typeName: "short", byteSize: 2 } },
      { name: "_char", offset: 6, type: { kind: "primitive", typeName: "char", byteSize: 1 } },
    ],
  });

  function setLocals(...vars: Variable[]) {
    mockSourceMap.getLocalsForPc.returns(vars);
  }

  beforeEach(() => {
    mockVAmiga = sinon.createStubInstance(VAmiga);
    mockSourceMap = sinon.createStubInstance(SourceMap);
    mockSourceMap.getLocalsForPc.returns([]);
    mockSourceMap.getGlobalVariables.returns([]);
    mockSourceMap.findSymbolOffset.returns(undefined);
    variablesManager = new VariablesManager(mockVAmiga, mockSourceMap);
    evaluator = new CExpressionEvaluator(mockVAmiga, mockSourceMap, variablesManager);
    mockVAmiga.getCpuInfo.resolves(cpu);
    mockVAmiga.isValidAddress.returns(true);
  });

  afterEach(() => sinon.restore());

  describe("parsing / fallback (returns undefined for non-C input)", () => {
    const cases = ["", "   ", "42", "0x10", "d0 + d1", "a + b", ".foo", "a.", "a->", "arr[", "()", "*"];
    for (const expr of cases) {
      it(`returns undefined for ${JSON.stringify(expr)}`, async () => {
        assert.strictEqual(await evaluator.evaluateToBody(expr, 0x1000, null), undefined);
      });
    }

    it("returns undefined for an unknown identifier", async () => {
      assert.strictEqual(await evaluator.evaluateToBody("nope", 0x1000, null), undefined);
    });
  });

  describe("expressionRangeAt (hover range, truncates at the hovered token)", () => {
    // Hover at the position of `token` within `line` (uses its first occurrence + an offset into it).
    const at = (line: string, token: string, offsetInToken = 0) =>
      expressionRangeAt(line, line.indexOf(token) + offsetInToken);

    it("hovering the base of a chain yields only the base", () => {
      const line = "SysBase->ColdCapture";
      assert.strictEqual(at(line, "SysBase")?.text, "SysBase");
    });

    it("hovering a later member yields the chain up to that member", () => {
      const line = "SysBase->ColdCapture";
      assert.strictEqual(at(line, "ColdCapture")?.text, "SysBase->ColdCapture");
    });

    it("truncates a longer chain at each hovered component", () => {
      const line = "enemies[i].pos.x";
      assert.strictEqual(at(line, "enemies")?.text, "enemies");
      assert.strictEqual(at(line, "pos")?.text, "enemies[i].pos");
      assert.strictEqual(at(line, ".x", 1)?.text, "enemies[i].pos.x");
    });

    it("hovering an array index token evaluates just that token", () => {
      const line = "enemies[idx].pos";
      assert.strictEqual(at(line, "idx")?.text, "idx");
    });

    it("works for `.` chains too", () => {
      assert.strictEqual(at("a.b.c", "b")?.text, "a.b");
    });

    it("extracts the chain from within a larger line", () => {
      const line = "    result = player->health;";
      assert.strictEqual(at(line, "player")?.text, "player");
      assert.strictEqual(at(line, "health")?.text, "player->health");
    });

    it("returns undefined when the cursor is not on an identifier", () => {
      const line = "SysBase->ColdCapture";
      // The '>' of '->' is between the two identifiers, on neither.
      assert.strictEqual(expressionRangeAt(line, line.indexOf("->") + 1), undefined);
    });
  });

  describe("member access '.'", () => {
    it("resolves a struct field by offset", async () => {
      setLocals({ name: "s", typeName: "struct S", byteSize: 7, location: { kind: "addr", address: 0x3000 }, typeDescriptor: structType() });
      mockVAmiga.peek16.withArgs(0x3004).resolves(0x1234);

      const res = await evaluator.evaluateToBody("s._short", 0x1000, null);
      assert.ok(res);
      assert.strictEqual(res!.memoryReference, "0x00003004");
      assert.strictEqual(res!.type, "short");
      assert.ok(res!.result.includes("1234"));
    });

    it("returns undefined for '.' on a non-struct", async () => {
      setLocals({ name: "n", typeName: "int", byteSize: 4, location: { kind: "addr", address: 0x3000 }, typeDescriptor: { kind: "primitive", typeName: "int", byteSize: 4 } });
      assert.strictEqual(await evaluator.evaluateToBody("n.x", 0x1000, null), undefined);
    });

    it("returns undefined for an unknown field", async () => {
      setLocals({ name: "s", typeName: "struct S", byteSize: 7, location: { kind: "addr", address: 0x3000 }, typeDescriptor: structType() });
      assert.strictEqual(await evaluator.evaluateToBody("s.nope", 0x1000, null), undefined);
    });
  });

  describe("arrow '->'", () => {
    it("dereferences a pointer-to-struct and resolves a field", async () => {
      setLocals({ name: "p", typeName: "struct S *", byteSize: 4, location: { kind: "addr", address: 0x3000 },
        typeDescriptor: { kind: "pointer", typeName: "struct S *", byteSize: 4, pointee: structType() } });
      mockVAmiga.peek32.withArgs(0x3000).resolves(0x5000); // struct base
      mockVAmiga.peek32.withArgs(0x5000).resolves(0xabcd); // _int @ +0

      const res = await evaluator.evaluateToBody("p->_int", 0x1000, null);
      assert.ok(res);
      assert.strictEqual(res!.memoryReference, "0x00005000");
      assert.strictEqual(res!.type, "int");
      assert.ok(res!.result.includes("abcd"));
    });

    it("returns undefined for '->' on a non-pointer", async () => {
      setLocals({ name: "s", typeName: "struct S", byteSize: 7, location: { kind: "addr", address: 0x3000 }, typeDescriptor: structType() });
      assert.strictEqual(await evaluator.evaluateToBody("s->_int", 0x1000, null), undefined);
    });
  });

  describe("array index '[]'", () => {
    it("indexes an array with a literal", async () => {
      setLocals({ name: "arr", typeName: "int[10]", byteSize: 40, location: { kind: "addr", address: 0x4000 },
        typeDescriptor: { kind: "array", typeName: "int[10]", byteSize: 40, elementCount: 10, elementType: { kind: "primitive", typeName: "int", byteSize: 4 } } });
      mockVAmiga.peek32.withArgs(0x4008).resolves(0x99); // arr[2]

      const res = await evaluator.evaluateToBody("arr[2]", 0x1000, null);
      assert.ok(res);
      assert.strictEqual(res!.memoryReference, "0x00004008");
      assert.ok(res!.result.includes("99"));
    });

    it("indexes an array with a variable index", async () => {
      setLocals(
        { name: "arr", typeName: "int[10]", byteSize: 40, location: { kind: "addr", address: 0x4000 },
          typeDescriptor: { kind: "array", typeName: "int[10]", byteSize: 40, elementCount: 10, elementType: { kind: "primitive", typeName: "int", byteSize: 4 } } },
        { name: "i", typeName: "int", byteSize: 4, location: { kind: "addr", address: 0x9000 }, typeDescriptor: { kind: "primitive", typeName: "int", byteSize: 4 } },
      );
      mockVAmiga.peek32.withArgs(0x9000).resolves(3); // i == 3
      mockVAmiga.peek32.withArgs(0x400c).resolves(0x77); // arr[3]

      const res = await evaluator.evaluateToBody("arr[i]", 0x1000, null);
      assert.ok(res);
      assert.strictEqual(res!.memoryReference, "0x0000400c");
      assert.ok(res!.result.includes("77"));
    });

    it("indexes through a pointer (base + i*size)", async () => {
      setLocals({ name: "p", typeName: "int *", byteSize: 4, location: { kind: "addr", address: 0x3000 },
        typeDescriptor: { kind: "pointer", typeName: "int *", byteSize: 4, pointee: { kind: "primitive", typeName: "int", byteSize: 4 } } });
      mockVAmiga.peek32.withArgs(0x3000).resolves(0x6000); // pointer value
      mockVAmiga.peek32.withArgs(0x600c).resolves(0x55); // p[3]

      const res = await evaluator.evaluateToBody("p[3]", 0x1000, null);
      assert.ok(res);
      assert.strictEqual(res!.memoryReference, "0x0000600c");
      assert.ok(res!.result.includes("55"));
    });
  });

  describe("dereference '*'", () => {
    it("dereferences a pointer-to-primitive", async () => {
      setLocals({ name: "p", typeName: "int *", byteSize: 4, location: { kind: "addr", address: 0x3000 },
        typeDescriptor: { kind: "pointer", typeName: "int *", byteSize: 4, pointee: { kind: "primitive", typeName: "int", byteSize: 4 } } });
      mockVAmiga.peek32.withArgs(0x3000).resolves(0x7000); // pointer value
      mockVAmiga.peek32.withArgs(0x7000).resolves(0x42); // *p

      const res = await evaluator.evaluateToBody("*p", 0x1000, null);
      assert.ok(res);
      assert.strictEqual(res!.memoryReference, "0x00007000");
      assert.strictEqual(res!.type, "int");
      assert.ok(res!.result.includes("42"));
    });

    it("returns undefined for '*' on a non-pointer", async () => {
      setLocals({ name: "n", typeName: "int", byteSize: 4, location: { kind: "addr", address: 0x3000 }, typeDescriptor: { kind: "primitive", typeName: "int", byteSize: 4 } });
      assert.strictEqual(await evaluator.evaluateToBody("*n", 0x1000, null), undefined);
    });
  });

  describe("address-of '&'", () => {
    it("formats the address of an lvalue with a pointer type", async () => {
      setLocals({ name: "s", typeName: "struct S", byteSize: 7, location: { kind: "addr", address: 0x3000 }, typeDescriptor: structType() });

      const res = await evaluator.evaluateToBody("&s._short", 0x1000, null);
      assert.ok(res);
      assert.strictEqual(res!.memoryReference, "0x00003004");
      assert.strictEqual(res!.type, "short *");
      assert.ok(res!.result.includes("00003004"));
      assert.strictEqual(res!.variablesReference, 0);
    });
  });

  describe("chaining and parentheses", () => {
    it("evaluates (*p)._int the same as p->_int", async () => {
      setLocals({ name: "p", typeName: "struct S *", byteSize: 4, location: { kind: "addr", address: 0x3000 },
        typeDescriptor: { kind: "pointer", typeName: "struct S *", byteSize: 4, pointee: structType() } });
      mockVAmiga.peek32.withArgs(0x3000).resolves(0x5000);
      mockVAmiga.peek32.withArgs(0x5000).resolves(0xc0de); // _int @ +0

      const res = await evaluator.evaluateToBody("(*p)._int", 0x1000, null);
      assert.ok(res);
      assert.strictEqual(res!.memoryReference, "0x00005000");
      assert.ok(res!.result.includes("c0de"));
    });
  });

  describe("globals fallback (pc === null)", () => {
    it("resolves a global member when no frame pc is given", async () => {
      mockSourceMap.getGlobalVariables.returns([
        { name: "g", typeName: "struct S", byteSize: 7, location: { kind: "addr", address: 0x2000 }, typeDescriptor: structType() },
      ]);
      mockVAmiga.peek32.withArgs(0x2000).resolves(0x11);

      const res = await evaluator.evaluateToBody("g._int", null, null);
      assert.ok(res);
      assert.strictEqual(res!.memoryReference, "0x00002000");
      assert.ok(res!.result.includes("11"));
    });
  });

  describe("evaluateToLValue (write-target resolution)", () => {
    it("resolves a struct member to its address and type", async () => {
      setLocals({ name: "s", typeName: "struct S", byteSize: 7, location: { kind: "addr", address: 0x3000 }, typeDescriptor: structType() });

      const lv = await evaluator.evaluateToLValue("s._short", 0x1000, null);
      assert.ok(lv);
      assert.strictEqual(lv!.address, 0x3004);
      assert.strictEqual(lv!.type.typeName, "short");
    });

    it("resolves through a pointer (arrow)", async () => {
      setLocals({ name: "p", typeName: "struct S *", byteSize: 4, location: { kind: "addr", address: 0x3000 },
        typeDescriptor: { kind: "pointer", typeName: "struct S *", byteSize: 4, pointee: structType() } });
      mockVAmiga.peek32.withArgs(0x3000).resolves(0x5000);

      const lv = await evaluator.evaluateToLValue("p->_int", 0x1000, null);
      assert.ok(lv);
      assert.strictEqual(lv!.address, 0x5000);
      assert.strictEqual(lv!.type.typeName, "int");
    });

    it("resolves an array element", async () => {
      setLocals({ name: "arr", typeName: "int[10]", byteSize: 40, location: { kind: "addr", address: 0x4000 },
        typeDescriptor: { kind: "array", typeName: "int[10]", byteSize: 40, elementCount: 10, elementType: { kind: "primitive", typeName: "int", byteSize: 4 } } });

      const lv = await evaluator.evaluateToLValue("arr[2]", 0x1000, null);
      assert.ok(lv);
      assert.strictEqual(lv!.address, 0x4008);
      assert.strictEqual(lv!.type.typeName, "int");
    });

    it("returns undefined for address-of, literals, unknown names and type mismatches", async () => {
      setLocals(
        { name: "s", typeName: "struct S", byteSize: 7, location: { kind: "addr", address: 0x3000 }, typeDescriptor: structType() },
        { name: "n", typeName: "int", byteSize: 4, location: { kind: "addr", address: 0x6000 }, typeDescriptor: { kind: "primitive", typeName: "int", byteSize: 4 } },
      );
      assert.strictEqual(await evaluator.evaluateToLValue("&s", 0x1000, null), undefined);
      assert.strictEqual(await evaluator.evaluateToLValue("42", 0x1000, null), undefined);
      assert.strictEqual(await evaluator.evaluateToLValue("nope", 0x1000, null), undefined);
      assert.strictEqual(await evaluator.evaluateToLValue("*n", 0x1000, null), undefined);
    });
  });
});
