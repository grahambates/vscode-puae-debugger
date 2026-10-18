// Custom-chip state, decoded for reading rather than for poking at.
//
// On an Amiga most of what goes wrong goes wrong in the chipset, not the CPU: a DMA channel left
// off, a bitplane pointer one line out, a copper list that never reaches its end. The raw values
// are all in `getAllCustomRegisters()` already — this turns them into the handful of grouped,
// decoded lines a person (or a model) would otherwise reconstruct by hand from the HRM, and walks
// the copper list the way the copper itself would.
//
// Pure — no emulator, no session — so both halves can be tested against plain inputs. The bit
// decoding itself is amigaRegisterParsers.ts, the same parsers the debugger's Variables view uses.

import { CustomRegisters } from "../emulatorProtocol";
import { parseRegister, RegisterBitField } from "../amigaRegisterParsers";
import { disassembleCopperInstruction } from "../shared/copperDisassembler";
import { CUSTOM_REGISTER_OFFSETS } from "../webview/shared/customRegisters";

const hex16 = (v: number) => "$" + (v & 0xffff).toString(16).toUpperCase().padStart(4, "0");

/** "HIRES BITPLANES=4 COLOR" — set flags by name, multi-bit fields as name=value. */
function decodeFields(fields: RegisterBitField[]): string {
  return fields
    .map(({ name, value }) => {
      const label = name.replace(/^[\d,-]+:\s*/, "");
      if (value === true) return label;
      if (value === false) return undefined;
      return `${label}=${value}`;
    })
    .filter((s): s is string => s !== undefined)
    .join(" ");
}

/**
 * Grouped, decoded custom registers. `describePointer` symbolicates a chip pointer
 * ("0x0001a000 (screen+0)"), so a bitplane pointer one line out reads as `screen+40`.
 */
export function formatChipset(regs: CustomRegisters, describePointer: (address: number) => string): string {
  const has = (name: string) => regs[name] !== undefined;
  const num = (name: string) => Number(regs[name]?.value ?? NaN);
  const word = (name: string) => (has(name) ? hex16(num(name)) : "-");
  const decoded = (name: string, as = name) => {
    if (!has(name)) return `${as}=-`;
    const fields = decodeFields(parseRegister(as, num(name)));
    return `${as}=${hex16(num(name))}${fields ? ` [${fields}]` : ""}`;
  };
  const words = (names: string[]) => names.map((n) => `${n}=${word(n)}`).join(" ");
  const pointer = (name: string) => `${name}=${has(name) ? describePointer(num(name)) : "-"}`;

  const lines: string[] = [];

  // Beam position. VPOSR's low bit is V8 and VHPOSR's high byte V7-V0, so the line number needs
  // both; HPOS is in colour clocks (one per two lores pixels), the unit a copper WAIT uses.
  const vposr = num("VPOS");
  const vhposr = num("VHPOS");
  if (Number.isFinite(vposr) && Number.isFinite(vhposr)) {
    const line = ((vposr & 1) << 8) | (vhposr >> 8);
    const hpos = (vhposr & 0xff).toString(16).toUpperCase().padStart(2, "0");
    lines.push(`Beam: line ${line}, hpos $${hpos} (colour clocks)${vposr & 0x8000 ? ", long frame" : ""}`);
  }

  lines.push(
    "",
    "DMA and interrupts:",
    `  ${decoded("DMACON")}`,
    `  ${decoded("INTENA")}`,
    `  ${decoded("INTREQ")}`,
    `  ${decoded("ADKCON")}`,
  );
  // DMAEN gates every channel — easy to miss when the channel bit itself is set.
  const dmacon = num("DMACON");
  if (Number.isFinite(dmacon) && (dmacon & 0x0200) === 0 && (dmacon & 0x01ff) !== 0) {
    lines.push("  note: ENABLE_ALL (DMAEN) is off, so no DMA channel runs whatever its own bit says");
  }

  // Only the planes BPLCON0 actually enables are worth listing; the rest are stale. BPU3 (bit 4)
  // is AGA's eighth-plane bit.
  const bplcon0 = num("BPLCON0");
  const planes = Number.isFinite(bplcon0) ? ((bplcon0 >> 12) & 7) | ((bplcon0 >> 1) & 8) : 8;
  lines.push(
    "",
    "Display:",
    `  ${decoded("BPLCON0")}`,
    `  ${decoded("BPLCON1")}`,
    `  ${decoded("BPLCON2")}`,
    `  ${decoded("BPLCON3")}`,
    `  ${words(["DIWSTRT", "DIWSTOP", "DDFSTRT", "DDFSTOP"])}`,
    `  ${words(["BPL1MOD", "BPL2MOD", "FMODE"])}`,
  );
  if (planes === 0) {
    lines.push("  no bitplanes enabled");
  } else {
    for (let i = 1; i <= Math.min(planes, 8); i++) lines.push(`  ${pointer(`BPL${i}PT`)}`);
    lines.push("  (bitplane pointers advance as lines are fetched; the copper list normally reloads them each frame)");
  }

  lines.push("", "Copper:", `  ${pointer("COP1LC")}`, `  ${pointer("COP2LC")}`, `  ${decoded("COPCON")}`);

  lines.push(
    "",
    "Blitter:",
    `  ${decoded("BLTCON0")}`,
    `  ${decoded("BLTCON1")}`,
    `  ${pointer("BLTAPT")}  ${pointer("BLTBPT")}`,
    `  ${pointer("BLTCPT")}  ${pointer("BLTDPT")}`,
    `  ${words(["BLTAMOD", "BLTBMOD", "BLTCMOD", "BLTDMOD", "BLTAFWM", "BLTALWM"])}`,
    `  ${decoded("BLTSIZE")}${Number.isFinite(dmacon) ? (dmacon & 0x4000 ? "  (busy)" : "  (idle)") : ""}`,
  );

  lines.push("", "Sprites:");
  for (let i = 0; i < 8; i++) {
    // POS and CTL both zero is a sprite that was never positioned — common, and not worth decoding.
    const unused = num(`SPR${i}POS`) === 0 && num(`SPR${i}CTL`) === 0;
    lines.push(`  ${i}: ${pointer(`SPR${i}PT`)} ` +
      (unused ? "POS/CTL=0 (not positioned)" : `${decoded(`SPR${i}POS`)} ${decoded(`SPR${i}CTL`)}`));
  }

  const colours = Array.from({ length: 32 }, (_, i) => `COLOR${String(i).padStart(2, "0")}`).filter(has);
  if (colours.length) {
    lines.push("", "Colours (OCS/ECS 12-bit):");
    for (let i = 0; i < colours.length; i += 8) {
      lines.push("  " + colours.slice(i, i + 8).map((n) => `${n.slice(5)}:${hex16(num(n)).slice(2)}`).join(" "));
    }
  }
  return lines.join("\n");
}

export interface CopperListOptions {
  /** Where to start: normally COP1LC, where the copper restarts every vertical blank. */
  start: number;
  /** COP2LC's value when the walk starts, for a COPJMP2 that runs before the list sets it. */
  cop2lc: number;
  /** Instruction budget — a list with no end marker would otherwise be read until memory ran out. */
  maxInstructions: number;
  describeAddress?: (address: number) => string;
}

const COP1LCH = CUSTOM_REGISTER_OFFSETS["COP1LCH"];
const COP1LCL = CUSTOM_REGISTER_OFFSETS["COP1LCL"];
const COP2LCH = CUSTOM_REGISTER_OFFSETS["COP2LCH"];
const COP2LCL = CUSTOM_REGISTER_OFFSETS["COP2LCL"];
const COPJMP1 = CUSTOM_REGISTER_OFFSETS["COPJMP1"];
const COPJMP2 = CUSTOM_REGISTER_OFFSETS["COPJMP2"];
// How much to read per memory fetch. A typical list fits in one; a long one costs a few.
const CHUNK_BYTES = 1024;

/**
 * Walks a copper list as the copper would run it in one frame, and returns it decoded one
 * instruction a line.
 *
 * Follows COPJMP1/COPJMP2 strobes (using COPxLC as the list itself last set them, else the
 * register's value), since a list split across two buffers is common and reading straight on
 * past a jump shows garbage. Stops at the end marker (WAIT $FFFF,$FFFE), at a jump back to an
 * instruction already listed (a loop), or at the instruction budget. A SKIP can't be resolved
 * without running the beam, so both of its outcomes are left to the reader: the walk carries on
 * linearly, which is what the copper does when the SKIP isn't taken.
 *
 * WAITs past line 255 are annotated with the real line: the copper compares only the low 8 bits
 * of the vertical position, so the usual idiom is WAIT $FFDF then smaller line numbers, which
 * read as going backwards unless the wrap is spelled out.
 */
export async function walkCopperList(
  read: (address: number, bytes: number) => Promise<Buffer>,
  options: CopperListOptions,
): Promise<string> {
  const { maxInstructions, describeAddress } = options;
  let cop1 = options.start;
  let cop2 = options.cop2lc;
  let pc = options.start;
  let chunkStart = -1;
  let chunk: Buffer = Buffer.alloc(0);
  const visited = new Set<number>();
  const lines: string[] = [];
  let lastWaitLine = -1;
  let lineBase = 0;
  let ending = `(stopped after ${maxInstructions} instructions without reaching the end marker; raise copperMax to see more)`;

  for (let n = 0; n < maxInstructions; n++) {
    if (visited.has(pc)) {
      ending = `(jumps back to ${hex24(pc)}, already listed above — the list loops)`;
      break;
    }
    visited.add(pc);
    if (chunkStart < 0 || pc < chunkStart || pc + 4 > chunkStart + chunk.length) {
      chunkStart = pc;
      chunk = await read(pc, CHUNK_BYTES);
    }
    const word1 = chunk.readUInt16BE(pc - chunkStart);
    const word2 = chunk.readUInt16BE(pc - chunkStart + 2);
    const instruction = disassembleCopperInstruction(pc, word1, word2);
    const comments: string[] = instruction.comment ? [instruction.comment] : [];
    let next = pc + 4;
    let isEnd = false;

    if (instruction.mnemonic === "MOVE") {
      const reg = word1 & 0x01fe;
      if (reg === COP1LCH) cop1 = ((word2 << 16) | (cop1 & 0xffff)) >>> 0;
      else if (reg === COP1LCL) cop1 = ((cop1 & 0xffff0000) | word2) >>> 0;
      else if (reg === COP2LCH) cop2 = ((word2 << 16) | (cop2 & 0xffff)) >>> 0;
      else if (reg === COP2LCL) cop2 = ((cop2 & 0xffff0000) | word2) >>> 0;
      else if (reg === COPJMP1 || reg === COPJMP2) {
        next = reg === COPJMP1 ? cop1 : cop2;
        comments.push(`jump to ${describeAddress ? describeAddress(next) : hex24(next)}`);
      }
    } else if (instruction.operands === "end") {
      isEnd = true;
    } else if (instruction.mnemonic === "WAIT") {
      const vp = (word1 >> 8) & 0xff;
      // A smaller line than the previous WAIT's means the beam has wrapped past line 255.
      if (lastWaitLine >= 0 && vp < lastWaitLine) lineBase = 256;
      lastWaitLine = vp;
      if (lineBase) comments.push(`line ${vp + lineBase}`);
    }

    const bytes = `${hex16(word1).slice(1)} ${hex16(word2).slice(1)}`;
    const text = `${instruction.mnemonic} ${instruction.operands}`.trim();
    lines.push(`${hex24(pc)}  ${bytes}  ${text.padEnd(22)}${comments.length ? `; ${comments.join(", ")}` : ""}`.trimEnd());

    if (isEnd) {
      ending = "";
      break;
    }
    pc = next;
  }
  if (ending) lines.push(ending);
  return lines.join("\n");
}

function hex24(address: number): string {
  return "$" + (address >>> 0).toString(16).padStart(6, "0");
}
