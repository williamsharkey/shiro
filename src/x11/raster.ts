/**
 * Software rasterizer for the in-page X server. Every drawable (window or
 * pixmap) owns a `Pix`: a Uint32Array of X pixel values (0xRRGGBB for depth
 * 24, 0xAARRGGBB for 32, 0..255 for 8, 0/1 for 1). Core drawing requests
 * become horizontal spans clipped by the GC and filled with the GC's fill
 * style and raster function, following the X11 protocol's pixelization
 * rules closely enough for real clients (xterm, Xaw, Xt, cairo fallbacks).
 */
import { GXcopy, FillSolid, FillTiled, FillStippled, FillOpaqueStippled } from './proto';
import type { XFont, Glyph } from './fonts';

export interface Rect { x: number; y: number; w: number; h: number }

export class Pix {
  data: Uint32Array;
  /** Called with the changed area after each drawing operation. */
  onDamage: ((x: number, y: number, w: number, h: number) => void) | null = null;
  constructor(public width: number, public height: number, public depth: number) {
    this.data = new Uint32Array(Math.max(1, width * height));
  }
  get mask(): number { return depthMask(this.depth); }
  get(x: number, y: number): number { return this.data[y * this.width + x]; }
  /** Resize keeping the old contents at (dx, dy) (bit gravity). */
  resize(w: number, h: number, dx = 0, dy = 0, fill = 0): void {
    if (w === this.width && h === this.height && !dx && !dy) return;
    const old = this.data, ow = this.width, oh = this.height;
    const data = new Uint32Array(Math.max(1, w * h));
    if (fill) data.fill(fill);
    for (let y = 0; y < oh; y++) {
      const ty = y + dy;
      if (ty < 0 || ty >= h) continue;
      const x0 = Math.max(0, -dx), x1 = Math.min(ow, w - dx);
      if (x1 > x0) data.set(old.subarray(y * ow + x0, y * ow + x1), ty * w + x0 + dx);
    }
    this.data = data; this.width = w; this.height = h;
  }
  damage(x: number, y: number, w: number, h: number): void {
    if (!this.onDamage) return;
    const x0 = Math.max(0, x), y0 = Math.max(0, y);
    const x1 = Math.min(this.width, x + w), y1 = Math.min(this.height, y + h);
    if (x1 > x0 && y1 > y0) this.onDamage(x0, y0, x1 - x0, y1 - y0);
  }
}

export function depthMask(depth: number): number {
  return depth >= 32 ? 0xffffffff : depth === 24 ? 0xffffff : (1 << depth) - 1;
}

export interface GC {
  func: number;
  planeMask: number;
  fg: number;
  bg: number;
  lineWidth: number;
  lineStyle: number;   // 0 Solid, 1 OnOffDash, 2 DoubleDash
  capStyle: number;    // 0 NotLast, 1 Butt, 2 Round, 3 Projecting
  joinStyle: number;   // 0 Miter, 1 Round, 2 Bevel
  fillStyle: number;
  fillRule: number;    // 0 EvenOdd, 1 Winding
  tile: Pix | null;
  stipple: Pix | null;
  tsx: number; tsy: number;
  font: XFont | null;
  fontId: number;
  subwindowMode: number;
  graphicsExposures: boolean;
  clipX: number; clipY: number;
  clipRects: Rect[] | null;   // null = no clip list
  clipMask: Pix | null;
  dashOffset: number;
  dashes: number[];
  arcMode: number;     // 0 Chord, 1 PieSlice
}

export function defaultGC(): GC {
  return {
    func: GXcopy, planeMask: 0xffffffff, fg: 0, bg: 1, lineWidth: 0, lineStyle: 0, capStyle: 1,
    joinStyle: 0, fillStyle: FillSolid, fillRule: 0, tile: null, stipple: null, tsx: 0, tsy: 0,
    font: null, fontId: 0, subwindowMode: 0, graphicsExposures: true, clipX: 0, clipY: 0,
    clipRects: null, clipMask: null, dashOffset: 0, dashes: [4, 4], arcMode: 1,
  };
}

export function rop(f: number, s: number, d: number): number {
  switch (f) {
    case 0: return 0;
    case 1: return s & d;
    case 2: return s & ~d;
    case 3: return s;
    case 4: return ~s & d;
    case 5: return d;
    case 6: return s ^ d;
    case 7: return s | d;
    case 8: return ~(s | d);
    case 9: return ~s ^ d;
    case 10: return ~d;
    case 11: return s | ~d;
    case 12: return ~s;
    case 13: return ~s | d;
    case 14: return ~(s & d);
    default: return 0xffffffff;
  }
}

/**
 * Draws into one drawable with one GC: clipping, fill style and raster
 * function. Primitives call span(y, x0, x1) (x1 exclusive) or pixel paths.
 */
export class Painter {
  private clips: Rect[];
  private mask: number;
  private simple: boolean;
  /** bounding box of everything drawn, for damage */
  private bx0 = Infinity; private by0 = Infinity; private bx1 = -Infinity; private by1 = -Infinity;

  constructor(readonly dst: Pix, readonly gc: GC, ox = 0, oy = 0, extraClip?: Rect) {
    const bounds: Rect = { x: 0, y: 0, w: dst.width, h: dst.height };
    let clips = [extraClip ? intersect(bounds, extraClip) : bounds].filter(Boolean) as Rect[];
    if (gc.clipRects) {
      const out: Rect[] = [];
      for (const r of gc.clipRects) {
        const t = { x: r.x + gc.clipX + ox, y: r.y + gc.clipY + oy, w: r.w, h: r.h };
        for (const c of clips) { const i = intersect(c, t); if (i) out.push(i); }
      }
      clips = out;
    }
    this.clips = clips;
    this.mask = dst.mask;
    this.simple = gc.func === GXcopy && (gc.planeMask & this.mask) === this.mask;
  }

  private note(x0: number, y: number, x1: number): void {
    if (x0 < this.bx0) this.bx0 = x0;
    if (x1 > this.bx1) this.bx1 = x1;
    if (y < this.by0) this.by0 = y;
    if (y + 1 > this.by1) this.by1 = y + 1;
  }

  /** Report damage for everything drawn so far. */
  finish(): void {
    if (this.bx1 > this.bx0) this.dst.damage(this.bx0, this.by0, this.bx1 - this.bx0, this.by1 - this.by0);
    this.bx0 = this.by0 = Infinity; this.bx1 = this.by1 = -Infinity;
  }

  private store(i: number, v: number): void {
    const d = this.dst.data;
    if (this.simple) { d[i] = v & this.mask; return; }
    const r = rop(this.gc.func, v, d[i]);
    const pm = this.gc.planeMask;
    d[i] = ((d[i] & ~pm) | (r & pm)) & this.mask;
  }

  private clipMaskAllows(x: number, y: number): boolean {
    const m = this.gc.clipMask!;
    const mx = x - this.gc.clipX, my = y - this.gc.clipY;
    return mx >= 0 && my >= 0 && mx < m.width && my < m.height && (m.data[my * m.width + mx] & 1) !== 0;
  }

  /** Fill [x0, x1) on row y with the GC's fill style (or with `src` per pixel when given). */
  span(y: number, x0: number, x1: number, fillStyle = this.gc.fillStyle): void {
    for (const c of this.clips) {
      if (y < c.y || y >= c.y + c.h) continue;
      const a = Math.max(x0, c.x), b = Math.min(x1, c.x + c.w);
      if (b <= a) continue;
      this.note(a, y, b);
      this.rawSpan(y, a, b, fillStyle);
    }
  }

  private rawSpan(y: number, a: number, b: number, fillStyle: number): void {
    const gc = this.gc, d = this.dst.data, row = y * this.dst.width;
    const cm = gc.clipMask;
    if (fillStyle === FillSolid || (fillStyle === FillTiled && !gc.tile) || ((fillStyle === FillStippled || fillStyle === FillOpaqueStippled) && !gc.stipple)) {
      if (this.simple && !cm) { d.fill(gc.fg & this.mask, row + a, row + b); return; }
      for (let x = a; x < b; x++) if (!cm || this.clipMaskAllows(x, y)) this.store(row + x, gc.fg);
      return;
    }
    if (fillStyle === FillTiled) {
      const t = gc.tile!;
      const ty = mod(y - gc.tsy, t.height) * t.width;
      for (let x = a; x < b; x++) {
        if (cm && !this.clipMaskAllows(x, y)) continue;
        this.store(row + x, t.data[ty + mod(x - gc.tsx, t.width)]);
      }
      return;
    }
    const s = gc.stipple!;
    const sy = mod(y - gc.tsy, s.height) * s.width;
    for (let x = a; x < b; x++) {
      if (cm && !this.clipMaskAllows(x, y)) continue;
      const bit = s.data[sy + mod(x - gc.tsx, s.width)] & 1;
      if (bit) this.store(row + x, gc.fg);
      else if (fillStyle === FillOpaqueStippled) this.store(row + x, gc.bg);
    }
  }

  /** One pixel with an explicit source value (images, text, copies). */
  pixel(x: number, y: number, v: number): void {
    if (!this.inClip(x, y)) return;
    if (this.gc.clipMask && !this.clipMaskAllows(x, y)) return;
    this.note(x, y, x + 1);
    this.store(y * this.dst.width + x, v);
  }

  inClip(x: number, y: number): boolean {
    for (const c of this.clips) if (x >= c.x && y >= c.y && x < c.x + c.w && y < c.y + c.h) return true;
    return false;
  }

  /**
   * Copy a w×h block whose source pixel at (sx, sy) relative to the block is
   * `src(sx, sy)`, to (dx, dy); `skip` pixels (stipple-like sources) return -1.
   */
  block(dx: number, dy: number, w: number, h: number, src: (sx: number, sy: number) => number): void {
    const cm = this.gc.clipMask;
    for (const c of this.clips) {
      const r = intersect(c, { x: dx, y: dy, w, h });
      if (!r) continue;
      this.note(r.x, r.y, r.x + r.w);
      this.note(r.x, r.y + r.h - 1, r.x + r.w);
      for (let y = r.y; y < r.y + r.h; y++) {
        const row = y * this.dst.width;
        for (let x = r.x; x < r.x + r.w; x++) {
          if (cm && !this.clipMaskAllows(x, y)) continue;
          const v = src(x - dx, y - dy);
          if (v !== -1) this.store(row + x, v);
        }
      }
    }
  }

  /** Fast copy of rows from a Uint32Array (GXcopy, no clip mask), else per pixel. */
  copyRows(dx: number, dy: number, w: number, h: number, src: Uint32Array, srcStride: number, srcOff: number): void {
    if (!this.simple || this.gc.clipMask) {
      this.block(dx, dy, w, h, (sx, sy) => src[srcOff + sy * srcStride + sx]);
      return;
    }
    const d = this.dst.data, m = this.mask;
    for (const c of this.clips) {
      const r = intersect(c, { x: dx, y: dy, w, h });
      if (!r) continue;
      this.note(r.x, r.y, r.x + r.w);
      this.note(r.x, r.y + r.h - 1, r.x + r.w);
      for (let y = r.y; y < r.y + r.h; y++) {
        const so = srcOff + (y - dy) * srcStride + (r.x - dx);
        const doff = y * this.dst.width + r.x;
        if (m === 0xffffffff) d.set(src.subarray(so, so + r.w), doff);
        else for (let i = 0; i < r.w; i++) d[doff + i] = src[so + i] & m;
      }
    }
  }

  // ── primitives ──

  fillRect(x: number, y: number, w: number, h: number): void {
    for (let j = y; j < y + h; j++) this.span(j, x, x + w);
  }

  /** Zero-width line (Bresenham), both ends drawn unless notLast. */
  thinLine(x0: number, y0: number, x1: number, y1: number, notLast = false, dash?: DashState): void {
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy, x = x0, y = y0;
    for (;;) {
      const last = x === x1 && y === y1;
      if (!(last && notLast)) this.dashPixel(x, y, dash);
      if (last) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
  }

  private dashPixel(x: number, y: number, dash?: DashState): void {
    if (!dash) { this.span(y, x, x + 1); return; }
    const on = dash.on();
    dash.step();
    if (on) this.span(y, x, x + 1, this.gc.fillStyle);
    else if (this.gc.lineStyle === 2) { const fg = this.gc.fg; this.gc.fg = this.gc.bg; this.span(y, x, x + 1, FillSolid); this.gc.fg = fg; }
  }

  /** Polyline in absolute points with the GC's line attributes. */
  polyline(pts: number[], closed = false): void {
    const gc = this.gc;
    const n = pts.length / 2;
    if (n === 0) return;
    if (gc.lineWidth <= 1) {
      const dash = gc.lineStyle ? new DashState(gc.dashes, gc.dashOffset) : undefined;
      if (n === 1) { this.span(pts[1], pts[0], pts[0] + 1); return; }
      for (let i = 0; i < n - 1; i++) {
        const lastSeg = i === n - 2;
        // interior joints are drawn once; the final point follows cap NotLast
        this.thinLine(pts[2 * i], pts[2 * i + 1], pts[2 * i + 2], pts[2 * i + 3], !lastSeg || gc.capStyle === 0 || closed, dash);
      }
      return;
    }
    const hw = gc.lineWidth / 2;
    for (let i = 0; i < n - 1; i++) {
      const x0 = pts[2 * i], y0 = pts[2 * i + 1], x1 = pts[2 * i + 2], y1 = pts[2 * i + 3];
      const first = i === 0 && !closed, last = i === n - 2 && !closed;
      this.wideSegment(x0, y0, x1, y1, hw, first ? gc.capStyle : 1, last ? gc.capStyle : 1);
      if (i > 0 || closed) this.joint(x0, y0, hw);
    }
  }

  private joint(x: number, y: number, hw: number): void {
    if (this.gc.joinStyle === 2) return;
    this.fillPolygon(circlePoints(x, y, hw, hw), 1);
  }

  wideSegment(x0: number, y0: number, x1: number, y1: number, hw: number, cap0: number, cap1: number): void {
    let dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len === 0) {
      if (cap0 === 2) this.fillPolygon(circlePoints(x0, y0, hw, hw), 1);
      else if (cap0 === 3) this.fillPolygonF([x0 - hw, y0 - hw, x0 + hw, y0 - hw, x0 + hw, y0 + hw, x0 - hw, y0 + hw], 1);
      return;
    }
    dx /= len; dy /= len;
    const nx = -dy * hw, ny = dx * hw;
    const e0 = cap0 === 3 ? hw : 0, e1 = cap1 === 3 ? hw : 0;
    const ax = x0 - dx * e0, ay = y0 - dy * e0, bx = x1 + dx * e1, by = y1 + dy * e1;
    this.fillPolygonF([ax + nx, ay + ny, bx + nx, by + ny, bx - nx, by - ny, ax - nx, ay - ny], 1);
    if (cap0 === 2) this.fillPolygon(circlePoints(x0, y0, hw, hw), 1);
    if (cap1 === 2) this.fillPolygon(circlePoints(x1, y1, hw, hw), 1);
  }

  /** Fill a polygon of integer or fractional points (pixel centers sampled at +0.5). */
  fillPolygon(pts: number[], rule = this.gc.fillRule): void { this.fillPolygonF(pts, rule); }

  fillPolygonF(pts: number[], rule: number): void {
    const n = pts.length / 2;
    if (n < 3) return;
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) { minY = Math.min(minY, pts[2 * i + 1]); maxY = Math.max(maxY, pts[2 * i + 1]); }
    const y0 = Math.max(Math.ceil(minY - 0.5), 0), y1 = Math.min(Math.ceil(maxY - 0.5), this.dst.height);
    const xs: { x: number; w: number }[] = [];
    for (let y = y0; y < y1; y++) {
      const yc = y + 0.5;
      xs.length = 0;
      for (let i = 0; i < n; i++) {
        const ax = pts[2 * i], ay = pts[2 * i + 1];
        const j = (i + 1) % n;
        const bx = pts[2 * j], by = pts[2 * j + 1];
        if (ay === by) continue;
        const up = ay < by;
        const lo = up ? ay : by, hi = up ? by : ay;
        if (yc < lo || yc >= hi) continue;
        xs.push({ x: ax + (yc - ay) * (bx - ax) / (by - ay), w: up ? 1 : -1 });
      }
      xs.sort((a, b) => a.x - b.x);
      if (rule === 0) {
        for (let k = 0; k + 1 < xs.length; k += 2) this.span(y, Math.ceil(xs[k].x - 0.5), Math.ceil(xs[k + 1].x - 0.5));
      } else {
        let wind = 0;
        for (let k = 0; k < xs.length - 1; k++) {
          wind += xs[k].w;
          if (wind !== 0) this.span(y, Math.ceil(xs[k].x - 0.5), Math.ceil(xs[k + 1].x - 0.5));
        }
      }
    }
  }

  /** PolyArc / PolyFillArc. Angles in 1/64 degree, counterclockwise from 3 o'clock. */
  arc(x: number, y: number, w: number, h: number, a1: number, a2: number, fill: boolean): void {
    const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
    const full = Math.abs(a2) >= 360 * 64;
    const start = (a1 / 64) * Math.PI / 180;
    const extent = Math.max(-2 * Math.PI, Math.min(2 * Math.PI, (a2 / 64) * Math.PI / 180));
    const steps = Math.max(8, Math.ceil(Math.abs(extent) * Math.max(rx, ry) / 2));
    const pts: number[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = start + extent * i / steps;
      pts.push(cx + rx * Math.cos(t), cy - ry * Math.sin(t));
    }
    if (fill) {
      if (w === 0 || h === 0) return;
      if (!full && this.gc.arcMode === 1) pts.push(cx, cy);
      this.fillPolygonF(pts, 1);
      return;
    }
    if (this.gc.lineWidth <= 1) {
      const ip = pts.map((v, i) => Math.round(i % 2 === 0 ? v - 0.5 : v - 0.5));
      this.polyline(ip, full);
    } else {
      const hw = this.gc.lineWidth / 2;
      for (let i = 0; i + 3 < pts.length; i += 2) this.wideSegment(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], hw, 1, 1);
    }
  }

  /** Draw text glyphs at baseline (x, y); `image` = ImageText (background box in bg). */
  text(font: XFont, codes: ArrayLike<number>, x: number, y: number, image: boolean): number {
    const gc = this.gc;
    if (image) {
      let width = 0;
      for (let i = 0; i < codes.length; i++) width += (font.glyph(codes[i]) ?? font.glyph(font.defaultChar))?.width ?? 0;
      const fg = gc.fg, func = gc.func;
      gc.fg = gc.bg; gc.func = GXcopy;
      this.simple = (gc.planeMask & this.mask) === this.mask;
      this.fillRectSolid(x, y - font.ascent, width, font.ascent + font.descent);
      gc.fg = fg;
      for (let i = 0; i < codes.length; i++) x += this.glyph(font.glyph(codes[i]) ?? font.glyph(font.defaultChar), x, y, true);
      gc.func = func;
      this.simple = gc.func === GXcopy && (gc.planeMask & this.mask) === this.mask;
      return x;
    }
    for (let i = 0; i < codes.length; i++) x += this.glyph(font.glyph(codes[i]) ?? font.glyph(font.defaultChar), x, y, false);
    return x;
  }

  private fillRectSolid(x: number, y: number, w: number, h: number): void {
    for (let j = y; j < y + h; j++) this.span(j, x, x + w, FillSolid);
  }

  private glyph(g: Glyph | undefined, x: number, y: number, solid: boolean): number {
    if (!g) return 0;
    const gw = g.rsb - g.lsb, gh = g.ascent + g.descent, stride = (gw + 7) >> 3;
    const ox = x + g.lsb, oy = y - g.ascent;
    for (let r = 0; r < gh; r++) {
      const py = oy + r;
      if (py < 0 || py >= this.dst.height) continue;
      for (let c = 0; c < gw; c++) {
        if (!((g.bits[r * stride + (c >> 3)] >> (7 - (c & 7))) & 1)) continue;
        const px = ox + c;
        if (solid || this.gc.fillStyle === FillSolid) this.pixel(px, py, this.gc.fg);
        else this.span(py, px, px + 1);
      }
    }
    return g.width;
  }
}

/** Dash pattern walker for thin lines. */
export class DashState {
  private i = 0;
  private left: number;
  constructor(private dashes: number[], offset: number) {
    const total = dashes.reduce((a, b) => a + b, 0) || 1;
    let off = offset % total;
    this.left = dashes[0] || 1;
    while (off > 0) { const t = Math.min(off, this.left); off -= t; this.left -= t; if (!this.left) this.advance(); }
  }
  private advance() { this.i = (this.i + 1) % this.dashes.length; this.left = this.dashes[this.i] || 1; }
  on() { return this.i % 2 === 0; }
  step() { if (--this.left <= 0) this.advance(); }
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 > x && y1 > y ? { x, y, w: x1 - x, h: y1 - y } : null;
}

function mod(a: number, n: number): number { const r = a % n; return r < 0 ? r + n : r; }

function circlePoints(cx: number, cy: number, rx: number, ry: number): number[] {
  const steps = Math.max(8, Math.ceil(Math.max(rx, ry) * 2));
  const pts: number[] = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    pts.push(cx + rx * Math.cos(t), cy + ry * Math.sin(t));
  }
  return pts;
}

// ── images ──

/** Bytes per row for an image of `bpp` bits with 32-bit scanline padding. */
export function imageStride(width: number, bpp: number): number {
  return (((width * bpp) + 31) >> 5) << 2;
}

/** Bits per pixel of ZPixmap images for a depth (the server's pixmap formats). */
export function bppForDepth(depth: number): number {
  return depth === 1 ? 1 : depth <= 8 ? 8 : depth <= 16 ? 16 : 32;
}

/** Read a ZPixmap image (LSBFirst) into a function of (x, y) → pixel. */
export function zImageReader(data: Uint8Array, width: number, depth: number, leftPad = 0): (x: number, y: number) => number {
  const bpp = bppForDepth(depth);
  const stride = imageStride(width + leftPad, bpp);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const mask = depthMask(depth);
  switch (bpp) {
    case 1: return (x, y) => { const b = x + leftPad; return (data[y * stride + (b >> 3)] >> (b & 7)) & 1; };
    case 8: return (x, y) => data[y * stride + x];
    case 16: return (x, y) => dv.getUint16(y * stride + x * 2, true);
    default: return (x, y) => dv.getUint32(y * stride + x * 4, true) & mask;
  }
}

/** Encode a region of a Pix as a ZPixmap image (LSBFirst, pad 32). */
export function encodeZImage(src: Pix, x: number, y: number, w: number, h: number, planeMask = 0xffffffff): Uint8Array {
  const bpp = bppForDepth(src.depth);
  const stride = imageStride(w, bpp);
  const out = new Uint8Array(stride * h);
  const dv = new DataView(out.buffer);
  for (let j = 0; j < h; j++) {
    const sy = y + j;
    if (sy < 0 || sy >= src.height) continue;
    for (let i = 0; i < w; i++) {
      const sx = x + i;
      if (sx < 0 || sx >= src.width) continue;
      const v = src.data[sy * src.width + sx] & planeMask;
      switch (bpp) {
        case 1: if (v & 1) out[j * stride + (i >> 3)] |= 1 << (i & 7); break;
        case 8: out[j * stride + i] = v; break;
        case 16: dv.setUint16(j * stride + i * 2, v, true); break;
        default: dv.setUint32(j * stride + i * 4, v, true);
      }
    }
  }
  return out;
}

/** Encode a region as an XYPixmap (one bitmap per plane, most significant plane first). */
export function encodeXYImage(src: Pix, x: number, y: number, w: number, h: number, planeMask: number): Uint8Array {
  const stride = imageStride(w, 1);
  const planes: number[] = [];
  for (let p = src.depth - 1; p >= 0; p--) if (planeMask & (1 << p)) planes.push(p);
  const out = new Uint8Array(stride * h * planes.length);
  planes.forEach((p, k) => {
    const base = k * stride * h;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const sx = x + i, sy = y + j;
      if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) continue;
      if ((src.data[sy * src.width + sx] >> p) & 1) out[base + j * stride + (i >> 3)] |= 1 << (i & 7);
    }
  });
  return out;
}
