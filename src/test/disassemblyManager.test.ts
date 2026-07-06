import * as assert from "assert";
import * as sinon from "sinon";
import { DisassemblyManager } from "../disassemblyManager";
import { Source } from "@vscode/debugadapter";

// Build a Buffer of NOP instructions (0x4E71, 2 bytes each).
function nopBuf(count: number): Buffer {
  const buf = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) buf.writeUInt16BE(0x4e71, i * 2);
  return buf;
}

// Pad a buffer with NOPs to reach totalBytes length.
function padNops(head: Buffer, totalBytes: number): Buffer {
  const tail = nopBuf(Math.ceil(Math.max(totalBytes - head.length, 0) / 2));
  return Buffer.concat([head, tail]).subarray(0, totalBytes);
}

describe("DisassemblyManager", () => {
  let readMemory: sinon.SinonStub;
  let lookupAddress: sinon.SinonStub;
  let mgr: DisassemblyManager;

  beforeEach(() => {
    readMemory = sinon.stub();
    lookupAddress = sinon.stub().returns(null);
    mgr = new DisassemblyManager(
      { readMemory } as any,
      { lookupAddress } as any,
    );
  });

  afterEach(() => sinon.restore());

  // The mock always returns count/2 NOPs starting at startAddress.
  // DisassemblyManager computes startAddress from baseAddress + offset math,
  // so decoded[k].addr = startAddress + k*2 for 2-byte NOPs.
  function setupNopMemory() {
    readMemory.callsFake((_addr: number, count: number) =>
      Promise.resolve(nopBuf(Math.ceil(count / 2))),
    );
  }

  describe("Basic disassembly", () => {
    it("decodes instructions at base address", async () => {
      setupNopMemory();
      const result = await mgr.disassemble(0x1000, 0, 3);
      assert.strictEqual(result.length, 3);
      assert.strictEqual(result[0].address, "0x1000");
      assert.strictEqual(result[1].address, "0x1002");
      assert.strictEqual(result[2].address, "0x1004");
      assert.strictEqual(result[0].presentationHint, undefined); // NOPs are valid
    });

    it("throws when base address not found in decoded output", async () => {
      // Return empty buffer — no instructions decoded at all.
      readMemory.resolves(Buffer.alloc(0));
      await assert.rejects(
        () => mgr.disassemble(0x1000, 0, 1),
        /Disassembly failed: Start instruction not found/,
      );
    });
  });

  describe("Positive offset", () => {
    it("skips instructions before base address", async () => {
      // offset=2, count=2 → fetches base + 4 instructions, returns [base+4, base+6]
      setupNopMemory();
      const result = await mgr.disassemble(0x1000, 2, 2);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].address, "0x1004");
      assert.strictEqual(result[1].address, "0x1006");
    });
  });

  describe("Negative offset", () => {
    it("returns instructions before base address (no clamping needed)", async () => {
      // baseAddress=0x1010, offset=-2, count=2
      // startAddress = 0x1010 - 2*8 = 0x1000
      // With NOPs: decoded[0..] at 0x1000, 0x1002, ..., 0x1010 (index 8)
      // realStart = 8 + (-2) = 6 → result at 0x100C, 0x100E
      setupNopMemory();
      const result = await mgr.disassemble(0x1010, -2, 2);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].address, "0x100c");
      assert.strictEqual(result[1].address, "0x100e");
    });

    it("pads with invalid instructions when offset exceeds available memory", async () => {
      // baseAddress=0x4, offset=-3, count=3
      // startAddress = max(0x4 - 24, 0) = 0
      // With NOPs: decoded[0..] at 0, 2, 4 (base, index 2), 6, ...
      // realStart = 2 + (-3) = -1 → 1 padding + decoded[0..2]
      setupNopMemory();
      const result = await mgr.disassemble(0x4, -3, 3);
      assert.strictEqual(result.length, 4); // 1 padding + 3 from decoded
      assert.strictEqual(result[0].instruction, "invalid");
      assert.strictEqual(result[0].presentationHint, "invalid");
      assert.strictEqual(result[1].address, "0x0");
      assert.strictEqual(result[2].address, "0x2");
      assert.strictEqual(result[3].address, "0x4");
    });
  });

  describe("Unknown opcodes", () => {
    it("falls back to dc.w and marks as invalid for unknown opcodes", async () => {
      // 0xFFFF is not a valid M68k opcode — m68kdecode should throw.
      // With offset=0, startAddress = baseAddress = 0x1000.
      const buf = padNops(Buffer.from([0xff, 0xff]), 80);
      readMemory.resolves(buf);
      const result = await mgr.disassemble(0x1000, 0, 1);
      assert.strictEqual(result.length, 1);
      assert.ok(result[0].instruction.startsWith("dc."), `expected dc.w, got "${result[0].instruction}"`);
      assert.strictEqual(result[0].presentationHint, "invalid");
    });
  });

  describe("Source map integration", () => {
    it("attaches symbol and location when source map resolves the address", async () => {
      setupNopMemory();
      lookupAddress.withArgs(0x1000).returns({ path: "/project/src/main.c", line: 42 });
      lookupAddress.returns(null);

      const result = await mgr.disassemble(0x1000, 0, 2);
      assert.strictEqual(result[0].symbol, "main.c:42");
      assert.ok(result[0].location instanceof Source);
      assert.strictEqual(result[0].location!.name, "main.c");
      assert.strictEqual(result[0].line, 42);
      // Second instruction has no source info.
      assert.strictEqual(result[1].symbol, undefined);
      assert.strictEqual(result[1].line, undefined);
    });

    it("works without a source map", async () => {
      setupNopMemory();
      const noSrcMgr = new DisassemblyManager({ readMemory } as any, null as any);
      const result = await noSrcMgr.disassemble(0x1000, 0, 1);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].symbol, undefined);
    });
  });
});
