/**
 * Rootless display: every top-level X window becomes a desktop canvas
 * window (src/gui/window-host.ts). Damage is composed (compose.ts) into an
 * ImageData and blitted on the next animation frame; pointer, wheel and
 * keyboard events on the canvas become X input; title, size hints, close
 * (WM_DELETE_WINDOW), moves and resizes go back and forth like a window
 * manager would do them.
 */
import type { XServer, XWindow, XCursor } from './server';
import type { CanvasWindow, GuiInputEvent, WindowHost } from '../gui/window-host';
import { composeTop } from './compose';
import { isModifierCode, keysymForChar } from './keymap';
import { ClientMessage } from './proto';
import type { Rect } from './raster';

interface Top {
  win: XWindow;
  cw: CanvasWindow | null;
  img: ImageData | null;
  dirty: Rect | null;
  frame: number;
  hints: SizeHints;
  cleanup: (() => void)[];
}

interface SizeHints {
  flags: number; minW: number; minH: number; maxW: number; maxH: number;
  incW: number; incH: number; baseW: number; baseH: number;
}

const raf: (cb: () => void) => number = typeof requestAnimationFrame === 'function'
  ? (cb) => requestAnimationFrame(cb)
  : (cb) => setTimeout(cb, 16) as unknown as number;

export class Rootless {
  private tops = new Map<XWindow, Top>();
  /** Keys held down, so a blur can release them. */
  private held = new Set<number>();
  onTitle: ((w: XWindow, title: string) => void) | null = null;

  constructor(readonly server: XServer, readonly host: WindowHost) {
    server.hooks = {
      topMapped: (w) => this.mapped(w),
      topUnmapped: (w) => this.unmapped(w),
      topDestroyed: (w) => this.destroyed(w),
      topConfigured: (w) => this.configured(w),
      topProperty: (w, atom) => this.property(w, atom),
      damage: (w, x, y, ww, hh) => this.damage(w, { x, y, w: ww, h: hh }),
      cursor: (w, c) => this.tops.get(w)?.cw?.setCursor(cursorCss(c)),
      bell: () => { /* no audio bell; a desktop could flash */ },
    };
  }

  /** Toplevels currently shown, for status (`xserver` command) and tests. */
  windows(): { id: number; title: string; x: number; y: number; width: number; height: number; mapped: boolean }[] {
    return [...this.tops.values()].map((t) => ({ id: t.win.id, title: this.title(t.win), x: t.win.x, y: t.win.y, width: t.win.width, height: t.win.height, mapped: t.win.mapped }));
  }

  title(w: XWindow): string {
    const net = this.server.prop(w, '_NET_WM_NAME');
    if (net) return new TextDecoder().decode(net.data);
    const p = this.server.prop(w, 'WM_NAME');
    if (!p) return '';
    let s = '';
    for (const b of p.data) s += String.fromCharCode(b);
    return s;
  }

  private sizeHints(w: XWindow): SizeHints {
    const h: SizeHints = { flags: 0, minW: 0, minH: 0, maxW: 0, maxH: 0, incW: 1, incH: 1, baseW: 0, baseH: 0 };
    const p = this.server.prop(w, 'WM_NORMAL_HINTS');
    if (!p || p.data.length < 72) return h;
    const dv = new DataView(p.data.buffer, p.data.byteOffset, p.data.byteLength);
    const v = (i: number) => dv.getInt32(i * 4, true);
    h.flags = v(0);
    if (h.flags & 16) { h.minW = v(5); h.minH = v(6); }
    if (h.flags & 32) { h.maxW = v(7); h.maxH = v(8); }
    if (h.flags & 64) { h.incW = Math.max(1, v(9)); h.incH = Math.max(1, v(10)); }
    if (h.flags & 256 && p.data.length >= 72) { h.baseW = v(15); h.baseH = v(16); }
    return h;
  }

  private undecorated(w: XWindow): boolean {
    if (w.overrideRedirect) return true;
    const motif = this.server.prop(w, '_MOTIF_WM_HINTS');
    if (motif && motif.data.length >= 12) {
      const dv = new DataView(motif.data.buffer, motif.data.byteOffset, motif.data.byteLength);
      if ((dv.getUint32(0, true) & 2) && dv.getUint32(8, true) === 0) return true;
    }
    const type = this.server.prop(w, '_NET_WM_WINDOW_TYPE');
    if (type && type.data.length >= 4) {
      const name = this.server.atomName(new DataView(type.data.buffer, type.data.byteOffset).getUint32(0, true)) ?? '';
      if (/_(MENU|DROPDOWN_MENU|POPUP_MENU|TOOLTIP|NOTIFICATION|COMBO|DND|SPLASH)$/.test(name)) return true;
    }
    return false;
  }

  private mapped(w: XWindow): void {
    if (this.tops.get(w)?.cw) return;
    const hints = this.sizeHints(w);
    const t: Top = { win: w, cw: null, img: null, dirty: null, frame: 0, hints, cleanup: [] };
    this.tops.set(w, t);
    const decorated = !this.undecorated(w);
    let x = w.x, y = w.y;
    if (decorated) {
      const userPos = (hints.flags & 1) || ((hints.flags & 4) && (x || y));
      const transient = this.transientFor(w);
      if (transient) {
        x = Math.round(transient.x + (transient.width - w.width) / 2);
        y = Math.round(transient.y + (transient.height - w.height) / 3);
      } else if (!userPos) {
        const p = this.host.placeWindow?.(w.width, w.height) ?? { x: 80, y: 80 };
        x = p.x; y = p.y;
      }
      if (x !== w.x || y !== w.y) this.server.hostMoved(w, x, y);
    }
    const cw = this.host.createCanvasWindow({
      title: this.title(w) || 'X11', x, y, width: w.width, height: w.height, decorated, override: w.overrideRedirect,
      transientFor: this.transientFor(w) ? this.tops.get(this.transientFor(w)!)?.cw ?? null : null,
      minWidth: hints.minW || undefined, minHeight: hints.minH || undefined,
      resizable: !(hints.maxW && hints.maxW === hints.minW && hints.maxH === hints.minH),
      appId: this.wmClass(w),
    });
    t.cw = cw;
    // The host may have placed or clamped the window: tell the client where it is
    const pos = cw.position();
    if (pos.x !== w.x || pos.y !== w.y) this.server.hostMoved(w, pos.x, pos.y);
    cw.onInput((e) => this.input(t, e));
    cw.on('close', () => this.requestClose(w));
    cw.on('move', (nx, ny) => this.server.hostMoved(w, nx, ny));
    cw.on('resize', (nw, nh) => this.hostResize(t, nw, nh));
    cw.on('focus', () => this.focusIn(w));
    cw.on('blur', () => this.focusOut(w));
    cw.show();
    if (decorated) cw.activate();
    this.damage(w, { x: 0, y: 0, w: w.width, h: w.height });
  }

  /** Unmapped toplevels lose their desktop window; mapping again makes a new one. */
  private unmapped(w: XWindow): void {
    const t = this.tops.get(w);
    if (!t) return;
    for (const f of t.cleanup) f();
    t.cw?.destroy();
    this.tops.delete(w);
  }

  private transientFor(w: XWindow): XWindow | null {
    const p = this.server.prop(w, 'WM_TRANSIENT_FOR');
    if (!p || p.data.length < 4) return null;
    const id = new DataView(p.data.buffer, p.data.byteOffset).getUint32(0, true);
    const tw = this.server.winOrNull(id);
    return tw && tw.parent === this.server.root ? tw : null;
  }

  private wmClass(w: XWindow): string | undefined {
    const p = this.server.prop(w, 'WM_CLASS');
    if (!p) return undefined;
    // the instance name (argv[0] of most apps: "xterm", "l3afpad") is the desktop app id
    const parts = new TextDecoder('latin1').decode(p.data).split('\0');
    return (parts[0] || parts[1] || '').toLowerCase() || undefined;
  }

  private destroyed(w: XWindow): void {
    const t = this.tops.get(w);
    if (!t) return;
    for (const f of t.cleanup) f();
    t.cw?.destroy();
    this.tops.delete(w);
  }

  private configured(w: XWindow): void {
    const t = this.tops.get(w);
    if (!t?.cw) return;
    t.cw.setGeometry({ x: w.x, y: w.y, width: w.width, height: w.height }, this.inHostResize);
    if (t.img && (t.img.width !== w.width || t.img.height !== w.height)) t.img = null;
  }

  private property(w: XWindow, atom: string): void {
    const t = this.tops.get(w);
    if (atom === 'WM_NAME' || atom === '_NET_WM_NAME') {
      const title = this.title(w);
      t?.cw?.setTitle(title);
      this.onTitle?.(w, title);
    }
    if (atom === 'WM_NORMAL_HINTS' && t) t.hints = this.sizeHints(w);
  }

  private damage(w: XWindow, r: Rect): void {
    const t = this.tops.get(w);
    if (!t?.cw || !w.mapped) return;
    t.dirty = t.dirty ? union(t.dirty, r) : r;
    if (!t.frame) t.frame = raf(() => this.flush(t));
  }

  /** Compose and blit the dirty area now (also used by tests and screenshots). */
  flush(t: Top): void {
    t.frame = 0;
    const w = t.win;
    if (!t.cw || !t.dirty || !w.mapped || w.destroyed) return;
    const r = t.dirty;
    t.dirty = null;
    if (!t.img || t.img.width !== w.width || t.img.height !== w.height) {
      t.img = new ImageData(w.width, w.height);
      r.x = 0; r.y = 0; r.w = w.width; r.h = w.height;
    }
    composeTop(w, t.img, r);
    t.cw.present(t.img, 0, 0, r);
  }

  /** Flush every pending frame synchronously. */
  flushAll(): void { for (const t of this.tops.values()) if (t.dirty) this.flush(t); }

  private inHostResize = false;

  private hostResize(t: Top, w: number, h: number): void {
    const hi = t.hints;
    if (hi.incW > 1) w = hi.baseW + Math.max(0, Math.round((w - hi.baseW) / hi.incW)) * hi.incW;
    if (hi.incH > 1) h = hi.baseH + Math.max(0, Math.round((h - hi.baseH) / hi.incH)) * hi.incH;
    if (hi.minW) w = Math.max(w, hi.minW);
    if (hi.minH) h = Math.max(h, hi.minH);
    if (hi.maxW) w = Math.min(w, hi.maxW);
    if (hi.maxH) h = Math.min(h, hi.maxH);
    if (w === t.win.width && h === t.win.height) return;
    this.inHostResize = true;
    try { this.server.configure(t.win, { width: w, height: h }); } finally { this.inHostResize = false; }
  }

  private requestClose(w: XWindow): void {
    const protocols = this.server.prop(w, 'WM_PROTOCOLS');
    const del = this.server.existingAtom('WM_DELETE_WINDOW');
    if (protocols && del && hasAtom(protocols.data, del)) {
      this.clientMessage(w, this.server.atom('WM_PROTOCOLS'), [del, this.server.time()]);
      return;
    }
    if (w.owner) this.server.disconnect(w.owner);
  }

  clientMessage(w: XWindow, type: number, data: number[]): void {
    if (!w.owner || w.owner.closed) return;
    this.server.event(w.owner, (e) => {
      e.u8(ClientMessage).u8(32).u16(0).u32(w.id).u32(type);
      for (let i = 0; i < 5; i++) e.u32(data[i] ?? 0);
    });
  }

  private focusIn(w: XWindow): void {
    if (!w.mapped || w.destroyed) return;
    this.server.raiseTop(w);
    const hints = this.server.prop(w, 'WM_HINTS');
    let input = true;
    if (hints && hints.data.length >= 8) {
      const dv = new DataView(hints.data.buffer, hints.data.byteOffset, hints.data.byteLength);
      if (dv.getUint32(0, true) & 1) input = dv.getUint32(4, true) !== 0;
    }
    if (input && w.viewable()) this.server.setFocus(w, 1);
    const protocols = this.server.prop(w, 'WM_PROTOCOLS');
    const take = this.server.existingAtom('WM_TAKE_FOCUS');
    if (protocols && take && hasAtom(protocols.data, take)) this.clientMessage(w, this.server.atom('WM_PROTOCOLS'), [take, this.server.time()]);
  }

  private focusOut(w: XWindow): void {
    for (const kc of this.held) this.server.key(false, kc);
    this.held.clear();
    const f = this.server.focusWindow();
    if (f && (f === w || w.isAncestorOf(f))) this.server.setFocus(1, 1);
  }

  private wheelX = 0;
  private wheelY = 0;

  /** Input from the host window (normalized DOM events, content pixels). */
  private input(t: Top, e: GuiInputEvent): void {
    const s = this.server, w = t.win;
    const rootX = w.x + e.x, rootY = w.y + e.y;
    switch (e.type) {
      case 'pointermove': s.movePointer(rootX, rootY, w); break;
      case 'enter': s.movePointer(rootX, rootY, w); break;
      case 'pointerdown': s.movePointer(rootX, rootY, w); s.button(true, domButton(e.button)); break;
      case 'pointerup': s.movePointer(rootX, rootY, w); s.button(false, domButton(e.button)); break;
      case 'wheel': {
        // 40 px of scrolling per wheel click (X buttons 4/5, 6/7 horizontal)
        this.wheelY += e.deltaY / 40; this.wheelX += e.deltaX / 40;
        const clicks = (a: number) => (a > 0 ? Math.floor(a) : Math.ceil(a));
        for (let n = clicks(this.wheelY); n !== 0; n -= Math.sign(n)) { const b = n > 0 ? 5 : 4; s.button(true, b); s.button(false, b); }
        for (let n = clicks(this.wheelX); n !== 0; n -= Math.sign(n)) { const b = n > 0 ? 7 : 6; s.button(true, b); s.button(false, b); }
        this.wheelY -= clicks(this.wheelY); this.wheelX -= clicks(this.wheelX);
        break;
      }
      case 'keydown': this.keyEvent(true, e); break;
      case 'keyup': this.keyEvent(false, e); break;
      case 'focus': this.focusIn(w); break;
      case 'blur': this.focusOut(w); break;
    }
  }

  /** Map a key event: by physical code when the US layout agrees with e.key, else by character. */
  keyEvent(down: boolean, e: { code: string; key: string; repeat?: boolean }): void {
    const s = this.server;
    let kc = s.keymap.keycodeForCode(e.code);
    if (e.key.length === 1 || [...e.key].length === 1) {
      const [plain, shifted] = kc ? s.keymap.keysyms(kc) : [0, 0];
      const sym = keysymForChar(e.key);
      if (!kc || (sym !== plain && sym !== shifted)) {
        if (!down) return; // the press sent press+release
        const k = s.keymap.keycodeForChar(e.key);
        if (k.remapped) s.mappingNotify(1, k.keycode, 1);
        this.tap(k.keycode, k.shift);
        return;
      }
      // The character needs Shift but no Shift is down (synthetic input, some
      // on-screen keyboards): press it around this key
      if (sym === shifted && sym !== plain && !(s.mods & 1)) {
        if (down) this.tap(kc, true);
        return;
      }
    }
    if (!kc) return;
    if (down) {
      if (e.repeat && this.held.has(kc) && !isModifierCode(e.code)) s.key(false, kc);
      this.held.add(kc);
    } else this.held.delete(kc);
    s.key(down, kc);
  }

  /** Press and release a keycode, with Shift around it when needed and not held. */
  private tap(kc: number, shift: boolean): void {
    const s = this.server;
    const wrap = shift && !(s.mods & 1);
    if (wrap) s.key(true, 50);
    s.key(true, kc);
    s.key(false, kc);
    if (wrap) s.key(false, 50);
  }

  /** Type text (paste) as key events. */
  typeText(text: string): void {
    const s = this.server;
    for (const ch of text.replace(/\r\n/g, '\n')) {
      const k = s.keymap.keycodeForChar(ch);
      if (k.remapped) s.mappingNotify(1, k.keycode, 1);
      const needShift = k.shift && !(s.mods & 1);
      if (needShift) s.key(true, 50);
      s.key(true, k.keycode); s.key(false, k.keycode);
      if (needShift) s.key(false, 50);
    }
  }
}

function domButton(b: number): number {
  return b === 0 ? 1 : b === 1 ? 2 : b === 2 ? 3 : b === 3 ? 8 : b === 4 ? 9 : 1;
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function hasAtom(data: Uint8Array, atom: number): boolean {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i + 4 <= data.length; i += 4) if (dv.getUint32(i, true) === atom) return true;
  return false;
}

const cursorUrls = new WeakMap<XCursor, string>();

function cursorCss(c: XCursor | null): string {
  if (!c) return 'default';
  if (!c.image) return c.css;
  let url = cursorUrls.get(c);
  if (!url && typeof document !== 'undefined') {
    const cv = document.createElement('canvas');
    cv.width = c.image.width; cv.height = c.image.height;
    const ctx = cv.getContext('2d');
    if (ctx) {
      ctx.putImageData(new ImageData(new Uint8ClampedArray(c.image.rgba), c.image.width, c.image.height), 0, 0);
      url = `url(${cv.toDataURL()}) ${c.image.xhot} ${c.image.yhot}, ${c.css || 'default'}`;
      cursorUrls.set(c, url);
    }
  }
  return url ?? c.css;
}
