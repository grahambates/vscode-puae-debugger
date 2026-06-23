#pragma once

#include <stddef.h>
#include <stdint.h>

#include "e9k-lib.h"

void
e9k_debug_memprotect_set_enabled(int enabled);

// Starts (or restarts) the live AllocMem/FreeMem watch that builds the
// allow-list, independent of whether enforcement is enabled. Validates
// execBase itself before committing (see e9k_debug_execBaseValid), so it's
// safe to call on every tick from the moment the machine starts running —
// it no-ops (returning 0) until exec.library has actually initialized
// itself, far earlier than puae_app.js/puae_rpc.js's isExecReady "user task
// started" heuristic. Callers must stop polling once this first returns 1 —
// calling it again while already tracking discards any AllocMem call
// currently in-flight. Safe to call again deliberately after an explicit
// reset/reboot to recompute the AllocMem/FreeMem LVO addresses from the new
// execBase.
int
e9k_debug_memprotect_start_tracking(void);

// Walks ExecBase->LibList and adds every resident library (GfxBase,
// IntuitionBase, DosBase, exec.library itself, ...) to the allow-list.
// Deliberately separate from e9k_debug_memprotect_start_tracking — call
// this once the caller already trusts library state is live (e.g. the
// same "GfxBase is set" condition puae_app.js's tryExec uses), not as
// early as execBase merely validates. Safe to call repeatedly.
int
e9k_debug_memprotect_seed_libraries(void);

void
e9k_debug_memprotect_reset_ranges(void);

int
e9k_debug_memprotect_add_range(uint32_t addr, uint32_t size);

int
e9k_debug_memprotect_consume_break(e9k_debug_memprotect_break_t *out);
