// Stubs for ami9000-only blitter/drawing debug functions.
// The real implementations add per-sprite and per-bitplane debug toggles
// that don't exist in stock libretro-uae. For Stage D (breakpoints + regs)
// we don't need them — silence the linker with no-ops.
void blitter_setDestinationWriteEnabled(int enabled) { (void)enabled; }
void drawing_setSpriteEnabled(int spriteIndex, int enabled) { (void)spriteIndex; (void)enabled; }

// Stage G2: the chip-RAM accessors in memory.c (patched, see
// libretro-uae.patch) call e9k_debug_memhook_*() unconditionally, so the
// hooks are always "installed" — no separate enable step is needed.
int debug_enableE9kHooks(void) { return 1; }
