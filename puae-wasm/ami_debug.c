/*
 * ami_debug.c — Amiga debug layer for the PUAE wasm backend.
 *
 * STRUCTURE: This file contains two categories of code, distinguished by
 * naming convention and declared in separate headers:
 *
 *   VENDORED (Engine9000) — e9k_debug_* functions declared in e9k/e9k_debug.h.
 *     Breakpoints, watchpoints, protects, catchpoints, callstack tracking,
 *     memory hooks, profiler, disassembly, register/memory read/write, memory
 *     map, display/custom/audio registers, vblank/hblank callbacks, step modes.
 *     Originated from the Engine9000 project's debugger core; kept in e9k/.
 *
 *   OUR ADDITIONS — puae_debug_* functions declared in puae_debug.h.
 *     Time-travel/reverse-debugging infrastructure added in Phases 13–18:
 *     instruction counter, replay mode, CPU trace ring buffer, event-phase
 *     capture/restore, frame boundary scanning, suspend/resume breakpoints,
 *     PUAE-specific accessors and diagnostics.
 *
 * Both categories are implemented here (not split into separate .c files)
 * because the replay-mode state variables are inlined into the hot-path of
 * e9k_debug_instructionHookImpl, and separating them would require making
 * those static variables extern-visible — not worth the coupling cost.
 */

#include "e9k_debug.h"
#include "puae_debug.h"
#include "e9k_protect.h"
#include "e9k_watchpoint.h"

#include "libretro.h"

#include "sysconfig.h"
#include "sysdeps.h"
#include "options.h"
#include "events.h"
#include "uae.h"
#include "memory.h"
#include "custom.h"
#include "audio.h"
#include "newcpu.h"
#include "debug.h"

#define E9K_DEBUG_CALLSTACK_MAX 256
#define E9K_DEBUG_BREAKPOINT_MAX 4096

extern bool libretro_frame_end;

#define E9K_DEBUG_EXPORT RETRO_API

// Fake debug output register support (written by target code, consumed by e9k-debugger)
#define E9K_DEBUG_TEXT_CAP 8192

static int e9k_debug_paused = 0;
static uint32_t e9k_debug_callstack[E9K_DEBUG_CALLSTACK_MAX];
static size_t e9k_debug_callstackDepth = 0;

static int e9k_debug_stepInstr = 0;
static int e9k_debug_stepInstrAfter = 0;

// Monotonic count of retired instructions: instrCount == N means the
// instruction at the current PC is instruction #N and has NOT yet executed
// (it becomes N+1 once instructionHook lets it run). Used as the anchor for
// exact-instruction rewind (see puae_debug_replay_instructions below).
static uint64_t puae_debug_instrCount = 0;

// Replay mode: instructionHook short-circuits all normal step/breakpoint
// logic and instead runs forward exactly to puae_debug_replayTarget
// (an instrCount value), used to re-derive exact CPU/chipset state between a
// restored checkpoint and a target instruction count.
static int puae_debug_replayMode = 0;
static uint64_t puae_debug_replayTarget = 0;

// When set during replay, shim_video_refresh (frontend_shim.c) still updates
// the pixel buffer/frame count (but NOT e9k_vblank_notify's per-frame debugger
// hooks, which stay suppressed). Used by puae_debug_replay_instructions_video
// so the framebuffer reflects the landed-on state after stepBack/
// continueReverse/stepBackFrame, which would otherwise leave a stale frame on
// screen (the restored checkpoint doesn't include rendered pixels).
static int puae_debug_replayVideoEnabled = 0;

// Scan mode (active only while puae_debug_replayMode is set): records the
// instrCount of the most recent (i.e. latest in forward time) instruction
// hitting a breakpoint during the replay range, for continueReverse.
static int puae_debug_scanMode = 0;
static uint64_t puae_debug_scanLastMatch = 0;

// Like puae_debug_scanMode, but records the instrCount of the most recent
// frame boundary (vblank) crossed during the replay range, for
// stepBackFrame. Shares puae_debug_scanLastMatch with puae_debug_scanMode —
// only one scan kind is ever active at a time.
static int puae_debug_scanFrameMode = 0;

static int e9k_debug_stepLine = 0;
static int e9k_debug_stepNext = 0;
static int e9k_debug_stepNextSkipOnce = 0;
static int e9k_debug_stepOut = 0;
static int e9k_debug_stepOutSkipOnce = 0;
static int e9k_debug_stepIntoPending = 0;

static int e9k_debug_skipBreakpointOnce = 0;
static uint32_t e9k_debug_skipBreakpointPc = 0;

static uint32_t e9k_debug_breakpoints[E9K_DEBUG_BREAKPOINT_MAX];
static size_t e9k_debug_breakpointCount = 0;
static uint32_t e9k_debug_tempBreakpoints[E9K_DEBUG_BREAKPOINT_MAX];
static size_t e9k_debug_tempBreakpointCount = 0;

static void (*e9k_debug_vblankCb)(void *) = NULL;
static void *e9k_debug_vblankUser = NULL;

static void (*e9k_debug_hblankCb)(void *) = NULL;
static void *e9k_debug_hblankUser = NULL;

static int e9k_debug_memhooksEnabled = 1;

static e9k_debug_watchpoint_t e9k_debug_watchpoints[E9K_WATCHPOINT_COUNT];
static uint64_t e9k_debug_watchpointEnabledMask = 0;
static e9k_debug_watchbreak_t e9k_debug_watchbreak = {0};
static int e9k_debug_watchbreakPending = 0;
static int e9k_debug_watchpointSuspend = 0;

// Set while e9k_debug_read_memory/e9k_debug_peek_memory are scanning memory
// for debugger display purposes. custom_wget_1's write-only-register
// readback side effect (real OCS/ECS hardware writes the last chip bus value
// back to a write-only register when the CPU reads it) is suppressed while
// this is set, so that inspecting memory in the debugger can't corrupt
// chipset registers like DDFSTRT.
int puae_debug_inspect_active = 0;

static e9k_debug_protect_t e9k_debug_protects[E9K_PROTECT_COUNT];
static uint64_t e9k_debug_protectEnabledMask = 0;

static uint64_t puae_debug_catchpointEnabledMask = 0;
static e9k_debug_catchbreak_t puae_debug_catchbreak = {0};
static int puae_debug_catchbreakPending = 0;

static int e9k_debug_checkpointEnabled = 0;
static e9k_debug_checkpoint_t e9k_debug_checkpoints[E9K_CHECKPOINT_COUNT];

// CPU instruction trace ring buffer (PC + SR per retired instruction),
// modeled on WinUAE's debugger "H" command history[] and vAmiga/Moira's
// Debugger::logBuffer. Enabled by default since enableCpuLogging() currently
// has no caller.
static int puae_debug_cpuLoggingEnabled = 1;
static uint32_t puae_debug_cpuTracePc[PUAE_DEBUG_CPU_TRACE_CAP];
static uint16_t puae_debug_cpuTraceSr[PUAE_DEBUG_CPU_TRACE_CAP];
static size_t puae_debug_cpuTraceHead = 0; // next write index
static size_t puae_debug_cpuTraceCount = 0; // number of valid entries (<= CAP)

static int e9k_debug_profilerEnabled = 0;

// Minimal PC-sampling profiler used by e9k-debugger. The debugger resolves PCs to symbols/lines.
// We stream aggregated PC hits as JSON in e9k_debug_profiler_stream_next(), matching geo9000.
#define E9K_DEBUG_PROF_EMPTY_PC 0xffffffffu
#define E9K_DEBUG_PROF_TABLE_CAP 4096u
#define E9K_DEBUG_PROF_SAMPLE_DIV 64u
static uint32_t e9k_debug_prof_pcs[E9K_DEBUG_PROF_TABLE_CAP];
static uint64_t e9k_debug_prof_samples[E9K_DEBUG_PROF_TABLE_CAP];
static uint64_t e9k_debug_prof_cycles[E9K_DEBUG_PROF_TABLE_CAP];
static uint32_t e9k_debug_prof_entryEpoch[E9K_DEBUG_PROF_TABLE_CAP];
static uint32_t e9k_debug_prof_dirtyIdx[E9K_DEBUG_PROF_TABLE_CAP];
static uint32_t e9k_debug_prof_dirtyCount = 0;
static uint32_t e9k_debug_prof_epoch = 1;
static uint32_t e9k_debug_prof_tick = 0;
static uint32_t e9k_debug_prof_lastTickAtFrame = 0;
static int e9k_debug_prof_streamEnabled = 0;
static int e9k_debug_prof_lastValid = 0;
static uint32_t e9k_debug_prof_lastPc = 0;
static evt_t e9k_debug_prof_lastCycle = 0;
#ifdef JIT
static int e9k_debug_prof_savedCachesize = -1;
#endif


static char e9k_debug_textBuf[E9K_DEBUG_TEXT_CAP];
static size_t e9k_debug_textHead = 0;
static size_t e9k_debug_textTail = 0;
static size_t e9k_debug_textCount = 0;

static void e9k_debug_requestBreak(void);

static void
e9k_debug_profiler_reset(void)
{
	memset(e9k_debug_prof_pcs, 0xff, sizeof(e9k_debug_prof_pcs));
	memset(e9k_debug_prof_samples, 0, sizeof(e9k_debug_prof_samples));
	memset(e9k_debug_prof_cycles, 0, sizeof(e9k_debug_prof_cycles));
	memset(e9k_debug_prof_entryEpoch, 0, sizeof(e9k_debug_prof_entryEpoch));
	e9k_debug_prof_dirtyCount = 0;
	e9k_debug_prof_epoch = 1;
	e9k_debug_prof_tick = 0;
	e9k_debug_prof_lastTickAtFrame = 0;
	e9k_debug_prof_lastValid = 0;
	e9k_debug_prof_lastPc = 0;
	e9k_debug_prof_lastCycle = 0;
}

static void
e9k_debug_profiler_markDirtySlot(uint32_t slot)
{
	if (slot >= E9K_DEBUG_PROF_TABLE_CAP) {
		return;
	}
	if (e9k_debug_prof_entryEpoch[slot] == e9k_debug_prof_epoch) {
		return;
	}
	e9k_debug_prof_entryEpoch[slot] = e9k_debug_prof_epoch;
	if (e9k_debug_prof_dirtyCount < E9K_DEBUG_PROF_TABLE_CAP) {
		e9k_debug_prof_dirtyIdx[e9k_debug_prof_dirtyCount++] = slot;
	}
}

static int
e9k_debug_profiler_findSlot(uint32_t pc24, int create, uint32_t *out_slot)
{
	if (out_slot) {
		*out_slot = 0;
	}
	pc24 &= 0x00ffffffu;
	uint32_t mask = E9K_DEBUG_PROF_TABLE_CAP - 1u;
	uint32_t idx = (pc24 * 2654435761u) & mask;
	for (uint32_t probe = 0; probe < E9K_DEBUG_PROF_TABLE_CAP; ++probe) {
		uint32_t slot = (idx + probe) & mask;
		uint32_t cur = e9k_debug_prof_pcs[slot];
		if (cur == pc24) {
			if (out_slot) {
				*out_slot = slot;
			}
			return 1;
		}
		if (cur == E9K_DEBUG_PROF_EMPTY_PC) {
			if (!create) {
				return 0;
			}
			e9k_debug_prof_pcs[slot] = pc24 & 0x00ffffffu;
			e9k_debug_prof_samples[slot] = 0;
			e9k_debug_prof_cycles[slot] = 0;
			if (out_slot) {
				*out_slot = slot;
			}
			return 1;
		}
	}
	return 0;
}

static void
e9k_debug_profiler_accountCycles(uint32_t pc24, uint64_t cycles)
{
	if (cycles == 0) {
		return;
	}
	uint32_t slot = 0;
	if (!e9k_debug_profiler_findSlot(pc24, 1, &slot)) {
		return;
	}
	e9k_debug_prof_cycles[slot] += cycles;
	e9k_debug_profiler_markDirtySlot(slot);
}

static void
e9k_debug_profiler_samplePc(uint32_t pc24)
{
	uint32_t slot = 0;
	if (!e9k_debug_profiler_findSlot(pc24, 1, &slot)) {
		return;
	}
	e9k_debug_prof_samples[slot] += 1;
	e9k_debug_profiler_markDirtySlot(slot);
}

static void
e9k_debug_profiler_instrHook(uint32_t pc24)
{
	if (!e9k_debug_profilerEnabled) {
		return;
	}
	if (e9k_debug_paused) {
		return;
	}
	if (puae_debug_replayMode) {
		// Replay re-executes already-profiled instructions; don't double-count.
		return;
	}

	evt_t now = get_cycles();
	if (e9k_debug_prof_lastValid) {
		evt_t deltaUnits = now - e9k_debug_prof_lastCycle;
		if (deltaUnits > 0) {
			uint64_t deltaCycles = 0;
			if (CYCLE_UNIT > 0) {
				deltaCycles = (uint64_t)(deltaUnits / (evt_t)CYCLE_UNIT);
			} else {
				deltaCycles = (uint64_t)deltaUnits;
			}
			if (deltaCycles) {
				e9k_debug_profiler_accountCycles(e9k_debug_prof_lastPc, deltaCycles);
			}
		}
	}
	e9k_debug_prof_lastCycle = now;
	e9k_debug_prof_lastPc = pc24 & 0x00ffffffu;
	e9k_debug_prof_lastValid = 1;

	e9k_debug_prof_tick++;
	if ((e9k_debug_prof_tick % E9K_DEBUG_PROF_SAMPLE_DIV) == 0u) {
		e9k_debug_profiler_samplePc(pc24);
	}
}

// ---- wasm_profile: vAmiga-format CPU profiler ----
// Each record: [depth, leaf_pc, callerN-1, ..., caller0, cycleDelta] (uint32_t).
// Address range + optional DWARF unwind table from wasm_profile_set_unwind.
// When a table is present (C/C++ programs): call stack reconstructed by walking
// DWARF CFA chains.  When absent (assembly): JSR/BSR/RTS shadow call stack.

#define WASM_PROFILE_BUF_WORDS (1 << 20)   /* 4 MB ≈ 174k samples at avg depth 5 */
static uint32_t g_wprofBuf[WASM_PROFILE_BUF_WORDS];
static uint32_t g_wprofBufLen;
int             g_wprofActive;             /* non-static: read by wasm_profile_start */
static uint32_t g_wprofStartAddr;
static uint32_t g_wprofEndAddr;
static uint64_t g_wprofTotalInstrs;
static uint64_t g_wprofInRangeInstrs;
static evt_t    g_wprofLastCycle;
static int      g_wprofLastCycleValid;
static int      g_wprofWasPaused;
static evt_t    g_wprofStartCycles;
static uint64_t g_wprofFrameCycles;

/* DWARF unwind table uploaded by wasm_profile_set_unwind (NULL = assembly/branch-stack). */
static uint8_t *g_wprofUnwindBuf = NULL;
static uint32_t g_wprofUnwindLen = 0;

/*
 * Safe 4-byte big-endian read from the Amiga address space, with no side effects.
 * Uses mem_banks[] (standard UAE memory map) so chip, slow, and fast RAM all work.
 * Returns 0 for unmapped or ROM addresses (which never hold a 68k stack frame).
 */
static uint32_t
unwind_read_safe(uint32_t addr)
{
	const addrbank *b = mem_banks[addr >> 16];
	if (!b || !b->baseaddr) return 0;
	uint32_t off = addr & b->mask;
	if (off + 3 > b->mask) return 0;
	const uint8_t *p = b->baseaddr + off;
	return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
	       ((uint32_t)p[2] << 8)  |  (uint32_t)p[3];
}

#define UNWIND_ENTRY_BYTES 6  /* u16 cfa_packed, i16 r13_off, i16 ra_off */

/*
 * Walk DWARF call frames from the current PC, filling callers[] with the
 * return-address chain innermost-first.  Returns the number of callers written.
 *
 * Entry format (from unwindTable.ts / WinUAE cpu_profiler_unwind):
 *   cfa_packed = (cfaReg << 12) | cfaOffset  — 0 means no DWARF info
 *   r13_off    = offset from CFA where caller's A5 is saved (0 = not tracked)
 *   ra_off     = offset from CFA where return address is saved
 */
static uint32_t
wasm_profile_dwarf_walk(uint32_t pc, uint32_t *callers, uint32_t maxCallers)
{
	uint32_t depth = 0;
	/* Mirror the live 68k register file; updated as we unwind each frame. */
	uint32_t cur_regs[16];
	for (int i = 0; i < 16; i++) cur_regs[i] = regs.regs[i];

	while (depth < maxCallers && pc >= g_wprofStartAddr && pc < g_wprofEndAddr) {
		uint32_t idx = (pc - g_wprofStartAddr) >> 1;
		if ((idx + 1) * UNWIND_ENTRY_BYTES > g_wprofUnwindLen) break;

		const uint8_t *e = g_wprofUnwindBuf + idx * UNWIND_ENTRY_BYTES;
		uint16_t cfa_packed = (uint16_t)e[0] | ((uint16_t)e[1] << 8);
		if (cfa_packed == 0) break;  /* no DWARF CFI for this PC */

		int16_t r13_off = (int16_t)((uint16_t)e[2] | ((uint16_t)e[3] << 8));
		int16_t ra_off  = (int16_t)((uint16_t)e[4] | ((uint16_t)e[5] << 8));
		uint8_t cfaReg  = (uint8_t)(cfa_packed >> 12);   /* DWARF 68k reg 0-15 */
		uint32_t cfaOff = (uint32_t)(cfa_packed & 0xfff);

		/* CFA = reg[cfaReg] + cfaOffset.  SP=reg[15], A5=reg[13] are most common. */
		uint32_t cfa = cur_regs[cfaReg] + cfaOff;

		/* Return address is at CFA + ra_off (typically CFA - 4 for m68k). */
		uint32_t ra = unwind_read_safe((uint32_t)((int32_t)cfa + ra_off));
		if (!ra) break;

		/* Restore caller's A5 if it was pushed onto the stack. */
		if (r13_off != 0)
			cur_regs[13] = unwind_read_safe((uint32_t)((int32_t)cfa + r13_off));

		/* Caller's SP is this frame's CFA. */
		cur_regs[15] = cfa;

		callers[depth++] = ra;
		pc = ra;
	}
	return depth;
}

void
wasm_profile_prepare(void)
{
	g_wprofBufLen          = 0;
	g_wprofTotalInstrs     = 0;
	g_wprofInRangeInstrs   = 0;
	g_wprofLastCycleValid  = 0;
	g_wprofFrameCycles     = 0;
	g_wprofActive          = 1;
	g_wprofWasPaused       = e9k_debug_paused;
	e9k_debug_paused       = 0;
	g_wprofStartCycles     = get_cycles();
}

void
wasm_profile_finish(int numFrames)
{
	if (numFrames > 0 && CYCLE_UNIT > 0) {
		evt_t elapsed = get_cycles() - g_wprofStartCycles;
		g_wprofFrameCycles = (uint64_t)elapsed / (uint64_t)CYCLE_UNIT / (uint64_t)numFrames;
	}
	g_wprofActive    = 0;
	e9k_debug_paused = g_wprofWasPaused;
}

static void
wasm_profile_instrHook(uint32_t pc24)
{
	if (!g_wprofActive) return;
	if (puae_debug_replayMode) return;

	g_wprofTotalInstrs++;
	if (pc24 < g_wprofStartAddr || pc24 >= g_wprofEndAddr) return;
	g_wprofInRangeInstrs++;

	evt_t now = get_cycles();
	uint32_t cycleDelta = 1;
	if (g_wprofLastCycleValid && CYCLE_UNIT > 0) {
		evt_t delta = now - g_wprofLastCycle;
		if (delta > 0) {
			uint64_t d = (uint64_t)delta / (uint64_t)CYCLE_UNIT;
			if (d > 0) cycleDelta = (uint32_t)(d < 0xfffffu ? d : 0xfffffu);
		}
	}
	g_wprofLastCycle      = now;
	g_wprofLastCycleValid = 1;

	/* Stack: leaf (current PC) + callers innermost-first.
	 * DWARF unwind table present  → walk CFA chain from live registers.
	 * No table (assembly program) → use JSR/BSR/RTS shadow call stack. */
	uint32_t callers[63];
	uint32_t stkDepth;
	if (g_wprofUnwindLen > 0) {
		stkDepth = wasm_profile_dwarf_walk(pc24, callers, 63);
	} else {
		stkDepth = (uint32_t)e9k_debug_callstackDepth;
		if (stkDepth > 63) stkDepth = 63;
		for (uint32_t i = 0; i < stkDepth; i++)
			callers[i] = e9k_debug_callstack[stkDepth - 1 - i];
	}

	uint32_t depth  = 1 + stkDepth;
	uint32_t needed = 1 + depth + 1;   /* depth-word + PCs + cycleDelta */
	if (g_wprofBufLen + needed > WASM_PROFILE_BUF_WORDS) return;

	g_wprofBuf[g_wprofBufLen++] = depth;
	g_wprofBuf[g_wprofBufLen++] = pc24;   /* leaf */
	for (uint32_t i = 0; i < stkDepth; i++)
		g_wprofBuf[g_wprofBufLen++] = callers[i];
	g_wprofBuf[g_wprofBufLen++] = cycleDelta;
}

E9K_DEBUG_EXPORT void
wasm_profile_set_unwind(const void *data, uint32_t len, uint32_t startAddr, uint32_t endAddr)
{
	free(g_wprofUnwindBuf);
	g_wprofUnwindBuf = NULL;
	g_wprofUnwindLen = 0;
	if (len > 0 && data) {
		g_wprofUnwindBuf = malloc(len);
		if (g_wprofUnwindBuf) {
			memcpy(g_wprofUnwindBuf, data, len);
			g_wprofUnwindLen = len;
		}
	}
	g_wprofStartAddr = startAddr;
	g_wprofEndAddr   = endAddr;
}

E9K_DEBUG_EXPORT uint32_t *
wasm_profile_get_buf_ptr(void) { return g_wprofBuf; }

E9K_DEBUG_EXPORT uint32_t
wasm_profile_get_buf_words(void) { return g_wprofBufLen; }

static char g_wprof_stats_buf[256];

E9K_DEBUG_EXPORT const char *
wasm_profile_get_stats(void)
{
	snprintf(g_wprof_stats_buf, sizeof(g_wprof_stats_buf),
		"{\"start\":%u,\"end\":%u,\"total\":%llu,\"inRange\":%llu,\"frameCycles\":%llu}",
		(unsigned)g_wprofStartAddr, (unsigned)g_wprofEndAddr,
		(unsigned long long)g_wprofTotalInstrs,
		(unsigned long long)g_wprofInRangeInstrs,
		(unsigned long long)g_wprofFrameCycles);
	return g_wprof_stats_buf;
}

// ---- DMA profiler grid (vAmiga Cell[] format) ----
// Populated by wasm_dma_serialize_grid() after wasm_profile_start completes.
// 227 * 313 * 8 bytes = ~568KB; serialised by e9k_dma_serialize() in debug.c.
#define E9K_DMA_CELL_BYTES 8
static uint8_t g_dmaGrid[227 * 313 * E9K_DMA_CELL_BYTES];
static uint32_t g_dmaGridSize;

extern uint32_t e9k_dma_serialize(uint8_t *out);

void
wasm_dma_serialize_grid(void)
{
	g_dmaGridSize = e9k_dma_serialize(g_dmaGrid);
}

E9K_DEBUG_EXPORT const uint8_t *
wasm_dma_get_grid_ptr(void) { return g_dmaGrid; }

E9K_DEBUG_EXPORT uint32_t
wasm_dma_get_grid_size(void) { return g_dmaGridSize; }

// Chip and slow RAM wasm-heap pointers for the profiler memory-reconstruction snapshot.
E9K_DEBUG_EXPORT uint32_t
wasm_dma_get_chip_ptr(void)  { return (uint32_t)chipmem_bank.baseaddr; }

E9K_DEBUG_EXPORT uint32_t
wasm_dma_get_chip_size(void) { return (uint32_t)(chipmem_bank.mask + 1); }

E9K_DEBUG_EXPORT uint32_t
wasm_dma_get_slow_ptr(void)  { return (uint32_t)bogomem_bank.baseaddr; }

E9K_DEBUG_EXPORT uint32_t
wasm_dma_get_slow_size(void) { return bogomem_bank.baseaddr ? (uint32_t)(bogomem_bank.mask + 1) : 0; }

// ---- DMA live overlay controls ----
extern void e9k_dma_set_channel_enabled(int type, int enabled);
extern void e9k_dma_draw_overlay(uint8_t *rgba, int width, int height, int opacity);

int g_dmaOverlayEnabled = 0;
int g_dmaOverlayOpacity = 128;

E9K_DEBUG_EXPORT void
wasm_dma_overlay_enable(int on)
{
	g_dmaOverlayEnabled = on ? 1 : 0;
	if (on && !debug_dma)
		debug_dma = 1;
}

E9K_DEBUG_EXPORT void
wasm_dma_overlay_set_channel(int type, int on)
{
	e9k_dma_set_channel_enabled(type, on);
}

E9K_DEBUG_EXPORT void
wasm_dma_overlay_set_opacity(int opacity)
{
	if (opacity < 0) opacity = 0;
	if (opacity > 255) opacity = 255;
	g_dmaOverlayOpacity = opacity;
}

static void
e9k_debug_cpuTrace_instrHook(uint32_t pc24)
{
	if (!puae_debug_cpuLoggingEnabled) {
		return;
	}
	MakeSR();
	puae_debug_cpuTracePc[puae_debug_cpuTraceHead] = pc24;
	puae_debug_cpuTraceSr[puae_debug_cpuTraceHead] = regs.sr;
	puae_debug_cpuTraceHead = (puae_debug_cpuTraceHead + 1) % PUAE_DEBUG_CPU_TRACE_CAP;
	if (puae_debug_cpuTraceCount < PUAE_DEBUG_CPU_TRACE_CAP) {
		puae_debug_cpuTraceCount++;
	}
}

E9K_DEBUG_EXPORT void
puae_debug_enable_cpu_logging(int enabled)
{
	puae_debug_cpuLoggingEnabled = enabled ? 1 : 0;
}

E9K_DEBUG_EXPORT size_t
puae_debug_read_cpu_trace(uint32_t count, uint32_t *out, size_t cap)
{
	if (!out || cap < 2) {
		return 0;
	}
	size_t maxEntries = cap / 2;
	if (count < maxEntries) {
		maxEntries = count;
	}
	if (maxEntries > puae_debug_cpuTraceCount) {
		maxEntries = puae_debug_cpuTraceCount;
	}
	for (size_t i = 0; i < maxEntries; ++i) {
		// Index 0 = most recently logged entry, i.e. one before the
		// (not-yet-overwritten) write head.
		size_t idx = (puae_debug_cpuTraceHead + PUAE_DEBUG_CPU_TRACE_CAP - 1 - i) % PUAE_DEBUG_CPU_TRACE_CAP;
		out[i * 2] = puae_debug_cpuTracePc[idx];
		out[i * 2 + 1] = (uint32_t)puae_debug_cpuTraceSr[idx];
	}
	return maxEntries;
}

void
e9k_debug_text_write(uae_u8 byte)
{
		if (e9k_debug_textCount == E9K_DEBUG_TEXT_CAP) {
			e9k_debug_textTail = (e9k_debug_textTail + 1) % E9K_DEBUG_TEXT_CAP;
		e9k_debug_textCount--;
	}
	e9k_debug_textBuf[e9k_debug_textHead] = (char)byte;
	e9k_debug_textHead = (e9k_debug_textHead + 1) % E9K_DEBUG_TEXT_CAP;
	e9k_debug_textCount++;
}

static uint32_t
e9k_debug_maskAddr(uaecptr addr)
{
	return (uint32_t)addr & 0x00ffffffu;
}

static uint32_t
e9k_debug_maskValue(uint32_t v, uint32_t sizeBits)
{
	if (sizeBits == 8u) {
		return v & 0xffu;
	}
	if (sizeBits == 16u) {
		return v & 0xffffu;
	}
	return v;
}

static uint32_t
e9k_debug_sizeBytes(uint32_t sizeBits)
{
	if (sizeBits == 8u) {
		return 1u;
	}
	if (sizeBits == 16u) {
		return 2u;
	}
	if (sizeBits == 32u) {
		return 4u;
	}
	return 0u;
}

static int
e9k_debug_tryGetCallReturnPc(uint32_t pc24, uae_u16 opcode, uint32_t *outReturnPc)
{
	if (!outReturnPc) {
		return 0;
	}

	if ((opcode & 0xFFC0u) == 0x4E80u) {
		int mode = (opcode >> 3) & 7;
		int reg = opcode & 7;
		uint32_t ext = 0;
		if (mode == 5 || mode == 6) {
			ext = 2;
		} else if (mode == 7) {
			if (reg == 0 || reg == 2 || reg == 3) {
				ext = 2;
			} else if (reg == 1) {
				ext = 4;
			} else {
				return 0;
			}
		} else if (mode < 2) {
			return 0;
		}
		*outReturnPc = (pc24 + 2u + ext) & 0x00ffffffu;
		return 1;
	}

	if ((opcode & 0xFF00u) == 0x6100u) {
		uint32_t disp8 = opcode & 0x00ffu;
		uint32_t len = 2u;
		if (disp8 == 0u) {
			len = 4u;
		} else if (disp8 == 0xffu) {
			len = 6u;
		}
		*outReturnPc = (pc24 + len) & 0x00ffffffu;
		return 1;
	}

	return 0;
}


static int
e9k_debug_watchpointMatch(const e9k_debug_watchpoint_t *wp, uint32_t accessAddr, uint32_t accessKind,
                          uint32_t accessSizeBits, uint32_t value, uint32_t oldValue, int oldValueValid)
{
	if (!wp) {
		return 0;
	}
	uint32_t op = wp->op_mask;

	if (accessKind == E9K_WATCH_ACCESS_READ) {
		if ((op & E9K_WATCH_OP_READ) == 0u) {
			return 0;
		}
	} else if (accessKind == E9K_WATCH_ACCESS_WRITE) {
		if ((op & E9K_WATCH_OP_WRITE) == 0u) {
			return 0;
		}
	} else {
		return 0;
	}

	if (op & E9K_WATCH_OP_ADDR_COMPARE_MASK) {
		uint32_t mask = wp->addr_mask_operand;
		if ((accessAddr & mask) != (wp->addr & mask)) {
			return 0;
		}
	}

	if (op & E9K_WATCH_OP_ACCESS_SIZE) {
		if (wp->size_operand != 8u && wp->size_operand != 16u && wp->size_operand != 32u) {
			return 0;
		}
		if (accessSizeBits != wp->size_operand) {
			return 0;
		}
	}

	uint32_t v = e9k_debug_maskValue(value, accessSizeBits);
	uint32_t ov = e9k_debug_maskValue(oldValue, accessSizeBits);

	if (op & E9K_WATCH_OP_VALUE_EQ) {
		if (v != e9k_debug_maskValue(wp->value_operand, accessSizeBits)) {
			return 0;
		}
	}
	if (op & E9K_WATCH_OP_OLD_VALUE_EQ) {
		if (!oldValueValid) {
			return 0;
		}
		if (ov != e9k_debug_maskValue(wp->old_value_operand, accessSizeBits)) {
			return 0;
		}
	}
	if (op & E9K_WATCH_OP_VALUE_NEQ_OLD) {
		if (!oldValueValid) {
			return 0;
		}
		if (ov == e9k_debug_maskValue(wp->diff_operand, accessSizeBits)) {
			return 0;
		}
	}

	return 1;
}

static void
e9k_debug_watchbreakRequest(uint32_t index, uint32_t accessAddr, uint32_t accessKind, uint32_t accessSizeBits,
                            uint32_t value, uint32_t oldValue, int oldValueValid)
{
	if (e9k_debug_watchbreakPending) {
		return;
	}
	if (index >= E9K_WATCHPOINT_COUNT) {
		return;
	}

	e9k_debug_watchpoint_t *wp = &e9k_debug_watchpoints[index];

	memset(&e9k_debug_watchbreak, 0, sizeof(e9k_debug_watchbreak));
	e9k_debug_watchbreak.index = index;
	e9k_debug_watchbreak.watch_addr = wp->addr;
	e9k_debug_watchbreak.op_mask = wp->op_mask;
	e9k_debug_watchbreak.diff_operand = wp->diff_operand;
	e9k_debug_watchbreak.value_operand = wp->value_operand;
	e9k_debug_watchbreak.old_value_operand = wp->old_value_operand;
	e9k_debug_watchbreak.size_operand = wp->size_operand;
	e9k_debug_watchbreak.addr_mask_operand = wp->addr_mask_operand;

	e9k_debug_watchbreak.access_addr = accessAddr;
	e9k_debug_watchbreak.access_kind = accessKind;
	e9k_debug_watchbreak.access_size = accessSizeBits;
	e9k_debug_watchbreak.value = e9k_debug_maskValue(value, accessSizeBits);
	e9k_debug_watchbreak.old_value = e9k_debug_maskValue(oldValue, accessSizeBits);
	e9k_debug_watchbreak.old_value_valid = oldValueValid ? 1u : 0u;

	e9k_debug_watchbreakPending = 1;
	e9k_debug_requestBreak();
}

static int
e9k_debug_hasBreakpoint(uint32_t addr)
{
	for (size_t i = 0; i < e9k_debug_breakpointCount; ++i) {
		if (e9k_debug_breakpoints[i] == addr) {
			return 1;
		}
	}
	return 0;
}

static int
e9k_debug_consumeTempBreakpoint(uint32_t addr)
{
	for (size_t i = 0; i < e9k_debug_tempBreakpointCount; ++i) {
		if (e9k_debug_tempBreakpoints[i] == addr) {
			size_t remain = e9k_debug_tempBreakpointCount - (i + 1u);
			if (remain) {
				memmove(&e9k_debug_tempBreakpoints[i], &e9k_debug_tempBreakpoints[i + 1u], remain * sizeof(e9k_debug_tempBreakpoints[0]));
			}
			e9k_debug_tempBreakpointCount--;
			return 1;
		}
	}
	return 0;
}

E9K_DEBUG_EXPORT void
e9k_debug_pause(void)
{
	// Use the same break mechanism as instruction/watch breaks so execution halts immediately
	// (important when running with threaded CPU/event loops).
	e9k_debug_requestBreak();
}

E9K_DEBUG_EXPORT void
puae_debug_request_break_before_next_instr(void)
{
	// Reuses step-instr's "after" flag: the next instructionHook call requests
	// a break and returns 1 *before* its instruction executes (see the
	// e9k_debug_stepInstrAfter check at the top of e9k_debug_instructionHook).
	e9k_debug_stepInstrAfter = 1;
}

E9K_DEBUG_EXPORT void
e9k_debug_resume(void)
{
	e9k_debug_paused = 0;
	e9k_debug_stepInstr = 0;
	e9k_debug_stepInstrAfter = 0;
	e9k_debug_stepLine = 0;
	e9k_debug_stepNext = 0;
	e9k_debug_stepNextSkipOnce = 0;
	e9k_debug_stepOut = 0;
	e9k_debug_stepOutSkipOnce = 0;
	e9k_debug_stepIntoPending = 0;

	uint32_t pc24 = e9k_debug_maskAddr(m68k_getpc());
	if (e9k_debug_hasBreakpoint(pc24)) {
		e9k_debug_skipBreakpointOnce = 1;
		e9k_debug_skipBreakpointPc = pc24;
	}
}

E9K_DEBUG_EXPORT int
e9k_debug_is_paused(void)
{
	return e9k_debug_paused;
}

E9K_DEBUG_EXPORT void
e9k_debug_step_instr(void)
{
	e9k_debug_paused = 0;
	e9k_debug_stepLine = 0;
	e9k_debug_stepNext = 0;
	e9k_debug_stepNextSkipOnce = 0;
	e9k_debug_stepOut = 0;
	e9k_debug_stepOutSkipOnce = 0;
	e9k_debug_stepIntoPending = 0;
	e9k_debug_stepInstr = 1;
	e9k_debug_stepInstrAfter = 0;
}

E9K_DEBUG_EXPORT void
e9k_debug_step_line(void)
{
	e9k_debug_paused = 0;
	e9k_debug_stepInstr = 0;
	e9k_debug_stepInstrAfter = 0;
	e9k_debug_stepLine = 1;
	e9k_debug_stepNext = 0;
	e9k_debug_stepNextSkipOnce = 0;
	e9k_debug_stepOut = 0;
	e9k_debug_stepOutSkipOnce = 0;
	e9k_debug_stepIntoPending = 0;
}

E9K_DEBUG_EXPORT void
e9k_debug_step_next(void)
{
	e9k_debug_paused = 0;
	e9k_debug_stepInstr = 0;
	e9k_debug_stepInstrAfter = 0;
	e9k_debug_stepLine = 1;
	e9k_debug_stepNext = 1;
	e9k_debug_stepNextSkipOnce = 0;
	e9k_debug_stepOut = 0;
	e9k_debug_stepOutSkipOnce = 0;
	e9k_debug_stepIntoPending = 0;
}

E9K_DEBUG_EXPORT void
e9k_debug_step_out(void)
{
	e9k_debug_paused = 0;
	e9k_debug_stepInstr = 0;
	e9k_debug_stepInstrAfter = 0;
	e9k_debug_stepLine = 1;
	e9k_debug_stepNext = 0;
	e9k_debug_stepNextSkipOnce = 0;
	e9k_debug_stepOut = 1;
	e9k_debug_stepOutSkipOnce = 0;
	e9k_debug_stepIntoPending = 0;
}

E9K_DEBUG_EXPORT size_t
e9k_debug_read_callstack(uint32_t *out, size_t cap)
{
	if (!out || cap == 0) {
		return 0;
	}
	size_t count = e9k_debug_callstackDepth;
	if (count > cap) {
		count = cap;
	}
	for (size_t i = 0; i < count; ++i) {
		out[i] = e9k_debug_callstack[i];
	}
	return count;
}

E9K_DEBUG_EXPORT size_t
e9k_debug_read_regs(uint32_t *out, size_t cap)
{
	if (!out || cap == 0) {
		return 0;
	}
	MakeSR();
	size_t count = 0;
	for (int i = 0; i < 16 && count < cap; ++i) {
		out[count++] = regs.regs[i];
	}
	if (count < cap) {
		out[count++] = regs.sr;
	}
	if (count < cap) {
		out[count++] = e9k_debug_maskAddr(m68k_getpc());
	}
	if (count < cap) {
		// USP: live in regs.regs[15]/A7 when in user mode (regs.s == 0),
		// otherwise stashed in the regs.usp shadow register.
		out[count++] = regs.s ? regs.usp : m68k_areg(regs, 7);
	}
	return count;
}

E9K_DEBUG_EXPORT int
e9k_debug_write_reg(uint32_t regnum, uint32_t value)
{
	if (regnum < 16) {
		regs.regs[regnum] = value;
		return 0;
	}
	if (regnum == 16) {
		regs.sr = (uae_u16)value;
		MakeFromSR();
		return 0;
	}
	if (regnum == 17) {
		m68k_setpc((uaecptr)value);
		// m68k_setpc() repoints the direct-fetch pointers (pc_p/pc_oldp) but
		// leaves the 68000's two-word prefetch queue (regs.ir/regs.irc)
		// holding whatever was fetched from the OLD pc. Without this, the
		// CPU executes 1-2 stale prefetched opcodes from the old location
		// before the new pc takes effect, which silently corrupts the
		// debugger's "jump to address" / fastLoad-injection use cases.
		fill_prefetch();
		return 0;
	}
	if (regnum == 18) {
		// USP: same live-vs-shadow convention as e9k_debug_read_regs.
		if (regs.s) {
			regs.usp = (uaecptr)value;
		} else {
			m68k_areg(regs, 7) = (uaecptr)value;
		}
		return 0;
	}
	return -1;
}

E9K_DEBUG_EXPORT size_t
e9k_debug_read_memory(uint32_t addr, uint8_t *out, size_t cap)
{
	if (!out || cap == 0) {
		return 0;
	}
	e9k_debug_watchpointSuspend++;
	puae_debug_inspect_active++;
	uaecptr base = (uaecptr)addr;
	for (size_t i = 0; i < cap; ++i) {
		out[i] = (uint8_t)get_byte_debug(munge24(base + (uaecptr)i));
	}
	puae_debug_inspect_active--;
	e9k_debug_watchpointSuspend--;
	return cap;
}

E9K_DEBUG_EXPORT int
e9k_debug_write_memory(uint32_t addr, uint32_t value, size_t size)
{
	e9k_debug_watchpointSuspend++;
	uaecptr a = munge24((uaecptr)addr);
	if (size == 1) {
		put_byte(a, value & 0xffu);
		e9k_debug_watchpointSuspend--;
		return 1;
	}
	if (size == 2) {
		put_word(a, value & 0xffffu);
		e9k_debug_watchpointSuspend--;
		return 1;
	}
	if (size == 4) {
		put_long(a, value);
		e9k_debug_watchpointSuspend--;
		return 1;
	}
	e9k_debug_watchpointSuspend--;
	return 0;
}

E9K_DEBUG_EXPORT size_t
e9k_debug_write_memory_buf(uint32_t addr, const uint8_t *data, size_t len)
{
	if (!data) {
		return 0;
	}
	e9k_debug_watchpointSuspend++;
	uaecptr base = (uaecptr)addr;
	for (size_t i = 0; i < len; ++i) {
		put_byte(munge24(base + (uaecptr)i), data[i]);
	}
	e9k_debug_watchpointSuspend--;
	return len;
}

// Unlike e9k_debug_write_memory/read_memory (which suspend
// watchpoint/protect checks, since they're meant for debugger-side memory
// inspection/poking that shouldn't trigger breaks intended for the target
// program), these go through the normal CPU-visible accessors so that
// watchpoints/protects fire as if the target program performed the access.
// Used by tests to exercise the memhooks deterministically.
E9K_DEBUG_EXPORT int
e9k_debug_poke_memory(uint32_t addr, uint32_t value, size_t size)
{
	uaecptr a = munge24((uaecptr)addr);
	if (size == 1) {
		put_byte(a, value & 0xffu);
		return 1;
	}
	if (size == 2) {
		put_word(a, value & 0xffffu);
		return 1;
	}
	if (size == 4) {
		put_long(a, value);
		return 1;
	}
	return 0;
}

E9K_DEBUG_EXPORT size_t
e9k_debug_peek_memory(uint32_t addr, uint8_t *out, size_t cap)
{
	if (!out || cap == 0) {
		return 0;
	}
	puae_debug_inspect_active++;
	uaecptr base = (uaecptr)addr;
	for (size_t i = 0; i < cap; ++i) {
		out[i] = (uint8_t)get_byte(munge24(base + (uaecptr)i));
	}
	puae_debug_inspect_active--;
	return cap;
}

// Numeric values mirror src/vAmiga.ts's MemSrc enum.
#define E9K_MEMSRC_NONE          0
#define E9K_MEMSRC_CHIP          1
#define E9K_MEMSRC_CHIP_MIRROR   2
#define E9K_MEMSRC_SLOW          3
#define E9K_MEMSRC_SLOW_MIRROR   4
#define E9K_MEMSRC_FAST          5
#define E9K_MEMSRC_CIA           6
#define E9K_MEMSRC_CIA_MIRROR    7
#define E9K_MEMSRC_CUSTOM        9
#define E9K_MEMSRC_CUSTOM_MIRROR 10
#define E9K_MEMSRC_ROM           13
#define E9K_MEMSRC_ROM_MIRROR    14
#define E9K_MEMSRC_EXT           16

E9K_DEBUG_EXPORT size_t
e9k_debug_read_memory_map(uint8_t *out, size_t cap)
{
	if (!out) {
		return 0;
	}
	size_t count = (cap < 256) ? cap : 256;

	// Tracks the first bank pointer seen for each classified type, so later
	// banks backed by the same addrbank (e.g. chip RAM mirrors above
	// 0x200000 on a 512KB/1MB Agnus) report the "_MIRROR" variant.
	const addrbank *seenBank[8];
	size_t seenCount = 0;

	for (size_t i = 0; i < count; ++i) {
		const addrbank *b = mem_banks[i];
		uint8_t cls = E9K_MEMSRC_NONE;

		if (b == &chipmem_bank) {
			cls = E9K_MEMSRC_CHIP;
		} else if (b == &kickmem_bank) {
			cls = E9K_MEMSRC_ROM;
		} else if (b == &custom_bank) {
			cls = E9K_MEMSRC_CUSTOM;
		} else if (b == &cia_bank) {
			cls = E9K_MEMSRC_CIA;
		} else if (b == &bogomem_bank) {
			cls = E9K_MEMSRC_SLOW;
		} else if (b == &extendedkickmem_bank) {
			cls = E9K_MEMSRC_EXT;
		} else {
			for (int f = 0; f < MAX_RAM_BOARDS; ++f) {
				if (b == &fastmem_bank[f]) {
					cls = E9K_MEMSRC_FAST;
					break;
				}
			}
		}

		if (cls != E9K_MEMSRC_NONE && cls != E9K_MEMSRC_FAST) {
			int mirror = 0;
			for (size_t s = 0; s < seenCount; ++s) {
				if (seenBank[s] == b) {
					mirror = 1;
					break;
				}
			}
			if (mirror) {
				switch (cls) {
					case E9K_MEMSRC_CHIP:   cls = E9K_MEMSRC_CHIP_MIRROR; break;
					case E9K_MEMSRC_ROM:    cls = E9K_MEMSRC_ROM_MIRROR; break;
					case E9K_MEMSRC_CUSTOM: cls = E9K_MEMSRC_CUSTOM_MIRROR; break;
					case E9K_MEMSRC_CIA:    cls = E9K_MEMSRC_CIA_MIRROR; break;
					default: break;
				}
			} else if (seenCount < 8) {
				seenBank[seenCount] = b;
				seenCount++;
			}
		}

		out[i] = cls;
	}
	return count;
}

E9K_DEBUG_EXPORT size_t
e9k_debug_disassemble_quick(uint32_t pc, char *out, size_t cap)
{
	if (!out || cap == 0) {
		return 0;
	}
	e9k_debug_watchpointSuspend++;
	uaecptr nextpc = 0xffffffffu;
	int bufsize = (cap > 0x7fffffffU) ? 0x7fffffff : (int)cap;
	uaecptr addr = munge24((uaecptr)pc);
	m68k_disasm_2(out, bufsize, addr, NULL, 0, &nextpc, 1, NULL, NULL, 0xffffffffu, 0);
	out[bufsize - 1] = '\0';

	if (nextpc != 0xffffffffu && nextpc > addr) {
		e9k_debug_watchpointSuspend--;
		return (size_t)(nextpc - addr);
	}
	e9k_debug_watchpointSuspend--;
	return 2;
}

E9K_DEBUG_EXPORT uint64_t
puae_debug_read_instr_count(void)
{
	return puae_debug_instrCount;
}

// puae_debug_instrCount is not part of the libretro savestate (retro_serialize
// /retro_unserialize): after restoring a checkpoint, the caller must restore
// the instrCount that was recorded alongside that checkpoint via this setter.
E9K_DEBUG_EXPORT void
puae_debug_write_instr_count(uint64_t value)
{
	puae_debug_instrCount = value;
}

int
puae_debug_is_replaying(void)
{
	return puae_debug_replayMode;
}

int
puae_debug_is_replay_video_enabled(void)
{
	return puae_debug_replayVideoEnabled;
}

// Runs forward exactly `count` retired instructions from the current state
// (normally immediately after restoring a checkpoint), with debugger
// side-effects (watchpoints, catchpoints, profiler sampling, audio/video
// output, frame count, callstack bookkeeping, step/breakpoint handling) all
// suppressed via puae_debug_replayMode. Leaves the CPU paused with
// puae_debug_instrCount advanced by exactly `count`.
//
// If count == 0, this is a no-op: in particular it does NOT clear
// e9k_debug_stepInstrAfter, so a pending "exact restore, zero drift" request
// from puae_debug_request_break_before_next_instr (set by wasm_unserialize)
// is preserved.
E9K_DEBUG_EXPORT void
puae_debug_replay_instructions(uint32_t count)
{
	if (count == 0) {
		return;
	}
	// A pending zero-drift "break before next instr" would otherwise abort
	// before the first replayed instruction executes.
	e9k_debug_stepInstrAfter = 0;
	puae_debug_replayMode = 1;
	puae_debug_replayTarget = puae_debug_instrCount + (uint64_t)count;
	e9k_debug_paused = 0;
	while (puae_debug_instrCount < puae_debug_replayTarget) {
		libretro_frame_end = false;
		retro_run();
	}
	puae_debug_replayMode = 0;
}

// Like puae_debug_replay_instructions, but shim_video_refresh
// (frontend_shim.c) is allowed to update the pixel buffer/frame count for
// frames rendered during the replay (e9k_vblank_notify's per-frame debugger
// hooks remain suppressed, as in plain replay). Used for the final "land on
// target" replay of stepBack/continueReverse/stepBackFrame, so the on-screen
// framebuffer reflects the landed-on state rather than whatever was on screen
// before the rewind.
E9K_DEBUG_EXPORT void
puae_debug_replay_instructions_video(uint32_t count)
{
	puae_debug_replayVideoEnabled = 1;
	puae_debug_replay_instructions(count);
	puae_debug_replayVideoEnabled = 0;
}

// Like puae_debug_replay_instructions, but also records the instrCount of the
// latest (most recent in forward time) instruction within the replayed range
// whose PC has a breakpoint set. Returns that instrCount, or (uint64_t)-1 if
// none matched. Used by continueReverse to find where to land.
E9K_DEBUG_EXPORT uint64_t
puae_debug_replay_scan(uint32_t count)
{
	if (count == 0) {
		return (uint64_t)-1;
	}
	puae_debug_scanMode = 1;
	puae_debug_scanLastMatch = (uint64_t)-1;
	puae_debug_replay_instructions(count);
	puae_debug_scanMode = 0;
	return puae_debug_scanLastMatch;
}

// Combined scan + video: like puae_debug_replay_scan but also enables
// replayVideoEnabled so the framebuffer is updated during the same pass.
// Avoids the second restore+replay that continueReverse's separate scan and
// render passes would otherwise require.
E9K_DEBUG_EXPORT uint64_t
puae_debug_replay_scan_video(uint32_t count)
{
	if (count == 0) {
		return (uint64_t)-1;
	}
	puae_debug_scanMode = 1;
	puae_debug_scanLastMatch = (uint64_t)-1;
	puae_debug_replayVideoEnabled = 1;
	puae_debug_replay_instructions(count);
	puae_debug_scanMode = 0;
	puae_debug_replayVideoEnabled = 0;
	return puae_debug_scanLastMatch;
}

// Like puae_debug_replay_scan, but records the instrCount of the most recent
// frame boundary (vblank) crossed during the replay range, for
// stepBackFrame. Returns (uint64_t)-1 if no frame boundary was crossed.
E9K_DEBUG_EXPORT uint64_t
puae_debug_replay_scan_frame(uint32_t count)
{
	if (count == 0) {
		return (uint64_t)-1;
	}
	puae_debug_scanFrameMode = 1;
	puae_debug_scanLastMatch = (uint64_t)-1;
	puae_debug_replay_instructions(count);
	puae_debug_scanFrameMode = 0;
	return puae_debug_scanLastMatch;
}

// e9k-debugger (Phase 2): the libretro savestate format does not preserve
// eventtab[ev_hsync]/[ev_hsynch]/[ev_misc] phase info, nor the vpos/lof_*
// scanline-position state derived from it. On restore, init_eventtab() (via
// devices_reset(), part of retro_unserialize's reset path) resyncs
// ev_hsync/ev_hsynch to `get_cycles() + HSYNCTIME`, discarding the actual
// "cycles into the current scanline" phase that existed when the snapshot
// was taken; vpos/lof_store/lof_display aren't touched by retro_unserialize
// at all, so they retain whatever value the emulator instance had *before*
// the restore (e.g. a "future" vpos from continued execution), inconsistent
// with the restored cycle/event state. For checkpoints captured mid-line
// (not at a real savestate sync point, as ours are), this introduces a
// constant offset that persists across replay even though
// currcycle/CIA/intena/intreq all match exactly - causing replay to diverge
// from ground truth after enough instructions (observed: a `vpos`-polling
// loop exits one scanline later in replay than in ground truth). Capture/
// restore this phase out-of-band, alongside the regular libretro savestate
// blob (see wasm_serialize/wasm_unserialize in frontend_shim.c). Layout:
// 3 events (ev_hsync, ev_hsynch, ev_misc) x 5 words (active, evtime lo/hi,
// oldcycles lo/hi), then vpos, lof_store, lof_display.
// (PUAE_DEBUG_EVENT_PHASE_WORDS is defined in puae_debug.h)
E9K_DEBUG_EXPORT void
puae_debug_capture_event_phase(uint32_t *out)
{
	int i = 0;
	for (int e = ev_hsync; e <= ev_misc; e++) {
		out[i++] = (uint32_t)eventtab[e].active;
		out[i++] = (uint32_t)((uint64_t)eventtab[e].evtime & 0xFFFFFFFFu);
		out[i++] = (uint32_t)((uint64_t)eventtab[e].evtime >> 32);
		out[i++] = (uint32_t)((uint64_t)eventtab[e].oldcycles & 0xFFFFFFFFu);
		out[i++] = (uint32_t)((uint64_t)eventtab[e].oldcycles >> 32);
	}
	out[i++] = (uint32_t)vpos;
	out[i++] = (uint32_t)lof_store;
	out[i++] = (uint32_t)lof_display;
}

E9K_DEBUG_EXPORT void
puae_debug_restore_event_phase(const uint32_t *in)
{
	int i = 0;
	for (int e = ev_hsync; e <= ev_misc; e++) {
		eventtab[e].active = in[i++] ? true : false;
		uint64_t evtime = (uint64_t)in[i] | ((uint64_t)in[i + 1] << 32);
		i += 2;
		uint64_t oldcycles = (uint64_t)in[i] | ((uint64_t)in[i + 1] << 32);
		i += 2;
		eventtab[e].evtime = (evt_t)evtime;
		eventtab[e].oldcycles = (evt_t)oldcycles;
	}
	vpos = (int)in[i++];
	lof_store = (int)in[i++];
	lof_display = (int)in[i++];
	events_schedule();
}

E9K_DEBUG_EXPORT uint64_t
e9k_debug_read_cycle_count(void)
{
	// get_cycles() returns UAE internal "cycle units" (CYCLE_UNIT = 512), not raw CPU cycles.
	// Convert to a more intuitive cycle count for the debugger UI.
	evt_t c = get_cycles();
	if (CYCLE_UNIT > 0) {
		return (uint64_t)(c / (evt_t)CYCLE_UNIT);
	}
	return (uint64_t)c;
}

E9K_DEBUG_EXPORT size_t
e9k_debug_read_display_regs(uint16_t *out, size_t cap)
{
	if (!out || cap < E9K_DISPLAY_REG_COUNT) {
		return 0;
	}
	e9k_get_display_regs(out);
	return E9K_DISPLAY_REG_COUNT;
}

E9K_DEBUG_EXPORT size_t
e9k_debug_read_custom_regs_raw(uint8_t *out, size_t cap)
{
	if (!out || cap < E9K_CUSTOM_REGS_RAW_SIZE) {
		return 0;
	}
	e9k_get_custom_regs_raw(out);
	return E9K_CUSTOM_REGS_RAW_SIZE;
}

E9K_DEBUG_EXPORT size_t
e9k_debug_read_audio_regs(uint8_t *out, size_t cap)
{
	if (!out || cap < E9K_AUDIO_REGS_SIZE) {
		return 0;
	}
	e9k_get_audio_regs_raw(out);
	return E9K_AUDIO_REGS_SIZE;
}

E9K_DEBUG_EXPORT void
e9k_debug_add_breakpoint(uint32_t addr)
{
	uint32_t addr24 = e9k_debug_maskAddr((uaecptr)addr);
	if (e9k_debug_hasBreakpoint(addr24)) {
		return;
	}
	if (e9k_debug_breakpointCount >= E9K_DEBUG_BREAKPOINT_MAX) {
		return;
	}
	e9k_debug_breakpoints[e9k_debug_breakpointCount++] = addr24;
}

E9K_DEBUG_EXPORT void
e9k_debug_remove_breakpoint(uint32_t addr)
{
	uint32_t addr24 = e9k_debug_maskAddr((uaecptr)addr);
	for (size_t i = 0; i < e9k_debug_breakpointCount; ++i) {
		if (e9k_debug_breakpoints[i] == addr24) {
			size_t remain = e9k_debug_breakpointCount - (i + 1u);
			if (remain) {
				memmove(&e9k_debug_breakpoints[i], &e9k_debug_breakpoints[i + 1u], remain * sizeof(e9k_debug_breakpoints[0]));
			}
			e9k_debug_breakpointCount--;
			return;
		}
	}
}

static size_t puae_debug_breakpointCountSuspended = 0;

// retro_unserialize's restore path is sensitive to e9k_debug_breakpointCount:
// restoring a checkpoint with a breakpoint registered measurably perturbs
// chipset cycle timing, shifting a subsequent puae_debug_replay_instructions/
// replay_scan landing by a variable number of instructions (root cause not
// isolated further than this). Since breakpoints are meaningless mid-restore
// anyway (replay mode bypasses e9k_debug_hasBreakpoint entirely),
// wasm_unserialize suspends them across retro_unserialize and restores them
// immediately afterwards.
void
puae_debug_suspend_breakpoints(void)
{
	puae_debug_breakpointCountSuspended = e9k_debug_breakpointCount;
	e9k_debug_breakpointCount = 0;
}

void
puae_debug_resume_breakpoints(void)
{
	e9k_debug_breakpointCount = puae_debug_breakpointCountSuspended;
}

E9K_DEBUG_EXPORT void
e9k_debug_add_temp_breakpoint(uint32_t addr)
{
	uint32_t addr24 = e9k_debug_maskAddr((uaecptr)addr);
	for (size_t i = 0; i < e9k_debug_tempBreakpointCount; ++i) {
		if (e9k_debug_tempBreakpoints[i] == addr24) {
			return;
		}
	}
	if (e9k_debug_tempBreakpointCount >= E9K_DEBUG_BREAKPOINT_MAX) {
		return;
	}
	e9k_debug_tempBreakpoints[e9k_debug_tempBreakpointCount++] = addr24;
}

E9K_DEBUG_EXPORT void
e9k_debug_remove_temp_breakpoint(uint32_t addr)
{
	uint32_t addr24 = e9k_debug_maskAddr((uaecptr)addr);
	(void)e9k_debug_consumeTempBreakpoint(addr24);
}

E9K_DEBUG_EXPORT void
e9k_debug_set_vblank_callback(void (*cb)(void *), void *user)
{
	e9k_debug_vblankCb = cb;
	e9k_debug_vblankUser = user;
}

E9K_DEBUG_EXPORT void
e9k_debug_set_hblank_callback(void (*cb)(void *), void *user)
{
	e9k_debug_hblankCb = cb;
	e9k_debug_hblankUser = user;
}

E9K_DEBUG_EXPORT void
e9k_vblank_notify(void)
{
	if (e9k_debug_protectEnabledMask || e9k_debug_watchpointEnabledMask) {
	}
	if (e9k_debug_profilerEnabled && !e9k_debug_paused) {
		if (e9k_debug_prof_tick == e9k_debug_prof_lastTickAtFrame) {
			uaecptr pc = m68k_getpc();
			e9k_debug_profiler_samplePc(e9k_debug_maskAddr(pc));
		}
		e9k_debug_prof_lastTickAtFrame = e9k_debug_prof_tick;
	}
	if (e9k_debug_vblankCb) {
		e9k_debug_vblankCb(e9k_debug_vblankUser);
	}
}

E9K_DEBUG_EXPORT void
e9k_hsync_notify(void)
{
	if (e9k_debug_hblankCb) {
		e9k_debug_hblankCb(e9k_debug_hblankUser);
	}
}

// Called from hsync_handler() (custom.c) on the scanline where a new frame's
// vblank starts — including during replay (unlike e9k_vblank_notify, which
// is suppressed then). Used by puae_debug_replay_scan_frame to find the most
// recent frame boundary within a replayed range, for stepBackFrame.
E9K_DEBUG_EXPORT void
puae_debug_frame_boundary_notify(void)
{
	if (puae_debug_replayMode && puae_debug_scanFrameMode) {
		puae_debug_scanLastMatch = puae_debug_instrCount;
	}
}

static void
e9k_debug_requestBreak(void)
{
	e9k_debug_paused = 1;
	e9k_debug_stepInstr = 0;
	e9k_debug_stepInstrAfter = 0;
	e9k_debug_stepLine = 0;
	e9k_debug_stepNext = 0;
	e9k_debug_stepNextSkipOnce = 0;
	e9k_debug_stepOut = 0;
	e9k_debug_stepOutSkipOnce = 0;
	e9k_debug_stepIntoPending = 0;
	libretro_frame_end = true;
	set_special(SPCFLAG_BRK);
}

static void
e9k_debug_watchpointRead(uint32_t addr24, uint32_t value, uint32_t sizeBits)
{
	if (e9k_debug_watchpointSuspend > 0) {
		return;
	}
	if (e9k_debug_paused) {
		return;
	}
	if (puae_debug_replayMode) {
		// Replay re-executes real memory accesses; watchpoints must not refire.
		return;
	}
	if (e9k_debug_watchpointEnabledMask == 0) {
		return;
	}

	for (uint32_t index = 0; index < E9K_WATCHPOINT_COUNT; ++index) {
		if ((e9k_debug_watchpointEnabledMask & (1ull << index)) == 0ull) {
			continue;
		}
		if (e9k_debug_watchpointMatch(&e9k_debug_watchpoints[index], addr24, E9K_WATCH_ACCESS_READ, sizeBits, value, value, 1)) {
			e9k_debug_watchbreakRequest(index, addr24, E9K_WATCH_ACCESS_READ, sizeBits, value, value, 1);
			return;
		}
	}
}

static void
e9k_debug_watchpointWrite(uint32_t addr24, uint32_t value, uint32_t oldValue, uint32_t sizeBits, int oldValueValid)
{
	if (e9k_debug_watchpointSuspend > 0) {
		return;
	}
	if (e9k_debug_paused) {
		return;
	}
	if (puae_debug_replayMode) {
		// Replay re-executes real memory accesses; watchpoints must not refire.
		return;
	}
	if (e9k_debug_watchpointEnabledMask == 0) {
		return;
	}

	for (uint32_t index = 0; index < E9K_WATCHPOINT_COUNT; ++index) {
		if ((e9k_debug_watchpointEnabledMask & (1ull << index)) == 0ull) {
			continue;
		}
		if (e9k_debug_watchpointMatch(&e9k_debug_watchpoints[index], addr24, E9K_WATCH_ACCESS_WRITE, sizeBits, value, oldValue, oldValueValid)) {
			e9k_debug_watchbreakRequest(index, addr24, E9K_WATCH_ACCESS_WRITE, sizeBits, value, oldValue, oldValueValid);
			return;
		}
	}
}

static int
e9k_debug_protectFilterWrite(uint32_t addr24, uint32_t sizeBits, uint32_t oldValue, int oldValueValid, uint32_t *inoutValue)
{
	if (!inoutValue) {
		return 1;
	}
	if (e9k_debug_watchpointSuspend > 0) {
		return 1;
	}
	if (e9k_debug_protectEnabledMask == 0) {
		return 1;
	}

	uint32_t sizeBytes = e9k_debug_sizeBytes(sizeBits);
	if (sizeBytes == 0u) {
		return 1;
	}

	uint8_t bytes[4] = {0};
	uint8_t oldBytes[4] = {0};
	uint32_t v = e9k_debug_maskValue(*inoutValue, sizeBits);
	uint32_t ov = e9k_debug_maskValue(oldValue, sizeBits);

	for (uint32_t i = 0; i < sizeBytes; ++i) {
		uint32_t shift = (sizeBytes - 1u - i) * 8u;
		bytes[i] = (uint8_t)((v >> shift) & 0xffu);
		if (oldValueValid) {
			oldBytes[i] = (uint8_t)((ov >> shift) & 0xffu);
		}
	}

	for (uint32_t entryIndex = 0; entryIndex < E9K_PROTECT_COUNT; ++entryIndex) {
		if ((e9k_debug_protectEnabledMask & (1ull << entryIndex)) == 0ull) {
			continue;
		}
		const e9k_debug_protect_t *p = &e9k_debug_protects[entryIndex];
		if (p->mode != E9K_PROTECT_MODE_BLOCK) {
			continue;
		}
		uint32_t pSizeBytes = e9k_debug_sizeBytes(p->sizeBits);
		if (pSizeBytes == 0u) {
			continue;
		}
		uint32_t mask = p->addrMask ? p->addrMask : 0x00ffffffu;
		for (uint32_t writeIndex = 0; writeIndex < sizeBytes; ++writeIndex) {
			uint32_t writeAddr = (addr24 + writeIndex) & 0x00ffffffu;
			for (uint32_t byteIndex = 0; byteIndex < pSizeBytes; ++byteIndex) {
				uint32_t pa = (p->addr + byteIndex) & 0x00ffffffu;
				if ((writeAddr & mask) == (pa & mask)) {
					if (oldValueValid) {
						*inoutValue = ov;
						return 1;
					}
					return 0;
				}
			}
		}
	}

	for (uint32_t writeIndex = 0; writeIndex < sizeBytes; ++writeIndex) {
		uint32_t writeAddr = (addr24 + writeIndex) & 0x00ffffffu;
		for (uint32_t entryIndex = 0; entryIndex < E9K_PROTECT_COUNT; ++entryIndex) {
			if ((e9k_debug_protectEnabledMask & (1ull << entryIndex)) == 0ull) {
				continue;
			}
			const e9k_debug_protect_t *p = &e9k_debug_protects[entryIndex];
			if (p->mode != E9K_PROTECT_MODE_SET) {
				continue;
			}
			uint32_t pSizeBytes = e9k_debug_sizeBytes(p->sizeBits);
			if (pSizeBytes == 0u) {
				continue;
			}

			uint32_t mask = p->addrMask ? p->addrMask : 0x00ffffffu;
			for (uint32_t byteIndex = 0; byteIndex < pSizeBytes; ++byteIndex) {
				uint32_t pa = (p->addr + byteIndex) & 0x00ffffffu;
				if ((writeAddr & mask) != (pa & mask)) {
					continue;
				}

				if (p->mode == E9K_PROTECT_MODE_SET) {
					uint32_t pshift = (pSizeBytes - 1u - byteIndex) * 8u;
					bytes[writeIndex] = (uint8_t)((p->value >> pshift) & 0xffu);
				}
				goto next_write_byte;
			}
		}
next_write_byte:
		;
	}

	uint32_t outValue = 0;
	for (uint32_t i = 0; i < sizeBytes; ++i) {
		outValue = (outValue << 8) | (uint32_t)bytes[i];
	}
	*inoutValue = outValue;
	return 1;
}

E9K_DEBUG_EXPORT void
e9k_debug_memhook_afterRead(uint32_t addr24, uint32_t value, uint32_t sizeBits)
{
	addr24 &= 0x00ffffffu;
	e9k_debug_watchpointRead(addr24, value, sizeBits);
}

E9K_DEBUG_EXPORT int
e9k_debug_memhook_filterWrite(uint32_t addr24, uint32_t sizeBits, uint32_t oldValue, int oldValueValid, uint32_t *inoutValue)
{
	addr24 &= 0x00ffffffu;
	return e9k_debug_protectFilterWrite(addr24, sizeBits, oldValue, oldValueValid, inoutValue);
}

E9K_DEBUG_EXPORT void
e9k_debug_memhook_afterWrite(uint32_t addr24, uint32_t value, uint32_t oldValue, uint32_t sizeBits, int oldValueValid)
{
	addr24 &= 0x00ffffffu;
	e9k_debug_watchpointWrite(addr24, value, oldValue, sizeBits, oldValueValid);
}

static int
e9k_debug_instructionHookImpl(uaecptr pc, uae_u16 opcode)
{
	uint32_t pc24 = e9k_debug_maskAddr(pc);

	e9k_debug_profiler_instrHook(pc24);
	wasm_profile_instrHook(pc24);
	e9k_debug_cpuTrace_instrHook(pc24);

	if (e9k_debug_stepInstrAfter) {
		e9k_debug_requestBreak();
		return 1;
	}

	if (puae_debug_replayMode) {
		// Bypass all normal step/breakpoint/callstack handling: replay always
		// runs to an exact instruction count (puae_debug_replayTarget).
		if (puae_debug_scanMode && e9k_debug_hasBreakpoint(pc24)) {
			// Record the latest (in forward time) match; continueReverse wants
			// the most recent breakpoint hit within the replayed range.
			puae_debug_scanLastMatch = puae_debug_instrCount;
		}
		if (puae_debug_instrCount >= puae_debug_replayTarget) {
			e9k_debug_requestBreak();
			return 1;
		}
		return 0;
	}

	if ((opcode & 0xFFC0u) == 0x4E80u) {
		int mode = (opcode >> 3) & 7;
		int reg = opcode & 7;
		int ext = 0;
		if (mode == 5 || mode == 6) {
			ext = 2;
		} else if (mode == 7) {
			if (reg == 0 || reg == 2 || reg == 3) {
				ext = 2;
			} else if (reg == 1) {
				ext = 4;
			} else {
				ext = -1;
			}
		} else if (mode < 2) {
			ext = -1;
		}
		if (ext >= 0) {
			if (e9k_debug_callstackDepth < E9K_DEBUG_CALLSTACK_MAX) {
				e9k_debug_callstack[e9k_debug_callstackDepth++] = pc24;
			}
		}
	} else if ((opcode & 0xFF00u) == 0x6100u) {
		if (e9k_debug_callstackDepth < E9K_DEBUG_CALLSTACK_MAX) {
			e9k_debug_callstack[e9k_debug_callstackDepth++] = pc24;
		}
	} else if (opcode == 0x4E75u || opcode == 0x4E74u || opcode == 0x4E73u || opcode == 0x4E77u) {
		if (e9k_debug_callstackDepth > 0) {
			e9k_debug_callstackDepth--;
		}
		if (e9k_debug_stepNext) {
			e9k_debug_stepNextSkipOnce = 1;
		}
		if (e9k_debug_stepOut) {
			e9k_debug_stepOutSkipOnce = 1;
		}
	}

	if (e9k_debug_stepInstr) {
		e9k_debug_stepInstr = 0;
		e9k_debug_stepInstrAfter = 1;
		return 0;
	}
	if (e9k_debug_stepLine && !e9k_debug_stepNext && !e9k_debug_stepOut) {
		if (e9k_debug_stepIntoPending) {
			e9k_debug_stepIntoPending = 0;
			e9k_debug_requestBreak();
			return 1;
		}
		uint32_t returnPc = 0;
		if (e9k_debug_tryGetCallReturnPc(pc24, opcode, &returnPc)) {
			e9k_debug_stepIntoPending = 1;
			return 0;
		}
	}

	if (e9k_debug_stepNext && e9k_debug_stepNextSkipOnce) {
		e9k_debug_stepNextSkipOnce = 0;
		return 0;
	}
	if (e9k_debug_stepOut && e9k_debug_stepOutSkipOnce) {
		e9k_debug_stepOutSkipOnce = 0;
		return 0;
	}

	if (e9k_debug_skipBreakpointOnce) {
		e9k_debug_skipBreakpointOnce = 0;
		if (pc24 == e9k_debug_skipBreakpointPc) {
			return 0;
		}
	}

	if (e9k_debug_consumeTempBreakpoint(pc24) || e9k_debug_hasBreakpoint(pc24)) {
		e9k_debug_requestBreak();
		return 1;
	}

	return 0;
}

E9K_DEBUG_EXPORT int
e9k_debug_instructionHook(uaecptr pc, uae_u16 opcode)
{
	int brk = e9k_debug_instructionHookImpl(pc, opcode);
	if (!brk) {
		// Only count instructions that actually execute: instrCount tracks
		// "number of retired instructions", i.e. the index of the
		// not-yet-executed instruction at the current PC.
		puae_debug_instrCount++;
	}
	return brk;
}

E9K_DEBUG_EXPORT void
e9k_debug_reset_watchpoints(void)
{
	memset(e9k_debug_watchpoints, 0, sizeof(e9k_debug_watchpoints));
	e9k_debug_watchpointEnabledMask = 0;
	memset(&e9k_debug_watchbreak, 0, sizeof(e9k_debug_watchbreak));
	e9k_debug_watchbreakPending = 0;
	e9k_debug_watchpointSuspend = 0;
}

E9K_DEBUG_EXPORT int
e9k_debug_add_watchpoint(uint32_t addr, uint32_t op_mask, uint32_t diff_operand, uint32_t value_operand,
                         uint32_t old_value_operand, uint32_t size_operand, uint32_t addr_mask_operand)
{
	if (!e9k_debug_memhooksEnabled) {
		return -1;
	}
	for (uint32_t i = 0; i < E9K_WATCHPOINT_COUNT; ++i) {
		uint64_t bit = 1ull << i;
		if ((e9k_debug_watchpointEnabledMask & bit) != 0ull) {
			continue;
		}
		if (e9k_debug_watchpoints[i].op_mask != 0u) {
			continue;
		}
		e9k_debug_watchpoints[i].addr = addr & 0x00ffffffu;
		e9k_debug_watchpoints[i].op_mask = op_mask;
		e9k_debug_watchpoints[i].diff_operand = diff_operand;
		e9k_debug_watchpoints[i].value_operand = value_operand;
		e9k_debug_watchpoints[i].old_value_operand = old_value_operand;
		e9k_debug_watchpoints[i].size_operand = size_operand;
		e9k_debug_watchpoints[i].addr_mask_operand = addr_mask_operand;
		e9k_debug_watchpointEnabledMask |= bit;
		return (int)i;
	}
	return -1;
}

E9K_DEBUG_EXPORT void
e9k_debug_remove_watchpoint(uint32_t index)
{
	if (index >= E9K_WATCHPOINT_COUNT) {
		return;
	}
	e9k_debug_watchpointEnabledMask &= ~(1ull << index);
	memset(&e9k_debug_watchpoints[index], 0, sizeof(e9k_debug_watchpoints[index]));
}

E9K_DEBUG_EXPORT size_t
e9k_debug_read_watchpoints(e9k_debug_watchpoint_t *out, size_t cap)
{
	if (!out || cap == 0) {
		return 0;
	}
	size_t count = E9K_WATCHPOINT_COUNT;
	if (count > cap) {
		count = cap;
	}
	memcpy(out, e9k_debug_watchpoints, count * sizeof(out[0]));
	return count;
}

E9K_DEBUG_EXPORT uint64_t
e9k_debug_get_watchpoint_enabled_mask(void)
{
	return e9k_debug_watchpointEnabledMask;
}

E9K_DEBUG_EXPORT void
e9k_debug_set_watchpoint_enabled_mask(uint64_t mask)
{
	if (mask) {
		if (!e9k_debug_memhooksEnabled) {
			return;
		}
	}
	e9k_debug_watchpointEnabledMask = mask;
}

E9K_DEBUG_EXPORT int
e9k_debug_consume_watchbreak(e9k_debug_watchbreak_t *out)
{
	if (!out) {
		return 0;
	}
	if (!e9k_debug_watchbreakPending) {
		return 0;
	}
	*out = e9k_debug_watchbreak;
	e9k_debug_watchbreakPending = 0;
	return 1;
}

E9K_DEBUG_EXPORT void
e9k_debug_reset_protects(void)
{
	memset(e9k_debug_protects, 0, sizeof(e9k_debug_protects));
	e9k_debug_protectEnabledMask = 0;
}

E9K_DEBUG_EXPORT int
e9k_debug_add_protect(uint32_t addr, uint32_t size_bits, uint32_t mode, uint32_t value)
{
	if (!e9k_debug_memhooksEnabled) {
		return -1;
	}
	if (size_bits != 8u && size_bits != 16u && size_bits != 32u) {
		return -1;
	}
	if (mode != E9K_PROTECT_MODE_BLOCK && mode != E9K_PROTECT_MODE_SET) {
		return -1;
	}

	uint32_t addr24 = addr & 0x00ffffffu;
	uint32_t addrMask = 0x00ffffffu;
	uint32_t maskedValue = e9k_debug_maskValue(value, size_bits);

	for (uint32_t i = 0; i < E9K_PROTECT_COUNT; ++i) {
		if ((e9k_debug_protectEnabledMask & (1ull << i)) == 0ull) {
			continue;
		}
		const e9k_debug_protect_t *p = &e9k_debug_protects[i];
		if (p->addr == addr24 &&
		    p->addrMask == addrMask &&
		    p->sizeBits == size_bits &&
		    p->mode == mode &&
		    p->value == maskedValue) {
			return (int)i;
		}
	}

	for (uint32_t i = 0; i < E9K_PROTECT_COUNT; ++i) {
		if (e9k_debug_protects[i].sizeBits != 0u) {
			continue;
		}
		e9k_debug_protects[i].addr = addr24;
		e9k_debug_protects[i].addrMask = addrMask;
		e9k_debug_protects[i].sizeBits = size_bits;
		e9k_debug_protects[i].mode = mode;
		e9k_debug_protects[i].value = maskedValue;
		e9k_debug_protectEnabledMask |= (1ull << i);
		return (int)i;
	}

	return -1;
}

E9K_DEBUG_EXPORT void
e9k_debug_remove_protect(uint32_t index)
{
	if (index >= E9K_PROTECT_COUNT) {
		return;
	}
	memset(&e9k_debug_protects[index], 0, sizeof(e9k_debug_protects[index]));
	e9k_debug_protectEnabledMask &= ~(1ull << index);
}

E9K_DEBUG_EXPORT size_t
e9k_debug_read_protects(e9k_debug_protect_t *out, size_t cap)
{
	if (!out || cap == 0) {
		return 0;
	}
	size_t count = E9K_PROTECT_COUNT;
	if (count > cap) {
		count = cap;
	}
	memcpy(out, e9k_debug_protects, count * sizeof(out[0]));
	return count;
}

E9K_DEBUG_EXPORT uint64_t
e9k_debug_get_protect_enabled_mask(void)
{
	return e9k_debug_protectEnabledMask;
}

E9K_DEBUG_EXPORT void
e9k_debug_set_protect_enabled_mask(uint64_t mask)
{
	if (mask) {
		if (!e9k_debug_memhooksEnabled) {
			return;
		}
	}
	e9k_debug_protectEnabledMask = mask;
}

E9K_DEBUG_EXPORT void
e9k_debug_profiler_start(int stream)
{
	e9k_debug_profiler_reset();
	e9k_debug_prof_streamEnabled = stream ? 1 : 0;
	e9k_debug_profilerEnabled = 1;
#ifdef JIT
	if (e9k_debug_prof_savedCachesize < 0) {
		e9k_debug_prof_savedCachesize = currprefs.cachesize;
	}
	if (currprefs.cachesize) {
		currprefs.cachesize = 0;
		flush_icache(3);
		set_special(SPCFLAG_END_COMPILE);
	}
#endif
}

E9K_DEBUG_EXPORT void
e9k_debug_profiler_stop(void)
{
	e9k_debug_profilerEnabled = 0;
	e9k_debug_prof_streamEnabled = 0;
#ifdef JIT
	if (e9k_debug_prof_savedCachesize >= 0) {
		if (currprefs.cachesize != e9k_debug_prof_savedCachesize) {
			currprefs.cachesize = e9k_debug_prof_savedCachesize;
			flush_icache(3);
			set_special(SPCFLAG_END_COMPILE);
		}
		e9k_debug_prof_savedCachesize = -1;
	}
#endif
}

E9K_DEBUG_EXPORT int
e9k_debug_profiler_is_enabled(void)
{
	return e9k_debug_profilerEnabled;
}

E9K_DEBUG_EXPORT size_t
e9k_debug_profiler_stream_next(char *out, size_t cap)
{
	if (!out || cap == 0) {
		return 0;
	}

	if (!e9k_debug_prof_streamEnabled) {
		return 0;
	}
	if (e9k_debug_prof_dirtyCount == 0) {
		return 0;
	}

	const char *enabled = e9k_debug_profilerEnabled ? "enabled" : "disabled";
	size_t pos = 0;
	int written = snprintf(out, cap, "{\"stream\":\"profiler\",\"enabled\":\"%s\",\"hits\":[", enabled);
	if (written <= 0 || (size_t)written >= cap) {
		return 0;
	}
	pos = (size_t)written;

	int first = 1;
	uint32_t newDirtyCount = 0;
	for (uint32_t i = 0; i < e9k_debug_prof_dirtyCount; ++i) {
		uint32_t slot = e9k_debug_prof_dirtyIdx[i];
		if (slot >= E9K_DEBUG_PROF_TABLE_CAP) {
			continue;
		}
		uint32_t pc24 = e9k_debug_prof_pcs[slot];
		if (pc24 == E9K_DEBUG_PROF_EMPTY_PC) {
			e9k_debug_prof_entryEpoch[slot] = 0;
			continue;
		}
		unsigned long long samples = (unsigned long long)e9k_debug_prof_samples[slot];
		unsigned long long cycles = (unsigned long long)e9k_debug_prof_cycles[slot];
		if (samples == 0 && cycles == 0) {
			e9k_debug_prof_entryEpoch[slot] = 0;
			continue;
		}

		char entry[96];
		if (first) {
			written = snprintf(entry, sizeof(entry), "{\"pc\":\"0x%06X\",\"samples\":%llu,\"cycles\":%llu}",
			                   (unsigned)(pc24 & 0x00ffffffu), samples, cycles);
			first = 0;
		} else {
			written = snprintf(entry, sizeof(entry), ",{\"pc\":\"0x%06X\",\"samples\":%llu,\"cycles\":%llu}",
			                   (unsigned)(pc24 & 0x00ffffffu), samples, cycles);
		}
		if (written <= 0) {
			e9k_debug_prof_entryEpoch[slot] = 0;
			continue;
		}
		size_t need = (size_t)written;
		if (pos + need + 2 >= cap) {
			e9k_debug_prof_dirtyIdx[newDirtyCount++] = slot;
			continue;
		}
		memcpy(out + pos, entry, need);
		pos += need;
		e9k_debug_prof_entryEpoch[slot] = 0;
	}
	e9k_debug_prof_dirtyCount = newDirtyCount;

	if (pos + 2 >= cap) {
		return 0;
	}
	out[pos++] = ']';
	out[pos++] = '}';
	out[pos] = '\0';

	if (e9k_debug_prof_dirtyCount == 0) {
		e9k_debug_prof_epoch++;
		if (e9k_debug_prof_epoch == 0) {
			memset(e9k_debug_prof_entryEpoch, 0, sizeof(e9k_debug_prof_entryEpoch));
			e9k_debug_prof_epoch = 1;
		}
	}
	return pos;
}

E9K_DEBUG_EXPORT size_t
e9k_debug_text_read(char *out, size_t cap)
{
	if (!out || cap == 0 || e9k_debug_textCount == 0) {
		return 0;
	}
	size_t n = e9k_debug_textCount < cap ? e9k_debug_textCount : cap;
	for (size_t i = 0; i < n; ++i) {
		out[i] = e9k_debug_textBuf[e9k_debug_textTail];
		e9k_debug_textTail = (e9k_debug_textTail + 1) % E9K_DEBUG_TEXT_CAP;
	}
	e9k_debug_textCount -= n;
	return n;
}

E9K_DEBUG_EXPORT size_t
e9k_debug_read_checkpoints(e9k_debug_checkpoint_t *out, size_t cap)
{
	if (!out || cap == 0) {
		return 0;
	}
	size_t count = E9K_CHECKPOINT_COUNT;
	if (count > cap) {
		count = cap;
	}
	memcpy(out, e9k_debug_checkpoints, count * sizeof(out[0]));
	return count;
}

E9K_DEBUG_EXPORT void
e9k_debug_reset_checkpoints(void)
{
	memset(e9k_debug_checkpoints, 0, sizeof(e9k_debug_checkpoints));
}

E9K_DEBUG_EXPORT void
e9k_debug_set_checkpoint_enabled(int enabled)
{
	e9k_debug_checkpointEnabled = enabled ? 1 : 0;
}

E9K_DEBUG_EXPORT int
e9k_debug_get_checkpoint_enabled(void)
{
	return e9k_debug_checkpointEnabled;
}

E9K_DEBUG_EXPORT int *
e9k_debug_amiga_get_debug_dma_addr(void)
{
	return &debug_dma;
}

E9K_DEBUG_EXPORT void
puae_debug_set_catchpoint(uint32_t vector)
{
	if (vector < E9K_CATCHPOINT_VECTOR_MAX) {
		puae_debug_catchpointEnabledMask |= (1ull << vector);
	}
}

E9K_DEBUG_EXPORT void
puae_debug_remove_catchpoint(uint32_t vector)
{
	if (vector < E9K_CATCHPOINT_VECTOR_MAX) {
		puae_debug_catchpointEnabledMask &= ~(1ull << vector);
	}
}

E9K_DEBUG_EXPORT void
puae_debug_check_catchpoint(uint32_t vector, uint32_t pc)
{
	if (puae_debug_replayMode) {
		// Replay re-enters exception vectors that already triggered forward;
		// catchpoints must not refire.
		return;
	}
	if (vector >= E9K_CATCHPOINT_VECTOR_MAX) {
		return;
	}
	if ((puae_debug_catchpointEnabledMask & (1ull << vector)) == 0ull) {
		return;
	}
	if (puae_debug_catchbreakPending) {
		return;
	}
	puae_debug_catchbreak.pc = pc;
	puae_debug_catchbreak.vector = vector;
	puae_debug_catchbreakPending = 1;
	e9k_debug_requestBreak();
}

E9K_DEBUG_EXPORT int
puae_debug_consume_catchbreak(e9k_debug_catchbreak_t *out)
{
	if (!out) {
		return 0;
	}
	if (!puae_debug_catchbreakPending) {
		return 0;
	}
	*out = puae_debug_catchbreak;
	puae_debug_catchbreakPending = 0;
	return 1;
}

E9K_DEBUG_EXPORT uint32_t
puae_debug_get_chip_mem_size(void)
{
	return (uint32_t)currprefs.chipmem.size;
}

