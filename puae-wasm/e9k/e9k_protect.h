#pragma once

#include <stddef.h>
#include <stdint.h>

#include "e9k-lib.h"

void
e9k_debug_reset_protects(void);

int
e9k_debug_add_protect(uint32_t addr, uint32_t size_bits, uint32_t mode, uint32_t value);

void
e9k_debug_remove_protect(uint32_t index);

size_t
e9k_debug_read_protects(e9k_debug_protect_t *out, size_t cap);

uint64_t
e9k_debug_get_protect_enabled_mask(void);

void
e9k_debug_set_protect_enabled_mask(uint64_t mask);
