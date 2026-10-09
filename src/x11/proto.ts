/**
 * X11 wire protocol: constants and a small byte codec for the in-page X
 * server (src/x11/server.ts). Numbers follow the X Window System Protocol,
 * version 11 (X.Org's "xproto" document).
 */

export const X_PROTOCOL = 11;
export const X_PROTOCOL_REVISION = 0;

// ── Errors ──
export const BadRequest = 1, BadValue = 2, BadWindow = 3, BadPixmap = 4, BadAtom = 5, BadCursor = 6,
  BadFont = 7, BadMatch = 8, BadDrawable = 9, BadAccess = 10, BadAlloc = 11, BadColor = 12,
  BadGC = 13, BadIDChoice = 14, BadName = 15, BadLength = 16, BadImplementation = 17;

// ── Events ──
export const KeyPress = 2, KeyRelease = 3, ButtonPress = 4, ButtonRelease = 5, MotionNotify = 6,
  EnterNotify = 7, LeaveNotify = 8, FocusIn = 9, FocusOut = 10, KeymapNotify = 11, Expose = 12,
  GraphicsExpose = 13, NoExpose = 14, VisibilityNotify = 15, CreateNotify = 16, DestroyNotify = 17,
  UnmapNotify = 18, MapNotify = 19, MapRequest = 20, ReparentNotify = 21, ConfigureNotify = 22,
  ConfigureRequest = 23, GravityNotify = 24, ResizeRequest = 25, CirculateNotify = 26,
  CirculateRequest = 27, PropertyNotify = 28, SelectionClear = 29, SelectionRequest = 30,
  SelectionNotify = 31, ColormapNotify = 32, ClientMessage = 33, MappingNotify = 34, GenericEvent = 35;

// ── Event masks ──
export const KeyPressMask = 1 << 0, KeyReleaseMask = 1 << 1, ButtonPressMask = 1 << 2,
  ButtonReleaseMask = 1 << 3, EnterWindowMask = 1 << 4, LeaveWindowMask = 1 << 5,
  PointerMotionMask = 1 << 6, PointerMotionHintMask = 1 << 7, Button1MotionMask = 1 << 8,
  ButtonMotionMask = 1 << 13, KeymapStateMask = 1 << 14, ExposureMask = 1 << 15,
  VisibilityChangeMask = 1 << 16, StructureNotifyMask = 1 << 17, ResizeRedirectMask = 1 << 18,
  SubstructureNotifyMask = 1 << 19, SubstructureRedirectMask = 1 << 20, FocusChangeMask = 1 << 21,
  PropertyChangeMask = 1 << 22, ColormapChangeMask = 1 << 23, OwnerGrabButtonMask = 1 << 24;

/** Which event masks select each core event (for delivery and propagation). */
export function maskForEvent(code: number, state = 0): number {
  switch (code) {
    case KeyPress: return KeyPressMask;
    case KeyRelease: return KeyReleaseMask;
    case ButtonPress: return ButtonPressMask;
    case ButtonRelease: return ButtonReleaseMask;
    case MotionNotify: {
      let m = PointerMotionMask;
      if (state & 0x1f00) m |= ButtonMotionMask | ((state >> 8) & 0x1f) << 8;
      return m;
    }
    case EnterNotify: return EnterWindowMask;
    case LeaveNotify: return LeaveWindowMask;
    case FocusIn: case FocusOut: return FocusChangeMask;
    case Expose: return ExposureMask;
    case PropertyNotify: return PropertyChangeMask;
    default: return 0;
  }
}

// Key/button state bits
export const ShiftMask = 1, LockMask = 2, ControlMask = 4, Mod1Mask = 8, Mod2Mask = 16, Mod3Mask = 32,
  Mod4Mask = 64, Mod5Mask = 128, Button1Mask = 256;

// Window classes, map states
export const CopyFromParent = 0, InputOutput = 1, InputOnly = 2;
export const IsUnmapped = 0, IsUnviewable = 1, IsViewable = 2;

// GC functions
export const GXclear = 0, GXand = 1, GXandReverse = 2, GXcopy = 3, GXandInverted = 4, GXnoop = 5,
  GXxor = 6, GXor = 7, GXnor = 8, GXequiv = 9, GXinvert = 10, GXorReverse = 11, GXcopyInverted = 12,
  GXorInverted = 13, GXnand = 14, GXset = 15;

export const FillSolid = 0, FillTiled = 1, FillStippled = 2, FillOpaqueStippled = 3;

// ── Predefined atoms (1..68) ──
export const PREDEFINED_ATOMS = [
  'PRIMARY', 'SECONDARY', 'ARC', 'ATOM', 'BITMAP', 'CARDINAL', 'COLORMAP', 'CURSOR',
  'CUT_BUFFER0', 'CUT_BUFFER1', 'CUT_BUFFER2', 'CUT_BUFFER3', 'CUT_BUFFER4', 'CUT_BUFFER5',
  'CUT_BUFFER6', 'CUT_BUFFER7', 'DRAWABLE', 'FONT', 'INTEGER', 'PIXMAP', 'POINT', 'RECTANGLE',
  'RESOURCE_MANAGER', 'RGB_COLOR_MAP', 'RGB_BEST_MAP', 'RGB_BLUE_MAP', 'RGB_DEFAULT_MAP',
  'RGB_GRAY_MAP', 'RGB_GREEN_MAP', 'RGB_RED_MAP', 'STRING', 'VISUALID', 'WINDOW', 'WM_COMMAND',
  'WM_HINTS', 'WM_CLIENT_MACHINE', 'WM_ICON_NAME', 'WM_ICON_SIZE', 'WM_NAME', 'WM_NORMAL_HINTS',
  'WM_SIZE_HINTS', 'WM_ZOOM_HINTS', 'MIN_SPACE', 'NORM_SPACE', 'MAX_SPACE', 'END_SPACE',
  'SUPERSCRIPT_X', 'SUPERSCRIPT_Y', 'SUBSCRIPT_X', 'SUBSCRIPT_Y', 'UNDERLINE_POSITION',
  'UNDERLINE_THICKNESS', 'STRIKEOUT_ASCENT', 'STRIKEOUT_DESCENT', 'ITALIC_ANGLE', 'X_HEIGHT',
  'QUAD_WIDTH', 'WEIGHT', 'POINT_SIZE', 'RESOLUTION', 'COPYRIGHT', 'NOTICE', 'FONT_NAME',
  'FAMILY_NAME', 'FULL_NAME', 'CAP_HEIGHT', 'WM_CLASS', 'WM_TRANSIENT_FOR',
];
export const ATOM_STRING = 31, ATOM_WM_NAME = 39, ATOM_WM_NORMAL_HINTS = 40, ATOM_WM_HINTS = 35,
  ATOM_WM_CLASS = 67, ATOM_WM_TRANSIENT_FOR = 68, ATOM_ATOM = 4, ATOM_CARDINAL = 6, ATOM_WINDOW = 33,
  ATOM_INTEGER = 19, ATOM_PRIMARY = 1, ATOM_WM_ICON_NAME = 37;

export const pad4 = (n: number) => (n + 3) & ~3;

/** Little/big-endian reader over one request. */
export class Reader {
  readonly dv: DataView;
  constructor(readonly buf: Uint8Array, public pos = 0, readonly le = true) {
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  get left() { return this.buf.length - this.pos; }
  u8() { return this.buf[this.pos++]; }
  i8() { return (this.buf[this.pos++] << 24) >> 24; }
  u16() { const v = this.dv.getUint16(this.pos, this.le); this.pos += 2; return v; }
  i16() { const v = this.dv.getInt16(this.pos, this.le); this.pos += 2; return v; }
  u32() { const v = this.dv.getUint32(this.pos, this.le); this.pos += 4; return v; }
  i32() { const v = this.dv.getInt32(this.pos, this.le); this.pos += 4; return v; }
  skip(n: number) { this.pos += n; return this; }
  bytes(n: number) { const b = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return b; }
  str(n: number) { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.buf[this.pos + i]); this.pos += n; return s; }
  /** A string of n bytes followed by padding to 4. */
  pstr(n: number) { const s = this.str(n); this.pos += pad4(n) - n; return s; }
}

/** Growable little/big-endian writer for replies and events. */
export class Writer {
  buf: Uint8Array;
  dv: DataView;
  pos = 0;
  constructor(size = 64, readonly le = true) {
    this.buf = new Uint8Array(size);
    this.dv = new DataView(this.buf.buffer);
  }
  private need(n: number) {
    if (this.pos + n <= this.buf.length) return;
    let s = this.buf.length * 2;
    while (s < this.pos + n) s *= 2;
    const b = new Uint8Array(s);
    b.set(this.buf.subarray(0, this.pos));
    this.buf = b;
    this.dv = new DataView(b.buffer);
  }
  u8(v: number) { this.need(1); this.buf[this.pos++] = v; return this; }
  u16(v: number) { this.need(2); this.dv.setUint16(this.pos, v & 0xffff, this.le); this.pos += 2; return this; }
  i16(v: number) { this.need(2); this.dv.setInt16(this.pos, v, this.le); this.pos += 2; return this; }
  u32(v: number) { this.need(4); this.dv.setUint32(this.pos, v >>> 0, this.le); this.pos += 4; return this; }
  i32(v: number) { this.need(4); this.dv.setInt32(this.pos, v | 0, this.le); this.pos += 4; return this; }
  zero(n: number) { this.need(n); this.buf.fill(0, this.pos, this.pos + n); this.pos += n; return this; }
  bytes(b: Uint8Array) { this.need(b.length); this.buf.set(b, this.pos); this.pos += b.length; return this; }
  str(s: string) { this.need(s.length); for (let i = 0; i < s.length; i++) this.buf[this.pos++] = s.charCodeAt(i) & 0xff; return this; }
  pad() { const p = pad4(this.pos) - this.pos; return this.zero(p); }
  /** Patch a u32 at an earlier offset. */
  setU32(at: number, v: number) { this.dv.setUint32(at, v >>> 0, this.le); }
  setU16(at: number, v: number) { this.dv.setUint16(at, v & 0xffff, this.le); }
  done() { return this.buf.slice(0, this.pos); }
}
