// Physical-keyboard → Amiga keycode translation, trimmed from the original
// vAmiga_keyboard.js (which also rendered an on-screen virtual keyboard —
// dropped here; this is a desktop-only VS Code extension with a real
// keyboard). Source: https://github.com/dirkwhoffmann/vAmiga/blob/164c04d75f0ae739dd9f2ff2c28520db05e7c047/GUI/Peripherals/AmigaKey.swift

export const keyTranslationMap = {
  //--- ANSI
  Grave: 0,
  Digit1: 1,
  Digit2: 2,
  Digit3: 3,
  Digit4: 4,
  Digit5: 5,
  Digit6: 6,
  Digit7: 7,
  Digit8: 8,
  Digit9: 9,
  Digit0: 10,
  Minus: 0x0b,
  Equal: 0x0c,
  Backslash: 0x0d,

  Numpad0: 0x0f,

  KeyQ: 0x10,
  KeyW: 0x11,
  KeyE: 0x12,
  KeyR: 0x13,
  KeyT: 0x14,
  KeyY: 0x15,
  KeyU: 0x16,
  KeyI: 0x17,
  KeyO: 0x18,
  KeyP: 0x19,
  BracketLeft: 0x1a,
  BracketRight: 0x1b,

  Numpad1: 0x1d,
  Numpad2: 0x1e,
  Numpad3: 0x1f,

  KeyA: 0x20,
  KeyS: 0x21,
  KeyD: 0x22,
  KeyF: 0x23,
  KeyG: 0x24,
  KeyH: 0x25,
  KeyJ: 0x26,
  KeyK: 0x27,
  KeyL: 0x28,
  Semicolon: 0x29,
  Quote: 0x2a,

  Numpad4: 0x2d,
  Numpad5: 0x2e,
  Numpad6: 0x2f,

  KeyZ: 0x31,
  KeyX: 0x32,
  KeyC: 0x33,
  KeyV: 0x34,
  KeyB: 0x35,
  KeyN: 0x36,
  KeyM: 0x37,
  Comma: 0x38,
  Period: 0x39,
  Slash: 0x3a,

  NumpadDecimal: 0x3c,
  Numpad7: 0x3d,
  Numpad8: 0x3e,
  Numpad9: 0x3f,

  //--- Extra Keys on international Amigas (ISO style)
  hashtag: 0x2b,
  laceBrace: 0x30,

  // Amiga keycodes 0x40 - 0x5F (Codes common to all keyboards)
  Space: 0x40,
  Backspace: 0x41,
  Tab: 0x42,
  NumpadEnter: 0x43,
  Enter: 0x44,
  Escape: 0x45,
  Delete: 0x46,
  NumpadSubtract: 0x4a,
  ArrowUp: 0x4c,
  ArrowDown: 0x4d,
  ArrowRight: 0x4e,
  ArrowLeft: 0x4f,
  F1: 0x50,
  F2: 0x51,
  F3: 0x52,
  F4: 0x53,
  F5: 0x54,
  F6: 0x55,
  F7: 0x56,
  F8: 0x57,
  F9: 0x58,
  F10: 0x59,

  keypadLBracket: 0x5a,
  keypadRBracket: 0x5b,
  NumpadDivide: 0x5c,
  NumpadMultiply: 0x5d,
  NumpadAdd: 0x5e,
  Help: 0x5f,

  // 0x60 - 0x67 (Key codes for qualifier keys)
  ShiftLeft: 0x60,
  ShiftRight: 0x61,
  CapsLock: 0x62,
  ControlLeft: 0x63,
  AltLeft: 0x64,
  AltRight: 0x65,
  leftAmiga: 0x66,
  rightAmiga: 0x67,
};

// Returns { modifier: [code, 0] | null, raw_key: [code, 0] } for a
// KeyboardEvent's (code, key), or undefined if the code has no Amiga mapping.
export function translateKey(code) {
  const mapindex = keyTranslationMap[code];
  if (mapindex === undefined) return undefined;
  return { modifier: null, raw_key: [mapindex, 0] };
}
