// 68000 disassembly, formatted for reading code rather than for reassembling it — shared by the
// MCP server's emulator_disassemble and profile_dump's per-instruction listing.
//
// m68kdecode's own rendering is faithful but hard to read in an Amiga context: absolute
// addresses come out in decimal (`move.w #16384,14676122` is `move.w #$4000,INTENA`), branches as
// raw displacements (`bra.b -2(pc)`), and nothing is symbolicated. This keeps its decoding and
// rewrites only the parts of the text whose meaning is unambiguous — absolute addresses and
// immediates to hex, branch displacements to their target — then adds what an address *is* as a
// trailing comment: a symbol, a custom register, a CIA.
//
// Pure: symbols come in as a lookup function, so it works from a live SourceMap or a capture's
// embedded symbol list, and can be tested against plain bytes.

import { decodeInstruction, instructionToString } from "m68kdecode";
import { customRegisterName } from "./webview/shared/customRegisters";

/** An address as "symbol" / "symbol+offset", or undefined — from a SourceMap or a capture's own symbol list. */
export type Symbolize = (address: number) => string | undefined;

export interface DecodedLine {
  address: number;
  length: number;
  hex: string;
  text: string;
  comments: string[];
}

const BRANCHES = new Set(["BRA", "BSR", "BCC", "DBCC"]);
const hex = (v: number) => "$" + (v >>> 0).toString(16);

/** What an absolute address refers to, if anything recognisable. */
export function describeTarget(address: number, symbolize?: Symbolize): string | undefined {
  const a = address & 0xffffff;
  if (a === 4) return "AbsExecBase";
  if (a >= 0xdff000 && a < 0xdff200) return customRegisterName(a & 0x1fe) ?? `custom ${hex(a)}`;
  // CIA-A sits on odd addresses, CIA-B on even, each register 256 bytes apart.
  if (a >= 0xbfd000 && a < 0xbfe000 && (a & 0xff) === 0) return `CIA-B reg ${(a >> 8) & 0xf}`;
  if (a >= 0xbfe001 && a < 0xbff000 && (a & 0xff) === 1) return `CIA-A reg ${(a >> 8) & 0xf}`;
  return symbolize?.(a);
}

/** Decodes one instruction at `address`, from `mem` (which starts at `address`). */
export function decodeLine(mem: Uint8Array, address: number, symbolize?: Symbolize): DecodedLine {
  const word = mem.length >= 2 ? ((mem[0] << 8) | mem[1]) >>> 0 : 0;
  let length = 2;
  let text = `dc.w $${word.toString(16).padStart(4, "0")}`;
  const comments: string[] = [];
  try {
    const decoded = decodeInstruction(mem);
    length = Math.max(decoded.bytesUsed, 2);
    text = instructionToString(decoded.instruction).trim();
    const isBranch = BRANCHES.has(decoded.instruction.operation);
    for (const op of decoded.instruction.operands) {
      if (!op) continue;
      if (op.kind === "PCDISP" && !op.disp.indexer && !op.disp.indirection) {
        const target = (address + op.offset + op.disp.baseDisplacement) >>> 0;
        const label = describeTarget(target, symbolize);
        if (isBranch) {
          // A branch's displacement is never what the reader wants; its destination is.
          text = text.replace(`${op.disp.baseDisplacement}(pc)`, hex(target));
          if (label) comments.push(label);
        } else {
          comments.push(`${hex(target)}${label ? ` ${label}` : ""}`);
        }
      } else if (op.kind === "ABS32") {
        text = text.replace(new RegExp(`(?<![#\\w-])${op.value}(?!\\w)`, "g"), hex(op.value));
        const label = describeTarget(op.value, symbolize);
        if (label) comments.push(label);
      } else if (op.kind === "ABS16") {
        // Sign-extended to 32 bits by the CPU: $8000.w is $ffff8000, i.e. $ff8000 on a 24-bit bus.
        const word16 = op.value & 0xffff;
        text = text.replace(`${op.value}.w`, `${hex(word16)}.w`);
        const label = describeTarget(op.value, symbolize);
        if (label) comments.push(label);
      } else if ((op.kind === "IMM8" || op.kind === "IMM16" || op.kind === "IMM32") && op.value >= 10) {
        // Only when the text shows the same number (moveq #-1 decodes as value 255, printed -1).
        text = text.replace(`#${op.value}`, `#${hex(op.value)}`);
      }
    }
  } catch {
    // Not a valid opcode — data, or a misaligned start. Leave the dc.w.
  }
  const hexBytes = Array.from(mem.subarray(0, length), (b) => b.toString(16).padStart(2, "0")).join("");
  return { address, length, hex: hexBytes, text, comments };
}

/** Sequentially decodes from `start` until `count` instructions or `end`, whichever is first. */
export function decodeRange(
  mem: Uint8Array,
  memBase: number,
  start: number,
  count: number,
  end = Infinity,
  symbolize?: Symbolize,
): DecodedLine[] {
  const out: DecodedLine[] = [];
  let address = start;
  while (out.length < count && address < end && address - memBase + 2 <= mem.length) {
    const line = decodeLine(mem.subarray(address - memBase), address, symbolize);
    out.push(line);
    address += line.length;
  }
  return out;
}

/** One instruction from its raw bytes (as hex, e.g. "4e 75"), as a single line of text with comments. */
export function formatInstruction(hexBytes: string, address: number, symbolize?: Symbolize): string {
  const bytes = Uint8Array.from((hexBytes.match(/[0-9a-f]{2}/gi) ?? []).map((b) => parseInt(b, 16)));
  const line = decodeLine(bytes, address, symbolize);
  return line.comments.length ? `${line.text}  ; ${line.comments.join(", ")}` : line.text;
}
