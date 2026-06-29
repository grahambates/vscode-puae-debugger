// Webview-side RPC dispatcher for the PUAE/ami9000 wasm backend.
//
// Implements the same {command, args:{..., _rpcId?}} -> postMessage contract
// as vamiga/js/vAmiga_ui.js's window.addEventListener('message', ...) handler
// (see lines ~2589-2773 there): one-way commands are applied directly,
// commands with `args._rpcId` reply via postMessage({type:'rpcResponse', id,
// result}), where `result` is either the value or `{error: message}`.
//
// setupRpcDispatcher(M, postMessage) returns { handleMessage(message) } so
// that test_g3.mjs can drive it directly with a mock postMessage, and
// index.html can wire it to window.addEventListener('message', ...) +
// vscode.postMessage.

import type { PuaeModule } from "./types";

// Must match frontend_shim.c's `#define MEM_BUF_CAP 4096` — wasm_read_memory
// clamps to this per call, so larger reads are chunked below.
const MEM_BUF_CAP = 4096;

// Max number of full-state snapshots retained for stepBack/continueReverse
// (see captureSnapshot/restoreSnapshot below). Snapshot size is roughly
// chipmem + bogomem + fastmem + z3fastmem + ~128KB overhead, e.g. ~1.6MB for
// a default A500-like config up to ~10MB for an A1200-like config with 8MB
// fast RAM — so 40 history entries is ~65-400MB. Entries come from both
// command-boundary snapshots (run/stepInto/eof/eol) and periodic
// checkpoints taken during a free-run (see pushSnapshot below and
// app.ts's frame()), giving ~40s of rewindable history at the latter's
// 1-per-emulated-second cadence.
const MAX_SNAPSHOT_HISTORY = 40;

// Matches E9K_CPU_TRACE_CAP in e9k_debug.h.
const E9K_CPU_TRACE_CAP = 256;

const E9K_WATCH_OP_READ = 1 << 0;
const E9K_WATCH_OP_WRITE = 1 << 1;
const E9K_WATCH_OP_ADDR_COMPARE_MASK = 1 << 6;

// Register indices, matching e9k_debug_read_regs/e9k_debug_write_reg's layout
// (0-7 = D0-D7, 8-15 = A0-A7, 16 = SR, 17 = PC, 18 = USP).
const REG_INDEX: Record<string, number> = {
  d0: 0, d1: 1, d2: 2, d3: 3, d4: 4, d5: 5, d6: 6, d7: 7,
  a0: 8, a1: 9, a2: 10, a3: 11, a4: 12, a5: 13, a6: 14, a7: 15,
  sr: 16, pc: 17, usp: 18,
};

// MemSrc enum values (src/vAmiga.ts) that e9k_debug_read_memory_map's output
// bytes already use directly.
const MEM_SRC_CHIP = 1;
const MEM_SRC_CHIP_MIRROR = 2;
const MEM_SRC_NONE = 0;

function hex(value: number, digits = 8): string {
  return "0x" + (value >>> 0).toString(16).padStart(digits, "0");
}

// Reads `size` bytes at `address` and returns them as a single big-endian
// unsigned integer. Module-level (not just inside setupRpcDispatcher's
// closure) so tryExec/getCurrentProcess below can use it directly.
function peekMem(M: PuaeModule, address: number, size: number): number {
  M._wasm_peek_memory(address >>> 0, size);
  const ptr = M._wasm_get_mem_buf();
  const buf = new Uint8Array(M.HEAPU8.buffer, ptr, size);
  let value = 0;
  for (let i = 0; i < size; i++) value = value * 256 + buf[i];
  return value >>> 0;
}

function readRegs(M: PuaeModule): Uint32Array {
  const n = M._wasm_read_regs();
  const ptr = M._wasm_get_reg_buf();
  return new Uint32Array(M.HEAPU32.buffer, ptr, n);
}

// Captures/restores full emulator state via the standard libretro
// retro_serialize/retro_unserialize API (wasm_serialize/wasm_unserialize) —
// the same mechanism RetroArch uses for its "rewind" feature. Used by
// stepBack/continueReverse below.
function captureSnapshot(M: PuaeModule): Uint8Array {
  const size = M._wasm_serialize_size();
  const ptr = M._malloc(size);
  try {
    if (!M._wasm_serialize(ptr, size)) {
      throw new Error("wasm_serialize failed");
    }
    return new Uint8Array(M.HEAPU8.buffer, ptr, size).slice();
  } finally {
    M._free(ptr);
  }
}

function restoreSnapshot(M: PuaeModule, bytes: Uint8Array): void {
  const ptr = M._malloc(bytes.length);
  try {
    M.HEAPU8.set(bytes, ptr);
    if (!M._wasm_unserialize(ptr, bytes.length)) {
      throw new Error("wasm_unserialize failed");
    }
  } finally {
    M._free(ptr);
  }
}

// e9k_debug_instrCount: a monotonic count of retired instructions, used as
// the anchor for exact-instruction rewind (see e9k_debug_replay_instructions
// in e9k/e9k_debug.c). Not part of the libretro savestate, so checkpoints
// must record it alongside their snapshot bytes and restore it explicitly via
// writeInstrCount after restoreSnapshot.
function readInstrCount(M: PuaeModule): bigint {
  M._wasm_read_instr_count();
  const lo = M._wasm_get_instr_count_lo();
  const hi = M._wasm_get_instr_count_hi();
  return (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
}

function writeInstrCount(M: PuaeModule, value: bigint): void {
  M._wasm_write_instr_count(Number(value & 0xFFFFFFFFn), Number((value >> 32n) & 0xFFFFFFFFn));
}

interface CheckpointEntry {
  bytes: Uint8Array;
  pc: number;
  instrCount: bigint;
}

// Restores a { bytes, instrCount } checkpoint entry (see pushSnapshot below)
// to both the emulator state and the instrCount anchor.
function restoreCheckpoint(M: PuaeModule, entry: CheckpointEntry): void {
  restoreSnapshot(M, entry.bytes);
  writeInstrCount(M, entry.instrCount);
}

// Runs forward exactly `count` retired instructions from the current state
// (normally right after restoreCheckpoint), with debugger side effects
// suppressed, and lets the framebuffer be refreshed for frames rendered
// during the replay (e.g. eof/eol callbacks stay suppressed). Used for the
// final "land on target" replay of stepBack/continueReverse/stepBackFrame, so
// the on-screen canvas reflects the landed-on state instead of whatever was
// on screen before the rewind — the restored checkpoint doesn't include
// rendered pixels. count == 0 is a no-op.
function replayInstructionsVideo(M: PuaeModule, count: bigint): void {
  M._wasm_replay_instructions_video(Number(count));
}

const REPLAY_SCAN_NO_MATCH = (1n << 64n) - 1n;

// Combined scan + video in one pass
function replayScanVideo(M: PuaeModule, count: bigint): bigint | null {
  if (count <= 0n) return null;
  M._wasm_replay_scan_video(Number(count));
  const lo = M._wasm_get_replay_scan_match_lo();
  const hi = M._wasm_get_replay_scan_match_hi();
  const match = (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
  return match === REPLAY_SCAN_NO_MATCH ? null : match;
}

// Like replayScan, but returns the instrCount of the latest frame boundary
// (vblank) crossed within the replayed range, or null if none was crossed.
function replayScanFrame(M: PuaeModule, count: bigint): bigint | null {
  if (count <= 0n) return null;
  M._wasm_replay_scan_frame(Number(count));
  const lo = M._wasm_get_replay_scan_match_lo();
  const hi = M._wasm_get_replay_scan_match_hi();
  const match = (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
  return match === REPLAY_SCAN_NO_MATCH ? null : match;
}

// Pure predicate: exec.library's AllocMem LVO is a jmp instruction, GfxBase
// is set, and the CPU is out of supervisor mode — the same three checks
// vAmiga_ui.js's tryExec uses. No side effects; safe to call in a tight loop.
export function isExecReady(M: PuaeModule): boolean {
  const execBase = peekMem(M, 4, 4);
  const allocMemAddr = (execBase - 198) >>> 0;
  const gfxBaseAddr = (execBase + 156) >>> 0;
  const regs = readRegs(M);
  const isSupervisor = (regs[16] & 0x2000) !== 0; // SR bit 13
  return (
    allocMemAddr > 0 &&
    peekMem(M, allocMemAddr, 2) === 0x4ef9 && // jmp instruction
    peekMem(M, gfxBaseAddr, 4) !== 0 && // GfxBase set
    !isSupervisor
  );
}

// Port of vAmiga_ui.js's tryExec (non-fastLoad branch). Once isExecReady(),
// arms a breakpoint on AllocMem's LVO (-198 from ExecBase) so
// getCurrentProcess() can be polled on each hit. Called every frame from
// app.ts's frame() (non-fastLoad/programB64 path) until it returns
// {ready: true}.
export function tryExec(M: PuaeModule): { ready: boolean; allocMemAddr?: number } {
  if (!isExecReady(M)) return { ready: false };
  const execBase = peekMem(M, 4, 4);
  const allocMemAddr = (execBase - 198) >>> 0;
  M._wasm_add_breakpoint(allocMemAddr);
  return { ready: true, allocMemAddr };
}

export interface CurrentProcess {
  command: string;
  segments: { start: number; size: number }[];
}

// Port of vAmiga's wasm_get_current_process() (main.cpp ~4106-4203). Walks
// ExecBase -> ThisTask -> CLI -> command name + seglist, returning null
// unless the active task is a CLI process running "file" (the program
// app.ts wrote to /uae_system/dh0/file, run via s/startup-sequence) —
// else {command: 'file', segments: [{start, size}, ...]}.
export function getCurrentProcess(M: PuaeModule): CurrentProcess | null {
  const execbase = peekMem(M, 4, 4);
  const activetask = peekMem(M, execbase + 276, 4);
  if (!activetask) return null;
  if (peekMem(M, activetask + 8, 1) !== 13) return null; // ln_Type == NT_PROCESS
  const cliPtr = peekMem(M, activetask + 172, 4);
  if (!cliPtr) return null;
  const cli = cliPtr << 2; // BPTR -> APTR
  const cmdPtr = peekMem(M, cli + 16, 4);
  if (!cmdPtr) return null;
  const cmdAddr = cmdPtr << 2;
  const cmdLen = peekMem(M, cmdAddr, 1);
  let command = "";
  for (let i = 0; i < cmdLen; i++) {
    command += String.fromCharCode(peekMem(M, cmdAddr + 1 + i, 1));
  }
  if (command !== "file") return null;
  const seglistPtr = peekMem(M, cli + 60, 4);
  if (!seglistPtr) return null;
  const segments: { start: number; size: number }[] = [];
  let seglist = seglistPtr << 2;
  while (seglist) {
    const size = peekMem(M, seglist - 4, 4) - 4;
    segments.push({ start: seglist + 4, size });
    const next = peekMem(M, seglist, 4);
    seglist = next ? next << 2 : 0;
  }
  return { command, segments };
}

export interface StopMessage {
  hasMessage: boolean;
  name: string;
  payload: Record<string, number | undefined>;
}

// Builds the StopMessage-shaped payload for an `emulator-state: stopped`
// message (see src/vAmiga.ts's StopMessage), matching vAmiga_ui.js's
// handleStop: a pending catchbreak (consumed here) means a 68k exception
// matching an enabled catchpoint vector was raised, with payload.vector set
// to the exception vector number and payload.pc set to the faulting PC. A
// pending watchbreak means a watchpoint was hit, with payload.pc set to the
// *watched address*; otherwise it's a breakpoint/step halt, with payload.pc
// set to the CPU's current PC.
export function getCurrentStopMessage(M: PuaeModule): StopMessage {
  if (M._wasm_consume_catchbreak()) {
    const ptr = M._wasm_get_catchbreak_buf();
    const buf = new Uint32Array(M.HEAPU32.buffer, ptr, 2);
    return {
      hasMessage: true,
      name: "CATCHPOINT_REACHED",
      payload: { pc: buf[0] >>> 0, vector: buf[1] >>> 0 },
    };
  }
  if (M._wasm_consume_watchbreak()) {
    const ptr = M._wasm_get_watchbreak_buf();
    const buf = new Uint32Array(M.HEAPU32.buffer, ptr, 18);
    return {
      hasMessage: true,
      name: "WATCHPOINT_REACHED",
      payload: {
        pc: buf[1] >>> 0,
        vector: 0,
        source: buf[14] >>> 0,
        cpuPc: buf[15] >>> 0,
        copperPc: buf[17] >>> 0 ? buf[16] >>> 0 : undefined,
      },
    };
  }
  if (M._wasm_consume_regwatchbreak()) {
    const ptr = M._wasm_get_regwatchbreak_buf();
    const buf = new Uint32Array(M.HEAPU32.buffer, ptr, 4);
    return {
      hasMessage: true,
      name: "REGISTER_WATCHPOINT_REACHED",
      payload: {
        pc: buf[3] >>> 0,
        vector: 0,
        regIndex: buf[0] >>> 0,
        oldValue: buf[1] >>> 0,
        newValue: buf[2] >>> 0,
      },
    };
  }
  if (M._wasm_consume_memprotect_break()) {
    const ptr = M._wasm_get_memprotect_break_buf();
    const buf = new Uint32Array(M.HEAPU32.buffer, ptr, 5);
    return {
      hasMessage: true,
      name: "MEMORY_PROTECTION_VIOLATION",
      payload: {
        pc: buf[0] >>> 0,
        vector: 0,
        addr: buf[1] >>> 0,
        value: buf[2] >>> 0,
        sizeBits: buf[3] >>> 0,
        // 0 = CPU, 1 = DMA (Blitter/disk) — see e9k-lib.h's
        // E9K_MEMPROTECT_SOURCE_* and memory.c's hook call sites.
        source: buf[4] >>> 0,
      },
    };
  }
  const n = M._wasm_read_regs();
  const ptr = M._wasm_get_reg_buf();
  const regs = new Uint32Array(M.HEAPU32.buffer, ptr, n);
  return {
    hasMessage: true,
    name: "BREAKPOINT_REACHED",
    payload: { pc: regs[17] >>> 0, vector: 0 },
  };
}

export interface RpcMessage {
  command: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args?: Record<string, any>;
}

export interface RpcDispatcher {
  handleMessage(message: RpcMessage): void;
  pushSnapshot(): void;
}

export function setupRpcDispatcher(
  M: PuaeModule,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  postMessage: (message: any) => void,
): RpcDispatcher {
  // Watchpoint address -> e9k_debug watchpoint slot index, for removeWatchpoint.
  const watchpoints = new Map<number, number>();

  // Persistent array of checkpoint "anchors" for stepBack/continueReverse
  // (see captureSnapshot/restoreCheckpoint/replayInstructionsVideo/replayScan
  // above), sorted ascending by instrCount — current position is read live
  // via readInstrCount(M), not tracked by popping entries. Each entry is
  // { bytes, pc, instrCount } — pc/instrCount are the state at capture time,
  // for inspection/debugging of what's in the history.
  const snapshotHistory: CheckpointEntry[] = [];

  // Captures the current state onto snapshotHistory as a new anchor for
  // stepBack/continueReverse to replay from. Called both before any command
  // that advances execution (run, stepInto, eof, eol) and periodically during
  // a free-run (see app.ts's frame(), ~once per emulated second) —
  // giving rewindable history that extends into a long `continue`, not just
  // back to its start. Shared ring buffer for both purposes: heavy
  // single-stepping via stepInto can evict periodic continue-checkpoints from
  // history.
  function pushSnapshot(): void {
    const pc = readRegs(M)[17] >>> 0;
    const instrCount = readInstrCount(M);
    // If a previous stepBack/continueReverse rewound execution to an earlier
    // instrCount and new forward steps have now diverged from what was
    // previously recorded, drop the abandoned "future" entries so
    // snapshotHistory stays sorted ascending by instrCount.
    while (
      snapshotHistory.length > 0 &&
      snapshotHistory[snapshotHistory.length - 1].instrCount >= instrCount
    ) {
      snapshotHistory.pop();
    }
    snapshotHistory.push({ bytes: captureSnapshot(M), pc, instrCount });
    if (snapshotHistory.length > MAX_SNAPSHOT_HISTORY) snapshotHistory.shift();
  }

  function getCpuInfo(): Record<string, string> {
    const n = M._wasm_read_regs();
    const ptr = M._wasm_get_reg_buf();
    const regs = new Uint32Array(M.HEAPU32.buffer, ptr, n);

    const info: Record<string, string> = {};
    for (let i = 0; i < 8; i++) info["d" + i] = hex(regs[i]);
    for (let i = 0; i < 8; i++) info["a" + i] = hex(regs[8 + i]);
    info.sr = hex(regs[16]);
    info.pc = hex(regs[17]);
    info.usp = hex(regs[18]);

    // e9k_debug_read_regs doesn't expose these (documented gap, Stage G3).
    for (const name of ["isp", "msp", "vbr", "irc", "sfc", "dfc", "cacr", "caar"]) {
      info[name] = "0x00000000";
    }
    return info;
  }

  function setRegister(name: string, value: number): { value: string } {
    const regnum = REG_INDEX[name.toLowerCase()];
    if (regnum === undefined) {
      throw new Error(
        `PUAE backend cannot set register '${name}' (not addressable via e9k_debug_write_reg)`,
      );
    }
    if (M._wasm_set_reg(regnum, value >>> 0) !== 0) {
      throw new Error(`Failed to set register '${name}'`);
    }
    return { value: hex(value) };
  }

  // Reads `count` bytes starting at `address`, chunking at MEM_BUF_CAP since
  // wasm_read_memory's output buffer is fixed-size.
  function readMemory(address: number, count: number): Uint8Array {
    const out = new Uint8Array(count);
    let offset = 0;
    while (offset < count) {
      const chunkLen = Math.min(count - offset, MEM_BUF_CAP);
      const n = M._wasm_read_memory((address + offset) >>> 0, chunkLen);
      const ptr = M._wasm_get_mem_buf();
      out.set(new Uint8Array(M.HEAPU8.buffer, ptr, n), offset);
      offset += n;
      if (n < chunkLen) break;
    }
    return offset === count ? out : out.slice(0, offset);
  }

  function writeMemory(address: number, data: Uint8Array | ArrayLike<number>): void {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const ptr = M._malloc(Math.max(bytes.length, 1));
    try {
      M.HEAPU8.set(bytes, ptr);
      M._wasm_write_memory_buf(address >>> 0, ptr, bytes.length);
    } finally {
      M._free(ptr);
    }
  }

  // Reads `size` bytes at `address` and returns them as a single big-endian
  // unsigned integer.
  function peek(address: number, size: number): number {
    return peekMem(M, address, size);
  }

  function poke(address: number, value: number, size: number): void {
    M._wasm_poke_memory(address >>> 0, value >>> 0, size);
  }

  // Custom chip registers PUAE's `custom_wget` returns a genuinely live
  // value for (the "...R" read-back registers in libretro-uae's
  // identify.c custd[] table, e.g. INTENAR at $DFF01C returns the live
  // `intena` masked to bits 0-14). Named without the "R" suffix to match
  // vAmiga_ui.js's getAllCustomRegisters() convention, so
  // amigaRegisterParsers.ts's bit-breakdown views (INTENA, INTREQ, DMACON,
  // ADKCON) work for this backend too.
  //
  // Other write-only registers (DMACON's write-side bits, sprite/bitplane/
  // audio pointers, COP1LC/COP2LC, etc.) are NOT exposed here: reading their
  // addresses via custom_wget doesn't return the live shadow register (real
  // hardware returns the floating data bus too), and PUAE's internal globals
  // for those aren't wired to a wasm export yet. BPLCON0-3/DIWSTRT-STOP/
  // DDFSTRT-STOP/COLOR00-31 ARE exposed, via getDisplayRegs() below.
  const READABLE_CUSTOM_REGS: Record<string, number> = {
    DMACON: 0xdff002, // DMACONR
    VPOS: 0xdff004, // VPOSR
    VHPOS: 0xdff006, // VHPOSR
    JOY0DAT: 0xdff00a,
    JOY1DAT: 0xdff00c,
    CLXDAT: 0xdff00e,
    ADKCON: 0xdff010, // ADKCONR
    POT0DAT: 0xdff012,
    POT1DAT: 0xdff014,
    POTGO: 0xdff016, // POTGOR
    DSKBYT: 0xdff01a, // DSKBYTR
    INTENA: 0xdff01c, // INTENAR
    INTREQ: 0xdff01e, // INTREQR
  };

  // Display-control registers that are write-only on the 68k bus
  // (BPLCON0-3, DIWSTRT/STOP, DDFSTRT/STOP, COLOR00-31 read back the floating
  // data bus on real hardware) but are needed by StateViewerProvider's
  // "Amiga State" panel. Exposed via e9k_get_display_regs() (custom.c) ->
  // wasm_read_display_regs/wasm_get_display_regs_buf. Order matches
  // E9K_DISPLAY_REG_COUNT in e9k_debug.h.
  const DISPLAY_REGS_ORDER = [
    "BPLCON0",
    "BPLCON1",
    "BPLCON2",
    "BPLCON3",
    "DIWSTRT",
    "DIWSTOP",
    "DDFSTRT",
    "DDFSTOP",
    ...Array.from({ length: 32 }, (_, i) => `COLOR${String(i).padStart(2, "0")}`),
  ];

  function getDisplayRegs(): Record<string, { value: string }> {
    const count = M._wasm_read_display_regs();
    const ptr = M._wasm_get_display_regs_buf();
    const values = new Uint16Array(M.HEAPU8.buffer, ptr, count);
    const result: Record<string, { value: string }> = {};
    for (let i = 0; i < DISPLAY_REGS_ORDER.length; i++) {
      result[DISPLAY_REGS_ORDER[i]] = { value: hex(values[i], 4) };
    }
    return result;
  }

  type RegTableEntry = [name: string, offset: number, size: number];

  // Reads getCustomRegsRaw()'s table-driven entries from a big-endian
  // DataView, sized 2 or 4 bytes per entry.
  function readRegTable(table: RegTableEntry[], view: DataView): Record<string, { value: string }> {
    const result: Record<string, { value: string }> = {};
    for (const [name, offset, size] of table) {
      const value = size === 4 ? view.getUint32(offset, false) : view.getUint16(offset, false);
      result[name] = { value: hex(value, size * 2) };
    }
    return result;
  }

  // Additional custom registers that are write-only on the 68k bus, exposed
  // via e9k_debug_read_custom_regs_raw() -> save_custom()'s savestate-format
  // dump of $DFF000-$DFF1FE: blitter/copper/disk pointers and control,
  // bitplane/sprite pointers and data, and display-timing registers not
  // already covered by READABLE_CUSTOM_REGS/DISPLAY_REGS_ORDER above.
  //
  // `addr` is the $DFFxxx register offset; the raw buffer holds a 4-byte
  // chipset_mask header followed by big-endian words/longs at byte offset
  // 4+addr, so the table below is converted to [name, 4 + addr, size]
  // entries for readRegTable(). 32-bit (size 4) entries are PUAE's combined
  // H/L pointer pairs, named without the H/L suffix to match vAmiga's
  // convention (e.g. BLTCPT, COP1LC, BPL1PT, SPR0PT).
  //
  // NOT included: $DFF0A0-$DFF0DE (where AUD0-3's registers would be) is
  // zero filler in this buffer, not live audio state - see
  // AUDIO_REGS_TABLE/getAudioRegs() instead.
  const CUSTOM_REGS_RAW_TABLE: RegTableEntry[] = (() => {
    const table: RegTableEntry[] = [
      ["BLTDDAT", 0x000, 2],
      ["DSKPT", 0x020, 4],
      ["DSKLEN", 0x024, 2],
      ["COPCON", 0x02e, 2],
      ["SERDAT", 0x030, 2],
      ["SERPER", 0x032, 2],
      ["POTGO", 0x034, 2],
      ["BLTCON0", 0x040, 2],
      ["BLTCON1", 0x042, 2],
      ["BLTAFWM", 0x044, 2],
      ["BLTALWM", 0x046, 2],
      ["BLTCPT", 0x048, 4],
      ["BLTBPT", 0x04c, 4],
      ["BLTAPT", 0x050, 4],
      ["BLTDPT", 0x054, 4],
      ["BLTSIZE", 0x058, 2],
      ["BLTSIZV", 0x05c, 2],
      ["BLTSIZH", 0x05e, 2],
      ["BLTCMOD", 0x060, 2],
      ["BLTBMOD", 0x062, 2],
      ["BLTAMOD", 0x064, 2],
      ["BLTDMOD", 0x066, 2],
      ["BLTCDAT", 0x070, 2],
      ["BLTBDAT", 0x072, 2],
      ["BLTADAT", 0x074, 2],
      ["DENISEID", 0x07c, 2],
      ["DSKSYNC", 0x07e, 2],
      ["COP1LC", 0x080, 4],
      ["COP2LC", 0x084, 4],
      ["CLXCON", 0x098, 2],
      ["BPL1PT", 0x0e0, 4],
      ["BPL2PT", 0x0e4, 4],
      ["BPL3PT", 0x0e8, 4],
      ["BPL4PT", 0x0ec, 4],
      ["BPL5PT", 0x0f0, 4],
      ["BPL6PT", 0x0f4, 4],
      ["BPL1MOD", 0x108, 2],
      ["BPL2MOD", 0x10a, 2],
      ["BPLCON4", 0x10c, 2],
      ["CLXCON2", 0x10e, 2],
      ["BPL1DAT", 0x110, 2],
      ["BPL2DAT", 0x112, 2],
      ["BPL3DAT", 0x114, 2],
      ["BPL4DAT", 0x116, 2],
      ["BPL5DAT", 0x118, 2],
      ["BPL6DAT", 0x11a, 2],
      ["HTOTAL", 0x1c0, 2],
      ["HSSTOP", 0x1c2, 2],
      ["HBSTRT", 0x1c4, 2],
      ["HBSTOP", 0x1c6, 2],
      ["VTOTAL", 0x1c8, 2],
      ["VSSTOP", 0x1ca, 2],
      ["VBSTRT", 0x1cc, 2],
      ["VBSTOP", 0x1ce, 2],
      ["SPRHSTRT", 0x1d0, 2],
      ["SPRHSTOP", 0x1d2, 2],
      ["BPLHSTRT", 0x1d4, 2],
      ["BPLHSTOP", 0x1d6, 2],
      ["HHPOSW", 0x1d8, 2],
      ["HHPOSR", 0x1da, 2],
      ["BEAMCON0", 0x1dc, 2],
      ["HSSTRT", 0x1de, 2],
      ["VSSTRT", 0x1e0, 2],
      ["HCENTER", 0x1e2, 2],
      ["DIWHIGH", 0x1e4, 2],
      ["FMODE", 0x1fc, 2],
    ];
    for (let i = 0; i < 8; i++) {
      table.push([`SPR${i}PT`, 0x120 + i * 4, 4]);
    }
    for (let i = 0; i < 8; i++) {
      const base = 0x140 + i * 8;
      table.push([`SPR${i}POS`, base, 2]);
      table.push([`SPR${i}CTL`, base + 2, 2]);
      table.push([`SPR${i}DATA`, base + 4, 2]);
      table.push([`SPR${i}DATB`, base + 6, 2]);
    }
    return table.map(([name, addr, size]) => [name, 4 + addr, size] as RegTableEntry);
  })();

  function getCustomRegsRaw(): Record<string, { value: string }> {
    const cap = M._wasm_read_custom_regs_raw();
    const ptr = M._wasm_get_custom_regs_raw_buf();
    const view = new DataView(M.HEAPU8.buffer, ptr, cap);
    return readRegTable(CUSTOM_REGS_RAW_TABLE, view);
  }

  // AUD0-3 LC/LEN/PER/VOL/DAT, exposed via e9k_debug_read_audio_regs() since
  // these are write-only on the 68k bus and not part of save_custom()'s
  // output (see CUSTOM_REGS_RAW_TABLE above). Packed big-endian per channel
  // as LC(4) LEN(2) PER(2) VOL(2) DAT(2) = 12 bytes, matching
  // E9K_AUDIO_REGS_SIZE in e9k_debug.h.
  const AUDIO_REGS_TABLE: RegTableEntry[] = (() => {
    const table: RegTableEntry[] = [];
    for (let i = 0; i < 4; i++) {
      const base = i * 12;
      table.push([`AUD${i}LC`, base, 4]);
      table.push([`AUD${i}LEN`, base + 4, 2]);
      table.push([`AUD${i}PER`, base + 6, 2]);
      table.push([`AUD${i}VOL`, base + 8, 2]);
      table.push([`AUD${i}DAT`, base + 10, 2]);
    }
    return table;
  })();

  function getAudioRegs(): Record<string, { value: string }> {
    const cap = M._wasm_read_audio_regs();
    const ptr = M._wasm_get_audio_regs_buf();
    const view = new DataView(M.HEAPU8.buffer, ptr, cap);
    return readRegTable(AUDIO_REGS_TABLE, view);
  }

  function getAllCustomRegisters(): Record<string, { value: string }> {
    const result: Record<string, { value: string }> = {};
    for (const [name, address] of Object.entries(READABLE_CUSTOM_REGS)) {
      result[name] = { value: hex(peek(address, 2), 4) };
    }
    Object.assign(result, getDisplayRegs());
    Object.assign(result, getCustomRegsRaw());
    Object.assign(result, getAudioRegs());
    return result;
  }

  function getMemoryInfo() {
    M._wasm_read_memory_map();
    const ptr = M._wasm_get_memory_map_buf();
    const cpuMemSrc = Array.from(new Uint8Array(M.HEAPU8.buffer, ptr, 256));

    // Agnus' chip-bus DMA can only see chip RAM; everything else is NONE.
    // Approximation pending real Agnus-bus modeling (e.g. "Gary timeout"
    // chip-DMA access to slow/fast RAM isn't represented here).
    const agnusMemSrc = cpuMemSrc.map((v) =>
      v === MEM_SRC_CHIP || v === MEM_SRC_CHIP_MIRROR ? v : MEM_SRC_NONE,
    );

    // Chip RAM size is configurable (OpenOptions.chipRam / configFilePath /
    // emulatorOptions.puae's chipmem_size). The chip address space as seen in
    // cpuMemSrc (CHIP + CHIP_MIRROR banks) reflects the Agnus revision's
    // addressable range, not the installed RAM size — e.g. it's a fixed 2MB
    // for the default A500/OCS_OLD config even though chipmem_size is 512K
    // (the extra range mirrors the installed RAM). So derive the mask
    // directly from currprefs.chipmem.size via wasm_get_chip_mem_size.
    const chipMask = hex(M._wasm_get_chip_mem_size() - 1);

    return {
      // This backend always boots a 512KB Kickstart 1.3 ROM directly mapped at
      // 0xF80000-0xFFFFFF — no boot ROM, WOM, or extended ROM.
      hasRom: true,
      hasWom: false,
      hasExt: false,
      hasBootRom: false,
      hasKickRom: true,
      womLock: false,
      romMask: hex(0x0007ffff),
      extMask: hex(0x00000000),
      chipMask,
      cpuMemSrc,
      agnusMemSrc,
    };
  }

  // e9k_debug_disassemble_quick (UAE's m68k_disasm_2) prefixes each line with
  // the address ("%08X ", 9 chars) followed by max(wordCount, disasm_min_words=5)
  // hex-word groups ("%04X " or "     ", 5 chars each) before the mnemonic +
  // operands. Strip that prefix so `instruction` is mnemonic-only, matching
  // vAmiga_ui.js's format (relied on by doInstructionStepOver's jsr/bsr/dbra
  // detection in vAmigaDebugAdapter.ts).
  function parseDisasmInstruction(raw: string, len: number): string {
    const words = Math.max(Math.min(Math.floor(len / 2), 16), 5);
    return raw.slice(9 + words * 5).trim();
  }

  function disassemble(address: number, count: number) {
    const instructions: { addr: string; instruction: string; hex: string }[] = [];
    let addr = address >>> 0;
    for (let i = 0; i < count; i++) {
      const len = M._wasm_disassemble(addr);
      const raw = M.UTF8ToString(M._wasm_get_disasm_buf());
      const instruction = parseDisasmInstruction(raw, len);
      const bytes = readMemory(addr, Math.max(len, 0));
      const hexBytes = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
      instructions.push({ addr: hex(addr, 6), instruction, hex: hexBytes });
      addr = (addr + Math.max(len, 2)) >>> 0;
    }
    return { instructions };
  }

  // 16-char status-register flag string, matching vAmiga/Moira's
  // disassembleSR() format (vAmigaDebugAdapter.ts checks flags.includes("S")
  // to detect supervisor mode for exception stack-frame handling).
  function srFlags(sr: number): string {
    const bit = (n: number) => (sr & (1 << n)) !== 0;
    const ipl = (sr >> 8) & 7;
    return [
      bit(15) ? "T" : "t",
      bit(14) ? "T" : "t",
      bit(13) ? "S" : "s",
      bit(12) ? "M" : "m",
      "-",
      ipl & 4 ? "1" : "0",
      ipl & 2 ? "1" : "0",
      ipl & 1 ? "1" : "0",
      "-",
      "-",
      "-",
      bit(4) ? "X" : "x",
      bit(3) ? "N" : "n",
      bit(2) ? "Z" : "z",
      bit(1) ? "V" : "v",
      bit(0) ? "C" : "c",
    ].join("");
  }

  function getCpuTrace(count: number) {
    const maxCount = Math.min(Math.max(count >>> 0, 0), E9K_CPU_TRACE_CAP);
    const n = M._wasm_read_cpu_trace(maxCount);
    const bufPtr = M._wasm_get_cpu_trace_buf() >> 2;
    const trace: { pc: string; instruction: string; flags: string; length: number }[] = [];
    for (let i = 0; i < n; i++) {
      const pc = M.HEAPU32[bufPtr + i * 2];
      const sr = M.HEAPU32[bufPtr + i * 2 + 1];
      const len = M._wasm_disassemble(pc);
      const raw = M.UTF8ToString(M._wasm_get_disasm_buf());
      trace.push({
        pc: hex(pc, 6),
        instruction: parseDisasmInstruction(raw, len),
        flags: srFlags(sr),
        length: Math.max(len, 0),
      });
    }
    return trace;
  }

  // addr_mask_operand is a bitmask comparison in e9k_debug_watchpointMatch
  // ((accessAddr & mask) == (wp->addr & mask)), not an arbitrary byte-range
  // check — so `length` can only be expressed by rounding up to the next
  // power of 2 and masking off its low bits. The *effective* watched
  // region is [address rounded down to that boundary, +size), which can
  // start slightly before `address` rather than exactly at it. length=1
  // (the default) gives mask=0xFFFFFFFF, i.e. the original exact-address
  // behaviour.
  function watchpointAddrMask(length: number): number {
    if (!length || length <= 1) return 0xffffffff;
    const size = 1 << Math.ceil(Math.log2(length));
    return (~(size - 1)) >>> 0;
  }

  function setWatchpoint(
    address: number,
    { read = true, write = true, length = 1 }: { read?: boolean; write?: boolean; length?: number } = {},
  ): void {
    if (watchpoints.has(address)) return;
    let opMask = E9K_WATCH_OP_ADDR_COMPARE_MASK;
    if (read) opMask |= E9K_WATCH_OP_READ;
    if (write) opMask |= E9K_WATCH_OP_WRITE;
    const index = M._wasm_add_watchpoint(
      address >>> 0,
      opMask,
      0, 0, 0, 0, watchpointAddrMask(length),
    );
    if (index < 0) {
      console.warn(`[puae_rpc] setWatchpoint: no free watchpoint slots for 0x${address.toString(16)}`);
      return;
    }
    watchpoints.set(address, index);
  }

  function removeWatchpoint(address: number): void {
    const index = watchpoints.get(address);
    if (index === undefined) return;
    M._wasm_remove_watchpoint(index);
    watchpoints.delete(address);
  }

  // Register watches: break when a CPU register's own value changes (D0-D7/
  // A0-A7 only — see e9k-lib.h's E9K_REGWATCH_COUNT comment for why there's
  // no read/write/length distinction the way memory watchpoints have one).
  function setRegisterWatch(regIndex: number): void {
    M._wasm_add_regwatch(regIndex >>> 0);
  }

  function removeRegisterWatch(regIndex: number): void {
    M._wasm_remove_regwatch(regIndex >>> 0);
  }

  // Clears all watchpoints/register watches, both in the engine and in this
  // module's own address->slot bookkeeping. Needed when a new debug session
  // reuses this same webview/module instance: the new session's
  // BreakpointManager starts empty and has no record of what a *previous*
  // session armed, so without an explicit reset here that old watch stays
  // live (and, for memory watchpoints, the stale `watchpoints` Map entry
  // would also make a same-address setWatchpoint silently no-op afterward).
  function resetWatchpoints(): void {
    M._wasm_reset_debug_watches();
    watchpoints.clear();
  }

  function handleMessage(message: RpcMessage): void {
    if (!message || !message.command) return;
    const args = message.args || {};

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rpcRequest = (resultFn: () => any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = { type: "rpcResponse", id: args._rpcId };
      try {
        res.result = resultFn();
      } catch (error) {
        res.result = { error: (error as Error).message };
      }
      postMessage(res);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rpcRequestAsync = (resultFn: () => Promise<any>) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = { type: "rpcResponse", id: args._rpcId };
      resultFn()
        .then(result => { res.result = result; postMessage(res); })
        .catch(error => { res.result = { error: error.message }; postMessage(res); });
    };

    switch (message.command) {
      // --- One-way commands ---
      case "pause":
        M._wasm_pause();
        // Mirrors vAmiga_ui.js's wasm_halt(true): tells the DAP adapter the
        // emulator is now paused so it can send a StoppedEvent("pause").
        postMessage({ type: "emulator-state", state: "paused" });
        break;
      case "run":
        pushSnapshot();
        M._wasm_resume();
        // Mirrors vAmiga_ui.js's continue path: tells the DAP adapter the
        // emulator is running again so it can send a ContinuedEvent.
        postMessage({ type: "emulator-state", state: "running" });
        break;
      case "stepInto": {
        // Mirrors index.html's Stage G1 "Step Instr" button: single-step
        // then tick until paused (or give up after a few ticks).
        pushSnapshot();
        M._wasm_step_instr();
        const MAX_TICKS = 4;
        for (let i = 0; i < MAX_TICKS; i++) {
          M._wasm_tick();
          if (M._wasm_is_paused()) break;
        }
        // Tells the DAP adapter the step completed so it can send a
        // StoppedEvent("step") (handleStep, vAmigaDebugAdapter.ts).
        postMessage({ type: "emulator-state", state: "stopped", message: getCurrentStopMessage(M) });
        break;
      }
      case "eof":
        // wasm_eof() registers a one-shot vblank callback and resumes.
        pushSnapshot();
        M._wasm_eof();
        break;
      case "eol":
        // wasm_eol() registers a one-shot hblank (per-scanline) callback and resumes.
        pushSnapshot();
        M._wasm_eol();
        break;
      case "setBreakpoint":
        if (args.ignores) {
          console.warn("[puae_rpc] setBreakpoint: ignore counts not supported, breakpoint will fire every time");
        }
        M._wasm_add_breakpoint(args.address >>> 0);
        break;
      case "removeBreakpoint":
        M._wasm_remove_breakpoint(args.address >>> 0);
        break;
      case "setWatchpoint":
        if (args.ignores) {
          console.warn("[puae_rpc] setWatchpoint: ignore counts not supported, watchpoint will fire every time");
        }
        setWatchpoint(args.address >>> 0, {
          read: args.read,
          write: args.write,
          length: args.length,
        });
        break;
      case "removeWatchpoint":
        removeWatchpoint(args.address >>> 0);
        break;
      case "setRegisterWatch":
        setRegisterWatch(args.regIndex >>> 0);
        break;
      case "removeRegisterWatch":
        removeRegisterWatch(args.regIndex >>> 0);
        break;
      case "resetWatchpoints":
        resetWatchpoints();
        break;
      case "setCatchpoint":
        if (args.ignores) {
          console.warn("[puae_rpc] setCatchpoint: ignore counts not supported, catchpoint will fire every time");
        }
        M._wasm_set_catchpoint(args.vector >>> 0);
        break;
      case "removeCatchpoint":
        M._wasm_remove_catchpoint(args.vector >>> 0);
        break;
      case "setMemoryProtectionEnabled":
        M._wasm_memprotect_set_enabled(args.enabled ? 1 : 0);
        break;
      case "resetMemoryProtectionRanges":
        M._wasm_memprotect_reset_ranges();
        break;
      case "addMemoryProtectionRange":
        M._wasm_memprotect_add_range(args.address >>> 0, args.size >>> 0);
        break;
      case "seedMemoryProtectionLibraries":
        M._wasm_memprotect_seed_libraries();
        break;
      case "enableCpuLogging":
        M._wasm_enable_cpu_logging(args.enabled ? 1 : 0);
        break;
      case "load":
        // Reuse the already-booted wasm module + webview for a new debug
        // session: hard-reset the machine (uae_reset(1,0) — reboots
        // Kickstart, clears RAM) and re-run the boot warm-up to reach
        // "exec ready" again, then re-signal exec-ready so the extension
        // re-runs fastLoad injection for the new program. Mirrors
        // vAmiga_ui.js's snapshot-restore "load" handler.
        M._wasm_reset();
        // Process the hard reset: quit_program flips from negative ->
        // UAE_RESET_HARD on the first tick (after run_func), then is
        // actioned (custom_reset, m68k_reset2, memory_clear) on the second —
        // a couple of extra ticks give margin (see test_reset.mjs).
        for (let i = 0; i < 4; i++) M._wasm_tick();
        // The hard reset invalidated every previously-tracked AllocMem range
        // (and possibly moved execBase) — drop them and restart the watch
        // fresh, same as the initial boot path. Reset first so no stale
        // range survives even if a tick below catches an AllocMem call
        // before the reset-ranges call would otherwise have landed.
        M._wasm_memprotect_reset_ranges();
        // Tick until AmigaOS is ready rather than a fixed count — mirrors
        // vAmiga_ui.js's tryExec condition. 1000 ticks (~20 PAL seconds) is
        // a generous safety ceiling that should never be reached in practice.
        // Poll the memory-protection watch every tick too (it validates
        // execBase itself and no-ops until ready), so it starts as soon as
        // exec.library re-initializes post-reset, not just once this loop's
        // fuller "user task started" condition is met.
        {
          let memProtectTrackingStarted = false;
          for (let i = 0; !isExecReady(M) && i < 1000; i++) {
            M._wasm_tick();
            if (!memProtectTrackingStarted) {
              memProtectTrackingStarted = !!M._wasm_memprotect_start_tracking();
            }
          }
          if (!memProtectTrackingStarted) M._wasm_memprotect_start_tracking();
        }
        // GfxBase is confirmed set if isExecReady() actually passed (vs. the
        // loop timing out) — safe to walk the library list now.
        if (isExecReady(M)) M._wasm_memprotect_seed_libraries();
        // Snapshots captured before the reset reference the previous
        // program's RAM/state — restoring them now would be confusing/
        // incorrect, so drop them.
        snapshotHistory.length = 0;
        postMessage({ type: "exec-ready" });
        break;

      // --- RPC commands ---
      case "getCpuInfo":
        rpcRequest(() => getCpuInfo());
        break;
      case "setRegister":
        rpcRequest(() => setRegister(args.name, args.value));
        break;
      case "jump":
        rpcRequest(() => {
          setRegister("pc", args.address);
        });
        break;
      case "getMemoryInfo":
        rpcRequest(() => getMemoryInfo());
        break;
      case "readMemory":
        rpcRequest(() => ({ data: readMemory(args.address >>> 0, args.count) }));
        break;
      case "writeMemory":
        rpcRequest(() => writeMemory(args.address >>> 0, args.data));
        break;
      case "peek32":
        rpcRequest(() => peek(args.address, 4));
        break;
      case "peek16":
        rpcRequest(() => peek(args.address, 2));
        break;
      case "peek8":
        rpcRequest(() => peek(args.address, 1));
        break;
      case "poke32":
        rpcRequest(() => poke(args.address, args.value, 4));
        break;
      case "poke16":
        rpcRequest(() => poke(args.address, args.value, 2));
        break;
      case "poke8":
        rpcRequest(() => poke(args.address, args.value, 1));
        break;
      case "pokeCustom16":
        rpcRequest(() => poke(args.address, args.value, 2));
        break;
      case "pokeCustom32":
        rpcRequest(() => poke(args.address, args.value, 4));
        break;
      case "getAllCustomRegisters":
        rpcRequest(() => getAllCustomRegisters());
        break;
      case "disassemble":
        rpcRequest(() => disassemble(args.address, args.count));
        break;
      case "disassembleCopper":
        rpcRequest(() => {
          throw new Error("Copper disassembly not yet supported by the PUAE backend");
        });
        break;
      case "getCpuTrace":
        rpcRequest(() => getCpuTrace(args.count ?? 256));
        break;
      case "stepBack":
        // Lands exactly one instruction before the current state, by
        // restoring the newest checkpoint at or before that target instrCount
        // and replaying forward the remaining (usually small) instruction
        // count. Returns false if the target predates the oldest checkpoint
        // still in history.
        rpcRequest(() => {
          if (snapshotHistory.length === 0) return false;
          const current = readInstrCount(M);
          const target = current - 1n;
          if (target < snapshotHistory[0].instrCount) return false;
          let i = snapshotHistory.length - 1;
          while (snapshotHistory[i].instrCount > target) i--;
          const entry = snapshotHistory[i];
          restoreCheckpoint(M, entry);
          replayInstructionsVideo(M, target - entry.instrCount);
          return true;
        });
        break;
      case "continueReverse":
        // Walks back through snapshotHistory's checkpoint intervals (newest
        // first), scanning each for the latest instruction whose PC matches a
        // breakpoint, and lands exactly there. Each interval is also replayed
        // with video enabled and the canvas painted so the user sees the
        // display stepping backward in time while the scan runs. Returns false
        // (no breakpoint found / reached start of history) so the DAP adapter
        // shows "Cannot continue reverse: reached start of rewind history".
        rpcRequestAsync(async () => {
          if (snapshotHistory.length === 0) return false;
          const current = readInstrCount(M);
          const target = current - 1n;
          if (target < snapshotHistory[0].instrCount) return false;
          let i = snapshotHistory.length - 1;
          while (i >= 0 && snapshotHistory[i].instrCount > target) i--;
          for (; i >= 0; i--) {
            const entry = snapshotHistory[i];
            const next = snapshotHistory[i + 1];
            const upper = next && next.instrCount <= target + 1n ? next.instrCount : target + 1n;
            // Combined scan+video pass: scan for breakpoints and update the
            // framebuffer in one m68k_go run, avoiding a second restore+replay.
            restoreCheckpoint(M, entry);
            const match = replayScanVideo(M, upper - entry.instrCount);
            if (typeof globalThis.drawCurrentFrame === "function") globalThis.drawCurrentFrame();
            await new Promise(r => setTimeout(r, 0)); // yield for canvas repaint
            if (match !== null) {
              restoreCheckpoint(M, entry);
              replayInstructionsVideo(M, match - entry.instrCount);
              return true;
            }
          }
          // No breakpoint found — land at oldest checkpoint, signal "reached start".
          restoreCheckpoint(M, snapshotHistory[0]);
          return false;
        });
        break;
      case "stepBackFrame":
        // Steps back to the start of the current frame (the most recent
        // vblank strictly before the current instrCount). A frame boundary
        // recorded with instrCount==N means "vblank occurred just before
        // instruction N retires" — it fires during a replay targeting N
        // itself (before the break-check for instruction N). So to avoid
        // re-finding the boundary we're already paused at/just past, scan up
        // to `target = current - 1`, mirroring stepBack/continueReverse's
        // target computation. Walks back through snapshotHistory's
        // checkpoints (newest first); for each, scans the whole range up to
        // `target` for frame boundaries — scanLastMatch's "last write wins"
        // semantics mean this always yields the latest (closest-to-current)
        // boundary regardless of how large the scanned range is, so unlike
        // continueReverse no per-interval upper bound is needed. Returns
        // false if no frame boundary exists anywhere in history (e.g. before
        // the first vblank after boot).
        rpcRequest(() => {
          if (snapshotHistory.length === 0) return false;
          const current = readInstrCount(M);
          const target = current - 1n;
          if (target < snapshotHistory[0].instrCount) return false;
          let i = snapshotHistory.length - 1;
          while (i >= 0 && snapshotHistory[i].instrCount > target) i--;
          for (; i >= 0; i--) {
            const entry = snapshotHistory[i];
            restoreCheckpoint(M, entry);
            const match = replayScanFrame(M, target - entry.instrCount);
            if (match !== null) {
              restoreCheckpoint(M, entry);
              replayInstructionsVideo(M, match - entry.instrCount);
              postMessage({ type: "emulator-state", state: "stopped", message: getCurrentStopMessage(M) });
              return true;
            }
          }
          return false;
        });
        break;
      case "profileSetUnwind": {
        const raw = args.data;
        const bytes = raw instanceof Uint8Array ? raw
          : raw instanceof ArrayBuffer ? new Uint8Array(raw)
          : new Uint8Array(0);
        const ptr = bytes.length > 0 ? M._malloc(bytes.length) : 0;
        if (ptr) M.HEAPU8.set(bytes, ptr);
        M._wasm_profile_set_unwind(ptr, bytes.length, args.startAddr >>> 0, args.endAddr >>> 0);
        if (ptr) M._free(ptr);
        rpcRequest(() => ({ ok: true }));
        break;
      }
      case "startProfiling":
        rpcRequest(() => ({ ok: !!M._wasm_profile_start(args.numFrames ?? 1) }));
        break;
      case "getProfileData":
        rpcRequest(() => {
          const stats = JSON.parse(M.UTF8ToString(M._wasm_profile_get_stats()));
          const ptr = M._wasm_profile_get_buf_ptr();
          const words = M._wasm_profile_get_buf_words();
          return {
            data: new Uint8Array(M.HEAPU8.buffer, ptr, words * 4).slice(),
            start: stats.start,
            end: stats.end,
            total: stats.total,
            inRange: stats.inRange,
            frameCycles: stats.frameCycles ?? 0,
            isPAL: true,
          };
        });
        break;
      case "getDmaData": {
        const ptr = M._wasm_dma_get_grid_ptr();
        const size = M._wasm_dma_get_grid_size();
        rpcRequest(() => ({
          data: size > 0
            ? new Uint8Array(M.HEAPU8.buffer, ptr, size).slice()
            : new Uint8Array(0),
        }));
        break;
      }
      case "getDmaSnapshot": {
        const chipPtr = M._wasm_dma_get_chip_ptr();
        const chipSize = M._wasm_dma_get_chip_size();
        const chip = new Uint8Array(M.HEAPU8.buffer, chipPtr, chipSize).slice();

        const slowPtr = M._wasm_dma_get_slow_ptr();
        const slowSize = M._wasm_dma_get_slow_size();
        const slow = slowSize > 0
          ? new Uint8Array(M.HEAPU8.buffer, slowPtr, slowSize).slice()
          : new Uint8Array(0);

        // save_custom() output: 4-byte chipset_mask header + 256 big-endian u16 words.
        // Profiler expects 256 little-endian u16 words (512 bytes), so byte-swap here.
        M._wasm_read_custom_regs_raw();
        const rawPtr = M._wasm_get_custom_regs_raw_buf();
        const rawView = new DataView(M.HEAPU8.buffer, rawPtr, 520);
        const custom = new Uint8Array(512);
        const customView = new DataView(custom.buffer);
        for (let i = 0; i < 256; i++) {
          customView.setUint16(i * 2, rawView.getUint16(4 + i * 2, false), true);
        }

        rpcRequest(() => ({ chip, slow, custom }));
        break;
      }
      default:
        console.warn(`[puae_rpc] unhandled command: ${message.command}`);
    }
  }

  // pushSnapshot is also called by app.ts's frame() to take periodic
  // checkpoints during a free-run.
  return { handleMessage, pushSnapshot };
}
