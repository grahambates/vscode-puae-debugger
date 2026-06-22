#pragma once

#include <stddef.h>
#include <stdint.h>

#include "e9k-lib.h"

void
e9k_debug_memprotect_set_enabled(int enabled);

// Starts (or restarts) the live AllocMem/FreeMem watch that builds the
// allow-list — call once exec.library is confirmed ready (see
// puae_app.js/puae_rpc.js's isExecReady), independent of whether enforcement
// is enabled. Safe to call again after a reset to recompute the AllocMem/
// FreeMem LVO addresses from the (possibly different) post-reset execBase.
void
e9k_debug_memprotect_start_tracking(void);

void
e9k_debug_memprotect_reset_ranges(void);

int
e9k_debug_memprotect_add_range(uint32_t addr, uint32_t size);

int
e9k_debug_memprotect_consume_break(e9k_debug_memprotect_break_t *out);
