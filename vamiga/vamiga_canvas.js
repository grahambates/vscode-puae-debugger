// Framebuffer -> 2D canvas blit, trimmed from the original vAmiga_canvas.js
// (which also had a WebGL shader rendering path and jQuery-based responsive
// scaling — both dropped; CSS handles responsive sizing instead, and the 2D
// path is the only renderer now).
//
// HPIXELS/VPIXELS are the framebuffer's fixed raw row stride/height — a
// hardware constant (full PAL scanline/field count including blanking).
const TPP = 1;
const HPIXELS = 912 * TPP;
const VPIXELS = 313;
// Derived from the standard Amiga DIWSTRT/DIWSTOP register values —
// DIWSTRT=(0x2C,0x81), DIWSTOP=(0x12C,0x1C1) — the chipset's actual default
// display-window bounds, not a guess. DIWSTRT/DIWSTOP's horizontal field is
// in color-clock units (1 CCK = 2 lores pixels), doubled to convert into
// our pixel-buffer's column space and shifted by the same -72 offset
// js_set_display's xOff always applied; vertical values are used directly
// (already in line units). That gives an active window of 640x256 pixels
// at buffer position (186, 44).
const ACTIVE_LEFT = 129 * 2 - 72; // = 186
const ACTIVE_TOP = 44;
const ACTIVE_WIDTH = (449 - 129) * 2; // = 640
const ACTIVE_HEIGHT = 300 - 44; // = 256

// Fixed crop, centered on the active window above with a symmetric
// overscan margin — matches PUAE's <canvas width=720 height=574> on the X
// axis exactly; Y is capped by how much room is actually left below the
// active window within the VPIXELS=313 field (the standard window already
// sits close to the field's bottom edge), so its margin is smaller than X's
// to stay symmetric without overrunning the buffer.
const CROP_WIDTH = 720;
const MARGIN_Y = Math.min((CROP_WIDTH - ACTIVE_WIDTH) / 2, VPIXELS - (ACTIVE_TOP + ACTIVE_HEIGHT), ACTIVE_TOP);
const CROP_HEIGHT = ACTIVE_HEIGHT + MARGIN_Y * 2; // *2 again below (field doubling) for canvas height
const X_OFF = ACTIVE_LEFT - (CROP_WIDTH - ACTIVE_WIDTH) / 2;
const Y_OFF = ACTIVE_TOP - MARGIN_Y;

export function createCanvasRenderer(M, canvas) {
  // The framebuffer is a single field — the removed GL renderer always
  // displayed it stretched 2x vertically (`canvas.height = h*2`,
  // texture-sampled), which is what made it look like a normal full-height
  // Amiga screen. The 2D path needs to do the same stretch itself now that
  // it's the only renderer: blit the raw (unstretched) crop to an offscreen
  // canvas at native resolution, then drawImage it onto the visible canvas
  // at double height.
  const offscreen = document.createElement('canvas');
  offscreen.width = HPIXELS;
  offscreen.height = VPIXELS;
  const offCtx = offscreen.getContext('2d');
  const imageData = offCtx.createImageData(HPIXELS, VPIXELS);

  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  canvas.width = CROP_WIDTH;
  canvas.height = CROP_HEIGHT * 2;

  function render() {
    const pixels = M._wasm_pixel_buffer() + Y_OFF * (HPIXELS << 2);
    // Any heap view's .buffer is the same underlying ArrayBuffer — use
    // HEAPU8, which this build actually exports onto Module (HEAPU32 is
    // only a closure-local in the Emscripten glue, never attached to
    // Module, so `M.HEAPU32` is always undefined here).
    const pixelBuffer = new Uint8Array(M.HEAPU8.buffer, pixels, (HPIXELS * CROP_HEIGHT) << 2);
    imageData.data.set(pixelBuffer);
    offCtx.putImageData(imageData, 0, 0);
    ctx.drawImage(offscreen, X_OFF, 0, CROP_WIDTH, CROP_HEIGHT, 0, 0, CROP_WIDTH, CROP_HEIGHT * 2);
  }

  // The wasm core also calls this directly (bare global, see vamiga_app.js)
  // when the visible display area changes (e.g. autocropping) — ignored:
  // the canvas stays at a fixed position/size rather than chasing it.
  function setDisplay() {}

  return { render, setDisplay };
}
