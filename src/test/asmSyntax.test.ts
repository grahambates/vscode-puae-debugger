import { splitInstruction, tokenizeOperands } from "../webview/shared/asmSyntax";

describe("tokenizeOperands", () => {
  const kinds = (s: string) => tokenizeOperands(s).map((t) => `${t.type}:${t.text}`);

  it("splits registers, immediates and punctuation", () => {
    expect(kinds("#$4000,d0")).toEqual(["number:#$4000", "text:,", "register:d0"]);
    expect(kinds("4(a6),d1")).toEqual(["number:4", "text:(", "register:a6", "text:),", "register:d1"]);
  });

  it("keeps register ranges' dash as punctuation, not a negative number", () => {
    expect(kinds("d0-d7/a0-a6,-(a7)")).toEqual([
      "register:d0", "text:-", "register:d7", "text:/", "register:a0", "text:-", "register:a6", "text:,-(", "register:a7", "text:)",
    ]);
  });

  it("leaves digits inside a register name alone", () => {
    expect(kinds("#$0fff,COLOR00")).toEqual(["number:#$0fff", "text:,COLOR00"]);
    expect(kinds("#$0000,BPL1PTH")).toEqual(["number:#$0000", "text:,BPL1PTH"]);
  });

  it("reads a negative displacement as one number", () => {
    expect(kinds("d0,-4(pc)")).toEqual(["register:d0", "text:,", "number:-4", "text:(", "register:pc", "text:)"]);
  });
});

describe("splitInstruction", () => {
  it("separates mnemonic, size qualifier and operands", () => {
    expect(splitInstruction("move.w #16384,14676122")).toEqual({ mnemonic: "move", qualifier: ".w", gap: " ", operands: "#16384,14676122", comment: "" });
  });

  it("handles an instruction with no operands", () => {
    expect(splitInstruction("rts")).toEqual({ mnemonic: "rts", qualifier: "", gap: "", operands: "", comment: "" });
  });

  it("keeps a trailing comment, with its spacing, out of the operands", () => {
    expect(splitInstruction("jsr -198(a6)  ; exec.library AllocMem")).toEqual({
      mnemonic: "jsr", qualifier: "", gap: " ", operands: "-198(a6)", comment: "  ; exec.library AllocMem",
    });
  });

  it("concatenates back to the original text", () => {
    for (const text of ["move.l (a0)+,d0", "nop", "MOVE to BPLCON0 at $001234", "bra.b $1000 ; loop", ""]) {
      const p = splitInstruction(text);
      expect(p.mnemonic + p.qualifier + p.gap + p.operands + p.comment).toBe(text);
    }
  });
});
