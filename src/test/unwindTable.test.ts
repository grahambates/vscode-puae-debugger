import { readFileSync } from "fs";
import * as path from "path";
import {
  CfaInstruction,
  DebugFrame,
  DebugFrameCIE,
  DebugFrameFDE,
  DW_CFA,
  ELFSectionHeader,
  evaluateUnwindRows,
  parseDwarf,
  UnwindRow,
} from "../dwarfParser";
import { sourceMapFromDwarf } from "../dwarfSourceMap";
import { SourceMap } from "../sourceMap";
import { buildUnwindTable, PROFILER_UNWIND_ENTRY_SIZE } from "../unwindTable";

// --- helpers ---------------------------------------------------------------

function isSectionIncluded(header: ELFSectionHeader): boolean {
  return (
    header.size > 0 &&
    (header.addr > 0 ||
      header.name.startsWith(".text") ||
      header.name.startsWith(".data") ||
      header.name.startsWith(".bss") ||
      header.name.startsWith(".rodata"))
  );
}

function loadSourceMap(fixture: string): SourceMap {
  const buffer = readFileSync(path.join(__dirname, "fixtures/amigaPrograms", fixture));
  const dwarf = parseDwarf(buffer);
  const offsets = [...dwarf.sections.values()].filter((s) => isSectionIncluded(s)).map((s) => s.addr);
  return sourceMapFromDwarf(dwarf, offsets, "");
}

// Point query over the rows (test convenience only — production builds the whole table).
function unwindAt(pc: number, df: DebugFrame): UnwindRow | undefined {
  return evaluateUnwindRows(df).find((r) => pc >= r.startPc && pc < r.endPc);
}

// Build a one-function DebugFrame modelling a typical m68k framed function:
//   CIE:  def_cfa(A7,4); RA saved at CFA-4
//   FDE:  prologue grows the frame to CFA-offset 8, saves A5 at CFA-8,
//         then switches the CFA base to A5 (link a5).
// codeAlignFactor=2, dataAlignFactor=-2, returnAddressColumn=24.
function makeFramedFunctionDebugFrame(): DebugFrame {
  const A7 = 15;
  const A5 = 13;
  const RA_COL = 24;

  const initialInstructions: CfaInstruction[] = [
    { op: DW_CFA.def_cfa, reg: A7, offset: 4 },
    { op: DW_CFA.offset, reg: RA_COL, factoredOffset: 2 }, // 2 * -2 = -4
  ];

  const instructions: CfaInstruction[] = [
    { op: DW_CFA.advance_loc, delta: 2 }, // loc 0x100 -> 0x104
    { op: DW_CFA.def_cfa_offset, offset: 8 },
    { op: DW_CFA.offset, reg: A5, factoredOffset: 4 }, // 4 * -2 = -8
    { op: DW_CFA.advance_loc, delta: 1 }, // loc 0x104 -> 0x106
    { op: DW_CFA.def_cfa_register, reg: A5 },
  ];

  const cie: DebugFrameCIE = {
    offset: 0,
    version: 1,
    augmentation: "",
    codeAlignFactor: 2,
    dataAlignFactor: -2,
    returnAddressColumn: RA_COL,
    addressSize: 4,
    initialInstructions,
  };
  const fde: DebugFrameFDE = {
    offset: 0,
    cieOffset: 0,
    cie,
    pcStart: 0x100,
    pcRange: 0x40,
    instructions,
  };
  return { cies: new Map([[0, cie]]), fdes: [fde] };
}

// --- evaluateUnwindRows (deterministic, no fixture) ------------------------

describe("evaluateUnwindRows", () => {
  const df = makeFramedFunctionDebugFrame();

  it("returns no row for a pc not covered by any FDE", () => {
    expect(unwindAt(0x50, df)).toBeUndefined();
    expect(unwindAt(0x100 + 0x40, df)).toBeUndefined();
  });

  it("at function entry: CFA = A7+4, RA at CFA-4, A5 not yet saved", () => {
    const u = unwindAt(0x100, df)!;
    expect(u).toBeDefined();
    expect(u.cfaReg).toBe(15);
    expect(u.cfaOffset).toBe(4);
    expect(u.raOffset).toBe(-4);
    expect(u.r13Offset).toBeUndefined();
  });

  it("after the frame grows and A5 is saved (CFA still A7-based)", () => {
    const u = unwindAt(0x104, df)!;
    expect(u.cfaReg).toBe(15);
    expect(u.cfaOffset).toBe(8);
    expect(u.raOffset).toBe(-4);
    expect(u.r13Offset).toBe(-8);
  });

  it("after link a5: CFA switches to the A5 base, save rules persist", () => {
    const u = unwindAt(0x108, df)!;
    expect(u.cfaReg).toBe(13);
    expect(u.cfaOffset).toBe(8);
    expect(u.raOffset).toBe(-4);
    expect(u.r13Offset).toBe(-8);
  });

  it("honours remember_state / restore_state and restore", () => {
    const RA_COL = 24;
    const cie: DebugFrameCIE = {
      offset: 0,
      version: 1,
      augmentation: "",
      codeAlignFactor: 1,
      dataAlignFactor: -4,
      returnAddressColumn: RA_COL,
      addressSize: 4,
      initialInstructions: [
        { op: DW_CFA.def_cfa, reg: 15, offset: 4 },
        { op: DW_CFA.offset, reg: RA_COL, factoredOffset: 1 }, // CFA-4
      ],
    };
    const fde: DebugFrameFDE = {
      offset: 0,
      cieOffset: 0,
      cie,
      pcStart: 0,
      pcRange: 0x20,
      instructions: [
        { op: DW_CFA.advance_loc, delta: 4 }, // -> 4
        { op: DW_CFA.offset, reg: 13, factoredOffset: 2 }, // A5 at CFA-8
        { op: DW_CFA.remember_state },
        { op: DW_CFA.advance_loc, delta: 4 }, // -> 8
        { op: DW_CFA.restore, reg: 13 }, // drop the A5 rule (no initial rule)
        { op: DW_CFA.advance_loc, delta: 4 }, // -> 12
        { op: DW_CFA.restore_state }, // bring A5 rule back
      ],
    };
    const df2: DebugFrame = { cies: new Map([[0, cie]]), fdes: [fde] };

    expect(unwindAt(4, df2)!.r13Offset).toBe(-8); // saved
    expect(unwindAt(8, df2)!.r13Offset).toBeUndefined(); // restored to initial (none)
    expect(unwindAt(12, df2)!.r13Offset).toBe(-8); // restore_state brings it back
  });
});

// --- buildUnwindTable (fixture-based) --------------------------------------

describe("buildUnwindTable", () => {
  // A numbered-subdir fixture: linked (-Ttext=0), ELF vaddrs == file offsets, FDEs
  // distinct/non-overlapping. (Never reference simple_c/simple_c.elf in the root —
  // that one is in-flight/private; only the numbered subdirs are stable. c_prog.elf
  // / template.elf are relocatable objects with overlapping unrelocated FDEs.)
  const sourceMap = loadSourceMap("simple_c/08_profile_fib/simple_c.elf");
  const rows = sourceMap.getUnwindRows();
  const table = buildUnwindTable(rows)!;

  it("spans the DWARF-described code range with one 6-byte entry per 2-byte location", () => {
    expect(table).toBeDefined();
    const expStart = Math.min(...rows.map((r) => r.startPc));
    const expEnd = Math.max(...rows.map((r) => r.endPc));
    expect(table.startAddr).toBe(expStart);
    expect(table.endAddr).toBe(expEnd);
    const count = (table.endAddr - table.startAddr) >> 1;
    expect(table.buffer.length).toBe(count * PROFILER_UNWIND_ENTRY_SIZE);
  });

  it("returns undefined when there are no unwind rows", () => {
    expect(buildUnwindTable([])).toBeUndefined();
  });

  it("produces non-zero unwind entries where DWARF has frame info", () => {
    let nonZero = 0;
    const view = new DataView(table.buffer.buffer);
    for (let i = 0; i < table.buffer.length; i += PROFILER_UNWIND_ENTRY_SIZE) {
      if (view.getUint16(i, true) !== 0) nonZero++;
    }
    expect(nonZero).toBeGreaterThan(0);
  });

  it("row-filled table matches a per-PC row lookup for every slot", () => {
    // Locks the optimization: filling by constant-state rows must be identical to
    // looking up the row at each individual PC.
    const view = new DataView(table.buffer.buffer);
    const count = (table.endAddr - table.startAddr) >> 1;
    for (let i = 0; i < count; i++) {
      const pc = table.startAddr + i * 2;
      const u = rows.find((r) => pc >= r.startPc && pc < r.endPc);
      const expCfa = u ? (((u.cfaReg & 0xf) << 12) | (u.cfaOffset & 0xfff)) & 0xffff : 0;
      const expR13 = u ? (u.r13Offset ?? 0) : 0;
      const expRa = u ? (u.raOffset ?? -4) : 0;
      const o = i * PROFILER_UNWIND_ENTRY_SIZE;
      expect(view.getUint16(o, true)).toBe(expCfa);
      expect(view.getInt16(o + 2, true)).toBe(expR13);
      expect(view.getInt16(o + 4, true)).toBe(expRa);
    }
  });

  it("packed CFA register matches getCfaForPc for covered locations", () => {
    const view = new DataView(table.buffer.buffer);
    let checked = 0;
    for (let i = 0; i < (table.endAddr - table.startAddr) >> 1 && checked < 20; i++) {
      const pc = table.startAddr + i * 2;
      const cfa = sourceMap.getCfaForPc(pc);
      if (!cfa) continue;
      const packed = view.getUint16(i * PROFILER_UNWIND_ENTRY_SIZE, true);
      expect((packed >> 12) & 0xf).toBe(cfa.reg & 0xf);
      expect(packed & 0xfff).toBe(cfa.offset & 0xfff);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("skips a row whose CFA offset doesn't fit the packed 12-bit field, instead of wrapping it", () => {
    // A function with a large (>4095-byte) stack frame and no frame pointer can have
    // CFA = SP + offset with offset >= 4096, which can't be represented in the wire
    // format's 12-bit offset field. Silently masking with `& 0xfff` would compute a
    // wrong (truncated) CFA and corrupt every saved-register read derived from it.
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const oversized: UnwindRow = { startPc: 0x1000, endPc: 0x1010, cfaReg: 15, cfaOffset: 5000 };
    const t = buildUnwindTable([oversized])!;
    expect(t).toBeDefined();

    const view = new DataView(t.buffer.buffer);
    for (let pc = t.startAddr; pc < t.endAddr; pc += 2) {
      const o = ((pc - t.startAddr) >> 1) * PROFILER_UNWIND_ENTRY_SIZE;
      // Left zeroed (the "no unwind info" sentinel), not a wrapped/corrupt CFA.
      expect(view.getUint16(o, true)).toBe(0);
    }
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("still writes a row whose CFA offset is exactly at the 12-bit boundary (0xfff)", () => {
    const boundary: UnwindRow = { startPc: 0x2000, endPc: 0x2002, cfaReg: 15, cfaOffset: 0xfff };
    const t = buildUnwindTable([boundary])!;
    const view = new DataView(t.buffer.buffer);
    const packed = view.getUint16(0, true);
    expect((packed >> 12) & 0xf).toBe(15);
    expect(packed & 0xfff).toBe(0xfff);
  });
});
