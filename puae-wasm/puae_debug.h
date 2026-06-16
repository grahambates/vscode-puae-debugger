#pragma once

#include <stddef.h>
#include <stdint.h>
#include "e9k-lib.h"

/*
 * puae_debug.h — Our own additions to the debug layer (not from Engine9000).
 *
 * Time-travel/reverse-debugging infrastructure added in Phases 13–18. These
 * functions are implemented in ami_debug.c alongside the vendored Engine9000
 * e9k_debug_* functions (see ami_debug.c's file-level comment for why they
 * coexist in one file rather than being split).
 */

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
// even though puae_debug_is_replaying() is also true (e9k_vblank_notify's
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

// Temporarily zeroes e9k_debug_breakpointCount (saving its previous value),
// for wasm_unserialize to call across retro_unserialize. See ami_debug.c for
// why this is needed. puae_debug_resume_breakpoints restores the saved count.
void
puae_debug_suspend_breakpoints(void);

void
puae_debug_resume_breakpoints(void);

// Arms the same one-shot mechanism as e9k_debug_step_instr's "after" flag:
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
// (vector must be < E9K_CATCHPOINT_VECTOR_MAX, e.g. 4 = illegal instruction).
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
puae_debug_consume_catchbreak(e9k_debug_catchbreak_t *out);

/* ── PUAE-specific accessors and diagnostics ─────────────────────────────────  */

// Returns currprefs.chipmem.size (actual configured chip RAM size in bytes).
uint32_t
puae_debug_get_chip_mem_size(void);

// Diagnostics: currprefs.cpu_model (e.g. 68000, 68020, ...).
uint32_t
puae_debug_get_cpu_model(void);

// Diagnostics: bitmask of CPU timing-accuracy prefs — bit0 cpu_compatible,
// bit1 cpu_cycle_exact, bit2 cpu_memory_cycle_exact, bit3 blitter_cycle_exact.
uint32_t
puae_debug_get_cpu_flags(void);

// Diagnostics: currprefs.m68k_speed (0 = real hardware rate, <0 = max/turbo).
int32_t
puae_debug_get_m68k_speed(void);

// Diagnostics: DMA/cycle-contention internals (see ami_debug.c for index meanings).
int32_t
puae_debug_get_dma_diag(uint32_t index, uint32_t addr);

// Diagnostics: bitplane-DMA fetch prediction state (see ami_debug.c for index meanings).
int32_t
puae_debug_get_estimate_diag(uint32_t index, uint32_t param);

// Set during e9k_debug_read_memory/peek_memory to suppress write-only-register
// readback side effects in custom_wget_1 (suppresses real-hardware echo behavior
// so that debugger memory inspection cannot corrupt chipset registers like DDFSTRT).
extern int puae_debug_inspect_active;
