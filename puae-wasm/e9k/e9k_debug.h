#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "uae/types.h"
#include "e9k-lib.h"

// Debug base register sections (passed to e9k_debug_set_debug_base_callback()).
#define E9K_DEBUG_BASE_SECTION_TEXT 0u
#define E9K_DEBUG_BASE_SECTION_DATA 1u
#define E9K_DEBUG_BASE_SECTION_BSS  2u

int
e9k_debug_instructionHook(uaecptr pc, uae_u16 opcode);

void
e9k_debug_pause(void);

void
e9k_debug_resume(void);

int
e9k_debug_is_paused(void);

void
e9k_debug_step_instr(void);

void
e9k_debug_step_line(void);

void
e9k_debug_step_next(void);

void
e9k_debug_step_out(void);

size_t
e9k_debug_read_callstack(uint32_t *out, size_t cap);

// Reads up to `cap` registers into `out`: 0-15 = D0-D7/A0-A7 (regs.regs[i]),
// 16 = SR, 17 = PC, 18 = USP (regs.usp shadow if in supervisor mode, else
// live A7).
size_t
e9k_debug_read_regs(uint32_t *out, size_t cap);

// Writes a single register. regnum 0-15 = D0-D7/A0-A7 (regs.regs[i]),
// 16 = SR (applies MakeFromSR() side effects), 17 = PC (m68k_setpc()),
// 18 = USP (regs.usp shadow if in supervisor mode, else live A7).
// Returns 0 on success, -1 for an out-of-range regnum. Other CpuInfo
// fields (ISP/MSP/VBR/etc.) are not addressable here, mirroring the
// gap in e9k_debug_read_regs().
int
e9k_debug_write_reg(uint32_t regnum, uint32_t value);

size_t
e9k_debug_read_memory(uint32_t addr, uint8_t *out, size_t cap);

int
e9k_debug_write_memory(uint32_t addr, uint32_t value, size_t size);

// Bulk write of an arbitrary-length buffer, watchpoint/protect-suspended
// like e9k_debug_write_memory. Used for loading program data.
size_t
e9k_debug_write_memory_buf(uint32_t addr, const uint8_t *data, size_t len);

// Classifies each of the 256 64KB banks of the 24-bit address space
// (mem_banks[0..255]) into a byte using the same numeric values as
// src/vAmiga.ts's MemSrc enum (0=NONE, 1=CHIP, 2=CHIP_MIRROR, 3=SLOW,
// 4=SLOW_MIRROR, 5=FAST, 6=CIA, 7=CIA_MIRROR, 9=CUSTOM, 10=CUSTOM_MIRROR,
// 13=ROM, 14=ROM_MIRROR, 16=EXT). RTC/AUTOCONF/ZOR/WOM (8/11/12/15) are
// not currently detected and report as NONE. Returns the number of bytes
// written (min(cap, 256)).
size_t
e9k_debug_read_memory_map(uint8_t *out, size_t cap);

// Like read/write_memory, but go through the normal CPU-visible accessors
// without suspending watchpoint/protect checks (see e9k_debug.c for why).
int
e9k_debug_poke_memory(uint32_t addr, uint32_t value, size_t size);

size_t
e9k_debug_peek_memory(uint32_t addr, uint8_t *out, size_t cap);

size_t
e9k_debug_disassemble_quick(uint32_t pc, char *out, size_t cap);

uint64_t
e9k_debug_read_cycle_count(void);

void
e9k_debug_add_breakpoint(uint32_t addr);

void
e9k_debug_remove_breakpoint(uint32_t addr);

void
e9k_debug_add_temp_breakpoint(uint32_t addr);

void
e9k_debug_remove_temp_breakpoint(uint32_t addr);

// Optional host callback invoked once per vblank/frame.
void
e9k_debug_set_vblank_callback(void (*cb)(void *), void *user);

void
e9k_vblank_notify(void);

void
e9k_debug_reapply_memhooks(void);

// Memory-access hooks called from the chip-RAM bank accessors (see
// libretro-uae.patch's memory.c changes) to drive watchpoints/protects.
void
e9k_debug_memhook_afterRead(uint32_t addr24, uint32_t value, uint32_t sizeBits);

int
e9k_debug_memhook_filterWrite(uint32_t addr24, uint32_t sizeBits, uint32_t oldValue, int oldValueValid, uint32_t *inoutValue);

void
e9k_debug_memhook_afterWrite(uint32_t addr24, uint32_t value, uint32_t oldValue, uint32_t sizeBits, int oldValueValid);

// Optional host callback invoked when the target writes a new relocatable base.
void
e9k_debug_set_debug_base_callback(void (*cb)(uint32_t section, uint32_t base));

// Optional host callback invoked when the target requests a breakpoint via a fake debug peripheral.
void
e9k_debug_set_debug_breakpoint_callback(void (*cb)(uint32_t addr));

// Optional host callback used for source location resolution in cores that support source-line stepping.
void
e9k_debug_set_source_location_resolver(int (*resolver)(uint32_t pc24, uint64_t *out_location, void *user), void *user);

void
e9k_debug_set_debug_option(e9k_debug_option_t option, uint32_t argument, void *user);
