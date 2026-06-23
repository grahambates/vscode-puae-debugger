#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "uae/types.h"
#include "e9k-lib.h"

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

// Display-control register state that is write-only on the 68k bus
// (BPLCON0-3, DIWSTRT/STOP, DDFSTRT/STOP, COLOR00-31 all read back the
// floating data bus on real hardware) but is needed for the debugger's
// Amiga State view. Order: BPLCON0, BPLCON1, BPLCON2, BPLCON3, DIWSTRT,
// DIWSTOP, DDFSTRT, DDFSTOP, COLOR00..COLOR31 (raw 12-bit 0x0RGB values).
// Returns E9K_DISPLAY_REG_COUNT on success, 0 if cap is too small.
#define E9K_DISPLAY_REG_COUNT 40
size_t
e9k_debug_read_display_regs(uint16_t *out, size_t cap);

// Raw $DFF000-$DFF1FE custom-register image, for write-only registers not
// covered by e9k_debug_read_display_regs above (blitter/copper/disk
// pointers, bitplane/sprite pointers & data, display timing, etc). This is
// PUAE's savestate-format dump (save_custom(), full=1): a 4-byte
// chipset_mask header, then 256 big-endian uae_u16 words at byte offset
// 4+(addr & 0x1fe) for each custom register addr in $DFF000..$DFF1FE
// (32-bit registers like BLTCPT/COP1LC/BPLnPT/SPRnPT are written as a
// single big-endian uae_u32 at the offset of their high/first word), then a
// trailing 4-byte refptr (not a real register, ignore).
//
// CAVEAT: bytes at offset 4+0xA0 .. 4+0xDE (64 bytes, where AUD0-3's
// LC/LEN/PER/VOL/DAT would be) are zero filler written by save_custom's
// full-mode padding loop, NOT live audio state. Use
// e9k_debug_read_audio_regs for AUD0-3.
//
// Returns E9K_CUSTOM_REGS_RAW_SIZE on success, 0 if cap is too small.
#define E9K_CUSTOM_REGS_RAW_SIZE (8 + 256 * 2)
size_t
e9k_debug_read_custom_regs_raw(uint8_t *out, size_t cap);

// AUD0-3 LC/LEN/PER/VOL/DAT "live register" values (write-only on the 68k
// bus, not part of save_custom()'s output - see caveat above). Packed
// big-endian per channel as LC(4) LEN(2) PER(2) VOL(2) DAT(2) = 12 bytes,
// for 4 channels = E9K_AUDIO_REGS_SIZE bytes total.
//
// Returns E9K_AUDIO_REGS_SIZE on success, 0 if cap is too small.
#define E9K_AUDIO_REGS_SIZE (4 * 12)
size_t
e9k_debug_read_audio_regs(uint8_t *out, size_t cap);

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

// Optional host callback invoked once per scanline (hsync), after all
// per-line state updates for that line. Used to implement "run to end of
// line" (eol) stepping.
void
e9k_debug_set_hblank_callback(void (*cb)(void *), void *user);

void
e9k_hsync_notify(void);

// Memory-access hooks called from the chip-RAM bank accessors (see
// libretro-uae.patch's memory.c changes) to drive watchpoints/protects.
void
e9k_debug_memhook_afterRead(uint32_t addr24, uint32_t value, uint32_t sizeBits);

int
e9k_debug_memhook_filterWrite(uint32_t addr24, uint32_t sizeBits, uint32_t oldValue, int oldValueValid, uint32_t *inoutValue);

// `source` is E9K_MEMPROTECT_SOURCE_CPU/_DMA (e9k-lib.h) — which actually
// performed the write, the 68k CPU or a DMA-driven unit (Blitter, disk
// DMA). Callers outside the e9k module (e.g. memory.c) pass the literal
// 0/1 directly rather than including e9k-lib.h, to keep libretro-uae core
// files decoupled from the debug module's headers.
void
e9k_debug_memhook_afterWrite(uint32_t addr24, uint32_t value, uint32_t oldValue, uint32_t sizeBits, int oldValueValid, uint32_t source);
