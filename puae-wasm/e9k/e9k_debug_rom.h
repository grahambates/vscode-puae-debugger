#pragma once

#include <stddef.h>
#include <stdint.h>

typedef struct e9k_debug_rom_region {
    const uint8_t *data;
    size_t size;
} e9k_debug_rom_region_t;

