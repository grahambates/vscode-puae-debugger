#!/usr/bin/env bash
# Build script for the PUAE wasm debugger backend.
#
# Prerequisites:
#   - emsdk activated in the current shell (emcc/emar/emranlib on PATH)
#   - libretro-uae/ submodule checked out (vscode_vamiga_debugger branch,
#     already includes the patches needed for this build)
#     (no other external repos needed — e9k sources are in e9k/)
#
# Usage:
#   cd puae-wasm/
#   source ~/emsdk/emsdk_env.sh
#   ./build.sh
#
# Outputs: ../puae/puae.js  ../puae/puae.wasm  (served by python3 -m http.server 8081)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/puae"
E9K="$SCRIPT_DIR/e9k"
LUAE="$SCRIPT_DIR/libretro-uae"
EMCC="${EMCC:-emcc}"
EMAR="${EMAR:-emar}"
EMRANLIB="${EMRANLIB:-emranlib}"
J="${J:-$(sysctl -n hw.logicalcpu 2>/dev/null || nproc)}"

echo "=== Stage 1: libretro-uae (patched) → libpuae.a ==="

cd "$LUAE"

make platform=emscripten STATIC_LINKING=1 STATIC_LINKING_LINK=1 \
    CC="$EMCC" AR="$EMAR" RANLIB="$EMRANLIB" -j"$J"

# The Makefile writes puae_libretro_emscripten.bc (a plain ar archive despite
# the .bc suffix). Rename to .a so emcc treats it as a library, not source.
cp puae_libretro_emscripten.bc "$SCRIPT_DIR/libpuae.a"
echo "  → $SCRIPT_DIR/libpuae.a"

echo "=== Stage 2: e9k graft objects ==="

cd "$SCRIPT_DIR"

# Shared compiler flags — use libretro-uae headers (no USE_LIBRETRO_VFS,
# which would redefine FILE→RFILE and clash with emscripten's emscripten.h).
GRAFT_FLAGS=(
    -DHAVE_MEMALIGN -DHAVE_ASPRINTF -O2
    -std=gnu99 -DINLINE=inline -D__LIBRETRO__
    -I "$LUAE/sources/src"
    -I "$LUAE/sources/src/include"
    -I "$LUAE"
    -I "$LUAE/retrodep"
    -I "$LUAE/libretro-common/include"
    -I "$E9K"
)

echo "  Compiling e9k/newcpu.c…"
"$EMCC" "${GRAFT_FLAGS[@]}" \
    -c -o newcpu_ami.o "$E9K/newcpu.c"

echo "  Compiling e9k/e9k_debug.c…"
# e9k_compat.h forward-declares blitter_setDestinationWriteEnabled and
# drawing_setSpriteEnabled, which exist only in ami9000's blitter/drawing sources.
# Stubbed out in e9k_stubs.c (sprite/bitplane debug toggles, not needed for
# basic breakpoints).
"$EMCC" "${GRAFT_FLAGS[@]}" \
    -include "$SCRIPT_DIR/e9k_compat.h" \
    -c -o e9k_debug.o "$E9K/e9k_debug.c"

echo "  Compiling e9k_stubs.c…"
"$EMCC" -O2 -c -o e9k_stubs.o "$SCRIPT_DIR/e9k_stubs.c"

echo "=== Stage 3: assemble libami9000.a ==="

cp libpuae.a libami9000.a
# Replace libretro-uae's stock newcpu.o with the instrumented version (which
# calls e9k_debug_instructionHook at each instruction), then add the debug
# layer and stubs.
"$EMAR" d libami9000.a newcpu.o
"$EMAR" r libami9000.a newcpu_ami.o e9k_debug.o e9k_stubs.o
echo "  → $SCRIPT_DIR/libami9000.a"

echo "=== Stage 4: final emcc link → puae.js ==="

mkdir -p "$OUT_DIR"

EXPORTED_FUNCTIONS='["_main","_wasm_boot","_wasm_tick","_wasm_get_frame_count","_wasm_get_audio_frames_total","_wasm_get_fb_width","_wasm_get_fb_height","_wasm_get_fb_data","_wasm_get_fb_rgba","_wasm_get_fb_pitch","_wasm_get_base_width","_wasm_get_base_height","_wasm_get_sound_buffer_address","_wasm_copy_into_sound_buffer","_wasm_set_sample_rate","_wasm_get_audio_accum_L","_wasm_get_audio_accum_R","_wasm_get_audio_accum_count","_wasm_reset_audio_accum","_wasm_is_paused","_wasm_read_regs","_wasm_get_reg_buf","_wasm_add_breakpoint","_wasm_remove_breakpoint","_wasm_resume","_wasm_pause","_wasm_set_reg","_wasm_eof","_wasm_add_temp_breakpoint","_wasm_remove_temp_breakpoint","_wasm_read_memory","_wasm_get_mem_buf","_wasm_write_memory","_wasm_write_memory_buf","_wasm_poke_memory","_wasm_peek_memory","_wasm_read_memory_map","_wasm_get_memory_map_buf","_wasm_disassemble","_wasm_get_disasm_buf","_wasm_step_instr","_wasm_step_line","_wasm_step_next","_wasm_step_out","_wasm_read_callstack","_wasm_get_callstack_buf","_wasm_read_cycle_count","_wasm_get_cycle_count_lo","_wasm_get_cycle_count_hi","_wasm_add_watchpoint","_wasm_remove_watchpoint","_wasm_read_watchpoints","_wasm_get_watchpoint_buf","_wasm_read_watchpoint_enabled_mask","_wasm_get_watchpoint_enabled_mask_lo","_wasm_get_watchpoint_enabled_mask_hi","_wasm_set_watchpoint_enabled_mask","_wasm_consume_watchbreak","_wasm_get_watchbreak_buf","_wasm_add_protect","_wasm_remove_protect","_wasm_read_protects","_wasm_get_protect_buf","_wasm_read_protect_enabled_mask","_wasm_get_protect_enabled_mask_lo","_wasm_get_protect_enabled_mask_hi","_wasm_set_protect_enabled_mask","_malloc","_free"]'

"$EMCC" \
    -include emscripten/emscripten.h \
    -I "$LUAE/libretro-common/include" \
    -I "$LUAE/sources/src/include" \
    -I "$E9K" \
    -O2 \
    -s MODULARIZE=1 \
    -s EXPORT_NAME=createPuaeModule \
    -s "EXPORTED_FUNCTIONS=$EXPORTED_FUNCTIONS" \
    -s 'EXPORTED_RUNTIME_METHODS=["cwrap","ccall","FS","UTF8ToString"]' \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=320MB \
    -s STACK_SIZE=2MB \
    frontend_shim.c \
    libami9000.a \
    "$LUAE/build_extra"/*.o \
    -o "$OUT_DIR/puae.js"

echo ""
echo "=== Build complete ==="
echo "  puae.js   $(du -sh "$OUT_DIR/puae.js"   | cut -f1)"
echo "  puae.wasm $(du -sh "$OUT_DIR/puae.wasm" | cut -f1)"
echo ""
echo "Serve with: python3 -m http.server 8081 -d $OUT_DIR"
echo "Open:       http://localhost:8081/"
