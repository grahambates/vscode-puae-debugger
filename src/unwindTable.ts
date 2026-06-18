import { UnwindRow } from "./dwarfParser";

// One unwind entry per 2-byte code location, matching the WinUAE `cpu_profiler_unwind`
// layout the emulator-side CPU profiler consumes:
//
//   struct ProfilerUnwindEntry { u16 cfa; i16 r13; i16 ra; }   // 6 bytes, little-endian
//
//   cfa = (cfaReg << 12) | cfaOffset   // CFA base register (high nibble) + offset (low 12 bits)
//   r13 = byte offset from CFA where the caller's A5 is saved (0 = not saved)
//   ra  = byte offset from CFA where the return address is saved
//
// The emulator reconstructs a call stack per instruction by computing
// CFA = reg[cfaReg] + cfaOffset, reading the return address at CFA+ra and the
// caller's A5 at CFA+r13, then repeating up the chain.
export const PROFILER_UNWIND_ENTRY_SIZE = 6;

// m68k return address lives at CFA-4 when the DWARF info has no explicit rule
// for the return-address column (e.g. a leaf frame). Mirrors WinUAE's fallback.
const RA_FALLBACK_OFFSET = -4;

export interface UnwindTable {
  // Loaded code range the table covers. Index of a pc is (pc - startAddr) / 2.
  startAddr: number;
  endAddr: number;
  // (endAddr - startAddr) / 2 entries of PROFILER_UNWIND_ENTRY_SIZE bytes each.
  buffer: Uint8Array;
}

// Build the per-code-location unwind table directly from the program's DWARF
// unwind rows (sourceMap.getUnwindRows()). The covered range is derived from the
// rows themselves — i.e. all the code DWARF .debug_frame gives us unwind info for
// — so this needs nothing from the SourceMap's section/segment table. Returns
// undefined when there are no rows (no DWARF frame info / pure-assembly program),
// in which case the profiler cannot reconstruct call stacks.
//
// Filled row-by-row (each row is a [startPc, endPc) range of constant state): the
// packed entry is computed once per row and written across the row's slots. Slots
// inside the range but not covered by any row stay zeroed — the sentinel the
// emulator reads as "no unwind info". O(rows + covered slots); no per-PC replay.
export function buildUnwindTable(rows: UnwindRow[]): UnwindTable | undefined {
  if (rows.length === 0) return undefined;

  // Span exactly the code DWARF describes. PCs are 2-byte aligned (m68k), as are
  // FDE pcStart/pcRange, so startAddr/endAddr are already even.
  let startAddr = rows[0].startPc;
  let endAddr = rows[0].endPc;
  for (const r of rows) {
    if (r.startPc < startAddr) startAddr = r.startPc;
    if (r.endPc > endAddr) endAddr = r.endPc;
  }

  const count = (endAddr - startAddr) >> 1; // one entry per 2-byte code location
  const buffer = new Uint8Array(count * PROFILER_UNWIND_ENTRY_SIZE);
  const view = new DataView(buffer.buffer);

  for (const row of rows) {
    // Pack once per row. cfaReg is a m68k DWARF register number (0-15 → D0-D7/A0-A7),
    // so it fits in 4 bits; cfaOffset is a small positive frame offset (CFA is above SP)
    // packed into the remaining 12 bits (0-4095). A frame larger than that can't be
    // represented in this wire format — rather than silently wrapping (corrupting the
    // CFA, and so every saved-register read computed from it), skip the row and leave
    // its slots zeroed, the existing "no unwind info" sentinel for uncovered code.
    if (row.cfaOffset < 0 || row.cfaOffset > 0xfff) {
      console.warn(
        `buildUnwindTable: CFA offset ${row.cfaOffset} out of the packed 12-bit range ` +
          `for pc range 0x${row.startPc.toString(16)}-0x${row.endPc.toString(16)}; skipping ` +
          `(profiler call stacks through this range will stop here instead of using a corrupt CFA)`,
      );
      continue;
    }
    const cfa = (((row.cfaReg & 0xf) << 12) | (row.cfaOffset & 0xfff)) & 0xffff;
    const r13 = row.r13Offset ?? 0;
    const ra = row.raOffset ?? RA_FALLBACK_OFFSET;

    const from = Math.max(row.startPc, startAddr);
    const to = Math.min(row.endPc, endAddr);
    for (let pc = from; pc < to; pc += 2) {
      const o = ((pc - startAddr) >> 1) * PROFILER_UNWIND_ENTRY_SIZE;
      // First row wins (matches DWARF's first-FDE lookup). For a normal linked
      // program FDEs never overlap, so this is a no-op; it only disambiguates
      // pathological relocatable inputs. cfa is nonzero for a covered slot
      // (cfaReg is 13/15), so 0 marks "not yet written".
      if (view.getUint16(o, true) !== 0) continue;
      view.setUint16(o, cfa, true);
      view.setInt16(o + 2, r13, true);
      view.setInt16(o + 4, ra, true);
    }
  }

  return { startAddr, endAddr, buffer };
}
