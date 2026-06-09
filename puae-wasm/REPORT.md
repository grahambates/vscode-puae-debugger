# PUAE/WinUAE wasm spike — go/no-go report

Spike code lives in `puae-wasm/` (build via `./build.sh`, see header
comments for prerequisites). Plan: `there-may-be-aga-foamy-liskov.md`.

**Question answered**: can `libretro-uae` (PUAE/WinUAE core) plus `ami9000`'s
`e9k_debug` API be made to run acceptably in a browser/webview, as a future
68030/040/060+MMU/FPU-capable backend alongside vAmiga?

## Verdict: GO

All five stages (A–E) passed. No fundamental blocker found.

## Verification against plan criteria

### 1. Build feasibility — PASS
Stock `libretro-uae` builds for Emscripten with `STATIC_LINKING=1` and only a
small, documented 3-file/5-function patch (`libretro-uae.patch` — `double` →
`float` signature fixes for wasm trampolines). The debug layer (`e9k_debug.c`
+ instrumented `newcpu.c` from ami9000) is grafted in by swapping one object
file in the resulting archive — no fork of the full ami9000 build was needed.
Whole build is ~4 stages, fully scripted, no external repo dependencies
(`e9k/` sources vendored in-tree).

### 2. Video — PASS
Canvas2D rendering at a solid **50 fps**, single-threaded. `retro_run()` costs
~8.9 ms/frame against a 20 ms (50 Hz) budget — plenty of headroom. Pixel
format is RGB565, converted to RGBA in the C shim before `putImageData`.

Known cosmetic issue (non-blocking): minor left-border/right-crop in the
720×574 framebuffer due to PAL overscan vs. DIWSTRT; fixable later via
`puae_horizontal_pos` tuning.

### 3. Audio — PASS
`AudioWorkletNode` ring-buffer playback in sync with video, confirmed in both
the bare HTML page and the VS Code webview. Required per-chunk resampling
(PUAE's fixed 44100 Hz output → macOS's 48000 Hz `AudioContext`, 882→960
samples/tick) — implemented via linear interpolation in JS. Noted as "still
not perfect" in earlier testing but functional; worth revisiting tuning later
but not a blocker.

### 4. Debug bridge — PASS
`e9k_debug` API wired end-to-end: `wasm_add_breakpoint`/`wasm_remove_breakpoint`,
`wasm_resume`, `wasm_is_paused`, `wasm_read_regs`/`wasm_get_reg_buf` (D0-D7,
A0-A7, SR, PC). Confirmed: setting a breakpoint halts the emulator at the
expected PC, register dump is correct, and resume continues execution. Tested
both standalone and inside the VS Code webview.

### 5. Threading — single-threaded is sufficient
8.9 ms/frame for 68000/OCS leaves 11.1 ms headroom at 50 Hz. No
SharedArrayBuffer / COOP-COEP / `WASM_WORKERS` needed, which sidesteps
cross-origin-isolation header complications a VS Code webview would otherwise
impose. If 68030/040/060 configs (the actual motivation for this backend) turn
out meaningfully heavier, re-measure before reaching for a worker-based
approach — vAmiga's `thread_type=worker` is the documented fallback pattern.

### 6. Licensing — flagged, not a spike blocker
`libretro-uae`/`ami9000` are GPLv2, same as vAmiga's `Core/`. The existing
precedent (separately-built `.wasm`/`.js` artifact loaded at runtime, not
statically linked into the extension bundle — see vAmiga's `publish`/`uat`
CMake targets) should apply equally here. **Action before productionizing**:
confirm this isolation boundary satisfies the extension's distribution model;
not investigated further as part of this spike.

## VS Code webview integration (Stage E) — PASS
A throwaway `vamiga-debugger.puaeSpike` command
(`src/puaeSpike.ts`/`src/extension.ts`) opens the Stage D build inside a real
`createWebviewPanel`. Confirmed working with `localResourceRoots` scoped to
`puae-wasm/`:
- wasm boot/video render — required CSP `script-src 'wasm-unsafe-eval'
  'unsafe-inline'` plus an emscripten `locateFile` override (webview URIs have
  no meaning to emscripten's default `.wasm`-relative-to-script lookup)
- ROM loading — the ROM file is a symlink outside the workspace
  (`localResourceRoots` can't reach it); resolved via `realpathSync` and
  embedded as a base64 `data:` URI instead
- AudioWorklet — required `worker-src <cspSource> blob:` in the CSP;
  audio plays correctly
- Debug bridge — breakpoints/register reads work identically to the bare HTML
  page

No webview-specific blockers found beyond the CSP/resource-URI adjustments
above, all of which are one-time, documented patterns reusable for a real
integration.

## Summary for next steps
This justifies investing in a generic `Emulator` interface abstraction with
PUAE/ami9000 as a second backend (targeting 68030/040/060+MMU/FPU configs
vAmiga can't cover). Recommended follow-ups before that work begins:
- Tune audio resampling further (Stage C note: "still not perfect")
- Resolve the GPLv2 distribution question (#6) concretely for this extension
- Re-measure frame timing for 68030/040 configs to confirm the
  single-threaded verdict still holds for the actual target configs
