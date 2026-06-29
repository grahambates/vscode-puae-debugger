#!/usr/bin/env bash
# Build script for the PUAE wasm debugger backend.
#
# Prerequisites:
#   - emsdk activated in the current shell (emcc/emar/emranlib on PATH)
#   - libretro-uae/ submodule checked out (vscode_vamiga_debugger branch,
#     already includes the patches needed for this build)
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
LUAE="$SCRIPT_DIR/libretro-uae"
EMCC="${EMCC:-emcc}"
EMAR="${EMAR:-emar}"
EMRANLIB="${EMRANLIB:-emranlib}"
J="${J:-$(sysctl -n hw.logicalcpu 2>/dev/null || nproc)}"

echo "=== Stage 1: libretro-uae (patched) → libpuae.a ==="

cd "$LUAE"

# NO_LIBRETRO_VFS=1: USE_LIBRETRO_VFS (the Makefile default) makes
# libretro-common's file_stream_transforms.h `#define FILE RFILE`, which
# clashes with emscripten's own `typedef struct _IO_FILE FILE` (pulled in via
# sleep.h -> retro_timers.h -> emscripten/emscripten.h in misc.c). Standard
# FILE*/fopen via emscripten's FS layer works fine without the VFS shim.
make platform=emscripten STATIC_LINKING=1 STATIC_LINKING_LINK=1 NO_LIBRETRO_VFS=1 \
    CC="$EMCC" AR="$EMAR" RANLIB="$EMRANLIB" -j"$J"

# The Makefile writes puae_libretro_emscripten.bc (a plain ar archive despite
# the .bc suffix). Rename to .a so emcc treats it as a library, not source.
cp puae_libretro_emscripten.bc "$SCRIPT_DIR/libpuae.a"
echo "  → $SCRIPT_DIR/libpuae.a"

echo "=== Stage 2: graft objects ==="

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
)

echo "  Compiling puae_debug.c…"
"$EMCC" "${GRAFT_FLAGS[@]}" \
    -c -o puae_debug.o "$SCRIPT_DIR/puae_debug.c"

echo "=== Stage 2b: libretro-common/deps file/path/VFS/zlib/7z objects ==="

# With STATIC_LINKING=1, Makefile.common's `ifneq ($(STATIC_LINKING),1)`
# block excludes these libretro-common sources (file_path.c,
# vfs_implementation.c, etc.) plus the libz/7zip deps used by
# libretro-glue.c/unzip.c (gzopen, inflateEnd, SzArEx_*, ...), assuming the
# host frontend supplies them. Our frontend doesn't, and libretro-core.o /
# libretro-glue.o / unzip.o (compiled as part of libpuae.a) call into them,
# so compile them here with GRAFT_FLAGS (no -DUSE_LIBRETRO_VFS, avoiding the
# FILE/RFILE clash).
GRAFT_DEPS_SOURCES=(
    libretro-common/compat/compat_strl.c
    libretro-common/compat/compat_strcasestr.c
    libretro-common/compat/fopen_utf8.c
    libretro-common/encodings/encoding_utf.c
    libretro-common/file/file_path.c
    libretro-common/file/file_path_io.c
    libretro-common/file/retro_dirent.c
    libretro-common/streams/file_stream.c
    libretro-common/streams/file_stream_transforms.c
    libretro-common/string/stdstring.c
    libretro-common/time/rtime.c
    libretro-common/vfs/vfs_implementation.c
    deps/libz/adler32.c
    deps/libz/crc32.c
    deps/libz/deflate.c
    deps/libz/gzclose.c
    deps/libz/gzlib.c
    deps/libz/gzread.c
    deps/libz/gzwrite.c
    deps/libz/inffast.c
    deps/libz/inflate.c
    deps/libz/inftrees.c
    deps/libz/trees.c
    deps/libz/zutil.c
    deps/7zip/7zArcIn.c
    deps/7zip/7zBuf.c
    deps/7zip/7zCrc.c
    deps/7zip/7zCrcOpt.c
    deps/7zip/7zDec.c
    deps/7zip/7zFile.c
    deps/7zip/7zStream.c
    deps/7zip/Bcj2.c
    deps/7zip/Bra.c
    deps/7zip/Bra86.c
    deps/7zip/BraIA64.c
    deps/7zip/CpuArch.c
    deps/7zip/Delta.c
    deps/7zip/Lzma2Dec.c
    deps/7zip/LzmaDec.c
)
GRAFT_DEPS_OBJS=()
for src in "${GRAFT_DEPS_SOURCES[@]}"; do
    obj="grafted_$(basename "${src%.c}").o"
    echo "  Compiling ${src}..."
    "$EMCC" "${GRAFT_FLAGS[@]}" \
        -I "$LUAE/libretro-common/include/compat/zlib" \
        -I "$LUAE/deps/7zip" \
        -c -o "$obj" "$LUAE/$src"
    GRAFT_DEPS_OBJS+=("$obj")
done

echo "=== Stage 3: assemble libami9000.a ==="

cp libpuae.a libami9000.a
# libpuae.a's newcpu.o already calls puae_debug_instructionHook at each
# instruction (the hooks live directly in the libretro-uae submodule); just
# add the debug layer and grafted deps.
"$EMAR" r libami9000.a puae_debug.o "${GRAFT_DEPS_OBJS[@]}"
echo "  → $SCRIPT_DIR/libami9000.a"

echo "=== Stage 4: final emcc link → puae.js ==="

mkdir -p "$OUT_DIR"

EXPORTED_FUNCTIONS='["_main","_wasm_boot","_wasm_tick","_wasm_get_frame_count","_wasm_get_audio_frames_total","_wasm_get_fb_width","_wasm_get_fb_height","_wasm_get_fb_data","_wasm_get_fb_rgba","_wasm_get_fb_pitch","_wasm_get_base_width","_wasm_get_base_height","_wasm_get_sound_buffer_address","_wasm_copy_into_sound_buffer","_wasm_set_sample_rate","_wasm_get_audio_accum_L","_wasm_get_audio_accum_R","_wasm_get_audio_accum_count","_wasm_reset_audio_accum","_wasm_is_paused","_wasm_read_regs","_wasm_get_reg_buf","_wasm_add_breakpoint","_wasm_remove_breakpoint","_wasm_resume","_wasm_pause","_wasm_set_reg","_wasm_reset","_wasm_eof","_wasm_eol","_wasm_add_temp_breakpoint","_wasm_remove_temp_breakpoint","_wasm_read_memory","_wasm_get_mem_buf","_wasm_write_memory","_wasm_write_memory_buf","_wasm_poke_memory","_wasm_peek_memory","_wasm_read_memory_map","_wasm_get_memory_map_buf","_wasm_read_display_regs","_wasm_get_display_regs_buf","_wasm_read_custom_regs_raw","_wasm_get_custom_regs_raw_buf","_wasm_read_audio_regs","_wasm_get_audio_regs_buf","_wasm_disassemble","_wasm_get_disasm_buf","_wasm_enable_cpu_logging","_wasm_read_cpu_trace","_wasm_get_cpu_trace_buf","_wasm_step_instr","_wasm_step_line","_wasm_step_next","_wasm_step_out","_wasm_read_callstack","_wasm_get_callstack_buf","_wasm_read_cycle_count","_wasm_get_cycle_count_lo","_wasm_get_cycle_count_hi","_wasm_read_instr_count","_wasm_get_instr_count_lo","_wasm_get_instr_count_hi","_wasm_write_instr_count","_wasm_replay_instructions","_wasm_replay_instructions_video","_wasm_replay_scan","_wasm_replay_scan_frame","_wasm_get_replay_scan_match_lo","_wasm_get_replay_scan_match_hi","_wasm_reset_debug_watches","_wasm_add_watchpoint","_wasm_remove_watchpoint","_wasm_read_watchpoints","_wasm_get_watchpoint_buf","_wasm_read_watchpoint_enabled_mask","_wasm_get_watchpoint_enabled_mask_lo","_wasm_get_watchpoint_enabled_mask_hi","_wasm_set_watchpoint_enabled_mask","_wasm_consume_watchbreak","_wasm_get_watchbreak_buf","_wasm_add_regwatch","_wasm_remove_regwatch","_wasm_get_regwatch_enabled_mask","_wasm_consume_regwatchbreak","_wasm_get_regwatchbreak_buf","_wasm_set_catchpoint","_wasm_remove_catchpoint","_wasm_consume_catchbreak","_wasm_get_catchbreak_buf","_wasm_memprotect_set_enabled","_wasm_memprotect_start_tracking","_wasm_memprotect_seed_libraries","_wasm_memprotect_reset_ranges","_wasm_memprotect_add_range","_wasm_consume_memprotect_break","_wasm_get_memprotect_break_buf","_wasm_get_chip_mem_size","_wasm_serialize_size","_wasm_serialize","_wasm_unserialize","_wasm_profile_start","_wasm_profile_set_unwind","_wasm_profile_get_buf_ptr","_wasm_profile_get_buf_words","_wasm_profile_get_stats","_wasm_dma_get_grid_ptr","_wasm_dma_get_grid_size","_wasm_dma_get_chip_ptr","_wasm_dma_get_chip_size","_wasm_dma_get_slow_ptr","_wasm_dma_get_slow_size","_wasm_dma_overlay_enable","_wasm_dma_overlay_set_channel","_wasm_dma_overlay_set_opacity","_wasm_redraw_frame","_wasm_dma_get_cell_type","_wasm_dma_get_cell_addr","_wasm_dma_get_cell_data","_wasm_dma_get_cell_extra","_wasm_dma_get_cell_reg","_wasm_copper_tracking_enable","_wasm_copper_get_records_ptr","_wasm_copper_get_records_size","_wasm_regwrite_get_records_ptr","_wasm_regwrite_get_records_size","_wasm_set_bitplane_enabled","_wasm_set_sprite_enabled","_wasm_set_audio_channel_enabled","_wasm_set_blitter_enabled","_wasm_set_mouse_delta","_wasm_set_mouse_button","_malloc","_free"]'

"$EMCC" \
    -include emscripten/emscripten.h \
    -I "$LUAE/libretro-common/include" \
    -I "$LUAE/sources/src/include" \
    -O2 \
    -s MODULARIZE=1 \
    -s EXPORT_NAME=createPuaeModule \
    -s "EXPORTED_FUNCTIONS=$EXPORTED_FUNCTIONS" \
    -s 'EXPORTED_RUNTIME_METHODS=["cwrap","ccall","FS","UTF8ToString","HEAPU8","HEAPU32","HEAPF32"]' \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=320MB \
    -s STACK_SIZE=2MB \
    frontend_shim.c \
    libami9000.a \
    -o "$OUT_DIR/puae.js"

echo ""
echo "=== Build complete ==="
echo "  puae.js   $(du -sh "$OUT_DIR/puae.js"   | cut -f1)"
echo "  puae.wasm $(du -sh "$OUT_DIR/puae.wasm" | cut -f1)"
echo ""
echo "Serve with: python3 -m http.server 8081 -d $OUT_DIR"
echo "Open:       http://localhost:8081/"
