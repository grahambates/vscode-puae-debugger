/* eslint-disable @typescript-eslint/no-explicit-any */

export interface CpuInfo {
  pc: string;
  // data regs
  d0: string;
  d1: string;
  d2: string;
  d3: string;
  d4: string;
  d5: string;
  d6: string;
  d7: string;
  // address regs
  a0: string;
  a1: string;
  a2: string;
  a3: string;
  a4: string;
  a5: string;
  a6: string;
  a7: string;
  sr: string;
  // stack pointers
  usp: string;
  isp: string;
  msp: string;
  vbr: string;
  irc: string;
  sfc: string;
  dfc: string;
  // cache
  cacr: string;
  caar: string;
}

export enum MemSrc {
  NONE = 0,
  CHIP = 1,
  CHIP_MIRROR = 2,
  SLOW = 3,
  SLOW_MIRROR = 4,
  FAST = 5,
  CIA = 6,
  CIA_MIRROR = 7,
  RTC = 8,
  CUSTOM = 9,
  CUSTOM_MIRROR = 10,
  AUTOCONF = 11,
  ZOR = 12,
  ROM = 13,
  ROM_MIRROR = 14,
  WOM = 15,
  EXT = 16,
}

export interface MemoryInfo {
  hasRom: boolean;
  hasWom: boolean;
  hasExt: boolean;
  hasBootRom: boolean;
  hasKickRom: boolean;
  womLock: boolean;
  romMask: string;
  extMask: string;
  chipMask: string;
  cpuMemSrc: MemSrc[];
  agnusMemSrc: MemSrc[];
}

/**
 * Returns true if the given address is backed by memory, based on a
 * (possibly absent) cached memory map.
 */
export function isValidMemoryAddress(
  memoryInfo: MemoryInfo | undefined,
  address: number,
): boolean {
  if (memoryInfo) {
    const bank = address >>> 16;
    const type = memoryInfo.cpuMemSrc[bank];
    return type !== MemSrc.NONE;
  } else {
    return address >= 0 && address < 0x1000_0000;
  }
}

/**
 * Get the contiguous memory region bounds for a given address, based on a
 * (possibly absent) cached memory map.
 */
export function getMemoryRegionForAddress(
  memoryInfo: MemoryInfo | undefined,
  address: number,
): { start: number; end: number } | null {
  if (!memoryInfo) {
    return { start: 0, end: 0x1000_0000 };
  }

  const bank = address >>> 16;
  const type = memoryInfo.cpuMemSrc[bank];

  if (type === MemSrc.NONE) {
    return null;
  }

  let startBank = bank;
  while (startBank > 0 && memoryInfo.cpuMemSrc[startBank - 1] === type) {
    startBank--;
  }

  let endBank = bank;
  while (endBank < 255 && memoryInfo.cpuMemSrc[endBank + 1] === type) {
    endBank++;
  }

  return {
    start: startBank << 16,
    end: ((endBank + 1) << 16) - 1,
  };
}

export interface CpuTraceItem {
  pc: string;
  instruction: string;
  flags: string;
  length: number;
}

export interface CustomRegisters {
  [name: string]: {
    value: string;
  };
}

export interface RegisterSetStatus {
  value: string;
}

export interface MemResult {
  address: string;
  data: string;
}

export interface Segment {
  start: number;
  size: number;
}

export interface StopMessage {
  hasMessage: boolean;
  name:
    | "BREAKPOINT_REACHED"
    | "WATCHPOINT_REACHED"
    | "REGISTER_WATCHPOINT_REACHED"
    | "CATCHPOINT_REACHED"
    | "MEMORY_PROTECTION_VIOLATION";
  payload: {
    pc: number;
    vector: number;
    addr?: number;
    value?: number;
    sizeBits?: number;
    /** 0 = CPU, 1 = DMA/Copper. PUAE-only. */
    source?: number;
    /** CPU PC at the moment of the watchpoint hit. PUAE-only. */
    cpuPc?: number;
    /** Copper list pointer at the moment of a Copper-sourced watch hit. PUAE-only. */
    copperPc?: number;
    /** Which register changed (D0-D7=0..7, A0-A7=8..15). PUAE-only. */
    regIndex?: number;
    oldValue?: number;
    newValue?: number;
  };
}

export interface AttachedMessage {
  type: "attached";
  segments: Segment[];
}

export interface EmulatorStateMessage {
  type: "emulator-state";
  state: string;
  message: StopMessage;
}

export interface EmulatorOutputMessage {
  type: "emulator-output";
  data: string;
}

export interface ExecReadyMessage {
  type: "exec-ready";
}

export interface RpcResponseMessage {
  type: "rpcResponse";
  id: string;
  result: any;
}

export type EmulatorMessage =
  | AttachedMessage
  | EmulatorStateMessage
  | EmulatorOutputMessage
  | ExecReadyMessage
  | RpcResponseMessage;

export function isAttachedMessage(
  message: EmulatorMessage,
): message is AttachedMessage {
  return message.type === "attached";
}

export function isEmulatorStateMessage(
  message: EmulatorMessage,
): message is EmulatorStateMessage {
  return message.type === "emulator-state";
}

export function isEmulatorOutputMessage(
  message: EmulatorMessage,
): message is EmulatorOutputMessage {
  return message.type === "emulator-output";
}

export function isExecReadyMessage(
  message: EmulatorMessage,
): message is ExecReadyMessage {
  return message.type === "exec-ready";
}

export function isRpcResponseMessage(
  message: EmulatorMessage,
): message is RpcResponseMessage {
  return message.type === "rpcResponse";
}
