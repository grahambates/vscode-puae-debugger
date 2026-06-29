// Minimal libretro frontend shim for the PUAE wasm debugger backend.
// Registers the libretro callbacks, calls retro_init(), queries
// retro_get_system_av_info(), and drives retro_run() from JS.
// Stashes the most recent framebuffer pointer/geometry and audio sample
// count in globals exported to JS, mirroring vamigaweb_fork's
// wasm_pixel_buffer()/wasm_get_sound_buffer_address() shape.
// Stage B: converts XRGB8888 → RGBA8888 in shim_video_refresh so JS
// can create an ImageData directly from wasm_get_fb_rgba()'s pointer.

#include <stdio.h>
#include <stdarg.h>
#include <stdint.h>
#include <string.h>
#include <stdbool.h>
#include <unistd.h>
#include <emscripten.h>
#include "libretro.h"
#include "puae_debug.h"
#include "puae_debug.h"

// Read-only access to PUAE's *actual* allocated render buffer
// (gfxvidinfo->drawbuffer) — its rowbytes/width_allocated/height_allocated
// are the source of truth used in shim_video_refresh() below, since
// video_cb()'s own width/height/pitch parameters can run ahead of the real
// buffer's size (see comment there). Can't include xwin.h directly here —
// it needs STATIC_INLINE/MAX_AMIGADISPLAYS etc. from sysconfig.h/uae.h,
// which this minimal libretro shim deliberately doesn't pull in — so the
// actual struct access lives in puae_debug.c (puae_get_drawbuffer_shape),
// which already has that full include context for the rest of the
// debug module; we just call it as a plain function.
extern void puae_get_drawbuffer_shape(int *rowbytes, int *width_allocated, int *height_allocated);

// Defined in ami9000's libretro-core.c; set to true by puae_debug_requestBreak()
// when a breakpoint fires, causing retro_run() to return early.
extern bool libretro_frame_end;

// Max PUAE PAL framebuffer: normally 720×574 (PUAE_VIDEO_WIDTH x
// PUAE_VIDEO_HEIGHT_PAL in libretro-core.h), but retro_set_geometry()
// reports 912x626 (the true full raw raster) while the DMA overlay is
// active — see wasm_dma_overlay_enable (puae_debug.c). Size for that case.
#define MAX_FB_WIDTH  912
#define MAX_FB_HEIGHT 626
#define MAX_FB_PIXELS (MAX_FB_WIDTH * MAX_FB_HEIGHT)

static const void *g_fb_data;
static unsigned g_fb_width, g_fb_height;
static size_t g_fb_pitch;
static unsigned g_frame_count;
static unsigned g_audio_frames_total;
static enum retro_pixel_format g_pixel_format = RETRO_PIXEL_FORMAT_0RGB1555;
// Updated by RETRO_ENVIRONMENT_SET_GEOMETRY when PUAE auto-crops the display.
static unsigned g_geom_base_width = 360, g_geom_base_height = 287;

// --- Audio ---
// Sound buffer: 16 slots × 2048 floats (left[1024] then right[1024] per slot).
// Matches the layout vAmiga_audioprocessor.js expects: slot 0 at base address,
// each slot offset = slot_index * 2048 * sizeof(float) bytes.
#define AUDIO_SLOT_COUNT  16
#define AUDIO_SLOT_FRAMES 1024
static float g_sound_buffer[AUDIO_SLOT_COUNT * AUDIO_SLOT_FRAMES * 2]; // 128 KB

// Accumulation buffer — holds samples from shim_audio_sample_batch between ticks.
#define AUDIO_ACCUM_CAP (AUDIO_SLOT_COUNT * AUDIO_SLOT_FRAMES) // 16384 frames
static float g_audio_accum_L[AUDIO_ACCUM_CAP];
static float g_audio_accum_R[AUDIO_ACCUM_CAP];
static int   g_audio_accum_n = 0; // frames accumulated, not yet packed into slots

// Pre-converted RGBA8888 buffer — filled by shim_video_refresh.
// JS reads this via wasm_get_fb_rgba() and feeds it straight into putImageData.
static uint8_t g_rgba_buf[MAX_FB_PIXELS * 4];

// DMA live overlay — state lives in puae_debug.c, draw function in debug.c.
extern int  g_dmaOverlayEnabled;
extern int  g_dmaOverlayOpacity;
extern void puae_dma_draw_overlay(uint8_t *rgba, int width, int height, int opacity);

// Converts the last-received core framebuffer (g_fb_data/g_fb_width/
// g_fb_height/g_fb_pitch) to RGBA8888 and, if enabled, composites the DMA
// overlay on top, writing into g_rgba_buf. Shared by shim_video_refresh
// (after a real tick produces a new frame) and wasm_redraw_frame (re-runs
// this against the *same* cached frame without ticking — used when overlay
// channels/opacity are toggled while paused, where no new tick happens to
// otherwise trigger a redraw).
static void convert_and_overlay_frame(void) {
    if (!g_fb_data) return;
    const uint8_t *src_row = (const uint8_t *)g_fb_data;
    uint8_t *dst = g_rgba_buf;
    unsigned safe_w = g_fb_width  < MAX_FB_WIDTH  ? g_fb_width  : MAX_FB_WIDTH;
    unsigned safe_h = g_fb_height < MAX_FB_HEIGHT ? g_fb_height : MAX_FB_HEIGHT;
    size_t pitch = g_fb_pitch;

    // Convert whatever pixel format the core chose → RGBA8888 for putImageData().
    if (g_pixel_format == RETRO_PIXEL_FORMAT_XRGB8888) {
        // 32 bpp: 0x00RRGGBB (X byte ignored)
        for (unsigned y = 0; y < safe_h; y++) {
            const uint32_t *row32 = (const uint32_t *)src_row;
            for (unsigned x = 0; x < safe_w; x++) {
                uint32_t px = row32[x];
                *dst++ = (px >> 16) & 0xFF; // R
                *dst++ = (px >>  8) & 0xFF; // G
                *dst++ =  px        & 0xFF; // B
                *dst++ = 255;
            }
            src_row += pitch;
        }
    } else if (g_pixel_format == RETRO_PIXEL_FORMAT_RGB565) {
        // 16 bpp: RRRRR GGGGGG BBBBB
        for (unsigned y = 0; y < safe_h; y++) {
            const uint16_t *row16 = (const uint16_t *)src_row;
            for (unsigned x = 0; x < safe_w; x++) {
                uint16_t px = row16[x];
                uint8_t r5 = (px >> 11) & 0x1F;
                uint8_t g6 = (px >>  5) & 0x3F;
                uint8_t b5 =  px        & 0x1F;
                *dst++ = (r5 << 3) | (r5 >> 2); // 5→8 bit
                *dst++ = (g6 << 2) | (g6 >> 4); // 6→8 bit
                *dst++ = (b5 << 3) | (b5 >> 2); // 5→8 bit
                *dst++ = 255;
            }
            src_row += pitch;
        }
    } else {
        // 0RGB1555 fallback: shouldn't be used but handle it
        for (unsigned y = 0; y < safe_h; y++) {
            const uint16_t *row16 = (const uint16_t *)src_row;
            for (unsigned x = 0; x < safe_w; x++) {
                uint16_t px = row16[x];
                uint8_t r5 = (px >> 10) & 0x1F;
                uint8_t g5 = (px >>  5) & 0x1F;
                uint8_t b5 =  px        & 0x1F;
                *dst++ = (r5 << 3) | (r5 >> 2);
                *dst++ = (g5 << 3) | (g5 >> 2);
                *dst++ = (b5 << 3) | (b5 >> 2);
                *dst++ = 255;
            }
            src_row += pitch;
        }
    }

    if (g_dmaOverlayEnabled)
        puae_dma_draw_overlay(g_rgba_buf, (int)safe_w, (int)safe_h, g_dmaOverlayOpacity);
}

// Re-applies the current DMA overlay settings to the last-received frame
// without ticking — call after changing overlay channels/opacity while
// paused (wasm_dma_overlay_set_channel/set_opacity only flip C-side state;
// the actual recompositing normally only happens inside shim_video_refresh,
// which needs a real wasm_tick() to run). Bumping g_frame_count makes the
// existing "framebuffer changed while paused" redraw path in app.ts's
// frame() (already used for stepBack/continueReverse's replay landing) pick
// this up on its next scheduled callback.
EMSCRIPTEN_KEEPALIVE
void wasm_redraw_frame(void) {
    convert_and_overlay_frame();
    g_frame_count++;
}

static void shim_video_refresh(const void *data, unsigned width, unsigned height, size_t pitch) {
    if (puae_debug_is_replaying() && !puae_debug_is_replay_video_enabled()) {
        // Suppress frame-count/pixel-buffer/profiler updates during replay —
        // this frame doesn't correspond to real elapsed wall-clock time.
        return;
    }

    // libretro-core.c's retro_run() can pass data=NULL (its `old_frame`
    // counter, e.g. for PAL/NTSC region changes) for a "settling" frame.
    // Skip entirely rather than updating dimensions with no matching pixel
    // data.
    if (!data) {
        return;
    }

    // Confirmed by direct instrumentation (data == gfxvidinfo->drawbuffer.
    // bufmem, but rowbytes/width_allocated still describing the *old*
    // geometry): `width`/`height`/`pitch` here are *retro_set_geometry()'s
    // reported* values
    // (e.g. wasm_dma_overlay_enable switching defaultw/defaulth to the
    // 912x626 raw raster), which update independently of — and can run
    // ahead of — the *actual* allocated render buffer's size. The real
    // reallocation only happens in PUAE's check_prefs_changed_gfx(),
    // called once per frame from vsync_handle_check() (drawing.c) — i.e.
    // only when a real vsync is actually crossed. Single-instruction
    // stepping never crosses one, so `data` can keep reporting a
    // *reported* width/pitch that doesn't match its *real* allocated
    // stride indefinitely (not just for one transitional frame) — reading
    // it at the reported pitch/width walks past real row boundaries
    // (shearing) and eventually past the buffer's true allocated end
    // (garbage/blank). Fix: trust the buffer's actual allocated shape
    // (width_allocated/height_allocated/rowbytes), not video_cb's
    // parameters, for both the conversion and what's reported to JS —
    // these always describe what's actually safe to read from `data`,
    // regardless of whether retro_set_geometry's reported size has caught
    // up yet.
    int db_rowbytes = 0, db_width_allocated = 0, db_height_allocated = 0;
    puae_get_drawbuffer_shape(&db_rowbytes, &db_width_allocated, &db_height_allocated);
    if (db_width_allocated > 0 && db_height_allocated > 0 && db_rowbytes > 0) {
        width = (unsigned)db_width_allocated;
        height = (unsigned)db_height_allocated;
        pitch = (size_t)db_rowbytes;
    }

    g_fb_data = data;
    g_fb_width = width;
    g_fb_height = height;
    g_fb_pitch = pitch;
    g_frame_count++;

    convert_and_overlay_frame();

    if (puae_debug_is_replaying()) {
        // Pixel buffer refreshed above (puae_debug_replay_instructions_video),
        // but per-frame debugger hooks (memhook re-arming, profiler sampling,
        // one-shot wasm_eof()/wasm_eol() callbacks) must stay suppressed
        // during replay, same as plain replay.
        return;
    }

    // Drives puae_debug's per-frame hooks (memhook re-arming, profiler
    // sampling, and the one-shot wasm_eof() callback below).
    puae_vblank_notify();
}

static size_t shim_audio_sample_batch(const int16_t *data, size_t frames) {
    if (puae_debug_is_replaying()) {
        // Don't feed replayed audio (already played once) back into the
        // live accumulation buffer.
        return frames;
    }
    // Convert int16 interleaved stereo → float32 planar into the accumulation buffer.
    size_t to_copy = frames;
    if (g_audio_accum_n + (int)to_copy > AUDIO_ACCUM_CAP)
        to_copy = (size_t)(AUDIO_ACCUM_CAP - g_audio_accum_n);
    for (size_t i = 0; i < to_copy; i++) {
        g_audio_accum_L[g_audio_accum_n + (int)i] = data[i * 2    ] * (1.0f / 32768.0f);
        g_audio_accum_R[g_audio_accum_n + (int)i] = data[i * 2 + 1] * (1.0f / 32768.0f);
    }
    g_audio_accum_n    += (int)to_copy;
    g_audio_frames_total += (unsigned)frames;
    return frames;
}

static void shim_audio_sample(int16_t left, int16_t right) {
    if (puae_debug_is_replaying()) {
        return;
    }
    if (g_audio_accum_n < AUDIO_ACCUM_CAP) {
        g_audio_accum_L[g_audio_accum_n] = left  * (1.0f / 32768.0f);
        g_audio_accum_R[g_audio_accum_n] = right * (1.0f / 32768.0f);
        g_audio_accum_n++;
    }
    g_audio_frames_total++;
}

// --- Mouse input ---
// JS (app.ts's setupMouse, mirroring vamiga_app.js's pointer-lock handling)
// accumulates relative movement and button state here; shim_input_state
// answers libretro-mapper.c's RETRO_DEVICE_MOUSE polling for port 0 (gated
// on opt_physicalmouse, default-enabled in libretro-core.c), which forwards
// into UAE's mouse emulation via retro_mouse()/retro_mouse_button()
// (libretro-glue.c) — no .uae joyport config needed, those hardwire the
// Amiga port directly. X/Y deltas are consumed (reset to 0) once read,
// since RETRO_DEVICE_ID_MOUSE_X/_Y are relative-per-poll values.
static int16_t g_mouseDx = 0, g_mouseDy = 0;
static bool g_mouseLeft = false, g_mouseRight = false, g_mouseMiddle = false;

EMSCRIPTEN_KEEPALIVE
void wasm_set_mouse_delta(int dx, int dy) {
    g_mouseDx += (int16_t)dx;
    g_mouseDy += (int16_t)dy;
}

// `button` matches DOM MouseEvent.button: 0=left, 1=middle, 2=right.
EMSCRIPTEN_KEEPALIVE
void wasm_set_mouse_button(int button, int pressed) {
    bool down = pressed != 0;
    switch (button) {
        case 0: g_mouseLeft = down; break;
        case 1: g_mouseMiddle = down; break;
        case 2: g_mouseRight = down; break;
    }
}

static void shim_input_poll(void) {}

static int16_t shim_input_state(unsigned port, unsigned device, unsigned index, unsigned id) {
    if (port != 0 || device != RETRO_DEVICE_MOUSE) return 0;
    switch (id) {
        case RETRO_DEVICE_ID_MOUSE_X: { int16_t v = g_mouseDx; g_mouseDx = 0; return v; }
        case RETRO_DEVICE_ID_MOUSE_Y: { int16_t v = g_mouseDy; g_mouseDy = 0; return v; }
        case RETRO_DEVICE_ID_MOUSE_LEFT:   return g_mouseLeft ? 1 : 0;
        case RETRO_DEVICE_ID_MOUSE_RIGHT:  return g_mouseRight ? 1 : 0;
        case RETRO_DEVICE_ID_MOUSE_MIDDLE: return g_mouseMiddle ? 1 : 0;
        default: return 0;
    }
}

static void shim_log(enum retro_log_level level, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    char buf[512];
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    EM_ASM_({ console.log('[puae]', UTF8ToString($0)); }, buf);
}

static bool shim_environment(unsigned cmd, void *data) {
    switch (cmd) {
        case RETRO_ENVIRONMENT_GET_CAN_DUPE: {
            bool *out = (bool *)data;
            *out = true;
            return true;
        }
        case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT: {
            g_pixel_format = *(const enum retro_pixel_format *)data;
            EM_ASM_({ console.log('[shim] core requested pixel format', $0); }, (int)g_pixel_format);
            return true;
        }
        case RETRO_ENVIRONMENT_GET_LOG_INTERFACE: {
            struct retro_log_callback *cb = (struct retro_log_callback *)data;
            cb->log = shim_log;
            return true;
        }
        case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
        case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY: {
            static const char *dir = "/uae_system";
            *(const char **)data = dir;
            return true;
        }
        case RETRO_ENVIRONMENT_SET_GEOMETRY: {
            // PUAE fires this when auto-crop changes the effective display area.
            const struct retro_game_geometry *geo = (const struct retro_game_geometry *)data;
            g_geom_base_width  = geo->base_width;
            g_geom_base_height = geo->base_height;
            EM_ASM_({ console.log('[shim] SET_GEOMETRY base=' + $0 + 'x' + $1); },
                    geo->base_width, geo->base_height);
            return true;
        }
        case RETRO_ENVIRONMENT_SET_VARIABLES:
            return true;
        case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
            // No pending variable changes from the frontend.
            *(bool *)data = false;
            return true;
        case RETRO_ENVIRONMENT_GET_VARIABLE: {
            struct retro_variable *var = (struct retro_variable *)data;
            if (var->key) {
                if (strcmp(var->key, "puae_kickstart")     == 0) {
                    // Use the built-in AROS ROM when no kickstart file has been
                    // provided (puae_app.js skips writing the file in that case).
                    var->value = (access("/uae_system/kick34005.A500", F_OK) == 0)
                        ? "kick34005.A500" : "aros";
                    return true;
                }
                if (strcmp(var->key, "puae_model")         == 0) { var->value = "A500";           return true; }
                if (strcmp(var->key, "puae_model_fd")      == 0) { var->value = "A500";           return true; }
                if (strcmp(var->key, "puae_video_resolution")== 0) { var->value = "hires";        return true; }
                // "disabled": the standard 720x574 PAL-with-padding view
                // (no extra crop beyond PUAE's own preset). While the DMA
                // overlay is active, wasm_dma_overlay_enable() (puae_debug.c)
                // overrides crop_id directly to CROP_NONE *and* widens
                // retrow/retroh themselves (retro_set_geometry, libretro-
                // core.c) to the true full raw raster (912x626) — that's
                // what makes the canvas visibly grow past the standard size
                // exactly while a DMA channel is on, and shrink back to it
                // when all are off.
                if (strcmp(var->key, "puae_crop")          == 0) { var->value = "disabled";       return true; }
                if (strcmp(var->key, "puae_horizontal_pos")== 0) { var->value = "0";              return true; }
                if (strcmp(var->key, "puae_vertical_pos")  == 0) { var->value = "0";              return true; }
            }
            var->value = NULL;
            return false;
        }
        default:
            return false;
    }
}

// adf_path: path to an ADF in the Emscripten virtual filesystem,
// e.g. "/uae_system/game.adf", or NULL/empty string for no disk.
EMSCRIPTEN_KEEPALIVE
int wasm_boot(const char *adf_path) {
    EM_ASM({ console.log('[shim] registering libretro callbacks'); });

    retro_set_environment(shim_environment);
    retro_set_video_refresh(shim_video_refresh);
    retro_set_audio_sample(shim_audio_sample);
    retro_set_audio_sample_batch(shim_audio_sample_batch);
    retro_set_input_poll(shim_input_poll);
    retro_set_input_state(shim_input_state);

    EM_ASM({ console.log('[shim] calling retro_init()'); });
    retro_init();

    struct retro_system_info sysinfo;
    memset(&sysinfo, 0, sizeof(sysinfo));
    retro_get_system_info(&sysinfo);
    EM_ASM_({
        console.log('[shim] retro_get_system_info: library_name=' + UTF8ToString($0) +
                    ' library_version=' + UTF8ToString($1) +
                    ' valid_extensions=' + (($2) ? UTF8ToString($2) : '(null)'));
    }, sysinfo.library_name, sysinfo.library_version, sysinfo.valid_extensions);

    struct retro_system_av_info avinfo;
    memset(&avinfo, 0, sizeof(avinfo));
    retro_get_system_av_info(&avinfo);
    EM_ASM_({
        console.log('[shim] av_info geometry=' + $0 + 'x' + $1 +
                    ' max=' + $2 + 'x' + $3 +
                    ' aspect=' + $4 + ' fps=' + $5 + ' sample_rate=' + $6);
    }, avinfo.geometry.base_width, avinfo.geometry.base_height,
       avinfo.geometry.max_width, avinfo.geometry.max_height,
       avinfo.geometry.aspect_ratio, avinfo.timing.fps, avinfo.timing.sample_rate);

    int load_ok;
    if (adf_path && adf_path[0]) {
        EM_ASM_({ console.log('[shim] calling retro_load_game with path', UTF8ToString($0)); }, adf_path);
        struct retro_game_info game;
        memset(&game, 0, sizeof(game));
        game.path = adf_path;
        load_ok = retro_load_game(&game);
    } else {
        EM_ASM({ console.log('[shim] calling retro_load_game(NULL) — no disk'); });
        load_ok = retro_load_game(NULL);
    }
    EM_ASM_({ console.log('[shim] retro_load_game returned', $0); }, load_ok);

    return load_ok;
}

EMSCRIPTEN_KEEPALIVE
int wasm_tick(void) {
    libretro_frame_end = false;
    retro_run();
    return (int)g_frame_count;
}

EMSCRIPTEN_KEEPALIVE
int wasm_get_frame_count(void) { return (int)g_frame_count; }

EMSCRIPTEN_KEEPALIVE
int wasm_get_audio_frames_total(void) { return (int)g_audio_frames_total; }

EMSCRIPTEN_KEEPALIVE
int wasm_get_fb_width(void) { return (int)g_fb_width; }

EMSCRIPTEN_KEEPALIVE
int wasm_get_fb_height(void) { return (int)g_fb_height; }

EMSCRIPTEN_KEEPALIVE
const void *wasm_get_fb_data(void) { return g_fb_data; }

// Pre-converted RGBA8888 buffer, ready for putImageData().
EMSCRIPTEN_KEEPALIVE
const void *wasm_get_fb_rgba(void) { return g_rgba_buf; }

EMSCRIPTEN_KEEPALIVE
int wasm_get_fb_pitch(void) { return (int)g_fb_pitch; }

// Geometry reported via SET_GEOMETRY (updated by PUAE's auto-crop).
EMSCRIPTEN_KEEPALIVE
int wasm_get_base_width(void)  { return (int)g_geom_base_width; }

EMSCRIPTEN_KEEPALIVE
int wasm_get_base_height(void) { return (int)g_geom_base_height; }

// --- Audio exports (matching vAmiga_audioprocessor.js contract) ---

EMSCRIPTEN_KEEPALIVE
float *wasm_get_sound_buffer_address(void) { return g_sound_buffer; }

// Pack completed 1024-frame slots from the accumulation buffer into g_sound_buffer
// (left[1024] then right[1024] per slot). Returns frames-per-channel packed
// (1024 per slot) — mirrors vAmiga's wasm_copy_into_sound_buffer return convention.
EMSCRIPTEN_KEEPALIVE
int wasm_copy_into_sound_buffer(void) {
    int complete = g_audio_accum_n / AUDIO_SLOT_FRAMES;
    if (complete > AUDIO_SLOT_COUNT) complete = AUDIO_SLOT_COUNT;

    for (int s = 0; s < complete; s++) {
        float *slot = &g_sound_buffer[s * AUDIO_SLOT_FRAMES * 2];
        memcpy(slot,                     &g_audio_accum_L[s * AUDIO_SLOT_FRAMES],
               AUDIO_SLOT_FRAMES * sizeof(float));
        memcpy(slot + AUDIO_SLOT_FRAMES, &g_audio_accum_R[s * AUDIO_SLOT_FRAMES],
               AUDIO_SLOT_FRAMES * sizeof(float));
    }

    int remaining = g_audio_accum_n - complete * AUDIO_SLOT_FRAMES;
    if (remaining > 0 && complete > 0) {
        memmove(g_audio_accum_L, &g_audio_accum_L[complete * AUDIO_SLOT_FRAMES],
                remaining * sizeof(float));
        memmove(g_audio_accum_R, &g_audio_accum_R[complete * AUDIO_SLOT_FRAMES],
                remaining * sizeof(float));
    }
    g_audio_accum_n = remaining;
    return complete * AUDIO_SLOT_FRAMES;
}

// PUAE generates at 44100 Hz regardless; store the AudioContext rate for reference.
EMSCRIPTEN_KEEPALIVE
void wasm_set_sample_rate(unsigned rate) { (void)rate; }

// Raw accumulator access — lets JS push arbitrary-sized chunks to a ring-buffer
// worklet each tick rather than waiting for complete 1024-sample slots.
EMSCRIPTEN_KEEPALIVE
float *wasm_get_audio_accum_L(void) { return g_audio_accum_L; }

EMSCRIPTEN_KEEPALIVE
float *wasm_get_audio_accum_R(void) { return g_audio_accum_R; }

EMSCRIPTEN_KEEPALIVE
int wasm_get_audio_accum_count(void) { return g_audio_accum_n; }

EMSCRIPTEN_KEEPALIVE
void wasm_reset_audio_accum(void) { g_audio_accum_n = 0; }

// --- Debug exports (Stage D) ---
// wasm_tick() returns early (libretro_frame_end=true) when a breakpoint fires.
// The JS loop checks wasm_is_paused() after each tick to detect the halt.

EMSCRIPTEN_KEEPALIVE
int wasm_is_paused(void) { return puae_debug_is_paused(); }

// Register layout (19 × uint32_t): D0-D7 (regs[0..7]), A0-A7 (regs[8..15]), SR, PC, USP.
#define WASM_REG_COUNT 19
static uint32_t g_reg_buf[WASM_REG_COUNT];

// Populate g_reg_buf from live CPU state; returns the number of registers written.
EMSCRIPTEN_KEEPALIVE
int wasm_read_regs(void) {
    return (int)puae_debug_read_regs(g_reg_buf, WASM_REG_COUNT);
}

EMSCRIPTEN_KEEPALIVE
uint32_t *wasm_get_reg_buf(void) { return g_reg_buf; }

EMSCRIPTEN_KEEPALIVE
void wasm_add_breakpoint(uint32_t addr) { puae_debug_add_breakpoint(addr); }

EMSCRIPTEN_KEEPALIVE
void wasm_remove_breakpoint(uint32_t addr) { puae_debug_remove_breakpoint(addr); }

EMSCRIPTEN_KEEPALIVE
void wasm_resume(void) { puae_debug_resume(); }

EMSCRIPTEN_KEEPALIVE
void wasm_pause(void) { puae_debug_pause(); }

EMSCRIPTEN_KEEPALIVE
int wasm_set_reg(uint32_t regnum, uint32_t value) { return puae_debug_write_reg(regnum, value); }

// Defined in main.c. Requests a hard reset (reboot from Kickstart, RAM
// cleared) — processed by m68k_go() over the next couple of wasm_tick()
// calls, not synchronously. Used to reuse an already-booted wasm module +
// webview for a new debug session without re-instantiating either.
extern void uae_reset(int hardreset, int keyboardreset);

EMSCRIPTEN_KEEPALIVE
void wasm_reset(void) {
    puae_debug_resume(); // clear any debugger-halt state so ticks actually run
    uae_reset(1, 0);
}

// One-shot vblank callback for wasm_eof(): pauses on the next completed
// frame, then de-registers itself.
static void wasm_eof_vblank_cb(void *user) {
    (void)user;
    puae_debug_pause();
    puae_debug_set_vblank_callback(NULL, NULL);
}

// Resumes execution and arranges for it to pause again once the current
// frame finishes rendering (i.e. "run to end of frame").
EMSCRIPTEN_KEEPALIVE
void wasm_eof(void) {
    puae_debug_set_vblank_callback(wasm_eof_vblank_cb, NULL);
    puae_debug_resume();
}

// One-shot hblank callback for wasm_eol(): pauses on the next completed
// scanline, then de-registers itself.
static void wasm_eol_hblank_cb(void *user) {
    (void)user;
    puae_debug_pause();
    puae_debug_set_hblank_callback(NULL, NULL);
}

// Resumes execution and arranges for it to pause again once the current
// scanline finishes (i.e. "run to end of line").
EMSCRIPTEN_KEEPALIVE
void wasm_eol(void) {
    puae_debug_set_hblank_callback(wasm_eol_hblank_cb, NULL);
    puae_debug_resume();
}

EMSCRIPTEN_KEEPALIVE
void wasm_add_temp_breakpoint(uint32_t addr) { puae_debug_add_temp_breakpoint(addr); }

EMSCRIPTEN_KEEPALIVE
void wasm_remove_temp_breakpoint(uint32_t addr) { puae_debug_remove_temp_breakpoint(addr); }

// --- Debug exports (Stage G1) ---

// --- Memory ---
#define MEM_BUF_CAP 4096
static uint8_t g_mem_buf[MEM_BUF_CAP];

EMSCRIPTEN_KEEPALIVE
int wasm_read_memory(uint32_t addr, uint32_t len) {
    if (len > MEM_BUF_CAP) len = MEM_BUF_CAP;
    return (int)puae_debug_read_memory(addr, g_mem_buf, len);
}

EMSCRIPTEN_KEEPALIVE
uint8_t *wasm_get_mem_buf(void) { return g_mem_buf; }

EMSCRIPTEN_KEEPALIVE
int wasm_write_memory(uint32_t addr, uint32_t value, uint32_t size) {
    return puae_debug_write_memory(addr, value, size);
}

// Bulk write of an arbitrary-length buffer (e.g. program segments). Caller
// mallocs `data` in the wasm heap, HEAPU8.set()s the bytes, then frees it.
EMSCRIPTEN_KEEPALIVE
int wasm_write_memory_buf(uint32_t addr, const uint8_t *data, uint32_t len) {
    return (int)puae_debug_write_memory_buf(addr, data, len);
}

// Like wasm_read_memory/wasm_write_memory, but don't suspend
// watchpoint/protect checks — used to exercise the Stage G2 memhooks
// deterministically (e.g. from test_g2.mjs).
EMSCRIPTEN_KEEPALIVE
int wasm_poke_memory(uint32_t addr, uint32_t value, uint32_t size) {
    return puae_debug_poke_memory(addr, value, size);
}

EMSCRIPTEN_KEEPALIVE
int wasm_peek_memory(uint32_t addr, uint32_t len) {
    if (len > MEM_BUF_CAP) len = MEM_BUF_CAP;
    return (int)puae_debug_peek_memory(addr, g_mem_buf, len);
}

// --- Memory bank map (Stage G3) ---
#define MEMORY_MAP_BUF_CAP 256
static uint8_t g_memory_map_buf[MEMORY_MAP_BUF_CAP];

EMSCRIPTEN_KEEPALIVE
int wasm_read_memory_map(void) {
    return (int)puae_debug_read_memory_map(g_memory_map_buf, MEMORY_MAP_BUF_CAP);
}

EMSCRIPTEN_KEEPALIVE
uint8_t *wasm_get_memory_map_buf(void) { return g_memory_map_buf; }

// --- Display-control registers (write-only on the 68k bus) ---
static uint16_t g_display_regs_buf[PUAE_DISPLAY_REG_COUNT];

EMSCRIPTEN_KEEPALIVE
int wasm_read_display_regs(void) {
    return (int)puae_debug_read_display_regs(g_display_regs_buf, PUAE_DISPLAY_REG_COUNT);
}

EMSCRIPTEN_KEEPALIVE
uint16_t *wasm_get_display_regs_buf(void) { return g_display_regs_buf; }

// --- Raw custom-register image + audio registers (write-only on the 68k bus) ---
static uint8_t g_custom_regs_raw_buf[PUAE_CUSTOM_REGS_RAW_SIZE];

EMSCRIPTEN_KEEPALIVE
int wasm_read_custom_regs_raw(void) {
    return (int)puae_debug_read_custom_regs_raw(g_custom_regs_raw_buf, PUAE_CUSTOM_REGS_RAW_SIZE);
}

EMSCRIPTEN_KEEPALIVE
uint8_t *wasm_get_custom_regs_raw_buf(void) { return g_custom_regs_raw_buf; }

static uint8_t g_audio_regs_buf[PUAE_AUDIO_REGS_SIZE];

EMSCRIPTEN_KEEPALIVE
int wasm_read_audio_regs(void) {
    return (int)puae_debug_read_audio_regs(g_audio_regs_buf, PUAE_AUDIO_REGS_SIZE);
}

EMSCRIPTEN_KEEPALIVE
uint8_t *wasm_get_audio_regs_buf(void) { return g_audio_regs_buf; }

// --- Disassembly ---
#define DISASM_BUF_CAP 256
static char g_disasm_buf[DISASM_BUF_CAP];

EMSCRIPTEN_KEEPALIVE
int wasm_disassemble(uint32_t pc) {
    return (int)puae_debug_disassemble_quick(pc, g_disasm_buf, sizeof(g_disasm_buf));
}

EMSCRIPTEN_KEEPALIVE
const char *wasm_get_disasm_buf(void) { return g_disasm_buf; }

// --- CPU instruction trace ---
EMSCRIPTEN_KEEPALIVE
void wasm_enable_cpu_logging(int enabled) { puae_debug_enable_cpu_logging(enabled); }

// Interleaved (pc, sr) uint32 pairs, most-recently-executed first.
#define CPU_TRACE_BUF_CAP (PUAE_DEBUG_CPU_TRACE_CAP * 2)
static uint32_t g_cpu_trace_buf[CPU_TRACE_BUF_CAP];

EMSCRIPTEN_KEEPALIVE
int wasm_read_cpu_trace(uint32_t count) {
    return (int)puae_debug_read_cpu_trace(count, g_cpu_trace_buf, CPU_TRACE_BUF_CAP);
}

EMSCRIPTEN_KEEPALIVE
uint32_t *wasm_get_cpu_trace_buf(void) { return g_cpu_trace_buf; }

// --- Step variants ---
// Each clears puae_debug_is_paused(); caller must loop wasm_tick() until it
// reports paused again, mirroring the breakpoint flow.

EMSCRIPTEN_KEEPALIVE
void wasm_step_instr(void) { puae_debug_step_instr(); }

EMSCRIPTEN_KEEPALIVE
void wasm_step_line(void) { puae_debug_step_line(); }

EMSCRIPTEN_KEEPALIVE
void wasm_step_next(void) { puae_debug_step_next(); }

EMSCRIPTEN_KEEPALIVE
void wasm_step_out(void) { puae_debug_step_out(); }

// --- Callstack ---
#define CALLSTACK_BUF_CAP 256
static uint32_t g_callstack_buf[CALLSTACK_BUF_CAP];

EMSCRIPTEN_KEEPALIVE
int wasm_read_callstack(void) {
    return (int)puae_debug_read_callstack(g_callstack_buf, CALLSTACK_BUF_CAP);
}

EMSCRIPTEN_KEEPALIVE
uint32_t *wasm_get_callstack_buf(void) { return g_callstack_buf; }

// --- Cycle count (uint64_t split into lo/hi for cwrap, which can't return
// 64-bit values without -sWASM_BIGINT) ---
static uint64_t g_cycle_count;

EMSCRIPTEN_KEEPALIVE
void wasm_read_cycle_count(void) { g_cycle_count = puae_debug_read_cycle_count(); }

EMSCRIPTEN_KEEPALIVE
uint32_t wasm_get_cycle_count_lo(void) { return (uint32_t)(g_cycle_count & 0xFFFFFFFFu); }

EMSCRIPTEN_KEEPALIVE
uint32_t wasm_get_cycle_count_hi(void) { return (uint32_t)(g_cycle_count >> 32); }

// --- Instruction count (uint64_t split into lo/hi, same convention as cycle
// count above) ---
static uint64_t g_instr_count;

EMSCRIPTEN_KEEPALIVE
void wasm_read_instr_count(void) { g_instr_count = puae_debug_read_instr_count(); }

EMSCRIPTEN_KEEPALIVE
uint32_t wasm_get_instr_count_lo(void) { return (uint32_t)(g_instr_count & 0xFFFFFFFFu); }

EMSCRIPTEN_KEEPALIVE
uint32_t wasm_get_instr_count_hi(void) { return (uint32_t)(g_instr_count >> 32); }

// Not part of the libretro savestate — must be restored explicitly after
// wasm_unserialize (see puae_debug_write_instr_count).
EMSCRIPTEN_KEEPALIVE
void wasm_write_instr_count(uint32_t lo, uint32_t hi) {
    puae_debug_write_instr_count(((uint64_t)hi << 32) | (uint64_t)lo);
}

// --- CPU + DMA profiler ---

extern int  g_wprofActive;
extern void wasm_profile_prepare(void);
extern void wasm_profile_finish(int numFrames);
extern void wasm_dma_serialize_grid(void);

extern int  debug_dma;
extern void record_dma_reset(int start);

// Runs numFrames PAL/NTSC frames, sampling CPU call stacks and DMA slots.
// Returns 1 on success.
EMSCRIPTEN_KEEPALIVE
int wasm_profile_start(int numFrames)
{
    wasm_profile_prepare();
    record_dma_reset(1);   /* alloc if needed, toggle buffer, set debug_dma=1 */
    int target = (int)g_frame_count + numFrames;
    while ((int)g_frame_count < target) {
        libretro_frame_end = false;
        retro_run();
    }
    debug_dma = 0;
    wasm_profile_finish(numFrames);
    wasm_dma_serialize_grid();
    return 1;
}

// DMA grid, chip/slow RAM ptrs — implemented in puae_debug.c (has PUAE headers).
extern const uint8_t *wasm_dma_get_grid_ptr(void);
extern uint32_t       wasm_dma_get_grid_size(void);
extern uint32_t       wasm_dma_get_chip_ptr(void);
extern uint32_t       wasm_dma_get_chip_size(void);
extern uint32_t       wasm_dma_get_slow_ptr(void);
extern uint32_t       wasm_dma_get_slow_size(void);

// --- Bulk instruction replay (Phase 2 exact-instruction rewind) ---

EMSCRIPTEN_KEEPALIVE
void wasm_replay_instructions(uint32_t count) { puae_debug_replay_instructions(count); }

// Like wasm_replay_instructions, but lets shim_video_refresh update the pixel
// buffer/frame count for frames rendered during the replay — used for the
// final "land on target" replay so the on-screen framebuffer reflects the
// landed-on state.
EMSCRIPTEN_KEEPALIVE
void wasm_replay_instructions_video(uint32_t count) { puae_debug_replay_instructions_video(count); }

static uint64_t g_replay_scan_match;

EMSCRIPTEN_KEEPALIVE
void wasm_replay_scan(uint32_t count) { g_replay_scan_match = puae_debug_replay_scan(count); }

// Shares g_replay_scan_match/wasm_get_replay_scan_match_lo/hi with
// wasm_replay_scan above — only one scan kind runs at a time.
EMSCRIPTEN_KEEPALIVE
void wasm_replay_scan_frame(uint32_t count) { g_replay_scan_match = puae_debug_replay_scan_frame(count); }

// Combined scan + video in one pass — see puae_debug_replay_scan_video.
EMSCRIPTEN_KEEPALIVE
void wasm_replay_scan_video(uint32_t count) { g_replay_scan_match = puae_debug_replay_scan_video(count); }

EMSCRIPTEN_KEEPALIVE
uint32_t wasm_get_replay_scan_match_lo(void) { return (uint32_t)(g_replay_scan_match & 0xFFFFFFFFu); }

EMSCRIPTEN_KEEPALIVE
uint32_t wasm_get_replay_scan_match_hi(void) { return (uint32_t)(g_replay_scan_match >> 32); }

// --- Watchpoints (Stage G2) ---
// puae_debug_watchpoint_t is 7 x uint32 (addr, op_mask, diff_operand,
// value_operand, old_value_operand, size_operand, addr_mask_operand).
static puae_debug_watchpoint_t g_watchpoint_buf[PUAE_WATCHPOINT_COUNT];
static puae_debug_watchbreak_t g_watchbreak_buf;
static uint64_t g_watchpoint_enabled_mask;

// Clears all watchpoints and register watches. Needed because the webview
// (and its WASM module instance) can be reused across debug sessions while
// the TS-side bookkeeping (BreakpointManager) is recreated fresh each
// session — without this, a watch armed in a previous session has no
// record anywhere that would let the new session remove it, yet it stays
// live in the engine and keeps firing.
EMSCRIPTEN_KEEPALIVE
void wasm_reset_debug_watches(void) {
    puae_debug_reset_watchpoints();
    puae_debug_reset_regwatches();
}

EMSCRIPTEN_KEEPALIVE
int wasm_add_watchpoint(uint32_t addr, uint32_t op_mask, uint32_t diff_operand, uint32_t value_operand,
                         uint32_t old_value_operand, uint32_t size_operand, uint32_t addr_mask_operand) {
    return puae_debug_add_watchpoint(addr, op_mask, diff_operand, value_operand,
                                     old_value_operand, size_operand, addr_mask_operand);
}

EMSCRIPTEN_KEEPALIVE
void wasm_remove_watchpoint(uint32_t index) { puae_debug_remove_watchpoint(index); }

EMSCRIPTEN_KEEPALIVE
int wasm_read_watchpoints(void) {
    return (int)puae_debug_read_watchpoints(g_watchpoint_buf, PUAE_WATCHPOINT_COUNT);
}

EMSCRIPTEN_KEEPALIVE
uint32_t *wasm_get_watchpoint_buf(void) { return (uint32_t *)g_watchpoint_buf; }

EMSCRIPTEN_KEEPALIVE
void wasm_read_watchpoint_enabled_mask(void) { g_watchpoint_enabled_mask = puae_debug_get_watchpoint_enabled_mask(); }

EMSCRIPTEN_KEEPALIVE
uint32_t wasm_get_watchpoint_enabled_mask_lo(void) { return (uint32_t)(g_watchpoint_enabled_mask & 0xFFFFFFFFu); }

EMSCRIPTEN_KEEPALIVE
uint32_t wasm_get_watchpoint_enabled_mask_hi(void) { return (uint32_t)(g_watchpoint_enabled_mask >> 32); }

EMSCRIPTEN_KEEPALIVE
void wasm_set_watchpoint_enabled_mask(uint32_t lo, uint32_t hi) {
    puae_debug_set_watchpoint_enabled_mask(((uint64_t)hi << 32) | (uint64_t)lo);
}

EMSCRIPTEN_KEEPALIVE
int wasm_consume_watchbreak(void) {
    return puae_debug_consume_watchbreak(&g_watchbreak_buf);
}

EMSCRIPTEN_KEEPALIVE
uint32_t *wasm_get_watchbreak_buf(void) { return (uint32_t *)&g_watchbreak_buf; }

// --- Register watches (break when a CPU register's own value changes) ---
static puae_debug_regwatchbreak_t g_regwatchbreak_buf;

EMSCRIPTEN_KEEPALIVE
int wasm_add_regwatch(uint32_t regIndex) {
    return puae_debug_add_regwatch(regIndex);
}

EMSCRIPTEN_KEEPALIVE
void wasm_remove_regwatch(uint32_t regIndex) { puae_debug_remove_regwatch(regIndex); }

EMSCRIPTEN_KEEPALIVE
uint32_t wasm_get_regwatch_enabled_mask(void) { return puae_debug_get_regwatch_enabled_mask(); }

EMSCRIPTEN_KEEPALIVE
int wasm_consume_regwatchbreak(void) {
    return puae_debug_consume_regwatchbreak(&g_regwatchbreak_buf);
}

EMSCRIPTEN_KEEPALIVE
uint32_t *wasm_get_regwatchbreak_buf(void) { return (uint32_t *)&g_regwatchbreak_buf; }

// --- Memory protection (breaks on writes outside an allow-list of ranges) ---
// puae_debug_memprotect_break_t is 4 x uint32 (pc, addr, value, sizeBits).
static puae_debug_memprotect_break_t g_memprotect_break_buf;

EMSCRIPTEN_KEEPALIVE
void wasm_memprotect_set_enabled(int enabled) { puae_debug_memprotect_set_enabled(enabled); }

EMSCRIPTEN_KEEPALIVE
int wasm_memprotect_start_tracking(void) { return puae_debug_memprotect_start_tracking(); }

EMSCRIPTEN_KEEPALIVE
int wasm_memprotect_seed_libraries(void) { return puae_debug_memprotect_seed_libraries(); }

EMSCRIPTEN_KEEPALIVE
void wasm_memprotect_reset_ranges(void) { puae_debug_memprotect_reset_ranges(); }

EMSCRIPTEN_KEEPALIVE
int wasm_memprotect_add_range(uint32_t addr, uint32_t size) {
    return puae_debug_memprotect_add_range(addr, size);
}

EMSCRIPTEN_KEEPALIVE
int wasm_consume_memprotect_break(void) {
    return puae_debug_memprotect_consume_break(&g_memprotect_break_buf);
}

EMSCRIPTEN_KEEPALIVE
uint32_t *wasm_get_memprotect_break_buf(void) { return (uint32_t *)&g_memprotect_break_buf; }

// --- Catchpoints (exception-based breakpoints) ---
// puae_debug_catchbreak_t is 2 x uint32 (pc, vector).
static puae_debug_catchbreak_t g_catchbreak_buf;

EMSCRIPTEN_KEEPALIVE
void wasm_set_catchpoint(uint32_t vector) { puae_debug_set_catchpoint(vector); }

EMSCRIPTEN_KEEPALIVE
void wasm_remove_catchpoint(uint32_t vector) { puae_debug_remove_catchpoint(vector); }

EMSCRIPTEN_KEEPALIVE
int wasm_consume_catchbreak(void) {
    return puae_debug_consume_catchbreak(&g_catchbreak_buf);
}

EMSCRIPTEN_KEEPALIVE
uint32_t *wasm_get_catchbreak_buf(void) { return (uint32_t *)&g_catchbreak_buf; }

EMSCRIPTEN_KEEPALIVE
uint32_t wasm_get_chip_mem_size(void) { return puae_debug_get_chip_mem_size(); }

// --- Save state snapshots (reverse stepping) ---
// Thin wrappers around the standard libretro save-state API, used by the
// frontend to capture/restore full emulator state for step-back support.

// PUAE_DEBUG_EVENT_PHASE_WORDS extra uint32_t's appended after the regular libretro
// savestate blob, preserving eventtab[ev_hsync/ev_hsynch/ev_misc] phase info
// that retro_serialize/retro_unserialize don't (see puae_debug_capture_event_phase
// / puae_debug_restore_event_phase in puae_debug.c for why this is needed).
#define EVENT_PHASE_BYTES (PUAE_DEBUG_EVENT_PHASE_WORDS * sizeof(uint32_t))

EMSCRIPTEN_KEEPALIVE
size_t wasm_serialize_size(void) { return retro_serialize_size() + EVENT_PHASE_BYTES; }

EMSCRIPTEN_KEEPALIVE
int wasm_serialize(void *buf, size_t size) {
    size_t base = retro_serialize_size();
    if (size < base + EVENT_PHASE_BYTES) return 0;
    if (!retro_serialize(buf, base)) return 0;
    puae_debug_capture_event_phase((uint32_t *)((uint8_t *)buf + base));
    return 1;
}

EMSCRIPTEN_KEEPALIVE
int wasm_unserialize(const void *buf, size_t size) {
    size_t base = retro_serialize_size();
    if (size < base + EVENT_PHASE_BYTES) return 0;
    puae_debug_suspend_breakpoints();
    int ok = retro_unserialize(buf, base);
    puae_debug_resume_breakpoints();
    if (!ok) return 0;
    puae_debug_restore_event_phase((const uint32_t *)((const uint8_t *)buf + base));
    return 1;
}

int main(void) {
    EM_ASM({ console.log('[shim] module loaded, call _wasm_boot() to start'); });
    return 0;
}
