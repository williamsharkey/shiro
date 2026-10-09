/**
 * Rootless composition: paint a toplevel window's subtree (backing pixels,
 * borders, child stacking, SHAPE) into an RGBA buffer the size of the
 * toplevel, for a desktop window's canvas (putImageData).
 */
import type { XWindow } from './server';
import { InputOnly } from './proto';
import { intersect, type Rect } from './raster';

export interface RGBA { data: Uint8ClampedArray; width: number; height: number }

/** Recompose `area` (toplevel coordinates) of `top` into `out` (same size as top). */
export function composeTop(top: XWindow, out: RGBA, area: Rect): void {
  const r = intersect(area, { x: 0, y: 0, w: out.width, h: out.height });
  if (!r) return;
  const u32 = new Uint32Array(out.data.buffer, out.data.byteOffset, out.width * out.height);
  // clear to transparent (shaped toplevels show the desktop through)
  for (let y = r.y; y < r.y + r.h; y++) u32.fill(0, y * out.width + r.x, y * out.width + r.x + r.w);
  paint(top, 0, 0, shapeClip([r], top.shapeBounding, 0, 0), u32, out.width);
}

/** Clip rects narrowed by a window's bounding shape (shape rects are relative to its origin). */
function shapeClip(clips: Rect[], shape: Rect[] | null, ox: number, oy: number): Rect[] {
  if (!shape) return clips;
  const out: Rect[] = [];
  for (const c of clips) for (const s of shape) { const i = intersect(c, { x: s.x + ox, y: s.y + oy, w: s.w, h: s.h }); if (i) out.push(i); }
  return out;
}

/** Little-endian RGBA bytes as a u32: 0xAABBGGRR. */
function toRGBA(px: number, depth: number): number {
  if (depth === 32) {
    const a = px >>> 24;
    if (a === 0) return 0;
    let r = (px >> 16) & 0xff, g = (px >> 8) & 0xff, b = px & 0xff;
    if (a !== 255) { r = Math.min(255, (r * 255 / a) | 0); g = Math.min(255, (g * 255 / a) | 0); b = Math.min(255, (b * 255 / a) | 0); }
    return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
  }
  return (0xff000000 | ((px & 0xff) << 16) | (px & 0xff00) | ((px >> 16) & 0xff)) >>> 0;
}

function paint(w: XWindow, ox: number, oy: number, clipList: Rect[], out: Uint32Array, stride: number): void {
  // ox, oy: where this window's contents origin lands in the output; clipList: visible area
  if (!clipList.length) return;
  const area = { x: ox, y: oy, w: w.width, h: w.height };
  if (w.cls !== InputOnly && w.pix) {
    const p = w.pix, depth = w.depth;
    const clips = clipList.map((c) => intersect(c, area)).filter(Boolean) as Rect[];
    for (const c of clips) {
      for (let y = c.y; y < c.y + c.h; y++) {
        const sy = y - oy;
        if (sy >= p.height) break;
        const srow = sy * p.width;
        const drow = y * stride;
        const x1 = Math.min(c.x + c.w, ox + p.width);
        if (depth === 24) {
          for (let x = c.x; x < x1; x++) {
            const px = p.data[srow + x - ox];
            out[drow + x] = (0xff000000 | ((px & 0xff) << 16) | (px & 0xff00) | ((px >> 16) & 0xff)) >>> 0;
          }
        } else {
          for (let x = c.x; x < x1; x++) out[drow + x] = toRGBA(p.data[srow + x - ox], depth);
        }
      }
    }
  }
  for (const ch of w.children) {
    if (!ch.mapped) continue;
    const cx = ox + ch.x, cy = oy + ch.y;
    const outer = { x: cx, y: cy, w: ch.width + 2 * ch.bw, h: ch.height + 2 * ch.bw };
    const chClips = shapeClip(clipList.map((c) => intersect(c, outer)).filter(Boolean) as Rect[], ch.shapeBounding, cx + ch.bw, cy + ch.bw);
    if (ch.bw > 0 && ch.cls !== InputOnly) {
      for (const b of chClips) {
        const inner = { x: cx + ch.bw, y: cy + ch.bw, w: ch.width, h: ch.height };
        const color = toRGBA(ch.borderPixel, ch.depth);
        for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
          if (x >= inner.x && y >= inner.y && x < inner.x + inner.w && y < inner.y + inner.h) continue;
          out[y * stride + x] = color;
        }
      }
    }
    const inside = { x: cx + ch.bw, y: cy + ch.bw, w: ch.width, h: ch.height };
    paint(ch, cx + ch.bw, cy + ch.bw, chClips.map((c) => intersect(c, inside)).filter(Boolean) as Rect[], out, stride);
  }
}
