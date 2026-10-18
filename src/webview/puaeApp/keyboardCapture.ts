// Keyboard capture for the PUAE webview's emulated Amiga keyboard — mirrors
// mouseCapture.ts's structure. DOM keydown/keyup events are translated (by
// physical key, via KeyboardEvent.code — layout-independent, so e.g. the key
// physically labelled 'A' always reaches the emulator as 'A' regardless of
// the host OS keyboard layout) to libretro RETROK_* codes and forwarded to
// wasm_key_event (frontend_shim.c), which feeds them into the captured
// retro_keyboard_event callback — libretro-mapper.c's own, already-proven
// RETROK_* -> Amiga AK_* translation (keyboard_translation[]) handles the
// rest, the same table real RetroArch PUAE frontends use.
//
// Click the canvas to focus it (like mouse capture's click-to-lock gesture)
// — that's the explicit "keyboard input goes to the emulator now" action.
// Listeners are only attached while the canvas itself has focus, so the
// toolbar's own controls (scale <select>, opacity/decay <input type=range>,
// filter text boxes) keep normal keyboard behaviour when focused instead.
import type { PuaeModule } from "./types";
import { CODE_TO_RETROK } from "../../shared/retroKeys";


export function installKeyboardCapture(canvas: HTMLCanvasElement, M: PuaeModule): void {
  // Canvases aren't focusable by default; tabIndex makes this one a valid
  // focus target (and click-to-focus below actually work).
  if (canvas.tabIndex < 0) canvas.tabIndex = 0;

  function keyDown(event: KeyboardEvent): void {
    const code = CODE_TO_RETROK[event.code];
    if (code === undefined) return;
    event.preventDefault();
    M._wasm_key_event(1, code, 0, 0);
  }

  function keyUp(event: KeyboardEvent): void {
    const code = CODE_TO_RETROK[event.code];
    if (code === undefined) return;
    event.preventDefault();
    M._wasm_key_event(0, code, 0, 0);
  }

  canvas.addEventListener("focus", () => {
    canvas.addEventListener("keydown", keyDown);
    canvas.addEventListener("keyup", keyUp);
  });
  canvas.addEventListener("blur", () => {
    canvas.removeEventListener("keydown", keyDown);
    canvas.removeEventListener("keyup", keyUp);
  });
  canvas.addEventListener("mousedown", () => canvas.focus());
}
