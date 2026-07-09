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

// RETROK_* values (enum retro_key, libretro.h) for each DOM KeyboardEvent.code
// this emulator's Amiga keyboard can make use of. Omitted codes (browser/OS
// chrome keys with no Amiga equivalent, e.g. clipboard/media keys) are simply
// never forwarded.
const CODE_TO_RETROK: Record<string, number> = {
  // Letters (RETROK_a..RETROK_z = 97..122)
  KeyA: 97, KeyB: 98, KeyC: 99, KeyD: 100, KeyE: 101, KeyF: 102, KeyG: 103,
  KeyH: 104, KeyI: 105, KeyJ: 106, KeyK: 107, KeyL: 108, KeyM: 109, KeyN: 110,
  KeyO: 111, KeyP: 112, KeyQ: 113, KeyR: 114, KeyS: 115, KeyT: 116, KeyU: 117,
  KeyV: 118, KeyW: 119, KeyX: 120, KeyY: 121, KeyZ: 122,
  // Digit row (RETROK_0..RETROK_9 = 48..57)
  Digit0: 48, Digit1: 49, Digit2: 50, Digit3: 51, Digit4: 52,
  Digit5: 53, Digit6: 54, Digit7: 55, Digit8: 56, Digit9: 57,
  // Punctuation
  Minus: 45, Equal: 61, BracketLeft: 91, BracketRight: 93, Backslash: 92,
  Semicolon: 59, Quote: 39, Backquote: 96, Comma: 44, Period: 46, Slash: 47,
  // Whitespace / editing
  Space: 32, Enter: 13, Tab: 9, Backspace: 8, Escape: 27, Delete: 127,
  // Locks / modifiers
  CapsLock: 301, NumLock: 300, ScrollLock: 302,
  ShiftLeft: 304, ShiftRight: 303, ControlLeft: 306, ControlRight: 305,
  AltLeft: 308, AltRight: 307, MetaLeft: 310, MetaRight: 309,
  // Navigation
  ArrowUp: 273, ArrowDown: 274, ArrowRight: 275, ArrowLeft: 276,
  Insert: 277, Home: 278, End: 279, PageUp: 280, PageDown: 281,
  // Function keys (RETROK_F1..RETROK_F12 = 282..293)
  F1: 282, F2: 283, F3: 284, F4: 285, F5: 286, F6: 287,
  F7: 288, F8: 289, F9: 290, F10: 291, F11: 292, F12: 293,
  // Misc
  Pause: 19, PrintScreen: 316, ContextMenu: 319,
  // Numeric keypad
  Numpad0: 256, Numpad1: 257, Numpad2: 258, Numpad3: 259, Numpad4: 260,
  Numpad5: 261, Numpad6: 262, Numpad7: 263, Numpad8: 264, Numpad9: 265,
  NumpadDecimal: 266, NumpadDivide: 267, NumpadMultiply: 268,
  NumpadSubtract: 269, NumpadAdd: 270, NumpadEnter: 271, NumpadEqual: 272,
};

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
