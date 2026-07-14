// Mouse capture (pointer lock) for the PUAE webview's emulated Amiga mouse —
// ports vamiga_app.js's setupMouse to the PUAE wasm bridge's
// wasm_set_mouse_delta/wasm_set_mouse_button (frontend_shim.c), which feed
// libretro-mapper.c's RETRO_DEVICE_MOUSE polling for port 0 (enabled by
// default via opt_physicalmouse) into UAE's mouse emulation.
//
// Left click on the canvas requests pointer lock; middle click releases it.
// While locked, mouse movement/buttons are read from `document` (not the
// canvas) since the OS cursor is hidden/unconstrained during pointer lock —
// listening on canvas alone would miss events once the pointer leaves its
// bounds.
import type { PuaeModule } from "./types";

export function installMouseCapture(canvas: HTMLCanvasElement, M: PuaeModule): void {
  function updatePosition(event: MouseEvent): void {
    M._wasm_set_mouse_delta(event.movementX, event.movementY);
  }

  // event.button matches wasm_set_mouse_button's expected numbering
  // (DOM MouseEvent.button: 0=left, 1=middle, 2=right) directly.
  function mouseDown(event: MouseEvent): void {
    if (event.button === 1) {
      // Middle button releases capture rather than being forwarded. preventDefault stops the
      // browser's own middle-click autoscroll (the pan-cursor overlay most browsers show on a
      // middle mousedown) from kicking in at the same moment the pointer is unlocked — otherwise
      // the freed OS cursor reappears already in autoscroll mode, which looks like the release
      // didn't work even though exitPointerLock() did fire.
      event.preventDefault();
      document.exitPointerLock?.();
      return;
    }
    M._wasm_set_mouse_button(event.button, 1);
  }

  function mouseUp(event: MouseEvent): void {
    if (event.button === 1) return;
    M._wasm_set_mouse_button(event.button, 0);
  }

  function lockChangeAlert(): void {
    if (document.pointerLockElement === canvas) {
      document.addEventListener("mousemove", updatePosition);
      document.addEventListener("mousedown", mouseDown);
      document.addEventListener("mouseup", mouseUp);
    } else {
      document.removeEventListener("mousemove", updatePosition);
      document.removeEventListener("mousedown", mouseDown);
      document.removeEventListener("mouseup", mouseUp);
    }
  }

  document.addEventListener("pointerlockchange", lockChangeAlert);

  // Registered after installDmaHoverTooltip's click listener (app.ts
  // installs this second) — that listener calls stopImmediatePropagation
  // when it opens a source file, so a click that opens source doesn't also
  // request pointer lock on the same click.
  canvas.addEventListener("click", () => {
    // Don't capture the mouse while paused: this is exactly when the user is most likely
    // hovering the canvas to read the screen-reconstruction tooltip (screenHover.ts) or the DMA
    // overlay tooltip (dmaHover.ts), and pointer lock would hijack the cursor (hiding it and
    // switching mousemove to relative deltas) instead of letting them inspect the picture.
    if (M._wasm_is_paused()) return;
    void canvas.requestPointerLock();
  });
}
