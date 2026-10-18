// Memory watchpoints for the MCP session: break when something reads or writes an address range.
//
// The emulator's watchpoints match with an address mask — `(access & mask) == (addr & mask)` —
// so each one covers an aligned power-of-two block, not an arbitrary range. The debugger's own
// data breakpoints round a range up to one such block, which can watch more than was asked for
// (and so break on a neighbouring variable's writes, which looks exactly like the bug being
// hunted). Here a range is split into the fewest aligned blocks that cover it exactly instead;
// there are 64 hardware-ish slots, and a range of n bytes needs at most ~2·log2(n) of them.
//
// Pure — the session does the arming — so the splitting and the hit report can be tested alone.

import { SourceMap } from "../sourceMap";
import { describe as describeAddress, formatAddress } from "./breakpointSpec";
import { CUSTOM_REGISTER_OFFSETS, customRegisterName } from "../webview/shared/customRegisters";

/** PUAE_WATCHPOINT_COUNT in puae_debug.h. */
export const WATCHPOINT_SLOTS = 64;

export type WatchKind = "write" | "read" | "access";

export interface Block {
  address: number;
  size: number;
}

/** The fewest aligned power-of-two blocks covering exactly [start, start + length). */
export function alignedBlocks(start: number, length: number): Block[] {
  const blocks: Block[] = [];
  let address = start >>> 0;
  let remaining = length;
  while (remaining > 0) {
    // Largest power of two that both divides the address and fits in what's left.
    let size = address === 0 ? 2 ** 31 : address & -address;
    while (size > remaining) size /= 2;
    blocks.push({ address, size });
    address += size;
    remaining -= size;
  }
  return blocks;
}

/**
 * A custom register by HRM name: COLOR00 (a word), or a pointer pair without its suffix —
 * COP1LC, BPL1PT — as both halves. Undefined if `name` isn't one.
 */
export function customRegisterRange(name: string): Block | undefined {
  const upper = name.toUpperCase();
  const word = CUSTOM_REGISTER_OFFSETS[upper];
  if (word !== undefined) return { address: 0xdff000 + word, size: 2 };
  const pair = CUSTOM_REGISTER_OFFSETS[`${upper}H`];
  if (pair !== undefined && CUSTOM_REGISTER_OFFSETS[`${upper}L`] === pair + 2) {
    return { address: 0xdff000 + pair, size: 4 };
  }
  return undefined;
}

export interface WatchHit {
  /** The watched block's base (the stop payload's `pc`, despite the name). */
  watchAddress: number;
  addr?: number;
  accessKind?: number;
  sizeBits?: number;
  value?: number;
  oldValue?: number;
  /** 0 = CPU, 1 = DMA (the copper, for a custom register; blitter/disk, for chip RAM). */
  source?: number;
  cpuPc?: number;
  copperPc?: number;
  /**
   * The copper MOVE that made the write, when it could be confirmed. `copperPc` is the copper's
   * list pointer, which has already advanced past that instruction by the time the write lands.
   */
  copperInstruction?: number;
}

function hex(value: number, bits: number): string {
  return "$" + (value >>> 0).toString(16).padStart(Math.max(1, bits / 4), "0");
}

/**
 * "write.w $0f00 to $dff180 (COLOR00), was $0349 — by the copper at $000c94 (copper.s:12)".
 * Says who did it as precisely as the hit allows: for a DMA write the CPU's PC is incidental
 * (whatever it happened to be running), so it's labelled as such rather than presented as the
 * cause.
 */
export function describeHit(hit: WatchHit, sourceMap?: SourceMap): string {
  const addr = hit.addr ?? hit.watchAddress;
  const bits = hit.sizeBits || 16;
  const size = bits === 8 ? "b" : bits === 32 ? "l" : "w";
  const kind = hit.accessKind === 1 ? "read" : hit.accessKind === 2 ? "write" : "access";
  const isCustom = addr >= 0xdff000 && addr < 0xdff200;
  const target = isCustom
    ? `${formatAddress(addr)} (${customRegisterName(addr & 0x1fe) ?? "custom"})`
    : describeAddress(addr, sourceMap);
  let text = `${kind}.${size}`;
  if (hit.value !== undefined) text += ` ${hex(hit.value, bits)}`;
  text += `${kind === "read" ? " from" : " to"} ${target}`;
  if (kind === "write" && hit.oldValue !== undefined) text += `, was ${hex(hit.oldValue, bits)}`;

  if (hit.source === 1) {
    if (isCustom) {
      if (hit.copperInstruction !== undefined) {
        text += ` — by the copper MOVE at ${describeAddress(hit.copperInstruction, sourceMap)}`;
      } else {
        const at = hit.copperPc !== undefined ? ` (list pointer at ${describeAddress(hit.copperPc, sourceMap)})` : "";
        text += ` — by the copper${at}`;
      }
    } else {
      text += " — by DMA (blitter or disk), not the CPU";
    }
    if (hit.cpuPc !== undefined) text += `; the CPU was meanwhile at ${describeAddress(hit.cpuPc, sourceMap)}, which is not the cause`;
  } else if (hit.cpuPc !== undefined) {
    text += ` — by the CPU at ${describeAddress(hit.cpuPc, sourceMap)}`;
  }
  return text;
}

/** `equals`: the value becomes this. `changes`: the value is different after the write than before. */
export type WatchCondition = { equals: number } | { changes: true };

/**
 * Whether a write meets a watch's condition — judged on the watched VALUE as it is after the
 * write, not on the write itself. The emulator's own value test compares the access at the
 * access's width, which is wrong for a variable: a `clr.b` of a word's low byte would match
 * "== 0" while the word isn't 0, and a `move.l` across it would never match. So the write's own
 * bytes are patched into the watched bytes — as its new and its old value — which also makes the
 * answer independent of whether the hit fires before or after the store lands.
 *
 * `memory` is the watched range as read now; undefined for a custom register, which is write-only
 * and always written whole, so the write's value is the register's value.
 */
export function conditionMet(
  condition: WatchCondition,
  start: number,
  length: number,
  memory: Uint8Array | undefined,
  hit: { addr?: number; sizeBits?: number; value?: number; oldValue?: number },
): boolean {
  let after: number;
  let before: number | undefined;
  if (!memory) {
    after = (hit.value ?? 0) & 0xffff;
    before = hit.oldValue !== undefined ? hit.oldValue & 0xffff : undefined;
  } else {
    const n = (hit.sizeBits || 16) / 8;
    const patched = (value: number) => {
      const out = Uint8Array.from(memory);
      for (let i = 0; i < n; i++) {
        const at = (hit.addr ?? start) + i - start;
        if (at >= 0 && at < out.length) out[at] = (value >>> ((n - 1 - i) * 8)) & 0xff;
      }
      return out.reduce((acc, b) => acc * 256 + b, 0);
    };
    after = patched(hit.value ?? 0);
    before = hit.oldValue !== undefined ? patched(hit.oldValue) : undefined;
  }
  if ("equals" in condition) {
    const mask = length === 4 ? 0xffffffff : (1 << (length * 8)) - 1;
    return after === ((condition.equals & mask) >>> 0);
  }
  // Without the old value there's no telling it didn't change; stopping is the safe answer.
  return before === undefined || before !== after;
}
