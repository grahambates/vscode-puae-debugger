import { createSourceLookup } from "../webview/profilerViewer/sourceLookup";
import { IDisassembledFunction, ISymbol } from "../shared/profilerTypes";

const disassembly: IDisassembledFunction[] = [
  {
    address: 0x1000,
    name: "fnA",
    instructions: [
      { address: 0x1000, hex: "4e71", text: "nop", length: 2, hits: 1, cycles: 4, file: "a.asm", line: 9 },
      { address: 0x1002, hex: "4e75", text: "rts", length: 2, hits: 1, cycles: 16, file: "a.asm", line: 10 },
    ],
  },
  {
    address: 0x2000,
    name: "fnB",
    instructions: [
      { address: 0x2000, hex: "4e71", text: "nop", length: 2, hits: 1, cycles: 4 }, // no file/line
    ],
  },
];

const symbols: ISymbol[] = [
  { address: 0x1000, name: "fnA", size: 4, file: "a.asm", line: 8 }, // a code symbol (also covered by disassembly)
  { address: 0x4000, name: "Screen", size: 0x100, file: "b.asm", line: 42 }, // a data symbol
  { address: 0x5000, name: "NoLoc", size: 0x10 }, // no file/line (symbol declared with no debug info)
];

describe("createSourceLookup", () => {
  it("returns undefined when there's no disassembly or symbols", () => {
    expect(createSourceLookup(undefined, undefined)(0x1000)).toBeUndefined();
    expect(createSourceLookup([], [])(0x1000)).toBeUndefined();
  });

  it("resolves an exact instruction address", () => {
    expect(createSourceLookup(disassembly, undefined)(0x1002)).toEqual({ file: "a.asm", line: 10 });
  });

  it("resolves an address mid-instruction (floor search within instruction length)", () => {
    expect(createSourceLookup(disassembly, undefined)(0x1001)).toEqual({ file: "a.asm", line: 9 });
  });

  it("returns undefined past the last instruction's length", () => {
    expect(createSourceLookup(disassembly, undefined)(0x1004)).toBeUndefined();
  });

  it("returns undefined for an address before any known instruction or symbol", () => {
    expect(createSourceLookup(disassembly, symbols)(0x500)).toBeUndefined();
  });

  it("skips instructions with no file/line (e.g. fnB)", () => {
    expect(createSourceLookup(disassembly, undefined)(0x2000)).toBeUndefined();
  });

  it("falls back to a data symbol's declaration site when there's no disassembly entry", () => {
    expect(createSourceLookup(disassembly, symbols)(0x4000)).toEqual({ file: "b.asm", line: 42 });
  });

  it("resolves an offset within a data symbol's size (e.g. Screen+$f)", () => {
    expect(createSourceLookup(disassembly, symbols)(0x400f)).toEqual({ file: "b.asm", line: 42 });
  });

  it("returns undefined past a data symbol's size", () => {
    expect(createSourceLookup(disassembly, symbols)(0x4100)).toBeUndefined();
  });

  it("prefers the instruction-level hit over the symbol-level one when both apply", () => {
    // fnA's address is covered by both disassembly (line 9) and the symbol table (line 8) —
    // the more precise instruction-level lookup should win.
    expect(createSourceLookup(disassembly, symbols)(0x1000)).toEqual({ file: "a.asm", line: 9 });
  });

  it("returns undefined for a symbol with no file/line", () => {
    expect(createSourceLookup(undefined, symbols)(0x5000)).toBeUndefined();
  });
});
