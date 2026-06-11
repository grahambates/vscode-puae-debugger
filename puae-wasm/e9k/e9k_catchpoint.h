#pragma once

#include <stdint.h>

#include "e9k-lib.h"

// Enables/disables a halt the next time CPU exception `vector` is raised
// (vector must be < E9K_CATCHPOINT_VECTOR_MAX, e.g. 4 = illegal instruction).
// Mirrors WinUAE's debug_illegal_mask, but halts via the e9k_debug pause
// mechanism instead of activate_debugger().
void
e9k_debug_set_catchpoint(uint32_t vector);

void
e9k_debug_remove_catchpoint(uint32_t vector);

// Called from ExceptionX (newcpu.c) for every CPU exception. If `vector` has
// an enabled catchpoint, records {pc, vector} and requests a debugger break.
void
e9k_debug_check_catchpoint(uint32_t vector, uint32_t pc);

// Returns 1 and fills `out` if a catchpoint break is pending (consuming it),
// else returns 0.
int
e9k_debug_consume_catchbreak(e9k_debug_catchbreak_t *out);
