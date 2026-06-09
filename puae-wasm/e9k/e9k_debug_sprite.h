#pragma once

#include <stddef.h>
#include <stdint.h>

typedef struct e9k_debug_sprite_state {
    const uint16_t *vram;
    size_t vram_words;
    unsigned sprlimit;
    int screen_w;
    int screen_h;
    int crop_t;
    int crop_b;
    int crop_l;
    int crop_r;
} e9k_debug_sprite_state_t;

