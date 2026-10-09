/**
 * An X11 server that runs in the page (core protocol + BIG-REQUESTS, SHAPE,
 * XC-MISC; RENDER in render.ts). It is rootless: every top-level window is
 * reported to `hooks` (src/x11/rootless.ts turns them into desktop windows)
 * and has its own backing pixels, so nothing needs Expose for uncovering.
 *
 * The server is transport agnostic: `connect(transport)` returns a
 * connection that is fed bytes with `receive()`. src/x11/kernel-display.ts
 * accepts clients on the kernel's AF_UNIX socket /tmp/.X11-unix/X0; tests
 * can use any byte pipe.
 */
import * as P from './proto';
import { Reader, Writer, pad4 } from './proto';
import { Pix, Painter, defaultGC, type GC, type Rect, zImageReader, encodeZImage, encodeXYImage, imageStride, depthMask, intersect } from './raster';
import { openFont, listFonts, textExtents, type XFont, type CharInfo } from './fonts';
import { Keymap, MIN_KEYCODE, MAX_KEYCODE, KEYSYMS_PER_KEYCODE, MODIFIER_MAP } from './keymap';
import { lookupColor } from './colors';

export interface XTransport {
  write(data: Uint8Array): void;
  close(): void;
}

/** What rootless.ts (or a test) learns about top-level windows. */
export interface ServerHooks {
  topMapped?(w: XWindow): void;
  topUnmapped?(w: XWindow): void;
  topDestroyed?(w: XWindow): void;
  topConfigured?(w: XWindow): void;
  topProperty?(w: XWindow, atom: string): void;
  /** pixels of a viewable window changed: rect in that toplevel's coordinates */
  damage?(top: XWindow, x: number, y: number, w: number, h: number): void;
  cursor?(top: XWindow, cursor: XCursor | null): void;
  /** DOM-text mode: a run of core text drawn on a viewable window (not rasterized), in toplevel coordinates */
  text?(top: XWindow, run: TextRun): void;
  /** DOM-text mode: CopyArea within one toplevel, before ('begin') and after ('end') its pixels move */
  copy?(top: XWindow, phase: 'begin' | 'end', sx: number, sy: number, w: number, h: number, dx: number, dy: number): void;
  bell?(): void;
  /** a client took ownership of a selection (CLIPBOARD/PRIMARY) */
  selectionOwned?(selection: string, owner: XWindow | null): void;
}

/** Core text (ImageText/PolyText) as DOM-text mode reports it: x, y is the baseline's left end */
export interface TextRun { x: number; y: number; width: number; ascent: number; descent: number; text: string; font: string; fg: number; bg: number | null }

export interface XCursor { id: number; css: string; image?: { width: number; height: number; rgba: Uint8ClampedArray; xhot: number; yhot: number } }

export interface Property { type: number; format: number; data: Uint8Array }

const ROOT_ID = 0x100, COLORMAP_ID = 0x20, VISUAL_24 = 0x21, VISUAL_32 = 0x22, CMAP_32 = 0x23;
const CLIENT_SHIFT = 21, RESOURCE_MASK = (1 << CLIENT_SHIFT) - 1;
const VENDOR = 'tabcomputer in-page X server';
const RELEASE = 12101011;
export const SERVER_DEFAULTS = { width: 1600, height: 1000 };

export class XWindow {
  children: XWindow[] = [];          // bottom → top
  mapped = false;
  overrideRedirect = false;
  bgPixel: number | null = null;
  bgPixmap: Pix | null = null;
  bgParentRelative = false;
  borderPixel = 0;
  borderPixmap: Pix | null = null;
  bitGravity = 0;
  winGravity = 1;
  backingStore = 0;
  saveUnder = false;
  eventMasks = new Map<Client, number>();
  dontPropagate = 0;
  colormap = COLORMAP_ID;
  cursor: XCursor | null = null;
  props = new Map<number, Property>();
  pix: Pix | null = null;
  shapeBounding: Rect[] | null = null;
  shapeInput: Rect[] | null = null;
  shapeSelect = new Set<Client>();
  destroyed = false;
  /** Extension data (render pictures etc.) */
  ext: Record<string, unknown> = {};
  constructor(
    readonly id: number, public parent: XWindow | null, public x: number, public y: number,
    public width: number, public height: number, public bw: number, readonly cls: number,
    readonly depth: number, readonly visual: number, readonly owner: Client | null,
  ) {}
  get isRoot() { return this.parent === null; }
  viewable(): boolean {
    for (let w: XWindow | null = this; w; w = w.parent) if (!w.mapped && w.parent) return false;
    return true;
  }
  /** Top-level ancestor (child of root), or null for the root. */
  top(): XWindow | null {
    let w: XWindow = this;
    if (!w.parent) return null;
    while (w.parent && w.parent.parent) w = w.parent;
    return w;
  }
  /** Origin of this window's contents in root coordinates. */
  rootOrigin(): [number, number] {
    let x = 0, y = 0;
    for (let w: XWindow | null = this; w && w.parent; w = w.parent) { x += w.x + w.bw; y += w.y + w.bw; }
    return [x, y];
  }
  /** Origin of this window's contents relative to its toplevel's contents. */
  topOrigin(): [number, number] {
    let x = 0, y = 0;
    for (let w: XWindow | null = this; w && w.parent && w.parent.parent; w = w.parent) { x += w.x + w.bw; y += w.y + w.bw; }
    return [x, y];
  }
  isAncestorOf(w: XWindow): boolean {
    for (let p = w.parent; p; p = p.parent) if (p === this) return true;
    return false;
  }
  allEventMasks(): number { let m = 0; for (const v of this.eventMasks.values()) m |= v; return m; }
}

export interface Drawable { pix: Pix; win: XWindow | null; depth: number }

interface Resource { kind: string; owner: Client | null; free(): void; value: unknown }

export interface Extension {
  name: string;
  major: number;
  firstEvent: number;
  firstError: number;
  handle(c: Client, minor: number, r: Reader, len: number): void;
}

export class Client {
  seq = 0;
  le = true;
  setup = false;
  closed = false;
  private inbuf: Uint8Array = new Uint8Array(0);
  private out: Uint8Array[] = [];
  private outLen = 0;
  private flushQueued = false;
  bigRequests = false;
  saveSet = new Set<XWindow>();
  constructor(readonly server: XServer, readonly index: number, readonly transport: XTransport) {}
  get base() { return this.index << CLIENT_SHIFT; }

  receive(data: Uint8Array): void {
    if (this.closed) return;
    if (this.inbuf.length) {
      const b = new Uint8Array(this.inbuf.length + data.length);
      b.set(this.inbuf); b.set(data, this.inbuf.length);
      this.inbuf = b;
    } else {
      this.inbuf = data.slice();
    }
    this.server.process(this);
  }

  /** @internal take complete messages from the input buffer */
  takeInput(): Uint8Array { return this.inbuf; }
  /** @internal */ consumed(n: number) { this.inbuf = this.inbuf.subarray(n); }

  send(b: Uint8Array): void {
    if (this.closed) return;
    this.out.push(b);
    this.outLen += b.length;
    if (this.outLen > 256 * 1024) { this.flush(); return; }
    if (!this.flushQueued) {
      this.flushQueued = true;
      queueMicrotask(() => this.flush());
    }
  }
  flush(): void {
    this.flushQueued = false;
    if (!this.outLen || this.closed) return;
    const all = this.out.length === 1 ? this.out[0] : concat(this.out, this.outLen);
    this.out = []; this.outLen = 0;
    this.transport.write(all);
  }
  writer(size = 32): Writer { return new Writer(size, this.le); }
}

function concat(parts: Uint8Array[], len: number): Uint8Array {
  const b = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { b.set(p, o); o += p.length; }
  return b;
}

export class XError extends Error {
  constructor(readonly code: number, readonly value = 0) { super('X error ' + code); }
}

export class XServer {
  readonly root: XWindow;
  readonly width: number;
  readonly height: number;
  clients = new Map<number, Client>();
  private nextClient = 1;
  private resources = new Map<number, Resource>();
  private atoms: string[] = ['', ...P.PREDEFINED_ATOMS];
  private atomIds = new Map<string, number>();
  readonly extensions = new Map<string, Extension>();
  private extByMajor = new Map<number, Extension>();
  private nextMajor = 128;
  private nextEvent = 64;
  private nextError = 128;
  hooks: ServerHooks = {};
  keymap = new Keymap();
  private selections = new Map<number, { win: XWindow; client: Client; time: number }>();
  // input state
  pointerX = 0; pointerY = 0;
  buttons = 0;           // state mask bits 8..12
  mods = 0;              // shift/lock/control/mod1..5
  private keysDown = new Set<number>();
  private pointerWin: XWindow;
  focus: XWindow | number = 1;      // 0 None, 1 PointerRoot, or a window
  private focusRevert = 1;
  private grab: { win: XWindow; client: Client; mask: number; ownerEvents: boolean; implicit: boolean; cursor: XCursor | null; confine: XWindow | null } | null = null;
  private kbdGrab: { win: XWindow; client: Client; ownerEvents: boolean } | null = null;
  private passiveButtons: { win: XWindow; client: Client; button: number; mods: number; mask: number; ownerEvents: boolean; cursor: XCursor | null; confine: XWindow | null }[] = [];
  private passiveKeys: { win: XWindow; client: Client; key: number; mods: number; ownerEvents: boolean }[] = [];
  private startTime = Date.now();
  screenSaver = { timeout: 0, interval: 0, blanking: 1, exposures: 1 };
  fontPath: string[] = ['built-ins'];
  /** clients waiting while another holds GrabServer (not enforced: single page) */
  log: ((s: string) => void) | null = null;
  /**
   * DOM-text mode (docs/DOM-RENDERING.md): core text drawn on windows is
   * reported through hooks.text instead of rasterized (ImageText still paints
   * its background), and CopyArea within a window through hooks.copy.
   */
  domText = false;
  /** With domText: rasterize the glyphs too (the spans become a transparent overlay for selection and a11y). */
  domTextRaster = false;
  /** Debugging: called for every request (opcode, data byte = minor for extensions). */
  debugErrors = false;
  trace: ((c: Client, opcode: number, data: number, len: number) => void) | null = null;

  /** Dots per inch the screen reports (mm size, Xft.dpi): 96 × the display's device pixel ratio */
  readonly dpi: number;

  constructor(opts: { width?: number; height?: number; dpi?: number; domText?: boolean } = {}) {
    this.width = opts.width ?? SERVER_DEFAULTS.width;
    this.height = opts.height ?? SERVER_DEFAULTS.height;
    this.dpi = opts.dpi ?? 96;
    this.domText = !!opts.domText;
    P.PREDEFINED_ATOMS.forEach((n, i) => this.atomIds.set(n, i + 1));
    this.root = new XWindow(ROOT_ID, null, 0, 0, this.width, this.height, 0, P.InputOutput, 24, VISUAL_24, null);
    this.root.mapped = true;
    this.root.bgPixel = 0x2e3440;
    this.pointerWin = this.root;
    this.resources.set(ROOT_ID, { kind: 'window', owner: null, free() {}, value: this.root });
    this.resources.set(COLORMAP_ID, { kind: 'colormap', owner: null, free() {}, value: { visual: VISUAL_24 } });
    this.resources.set(CMAP_32, { kind: 'colormap', owner: null, free() {}, value: { visual: VISUAL_32 } });
    // What a desktop session's xrdb would load: toolkits take their DPI and font rendering from it
    const rdb = `Xft.dpi:\t${this.dpi}\nXft.antialias:\t1\nXft.hinting:\t1\nXft.hintstyle:\thintslight\nXft.rgba:\tnone\nXcursor.size:\t${Math.round(24 * this.dpi / 96)}\n` +
      // Above 96 dpi xterm's bitmap fonts would be tiny: an outline font sized in points follows Xft.dpi
      // (in DOM-text mode core text is sharp at any scale: xterm keeps its core fonts)
      (this.dpi > 96 && !this.domText ? 'XTerm*faceName:\tDejaVu Sans Mono\nXTerm*faceSize:\t9\n' : '');
    this.root.props.set(23 /* RESOURCE_MANAGER */, { type: P.ATOM_STRING, format: 8, data: new TextEncoder().encode(rdb) });
    this.addExtension('BIG-REQUESTS', 0, 0, (c, minor) => {
      if (minor !== 0) throw new XError(P.BadRequest);
      c.bigRequests = true;
      this.reply(c, 0, c.writer().u32(4 * 1024 * 1024));
    });
    this.addExtension('XC-MISC', 0, 0, (c, minor, r) => this.xcmisc(c, minor, r));
    const shape = this.addExtension('SHAPE', 1, 0, (c, minor, r) => this.shapeRequest(c, minor, r));
    this.shapeEvent = shape.firstEvent;
  }
  private shapeEvent = 0;

  time(): number { return (Date.now() - this.startTime) >>> 0; }

  addExtension(name: string, nEvents: number, nErrors: number, handle: Extension['handle']): Extension {
    const ext: Extension = {
      name, major: this.nextMajor++, firstEvent: nEvents ? this.nextEvent : 0, firstError: nErrors ? this.nextError : 0, handle,
    };
    this.nextEvent += nEvents;
    this.nextError += nErrors;
    this.extensions.set(name, ext);
    this.extByMajor.set(ext.major, ext);
    return ext;
  }

  // ── atoms ──
  atom(name: string): number {
    let id = this.atomIds.get(name);
    if (id === undefined) { id = this.atoms.length; this.atoms.push(name); this.atomIds.set(name, id); }
    return id;
  }
  atomName(id: number): string | undefined { return id > 0 && id < this.atoms.length ? this.atoms[id] : undefined; }
  existingAtom(name: string): number { return this.atomIds.get(name) ?? 0; }

  // ── connections ──
  connect(transport: XTransport): Client {
    const index = this.nextClient++;
    const c = new Client(this, index, transport);
    this.clients.set(index, c);
    return c;
  }

  disconnect(c: Client): void {
    if (c.closed) return;
    c.closed = true;
    this.clients.delete(c.index);
    if (this.grab?.client === c) this.grab = null;
    if (this.kbdGrab?.client === c) this.kbdGrab = null;
    this.passiveButtons = this.passiveButtons.filter((g) => g.client !== c);
    this.passiveKeys = this.passiveKeys.filter((g) => g.client !== c);
    for (const [sel, o] of [...this.selections]) if (o.client === c) { this.selections.delete(sel); this.hooks.selectionOwned?.(this.atomName(sel)!, null); }
    // save-set: reparenting WMs only; we just unmap nothing
    for (const [id, r] of [...this.resources]) {
      if (r.owner !== c) continue;
      if (r.kind === 'window') {
        const w = r.value as XWindow;
        if (!w.destroyed && (!w.parent || this.resources.get(w.parent.id)?.owner !== c)) this.destroyWindow(w);
      }
    }
    for (const [id, r] of [...this.resources]) if (r.owner === c) { r.free(); this.resources.delete(id); }
    for (const w of this.allWindows()) w.eventMasks.delete(c), w.shapeSelect.delete(c);
    try { c.transport.close(); } catch { /* gone */ }
  }

  private *allWindows(w: XWindow = this.root): Generator<XWindow> {
    yield w;
    for (const ch of w.children) yield* this.allWindows(ch);
  }

  /** Parse and run every complete request in the client's buffer. */
  process(c: Client): void {
    for (;;) {
      if (c.closed) return;
      const buf = c.takeInput();
      if (!c.setup) {
        if (buf.length < 12) return;
        const le = buf[0] === 0x6c;
        c.le = le;
        const r = new Reader(buf, 0, le);
        r.skip(6);
        const nlen = r.u16(), dlen = r.u16();
        const total = 12 + pad4(nlen) + pad4(dlen);
        if (buf.length < total) return;
        c.consumed(total);
        c.setup = true;
        c.send(this.setupReply(c));
        continue;
      }
      if (buf.length < 4) return;
      const r0 = new Reader(buf, 0, c.le);
      const opcode = r0.u8(), data = r0.u8();
      let len = r0.u16() * 4;
      let hdr = 4;
      if (len === 0) {
        if (!c.bigRequests) { this.disconnect(c); return; }
        if (buf.length < 8) return;
        len = r0.u32() * 4;
        hdr = 8;
        if (len < 8) { this.disconnect(c); return; }
      }
      if (buf.length < len) return;
      const req = buf.subarray(0, len);
      c.consumed(len);
      c.seq = (c.seq + 1) & 0xffff;
      const r = new Reader(req, hdr, c.le);
      this.trace?.(c, opcode, data, len);
      try {
        this.dispatch(c, opcode, data, r, len);
      } catch (e) {
        if (e instanceof XError) {
          this.trace?.(c, -1, e.code, opcode * 256 + (opcode >= 128 ? data : 0));
          if (this.debugErrors) this.log?.(`error ${e.code} value 0x${e.value.toString(16)} on ${opcode}.${data} req ${Array.from(req.subarray(0, Math.min(32, req.length))).join(',')}`);
          this.error(c, e.code, e.value, opcode, opcode >= 128 ? data : 0);
        }
        else {
          this.log?.(`X request ${opcode} failed: ${(e as Error)?.stack ?? e}`);
          this.error(c, P.BadImplementation, 0, opcode, 0);
        }
      }
    }
  }

  private setupReply(c: Client): Uint8Array {
    const w = c.writer(256);
    const vendor = VENDOR;
    const formats = [[1, 1, 32], [8, 8, 32], [16, 16, 32], [24, 32, 32], [32, 32, 32]];
    w.u8(1).u8(0).u16(P.X_PROTOCOL).u16(P.X_PROTOCOL_REVISION).u16(0); // length patched
    w.u32(RELEASE).u32(c.base).u32(RESOURCE_MASK).u32(256);
    w.u16(vendor.length).u16(65535).u8(1).u8(formats.length);
    w.u8(0).u8(0).u8(32).u8(32).u8(MIN_KEYCODE).u8(MAX_KEYCODE).zero(4);
    w.str(vendor).pad();
    for (const [d, bpp, pad] of formats) w.u8(d).u8(bpp).u8(pad).zero(5);
    // screen
    w.u32(ROOT_ID).u32(COLORMAP_ID).u32(0xffffff).u32(0).u32(this.root.allEventMasks());
    w.u16(this.width).u16(this.height).u16(Math.round(this.width * 25.4 / this.dpi)).u16(Math.round(this.height * 25.4 / this.dpi));
    w.u16(1).u16(1).u32(VISUAL_24).u8(0).u8(0).u8(24);
    const depths: [number, number[]][] = [[24, [VISUAL_24]], [1, []], [8, []], [16, []], [32, [VISUAL_32]]];
    w.u8(depths.length);
    for (const [d, vis] of depths) {
      w.u8(d).u8(0).u16(vis.length).zero(4);
      for (const v of vis) w.u32(v).u8(4).u8(8).u16(256).u32(0xff0000).u32(0xff00).u32(0xff).zero(4);
    }
    const out = w.done();
    new DataView(out.buffer).setUint16(6, (out.length - 8) / 4, c.le);
    return out;
  }

  // ── replies, errors, events ──
  reply(c: Client, data: number, body: Writer, extra?: Uint8Array): void {
    // body = everything after the 8-byte header; at least 24 bytes
    const bodyLen = Math.max(24, body.pos) + (extra ? extra.length : 0);
    const total = 8 + pad4(bodyLen);
    const out = new Uint8Array(Math.max(32, total));
    const dv = new DataView(out.buffer);
    out[0] = 1; out[1] = data;
    dv.setUint16(2, c.seq, c.le);
    dv.setUint32(4, (out.length - 32) / 4, c.le);
    out.set(body.buf.subarray(0, body.pos), 8);
    if (extra) out.set(extra, 8 + Math.max(24, body.pos));
    c.send(out);
  }

  error(c: Client, code: number, value: number, major: number, minor: number): void {
    const out = new Uint8Array(32);
    const dv = new DataView(out.buffer);
    out[0] = 0; out[1] = code;
    dv.setUint16(2, c.seq, c.le);
    dv.setUint32(4, value >>> 0, c.le);
    dv.setUint16(8, minor, c.le);
    out[10] = major;
    c.send(out);
  }

  /** Send a 32-byte event built by `fill` (bytes 0..31; the sequence number is filled in). */
  event(c: Client, fill: (w: Writer) => void, sent = false): void {
    const w = c.writer(32);
    fill(w);
    const out = new Uint8Array(32);
    out.set(w.buf.subarray(0, Math.min(32, w.pos)));
    if (out[0] !== P.KeymapNotify) new DataView(out.buffer).setUint16(2, c.seq, c.le);
    if (sent) out[0] |= 0x80;
    c.send(out);
  }

  /** Deliver to every client that selected `mask` on `win`. */
  deliver(win: XWindow, mask: number, fill: (w: Writer, c: Client) => void): number {
    let n = 0;
    for (const [c, m] of win.eventMasks) if (m & mask) { this.event(c, (w) => fill(w, c)); n++; }
    return n;
  }

  // ── resources ──
  private newId(c: Client, id: number): void {
    if ((id & ~RESOURCE_MASK) !== c.base || this.resources.has(id)) throw new XError(P.BadIDChoice, id);
  }
  private addResource(c: Client, id: number, kind: string, value: unknown, free: () => void = () => {}): void {
    this.newId(c, id);
    this.resources.set(id, { kind, owner: c, value, free });
  }
  /** Register a resource for an extension (render pictures, glyph sets). */
  addExtResource(c: Client, id: number, kind: string, value: unknown, free: () => void = () => {}): void { this.addResource(c, id, kind, value, free); }
  lookup<T>(id: number, kind: string, err: number): T {
    const r = this.resources.get(id);
    if (!r || r.kind !== kind) throw new XError(err, id);
    return r.value as T;
  }
  freeResource(id: number, kind: string, err: number): void {
    const r = this.resources.get(id);
    if (!r || r.kind !== kind) throw new XError(err, id);
    this.resources.delete(id);
    r.free();
  }
  hasResource(id: number, kind?: string): boolean { const r = this.resources.get(id); return !!r && (!kind || r.kind === kind); }
  win(id: number): XWindow { return this.lookup<XWindow>(id, 'window', P.BadWindow); }
  winOrNull(id: number): XWindow | null { const r = this.resources.get(id); return r?.kind === 'window' ? r.value as XWindow : null; }
  pixmap(id: number): Pix { return this.lookup<Pix>(id, 'pixmap', P.BadPixmap); }
  gc(id: number): GC { return this.lookup<GC>(id, 'gc', P.BadGC); }
  font(id: number): XFont {
    const r = this.resources.get(id);
    if (r?.kind === 'font') return r.value as XFont;
    if (r?.kind === 'gc') { const f = (r.value as GC).font; if (f) return f; }
    throw new XError(P.BadFont, id);
  }
  drawable(id: number): Drawable {
    const r = this.resources.get(id);
    if (r?.kind === 'pixmap') { const p = r.value as Pix; return { pix: p, win: null, depth: p.depth }; }
    if (r?.kind === 'window') {
      const w = r.value as XWindow;
      if (w.cls === P.InputOnly) throw new XError(P.BadMatch, id);
      return { pix: this.windowPix(w), win: w, depth: w.depth };
    }
    throw new XError(P.BadDrawable, id);
  }
  cursorById(id: number): XCursor | null {
    if (id === 0) return null;
    return this.lookup<XCursor>(id, 'cursor', P.BadCursor);
  }

  /** The window's backing pixels (created on demand; the root's too). */
  windowPix(w: XWindow): Pix {
    if (!w.pix) {
      w.pix = new Pix(Math.max(1, w.width), Math.max(1, w.height), w.depth);
      this.paintBackground(w, 0, 0, w.width, w.height);
      w.pix.onDamage = (x, y, ww, hh) => this.windowDamaged(w, x, y, ww, hh);
    }
    return w.pix;
  }

  private windowDamaged(w: XWindow, x: number, y: number, ww: number, hh: number): void {
    const top = w.top();
    if (!top || !w.viewable()) return;
    const [ox, oy] = w.topOrigin();
    this.hooks.damage?.(top, ox + x, oy + y, ww, hh);
  }

  /** Damage a whole window subtree (structure changed). */
  damageTop(w: XWindow): void {
    const top = w.top();
    if (top && top.mapped) this.hooks.damage?.(top, 0, 0, top.width, top.height);
  }

  paintBackground(w: XWindow, x: number, y: number, ww: number, hh: number): void {
    if (w.cls === P.InputOnly || !w.pix) return;
    let bgWin: XWindow | null = w, ox = 0, oy = 0;
    while (bgWin && bgWin.bgParentRelative && bgWin.parent) { ox += bgWin.x + bgWin.bw; oy += bgWin.y + bgWin.bw; bgWin = bgWin.parent; }
    if (!bgWin) return;
    const gc = defaultGC();
    if (bgWin.bgPixmap) { gc.fillStyle = P.FillTiled; gc.tile = bgWin.bgPixmap; gc.tsx = -ox; gc.tsy = -oy; }
    else if (bgWin.bgPixel !== null) gc.fg = bgWin.bgPixel;
    else return;
    const p = new Painter(w.pix, gc);
    p.fillRect(x, y, ww, hh);
    p.finish();
  }

  // ── dispatch ──
  private dispatch(c: Client, op: number, data: number, r: Reader, len: number): void {
    switch (op) {
      case 1: return this.createWindow(c, data, r);
      case 2: { const w = this.win(r.u32()); this.setWindowAttrs(c, w, r.u32(), r); return; }
      case 3: return this.getWindowAttributes(c, this.win(r.u32()));
      case 4: { const w = this.win(r.u32()); if (w !== this.root) this.destroyWindow(w); return; }
      case 5: { const w = this.win(r.u32()); for (const ch of [...w.children].reverse()) this.destroyWindow(ch); return; }
      case 6: { const w = this.win(r.u32()); if (data === 0) c.saveSet.add(w); else c.saveSet.delete(w); return; }
      case 7: return this.reparentWindow(c, this.win(r.u32()), this.win(r.u32()), r.i16(), r.i16());
      case 8: return this.mapWindow(c, this.win(r.u32()));
      case 9: { const w = this.win(r.u32()); for (const ch of [...w.children]) this.mapWindow(c, ch); return; }
      case 10: return this.unmapWindow(this.win(r.u32()));
      case 11: { const w = this.win(r.u32()); for (const ch of [...w.children].reverse()) this.unmapWindow(ch); return; }
      case 12: return this.configureRequest(c, this.win(r.u32()), r);
      case 13: { const w = this.win(r.u32()); this.circulate(w, data); return; }
      case 14: return this.getGeometry(c, r.u32());
      case 15: return this.queryTree(c, this.win(r.u32()));
      case 16: {
        const n = r.u16(); r.skip(2);
        const name = r.str(n);
        const id = data ? this.existingAtom(name) : this.atom(name);
        this.reply(c, 0, c.writer().u32(id));
        return;
      }
      case 17: {
        const id = r.u32();
        const name = this.atomName(id);
        if (name === undefined) throw new XError(P.BadAtom, id);
        const w = c.writer(32 + name.length).u16(name.length).zero(22).str(name);
        this.reply(c, 0, w);
        return;
      }
      case 18: return this.changeProperty(c, data, r);
      case 19: { const w = this.win(r.u32()); this.deleteProperty(w, r.u32()); return; }
      case 20: return this.getProperty(c, data, r);
      case 21: {
        const w = this.win(r.u32());
        const out = c.writer(32 + 4 * w.props.size).u16(w.props.size).zero(22);
        for (const a of w.props.keys()) out.u32(a);
        this.reply(c, 0, out);
        return;
      }
      case 22: return this.setSelectionOwner(c, r.u32(), r.u32(), r.u32());
      case 23: {
        const sel = r.u32();
        if (!this.atomName(sel)) throw new XError(P.BadAtom, sel);
        this.reply(c, 0, c.writer().u32(this.selections.get(sel)?.win.id ?? 0));
        return;
      }
      case 24: return this.convertSelection(c, r);
      case 25: return this.sendEvent(c, data, r);
      case 26: return this.grabPointer(c, data, r);
      case 27: if (this.grab && this.grab.client === c) this.endGrab(); return;
      case 28: { // GrabButton
        const ownerEvents = !!data;
        const win = this.win(r.u32()); const mask = r.u16(); r.skip(2);
        const confine = this.winOrNull(r.u32()); const cursor = this.cursorById(r.u32());
        const button = r.u8(); r.skip(1); const mods = r.u16();
        this.passiveButtons = this.passiveButtons.filter((g) => !(g.win === win && g.button === button && g.mods === mods));
        this.passiveButtons.push({ win, client: c, button, mods, mask, ownerEvents, cursor, confine });
        return;
      }
      case 29: { const button = data; const win = this.win(r.u32()); const mods = r.u16(); this.passiveButtons = this.passiveButtons.filter((g) => !(g.win === win && (button === 0 || g.button === button) && (mods === 0x8000 || g.mods === mods))); return; }
      case 30: { r.skip(4 + 4); const mask = r.u16(); if (this.grab && this.grab.client === c) this.grab.mask = mask; return; }
      case 31: { // GrabKeyboard
        const win = this.win(r.u32());
        if (this.kbdGrab && this.kbdGrab.client !== c) { this.reply(c, 1, c.writer()); return; }
        if (!win.viewable()) { this.reply(c, 3, c.writer()); return; }
        const old = this.focusWindow();
        this.kbdGrab = { win, client: c, ownerEvents: !!data };
        this.focusChange(old, win, 1);
        this.reply(c, 0, c.writer());
        return;
      }
      case 32: if (this.kbdGrab?.client === c) { const g = this.kbdGrab; this.kbdGrab = null; this.focusChange(g.win, this.focusWindow(), 2); } return;
      case 33: { // GrabKey
        const win = this.win(r.u32()); const mods = r.u16(); const key = r.u8();
        this.passiveKeys.push({ win, client: c, key, mods, ownerEvents: !!data });
        return;
      }
      case 34: { const key = data; const win = this.win(r.u32()); const mods = r.u16(); this.passiveKeys = this.passiveKeys.filter((g) => !(g.win === win && (key === 0 || g.key === key) && (mods === 0x8000 || g.mods === mods))); return; }
      case 35: return; // AllowEvents: we never freeze
      case 36: case 37: return; // Grab/UngrabServer
      case 38: return this.queryPointer(c, this.win(r.u32()));
      case 39: this.reply(c, 0, c.writer().u32(0)); return;
      case 40: return this.translateCoordinates(c, this.win(r.u32()), this.win(r.u32()), r.i16(), r.i16());
      case 41: { // WarpPointer
        r.skip(4); const dst = this.winOrNull(r.u32()); r.skip(12);
        const dx = r.i16(), dy = r.i16();
        if (dst) { const [ox, oy] = dst.rootOrigin(); this.movePointer(ox + dx, oy + dy); }
        else this.movePointer(this.pointerX + dx, this.pointerY + dy);
        return;
      }
      case 42: { // SetInputFocus
        const f = r.u32();
        const target: XWindow | number = f === 0 || f === 1 ? f : this.win(f);
        if (typeof target !== 'number' && !target.viewable()) throw new XError(P.BadMatch, f);
        this.setFocus(target, data);
        return;
      }
      case 43: this.reply(c, this.focusRevert, c.writer().u32(typeof this.focus === 'number' ? this.focus : this.focus.id)); return;
      case 44: {
        const w = c.writer(40);
        const bits = new Uint8Array(32);
        for (const k of this.keysDown) bits[k >> 3] |= 1 << (k & 7);
        w.bytes(bits);
        this.reply(c, 0, w);
        return;
      }
      case 45: { // OpenFont
        const fid = r.u32(); const n = r.u16(); r.skip(2);
        const name = r.str(n);
        const f = openFont(name);
        if (!f) throw new XError(P.BadName, 0);
        this.addResource(c, fid, 'font', f);
        return;
      }
      case 46: this.freeResource(r.u32(), 'font', P.BadFont); return;
      case 47: return this.queryFont(c, this.font(r.u32()));
      case 48: { // QueryTextExtents
        const f = this.font(r.u32());
        const nchars = (len - 8) / 2 - (data ? 1 : 0);
        const codes: number[] = [];
        for (let i = 0; i < nchars; i++) codes.push((r.u8() << 8) | r.u8());
        const e = textExtents(f, codes);
        this.reply(c, 0, c.writer().i16(f.ascent).i16(f.descent).i16(e.ascent).i16(e.descent).i32(e.width).i32(e.left).i32(e.right));
        return;
      }
      case 49: { // ListFonts
        const max = r.u16(); const n = r.u16();
        const names = listFonts(r.str(n), max);
        const w = c.writer(32).u16(names.length).zero(22);
        for (const nm of names) w.u8(nm.length).str(nm);
        this.reply(c, 0, w);
        return;
      }
      case 50: return this.listFontsWithInfo(c, r);
      case 51: { const n = r.u16(); r.skip(2); const paths: string[] = []; for (let i = 0; i < n; i++) paths.push(r.str(r.u8())); this.fontPath = paths.length ? paths : ['built-ins']; return; }
      case 52: { const w = c.writer().u16(this.fontPath.length).zero(22); for (const p of this.fontPath) w.u8(p.length).str(p); this.reply(c, 0, w); return; }
      case 53: { // CreatePixmap
        const pid = r.u32(); this.drawableOrWindow(r.u32()); const w = r.u16(), h = r.u16();
        if (!w || !h) throw new XError(P.BadValue, 0);
        if (![1, 8, 16, 24, 32].includes(data)) throw new XError(P.BadValue, data);
        this.addResource(c, pid, 'pixmap', new Pix(w, h, data));
        return;
      }
      case 54: this.freeResource(r.u32(), 'pixmap', P.BadPixmap); return;
      case 55: { const cid = r.u32(); this.drawableOrWindow(r.u32()); const gc = defaultGC(); this.changeGC(gc, r.u32(), r); this.addResource(c, cid, 'gc', gc); return; }
      case 56: { const gc = this.gc(r.u32()); this.changeGC(gc, r.u32(), r); return; }
      case 57: { const src = this.gc(r.u32()), dst = this.gc(r.u32()); copyGC(src, dst, r.u32()); return; }
      case 58: { const gc = this.gc(r.u32()); gc.dashOffset = r.u16(); const n = r.u16(); gc.dashes = Array.from(r.bytes(n)); return; }
      case 59: { // SetClipRectangles
        const gc = this.gc(r.u32()); gc.clipX = r.i16(); gc.clipY = r.i16();
        const rects: Rect[] = [];
        while (r.left >= 8) rects.push({ x: r.i16(), y: r.i16(), w: r.u16(), h: r.u16() });
        gc.clipRects = rects; gc.clipMask = null;
        return;
      }
      case 60: this.freeResource(r.u32(), 'gc', P.BadGC); return;
      case 61: return this.clearArea(c, data, this.win(r.u32()), r.i16(), r.i16(), r.u16(), r.u16());
      case 62: return this.copyArea(c, r);
      case 63: return this.copyPlane(c, r);
      case 64: case 65: return this.polyPointLine(op, data, r);
      case 66: { const { p, done } = this.painter(r); while (r.left >= 8) { const a = r.i16(), b = r.i16(), cc = r.i16(), d = r.i16(); p.polyline([a, b, cc, d]); } done(); return; }
      case 67: {
        const { p, done } = this.painter(r);
        while (r.left >= 8) {
          const x = r.i16(), y = r.i16(), w = r.u16(), h = r.u16();
          if (p.gc.lineWidth <= 1) p.polyline([x, y, x + w, y, x + w, y + h, x, y + h, x, y], true);
          else p.polyline([x, y, x + w, y, x + w, y + h, x, y + h, x, y], true);
        }
        done(); return;
      }
      case 68: case 71: {
        const { p, done } = this.painter(r);
        while (r.left >= 12) p.arc(r.i16(), r.i16(), r.u16(), r.u16(), r.i16(), r.i16(), op === 71);
        done(); return;
      }
      case 69: { // FillPoly
        const { p, done } = this.painter(r);
        r.skip(1); const mode = r.u8(); r.skip(2);
        const pts: number[] = [];
        while (r.left >= 4) {
          let x = r.i16(), y = r.i16();
          if (mode === 1 && pts.length) { x += pts[pts.length - 2]; y += pts[pts.length - 1]; }
          pts.push(x, y);
        }
        p.fillPolygon(pts);
        done(); return;
      }
      case 70: {
        const { p, done } = this.painter(r);
        while (r.left >= 8) p.fillRect(r.i16(), r.i16(), r.u16(), r.u16());
        done(); return;
      }
      case 72: return this.putImage(c, data, r);
      case 73: return this.getImage(c, data, r);
      case 74: case 75: return this.polyText(op === 75, r);
      case 76: case 77: {
        const { p, d, done } = this.painter(r);
        const x = r.i16(), y = r.i16();
        const codes: number[] = [];
        for (let i = 0; i < data; i++) codes.push(op === 77 ? (r.u8() << 8) | r.u8() : r.u8());
        const dom = this.domText && !!d.win;
        const end = p.gc.font ? p.text(p.gc.font, codes, x, y, true, !dom || this.domTextRaster) : x;
        done();
        if (dom && p.gc.font) this.textRun(d.win!, p.gc, p.gc.font, codes, x, y, end - x, true);
        return;
      }
      case 78: { const mid = r.u32(); const w = this.win(r.u32()); const vis = r.u32(); this.addResource(c, mid, 'colormap', { visual: vis || w.visual }); return; }
      case 79: { const id = r.u32(); if (id !== COLORMAP_ID && id !== CMAP_32) this.freeResource(id, 'colormap', P.BadColor); return; }
      case 80: { const mid = r.u32(); const src = this.lookup<{ visual: number }>(r.u32(), 'colormap', P.BadColor); this.addResource(c, mid, 'colormap', { visual: src.visual }); return; }
      case 81: case 82: r.u32(); return;
      case 83: this.reply(c, 0, c.writer().u16(1).zero(22).u32(COLORMAP_ID)); return;
      case 84: { // AllocColor
        const cm = this.colormapVisual(r.u32());
        const red = r.u16(), green = r.u16(), blue = r.u16();
        const pix = rgbPixel(red, green, blue, cm);
        this.reply(c, 0, c.writer().u16(expand8(red >> 8)).u16(expand8(green >> 8)).u16(expand8(blue >> 8)).zero(2).u32(pix));
        return;
      }
      case 85: { // AllocNamedColor
        const cm = this.colormapVisual(r.u32()); const n = r.u16(); r.skip(2);
        const rgb = lookupColor(r.str(n));
        if (rgb === null) throw new XError(P.BadName, 0);
        const [R, G, B] = [(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff];
        this.reply(c, 0, c.writer().u32(rgbPixel(R << 8, G << 8, B << 8, cm)).u16(expand8(R)).u16(expand8(G)).u16(expand8(B)).u16(expand8(R)).u16(expand8(G)).u16(expand8(B)));
        return;
      }
      case 86: case 87: throw new XError(P.BadAlloc, 0);
      case 88: case 89: case 90: return; // FreeColors, StoreColors, StoreNamedColor: TrueColor
      case 91: { // QueryColors
        const cm = this.colormapVisual(r.u32());
        const pixels: number[] = [];
        while (r.left >= 4) pixels.push(r.u32());
        const w = c.writer(32 + pixels.length * 8).u16(pixels.length).zero(22);
        for (const px of pixels) w.u16(expand8((px >> 16) & 0xff)).u16(expand8((px >> 8) & 0xff)).u16(expand8(px & 0xff)).zero(2);
        void cm;
        this.reply(c, 0, w);
        return;
      }
      case 92: { // LookupColor
        r.u32(); const n = r.u16(); r.skip(2);
        const rgb = lookupColor(r.str(n));
        if (rgb === null) throw new XError(P.BadName, 0);
        const [R, G, B] = [(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff].map(expand8);
        this.reply(c, 0, c.writer().u16(R).u16(G).u16(B).u16(R).u16(G).u16(B));
        return;
      }
      case 93: return this.createCursor(c, r);
      case 94: return this.createGlyphCursor(c, r);
      case 95: this.freeResource(r.u32(), 'cursor', P.BadCursor); return;
      case 96: return; // RecolorCursor
      case 97: { r.u32(); const w = r.u16(), h = r.u16(); this.reply(c, 0, c.writer().u16(data === 0 ? Math.max(w, 32) : w).u16(data === 0 ? Math.max(h, 32) : h)); return; }
      case 98: { // QueryExtension
        const n = r.u16(); r.skip(2);
        const ext = this.extensions.get(r.str(n));
        this.reply(c, 0, c.writer().u8(ext ? 1 : 0).u8(ext?.major ?? 0).u8(ext?.firstEvent ?? 0).u8(ext?.firstError ?? 0));
        return;
      }
      case 99: {
        const w = c.writer().zero(24);
        for (const name of this.extensions.keys()) w.u8(name.length).str(name);
        this.reply(c, this.extensions.size, w);
        return;
      }
      case 100: { // ChangeKeyboardMapping
        const first = r.u8(), per = r.u8(); r.skip(2);
        for (let i = 0; i < data; i++) {
          const syms: number[] = [];
          for (let j = 0; j < per; j++) syms.push(r.u32());
          this.keymap.syms.set(first + i, [syms[0] ?? 0, syms[1] ?? syms[0] ?? 0]);
        }
        this.mappingNotify(1, first, data);
        return;
      }
      case 101: { // GetKeyboardMapping
        const first = r.u8(), count = r.u8();
        const w = c.writer(32 + count * 8).zero(24);
        for (let k = first; k < first + count; k++) { const [a, b] = this.keymap.keysyms(k); w.u32(a).u32(b === a && a < 0x100 && !(a >= 0x61 && a <= 0x7a) ? 0 : b); }
        this.reply(c, KEYSYMS_PER_KEYCODE, w);
        return;
      }
      case 102: return; // ChangeKeyboardControl
      case 103: {
        const w = c.writer(52).u32(0).u8(0).u8(50).u16(400).u16(100).zero(2);
        w.bytes(new Uint8Array(32).fill(0xff));
        this.reply(c, 1, w);
        return;
      }
      case 104: this.hooks.bell?.(); return;
      case 105: return;
      case 106: this.reply(c, 0, c.writer().u16(2).u16(1).u16(4)); return;
      case 107: { this.screenSaver.timeout = r.i16(); this.screenSaver.interval = r.i16(); return; }
      case 108: this.reply(c, 0, c.writer().u16(this.screenSaver.timeout).u16(this.screenSaver.interval).u8(this.screenSaver.blanking).u8(this.screenSaver.exposures)); return;
      case 109: return;
      case 110: this.reply(c, 0, c.writer().u16(0).zero(22)); return;
      case 111: case 112: return;
      case 113: { // KillClient
        const id = r.u32();
        if (id === 0) return;
        const owner = this.resources.get(id)?.owner;
        if (owner) this.disconnect(owner);
        return;
      }
      case 114: { // RotateProperties
        const w = this.win(r.u32()); const n = r.u16(); const delta = r.i16();
        const atoms: number[] = []; for (let i = 0; i < n; i++) atoms.push(r.u32());
        const vals = atoms.map((a) => w.props.get(a));
        if (vals.some((v) => !v)) throw new XError(P.BadMatch, 0);
        atoms.forEach((a, i) => { w.props.set(atoms[(i + delta % n + n) % n], vals[i]!); });
        for (const a of atoms) this.propertyNotify(w, a, 0);
        return;
      }
      case 115: return;
      case 116: this.reply(c, 0, c.writer()); return;
      case 117: { const w = c.writer().zero(24).bytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])); this.reply(c, 10, w); return; }
      case 118: this.reply(c, 0, c.writer()); return;
      case 119: {
        const w = c.writer(48).zero(24);
        for (const m of MODIFIER_MAP) w.u8(m[0]).u8(m[1]);
        this.reply(c, 2, w);
        return;
      }
      case 127: return;
    }
    const ext = this.extByMajor.get(op);
    if (!ext) throw new XError(P.BadRequest);
    ext.handle(c, data, r, len);
  }

  private drawableOrWindow(id: number): void {
    const r = this.resources.get(id);
    if (!r || (r.kind !== 'window' && r.kind !== 'pixmap')) throw new XError(P.BadDrawable, id);
  }

  private colormapVisual(id: number): number {
    return this.lookup<{ visual: number }>(id, 'colormap', P.BadColor).visual;
  }

  // ── windows ──
  private createWindow(c: Client, depth: number, r: Reader): void {
    const wid = r.u32(); const parent = this.win(r.u32());
    const x = r.i16(), y = r.i16(), w = r.u16(), h = r.u16(), bw = r.u16();
    let cls = r.u16(); let visual = r.u32(); const mask = r.u32();
    if (cls === P.CopyFromParent) cls = parent.cls;
    if (!w || !h) throw new XError(P.BadValue, 0);
    if (cls === P.InputOnly) {
      if (bw || depth) throw new XError(P.BadMatch, 0);
      depth = 0;
      if (!visual) visual = parent.visual;
    } else {
      if (parent.cls === P.InputOnly) throw new XError(P.BadMatch, 0);
      if (!visual) visual = parent.visual;
      if (!depth) depth = visual === VISUAL_32 ? 32 : parent.depth;
      if (visual !== VISUAL_24 && visual !== VISUAL_32) throw new XError(P.BadMatch, visual);
      if ((visual === VISUAL_32) !== (depth === 32)) throw new XError(P.BadMatch, 0);
    }
    this.newId(c, wid);
    const win = new XWindow(wid, parent, x, y, w, h, bw, cls, depth, visual, c);
    if (cls === P.InputOutput) win.bgPixel = null; // None by default
    win.colormap = parent.colormap;
    if (depth === 32 && visual === VISUAL_32) win.colormap = CMAP_32;
    win.borderPixel = 0;
    this.resources.set(wid, { kind: 'window', owner: c, value: win, free: () => {} });
    parent.children.push(win);
    this.setWindowAttrs(c, win, mask, r, true);
    this.deliver(parent, P.SubstructureNotifyMask, (e) => e.u8(P.CreateNotify).u8(0).u16(0).u32(parent.id).u32(win.id).i16(x).i16(y).u16(w).u16(h).u16(bw).u8(win.overrideRedirect ? 1 : 0));
  }

  private setWindowAttrs(c: Client, w: XWindow, mask: number, r: Reader, creating = false): void {
    let repaint = false;
    for (let bit = 0; bit < 15; bit++) {
      if (!(mask & (1 << bit))) continue;
      const v = r.u32();
      switch (bit) {
        case 0:
          w.bgParentRelative = v === 1;
          w.bgPixmap = v > 1 ? this.pixmap(v) : null;
          if (v === 0) w.bgPixel = null;
          repaint = true; break;
        case 1: w.bgPixel = v; w.bgPixmap = null; w.bgParentRelative = false; repaint = true; break;
        case 2: w.borderPixmap = v ? this.pixmap(v) : null; break;
        case 3: w.borderPixel = v; w.borderPixmap = null; this.damageTop(w); break;
        case 4: w.bitGravity = v; break;
        case 5: w.winGravity = v; break;
        case 6: w.backingStore = v; break;
        case 7: case 8: break;
        case 9: w.overrideRedirect = !!v; break;
        case 10: w.saveUnder = !!v; break;
        case 11: {
          if (v & (P.SubstructureRedirectMask | P.ButtonPressMask | P.ResizeRedirectMask)) {
            for (const [other, m] of w.eventMasks) {
              if (other === c) continue;
              const exclusive = P.SubstructureRedirectMask | P.ButtonPressMask | P.ResizeRedirectMask;
              if (m & v & exclusive) throw new XError(P.BadAccess, w.id);
            }
          }
          if (v) w.eventMasks.set(c, v); else w.eventMasks.delete(c);
          break;
        }
        case 12: w.dontPropagate = v; break;
        case 13: w.colormap = v || (w.parent?.colormap ?? COLORMAP_ID); break;
        case 14: w.cursor = this.cursorById(v); this.cursorMaybeChanged(); break;
      }
    }
    void creating; void repaint;
  }

  private getWindowAttributes(c: Client, w: XWindow): void {
    const mapState = !w.mapped ? P.IsUnmapped : w.viewable() ? P.IsViewable : P.IsUnviewable;
    const out = c.writer(44).u32(w.visual).u16(w.cls).u8(w.bitGravity).u8(w.winGravity).u32(0xffffffff).u32(0)
      .u8(w.saveUnder ? 1 : 0).u8(1).u8(mapState).u8(w.overrideRedirect ? 1 : 0).u32(w.cls === P.InputOnly ? 0 : w.colormap)
      .u32(w.allEventMasks()).u32(w.eventMasks.get(c) ?? 0).u16(w.dontPropagate).zero(2);
    this.reply(c, w.backingStore, out);
  }

  destroyWindow(w: XWindow): void {
    if (w.destroyed) return;
    if (w.mapped) this.unmapWindow(w);
    for (const ch of [...w.children].reverse()) this.destroyWindow(ch);
    w.destroyed = true;
    // DestroyNotify: to the window, then its parent
    this.deliver(w, P.StructureNotifyMask, (e) => e.u8(P.DestroyNotify).u8(0).u16(0).u32(w.id).u32(w.id));
    if (w.parent) {
      const p = w.parent;
      this.deliver(p, P.SubstructureNotifyMask, (e) => e.u8(P.DestroyNotify).u8(0).u16(0).u32(p.id).u32(w.id));
      p.children = p.children.filter((x) => x !== w);
    }
    this.resources.delete(w.id);
    if (this.grab?.win === w || (this.grab && w.isAncestorOf(this.grab.win))) this.grab = null;
    if (this.kbdGrab?.win === w) this.kbdGrab = null;
    if (this.focus === w) this.revertFocus();
    for (const [sel, o] of [...this.selections]) if (o.win === w) { this.selections.delete(sel); this.hooks.selectionOwned?.(this.atomName(sel)!, null); }
    this.passiveButtons = this.passiveButtons.filter((g) => g.win !== w);
    this.passiveKeys = this.passiveKeys.filter((g) => g.win !== w);
    if (this.pointerWin === w || w.isAncestorOf(this.pointerWin)) this.pointerWin = w.parent ?? this.root;
    if (w.parent === this.root) this.hooks.topDestroyed?.(w);
    w.pix = null;
  }

  private reparentWindow(c: Client, w: XWindow, parent: XWindow, x: number, y: number): void {
    if (w === parent || w.isAncestorOf(parent) || w === this.root) throw new XError(P.BadMatch, 0);
    const wasMapped = w.mapped;
    if (wasMapped) this.unmapWindow(w);
    const old = w.parent!;
    const wasTop = old === this.root;
    old.children = old.children.filter((ch) => ch !== w);
    w.parent = parent; w.x = x; w.y = y;
    parent.children.push(w);
    const fill = (e: Writer, ev: XWindow) => e.u8(P.ReparentNotify).u8(0).u16(0).u32(ev.id).u32(w.id).u32(parent.id).i16(x).i16(y).u8(w.overrideRedirect ? 1 : 0);
    this.deliver(w, P.StructureNotifyMask, (e) => fill(e, w));
    this.deliver(old, P.SubstructureNotifyMask, (e) => fill(e, old));
    this.deliver(parent, P.SubstructureNotifyMask, (e) => fill(e, parent));
    if (wasTop) this.hooks.topDestroyed?.(w);
    if (wasMapped) this.mapWindow(c, w);
  }

  mapWindow(c: Client | null, w: XWindow): void {
    if (w.mapped || w.destroyed || !w.parent) return;
    const p = w.parent;
    if (!w.overrideRedirect) {
      for (const [other, m] of p.eventMasks) {
        if (other !== c && (m & P.SubstructureRedirectMask)) {
          this.event(other, (e) => e.u8(P.MapRequest).u8(0).u16(0).u32(p.id).u32(w.id));
          return;
        }
      }
    }
    w.mapped = true;
    this.deliver(w, P.StructureNotifyMask, (e) => e.u8(P.MapNotify).u8(0).u16(0).u32(w.id).u32(w.id).u8(w.overrideRedirect ? 1 : 0));
    this.deliver(p, P.SubstructureNotifyMask, (e) => e.u8(P.MapNotify).u8(0).u16(0).u32(p.id).u32(w.id).u8(w.overrideRedirect ? 1 : 0));
    if (!w.viewable()) return;
    this.becameViewable(w);
    if (p === this.root) {
      this.hooks.topMapped?.(w);
      this.hooks.damage?.(w, 0, 0, w.width, w.height);
    } else this.damageTop(w);
    this.updatePointerWindow();
  }

  /** Background, Expose and VisibilityNotify for a window that just became viewable, and its mapped children. */
  private becameViewable(w: XWindow): void {
    if (w.cls === P.InputOutput) {
      if (!w.pix) this.windowPix(w);
      else this.paintBackground(w, 0, 0, w.width, w.height);
      this.deliver(w, P.VisibilityChangeMask, (e) => e.u8(P.VisibilityNotify).u8(0).u16(0).u32(w.id).u8(0));
      this.deliver(w, P.ExposureMask, (e) => e.u8(P.Expose).u8(0).u16(0).u32(w.id).u16(0).u16(0).u16(w.width).u16(w.height).u16(0));
    }
    for (const ch of w.children) if (ch.mapped) this.becameViewable(ch);
  }

  unmapWindow(w: XWindow): void {
    if (!w.mapped || !w.parent) return;
    const wasViewable = w.viewable();
    w.mapped = false;
    const p = w.parent;
    this.deliver(w, P.StructureNotifyMask, (e) => e.u8(P.UnmapNotify).u8(0).u16(0).u32(w.id).u32(w.id).u8(0));
    this.deliver(p, P.SubstructureNotifyMask, (e) => e.u8(P.UnmapNotify).u8(0).u16(0).u32(p.id).u32(w.id).u8(0));
    if (this.grab && (this.grab.win === w || w.isAncestorOf(this.grab.win))) this.endGrab();
    if (typeof this.focus !== 'number' && (this.focus === w || w.isAncestorOf(this.focus))) this.revertFocus();
    if (p === this.root) this.hooks.topUnmapped?.(w);
    else if (wasViewable) this.damageTop(p);
    this.updatePointerWindow();
  }

  private configureRequest(c: Client, w: XWindow, r: Reader): void {
    const mask = r.u16(); r.skip(2);
    const v: Record<string, number> = {};
    const names = ['x', 'y', 'width', 'height', 'bw', 'sibling', 'stack'];
    for (let bit = 0; bit < 7; bit++) {
      if (!(mask & (1 << bit))) continue;
      const raw = r.u32();
      v[names[bit]] = bit <= 1 ? (raw << 16) >> 16 : bit <= 4 ? raw & 0xffff : raw;
    }
    if (w === this.root) return;
    const p = w.parent!;
    if (!w.overrideRedirect) {
      for (const [other, m] of p.eventMasks) {
        if (other !== c && (m & P.SubstructureRedirectMask)) {
          this.event(other, (e) => e.u8(P.ConfigureRequest).u8(v.stack ?? 0).u16(0).u32(p.id).u32(w.id).u32(v.sibling ?? 0)
            .i16(v.x ?? w.x).i16(v.y ?? w.y).u16(v.width ?? w.width).u16(v.height ?? w.height).u16(v.bw ?? w.bw).u16(mask));
          return;
        }
      }
    }
    if ((v.width !== undefined && v.width === 0) || (v.height !== undefined && v.height === 0)) throw new XError(P.BadValue, 0);
    this.configure(w, v);
  }

  /** Apply a configuration (also used by the rootless host for moves/resizes). */
  configure(w: XWindow, v: { x?: number; y?: number; width?: number; height?: number; bw?: number; sibling?: number; stack?: number }, synthetic = false): void {
    const p = w.parent!;
    const oldW = w.width, oldH = w.height;
    if (v.x !== undefined) w.x = v.x;
    if (v.y !== undefined) w.y = v.y;
    if (v.width !== undefined) w.width = Math.max(1, v.width);
    if (v.height !== undefined) w.height = Math.max(1, v.height);
    if (v.bw !== undefined) w.bw = v.bw;
    if (v.stack !== undefined) this.restack(w, v.stack, v.sibling ? this.winOrNull(v.sibling) : null);
    const resized = w.width !== oldW || w.height !== oldH;
    if (resized) this.resized(w, oldW, oldH);
    const above = (() => { const i = p.children.indexOf(w); return i > 0 ? p.children[i - 1].id : 0; })();
    const fill = (e: Writer, ev: XWindow) => {
      let x = w.x, y = w.y;
      if (synthetic) [x, y] = [w.x, w.y];
      e.u8(P.ConfigureNotify).u8(0).u16(0).u32(ev.id).u32(w.id).u32(above).i16(x).i16(y).u16(w.width).u16(w.height).u16(w.bw).u8(w.overrideRedirect ? 1 : 0);
    };
    this.deliver(w, P.StructureNotifyMask, (e) => fill(e, w));
    this.deliver(p, P.SubstructureNotifyMask, (e) => fill(e, p));
    if (p === this.root) this.hooks.topConfigured?.(w);
    if (w.viewable()) this.damageTop(w);
    if (w.viewable() && resized && p === this.root) this.hooks.damage?.(w, 0, 0, w.width, w.height);
    this.updatePointerWindow();
  }

  /** The rootless host moved a toplevel: like a reparenting WM, send a synthetic ConfigureNotify in root coordinates. */
  hostMoved(w: XWindow, x: number, y: number): void {
    if (w.x === x && w.y === y) return;
    w.x = x; w.y = y;
    for (const [c, m] of w.eventMasks) {
      if (!(m & P.StructureNotifyMask)) continue;
      this.event(c, (e) => e.u8(P.ConfigureNotify).u8(0).u16(0).u32(w.id).u32(w.id).u32(0).i16(x).i16(y).u16(w.width).u16(w.height).u16(w.bw).u8(w.overrideRedirect ? 1 : 0), true);
    }
    this.updatePointerWindow();
  }

  private resized(w: XWindow, oldW: number, oldH: number): void {
    if (w.pix) {
      const [dx, dy] = gravityOffset(w.bitGravity, oldW, oldH, w.width, w.height);
      if (w.bitGravity === 0) {
        w.pix.resize(w.width, w.height);
        this.paintBackground(w, 0, 0, w.width, w.height);
      } else {
        w.pix.resize(w.width, w.height, dx, dy);
        // newly exposed strips get the background
        if (w.width > oldW) this.paintBackground(w, oldW + dx, 0, w.width - oldW, w.height);
        if (w.height > oldH) this.paintBackground(w, 0, oldH + dy, w.width, w.height - oldH);
      }
    }
    // children move by win gravity
    for (const ch of w.children) {
      const [dx, dy] = gravityOffset(ch.winGravity, oldW, oldH, w.width, w.height);
      if (ch.winGravity === 0) { if (ch.mapped) this.unmapWindow(ch); continue; }
      if (dx || dy) {
        ch.x += dx; ch.y += dy;
        this.deliver(ch, P.StructureNotifyMask, (e) => e.u8(P.GravityNotify).u8(0).u16(0).u32(ch.id).u32(ch.id).i16(ch.x).i16(ch.y));
        this.deliver(w, P.SubstructureNotifyMask, (e) => e.u8(P.GravityNotify).u8(0).u16(0).u32(w.id).u32(ch.id).i16(ch.x).i16(ch.y));
      }
    }
    if (w.viewable() && w.cls === P.InputOutput) {
      // Expose the whole window when contents were forgotten, else the new area
      if (w.bitGravity === 0 || w.width > oldW || w.height > oldH) {
        this.deliver(w, P.ExposureMask, (e) => e.u8(P.Expose).u8(0).u16(0).u32(w.id).u16(0).u16(0).u16(w.width).u16(w.height).u16(0));
      }
    }
  }

  private restack(w: XWindow, mode: number, sibling: XWindow | null): void {
    const p = w.parent!;
    const list = p.children.filter((x) => x !== w);
    let i: number;
    switch (mode) {
      case 0: i = sibling ? list.indexOf(sibling) + 1 : list.length; break;       // Above
      case 1: i = sibling ? list.indexOf(sibling) : 0; break;                     // Below
      case 2: case 4: i = list.length; break;                                      // TopIf / Opposite (approx)
      default: i = 0;                                                              // BottomIf
    }
    if (i < 0) i = list.length;
    list.splice(i, 0, w);
    p.children = list;
  }

  private circulate(w: XWindow, dir: number): void {
    if (w.children.length < 2) return;
    const ch = dir === 0 ? w.children[0] : w.children[w.children.length - 1];
    this.restack(ch, dir === 0 ? 0 : 1, null);
    const place = dir === 0 ? 0 : 1;
    this.deliver(ch, P.StructureNotifyMask, (e) => e.u8(P.CirculateNotify).u8(0).u16(0).u32(ch.id).u32(ch.id).u32(0).u8(place));
    this.deliver(w, P.SubstructureNotifyMask, (e) => e.u8(P.CirculateNotify).u8(0).u16(0).u32(w.id).u32(ch.id).u32(0).u8(place));
    this.damageTop(w);
  }

  /** Raise a toplevel to the top of the stack (desktop focus). */
  raiseTop(w: XWindow): void {
    if (w.parent !== this.root) return;
    const list = this.root.children;
    if (list[list.length - 1] === w) return;
    this.root.children = [...list.filter((x) => x !== w), w];
  }

  private getGeometry(c: Client, id: number): void {
    const r = this.resources.get(id);
    if (r?.kind === 'pixmap') {
      const p = r.value as Pix;
      this.reply(c, p.depth, c.writer().u32(ROOT_ID).i16(0).i16(0).u16(p.width).u16(p.height).u16(0));
      return;
    }
    if (r?.kind !== 'window') throw new XError(P.BadDrawable, id);
    const w = r.value as XWindow;
    this.reply(c, w.depth, c.writer().u32(ROOT_ID).i16(w.x).i16(w.y).u16(w.width).u16(w.height).u16(w.bw));
  }

  private queryTree(c: Client, w: XWindow): void {
    const out = c.writer(32 + 4 * w.children.length).u32(ROOT_ID).u32(w.parent?.id ?? 0).u16(w.children.length).zero(14);
    for (const ch of w.children) out.u32(ch.id);
    this.reply(c, 0, out);
  }

  // ── properties ──
  private changeProperty(c: Client, mode: number, r: Reader): void {
    const w = this.win(r.u32()); const prop = r.u32(); const type = r.u32(); const format = r.u8(); r.skip(3);
    const n = r.u32();
    if (!this.atomName(prop)) throw new XError(P.BadAtom, prop);
    if (!this.atomName(type)) throw new XError(P.BadAtom, type);
    if (format !== 8 && format !== 16 && format !== 32) throw new XError(P.BadValue, format);
    const bytes = n * (format / 8);
    let data: Uint8Array = r.bytes(bytes).slice();
    if (!c.le && format > 8) data = swapUnits(data, format / 8); // store little-endian
    const old = w.props.get(prop);
    if (mode !== 0 && old) {
      if (old.type !== type || old.format !== format) throw new XError(P.BadMatch, 0);
      data = mode === 1 ? concat([data, old.data], data.length + old.data.length) : concat([old.data, data], data.length + old.data.length);
    }
    w.props.set(prop, { type, format, data });
    this.propertyNotify(w, prop, 0);
    void c;
  }

  setProperty(w: XWindow, prop: number, type: number, format: number, data: Uint8Array): void {
    w.props.set(prop, { type, format, data });
    this.propertyNotify(w, prop, 0);
  }

  private deleteProperty(w: XWindow, prop: number): void {
    if (!this.atomName(prop)) throw new XError(P.BadAtom, prop);
    if (w.props.delete(prop)) this.propertyNotify(w, prop, 1);
  }

  private propertyNotify(w: XWindow, prop: number, state: number): void {
    const t = this.time();
    this.deliver(w, P.PropertyChangeMask, (e) => e.u8(P.PropertyNotify).u8(0).u16(0).u32(w.id).u32(prop).u32(t).u8(state));
    if (w.parent === this.root) this.hooks.topProperty?.(w, this.atomName(prop) ?? '');
  }

  private getProperty(c: Client, del: number, r: Reader): void {
    const w = this.win(r.u32()); const prop = r.u32(); const type = r.u32(); const off = r.u32(); const len = r.u32();
    if (!this.atomName(prop)) throw new XError(P.BadAtom, prop);
    const p = w.props.get(prop);
    if (!p) { this.reply(c, 0, c.writer().u32(0).u32(0).u32(0)); return; }
    if (type !== 0 && type !== p.type) { this.reply(c, p.format, c.writer().u32(p.type).u32(p.data.length).u32(0)); return; }
    const N = p.data.length, I = 4 * off;
    if (I > N) throw new XError(P.BadValue, off);
    const L = Math.min(N - I, 4 * len);
    const A = N - (I + L);
    let value = p.data.subarray(I, I + L);
    if (!c.le && p.format > 8) value = swapUnits(value.slice(), p.format / 8);
    const out = c.writer(32 + L).u32(p.type).u32(A).u32(L / (p.format / 8)).zero(12);
    this.reply(c, p.format, out, value);
    if (del && A === 0) { w.props.delete(prop); this.propertyNotify(w, prop, 1); }
  }

  /** A property as bytes (little-endian units), for the rootless host. */
  prop(w: XWindow, name: string): Property | undefined {
    const id = this.existingAtom(name);
    return id ? w.props.get(id) : undefined;
  }

  // ── selections ──
  private setSelectionOwner(c: Client, ownerId: number, sel: number, time: number): void {
    const owner = ownerId ? this.win(ownerId) : null;
    if (!this.atomName(sel)) throw new XError(P.BadAtom, sel);
    const t = time || this.time();
    const old = this.selections.get(sel);
    if (old && time && old.time > time) return;
    if (old && old.client !== c && (!owner || old.win !== owner)) {
      this.event(old.client, (e) => e.u8(P.SelectionClear).u8(0).u16(0).u32(t).u32(old.win.id).u32(sel));
    }
    if (owner) this.selections.set(sel, { win: owner, client: c, time: t });
    else this.selections.delete(sel);
    this.hooks.selectionOwned?.(this.atomName(sel)!, owner);
  }

  selectionOwner(name: string): XWindow | null { return this.selections.get(this.existingAtom(name))?.win ?? null; }

  private convertSelection(c: Client, r: Reader): void {
    const requestor = this.win(r.u32()); const sel = r.u32(); const target = r.u32(); const prop = r.u32(); const time = r.u32();
    if (!this.atomName(sel)) throw new XError(P.BadAtom, sel);
    this.requestSelection(c, requestor, sel, target, prop, time);
  }

  private requestSelection(c: Client, requestor: XWindow, sel: number, target: number, prop: number, time: number): void {
    const o = this.selections.get(sel);
    if (o && !o.client.closed) {
      this.event(o.client, (e) => e.u8(P.SelectionRequest).u8(0).u16(0).u32(time).u32(o.win.id).u32(requestor.id).u32(sel).u32(target).u32(prop));
      return;
    }
    this.event(c, (e) => e.u8(P.SelectionNotify).u8(0).u16(0).u32(time).u32(requestor.id).u32(sel).u32(target).u32(0));
  }

  // ── server-side clients (the clipboard bridge) ──

  /**
   * A client inside the server: it gets events as 32-byte messages (replies
   * never come, it doesn't send requests) and acts through the methods below.
   */
  internalClient(onEvent: (e: Uint8Array) => void): Client {
    return this.connect({
      write: (d) => { for (let o = 0; o + 32 <= d.length; o += 32) onEvent(d.subarray(o, o + 32)); },
      close: () => {},
    });
  }

  /** An unmapped InputOnly window of the root owned by an internal client. */
  internalWindow(c: Client): XWindow {
    const id = c.base | (0x1000 + this.internalWindows++);
    const w = new XWindow(id, this.root, -1, -1, 1, 1, 0, P.InputOnly, 0, VISUAL_24, c);
    this.resources.set(id, { kind: 'window', owner: c, value: w, free: () => {} });
    this.root.children.unshift(w);
    return w;
  }
  private internalWindows = 0;

  /** SetSelectionOwner for an internal client. */
  ownSelection(c: Client, w: XWindow | null, name: string): void {
    this.setSelectionOwner(c, w ? w.id : 0, this.atom(name), 0);
  }

  /** ConvertSelection for an internal client: the owner answers with SelectionNotify to `w`. */
  convertSelectionFor(c: Client, w: XWindow, selection: string, target: string, property: string): void {
    this.requestSelection(c, w, this.atom(selection), this.atom(target), this.atom(property), this.time());
  }

  /** Send a SelectionNotify (the answer to a SelectionRequest) to a requestor. */
  selectionNotify(requestorId: number, selection: number, target: number, property: number, time: number): void {
    const w = this.winOrNull(requestorId);
    if (!w?.owner) return;
    this.event(w.owner, (e) => e.u8(P.SelectionNotify).u8(0).u16(0).u32(time).u32(w.id).u32(selection).u32(target).u32(property));
  }

  // ── SendEvent ──
  private sendEvent(c: Client, propagate: number, r: Reader): void {
    const dest = r.u32(); const mask = r.u32();
    const ev = r.bytes(32).slice();
    let w: XWindow | null;
    if (dest === 0) w = this.pointerWin;
    else if (dest === 1) {
      const f = this.focusWindow();
      w = f;
      if (f && this.pointerWin && f.isAncestorOf(this.pointerWin)) w = this.pointerWin;
    } else w = this.win(dest);
    if (!w) return;
    const send = (target: Client) => {
      const out = ev.slice();
      out[0] |= 0x80;
      if ((out[0] & 0x7f) !== P.KeymapNotify) new DataView(out.buffer).setUint16(2, target.seq, target.le);
      if (target.le !== c.le) swapEvent(out);
      target.send(out);
    };
    if (mask === 0) { if (w.owner && !w.owner.closed) send(w.owner); return; }
    for (let x: XWindow | null = w; x; x = x.parent) {
      let any = false;
      for (const [cl, m] of x.eventMasks) if (m & mask) { send(cl); any = true; }
      if (any || !propagate || (x.dontPropagate & mask)) return;
      if (x === this.focusWindow()) return;
    }
  }

  // ── pointer & keyboard ──
  private grabPointer(c: Client, ownerEvents: number, r: Reader): void {
    const win = this.win(r.u32()); const mask = r.u16(); r.skip(2);
    const confine = this.winOrNull(r.u32()); const cursor = this.cursorById(r.u32()); r.u32();
    if (this.grab && this.grab.client !== c && !this.grab.implicit) { this.reply(c, 1, c.writer()); return; }
    if (!win.viewable()) { this.reply(c, 3, c.writer()); return; }
    const old = this.grab;
    this.grab = { win, client: c, mask, ownerEvents: !!ownerEvents, implicit: false, cursor, confine };
    if (!old || old.win !== win) this.crossing(this.pointerWin, win, 1);
    this.cursorMaybeChanged();
    this.reply(c, 0, c.writer());
  }

  private endGrab(): void {
    const g = this.grab;
    if (!g) return;
    this.grab = null;
    if (!g.implicit) this.crossing(g.win, this.pointerWin, 2);
    this.cursorMaybeChanged();
  }

  focusWindow(): XWindow | null {
    if (this.kbdGrab) return this.kbdGrab.win;
    if (this.focus === 0) return null;
    if (this.focus === 1) return this.root;
    return this.focus as XWindow;
  }

  setFocus(target: XWindow | number, revert = 1): void {
    const old = this.focusWindow();
    this.focus = target;
    this.focusRevert = revert;
    const now = this.focusWindow();
    if (!this.kbdGrab && old !== now) this.focusChange(old, now, 0);
  }

  private revertFocus(): void {
    const r = this.focusRevert;
    let target: XWindow | number = r === 2 && typeof this.focus !== 'number' && this.focus.parent ? this.focus.parent : r === 1 ? 1 : 0;
    while (typeof target !== 'number' && !target.viewable()) target = target.parent ?? 1;
    this.setFocus(target, 0);
  }

  /** FocusOut/FocusIn with detail Ancestor/Inferior/Nonlinear (simplified). */
  private focusChange(from: XWindow | null, to: XWindow | null, mode: number): void {
    const send = (w: XWindow, code: number, detail: number) =>
      this.deliver(w, P.FocusChangeMask, (e) => e.u8(code).u8(detail).u16(0).u32(w.id).u8(mode));
    if (from && !from.destroyed) {
      if (to && from.isAncestorOf(to)) send(from, P.FocusOut, 2);         // Inferior
      else if (to && to.isAncestorOf(from)) {
        send(from, P.FocusOut, 0);                                          // Ancestor
        for (let p = from.parent; p && p !== to; p = p.parent) send(p, P.FocusOut, 1);
      } else {
        send(from, P.FocusOut, 3);                                          // Nonlinear
        for (let p = from.parent; p && (!to || !p.isAncestorOf(to)) && p !== to; p = p.parent) send(p, P.FocusOut, 4);
      }
    }
    if (to && !to.destroyed) {
      if (from && to.isAncestorOf(from)) send(to, P.FocusIn, 2);
      else if (from && from.isAncestorOf(to)) {
        const chain: XWindow[] = [];
        for (let p = to.parent; p && p !== from; p = p.parent) chain.unshift(p);
        for (const p of chain) send(p, P.FocusIn, 1);
        send(to, P.FocusIn, 0);
      } else {
        const chain: XWindow[] = [];
        for (let p = to.parent; p && (!from || !p.isAncestorOf(from)) && p !== from; p = p.parent) chain.unshift(p);
        for (const p of chain) send(p, P.FocusIn, 4);
        send(to, P.FocusIn, 3);
      }
    }
  }

  private queryPointer(c: Client, w: XWindow): void {
    const [ox, oy] = w.rootOrigin();
    let child = 0;
    for (let x: XWindow | null = this.pointerWin; x; x = x.parent) if (x.parent === w) { child = x.id; break; }
    this.reply(c, 1, c.writer().u32(ROOT_ID).u32(child).i16(this.pointerX).i16(this.pointerY).i16(this.pointerX - ox).i16(this.pointerY - oy).u16(this.mods | this.buttons));
  }

  private translateCoordinates(c: Client, src: XWindow, dst: XWindow, x: number, y: number): void {
    const [sx, sy] = src.rootOrigin(), [dx, dy] = dst.rootOrigin();
    const rx = sx + x, ry = sy + y;
    let child = 0;
    for (let i = dst.children.length - 1; i >= 0; i--) {
      const ch = dst.children[i];
      if (!ch.mapped) continue;
      const cx = dx + ch.x, cy = dy + ch.y;
      if (rx >= cx && ry >= cy && rx < cx + ch.width + 2 * ch.bw && ry < cy + ch.height + 2 * ch.bw) { child = ch.id; break; }
    }
    this.reply(c, 1, c.writer().u32(child).i16(rx - dx).i16(ry - dy));
  }

  /** Deepest viewable window containing root point (x, y); `within` restricts to one toplevel. */
  windowAt(x: number, y: number, within?: XWindow): XWindow {
    let w = this.root;
    let ox = 0, oy = 0;
    outer: for (;;) {
      const kids = w === this.root && within ? [within] : w.children;
      for (let i = kids.length - 1; i >= 0; i--) {
        const ch = kids[i];
        if (!ch.mapped) continue;
        const cx = ox + ch.x, cy = oy + ch.y;
        const tw = ch.width + 2 * ch.bw, th = ch.height + 2 * ch.bw;
        if (x < cx || y < cy || x >= cx + tw || y >= cy + th) continue;
        const shape = ch.shapeInput ?? ch.shapeBounding;
        if (shape && !shape.some((r) => x - cx - ch.bw >= r.x && y - cy - ch.bw >= r.y && x - cx - ch.bw < r.x + r.w && y - cy - ch.bw < r.y + r.h)) continue;
        w = ch; ox = cx + ch.bw; oy = cy + ch.bw;
        continue outer;
      }
      return w;
    }
  }

  private updatePointerWindow(): void {
    if (this.grab) return;
    const w = this.windowAt(this.pointerX, this.pointerY, this.pointerTop ?? undefined);
    if (w !== this.pointerWin) { this.crossing(this.pointerWin, w, 0); this.pointerWin = w; this.cursorMaybeChanged(); }
  }

  /** Which toplevel the host says the pointer is over (overlapping desktop windows). */
  pointerTop: XWindow | null = null;

  private cursorMaybeChanged(): void {
    const w = this.grab?.cursor ? this.grab.win : this.pointerWin;
    let cur: XCursor | null = this.grab?.cursor ?? null;
    if (!cur) for (let x: XWindow | null = w; x; x = x.parent) if (x.cursor) { cur = x.cursor; break; }
    const top = this.pointerWin.top();
    if (top) this.hooks.cursor?.(top, cur);
  }

  /** Enter/Leave events between two windows. */
  private crossing(from: XWindow, to: XWindow, mode: number): void {
    if (from === to) return;
    const t = this.time();
    const st = this.mods | this.buttons;
    const send = (w: XWindow, code: number, detail: number) => {
      if (w.destroyed) return;
      const [ox, oy] = w.rootOrigin();
      const focus = this.focusWindow();
      const flags = 2 | (focus && (focus === w || focus.isAncestorOf(w)) ? 1 : 0);
      this.deliverPointer(w, code, (e) => e.u8(code).u8(detail).u16(0).u32(t).u32(ROOT_ID).u32(w.id).u32(0)
        .i16(this.pointerX).i16(this.pointerY).i16(this.pointerX - ox).i16(this.pointerY - oy).u16(st).u8(mode).u8(flags), code === P.EnterNotify ? P.EnterWindowMask : P.LeaveWindowMask);
    };
    if (from.isAncestorOf(to)) {
      send(from, P.LeaveNotify, 2);
      const chain: XWindow[] = [];
      for (let p = to.parent; p && p !== from; p = p.parent) chain.unshift(p);
      for (const p of chain) send(p, P.EnterNotify, 1);
      send(to, P.EnterNotify, 0);
    } else if (to.isAncestorOf(from)) {
      send(from, P.LeaveNotify, 0);
      for (let p = from.parent; p && p !== to; p = p.parent) send(p, P.LeaveNotify, 1);
      send(to, P.EnterNotify, 2);
    } else {
      send(from, P.LeaveNotify, 3);
      let common: XWindow | null = from.parent;
      while (common && !common.isAncestorOf(to)) common = common.parent;
      for (let p = from.parent; p && p !== common; p = p.parent) send(p, P.LeaveNotify, 4);
      const chain: XWindow[] = [];
      for (let p = to.parent; p && p !== common; p = p.parent) chain.unshift(p);
      for (const p of chain) send(p, P.EnterNotify, 4);
      send(to, P.EnterNotify, 3);
    }
  }

  /** Crossing events go only to the window itself (no propagation), honoring the grab. */
  private deliverPointer(w: XWindow, code: number, fill: (e: Writer) => void, mask: number): void {
    const g = this.grab;
    if (g && !g.implicit) {
      if (g.ownerEvents) {
        const m = w.eventMasks.get(g.client);
        if (m !== undefined && (m & mask)) { this.event(g.client, fill); return; }
      }
      if (w === g.win && (g.mask & mask)) this.event(g.client, fill);
      return;
    }
    this.deliver(w, mask, (e) => fill(e));
    void code;
  }

  /** Move the pointer (root coordinates) and send motion/crossing events. */
  movePointer(x: number, y: number, top?: XWindow | null): void {
    if (top !== undefined) this.pointerTop = top;
    this.pointerX = x; this.pointerY = y;
    const w = this.windowAt(x, y, this.pointerTop ?? undefined);
    if (w !== this.pointerWin) {
      if (!this.grab) this.crossing(this.pointerWin, w, 0);
      this.pointerWin = w;
      this.cursorMaybeChanged();
    }
    this.deviceEvent(P.MotionNotify, 0, w);
  }

  /** Button press/release (1 left, 2 middle, 3 right, 4/5 wheel). */
  button(press: boolean, button: number): void {
    const bit = button <= 5 ? 1 << (7 + button) : 0;
    if (press) {
      if (!this.grab) {
        // passive grabs, outermost first
        const chain: XWindow[] = [];
        for (let x: XWindow | null = this.pointerWin; x; x = x.parent) chain.unshift(x);
        for (const x of chain) {
          const g = this.passiveButtons.find((pg) => pg.win === x && (pg.button === 0 || pg.button === button) && (pg.mods === 0x8000 || pg.mods === (this.mods & 0xff)));
          if (g) {
            this.grab = { win: g.win, client: g.client, mask: g.mask, ownerEvents: g.ownerEvents, implicit: false, cursor: g.cursor, confine: g.confine };
            (this.grab as any).passive = true;
            this.crossing(this.pointerWin, g.win, 1);
            break;
          }
        }
      }
      this.deviceEvent(P.ButtonPress, button, this.pointerWin);
      this.buttons |= bit;
    } else {
      this.deviceEvent(P.ButtonRelease, button, this.pointerWin);
      this.buttons &= ~bit;
      if (!(this.buttons & 0x1f00) && this.grab && (this.grab.implicit || (this.grab as any).passive)) {
        const g = this.grab;
        this.grab = null;
        if (!g.implicit) this.crossing(g.win, this.pointerWin, 2);
        else this.updatePointerWindow();
        this.cursorMaybeChanged();
      }
    }
  }

  /** Key press/release by X keycode. */
  key(press: boolean, keycode: number): void {
    if (press) this.keysDown.add(keycode); else this.keysDown.delete(keycode);
    this.deviceEvent(press ? P.KeyPress : P.KeyRelease, keycode, this.pointerWin);
    const mod = MODIFIER_MAP.findIndex((m) => m.includes(keycode));
    if (mod >= 0) {
      if (mod === 1) { if (press) this.mods ^= P.LockMask; }
      else if (mod === 4) { if (press) this.mods ^= P.Mod2Mask; }
      else if (press) this.mods |= 1 << mod; else this.mods &= ~(1 << mod);
    }
  }

  /** Set modifier state from the host (keys released while the page was unfocused). */
  syncModifiers(mods: number): void { this.mods = (this.mods & (P.LockMask | P.Mod2Mask)) | (mods & ~(P.LockMask | P.Mod2Mask)); }

  mappingNotify(request: number, first: number, count: number): void {
    for (const c of this.clients.values()) this.event(c, (e) => e.u8(P.MappingNotify).u8(0).u16(0).u8(request).u8(first).u8(count));
  }

  /** Key, button and motion events: grabs, focus, propagation. */
  private deviceEvent(code: number, detail: number, src: XWindow): void {
    const isKey = code === P.KeyPress || code === P.KeyRelease;
    const state = this.mods | this.buttons;
    const mask = P.maskForEvent(code, state);
    const t = this.time();
    const build = (ev: XWindow, child: number) => (e: Writer) => {
      const [ox, oy] = ev.rootOrigin();
      e.u8(code).u8(code === P.MotionNotify ? 0 : detail).u16(0).u32(t).u32(ROOT_ID).u32(ev.id).u32(child)
        .i16(this.pointerX).i16(this.pointerY).i16(this.pointerX - ox).i16(this.pointerY - oy).u16(state).u8(1).u8(0);
    };
    const childOf = (ev: XWindow, from: XWindow) => {
      for (let x: XWindow | null = from; x; x = x.parent) if (x.parent === ev) return x.id;
      return 0;
    };
    if (isKey) {
      if (this.kbdGrab) {
        const g = this.kbdGrab;
        if (g.ownerEvents && g.win.isAncestorOf(src) || g.ownerEvents && src === g.win) { if (this.propagate(src, code, mask, build, childOf, g.client)) return; }
        this.event(g.client, build(g.win, childOf(g.win, src)));
        return;
      }
      const focus = this.focusWindow();
      if (!focus) return;
      let start = focus;
      if (focus === this.root || focus.isAncestorOf(src)) start = src;
      if (code === P.KeyPress) {
        for (let x: XWindow | null = start; x; x = x.parent) {
          const g = this.passiveKeys.find((pk) => pk.win === x && (pk.key === 0 || pk.key === detail) && (pk.mods === 0x8000 || pk.mods === (this.mods & 0xff)));
          if (g) { this.event(g.client, build(g.win, childOf(g.win, src))); return; }
        }
      }
      this.propagate(start, code, mask, build, childOf, null, focus === this.root ? null : focus);
      return;
    }
    const g = this.grab;
    if (g) {
      if (g.ownerEvents && this.propagate(src, code, mask, build, childOf, g.client)) return;
      if (g.mask & mask) this.event(g.client, build(g.win, childOf(g.win, src)));
      return;
    }
    const delivered = this.propagate(src, code, mask, build, childOf, null);
    if (code === P.ButtonPress && delivered) {
      // implicit grab on the window that got the press
      const { win, client } = delivered;
      const m = win.eventMasks.get(client) ?? 0;
      this.grab = { win, client, mask: m, ownerEvents: (m & P.OwnerGrabButtonMask) !== 0, implicit: true, cursor: null, confine: null };
    }
  }

  /** Propagate a device event up from `src`; returns the window/client of delivery. */
  private propagate(src: XWindow, code: number, mask: number, build: (ev: XWindow, child: number) => (e: Writer) => void,
    childOf: (ev: XWindow, from: XWindow) => number, only: Client | null, stopAt: XWindow | null = null): { win: XWindow; client: Client } | null {
    for (let x: XWindow | null = src; x; x = x.parent) {
      let hit: { win: XWindow; client: Client } | null = null;
      for (const [c, m] of x.eventMasks) {
        if (only && c !== only) continue;
        if (!(m & mask)) continue;
        // ButtonPress goes to one client only (the one selecting it)
        this.event(c, build(x, childOf(x, src)));
        hit ??= { win: x, client: c };
      }
      if (hit) return hit;
      if (x.dontPropagate & mask) return null;
      if (stopAt && x === stopAt) return null;
    }
    return null;
  }

  // ── GCs & drawing ──
  private changeGC(gc: GC, mask: number, r: Reader): void {
    for (let bit = 0; bit < 23; bit++) {
      if (!(mask & (1 << bit))) continue;
      const v = r.u32();
      switch (bit) {
        case 0: gc.func = v & 15; break;
        case 1: gc.planeMask = v; break;
        case 2: gc.fg = v; break;
        case 3: gc.bg = v; break;
        case 4: gc.lineWidth = v & 0xffff; break;
        case 5: gc.lineStyle = v; break;
        case 6: gc.capStyle = v; break;
        case 7: gc.joinStyle = v; break;
        case 8: gc.fillStyle = v; break;
        case 9: gc.fillRule = v; break;
        case 10: gc.tile = this.pixmap(v); break;
        case 11: gc.stipple = this.pixmap(v); break;
        case 12: gc.tsx = (v << 16) >> 16; break;
        case 13: gc.tsy = (v << 16) >> 16; break;
        case 14: gc.font = this.font(v); gc.fontId = v; break;
        case 15: gc.subwindowMode = v; break;
        case 16: gc.graphicsExposures = !!v; break;
        case 17: gc.clipX = (v << 16) >> 16; break;
        case 18: gc.clipY = (v << 16) >> 16; break;
        case 19:
          if (v === 0) { gc.clipMask = null; gc.clipRects = null; }
          else { const m = this.pixmap(v); gc.clipMask = m; gc.clipRects = [{ x: 0, y: 0, w: m.width, h: m.height }]; }
          break;
        case 20: gc.dashOffset = v & 0xffff; break;
        case 21: gc.dashes = [v & 0xff, v & 0xff]; break;
        case 22: gc.arcMode = v; break;
      }
    }
  }

  /** Read drawable + gc and make a Painter. */
  private painter(r: Reader): { p: Painter; d: Drawable; done: () => void } {
    const d = this.drawable(r.u32());
    const gc = this.gc(r.u32());
    const p = new Painter(d.pix, gc);
    return { p, d, done: () => p.finish() };
  }

  private polyPointLine(op: number, mode: number, r: Reader): void {
    const { p, done } = this.painter(r);
    const pts: number[] = [];
    while (r.left >= 4) {
      let x = r.i16(), y = r.i16();
      if (mode === 1 && pts.length) { x += pts[pts.length - 2]; y += pts[pts.length - 1]; }
      pts.push(x, y);
    }
    if (op === 64) for (let i = 0; i < pts.length; i += 2) p.span(pts[i + 1], pts[i], pts[i] + 1);
    else {
      const closed = pts.length >= 6 && pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1];
      p.polyline(pts, closed);
    }
    done();
  }

  private clearArea(c: Client, exposures: number, w: XWindow, x: number, y: number, ww: number, hh: number): void {
    if (w.cls === P.InputOnly) throw new XError(P.BadMatch, w.id);
    if (!ww) ww = Math.max(0, w.width - x);
    if (!hh) hh = Math.max(0, w.height - y);
    if (w.pix) this.paintBackground(w, x, y, ww, hh);
    if (exposures && w.viewable()) {
      this.deliver(w, P.ExposureMask, (e) => e.u8(P.Expose).u8(0).u16(0).u32(w.id).u16(Math.max(0, x)).u16(Math.max(0, y)).u16(ww).u16(hh).u16(0));
    }
    void c;
  }

  private copyArea(c: Client, r: Reader): void {
    const src = this.drawable(r.u32()), dst = this.drawable(r.u32()), gc = this.gc(r.u32());
    const sx = r.i16(), sy = r.i16(), dx = r.i16(), dy = r.i16(), w = r.u16(), h = r.u16();
    if (src.depth !== dst.depth) throw new XError(P.BadMatch, 0);
    const s = src.pix;
    // clip the source rectangle to the source bounds
    const sr = intersect({ x: sx, y: sy, w, h }, { x: 0, y: 0, w: s.width, h: s.height });
    const dom = this.domText && src.pix === dst.pix && dst.win && dst.win.viewable() ? dst.win : null;
    const top = dom?.top();
    let o: [number, number] = [0, 0];
    if (dom && top && sr) { o = dom.topOrigin(); this.hooks.copy?.(top, 'begin', o[0] + sr.x, o[1] + sr.y, sr.w, sr.h, o[0] + dx + (sr.x - sx), o[1] + dy + (sr.y - sy)); }
    if (sr) {
      const p = new Painter(dst.pix, gc);
      const ox = dx + (sr.x - sx), oy = dy + (sr.y - sy);
      if (s === dst.pix) {
        const tmp = new Uint32Array(sr.w * sr.h);
        for (let j = 0; j < sr.h; j++) tmp.set(s.data.subarray((sr.y + j) * s.width + sr.x, (sr.y + j) * s.width + sr.x + sr.w), j * sr.w);
        p.copyRows(ox, oy, sr.w, sr.h, tmp, sr.w, 0);
      } else p.copyRows(ox, oy, sr.w, sr.h, s.data, s.width, sr.y * s.width + sr.x);
      p.finish();
      if (dom && top) this.hooks.copy?.(top, 'end', o[0] + sr.x, o[1] + sr.y, sr.w, sr.h, o[0] + ox, o[1] + oy);
    }
    if (gc.graphicsExposures) this.noExposure(c, dst, 62);
  }

  private copyPlane(c: Client, r: Reader): void {
    const src = this.drawable(r.u32()), dst = this.drawable(r.u32()), gc = this.gc(r.u32());
    const sx = r.i16(), sy = r.i16(), dx = r.i16(), dy = r.i16(), w = r.u16(), h = r.u16(); const plane = r.u32();
    if (!plane || (plane & (plane - 1))) throw new XError(P.BadValue, plane);
    const s = src.pix;
    const p = new Painter(dst.pix, gc);
    p.block(dx, dy, w, h, (x, y) => {
      const X = sx + x, Y = sy + y;
      if (X < 0 || Y < 0 || X >= s.width || Y >= s.height) return -1;
      return (s.data[Y * s.width + X] & plane) ? gc.fg : gc.bg;
    });
    p.finish();
    if (gc.graphicsExposures) this.noExposure(c, dst, 63);
  }

  private noExposure(c: Client, d: Drawable, major: number): void {
    const id = d.win ? d.win.id : this.idOfPix(d.pix);
    this.event(c, (e) => e.u8(P.NoExpose).u8(0).u16(0).u32(id).u16(0).u8(major));
  }

  private idOfPix(p: Pix): number {
    for (const [id, r] of this.resources) if (r.value === p) return id;
    return 0;
  }

  private putImage(c: Client, format: number, r: Reader): void {
    const d = this.drawable(r.u32()); const gc = this.gc(r.u32());
    const w = r.u16(), h = r.u16(), dx = r.i16(), dy = r.i16(), leftPad = r.u8(), depth = r.u8(); r.skip(2);
    const data = r.bytes(r.left);
    const p = new Painter(d.pix, gc);
    if (format === 0) { // XYBitmap
      if (depth !== 1) throw new XError(P.BadMatch, 0);
      const stride = imageStride(w + leftPad, 1);
      if (data.length < stride * h) throw new XError(P.BadLength, 0);
      p.block(dx, dy, w, h, (x, y) => { const b = x + leftPad; return ((data[y * stride + (b >> 3)] >> (b & 7)) & 1) ? gc.fg : gc.bg; });
    } else if (format === 1) { // XYPixmap
      if (depth !== d.depth) throw new XError(P.BadMatch, 0);
      const stride = imageStride(w + leftPad, 1);
      const plane = stride * h;
      p.block(dx, dy, w, h, (x, y) => {
        let v = 0;
        const b = x + leftPad;
        for (let k = 0; k < depth; k++) v = (v << 1) | ((data[k * plane + y * stride + (b >> 3)] >> (b & 7)) & 1);
        return v;
      });
    } else if (format === 2) { // ZPixmap
      if (depth !== d.depth) throw new XError(P.BadMatch, 0);
      if (depth >= 24 && !leftPad) {
        const stride = imageStride(w, 32) / 4;
        const aligned = data.byteOffset % 4 === 0 ? new Uint32Array(data.buffer, data.byteOffset, Math.floor(data.length / 4)) : new Uint32Array(data.slice().buffer, 0, Math.floor(data.length / 4));
        if (aligned.length < stride * h) throw new XError(P.BadLength, 0);
        if (c.le) p.copyRows(dx, dy, w, h, aligned, stride, 0);
        else { const sw = aligned.map((v) => ((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24)); p.copyRows(dx, dy, w, h, sw, stride, 0); }
      } else {
        const read = zImageReader(data, w, depth, leftPad);
        p.block(dx, dy, w, h, read);
      }
    } else throw new XError(P.BadValue, format);
    p.finish();
  }

  private getImage(c: Client, format: number, r: Reader): void {
    const d = this.drawable(r.u32());
    const x = r.i16(), y = r.i16(), w = r.u16(), h = r.u16(); const planeMask = r.u32();
    if (x < 0 || y < 0 || x + w > d.pix.width || y + h > d.pix.height) {
      if (!d.win) throw new XError(P.BadMatch, 0);
    }
    const visual = d.win ? d.win.visual : 0;
    const img = format === 2 ? encodeZImage(d.pix, x, y, w, h, planeMask) : encodeXYImage(d.pix, x, y, w, h, planeMask);
    this.reply(c, d.depth, c.writer().u32(visual).zero(20), img);
  }

  private polyText(wide: boolean, r: Reader): void {
    const { p, d, done } = this.painter(r);
    const dom = this.domText && !!d.win;
    const runs: [XFont, number[], number, number][] = [];
    let x = r.i16();
    const y = r.i16();
    while (r.left >= 2) {
      const n = r.u8();
      if (n === 0) { if (r.left < 1) break; r.u8(); continue; }
      if (n === 255) {
        const fid = (r.u8() << 24) | (r.u8() << 16) | (r.u8() << 8) | r.u8();
        p.gc.font = this.font(fid >>> 0); p.gc.fontId = fid >>> 0;
        continue;
      }
      const delta = r.i8();
      if (r.left < (wide ? 2 * n : n)) break;
      const codes: number[] = [];
      for (let i = 0; i < n; i++) codes.push(wide ? (r.u8() << 8) | r.u8() : r.u8());
      x += delta;
      if (!p.gc.font) continue;
      const x0 = x;
      x = p.text(p.gc.font, codes, x, y, false, !dom || this.domTextRaster);
      if (dom) runs.push([p.gc.font, codes, x0, x - x0]);
    }
    done();
    // after the damage of the glyphs drawn (overlay mode), or it would remove these runs' spans
    for (const [font, codes, x0, width] of runs) this.textRun(d.win!, p.gc, font, codes, x0, y, width, false);
  }

  private textRun(w: XWindow, gc: { fg: number; bg: number }, font: XFont, codes: number[], x: number, y: number, width: number, image: boolean): void {
    const top = w.top();
    if (!top || !w.viewable() || !this.hooks.text) return;
    const [ox, oy] = w.topOrigin();
    // 8-bit fonts here are ISO 8859-1 and 16-bit ones ISO 10646: both map code → code point
    const text = String.fromCharCode(...codes);
    this.hooks.text(top, { x: ox + x, y: oy + y, width, ascent: font.ascent, descent: font.descent, text, font: font.name, fg: gc.fg, bg: image ? gc.bg : null });
  }

  // ── fonts ──
  private writeCharInfo(w: Writer, ci: CharInfo): void {
    w.i16(ci.lsb).i16(ci.rsb).i16(ci.width).i16(ci.ascent).i16(ci.descent).u16(ci.attr);
  }

  private fontInfo(w: Writer, f: XFont, nInfos: number): void {
    this.writeCharInfo(w, f.minBounds); w.zero(4);
    this.writeCharInfo(w, f.maxBounds); w.zero(4);
    w.u16(f.minChar2).u16(f.maxChar2).u16(f.defaultChar).u16(f.props.length);
    w.u8(0).u8(f.minByte1).u8(f.maxByte1).u8(f.allExist ? 1 : 0).i16(f.ascent).i16(f.descent).u32(nInfos);
    for (const [k, v] of f.props) w.u32(this.atom(k)).u32(typeof v === 'string' ? this.atom(v) : v);
  }

  private queryFont(c: Client, f: XFont): void {
    const infos: CharInfo[] = [];
    for (let b1 = f.minByte1; b1 <= f.maxByte1; b1++) for (let b2 = f.minChar2; b2 <= f.maxChar2; b2++) infos.push(f.infoAt((b1 << 8) | b2));
    const w = c.writer(64 + f.props.length * 8 + infos.length * 12);
    this.fontInfo(w, f, infos.length);
    for (const ci of infos) this.writeCharInfo(w, ci);
    this.reply(c, 0, w);
  }

  private listFontsWithInfo(c: Client, r: Reader): void {
    const max = r.u16(); const n = r.u16();
    const names = listFonts(r.str(n), max);
    let left = names.length;
    for (const name of names) {
      const f = openFont(name, false);
      left--;
      if (!f) continue;
      const w = c.writer(64 + name.length);
      this.fontInfo(w, f, left);
      w.str(name);
      this.reply(c, name.length, w);
    }
    this.reply(c, 0, c.writer().zero(52));
  }

  // ── cursors ──
  private createCursor(c: Client, r: Reader): void {
    const id = r.u32(); const src = this.pixmap(r.u32()); const maskId = r.u32();
    const mask = maskId ? this.pixmap(maskId) : null;
    const fr = r.u16() >> 8, fg = r.u16() >> 8, fb = r.u16() >> 8, br = r.u16() >> 8, bg = r.u16() >> 8, bb = r.u16() >> 8;
    const xhot = r.u16(), yhot = r.u16();
    if (src.depth !== 1) throw new XError(P.BadMatch, 0);
    const rgba = new Uint8ClampedArray(src.width * src.height * 4);
    for (let i = 0; i < src.width * src.height; i++) {
      const on = src.data[i] & 1;
      const visible = mask ? (mask.data[i] ?? 0) & 1 : 1;
      if (!visible) continue;
      rgba.set(on ? [fr, fg, fb, 255] : [br, bg, bb, 255], i * 4);
    }
    const cur: XCursor = { id, css: 'default', image: { width: src.width, height: src.height, rgba, xhot, yhot } };
    this.addResource(c, id, 'cursor', cur);
  }

  private createGlyphCursor(c: Client, r: Reader): void {
    const id = r.u32(); r.u32(); r.u32();
    const ch = r.u16();
    this.addResource(c, id, 'cursor', { id, css: cursorFontCss(ch) });
  }

  /** Register a cursor made by an extension (RENDER CreateCursor). */
  addCursor(c: Client, cur: XCursor): void { this.addResource(c, cur.id, 'cursor', cur); }

  // ── extensions: SHAPE, XC-MISC ──
  private xcmisc(c: Client, minor: number, r: Reader): void {
    switch (minor) {
      case 0: this.reply(c, 0, c.writer().u16(1).u16(1)); return;
      case 1: { // GetXIDRange
        let start = c.base + 1;
        for (const id of this.resources.keys()) if ((id & ~RESOURCE_MASK) === c.base && id >= start) start = id + 1;
        this.reply(c, 0, c.writer().u32(start).u32(c.base + RESOURCE_MASK - start + 1));
        return;
      }
      case 2: { // GetXIDList
        const count = r.u32();
        const ids: number[] = [];
        for (let id = c.base + 1; ids.length < count && id <= c.base + RESOURCE_MASK; id++) if (!this.resources.has(id)) ids.push(id);
        const w = c.writer(32 + 4 * ids.length).u32(ids.length).zero(20);
        for (const id of ids) w.u32(id);
        this.reply(c, 0, w);
        return;
      }
    }
    throw new XError(P.BadRequest);
  }

  private shapeRequest(c: Client, minor: number, r: Reader): void {
    const kindRects = (w: XWindow, kind: number): Rect[] | null => kind === 2 ? w.shapeInput : kind === 0 ? w.shapeBounding : null;
    const setKind = (w: XWindow, kind: number, rects: Rect[] | null) => {
      if (kind === 0) w.shapeBounding = rects;
      else if (kind === 2) w.shapeInput = rects;
      this.damageTop(w);
      const shaped = !!rects;
      const ext = rects ? bounds(rects) : { x: -w.bw, y: -w.bw, w: w.width + 2 * w.bw, h: w.height + 2 * w.bw };
      for (const cl of w.shapeSelect) this.event(cl, (e) => e.u8(this.shapeEvent).u8(kind).u16(0).u32(w.id).i16(ext.x).i16(ext.y).u16(ext.w).u16(ext.h).u32(this.time()).u8(shaped ? 1 : 0));
    };
    const combine = (cur: Rect[] | null, w: XWindow, op: number, src: Rect[] | null): Rect[] | null => {
      const full = [{ x: 0, y: 0, w: w.width, h: w.height }];
      const a = cur ?? full;
      const b = src ?? full;
      switch (op) {
        case 0: return src;                                  // Set
        case 1: return [...a, ...b];                         // Union
        case 2: return intersectRects(a, b);                 // Intersect
        case 3: return subtractRects(a, b);                  // Subtract
        case 4: return subtractRects(b, a);                  // Invert
      }
      return src;
    };
    switch (minor) {
      case 0: this.reply(c, 0, c.writer().u16(1).u16(1)); return; // QueryVersion 1.1
      case 1: { // Rectangles
        const op = r.u8(), kind = r.u8(); r.skip(2);
        const w = this.win(r.u32()); const xo = r.i16(), yo = r.i16();
        const rects: Rect[] = [];
        while (r.left >= 8) rects.push({ x: r.i16() + xo, y: r.i16() + yo, w: r.u16(), h: r.u16() });
        setKind(w, kind, combine(kindRects(w, kind), w, op, rects));
        return;
      }
      case 2: { // Mask
        const op = r.u8(), kind = r.u8(); r.skip(2);
        const w = this.win(r.u32()); const xo = r.i16(), yo = r.i16(); const pm = r.u32();
        const rects = pm ? maskToRects(this.pixmap(pm), xo, yo) : null;
        setKind(w, kind, combine(kindRects(w, kind), w, op, rects));
        return;
      }
      case 3: { // Combine
        const op = r.u8(), kind = r.u8(), srcKind = r.u8(); r.skip(1);
        const w = this.win(r.u32()); const xo = r.i16(), yo = r.i16(); const sw = this.win(r.u32());
        const src = kindRects(sw, srcKind);
        setKind(w, kind, combine(kindRects(w, kind), w, op, src ? src.map((q) => ({ ...q, x: q.x + xo, y: q.y + yo })) : null));
        return;
      }
      case 4: { // Offset
        const kind = r.u8(); r.skip(3); const w = this.win(r.u32()); const xo = r.i16(), yo = r.i16();
        const cur = kindRects(w, kind);
        if (cur) setKind(w, kind, cur.map((q) => ({ ...q, x: q.x + xo, y: q.y + yo })));
        return;
      }
      case 5: { // QueryExtents
        const w = this.win(r.u32());
        const b = w.shapeBounding ? bounds(w.shapeBounding) : { x: -w.bw, y: -w.bw, w: w.width + 2 * w.bw, h: w.height + 2 * w.bw };
        this.reply(c, 0, c.writer().u8(w.shapeBounding ? 1 : 0).u8(0).zero(2).i16(b.x).i16(b.y).u16(b.w).u16(b.h).i16(0).i16(0).u16(w.width).u16(w.height));
        return;
      }
      case 6: { const w = this.win(r.u32()); if (r.u8()) w.shapeSelect.add(c); else w.shapeSelect.delete(c); return; }
      case 7: { const w = this.win(r.u32()); this.reply(c, w.shapeSelect.has(c) ? 1 : 0, c.writer()); return; }
      case 8: { // GetRectangles
        const w = this.win(r.u32()); const kind = r.u8();
        const rects = kindRects(w, kind) ?? [{ x: 0, y: 0, w: w.width, h: w.height }];
        const out = c.writer(32 + rects.length * 8).u32(rects.length).zero(20);
        for (const q of rects) out.i16(q.x).i16(q.y).u16(q.w).u16(q.h);
        this.reply(c, 0, out);
        return;
      }
    }
    throw new XError(P.BadRequest);
  }
}

// ── helpers ──

export function expand8(v: number): number { return (v << 8) | v; }

function rgbPixel(r: number, g: number, b: number, visual: number): number {
  const px = ((r >> 8) << 16) | ((g >> 8) << 8) | (b >> 8);
  return visual === VISUAL_32 ? (px | 0xff000000) >>> 0 : px;
}

function copyGC(src: GC, dst: GC, mask: number): void {
  const keys: (keyof GC)[][] = [['func'], ['planeMask'], ['fg'], ['bg'], ['lineWidth'], ['lineStyle'], ['capStyle'], ['joinStyle'],
    ['fillStyle'], ['fillRule'], ['tile'], ['stipple'], ['tsx'], ['tsy'], ['font', 'fontId'], ['subwindowMode'], ['graphicsExposures'],
    ['clipX'], ['clipY'], ['clipRects', 'clipMask'], ['dashOffset'], ['dashes'], ['arcMode']];
  keys.forEach((ks, bit) => { if (mask & (1 << bit)) for (const k of ks) (dst as any)[k] = (src as any)[k]; });
}

function gravityOffset(g: number, ow: number, oh: number, nw: number, nh: number): [number, number] {
  const dw = nw - ow, dh = nh - oh;
  switch (g) {
    case 2: return [dw >> 1, 0];       // North
    case 3: return [dw, 0];            // NorthEast
    case 4: return [0, dh >> 1];       // West
    case 5: return [dw >> 1, dh >> 1]; // Center
    case 6: return [dw, dh >> 1];      // East
    case 7: return [0, dh];            // SouthWest
    case 8: return [dw >> 1, dh];      // South
    case 9: return [dw, dh];           // SouthEast
    default: return [0, 0];            // Forget, NorthWest, Static
  }
}

function swapUnits(b: Uint8Array, unit: number): Uint8Array {
  for (let i = 0; i + unit <= b.length; i += unit) {
    if (unit === 2) { const t = b[i]; b[i] = b[i + 1]; b[i + 1] = t; }
    else { let t = b[i]; b[i] = b[i + 3]; b[i + 3] = t; t = b[i + 1]; b[i + 1] = b[i + 2]; b[i + 2] = t; }
  }
  return b;
}

/** Byte-swap a ClientMessage between clients of different byte orders (best effort: 32-bit data). */
function swapEvent(e: Uint8Array): void {
  const s16 = (o: number) => { const t = e[o]; e[o] = e[o + 1]; e[o + 1] = t; };
  const s32 = (o: number) => { let t = e[o]; e[o] = e[o + 3]; e[o + 3] = t; t = e[o + 1]; e[o + 1] = e[o + 2]; e[o + 2] = t; };
  s16(2);
  for (let o = 4; o < 32; o += 4) s32(o);
}

function bounds(rects: Rect[]): Rect {
  if (!rects.length) return { x: 0, y: 0, w: 0, h: 0 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function intersectRects(a: Rect[], b: Rect[]): Rect[] {
  const out: Rect[] = [];
  for (const p of a) for (const q of b) { const i = intersect(p, q); if (i) out.push(i); }
  return out;
}

function subtractRects(a: Rect[], b: Rect[]): Rect[] {
  let cur = a;
  for (const q of b) {
    const next: Rect[] = [];
    for (const p of cur) {
      const i = intersect(p, q);
      if (!i) { next.push(p); continue; }
      if (i.y > p.y) next.push({ x: p.x, y: p.y, w: p.w, h: i.y - p.y });
      if (i.y + i.h < p.y + p.h) next.push({ x: p.x, y: i.y + i.h, w: p.w, h: p.y + p.h - i.y - i.h });
      if (i.x > p.x) next.push({ x: p.x, y: i.y, w: i.x - p.x, h: i.h });
      if (i.x + i.w < p.x + p.w) next.push({ x: i.x + i.w, y: i.y, w: p.x + p.w - i.x - i.w, h: i.h });
    }
    cur = next;
  }
  return cur;
}

/** Rows of runs of set pixels in a depth-1 pixmap. */
function maskToRects(m: Pix, xo: number, yo: number): Rect[] {
  const out: Rect[] = [];
  for (let y = 0; y < m.height; y++) {
    let x = 0;
    while (x < m.width) {
      while (x < m.width && !(m.data[y * m.width + x] & 1)) x++;
      const s = x;
      while (x < m.width && (m.data[y * m.width + x] & 1)) x++;
      if (x > s) {
        const prev = out[out.length - 1];
        // merge with the run directly above when it has the same extent
        out.push({ x: s + xo, y: y + yo, w: x - s, h: 1 });
        void prev;
      }
    }
  }
  return mergeRows(out);
}

function mergeRows(rects: Rect[]): Rect[] {
  const open = new Map<string, Rect>();
  const out: Rect[] = [];
  for (const r of rects) {
    const key = `${r.x}:${r.w}`;
    const o = open.get(key);
    if (o && o.y + o.h === r.y) { o.h++; continue; }
    const n = { ...r };
    open.set(key, n);
    out.push(n);
  }
  return out;
}

/** The X cursor font glyph (even index of XC_* shapes) → CSS cursor. */
export function cursorFontCss(glyph: number): string {
  const map: Record<number, string> = {
    0: 'default', 2: 'default', 4: 'default', 6: 'nw-resize', 8: 'n-resize', 12: 'nw-resize', 14: 'nw-resize', 16: 's-resize',
    18: 'sw-resize', 20: 'sw-resize', 22: 'cell', 24: 'crosshair', 26: 'progress', 30: 'crosshair', 32: 'crosshair', 34: 'crosshair',
    38: 'pointer', 40: 'move', 42: 'crosshair', 44: 'default', 46: 'default', 48: 'default', 50: 'move', 52: 'move', 56: 'pointer',
    58: 'pointer', 60: 'pointer', 64: 'default', 66: 'default', 68: 'default', 70: 'w-resize', 72: 'default', 74: 'ew-resize',
    76: 'nw-resize', 78: 'not-allowed', 80: 'default', 86: 'crosshair', 88: 'not-allowed', 90: 'help', 92: 'help', 94: 'help',
    96: 'e-resize', 98: 'default', 100: 'default', 106: 'ew-resize', 108: 'ew-resize', 110: 'w-resize', 112: 'n-resize',
    114: 'e-resize', 116: 'ns-resize', 118: 'n-resize', 120: 'nesw-resize', 122: 'ne-resize', 124: 'nwse-resize',
    126: 'move', 128: 'crosshair', 130: 'crosshair', 132: 'move', 134: 'ne-resize', 136: 'ne-resize', 138: 'n-resize',
    140: 'nwse-resize', 142: 'default', 144: 'default', 146: 'default', 148: 'default', 150: 'wait', 152: 'text',
  };
  return map[glyph & ~1] ?? 'default';
}
