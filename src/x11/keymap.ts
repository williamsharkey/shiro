/**
 * Keyboard mapping for the in-page X server: browser KeyboardEvent.code →
 * X keycode (evdev code + 8, as on Xorg with evdev/libinput) and a US
 * layout core keymap (two keysyms per keycode: plain, shifted). Characters
 * the layout can't type get a spare keycode remapped on the fly
 * (`keycodeForChar`), like xdotool does.
 */

export const MIN_KEYCODE = 8, MAX_KEYCODE = 255;
export const KEYSYMS_PER_KEYCODE = 2;

const EVDEV: Record<string, number> = {
  Escape: 1, Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6, Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11,
  Minus: 12, Equal: 13, Backspace: 14, Tab: 15, KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20, KeyY: 21, KeyU: 22,
  KeyI: 23, KeyO: 24, KeyP: 25, BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29, KeyA: 30, KeyS: 31,
  KeyD: 32, KeyF: 33, KeyG: 34, KeyH: 35, KeyJ: 36, KeyK: 37, KeyL: 38, Semicolon: 39, Quote: 40, Backquote: 41,
  ShiftLeft: 42, Backslash: 43, KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48, KeyN: 49, KeyM: 50, Comma: 51,
  Period: 52, Slash: 53, ShiftRight: 54, NumpadMultiply: 55, AltLeft: 56, Space: 57, CapsLock: 58, F1: 59, F2: 60,
  F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68, NumLock: 69, ScrollLock: 70, Numpad7: 71,
  Numpad8: 72, Numpad9: 73, NumpadSubtract: 74, Numpad4: 75, Numpad5: 76, Numpad6: 77, NumpadAdd: 78, Numpad1: 79,
  Numpad2: 80, Numpad3: 81, Numpad0: 82, NumpadDecimal: 83, IntlBackslash: 86, F11: 87, F12: 88, NumpadEnter: 96,
  ControlRight: 97, NumpadDivide: 98, PrintScreen: 99, AltRight: 100, Home: 102, ArrowUp: 103, PageUp: 104,
  ArrowLeft: 105, ArrowRight: 106, End: 107, ArrowDown: 108, PageDown: 109, Insert: 110, Delete: 111, Pause: 119,
  MetaLeft: 125, MetaRight: 126, OSLeft: 125, OSRight: 126, ContextMenu: 127,
};

const c = (s: string) => s.charCodeAt(0);

/** evdev code → [plain, shifted] keysyms */
const SYMS: Record<number, [number, number]> = {
  1: [0xff1b, 0xff1b], 14: [0xff08, 0xff08], 15: [0xff09, 0xfe20], 28: [0xff0d, 0xff0d],
  29: [0xffe3, 0xffe3], 97: [0xffe4, 0xffe4], 42: [0xffe1, 0xffe1], 54: [0xffe2, 0xffe2],
  56: [0xffe9, 0xffe9], 100: [0xffea, 0xffea], 125: [0xffeb, 0xffeb], 126: [0xffec, 0xffec],
  58: [0xffe5, 0xffe5], 69: [0xff7f, 0xff7f], 70: [0xff14, 0xff14], 57: [0x20, 0x20],
  12: [c('-'), c('_')], 13: [c('='), c('+')], 26: [c('['), c('{')], 27: [c(']'), c('}')], 39: [c(';'), c(':')],
  40: [c("'"), c('"')], 41: [c('`'), c('~')], 43: [c('\\'), c('|')], 51: [c(','), c('<')], 52: [c('.'), c('>')],
  53: [c('/'), c('?')], 86: [c('<'), c('>')],
  102: [0xff50, 0xff50], 105: [0xff51, 0xff51], 103: [0xff52, 0xff52], 106: [0xff53, 0xff53], 108: [0xff54, 0xff54],
  104: [0xff55, 0xff55], 109: [0xff56, 0xff56], 107: [0xff57, 0xff57], 110: [0xff63, 0xff63], 111: [0xffff, 0xffff],
  99: [0xff61, 0xff61], 119: [0xff13, 0xff13], 127: [0xff67, 0xff67],
  55: [0xffaa, 0xffaa], 74: [0xffad, 0xffad], 78: [0xffab, 0xffab], 98: [0xffaf, 0xffaf], 96: [0xff8d, 0xff8d],
  83: [0xff9f, 0xffae], 82: [0xff9e, 0xffb0], 79: [0xff9c, 0xffb1], 80: [0xff99, 0xffb2], 81: [0xff9b, 0xffb3],
  75: [0xff96, 0xffb4], 76: [0xff9d, 0xffb5], 77: [0xff98, 0xffb6], 71: [0xff95, 0xffb7], 72: [0xff97, 0xffb8],
  73: [0xff9a, 0xffb9],
};
'1234567890'.split('').forEach((d, i) => { SYMS[2 + i] = [c(d), c('!@#$%^&*()'[i])]; });
'qwertyuiop'.split('').forEach((l, i) => { SYMS[16 + i] = [c(l), c(l.toUpperCase())]; });
'asdfghjkl'.split('').forEach((l, i) => { SYMS[30 + i] = [c(l), c(l.toUpperCase())]; });
'zxcvbnm'.split('').forEach((l, i) => { SYMS[44 + i] = [c(l), c(l.toUpperCase())]; });
for (let i = 0; i < 10; i++) SYMS[59 + i] = [0xffbe + i, 0xffbe + i];
SYMS[87] = [0xffc8, 0xffc8]; SYMS[88] = [0xffc9, 0xffc9];

/** Modifier map: shift, lock, control, mod1..mod5 (two keycodes each). */
export const MODIFIER_MAP: number[][] = [
  [50, 62], [66, 0], [37, 105], [64, 108], [77, 0], [0, 0], [133, 134], [0, 0],
];

/** The current core keymap: keycode → [plain, shifted]. */
export class Keymap {
  syms = new Map<number, [number, number]>();
  private spare = 200;
  private byChar = new Map<number, number>();
  constructor() {
    for (const [ev, s] of Object.entries(SYMS)) this.syms.set(+ev + 8, s);
  }
  keycodeForCode(code: string): number {
    const ev = EVDEV[code];
    return ev === undefined ? 0 : ev + 8;
  }
  keysyms(kc: number): [number, number] { return this.syms.get(kc) ?? [0, 0]; }
  /** A keycode (and whether Shift is needed) that types `ch`; remaps a spare keycode when none does. */
  keycodeForChar(ch: string): { keycode: number; shift: boolean; remapped: boolean } {
    const sym = keysymForChar(ch);
    for (const [kc, [a, b]] of this.syms) {
      if (a === sym) return { keycode: kc, shift: false, remapped: false };
      if (b === sym && kc < 200) return { keycode: kc, shift: true, remapped: false };
    }
    const cp = ch.codePointAt(0)!;
    let kc = this.byChar.get(cp);
    if (kc === undefined) {
      kc = this.spare;
      this.spare = this.spare >= 250 ? 200 : this.spare + 1;
      for (const [k, v] of this.byChar) if (v === kc) this.byChar.delete(k);
      this.byChar.set(cp, kc);
    }
    this.syms.set(kc, [sym, sym]);
    return { keycode: kc, shift: false, remapped: true };
  }
}

/** Keysym for a character: Latin-1 directly, else the Unicode keysym range. */
export function keysymForChar(ch: string): number {
  const cp = ch.codePointAt(0)!;
  if (cp === 0x0d || cp === 0x0a) return 0xff0d;
  if (cp === 0x09) return 0xff09;
  if (cp === 0x08) return 0xff08;
  if (cp === 0x1b) return 0xff1b;
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp;
  return 0x1000000 + cp;
}

/** KeyboardEvent.code values that are modifiers (no character). */
export function isModifierCode(code: string): boolean {
  return /^(Shift|Control|Alt|Meta|OS|CapsLock|NumLock)/.test(code);
}
