#pragma once

#include <stddef.h>
#include <stdint.h>

#include "e9k-lib.h"

void
e9k_debug_reset_watchpoints(void);

int
e9k_debug_add_watchpoint(uint32_t addr, uint32_t op_mask, uint32_t diff_operand, uint32_t value_operand,
                         uint32_t old_value_operand, uint32_t size_operand, uint32_t addr_mask_operand);

void
e9k_debug_remove_watchpoint(uint32_t index);

size_t
e9k_debug_read_watchpoints(e9k_debug_watchpoint_t *out, size_t cap);

uint64_t
e9k_debug_get_watchpoint_enabled_mask(void);

void
e9k_debug_set_watchpoint_enabled_mask(uint64_t mask);

int
e9k_debug_consume_watchbreak(e9k_debug_watchbreak_t *out);

void
e9k_debug_reset_regwatches(void);

int
e9k_debug_add_regwatch(uint32_t regIndex);

void
e9k_debug_remove_regwatch(uint32_t regIndex);

uint32_t
e9k_debug_get_regwatch_enabled_mask(void);

int
e9k_debug_consume_regwatchbreak(e9k_debug_regwatchbreak_t *out);
