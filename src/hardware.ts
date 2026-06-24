import { DebugProtocol } from "@vscode/debugprotocol";

// RESET             = 1,    // CPU reset exception
// BUS_ERROR         = 2,    // Bus error
// ADDRESS_ERROR     = 3,    // Address error
// ILLEGAL           = 4,    // Illegal instruction
// DIVIDE_BY_ZERO    = 5,    // Division by zero
// CHK               = 6,    // CHK instruction exception
// TRAPV             = 7,    // TRAPV instruction exception
// PRIVILEGE         = 8,    // Privilege violation
// TRACE             = 9,    // Trace exception
// LINEA             = 10,   // Line A emulator trap
// LINEF             = 11,   // Line F emulator trap
// FORMAT_ERROR      = 14,   // Stack frame format error
// IRQ_UNINITIALIZED = 15,   // Uninitialized interrupt request
// IRQ_SPURIOUS      = 24,   // Spurious interrupt
// TRAP              = 32,   // TRAP instruction exception

export const exceptionBreakpointFilters: DebugProtocol.ExceptionBreakpointsFilter[] =
  [
    // { filter: "1", label: "CPU reset", default: false },
    { filter: "2", label: "Bus error", default: true },
    { filter: "3", label: "Address error", default: true },
    { filter: "4", label: "Illegal instruction", default: true },
    { filter: "5", label: "Zero divide", default: true },
    // { filter: '6', label: 'CHK instruction', default: false },
    // { filter: '7', label: 'TRAPV instruction', default: false },
    { filter: "8", label: "Privilege violation", default: false },
    {
      filter: "memoryProtection",
      label: "Write to unallocated memory",
      default: false,
    },
  ];

// Sentinel BreakpointRef "address" for the memory protection exception
// filter (see breakpointManager.ts) — not a real 68k vector number.
export const MEMORY_PROTECTION_VECTOR = -1;

// Custom chipset register I/O range ($DFF000-$DFF1FE, mirrored across the
// rest of the $DFF000-$DFFFFF page). Used by breakpointManager.ts to tell
// apart the only two things that can ever write here — the CPU and the
// Copper — from chip RAM's CPU/Blitter/disk-DMA, which is a different
// set of possible sources entirely.
export const CUSTOM_REGISTER_RANGE = { start: 0xdff000, end: 0xdfffff };

export function isCustomRegisterAddress(address: number): boolean {
  return address >= CUSTOM_REGISTER_RANGE.start && address <= CUSTOM_REGISTER_RANGE.end;
}

// What's your vector Victor?
export const vectors = [
  "RESET_SSP",
  "RESET_PC",
  "BUS_ERROR",
  "ADR_ERROR",
  "ILLEG_OPC",
  "DIV_BY_0",
  "CHK",
  "TRAPV",
  "PRIVIL_VIO",
  "TRACE",
  "LINEA_EMU",
  "LINEF_EMU",
  null,
  null,
  null,
  "INT_UNINIT",
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  "INT_UNJUST",
  "L1",
  "L2",
  "L3",
  "L4",
  "L5",
  "L6",
  "NMI",
  "TRAP_00",
  "TRAP_01",
  "TRAP_02",
  "TRAP_03",
  "TRAP_04",
  "TRAP_05",
  "TRAP_06",
  "TRAP_07",
  "TRAP_08",
  "TRAP_09",
  "TRAP_10",
  "TRAP_11",
  "TRAP_12",
  "TRAP_13",
  "TRAP_14",
  "TRAP_15",
];

export interface CustomAddress {
  /** Present for write-only and read/write-paired registers. */
  writeAddress?: number;
  /** Present for read-only and read/write-paired registers. */
  readAddress?: number;
  long: boolean;
}

/**
 * Address(es) and length for custom registers.
 *
 * Most registers are purely write-only (control/data registers driven by
 * the CPU/Copper/DMA) or purely read-only (status/data registers) — those
 * get just `writeAddress` or `readAddress` respectively. A handful are
 * true read/write pairs at *different* physical addresses, merged into
 * one DAP variable name with the historical "R" suffix dropped (e.g.
 * DMACON's write address is $DFF096; its read counterpart, traditionally
 * called DMACONR, is $DFF002) — those get both fields.
 *
 * Strobe registers, and others where we can't display a value are commented out.
 */
export const customAddresses: Record<string, CustomAddress> = {
  BLTDDAT: { readAddress: 0xdff000, long: false }, // Blitter dest. early read (dummy address)
  DMACON: { writeAddress: 0xdff096, readAddress: 0xdff002, long: false }, // DMA control (and blitter status read)
  JOY0DAT: { readAddress: 0xdff00a, long: false }, // Joystick-mouse 0 data (vert, horiz)
  JOY1DAT: { readAddress: 0xdff00c, long: false }, // Joystick-mouse 1 data (vert, horiz)
  CLXDAT: { readAddress: 0xdff00e, long: false }, // Collision data reg. (read and clear)
  ADKCON: { writeAddress: 0xdff09e, readAddress: 0xdff010, long: false }, // Audio,disk,UART control (and read)
  POT0DAT: { readAddress: 0xdff012, long: false }, // Pot counter data left pair (vert, horiz)
  POT1DAT: { readAddress: 0xdff014, long: false }, // Pot counter data right pair (vert, horiz)
  POTINP: { readAddress: 0xdff016, long: false }, // Pot pin data read
  SERDAT: { writeAddress: 0xdff030, readAddress: 0xdff018, long: false }, // Serial port data and stop bits (write) / data and status (read)
  DSKBYT: { readAddress: 0xdff01a, long: false }, // Disk data byte and status read
  INTENA: { writeAddress: 0xdff09a, readAddress: 0xdff01c, long: false }, // Interrupt enable bits (clear or set bits, and read)
  INTREQ: { writeAddress: 0xdff09c, readAddress: 0xdff01e, long: false }, // Interrupt request bits (clear or set bits, and read)
  DSKPT: { writeAddress: 0xdff020, long: true }, // Disk pointer
  DSKLEN: { writeAddress: 0xdff024, long: false }, // Disk length
  DSKDAT: { writeAddress: 0xdff026, long: false }, // Disk DMA data write
  REFPTR: { writeAddress: 0xdff028, long: true }, // Internal hardware refresh pointer, no stored value
  VPOS: { writeAddress: 0xdff02a, long: false }, // Write vert most sig. bits (and frame flop)
  VHPOS: { writeAddress: 0xdff02c, long: false }, // Write vert and horiz pos of beam
  COPCON: { writeAddress: 0xdff02e, long: false }, // Coprocessor control
  SERPER: { writeAddress: 0xdff032, long: false }, // Serial port period and control
  POTGO: { writeAddress: 0xdff034, long: false }, // Pot count start,pot pin drive enable data
  JOYTEST: { writeAddress: 0xdff036, long: false }, // Write-only
  STREQU: { writeAddress: 0xdff038, long: false }, // Strobe for horiz sync with VB and EQU
  STRVBL: { writeAddress: 0xdff03a, long: false }, // Strobe for horiz sync with VB (vert blank)
  STRHOR: { writeAddress: 0xdff03c, long: false }, // Strobe for horiz sync
  // STRLONG: { writeAddress: 0xdff03e, long: false }, // Strobe for identification of long horiz line — no real handler in PUAE (falls through to default)
  BLTCON0: { writeAddress: 0xdff040, long: false }, // Blitter control register 0
  BLTCON1: { writeAddress: 0xdff042, long: false }, // Blitter control register 1
  BLTAFWM: { writeAddress: 0xdff044, long: false }, // Blitter first word mask for source A
  BLTALWM: { writeAddress: 0xdff046, long: false }, // Blitter last word mask for source A
  BLTCPT: { writeAddress: 0xdff048, long: true }, // Blitter pointer to source C
  BLTBPT: { writeAddress: 0xdff04c, long: true }, // Blitter pointer to source B
  BLTAPT: { writeAddress: 0xdff050, long: true }, // Blitter pointer to source A
  BLTDPT: { writeAddress: 0xdff054, long: true }, // Blitter pointer to dest D
  BLTSIZE: { writeAddress: 0xdff058, long: false }, // Blitter start and size (win/width,height)
  BLTCON0L: { writeAddress: 0xdff05a, long: false }, // control 0, lower 8 bits (minterms)
  BLTSIZV: { writeAddress: 0xdff05c, long: false }, // V size (for 15 bit vertical size)
  BLTSIZH: { writeAddress: 0xdff05e, long: false }, // H size and start (for 11 bit H size)
  BLTCMOD: { writeAddress: 0xdff060, long: false }, // Blitter modulo for source C
  BLTBMOD: { writeAddress: 0xdff062, long: false }, // Blitter modulo for source B
  BLTAMOD: { writeAddress: 0xdff064, long: false }, // Blitter modulo for source A
  BLTDMOD: { writeAddress: 0xdff066, long: false }, // Blitter modulo for dest D
  BLTCDAT: { writeAddress: 0xdff070, long: false }, // Blitter source C data register
  BLTBDAT: { writeAddress: 0xdff072, long: false }, // Blitter source B data register
  BLTADAT: { writeAddress: 0xdff074, long: false }, // Blitter source A data register
  // SPRHDAT: { readAddress: 0xdff078, long: true }, // UHRES: no real handler in PUAE either
  // BPLHDAT: { writeAddress: 0xdff07a, long: false }, // UHRES: no real handler in PUAE either
  DENISEID: { readAddress: 0xdff07c, long: false }, // revision level for Denise/Lisa (video out chip)
  DSKSYNC: { writeAddress: 0xdff07e, long: false }, // Disk sync pattern reg for disk read
  COP1LC: { writeAddress: 0xdff080, long: true }, // Coprocessor 1st location
  COP2LC: { writeAddress: 0xdff084, long: true }, // Coprocessor 2nd locatio
  COPJMP1: { writeAddress: 0xdff088, long: false }, // Coprocessor restart at 1st location
  COPJMP2: { writeAddress: 0xdff08a, long: false }, // Coprocessor restart at 2nd location
  // COPINS: { writeAddress: 0xdff08c, long: false }, // Write-only, no real handler in PUAE (falls through to default)
  DIWSTRT: { writeAddress: 0xdff08e, long: false }, // Display window start (upper left vert,horiz pos)
  DIWSTOP: { writeAddress: 0xdff090, long: false }, // Display window stop (lower right vert,horiz pos)
  DDFSTRT: { writeAddress: 0xdff092, long: false }, // Display bit plane data fetch start,horiz pos
  DDFSTOP: { writeAddress: 0xdff094, long: false }, // Display bit plane data fetch stop,horiz pos
  CLXCON: { writeAddress: 0xdff098, long: false }, // Collision control
  AUD0LC: { writeAddress: 0xdff0a0, long: true }, // Audio channel 0 location
  AUD0LEN: { writeAddress: 0xdff0a4, long: false }, // Audio channel 0 length
  AUD0PER: { writeAddress: 0xdff0a6, long: false }, // Audio channel 0 period
  AUD0VOL: { writeAddress: 0xdff0a8, long: false }, // Audio channel 0 volume
  AUD0DAT: { writeAddress: 0xdff0aa, long: false }, // Audio channel 0 data
  AUD1LC: { writeAddress: 0xdff0b0, long: true }, // Audio channel 1 location
  AUD1LEN: { writeAddress: 0xdff0b4, long: false }, // Audio channel 1 length
  AUD1PER: { writeAddress: 0xdff0b6, long: false }, // Audio channel 1 period
  AUD1VOL: { writeAddress: 0xdff0b8, long: false }, // Audio channel 1 volume
  AUD1DAT: { writeAddress: 0xdff0ba, long: false }, // Audio channel 1 data
  AUD2LC: { writeAddress: 0xdff0c0, long: true }, // Audio channel 2 location
  AUD2LEN: { writeAddress: 0xdff0c4, long: false }, // Audio channel 2 length
  AUD2PER: { writeAddress: 0xdff0c6, long: false }, // Audio channel 2 period
  AUD2VOL: { writeAddress: 0xdff0c8, long: false }, // Audio channel 2 volume
  AUD2DAT: { writeAddress: 0xdff0ca, long: false }, // Audio channel 2 data
  AUD3LC: { writeAddress: 0xdff0d0, long: true }, // Audio channel 3 location
  AUD3LEN: { writeAddress: 0xdff0d4, long: false }, // Audio channel 3 length
  AUD3PER: { writeAddress: 0xdff0d6, long: false }, // Audio channel 3 period
  AUD3VOL: { writeAddress: 0xdff0d8, long: false }, // Audio channel 3 volume
  AUD3DAT: { writeAddress: 0xdff0da, long: false }, // Audio channel 3 data
  BPL1PT: { writeAddress: 0xdff0e0, long: true }, // Bitplane pointer 1
  BPL2PT: { writeAddress: 0xdff0e4, long: true }, // Bitplane pointer 2
  BPL3PT: { writeAddress: 0xdff0e8, long: true }, // Bitplane pointer 3
  BPL4PT: { writeAddress: 0xdff0ec, long: true }, // Bitplane pointer 4
  BPL5PT: { writeAddress: 0xdff0f0, long: true }, // Bitplane pointer 5
  BPL6PT: { writeAddress: 0xdff0f4, long: true }, // Bitplane pointer 6
  BPL7PT: { writeAddress: 0xdff0f8, long: true }, // 7th bitplane pointer (real PUAE handler, unconditional — comment about vAmiga/AGA is about display, not this address existing)
  BPL8PT: { writeAddress: 0xdff0fc, long: true }, // 8th bitplane pointer
  BPLCON0: { writeAddress: 0xdff100, long: false }, // Bitplane control (miscellaneous control bits)
  BPLCON1: { writeAddress: 0xdff102, long: false }, // Bitplane control (scroll value)
  BPLCON2: { writeAddress: 0xdff104, long: false }, // Bitplane control (video priority control)
  BPLCON3: { writeAddress: 0xdff106, long: false }, // Bitplane control (enhanced features)
  BPL1MOD: { writeAddress: 0xdff108, long: false }, // Bitplane modulo (odd planes)
  BPL2MOD: { writeAddress: 0xdff10a, long: false }, // Bitplane modulo (even planes)
  // BPLCON4: { writeAddress: 0xdff10c, long: false }, // AGA only — genuinely #ifdef AGA-gated in PUAE, and this build doesn't define AGA
  // CLXCON2: { writeAddress: 0xdff10e, long: false }, // Also #ifdef AGA-gated in PUAE, same as BPLCON4
  BPL1DAT: { writeAddress: 0xdff110, long: false }, // Bitplane 1 data (parallel to serial convert)
  BPL2DAT: { writeAddress: 0xdff112, long: false }, // Bitplane 2 data (parallel to serial convert)
  BPL3DAT: { writeAddress: 0xdff114, long: false }, // Bitplane 3 data (parallel to serial convert)
  BPL4DAT: { writeAddress: 0xdff116, long: false }, // Bitplane 4 data (parallel to serial convert)
  BPL5DAT: { writeAddress: 0xdff118, long: false }, // Bitplane 5 data (parallel to serial convert)
  BPL6DAT: { writeAddress: 0xdff11a, long: false }, // Bitplane 6 data (parallel to serial convert)
  BPL7DAT: { writeAddress: 0xdff11c, long: false }, // 7th bitplane data (real PUAE handler, unconditional)
  BPL8DAT: { writeAddress: 0xdff11e, long: false }, // 8th bitplane data
  SPR0PT: { writeAddress: 0xdff120, long: true }, // Sprite 0 pointer
  SPR1PT: { writeAddress: 0xdff124, long: true }, // Sprite 1 pointer
  SPR2PT: { writeAddress: 0xdff128, long: true }, // Sprite 2 pointer
  SPR3PT: { writeAddress: 0xdff12c, long: true }, // Sprite 3 pointer
  SPR4PT: { writeAddress: 0xdff130, long: true }, // Sprite 4 pointer
  SPR5PT: { writeAddress: 0xdff134, long: true }, // Sprite 5 pointer
  SPR6PT: { writeAddress: 0xdff138, long: true }, // Sprite 6 pointer
  SPR7PT: { writeAddress: 0xdff13c, long: true }, // Sprite 7 pointer
  SPR0POS: { writeAddress: 0xdff140, long: false }, // Sprite 0 vert,horiz start pos data
  SPR0CTL: { writeAddress: 0xdff142, long: false }, // Sprite 0 position and control data
  SPR0DATA: { writeAddress: 0xdff144, long: false }, // Sprite 0 image data register A
  SPR0DATB: { writeAddress: 0xdff146, long: false }, // Sprite 0 image data register B
  SPR1POS: { writeAddress: 0xdff148, long: false }, // Sprite 1 vert,horiz start pos data
  SPR1CTL: { writeAddress: 0xdff14a, long: false }, // Sprite 1 position and control data
  SPR1DATA: { writeAddress: 0xdff14c, long: false }, // Sprite 1 image data register A
  SPR1DATB: { writeAddress: 0xdff14e, long: false }, // Sprite 1 image data register B
  SPR2POS: { writeAddress: 0xdff150, long: false }, // Sprite 2 vert,horiz start pos data
  SPR2CTL: { writeAddress: 0xdff152, long: false }, // Sprite 2 position and control data
  SPR2DATA: { writeAddress: 0xdff154, long: false }, // Sprite 2 image data register A
  SPR2DATB: { writeAddress: 0xdff156, long: false }, // Sprite 2 image data register B
  SPR3POS: { writeAddress: 0xdff158, long: false }, // Sprite 3 vert,horiz start pos data
  SPR3CTL: { writeAddress: 0xdff15a, long: false }, // Sprite 3 position and control data
  SPR3DATA: { writeAddress: 0xdff15c, long: false }, // Sprite 3 image data register A
  SPR3DATB: { writeAddress: 0xdff15e, long: false }, // Sprite 3 image data register B
  SPR4POS: { writeAddress: 0xdff160, long: false }, // Sprite 4 vert,horiz start pos data
  SPR4CTL: { writeAddress: 0xdff162, long: false }, // Sprite 4 position and control data
  SPR4DATA: { writeAddress: 0xdff164, long: false }, // Sprite 4 image data register A
  SPR4DATB: { writeAddress: 0xdff166, long: false }, // Sprite 4 image data register B
  SPR5POS: { writeAddress: 0xdff168, long: false }, // Sprite 5 vert,horiz start pos data
  SPR5CTL: { writeAddress: 0xdff16a, long: false }, // Sprite 5 position and control data
  SPR5DATA: { writeAddress: 0xdff16c, long: false }, // Sprite 5 image data register A
  SPR5DATB: { writeAddress: 0xdff16e, long: false }, // Sprite 5 image data register B
  SPR6POS: { writeAddress: 0xdff170, long: false }, // Sprite 6 vert,horiz start pos data
  SPR6CTL: { writeAddress: 0xdff172, long: false }, // Sprite 6 position and control data
  SPR6DATA: { writeAddress: 0xdff174, long: false }, // Sprite 6 image data register A
  SPR6DATB: { writeAddress: 0xdff176, long: false }, // Sprite 6 image data register B
  SPR7POS: { writeAddress: 0xdff178, long: false }, // Sprite 7 vert,horiz start pos data
  SPR7CTL: { writeAddress: 0xdff17a, long: false }, // Sprite 7 position and control data
  SPR7DATA: { writeAddress: 0xdff17c, long: false }, // Sprite 7 image data register A
  SPR7DATB: { writeAddress: 0xdff17e, long: false }, // Sprite 7 image data register B
  COLOR00: { writeAddress: 0xdff180, long: false }, // Color table 0
  COLOR01: { writeAddress: 0xdff182, long: false }, // Color table 1
  COLOR02: { writeAddress: 0xdff184, long: false }, // Color table 2
  COLOR03: { writeAddress: 0xdff186, long: false }, // Color table 3
  COLOR04: { writeAddress: 0xdff188, long: false }, // Color table 4
  COLOR05: { writeAddress: 0xdff18a, long: false }, // Color table 5
  COLOR06: { writeAddress: 0xdff18c, long: false }, // Color table 6
  COLOR07: { writeAddress: 0xdff18e, long: false }, // Color table 7
  COLOR08: { writeAddress: 0xdff190, long: false }, // Color table 8
  COLOR09: { writeAddress: 0xdff192, long: false }, // Color table 9
  COLOR10: { writeAddress: 0xdff194, long: false }, // Color table 10
  COLOR11: { writeAddress: 0xdff196, long: false }, // Color table 11
  COLOR12: { writeAddress: 0xdff198, long: false }, // Color table 12
  COLOR13: { writeAddress: 0xdff19a, long: false }, // Color table 13
  COLOR14: { writeAddress: 0xdff19c, long: false }, // Color table 14
  COLOR15: { writeAddress: 0xdff19e, long: false }, // Color table 15
  COLOR16: { writeAddress: 0xdff1a0, long: false }, // Color table 16
  COLOR17: { writeAddress: 0xdff1a2, long: false }, // Color table 17
  COLOR18: { writeAddress: 0xdff1a4, long: false }, // Color table 18
  COLOR19: { writeAddress: 0xdff1a6, long: false }, // Color table 19
  COLOR20: { writeAddress: 0xdff1a8, long: false }, // Color table 20
  COLOR21: { writeAddress: 0xdff1aa, long: false }, // Color table 21
  COLOR22: { writeAddress: 0xdff1ac, long: false }, // Color table 22
  COLOR23: { writeAddress: 0xdff1ae, long: false }, // Color table 23
  COLOR24: { writeAddress: 0xdff1b0, long: false }, // Color table 24
  COLOR25: { writeAddress: 0xdff1b2, long: false }, // Color table 25
  COLOR26: { writeAddress: 0xdff1b4, long: false }, // Color table 26
  COLOR27: { writeAddress: 0xdff1b6, long: false }, // Color table 27
  COLOR28: { writeAddress: 0xdff1b8, long: false }, // Color table 28
  COLOR29: { writeAddress: 0xdff1ba, long: false }, // Color table 29
  COLOR30: { writeAddress: 0xdff1bc, long: false }, // Color table 30
  COLOR31: { writeAddress: 0xdff1be, long: false }, // Color table 31
  // ECS registers below: "no handler in vAmiga" is about that backend's
  // value-tracking for display, not about PUAE — PUAE has real,
  // unconditional handlers for all of these, confirmed by reading
  // custom_wput_1's switch, so they're restored as watchpoint targets.
  HTOTAL: { writeAddress: 0xdff1c0, long: false }, // ECS: no handler in vAmiga
  HSSTOP: { writeAddress: 0xdff1c2, long: false }, // ECS: no handler in vAmiga
  HBSTRT: { writeAddress: 0xdff1c4, long: false }, // ECS: no handler in vAmiga
  HBSTOP: { writeAddress: 0xdff1c6, long: false }, // ECS: no handler in vAmiga
  VTOTAL: { writeAddress: 0xdff1c8, long: false }, // ECS: no handler in vAmiga
  VSSTOP: { writeAddress: 0xdff1ca, long: false }, // ECS: no handler in vAmiga
  VBSTRT: { writeAddress: 0xdff1cc, long: false }, // ECS: no handler in vAmiga
  VBSTOP: { writeAddress: 0xdff1ce, long: false }, // ECS: no handler in vAmiga
  SPRHSTRT: { writeAddress: 0xdff1d0, long: false }, // UHRES: not implemented in vAmiga, but real PUAE handler
  SPRHSTOP: { writeAddress: 0xdff1d2, long: false }, // UHRES: not implemented in vAmiga, but real PUAE handler
  BPLHSTRT: { writeAddress: 0xdff1d4, long: false }, // UHRES: not implemented in vAmiga, but real PUAE handler
  BPLHSTOP: { writeAddress: 0xdff1d6, long: false }, // UHRES: not implemented in vAmiga, but real PUAE handler
  HHPOS: { writeAddress: 0xdff1d8, readAddress: 0xdff1da, long: false }, // ECS, write + read side (HHPOSR)
  BEAMCON0: { writeAddress: 0xdff1dc, long: false }, // ECS: handler doesn't store raw value for display, but real write effect exists
  HSSTRT: { writeAddress: 0xdff1de, long: false }, // ECS: no handler in vAmiga
  VSSTRT: { writeAddress: 0xdff1e0, long: false }, // ECS: no handler in vAmiga
  HCENTER: { writeAddress: 0xdff1e2, long: false }, // ECS: no handler in vAmiga
  DIWHIGH: { writeAddress: 0xdff1e4, long: false }, // window - upper bits for start/stop
  // BPLHMOD: { writeAddress: 0xdff1e6, long: false }, // UHRES: no real handler in PUAE either
  // SPRHPT: { writeAddress: 0xdff1e8, long: true }, // UHRES: no real handler in PUAE either
  // BPLHPT: { writeAddress: 0xdff1ec, long: true }, // UHRES: no real handler in PUAE either
  FMODE: { writeAddress: 0xdff1fc, long: false }, // Not actually AGA-#ifdef-gated in PUAE despite the name
};
