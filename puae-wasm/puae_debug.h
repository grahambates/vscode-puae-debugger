#pragma once

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "uae/types.h"

#define PUAE_CHECKPOINT_COUNT 64

typedef struct puae_debug_checkpoint {
    uint64_t current;
    uint64_t accumulator;
    uint64_t count;
    uint64_t average;
    uint64_t minimum;
    uint64_t maximum;
} puae_debug_checkpoint_t;


#define PUAE_WATCHPOINT_COUNT 64

// Watchpoint operation bits.
// These can be combined; operands are stored separately per watchpoint.
#define PUAE_WATCH_OP_READ                 (1u << 0) // (1) Read
#define PUAE_WATCH_OP_WRITE                (1u << 1) // (2) Write
#define PUAE_WATCH_OP_VALUE_NEQ_OLD        (1u << 2) // (3) Value != existing value (write-only)
#define PUAE_WATCH_OP_VALUE_EQ             (1u << 3) // (4) Value == operand
#define PUAE_WATCH_OP_OLD_VALUE_EQ         (1u << 4) // (5) Existing value == operand
#define PUAE_WATCH_OP_ACCESS_SIZE          (1u << 5) // (6) Access size (operand: 8/16/32 bits)
#define PUAE_WATCH_OP_ADDR_COMPARE_MASK    (1u << 6) // (7) Address compare mask (operand: mask)

// Access kind for watchbreak reporting.
#define PUAE_WATCH_ACCESS_READ             1u
#define PUAE_WATCH_ACCESS_WRITE            2u

typedef struct puae_debug_watchpoint
{
    uint32_t addr;
    uint32_t op_mask;
    uint32_t diff_operand;      // (3) operand value
    uint32_t value_operand;     // (4) operand value
    uint32_t old_value_operand; // (5) operand value
    uint32_t size_operand;      // (6) operand size, 8/16/32 (bits)
    uint32_t addr_mask_operand; // (7) operand mask, 0 => always match
} puae_debug_watchpoint_t;

typedef struct puae_debug_watchbreak
{
    uint32_t index;             // 0..PUAE_WATCHPOINT_COUNT-1

    // Snapshot of the triggering watchpoint.
    uint32_t watch_addr;
    uint32_t op_mask;
    uint32_t diff_operand;
    uint32_t value_operand;
    uint32_t old_value_operand;
    uint32_t size_operand;      // 8/16/32 (bits)
    uint32_t addr_mask_operand;

    // Access details.
    uint32_t access_addr;       // address used for the access (base)
    uint32_t access_kind;       // PUAE_WATCH_ACCESS_*
    uint32_t access_size;       // 8/16/32 (bits)
    uint32_t value;             // value read/written (size-truncated)
    uint32_t old_value;         // existing value (if known; for reads, equals value)
    uint32_t old_value_valid;   // 1 if old_value is valid
    uint32_t source;            // PUAE_MEMPROTECT_SOURCE_CPU/_DMA (defined below)
    uint32_t cpu_pc;            // m68k_getpc() at the moment of the hit — for a DMA/Copper-
                                 // sourced access this is whatever the CPU happens to be running
                                 // concurrently, unrelated to what configured the access (which
                                 // ran earlier, asynchronously) — same caveat as memprotect's pc.
    uint32_t copper_pc;         // cop_state.ip (the Copper's own list pointer) at the moment of
                                 // the hit. Only meaningful when copper_pc_valid is set — unlike
                                 // cpu_pc, this *is* the address of the instruction that actually
                                 // caused a Copper-sourced custom-register write.
    uint32_t copper_pc_valid;   // 1 if this access was a custom-register write made by the
                                 // Copper (so copper_pc is meaningful), else 0.
} puae_debug_watchbreak_t;


// Register watches: break when a CPU register's *own* value changes, as
// opposed to a memory watchpoint on the address it happens to hold. There's
// no hardware/hook equivalent of a memory access function for registers —
// they're written inline by hundreds of opcode handlers — so this works by
// diffing each watched register's value once per retired instruction
// (see puae_debug_instructionHookImpl), not by intercepting individual
// writes. Indices match UAE's regs.regs[] layout: D0-D7 = 0..7, A0-A7 = 8..15.
#define PUAE_REGWATCH_COUNT 16

typedef struct puae_debug_regwatchbreak
{
    uint32_t reg_index; // 0..15 (D0-D7, A0-A7)
    uint32_t old_value;
    uint32_t new_value;
    uint32_t pc;         // PC of the not-yet-executed instruction when the change was detected
} puae_debug_regwatchbreak_t;


// 68k exception vector numbers fit in 0..63, matching the bits of the
// catchpoint-enabled mask (bit N = vector N, e.g. 4 = illegal instruction).
#define PUAE_CATCHPOINT_VECTOR_MAX 64

typedef struct puae_debug_catchbreak
{
    uint32_t pc;     // m68k_getpc() at the point the exception was raised
    uint32_t vector; // 68k exception vector number (2=bus error, 3=address
                      // error, 4=illegal instruction, 5=zero divide, 8=
                      // privilege violation, etc.)
} puae_debug_catchbreak_t;


// Memory protection: breaks on writes outside a dynamic allow-list of
// ranges (the debugged program's own loaded segments/stack, plus anything
// it AllocMem's while running), excluding the low-memory exception vector
// table (always allowed). See the puae_debug_memprotect_* declarations
// below.
#define PUAE_MEMPROTECT_RANGE_COUNT 128

typedef struct puae_debug_memprotect_range
{
    uint32_t addr;
    uint32_t size;
} puae_debug_memprotect_range_t;

// What actually performed the write: the 68k CPU executing an instruction,
// or a DMA-driven hardware unit (Blitter, disk DMA) writing chip RAM
// directly, independent of the CPU. See puae_debug_memhook_afterWrite's
// callers in memory.c.
#define PUAE_MEMPROTECT_SOURCE_CPU 0
#define PUAE_MEMPROTECT_SOURCE_DMA 1

typedef struct puae_debug_memprotect_break
{
    uint32_t pc;
    uint32_t addr;
    uint32_t value;
    uint32_t sizeBits;
    uint32_t source; // PUAE_MEMPROTECT_SOURCE_*
} puae_debug_memprotect_break_t;



/* Debug */


int
puae_debug_instructionHook(uaecptr pc, uae_u16 opcode);

void
puae_debug_pause(void);

void
puae_debug_resume(void);

int
puae_debug_is_paused(void);

void
puae_debug_step_instr(void);

void
puae_debug_step_line(void);

void
puae_debug_step_next(void);

void
puae_debug_step_out(void);

size_t
puae_debug_read_callstack(uint32_t *out, size_t cap);

// Reads up to `cap` registers into `out`: 0-15 = D0-D7/A0-A7 (regs.regs[i]),
// 16 = SR, 17 = PC, 18 = USP (regs.usp shadow if in supervisor mode, else
// live A7).
size_t
puae_debug_read_regs(uint32_t *out, size_t cap);

// Writes a single register. regnum 0-15 = D0-D7/A0-A7 (regs.regs[i]),
// 16 = SR (applies MakeFromSR() side effects), 17 = PC (m68k_setpc()),
// 18 = USP (regs.usp shadow if in supervisor mode, else live A7).
// Returns 0 on success, -1 for an out-of-range regnum. Other CpuInfo
// fields (ISP/MSP/VBR/etc.) are not addressable here, mirroring the
// gap in puae_debug_read_regs().
int
puae_debug_write_reg(uint32_t regnum, uint32_t value);

size_t
puae_debug_read_memory(uint32_t addr, uint8_t *out, size_t cap);

int
puae_debug_write_memory(uint32_t addr, uint32_t value, size_t size);

// Bulk write of an arbitrary-length buffer, watchpoint-suspended like
// puae_debug_write_memory. Used for loading program data.
size_t
puae_debug_write_memory_buf(uint32_t addr, const uint8_t *data, size_t len);

// Classifies each of the 256 64KB banks of the 24-bit address space
// (mem_banks[0..255]) into a byte using the same numeric values as
// src/vAmiga.ts's MemSrc enum (0=NONE, 1=CHIP, 2=CHIP_MIRROR, 3=SLOW,
// 4=SLOW_MIRROR, 5=FAST, 6=CIA, 7=CIA_MIRROR, 9=CUSTOM, 10=CUSTOM_MIRROR,
// 13=ROM, 14=ROM_MIRROR, 16=EXT). RTC/AUTOCONF/ZOR/WOM (8/11/12/15) are
// not currently detected and report as NONE. Returns the number of bytes
// written (min(cap, 256)).
size_t
puae_debug_read_memory_map(uint8_t *out, size_t cap);

// Like read/write_memory, but go through the normal CPU-visible accessors
// without suspending watchpoint checks (see puae_debug.c for why).
int
puae_debug_poke_memory(uint32_t addr, uint32_t value, size_t size);

size_t
puae_debug_peek_memory(uint32_t addr, uint8_t *out, size_t cap);

// Display-control register state that is write-only on the 68k bus
// (BPLCON0-3, DIWSTRT/STOP, DDFSTRT/STOP, COLOR00-31 all read back the
// floating data bus on real hardware) but is needed for the debugger's
// Amiga State view. Order: BPLCON0, BPLCON1, BPLCON2, BPLCON3, DIWSTRT,
// DIWSTOP, DDFSTRT, DDFSTOP, COLOR00..COLOR31 (raw 12-bit 0x0RGB values).
// Returns PUAE_DISPLAY_REG_COUNT on success, 0 if cap is too small.
#define PUAE_DISPLAY_REG_COUNT 40
size_t
puae_debug_read_display_regs(uint16_t *out, size_t cap);

// Raw $DFF000-$DFF1FE custom-register image, for write-only registers not
// covered by puae_debug_read_display_regs above (blitter/copper/disk
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
// puae_debug_read_audio_regs for AUD0-3.
//
// Returns PUAE_CUSTOM_REGS_RAW_SIZE on success, 0 if cap is too small.
#define PUAE_CUSTOM_REGS_RAW_SIZE (8 + 256 * 2)
size_t
puae_debug_read_custom_regs_raw(uint8_t *out, size_t cap);

// AGA's full 256-entry, 24-bit-per-channel palette (see puae_get_aga_colors_raw's doc comment,
// custom.c) — all zero when not currently in AGA mode. `out` must hold PUAE_AGA_COLOR_COUNT
// uint32_t entries (each 0x00RRGGBB). Returns PUAE_AGA_COLOR_COUNT on success, 0 if cap is too
// small.
#define PUAE_AGA_COLOR_COUNT 256
size_t
puae_debug_read_aga_colors(uint32_t *out, size_t cap);

// AUD0-3 LC/LEN/PER/VOL/DAT "live register" values (write-only on the 68k
// bus, not part of save_custom()'s output - see caveat above). Packed
// big-endian per channel as LC(4) LEN(2) PER(2) VOL(2) DAT(2) = 12 bytes,
// for 4 channels = PUAE_AUDIO_REGS_SIZE bytes total.
//
// Returns PUAE_AUDIO_REGS_SIZE on success, 0 if cap is too small.
#define PUAE_AUDIO_REGS_SIZE (4 * 12)
size_t
puae_debug_read_audio_regs(uint8_t *out, size_t cap);

size_t
puae_debug_disassemble_quick(uint32_t pc, char *out, size_t cap);

uint64_t
puae_debug_read_cycle_count(void);

void
puae_debug_add_breakpoint(uint32_t addr);

void
puae_debug_remove_breakpoint(uint32_t addr);

void
puae_debug_add_temp_breakpoint(uint32_t addr);

void
puae_debug_remove_temp_breakpoint(uint32_t addr);

// Optional host callback invoked once per vblank/frame.
void
puae_debug_set_vblank_callback(void (*cb)(void *), void *user);

void
puae_vblank_notify(void);

// Optional host callback invoked once per scanline (hsync), after all
// per-line state updates for that line. Used to implement "run to end of
// line" (eol) stepping.
void
puae_debug_set_hblank_callback(void (*cb)(void *), void *user);

void
puae_hsync_notify(void);

// Memory-access hooks called from the chip-RAM bank accessors (memory.c/
// memory.h, custom.c) to drive watchpoints/memprotect.
void
puae_debug_memhook_afterRead(uint32_t addr24, uint32_t value, uint32_t sizeBits);

// `source` is PUAE_MEMPROTECT_SOURCE_CPU/_DMA — which actually
// performed the write, the 68k CPU or a DMA-driven unit (Blitter, disk
// DMA).
void
puae_debug_memhook_afterWrite(uint32_t addr24, uint32_t value, uint32_t oldValue, uint32_t sizeBits, int oldValueValid, uint32_t source);



/* Mem protect */

void
puae_debug_memprotect_set_enabled(int enabled);

// Live-toggles cpu_cycle_exact/cpu_memory_cycle_exact/blitter_cycle_exact/cpu_compatible
// together — see the definition in puae_debug.c for why all four move together and why
// this goes through changed_prefs + check_prefs_changed_cpu() rather than currprefs directly.
void
puae_debug_set_cycle_exact(int enabled);

int
puae_debug_get_cycle_exact(void);

// Starts (or restarts) the live AllocMem/FreeMem watch that builds the
// allow-list, independent of whether enforcement is enabled. Validates
// execBase itself before committing (see puae_debug_execBaseValid), so it's
// safe to call on every tick from the moment the machine starts running —
// it no-ops (returning 0) until exec.library has actually initialized
// itself, far earlier than puae_app.js/puae_rpc.js's isExecReady "user task
// started" heuristic. Callers must stop polling once this first returns 1 —
// calling it again while already tracking discards any AllocMem call
// currently in-flight. Safe to call again deliberately after an explicit
// reset/reboot to recompute the AllocMem/FreeMem LVO addresses from the new
// execBase.
int
puae_debug_memprotect_start_tracking(void);

// Walks ExecBase->LibList and adds every resident library (GfxBase,
// IntuitionBase, DosBase, exec.library itself, ...) to the allow-list.
// Deliberately separate from puae_debug_memprotect_start_tracking — call
// this once the caller already trusts library state is live (e.g. the
// same "GfxBase is set" condition puae_app.js's tryExec uses), not as
// early as execBase merely validates. Safe to call repeatedly.
int
puae_debug_memprotect_seed_libraries(void);

void
puae_debug_memprotect_reset_ranges(void);

int
puae_debug_memprotect_add_range(uint32_t addr, uint32_t size);

int
puae_debug_memprotect_consume_break(puae_debug_memprotect_break_t *out);



/* Watchpoints */

void
puae_debug_reset_watchpoints(void);

int
puae_debug_add_watchpoint(uint32_t addr, uint32_t op_mask, uint32_t diff_operand, uint32_t value_operand,
                         uint32_t old_value_operand, uint32_t size_operand, uint32_t addr_mask_operand);

void
puae_debug_remove_watchpoint(uint32_t index);

size_t
puae_debug_read_watchpoints(puae_debug_watchpoint_t *out, size_t cap);

uint64_t
puae_debug_get_watchpoint_enabled_mask(void);

void
puae_debug_set_watchpoint_enabled_mask(uint64_t mask);

int
puae_debug_consume_watchbreak(puae_debug_watchbreak_t *out);

void
puae_debug_reset_regwatches(void);

int
puae_debug_add_regwatch(uint32_t regIndex);

void
puae_debug_remove_regwatch(uint32_t regIndex);

uint32_t
puae_debug_get_regwatch_enabled_mask(void);

int
puae_debug_consume_regwatchbreak(puae_debug_regwatchbreak_t *out);



/* ── Time-travel / reverse debugging ───────────────────────────────────────── */

// Monotonic count of retired instructions: instrCount == N means the
// instruction at the current PC is instruction #N and has not yet executed.
uint64_t
puae_debug_read_instr_count(void);

// Not part of the libretro savestate — callers must restore this explicitly
// after wasm_unserialize, to the instrCount recorded alongside that checkpoint.
void
puae_debug_write_instr_count(uint64_t value);

// True while puae_debug_replay_instructions/replay_scan is running. Lets
// frontend_shim.c suppress audio/video/frame-count output during replay.
int
puae_debug_is_replaying(void);

// True while puae_debug_replay_instructions_video is running. Lets
// frontend_shim.c's shim_video_refresh update the pixel buffer/frame count
// even though puae_debug_is_replaying() is also true (puae_vblank_notify's
// per-frame debugger hooks stay suppressed regardless).
int
puae_debug_is_replay_video_enabled(void);

// Runs forward exactly `count` retired instructions from the current state
// (normally right after restoring a checkpoint), with debugger side effects
// suppressed. Leaves the CPU paused with instrCount advanced by `count`.
// count == 0 is a no-op (preserves a pending zero-drift restore).
void
puae_debug_replay_instructions(uint32_t count);

// Like puae_debug_replay_instructions, but allows shim_video_refresh to update
// the pixel buffer/frame count for frames rendered during the replay. Used
// for the final "land on target" replay of stepBack/continueReverse/
// stepBackFrame so the on-screen framebuffer reflects the landed-on state.
void
puae_debug_replay_instructions_video(uint32_t count);

// Like puae_debug_replay_instructions, but returns the instrCount of the
// latest instruction within the replayed range whose PC has a breakpoint
// set, or (uint64_t)-1 if none matched.
uint64_t
puae_debug_replay_scan(uint32_t count);

// Like puae_debug_replay_scan, but returns the instrCount of the latest frame
// boundary (vblank) crossed within the replayed range, or (uint64_t)-1 if
// none was crossed.
uint64_t
puae_debug_replay_scan_frame(uint32_t count);

// Combined scan + video: like puae_debug_replay_scan but also enables video
// so the framebuffer is updated in the same pass, avoiding a second
// restore+replay in continueReverse's per-interval render step.
uint64_t
puae_debug_replay_scan_video(uint32_t count);

// Temporarily zeroes puae_debug_breakpointCount (saving its previous value),
// for wasm_unserialize to call across retro_unserialize. See puae_debug.c for
// why this is needed. puae_debug_resume_breakpoints restores the saved count.
void
puae_debug_suspend_breakpoints(void);

void
puae_debug_resume_breakpoints(void);

// Arms the same one-shot mechanism as puae_debug_step_instr's "after" flag:
// the very next instructionHook call pauses *before* executing that instruction.
// Used by m68k_go's save-state restore path (wasm_unserialize) to stop the CPU
// from running any instructions immediately after a restore, giving exact,
// zero-drift restore.
void
puae_debug_request_break_before_next_instr(void);

// Called from hsync_handler() (custom.c) on the scanline where a new frame's
// vblank starts — including during replay. Drives puae_debug_replay_scan_frame.
void
puae_debug_frame_boundary_notify(void);

/* ── CPU trace ring buffer ──────────────────────────────────────────────────── */

// Enables/disables the CPU instruction trace ring buffer. Enabled by default.
void
puae_debug_enable_cpu_logging(int enabled);

#define PUAE_DEBUG_CPU_TRACE_CAP 256

// Writes up to min(count, PUAE_DEBUG_CPU_TRACE_CAP, <number logged>) of the
// most recently retired instructions into `out` as interleaved (pc, sr) uint32
// pairs, most-recently-executed first. `cap` is the capacity of `out` in
// uint32_t words (must be >= 2 * count). Returns the number of entries written.
size_t
puae_debug_read_cpu_trace(uint32_t count, uint32_t *out, size_t cap);

/* ── Event-phase capture/restore ────────────────────────────────────────────── */

// Captures/restores eventtab[ev_hsync]/[ev_hsynch]/[ev_misc] phase info plus
// vpos/lof_store/lof_display, none of which the libretro savestate format
// preserves correctly for mid-line checkpoints. `out`/`in` must hold
// PUAE_DEBUG_EVENT_PHASE_WORDS uint32_t's. Called by wasm_serialize/
// wasm_unserialize in frontend_shim.c alongside the regular savestate blob.
// puae_debug_restore_event_phase also calls events_schedule() to recompute
// nextevent from the restored eventtab.
#define PUAE_DEBUG_EVENT_PHASE_WORDS (3 * 5 + 3)

void
puae_debug_capture_event_phase(uint32_t *out);

void
puae_debug_restore_event_phase(const uint32_t *in);

/* ── Catchpoints ─────────────────────────────────────────────────────────────── */

// Enables/disables a halt the next time CPU exception `vector` is raised
// (vector must be < PUAE_CATCHPOINT_VECTOR_MAX, e.g. 4 = illegal instruction).
void
puae_debug_set_catchpoint(uint32_t vector);

void
puae_debug_remove_catchpoint(uint32_t vector);

// Called from ExceptionX (newcpu.c) for every CPU exception. If `vector` has
// an enabled catchpoint, records {pc, vector} and requests a debugger break.
void
puae_debug_check_catchpoint(uint32_t vector, uint32_t pc);

// Returns 1 and fills `out` if a catchpoint break is pending (consuming it),
// else returns 0.
int
puae_debug_consume_catchbreak(puae_debug_catchbreak_t *out);

/* ── PUAE-specific accessors and diagnostics ─────────────────────────────────  */

// Returns currprefs.chipmem.size (actual configured chip RAM size in bytes).
uint32_t
puae_debug_get_chip_mem_size(void);

// Set during puae_debug_read_memory/peek_memory to suppress write-only-register
// readback side effects in custom_wget_1 (suppresses real-hardware echo behavior
// so that debugger memory inspection cannot corrupt chipset registers like DDFSTRT).
extern int puae_debug_inspect_active;

// Returns custom.c's cop_state.ip (the Copper's current list pointer) and
// sets *valid to 1 if the access in progress is a custom-register write made
// by the Copper (custom.c's copper_access flag), else 0 (and the returned
// value is meaningless). Lets puae_debug.c attribute a DMA-sourced watchpoint
// hit on a custom register to the actual Copper instruction responsible,
// rather than just the CPU's unrelated concurrent PC — cop_state/copper_access
// are static to custom.c, hence this accessor.
uint32_t
puae_debug_get_copper_pc(int *valid);
