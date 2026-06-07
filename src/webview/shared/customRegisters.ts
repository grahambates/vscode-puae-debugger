// Amiga custom-register offset → name table, shared across webviews (copper
// disassembler, DMA profiler tooltip, …). Offsets are relative to 0xDFF000 and even.
// Consolidated here so there's one canonical table instead of per-view copies.

export const CUSTOM_REGISTER_NAMES: Readonly<Record<number, string>> = {
  0x02: "DMACONR", 0x04: "VPOSR", 0x06: "VHPOSR", 0x08: "DSKDATR",
  0x0a: "JOY0DAT", 0x0c: "JOY1DAT", 0x0e: "CLXDAT", 0x10: "ADKCONR",
  0x12: "POT0DAT", 0x14: "POT1DAT", 0x16: "POTGOR", 0x18: "SERDATR",
  0x1a: "DSKBYTR", 0x1c: "INTENAR", 0x1e: "INTREQR", 0x20: "DSKPTH",
  0x22: "DSKPTL", 0x24: "DSKLEN", 0x26: "DSKDAT", 0x28: "REFPTR",
  0x2a: "VPOSW", 0x2c: "VHPOSW", 0x2e: "COPCON", 0x30: "SERDAT",
  0x32: "SERPER", 0x34: "POTGO", 0x36: "JOYTEST", 0x38: "STREQU",
  0x3a: "STRVBL", 0x3c: "STRHOR", 0x3e: "STRLONG", 0x40: "BLTCON0",
  0x42: "BLTCON1", 0x44: "BLTAFWM", 0x46: "BLTALWM", 0x48: "BLTCPTH",
  0x4a: "BLTCPTL", 0x4c: "BLTBPTH", 0x4e: "BLTBPTL", 0x50: "BLTAPTH",
  0x52: "BLTAPTL", 0x54: "BLTDPTH", 0x56: "BLTDPTL", 0x58: "BLTSIZE",
  0x5a: "BLTCON0L", 0x5c: "BLTSIZV", 0x5e: "BLTSIZH", 0x60: "BLTCMOD",
  0x62: "BLTBMOD", 0x64: "BLTAMOD", 0x66: "BLTDMOD", 0x70: "BLTCDAT",
  0x72: "BLTBDAT", 0x74: "BLTADAT", 0x76: "SPRHDAT", 0x78: "BPLHDAT",
  0x7a: "LISAID", 0x7c: "DSKSYNC", 0x7e: "COP1LCH", 0x80: "COP1LCL",
  0x82: "COP2LCH", 0x84: "COP2LCL", 0x86: "COPJMP1", 0x88: "COPJMP2",
  0x8a: "COPINS", 0x8c: "DIWSTRT", 0x8e: "DIWSTOP", 0x90: "DDFSTRT",
  0x92: "DDFSTOP", 0x94: "DMACON", 0x96: "CLXCON", 0x98: "INTENA",
  0x9a: "INTREQ", 0x9c: "ADKCON", 0xa0: "AUD0LCH", 0xa2: "AUD0LCL",
  0xa4: "AUD0LEN", 0xa6: "AUD0PER", 0xa8: "AUD0VOL", 0xaa: "AUD0DAT",
  0xb0: "AUD1LCH", 0xb2: "AUD1LCL", 0xb4: "AUD1LEN", 0xb6: "AUD1PER",
  0xb8: "AUD1VOL", 0xba: "AUD1DAT", 0xc0: "AUD2LCH", 0xc2: "AUD2LCL",
  0xc4: "AUD2LEN", 0xc6: "AUD2PER", 0xc8: "AUD2VOL", 0xca: "AUD2DAT",
  0xd0: "AUD3LCH", 0xd2: "AUD3LCL", 0xd4: "AUD3LEN", 0xd6: "AUD3PER",
  0xd8: "AUD3VOL", 0xda: "AUD3DAT", 0xe0: "BPL1PTH", 0xe2: "BPL1PTL",
  0xe4: "BPL2PTH", 0xe6: "BPL2PTL", 0xe8: "BPL3PTH", 0xea: "BPL3PTL",
  0xec: "BPL4PTH", 0xee: "BPL4PTL", 0xf0: "BPL5PTH", 0xf2: "BPL5PTL",
  0xf4: "BPL6PTH", 0xf6: "BPL6PTL", 0xf8: "BPL7PTH", 0xfa: "BPL7PTL",
  0xfc: "BPL8PTH", 0xfe: "BPL8PTL", 0x100: "BPLCON0", 0x102: "BPLCON1",
  0x104: "BPLCON2", 0x106: "BPLCON3", 0x108: "BPL1MOD", 0x10a: "BPL2MOD",
  0x10c: "BPLCON4", 0x10e: "CLXCON2", 0x110: "BPL1DAT", 0x112: "BPL2DAT",
  0x114: "BPL3DAT", 0x116: "BPL4DAT", 0x118: "BPL5DAT", 0x11a: "BPL6DAT",
  0x11c: "BPL7DAT", 0x11e: "BPL8DAT", 0x120: "SPR0PTH", 0x122: "SPR0PTL",
  0x124: "SPR1PTH", 0x126: "SPR1PTL", 0x128: "SPR2PTH", 0x12a: "SPR2PTL",
  0x12c: "SPR3PTH", 0x12e: "SPR3PTL", 0x130: "SPR4PTH", 0x132: "SPR4PTL",
  0x134: "SPR5PTH", 0x136: "SPR5PTL", 0x138: "SPR6PTH", 0x13a: "SPR6PTL",
  0x13c: "SPR7PTH", 0x13e: "SPR7PTL", 0x180: "COLOR00", 0x182: "COLOR01",
  0x184: "COLOR02", 0x186: "COLOR03", 0x188: "COLOR04", 0x18a: "COLOR05",
  0x18c: "COLOR06", 0x18e: "COLOR07", 0x190: "COLOR08", 0x192: "COLOR09",
  0x194: "COLOR10", 0x196: "COLOR11", 0x198: "COLOR12", 0x19a: "COLOR13",
  0x19c: "COLOR14", 0x19e: "COLOR15", 0x1a0: "COLOR16", 0x1a2: "COLOR17",
  0x1a4: "COLOR18", 0x1a6: "COLOR19", 0x1a8: "COLOR20", 0x1aa: "COLOR21",
  0x1ac: "COLOR22", 0x1ae: "COLOR23", 0x1b0: "COLOR24", 0x1b2: "COLOR25",
  0x1b4: "COLOR26", 0x1b6: "COLOR27", 0x1b8: "COLOR28", 0x1ba: "COLOR29",
  0x1bc: "COLOR30", 0x1be: "COLOR31",
};

// Register name for a custom-register offset (0x000-0x1FE), or undefined if unknown.
export function customRegisterName(offset: number): string | undefined {
  return CUSTOM_REGISTER_NAMES[offset & 0x1fe];
}

// Register name with a hex fallback for unknown offsets.
export function customRegisterLabel(offset: number): string {
  return customRegisterName(offset) ?? `CUSTOM+$${(offset & 0x1fe).toString(16).toUpperCase()}`;
}
