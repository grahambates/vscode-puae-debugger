// Value interpretations for the Disassembly view's CPU Registers panel tooltip — the same
// i8/u8/i16/u16/i32/u32 breakdown the live Variables view shows as expandable child items for a
// data/address register (see variablesManager.ts's dataRegVariables/addressRegVariables), just
// computed client-side for a hover tooltip instead of a tree node. Address registers skip the
// byte-sized interpretations (the 68000 doesn't do byte-sized address arithmetic) — the caller
// adds a symbol+offset line separately (see DisassemblyView.tsx), since that needs model.symbols.

import { convertToSigned } from "../shared/memoryFormat";

export interface RegInterpretation {
  label: string;
  value: number;
}

export function interpretDataReg(value: number): RegInterpretation[] {
  const u8v = value & 0xff;
  const u16v = value & 0xffff;
  const u32v = value >>> 0;
  return [
    { label: "i8", value: convertToSigned(u8v, 1) },
    { label: "u8", value: u8v },
    { label: "i16", value: convertToSigned(u16v, 2) },
    { label: "u16", value: u16v },
    { label: "i32", value: convertToSigned(u32v, 4) },
    { label: "u32", value: u32v },
  ];
}

export function interpretAddressReg(value: number): RegInterpretation[] {
  const u16v = value & 0xffff;
  const u32v = value >>> 0;
  return [
    { label: "i16", value: convertToSigned(u16v, 2) },
    { label: "u16", value: u16v },
    { label: "i32", value: convertToSigned(u32v, 4) },
    { label: "u32", value: u32v },
  ];
}
