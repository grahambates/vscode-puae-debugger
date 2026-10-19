// Syntax-highlighted instruction text for the profiler's CPU, Copper and Custom Registers views
// (and the change-history list under them). Same tokens and theme colours as the memory viewer's
// canvas disassembly (see shared/asmSyntax.ts) — the asm-* classes are styled in App.css.

import { splitInstruction, tokenizeOperands } from "../shared/asmSyntax";

/** Operands, or any text mixing registers and numbers ("$0000 → $4000"). */
export function AsmOperands({ text }: { text: string }) {
  return (
    <>
      {tokenizeOperands(text).map((t, i) =>
        t.type === "text" ? t.text : <span key={i} className={t.type === "register" ? "asm-register" : "asm-number"}>{t.text}</span>,
      )}
    </>
  );
}

/** A whole instruction line: "move.w #$4000,d0  ; comment". */
export function AsmText({ text }: { text: string }) {
  const { mnemonic, qualifier, gap, operands, comment } = splitInstruction(text);
  return (
    <>
      <span className="asm-mnemonic">{mnemonic}{qualifier}</span>
      {gap}
      <AsmOperands text={operands} />
      {comment && <span className="asm-comment">{comment}</span>}
    </>
  );
}
