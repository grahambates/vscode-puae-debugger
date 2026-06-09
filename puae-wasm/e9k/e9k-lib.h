#pragma once
#include <stdint.h>

typedef enum e9k_debug_option
{
    e9k_debug_option_none = 0,
    E9K_DEBUG_OPTION_AMIGA_BLITTER = 1,
    E9K_DEBUG_OPTION_AMIGA_SPRITE0 = 2,
    E9K_DEBUG_OPTION_AMIGA_SPRITE1 = 3,
    E9K_DEBUG_OPTION_AMIGA_SPRITE2 = 4,
    E9K_DEBUG_OPTION_AMIGA_SPRITE3 = 5,
    E9K_DEBUG_OPTION_AMIGA_SPRITE4 = 6,
    E9K_DEBUG_OPTION_AMIGA_SPRITE5 = 7,
    E9K_DEBUG_OPTION_AMIGA_SPRITE6 = 8,
    E9K_DEBUG_OPTION_AMIGA_SPRITE7 = 9,
    E9K_DEBUG_OPTION_AMIGA_BITPLANE0 = 10,
    E9K_DEBUG_OPTION_AMIGA_BITPLANE1 = 11,
    E9K_DEBUG_OPTION_AMIGA_BITPLANE2 = 12,
    E9K_DEBUG_OPTION_AMIGA_BITPLANE3 = 13,
    E9K_DEBUG_OPTION_AMIGA_BITPLANE4 = 14,
    E9K_DEBUG_OPTION_AMIGA_BITPLANE5 = 15,
    E9K_DEBUG_OPTION_AMIGA_BITPLANE6 = 16,
    E9K_DEBUG_OPTION_AMIGA_BITPLANE7 = 17,
    E9K_DEBUG_OPTION_AMIGA_AUDIO0 = 18,
    E9K_DEBUG_OPTION_AMIGA_AUDIO1 = 19,
    E9K_DEBUG_OPTION_AMIGA_AUDIO2 = 20,
    E9K_DEBUG_OPTION_AMIGA_AUDIO3 = 21
} e9k_debug_option_t;

#define E9K_CHECKPOINT_COUNT 64

typedef struct e9k_debug_checkpoint {
    uint64_t current;
    uint64_t accumulator;
    uint64_t count;
    uint64_t average;
    uint64_t minimum;
    uint64_t maximum;
} e9k_debug_checkpoint_t;


#define E9K_WATCHPOINT_COUNT 64

// Watchpoint operation bits.
// These can be combined; operands are stored separately per watchpoint.
#define E9K_WATCH_OP_READ                 (1u << 0) // (1) Read
#define E9K_WATCH_OP_WRITE                (1u << 1) // (2) Write
#define E9K_WATCH_OP_VALUE_NEQ_OLD        (1u << 2) // (3) Value != existing value (write-only)
#define E9K_WATCH_OP_VALUE_EQ             (1u << 3) // (4) Value == operand
#define E9K_WATCH_OP_OLD_VALUE_EQ         (1u << 4) // (5) Existing value == operand
#define E9K_WATCH_OP_ACCESS_SIZE          (1u << 5) // (6) Access size (operand: 8/16/32 bits)
#define E9K_WATCH_OP_ADDR_COMPARE_MASK    (1u << 6) // (7) Address compare mask (operand: mask)

// Access kind for watchbreak reporting.
#define E9K_WATCH_ACCESS_READ             1u
#define E9K_WATCH_ACCESS_WRITE            2u

typedef struct e9k_debug_watchpoint
{
    uint32_t addr;
    uint32_t op_mask;
    uint32_t diff_operand;      // (3) operand value
    uint32_t value_operand;     // (4) operand value
    uint32_t old_value_operand; // (5) operand value
    uint32_t size_operand;      // (6) operand size, 8/16/32 (bits)
    uint32_t addr_mask_operand; // (7) operand mask, 0 => always match
} e9k_debug_watchpoint_t;

typedef struct e9k_debug_watchbreak
{
    uint32_t index;             // 0..E9K_WATCHPOINT_COUNT-1

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
    uint32_t access_kind;       // E9K_WATCH_ACCESS_*
    uint32_t access_size;       // 8/16/32 (bits)
    uint32_t value;             // value read/written (size-truncated)
    uint32_t old_value;         // existing value (if known; for reads, equals value)
    uint32_t old_value_valid;   // 1 if old_value is valid
} e9k_debug_watchbreak_t;


#define E9K_PROTECT_COUNT 64
#define E9K_PROTECT_MODE_BLOCK 0u
#define E9K_PROTECT_MODE_SET   1u

typedef struct e9k_debug_protect
{
    uint32_t addr;
    uint32_t addrMask;
    uint32_t sizeBits; // protected region size: 8/16/32 (bits)
    uint32_t mode;     // E9K_PROTECT_MODE_*
    uint32_t value;    // set value (masked to sizeBits), ignored for BLOCK
} e9k_debug_protect_t;
