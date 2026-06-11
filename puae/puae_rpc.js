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

// Must match frontend_shim.c's `#define MEM_BUF_CAP 4096` — wasm_read_memory
// clamps to this per call, so larger reads are chunked below.
const MEM_BUF_CAP = 4096;

const E9K_WATCH_OP_READ = 1 << 0;
const E9K_WATCH_OP_WRITE = 1 << 1;
const E9K_WATCH_OP_ADDR_COMPARE_MASK = 1 << 6;

// Register indices, matching e9k_debug_read_regs/e9k_debug_write_reg's layout
// (0-7 = D0-D7, 8-15 = A0-A7, 16 = SR, 17 = PC, 18 = USP).
const REG_INDEX = {
  d0: 0, d1: 1, d2: 2, d3: 3, d4: 4, d5: 5, d6: 6, d7: 7,
  a0: 8, a1: 9, a2: 10, a3: 11, a4: 12, a5: 13, a6: 14, a7: 15,
  sr: 16, pc: 17, usp: 18,
};

// MemSrc enum values (src/vAmiga.ts) that e9k_debug_read_memory_map's output
// bytes already use directly.
const MEM_SRC_CHIP = 1;
const MEM_SRC_CHIP_MIRROR = 2;
const MEM_SRC_NONE = 0;

function hex(value, digits = 8) {
  return "0x" + (value >>> 0).toString(16).padStart(digits, "0");
}

// Builds the StopMessage-shaped payload for an `emulator-state: stopped`
// message (see src/vAmiga.ts's StopMessage), matching vAmiga_ui.js's
// handleStop: a pending watchbreak (consumed here) means a watchpoint was
// hit, with payload.pc set to the *watched address*; otherwise it's a
// breakpoint/step halt, with payload.pc set to the CPU's current PC.
export function getCurrentStopMessage(M) {
  if (M._wasm_consume_watchbreak()) {
    const ptr = M._wasm_get_watchbreak_buf();
    const buf = new Uint32Array(M.HEAPU32.buffer, ptr, 14);
    return {
      hasMessage: true,
      name: "WATCHPOINT_REACHED",
      payload: { pc: buf[1] >>> 0, vector: 0 },
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

export function setupRpcDispatcher(M, postMessage) {
  // Watchpoint address -> e9k_debug watchpoint slot index, for removeWatchpoint.
  const watchpoints = new Map();

  function getCpuInfo() {
    const n = M._wasm_read_regs();
    const ptr = M._wasm_get_reg_buf();
    const regs = new Uint32Array(M.HEAPU32.buffer, ptr, n);

    const info = {};
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

  function setRegister(name, value) {
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
  function readMemory(address, count) {
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

  function writeMemory(address, data) {
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
  function peek(address, size) {
    M._wasm_peek_memory(address >>> 0, size);
    const ptr = M._wasm_get_mem_buf();
    const buf = new Uint8Array(M.HEAPU8.buffer, ptr, size);
    let value = 0;
    for (let i = 0; i < size; i++) value = value * 256 + buf[i];
    return value >>> 0;
  }

  function poke(address, value, size) {
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
  const READABLE_CUSTOM_REGS = {
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

  function getDisplayRegs() {
    const count = M._wasm_read_display_regs();
    const ptr = M._wasm_get_display_regs_buf();
    const values = new Uint16Array(M.HEAPU8.buffer, ptr, count);
    const result = {};
    for (let i = 0; i < DISPLAY_REGS_ORDER.length; i++) {
      result[DISPLAY_REGS_ORDER[i]] = { value: hex(values[i], 4) };
    }
    return result;
  }

  // Reads getCustomRegsRaw()'s table-driven entries from a big-endian
  // DataView, sized 2 or 4 bytes per entry.
  function readRegTable(table, view) {
    const result = {};
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
  const CUSTOM_REGS_RAW_TABLE = (() => {
    const table = [
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
    return table.map(([name, addr, size]) => [name, 4 + addr, size]);
  })();

  function getCustomRegsRaw() {
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
  const AUDIO_REGS_TABLE = (() => {
    const table = [];
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

  function getAudioRegs() {
    const cap = M._wasm_read_audio_regs();
    const ptr = M._wasm_get_audio_regs_buf();
    const view = new DataView(M.HEAPU8.buffer, ptr, cap);
    return readRegTable(AUDIO_REGS_TABLE, view);
  }

  function getAllCustomRegisters() {
    const result = {};
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

    return {
      // This backend always boots a 512KB Kickstart 1.3 ROM directly mapped at
      // 0xF80000-0xFFFFFF on a fixed A500/OCS/512K-chip config — no boot ROM,
      // WOM, or extended ROM. Stage G4 (OpenOptions/hardware config) will
      // derive these from the actual configured machine instead.
      hasRom: true,
      hasWom: false,
      hasExt: false,
      hasBootRom: false,
      hasKickRom: true,
      womLock: false,
      romMask: hex(0x0007ffff),
      extMask: hex(0x00000000),
      chipMask: hex(0x0007ffff),
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
  function parseDisasmInstruction(raw, len) {
    const words = Math.max(Math.min(Math.floor(len / 2), 16), 5);
    return raw.slice(9 + words * 5).trim();
  }

  function disassemble(address, count) {
    const instructions = [];
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

  function setWatchpoint(address) {
    if (watchpoints.has(address)) return;
    // E9K_WATCH_OP_ADDR_COMPARE_MASK + addr_mask_operand=0xFFFFFFFF gives an
    // exact-address match (see e9k_debug_watchpointMatch).
    const index = M._wasm_add_watchpoint(
      address >>> 0,
      E9K_WATCH_OP_READ | E9K_WATCH_OP_WRITE | E9K_WATCH_OP_ADDR_COMPARE_MASK,
      0, 0, 0, 0, 0xffffffff,
    );
    if (index < 0) {
      console.warn(`[puae_rpc] setWatchpoint: no free watchpoint slots for 0x${address.toString(16)}`);
      return;
    }
    watchpoints.set(address, index);
  }

  function removeWatchpoint(address) {
    const index = watchpoints.get(address);
    if (index === undefined) return;
    M._wasm_remove_watchpoint(index);
    watchpoints.delete(address);
  }

  function handleMessage(message) {
    if (!message || !message.command) return;
    const args = message.args || {};

    const rpcRequest = (resultFn) => {
      const res = { type: "rpcResponse", id: args._rpcId };
      try {
        res.result = resultFn();
      } catch (error) {
        res.result = { error: error.message };
      }
      postMessage(res);
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
        M._wasm_resume();
        // Mirrors vAmiga_ui.js's continue path: tells the DAP adapter the
        // emulator is running again so it can send a ContinuedEvent.
        postMessage({ type: "emulator-state", state: "running" });
        break;
      case "stepInto": {
        // Mirrors index.html's Stage G1 "Step Instr" button: single-step
        // then tick until paused (or give up after a few ticks).
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
        M._wasm_eof();
        break;
      case "eol":
        console.warn("[puae_rpc] eol: not implemented (no hblank hook)");
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
        setWatchpoint(args.address >>> 0);
        break;
      case "removeWatchpoint":
        removeWatchpoint(args.address >>> 0);
        break;
      case "setCatchpoint":
      case "removeCatchpoint":
        console.warn(`[puae_rpc] ${message.command}: not implemented (exception-based stops not supported by PUAE backend)`);
        break;
      case "enableCpuLogging":
        // Not implemented; getCpuTrace always returns [].
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
        rpcRequest(() => []);
        break;
      case "stepBack":
      case "continueReverse":
        rpcRequest(() => false);
        break;
      default:
        console.warn(`[puae_rpc] unhandled command: ${message.command}`);
    }
  }

  return { handleMessage };
}
