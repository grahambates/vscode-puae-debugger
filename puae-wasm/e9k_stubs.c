// Stage G2: the chip-RAM accessors in memory.c (patched, see
// libretro-uae.patch) call e9k_debug_memhook_*() unconditionally, so the
// hooks are always "installed" — no separate enable step is needed.
int debug_enableE9kHooks(void) { return 1; }
