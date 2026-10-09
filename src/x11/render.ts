/**
 * RENDER extension (0.11) for the in-page X server, in software: picture
 * formats a8r8g8b8 / x8r8g8b8 / a8 / a1 / r5g6b5, pictures on drawables
 * with repeat, transforms, nearest/bilinear filters and clips, the
 * Porter-Duff operators (blend modes fall back to Over), solid and
 * gradient sources, glyph sets (Xft, cairo, Qt text), antialiased
 * trapezoids/triangles (cairo paths) and ARGB cursors.
 *
 * Internally colors are premultiplied ARGB packed in a u32 (a<<24|r<<16|g<<8|b).
 */
import type { XServer, Client, XCursor } from './server';
import { Pix, intersect, type Rect } from './raster';
import { Reader, BadMatch, BadRequest } from './proto';
import { XError } from './server';

const BadPictFormat = 0, BadPicture = 1, BadPictOp = 2, BadGlyphSet = 3, BadGlyph = 4;

interface Format { id: number; depth: number; type: 'argb' | 'xrgb' | 'a8' | 'a1' | 'rgb565' }

const FORMATS: Format[] = [
  { id: 0x30, depth: 32, type: 'argb' },
  { id: 0x31, depth: 24, type: 'xrgb' },
  { id: 0x32, depth: 8, type: 'a8' },
  { id: 0x33, depth: 1, type: 'a1' },
  { id: 0x34, depth: 16, type: 'rgb565' },
];
const FORMAT_BY_ID = new Map(FORMATS.map((f) => [f.id, f]));
const VISUAL_FORMAT: Record<number, number> = { 0x21: 0x31, 0x22: 0x30 };

interface Gradient {
  kind: 'linear' | 'radial' | 'conical';
  p: number[];              // linear: x1 y1 x2 y2; radial: cx1 cy1 cx2 cy2 r1 r2; conical: cx cy angle
  stops: number[];          // 0..1
  colors: number[];         // premultiplied ARGB
  lut?: Uint32Array;
}

interface Picture {
  id: number;
  pix: Pix | null;          // null for solid/gradient sources
  format: Format | null;
  solid: number | null;     // premultiplied
  gradient: Gradient | null;
  repeat: number;           // 0 none, 1 normal, 2 pad, 3 reflect
  clipX: number; clipY: number;
  clipRects: Rect[] | null;
  transform: number[] | null; // 3x3 row-major, doubles (dst → src)
  filter: 'nearest' | 'bilinear';
  componentAlpha: boolean;
  alphaMap: Picture | null;
}

interface GlyphImg { w: number; h: number; x: number; y: number; xOff: number; yOff: number; a: Uint8Array | null; argb: Uint32Array | null }
interface GlyphSet { format: Format; glyphs: Map<number, GlyphImg>; refs: number }

// ── pixel conversion ──

function toARGB(v: number, f: Format): number {
  switch (f.type) {
    case 'argb': return v >>> 0;
    case 'xrgb': return (v | 0xff000000) >>> 0;
    case 'a8': return ((v & 0xff) << 24) >>> 0;
    case 'a1': return v & 1 ? 0xff000000 : 0;
    case 'rgb565': {
      const r = (v >> 11) & 31, g = (v >> 5) & 63, b = v & 31;
      return (0xff000000 | (((r << 3) | (r >> 2)) << 16) | (((g << 2) | (g >> 4)) << 8) | ((b << 3) | (b >> 2))) >>> 0;
    }
  }
}

function fromARGB(c: number, f: Format): number {
  switch (f.type) {
    case 'argb': return c >>> 0;
    case 'xrgb': return c & 0xffffff;
    case 'a8': return c >>> 24;
    case 'a1': return (c >>> 24) >= 0x80 ? 1 : 0;
    case 'rgb565': return (((c >> 19) & 31) << 11) | (((c >> 10) & 63) << 5) | ((c >> 3) & 31);
  }
}

const mul8 = (a: number, b: number) => { const t = a * b + 128; return ((t >> 8) + t) >> 8; };

/** Solid colors in requests are premultiplied already. */
function color16(r: number, g: number, b: number, a: number): number {
  return (((a >> 8) << 24) | ((r >> 8) << 16) | ((g >> 8) << 8) | (b >> 8)) >>> 0;
}

/** Gradient stop colors are not premultiplied (as in pixman). */
function stopColor(r: number, g: number, b: number, a: number): number {
  const A = a >> 8;
  return ((A << 24) | (mul8(r >> 8, A) << 16) | (mul8(g >> 8, A) << 8) | mul8(b >> 8, A)) >>> 0;
}

/** Porter-Duff on premultiplied ARGB: result = s*Fa + d*Fb. */
function pdFactors(op: number, sa: number, da: number): [number, number] {
  switch (op) {
    case 0: return [0, 0];
    case 1: return [255, 0];
    case 2: return [0, 255];
    case 3: return [255, 255 - sa];
    case 4: return [255 - da, 255];
    case 5: return [da, 0];
    case 6: return [0, sa];
    case 7: return [255 - da, 0];
    case 8: return [0, 255 - sa];
    case 9: return [da, 255 - sa];
    case 10: return [255 - da, sa];
    case 11: return [255 - da, 255 - sa];
    case 12: return [255, 255];
    default: return [255, 255 - sa];
  }
}

function combine(op: number, s: number, d: number): number {
  const sa = s >>> 24, da = d >>> 24;
  if (op === 3) { // Over, the common case
    if (sa === 255) return s >>> 0;
    if (sa === 0) return d >>> 0;
    const k = 255 - sa;
    return (((sa + mul8(da, k)) << 24) | ((((s >> 16) & 0xff) + mul8((d >> 16) & 0xff, k)) << 16) |
      ((((s >> 8) & 0xff) + mul8((d >> 8) & 0xff, k)) << 8) | ((s & 0xff) + mul8(d & 0xff, k))) >>> 0;
  }
  if (op === 1) return s >>> 0;
  if (op === 13) { // Saturate
    const fa = sa === 0 ? 255 : Math.min(255, Math.floor((255 - da) * 255 / sa));
    return addc(scale(s, fa), d);
  }
  if (op === 12) return addc(s, d);
  if (op >= 0x10 && op < 0x30) op = op & 0xf;  // disjoint/conjoint ≈ plain
  const [fa, fb] = pdFactors(op, sa, da);
  return addc(scale(s, fa), scale(d, fb));
}

function scale(c: number, f: number): number {
  if (f === 255) return c >>> 0;
  if (f === 0) return 0;
  return ((mul8(c >>> 24, f) << 24) | (mul8((c >> 16) & 0xff, f) << 16) | (mul8((c >> 8) & 0xff, f) << 8) | mul8(c & 0xff, f)) >>> 0;
}

function addc(a: number, b: number): number {
  const ch = (s: number) => Math.min(255, ((a >>> s) & 0xff) + ((b >>> s) & 0xff));
  return ((ch(24) << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)) >>> 0;
}

/** Component-wise multiply of a color by a mask (unified or component alpha). */
function inMask(s: number, m: number, component: boolean): number {
  if (!component) return scale(s, m >>> 24);
  return ((mul8(s >>> 24, m >>> 24) << 24) | (mul8((s >> 16) & 0xff, (m >> 16) & 0xff) << 16) |
    (mul8((s >> 8) & 0xff, (m >> 8) & 0xff) << 8) | mul8(s & 0xff, m & 0xff)) >>> 0;
}

/** Component-alpha Over: per channel d = s + d * (1 - sa*mc). */
function overCA(s: number, m: number, d: number): number {
  const sa = s >>> 24;
  const ch = (sh: number) => {
    const sc = mul8((s >>> sh) & 0xff, (m >>> sh) & 0xff);
    const ma = mul8(sa, (m >>> sh) & 0xff);
    return Math.min(255, sc + mul8((d >>> sh) & 0xff, 255 - ma));
  };
  const a = Math.min(255, mul8(sa, m >>> 24) + mul8(d >>> 24, 255 - mul8(sa, m >>> 24)));
  return ((a << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)) >>> 0;
}

// ── sampling ──

function reflect(v: number, n: number): number {
  const p = 2 * n;
  v = ((v % p) + p) % p;
  return v >= n ? p - 1 - v : v;
}

function wrap(v: number, n: number, repeat: number): number {
  switch (repeat) {
    case 1: return ((v % n) + n) % n;
    case 2: return v < 0 ? 0 : v >= n ? n - 1 : v;
    case 3: return reflect(v, n);
    default: return v;
  }
}

function gradientColor(g: Gradient, t: number, repeat: number): number {
  if (!g.lut) g.lut = buildLut(g);
  if (repeat === 1) t = t - Math.floor(t);
  else if (repeat === 3) { t = Math.abs(t) % 2; if (t > 1) t = 2 - t; }
  else if (repeat === 2) t = Math.max(0, Math.min(1, t));
  else if (t < 0 || t > 1) return 0;
  return g.lut[Math.min(1023, Math.max(0, Math.round(t * 1023)))];
}

function buildLut(g: Gradient): Uint32Array {
  const lut = new Uint32Array(1024);
  const { stops, colors } = g;
  for (let i = 0; i < 1024; i++) {
    const t = i / 1023;
    let k = 0;
    while (k < stops.length - 1 && stops[k + 1] < t) k++;
    if (t <= stops[0]) { lut[i] = colors[0]; continue; }
    if (k >= stops.length - 1) { lut[i] = colors[colors.length - 1]; continue; }
    const t0 = stops[k], t1 = stops[k + 1];
    const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    const a = colors[k], b = colors[k + 1];
    const lerp = (s: number) => Math.round(((a >>> s) & 0xff) * (1 - f) + ((b >>> s) & 0xff) * f);
    lut[i] = ((lerp(24) << 24) | (lerp(16) << 16) | (lerp(8) << 8) | lerp(0)) >>> 0;
  }
  return lut;
}

function gradientAt(g: Gradient, x: number, y: number, repeat: number): number {
  const p = g.p;
  if (g.kind === 'linear') {
    const dx = p[2] - p[0], dy = p[3] - p[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 ? ((x - p[0]) * dx + (y - p[1]) * dy) / len2 : 0;
    return gradientColor(g, t, repeat);
  }
  if (g.kind === 'radial') {
    // two-circle gradient (pixman's formulation): find largest t with r(t) >= 0
    const [cx1, cy1, cx2, cy2, r1, r2] = p;
    const cdx = cx2 - cx1, cdy = cy2 - cy1, dr = r2 - r1;
    const pdx = x - cx1, pdy = y - cy1;
    const a = cdx * cdx + cdy * cdy - dr * dr;
    const b = pdx * cdx + pdy * cdy + r1 * dr;
    const c = pdx * pdx + pdy * pdy - r1 * r1;
    let t: number;
    if (Math.abs(a) < 1e-9) {
      if (Math.abs(b) < 1e-9) return 0;
      t = c / (2 * b);
    } else {
      const disc = b * b - a * c;
      if (disc < 0) return 0;
      const sq = Math.sqrt(disc);
      t = (b + sq) / a;
      if (r1 + t * dr < 0) t = (b - sq) / a;
    }
    if (r1 + t * dr < 0) return 0;
    return gradientColor(g, t, repeat);
  }
  const ang = Math.atan2(y - p[1], x - p[0]) - p[2] * Math.PI / 180;
  let t = ang / (2 * Math.PI);
  t = t - Math.floor(t);
  return gradientColor(g, t, 1);
}

/** Sample a source/mask picture at destination-space pixel (x, y) (already offset into picture space). */
function makeFetch(p: Picture): (x: number, y: number) => number {
  if (p.solid !== null) { const c = p.solid; return () => c; }
  const tr = p.transform;
  if (p.gradient) {
    const g = p.gradient;
    if (!tr) return (x, y) => gradientAt(g, x + 0.5, y + 0.5, p.repeat || 2);
    return (x, y) => {
      const [sx, sy] = apply(tr, x + 0.5, y + 0.5);
      return gradientAt(g, sx, sy, p.repeat || 2);
    };
  }
  const pix = p.pix!, f = p.format!, W = pix.width, H = pix.height, data = pix.data, rep = p.repeat;
  const at = (ix: number, iy: number): number => {
    if (rep) { ix = wrap(ix, W, rep); iy = wrap(iy, H, rep); }
    else if (ix < 0 || iy < 0 || ix >= W || iy >= H) return 0;
    return toARGB(data[iy * W + ix], f);
  };
  if (!tr) {
    if (!rep && f.type === 'argb') return (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : data[y * W + x] >>> 0);
    return at;
  }
  if (p.filter === 'nearest') {
    return (x, y) => { const [sx, sy] = apply(tr, x + 0.5, y + 0.5); return at(Math.floor(sx), Math.floor(sy)); };
  }
  return (x, y) => {
    const [sx, sy] = apply(tr, x + 0.5, y + 0.5);
    const fx = sx - 0.5, fy = sy - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const ax = fx - x0, ay = fy - y0;
    const c00 = at(x0, y0), c10 = at(x0 + 1, y0), c01 = at(x0, y0 + 1), c11 = at(x0 + 1, y0 + 1);
    const lerp = (s: number) => {
      const top = ((c00 >>> s) & 0xff) * (1 - ax) + ((c10 >>> s) & 0xff) * ax;
      const bot = ((c01 >>> s) & 0xff) * (1 - ax) + ((c11 >>> s) & 0xff) * ax;
      return Math.round(top * (1 - ay) + bot * ay);
    };
    return ((lerp(24) << 24) | (lerp(16) << 16) | (lerp(8) << 8) | lerp(0)) >>> 0;
  };
}

function apply(m: number[], x: number, y: number): [number, number] {
  const w = m[6] * x + m[7] * y + m[8];
  const sx = m[0] * x + m[1] * y + m[2], sy = m[3] * x + m[4] * y + m[5];
  return w === 1 || w === 0 ? [sx, sy] : [sx / w, sy / w];
}

const fixed = (r: Reader) => r.i32() / 65536;

// ── extension ──

export function installRender(server: XServer): void {
  const glyphsets = new Map<number, GlyphSet>();
  const ext = server.addExtension('RENDER', 0, 5, (c, minor, r) => {
    try {
      handle(c, minor, r);
    } catch (e) {
      if ((e as { renderError?: number }).renderError !== undefined) {
        server.error(c, ext.firstError + (e as { renderError: number }).renderError, (e as { value?: number }).value ?? 0, ext.major, minor);
        return;
      }
      throw e;
    }
  });
  const renderError = (code: number, value = 0) => Object.assign(new Error('render'), { renderError: code, value });

  const pict = (id: number): Picture => {
    if (!server.hasResource(id, 'picture')) throw renderError(BadPicture, id);
    return server.lookup<Picture>(id, 'picture', 0);
  };
  const pictOrNull = (id: number): Picture | null => (id ? pict(id) : null);

  const newPicture = (id: number): Picture => ({
    id, pix: null, format: null, solid: null, gradient: null, repeat: 0, clipX: 0, clipY: 0, clipRects: null,
    transform: null, filter: 'nearest', componentAlpha: false, alphaMap: null,
  });

  const changePicture = (p: Picture, mask: number, r: Reader) => {
    for (let bit = 0; bit < 13; bit++) {
      if (!(mask & (1 << bit))) continue;
      const v = r.u32();
      switch (bit) {
        case 0: p.repeat = v; break;
        case 1: p.alphaMap = v ? pict(v) : null; break;
        case 4: p.clipX = (v << 16) >> 16; break;
        case 5: p.clipY = (v << 16) >> 16; break;
        case 6:
          if (v === 0) p.clipRects = null;
          else { const m = server.lookup<Pix>(v, 'pixmap', 4); p.clipRects = maskRects(m); }
          break;
        case 12: p.componentAlpha = !!v; break;
        default: break;
      }
    }
  };

  /** Clip rectangles of a destination picture, in its pixel space. */
  const dstClips = (p: Picture): Rect[] => {
    const pix = p.pix!;
    const b = { x: 0, y: 0, w: pix.width, h: pix.height };
    if (!p.clipRects) return [b];
    const out: Rect[] = [];
    for (const c of p.clipRects) { const i = intersect(b, { x: c.x + p.clipX, y: c.y + p.clipY, w: c.w, h: c.h }); if (i) out.push(i); }
    return out;
  };

  /**
   * The core: dst[x,y] = op(src[x+sdx, y+sdy] IN mask[x+mdx, y+mdy], dst) over `area`.
   * `maskFn` overrides the mask picture (glyphs, trapezoid coverage); returns ARGB with alpha.
   */
  const composite = (op: number, src: Picture, mask: Picture | null, dst: Picture, area: Rect, sdx: number, sdy: number, mdx: number, mdy: number,
    maskFn?: (x: number, y: number) => number) => {
    if (!dst.pix) throw renderError(BadPicture, dst.id);
    const pix = dst.pix, f = dst.format!, data = pix.data, W = pix.width;
    const sf = makeFetch(src);
    const mf = maskFn ?? (mask ? makeFetch(mask) : null);
    const ca = !!mask?.componentAlpha && !maskFn;
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    const solidSrc = src.solid;
    for (const c of dstClips(dst)) {
      const r = intersect(c, area);
      if (!r) continue;
      bx0 = Math.min(bx0, r.x); by0 = Math.min(by0, r.y); bx1 = Math.max(bx1, r.x + r.w); by1 = Math.max(by1, r.y + r.h);
      // fast path: opaque-format copy/over with no mask from an argb/xrgb image
      for (let y = r.y; y < r.y + r.h; y++) {
        const row = y * W;
        for (let x = r.x; x < r.x + r.w; x++) {
          let s = solidSrc !== null ? solidSrc : sf(x + sdx, y + sdy);
          let m = 0xffffffff;
          if (mf) {
            m = mf(x + mdx, y + mdy);
            if (!ca) {
              const ma = m >>> 24;
              if (ma === 0 && (op === 3 || op === 12)) continue;
              s = scale(s, ma);
            }
          }
          const i = row + x;
          if (op === 1 && !ca) { data[i] = fromARGB(s, f); continue; }
          const d = toARGB(data[i], f);
          const out = ca ? (op === 3 ? overCA(s, m, d) : combine(op, inMask(s, m, true), d)) : combine(op, s, d);
          data[i] = fromARGB(out, f);
        }
      }
    }
    if (bx1 > bx0) pix.damage(bx0, by0, bx1 - bx0, by1 - by0);
  };

  /** Coverage mask (Float32 0..1) for polygons given as trapezoid-like edge pairs, in a bounding box. */
  const rasterize = (shapes: ((y: number) => [number, number] | null)[], tops: number[], bottoms: number[], antialias: boolean) => {
    let y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < shapes.length; i++) { y0 = Math.min(y0, tops[i]); y1 = Math.max(y1, bottoms[i]); }
    if (!(y1 > y0)) return null;
    const by0 = Math.floor(y0), by1 = Math.ceil(y1);
    // find x extent
    let x0 = Infinity, x1 = -Infinity;
    for (let i = 0; i < shapes.length; i++) for (const yy of [tops[i], bottoms[i], (tops[i] + bottoms[i]) / 2]) {
      const s = shapes[i](Math.min(Math.max(yy, tops[i]), bottoms[i]));
      if (s) { x0 = Math.min(x0, s[0]); x1 = Math.max(x1, s[1]); }
    }
    if (!(x1 > x0)) return null;
    const bx0 = Math.floor(x0), bx1 = Math.ceil(x1);
    const w = bx1 - bx0, h = by1 - by0;
    if (w <= 0 || h <= 0 || w * h > 16e6) return null;
    const cov = new Float32Array(w * h);
    const SUB = antialias ? 4 : 1;
    for (let i = 0; i < shapes.length; i++) {
      const t = tops[i], b = bottoms[i];
      for (let py = Math.floor(t); py < Math.ceil(b); py++) {
        for (let k = 0; k < SUB; k++) {
          const sy = py + (k + 0.5) / SUB;
          if (sy < t || sy >= b) continue;
          const span = shapes[i](sy);
          if (!span) continue;
          let [l, rr] = span;
          if (rr <= l) continue;
          const row = (py - by0) * w;
          if (!antialias) { l = Math.round(l); rr = Math.round(rr); }
          const il = Math.floor(l), ir = Math.floor(rr);
          const wgt = 1 / SUB;
          if (il === ir) { const ix = il - bx0; if (ix >= 0 && ix < w) cov[row + ix] += (rr - l) * wgt; continue; }
          if (il - bx0 >= 0 && il - bx0 < w) cov[row + il - bx0] += (il + 1 - l) * wgt;
          for (let x = il + 1; x < ir; x++) if (x - bx0 >= 0 && x - bx0 < w) cov[row + x - bx0] += wgt;
          if (ir - bx0 >= 0 && ir - bx0 < w && rr > ir) cov[row + ir - bx0] += (rr - ir) * wgt;
        }
      }
    }
    return { x: bx0, y: by0, w, h, cov };
  };

  const compositeCoverage = (op: number, src: Picture, dst: Picture, srcX: number, srcY: number, refX: number, refY: number,
    mask: { x: number; y: number; w: number; h: number; cov: Float32Array } | null) => {
    if (!mask) return;
    const { x, y, w, h, cov } = mask;
    composite(op, src, null, dst, { x, y, w, h }, srcX - refX, srcY - refY, 0, 0, (mx, my) => {
      const i = (my - y) * w + (mx - x);
      if (mx < x || my < y || mx >= x + w || my >= y + h) return 0;
      const a = Math.min(255, Math.round(cov[i] * 255));
      return (a << 24) >>> 0;
    });
  };

  const lineX = (x1: number, y1: number, x2: number, y2: number, y: number) => (y2 === y1 ? x1 : x1 + (y - y1) * (x2 - x1) / (y2 - y1));

  function handle(c: Client, minor: number, r: Reader): void {
    switch (minor) {
      case 0: { // QueryVersion
        server.reply(c, 0, c.writer().u32(0).u32(11));
        return;
      }
      case 1: { // QueryPictFormats
        const depths: [number, [number, number][]][] = [[1, []], [8, []], [16, []], [24, [[0x21, 0x31]]], [32, [[0x22, 0x30]]]];
        const w = c.writer(512);
        const nVisuals = depths.reduce((a, d) => a + d[1].length, 0);
        w.u32(FORMATS.length).u32(1).u32(depths.length).u32(nVisuals).u32(1).zero(4);
        for (const f of FORMATS) {
          w.u32(f.id).u8(1).u8(f.depth).zero(2);
          switch (f.type) {
            case 'argb': w.u16(16).u16(0xff).u16(8).u16(0xff).u16(0).u16(0xff).u16(24).u16(0xff); break;
            case 'xrgb': w.u16(16).u16(0xff).u16(8).u16(0xff).u16(0).u16(0xff).u16(0).u16(0); break;
            case 'a8': w.u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0xff); break;
            case 'a1': w.u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(1); break;
            case 'rgb565': w.u16(11).u16(0x1f).u16(5).u16(0x3f).u16(0).u16(0x1f).u16(0).u16(0); break;
          }
          w.u32(0);
        }
        w.u32(depths.length).u32(0x31);
        for (const [d, vis] of depths) {
          w.u8(d).u8(0).u16(vis.length).zero(4);
          for (const [v, f] of vis) w.u32(v).u32(f);
        }
        w.u32(0); // subpixel order: unknown
        server.reply(c, 0, w);
        return;
      }
      case 2: throw renderError(BadPictFormat, 0); // QueryPictIndexValues
      case 4: { // CreatePicture
        const pid = r.u32(); const did = r.u32(); const fid = r.u32(); const mask = r.u32();
        const f = FORMAT_BY_ID.get(fid);
        if (!f) throw renderError(BadPictFormat, fid);
        const d = server.drawable(did);
        if (d.depth !== f.depth) throw new XError(BadMatch, 0);
        const p = newPicture(pid);
        p.pix = d.pix; p.format = f;
        changePicture(p, mask, r);
        server.addExtResource(c, pid, 'picture', p);
        return;
      }
      case 5: { const p = pict(r.u32()); changePicture(p, r.u32(), r); return; }
      case 6: { // SetPictureClipRectangles
        const p = pict(r.u32()); p.clipX = r.i16(); p.clipY = r.i16();
        const rects: Rect[] = [];
        while (r.left >= 8) rects.push({ x: r.i16(), y: r.i16(), w: r.u16(), h: r.u16() });
        p.clipRects = rects;
        return;
      }
      case 7: { const id = r.u32(); pict(id); server.freeResource(id, 'picture', 0); return; }
      case 8: { // Composite
        const op = r.u8(); r.skip(3);
        const src = pict(r.u32()), mask = pictOrNull(r.u32()), dst = pict(r.u32());
        const sx = r.i16(), sy = r.i16(), mx = r.i16(), my = r.i16(), dx = r.i16(), dy = r.i16(), w = r.u16(), h = r.u16();
        if (op > 0x3e) throw renderError(BadPictOp, op);
        if (!mask && src.pix && !src.transform && !src.repeat) {
          // only the part of the source that exists contributes (unless the op clears)
          const area = intersect({ x: dx, y: dy, w, h }, { x: dx - sx, y: dy - sy, w: src.pix.width, h: src.pix.height });
          if (op === 3 || op === 12 || op === 2) { if (area) composite(op, src, null, dst, area, sx - dx, sy - dy, 0, 0); return; }
        }
        composite(op, src, mask, dst, { x: dx, y: dy, w, h }, sx - dx, sy - dy, mx - dx, my - dy);
        return;
      }
      case 10: { // Trapezoids
        const op = r.u8(); r.skip(3);
        const src = pict(r.u32()), dst = pict(r.u32()); const mf = r.u32(); const sx = r.i16(), sy = r.i16();
        const shapes: ((y: number) => [number, number] | null)[] = [], tops: number[] = [], bots: number[] = [];
        let refX = Infinity, refY = Infinity;
        while (r.left >= 40) {
          const top = fixed(r), bot = fixed(r);
          const l = [fixed(r), fixed(r), fixed(r), fixed(r)], rr = [fixed(r), fixed(r), fixed(r), fixed(r)];
          if (!(bot > top)) continue;
          if (refX === Infinity) { refX = Math.floor(l[1] <= l[3] ? l[0] : l[2]); refY = Math.floor(l[1] <= l[3] ? l[1] : l[3]); }
          shapes.push((y) => [lineX(l[0], l[1], l[2], l[3], y), lineX(rr[0], rr[1], rr[2], rr[3], y)]);
          tops.push(top); bots.push(bot);
        }
        if (!shapes.length) return;
        const aa = mf !== 0x33;
        compositeCoverage(op, src, dst, sx, sy, refX, refY, rasterize(shapes, tops, bots, aa));
        return;
      }
      case 11: case 12: case 13: { // Triangles, TriStrip, TriFan
        const op = r.u8(); r.skip(3);
        const src = pict(r.u32()), dst = pict(r.u32()); const mf = r.u32(); const sx = r.i16(), sy = r.i16();
        const pts: number[] = [];
        while (r.left >= 8) pts.push(fixed(r), fixed(r));
        const tris: number[][] = [];
        const n = pts.length / 2;
        if (minor === 11) for (let i = 0; i + 2 < n; i += 3) tris.push(pts.slice(i * 2, i * 2 + 6));
        else if (minor === 12) for (let i = 0; i + 2 < n; i++) tris.push(pts.slice(i * 2, i * 2 + 6));
        else for (let i = 1; i + 1 < n; i++) tris.push([pts[0], pts[1], pts[i * 2], pts[i * 2 + 1], pts[i * 2 + 2], pts[i * 2 + 3]]);
        if (!tris.length) return;
        const shapes: ((y: number) => [number, number] | null)[] = [], tops: number[] = [], bots: number[] = [];
        for (const t of tris) {
          const ys = [t[1], t[3], t[5]];
          tops.push(Math.min(...ys)); bots.push(Math.max(...ys));
          shapes.push((y) => {
            const xs: number[] = [];
            for (let e = 0; e < 3; e++) {
              const ax = t[e * 2], ay = t[e * 2 + 1], bx = t[(e * 2 + 2) % 6], by = t[(e * 2 + 3) % 6];
              if ((y >= ay && y < by) || (y >= by && y < ay)) xs.push(lineX(ax, ay, bx, by, y));
            }
            if (xs.length < 2) return null;
            return [Math.min(...xs), Math.max(...xs)];
          });
        }
        const first = tris[0];
        compositeCoverage(op, src, dst, sx, sy, Math.floor(first[0]), Math.floor(first[1]), rasterize(shapes, tops, bots, mf !== 0x33));
        return;
      }
      case 17: { // CreateGlyphSet
        const id = r.u32(); const fid = r.u32();
        const f = FORMAT_BY_ID.get(fid);
        if (!f) throw renderError(BadPictFormat, fid);
        const gs: GlyphSet = { format: f, glyphs: new Map(), refs: 1 };
        glyphsets.set(id, gs);
        server.addExtResource(c, id, 'glyphset', gs, () => { glyphsets.delete(id); });
        return;
      }
      case 18: { // ReferenceGlyphSet
        const id = r.u32(); const existing = r.u32();
        if (!server.hasResource(existing, 'glyphset')) throw renderError(BadGlyphSet, existing);
        const gs = server.lookup<GlyphSet>(existing, 'glyphset', 0);
        gs.refs++;
        server.addExtResource(c, id, 'glyphset', gs);
        return;
      }
      case 19: { const id = r.u32(); if (!server.hasResource(id, 'glyphset')) throw renderError(BadGlyphSet, id); server.freeResource(id, 'glyphset', 0); return; }
      case 20: { // AddGlyphs
        const id = r.u32();
        if (!server.hasResource(id, 'glyphset')) throw renderError(BadGlyphSet, id);
        const gs = server.lookup<GlyphSet>(id, 'glyphset', 0);
        const n = r.u32();
        const ids: number[] = []; for (let i = 0; i < n; i++) ids.push(r.u32());
        const infos: number[][] = []; for (let i = 0; i < n; i++) infos.push([r.u16(), r.u16(), r.i16(), r.i16(), r.i16(), r.i16()]);
        for (let i = 0; i < n; i++) {
          const [w, h, x, y, xOff, yOff] = infos[i];
          const g: GlyphImg = { w, h, x, y, xOff, yOff, a: null, argb: null };
          const f = gs.format;
          if (f.type === 'a1') {
            const stride = ((w + 31) >> 5) << 2;
            const bits = r.bytes(stride * h);
            g.a = new Uint8Array(w * h);
            for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) g.a[yy * w + xx] = (bits[yy * stride + (xx >> 3)] >> (xx & 7)) & 1 ? 255 : 0;
          } else if (f.type === 'a8') {
            const stride = (w + 3) & ~3;
            const bytes = r.bytes(stride * h);
            g.a = new Uint8Array(w * h);
            for (let yy = 0; yy < h; yy++) g.a.set(bytes.subarray(yy * stride, yy * stride + w), yy * w);
          } else {
            const bpp = f.depth === 16 ? 2 : 4;
            const stride = (w * bpp + 3) & ~3;
            const bytes = r.bytes(stride * h);
            const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            g.argb = new Uint32Array(w * h);
            for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
              const v = bpp === 4 ? dv.getUint32(yy * stride + xx * 4, c.le) : dv.getUint16(yy * stride + xx * 2, c.le);
              g.argb[yy * w + xx] = toARGB(v, f);
            }
          }
          gs.glyphs.set(ids[i], g);
        }
        return;
      }
      case 22: { // FreeGlyphs
        const id = r.u32();
        if (!server.hasResource(id, 'glyphset')) throw renderError(BadGlyphSet, id);
        const gs = server.lookup<GlyphSet>(id, 'glyphset', 0);
        while (r.left >= 4) gs.glyphs.delete(r.u32());
        return;
      }
      case 23: case 24: case 25: return compositeGlyphs(c, minor, r);
      case 26: { // FillRectangles
        const op = r.u8(); r.skip(3);
        const dst = pict(r.u32());
        const color = color16(r.u16(), r.u16(), r.u16(), r.u16());
        const src = newPicture(0); src.solid = color;
        while (r.left >= 8) {
          const x = r.i16(), y = r.i16(), w = r.u16(), h = r.u16();
          composite(op, src, null, dst, { x, y, w, h }, 0, 0, 0, 0);
        }
        return;
      }
      case 27: { // CreateCursor
        const cid = r.u32(); const p = pict(r.u32()); const xhot = r.u16(), yhot = r.u16();
        if (!p.pix) throw renderError(BadPicture, p.id);
        const W = p.pix.width, H = p.pix.height;
        const rgba = new Uint8ClampedArray(W * H * 4);
        for (let i = 0; i < W * H; i++) {
          const v = toARGB(p.pix.data[i], p.format!);
          const a = v >>> 24;
          if (!a) continue;
          rgba[i * 4] = Math.min(255, ((v >> 16) & 0xff) * 255 / a);
          rgba[i * 4 + 1] = Math.min(255, ((v >> 8) & 0xff) * 255 / a);
          rgba[i * 4 + 2] = Math.min(255, (v & 0xff) * 255 / a);
          rgba[i * 4 + 3] = a;
        }
        const cur: XCursor = { id: cid, css: 'default', image: { width: W, height: H, rgba, xhot, yhot } };
        server.addCursor(c, cur);
        return;
      }
      case 28: { // SetPictureTransform
        const p = pict(r.u32());
        const m: number[] = []; for (let i = 0; i < 9; i++) m.push(fixed(r));
        const identity = m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 0 && m[4] === 1 && m[5] === 0 && m[6] === 0 && m[7] === 0 && m[8] === 1;
        p.transform = identity ? null : m;
        return;
      }
      case 29: { // QueryFilters
        r.u32();
        const filters = ['nearest', 'bilinear', 'fast', 'good', 'best', 'convolution', 'separable-convolution'];
        const aliases = [0xffff, 0xffff, 0, 1, 1, 0xffff, 0xffff];
        const w = c.writer(128).u32(aliases.length).u32(filters.length).zero(16);
        for (const a of aliases) w.u16(a);
        for (const f of filters) w.u8(f.length).str(f);
        server.reply(c, 0, w);
        return;
      }
      case 30: { // SetPictureFilter
        const p = pict(r.u32()); const n = r.u16(); r.skip(2);
        const name = r.str(n);
        p.filter = name === 'nearest' || name === 'fast' ? 'nearest' : 'bilinear';
        return;
      }
      case 31: { // CreateAnimCursor: use the first frame
        const cid = r.u32(); const first = r.u32();
        const base = server.cursorById(first);
        server.addCursor(c, { ...(base ?? { css: 'default' }), id: cid } as XCursor);
        return;
      }
      case 32: { // AddTraps
        const p = pict(r.u32()); const xo = r.i16(), yo = r.i16();
        const shapes: ((y: number) => [number, number] | null)[] = [], tops: number[] = [], bots: number[] = [];
        while (r.left >= 24) {
          const tl = fixed(r) + xo, tr = fixed(r) + xo, ty = fixed(r) + yo, bl = fixed(r) + xo, br = fixed(r) + xo, by = fixed(r) + yo;
          if (!(by > ty)) continue;
          shapes.push((y) => [lineX(tl, ty, bl, by, y), lineX(tr, ty, br, by, y)]);
          tops.push(ty); bots.push(by);
        }
        const white = newPicture(0); white.solid = 0xffffffff;
        compositeCoverage(12, white, p, 0, 0, 0, 0, rasterize(shapes, tops, bots, true));
        return;
      }
      case 33: { // CreateSolidFill
        const pid = r.u32();
        const p = newPicture(pid);
        p.solid = color16(r.u16(), r.u16(), r.u16(), r.u16());
        server.addExtResource(c, pid, 'picture', p);
        return;
      }
      case 34: case 35: case 36: { // gradients
        const pid = r.u32();
        let kind: Gradient['kind'];
        let pts: number[];
        if (minor === 34) { kind = 'linear'; pts = [fixed(r), fixed(r), fixed(r), fixed(r)]; }
        else if (minor === 35) { kind = 'radial'; pts = [fixed(r), fixed(r), fixed(r), fixed(r), fixed(r), fixed(r)]; }
        else { kind = 'conical'; pts = [fixed(r), fixed(r), fixed(r)]; }
        const n = r.u32();
        const stops: number[] = []; for (let i = 0; i < n; i++) stops.push(fixed(r));
        const colors: number[] = []; for (let i = 0; i < n; i++) colors.push(stopColor(r.u16(), r.u16(), r.u16(), r.u16()));
        const p = newPicture(pid);
        p.gradient = { kind, p: pts, stops, colors };
        if (!n) p.solid = 0;
        server.addExtResource(c, pid, 'picture', p);
        return;
      }
    }
    throw new XError(BadRequest);
  }

  function compositeGlyphs(c: Client, minor: number, r: Reader): void {
    const op = r.u8(); r.skip(3);
    const src = pict(r.u32()), dst = pict(r.u32()); r.u32(); // mask format: glyphs are composited one by one
    let gsid = r.u32();
    const sx = r.i16(), sy = r.i16();
    const size = minor === 23 ? 1 : minor === 24 ? 2 : 4;
    let x = 0, y = 0;
    let first = true;
    let ox = 0, oy = 0;
    if (!server.hasResource(gsid, 'glyphset')) throw renderError(BadGlyphSet, gsid);
    let gs = server.lookup<GlyphSet>(gsid, 'glyphset', 0);
    while (r.left >= 8) {
      const len = r.u8(); r.skip(3);
      const dx = r.i16(), dy = r.i16();
      if (len === 255) {
        gsid = r.u32();
        if (!server.hasResource(gsid, 'glyphset')) throw renderError(BadGlyphSet, gsid);
        gs = server.lookup<GlyphSet>(gsid, 'glyphset', 0);
        continue;
      }
      x += dx; y += dy;
      if (first) { ox = x; oy = y; first = false; }
      const ids: number[] = [];
      for (let i = 0; i < len; i++) ids.push(size === 1 ? r.u8() : size === 2 ? r.u16() : r.u32());
      r.skip(((len * size + 3) & ~3) - len * size);
      for (const id of ids) {
        const g = gs.glyphs.get(id);
        if (!g) continue;
        const gx = x - g.x, gy = y - g.y;
        if (g.w && g.h) {
          if (g.a) {
            const a = g.a, w = g.w;
            composite(op, src, null, dst, { x: gx, y: gy, w: g.w, h: g.h }, sx - ox, sy - oy, 0, 0,
              (mx, my) => (a[(my - gy) * w + (mx - gx)] << 24) >>> 0);
          } else if (g.argb) {
            const im = g.argb, w = g.w;
            // colored glyph (emoji): the glyph itself is the source
            composite(op, { ...newPicture(0), pix: argbPix(im, w, g.h), format: FORMAT_BY_ID.get(0x30)! },
              null, dst, { x: gx, y: gy, w, h: g.h }, -gx, -gy, 0, 0);
          }
        }
        x += g.xOff; y += g.yOff;
      }
    }
    void c;
  }
}

function argbPix(data: Uint32Array, w: number, h: number): Pix {
  const p = new Pix(w, h, 32);
  p.data.set(data);
  return p;
}

function maskRects(m: Pix): Rect[] {
  const out: Rect[] = [];
  for (let y = 0; y < m.height; y++) {
    let x = 0;
    while (x < m.width) {
      while (x < m.width && !(m.data[y * m.width + x] & 1)) x++;
      const s = x;
      while (x < m.width && (m.data[y * m.width + x] & 1)) x++;
      if (x > s) out.push({ x: s, y, w: x - s, h: 1 });
    }
  }
  return out;
}
