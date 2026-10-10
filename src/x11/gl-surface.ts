/**
 * GL surfaces: a canvas over an X window, for frames that don't go through
 * Xshiro's pixmaps (glshiro's WebGL2 frames, docs/research/GL.md). The canvas
 * sits in the toplevel's desktop window (its overlay element), at the X
 * window's place, clipped to what of the window is visible: inside its
 * ancestors, minus the siblings stacked above it (and above each ancestor)
 * and its own children. It follows moves, resizes, map, unmap and restacks
 * (rootless.ts calls `update()` after any structure change), and comes back
 * when the toplevel is unmapped and mapped again.
 *
 * Coordinates are X pixels; the canvas is laid out at X px ÷ scale CSS px,
 * so its backing store matches the window 1:1 in device pixels.
 */
import type { XWindow } from './server';
import { InputOnly } from './proto';
import { intersect, type Rect } from './raster';

export interface GLSurface {
  readonly xid: number;
  /** The canvas over the window (a `bitmaprenderer` or any context); null without a DOM. */
  readonly canvas: HTMLCanvasElement | null;
  /** The window's size (its content, X px). */
  readonly width: number;
  readonly height: number;
  /** The window's content origin within its toplevel's content. */
  readonly x: number;
  readonly y: number;
  /** Mapped, inside a shown toplevel, and some part of it not covered. */
  readonly visible: boolean;
  /** The visible part, disjoint rects relative to the window's origin. */
  readonly clip: readonly Rect[];
  /** Size, position, visibility or clip changed. Returns an unsubscribe. */
  onChange(cb: () => void): () => void;
  /** The window was destroyed (the canvas is gone). */
  onDestroy(cb: () => void): () => void;
  /** Done with it: the canvas is removed; the window is drawn from its pixels again. */
  release(): void;
}

/** Subtract `b` from every rect in `rs` (each splits into at most 4). */
export function subtractRect(rs: Rect[], b: Rect): Rect[] {
  const out: Rect[] = [];
  for (const a of rs) {
    if (!intersect(a, b)) { out.push(a); continue; }
    const ax2 = a.x + a.w, ay2 = a.y + a.h, bx2 = b.x + b.w, by2 = b.y + b.h;
    if (b.y > a.y) out.push({ x: a.x, y: a.y, w: a.w, h: b.y - a.y });
    if (by2 < ay2) out.push({ x: a.x, y: by2, w: a.w, h: ay2 - by2 });
    const y1 = Math.max(a.y, b.y), y2 = Math.min(ay2, by2);
    if (b.x > a.x) out.push({ x: a.x, y: y1, w: b.x - a.x, h: y2 - y1 });
    if (bx2 < ax2) out.push({ x: bx2, y: y1, w: ax2 - bx2, h: y2 - y1 });
  }
  return out;
}

/** Outer rect (border included) of a window in its parent's content coordinates. */
const outer = (w: XWindow): Rect => ({ x: w.x, y: w.y, w: w.width + 2 * w.bw, h: w.height + 2 * w.bw });
const occludes = (w: XWindow) => w.mapped && w.cls !== InputOnly;

/**
 * The visible part of `w`'s contents in its toplevel's content coordinates:
 * clipped by every ancestor below the root, minus mapped siblings above it
 * or above any ancestor, minus its own mapped children. Empty when it isn't viewable.
 */
export function visibleInTop(w: XWindow): Rect[] {
  if (!w.parent || !w.viewable()) return [];
  const [ox, oy] = w.topOrigin();
  let region: Rect[] = [{ x: ox, y: oy, w: w.width, h: w.height }];
  for (const ch of w.children) if (occludes(ch)) region = subtractRect(region, { ...outer(ch), x: ox + ch.x, y: oy + ch.y });
  for (let a: XWindow = w; a.parent && a.parent.parent; a = a.parent) {
    const p = a.parent;
    const [px, py] = p.topOrigin();
    const pr = { x: px, y: py, w: p.width, h: p.height };
    region = region.map((r) => intersect(r, pr)).filter((r): r is Rect => !!r);
    const sibs = p.children;
    for (let i = sibs.indexOf(a) + 1; i < sibs.length; i++) {
      if (occludes(sibs[i])) { const o = outer(sibs[i]); region = subtractRect(region, { ...o, x: px + o.x, y: py + o.y }); }
    }
    if (!region.length) break;
  }
  return region;
}

/** What a surface needs from the rootless display. */
export interface SurfaceSite {
  /** The overlay element of the toplevel's desktop window, if it is shown. */
  overlay(top: XWindow): HTMLElement | null;
  /** Device px per CSS px. */
  readonly scale: number;
}

export class GLSurfaceImpl implements GLSurface {
  readonly canvas: HTMLCanvasElement | null;
  x = 0; y = 0; visible = false; clip: Rect[] = [];
  private changeCbs = new Set<() => void>();
  private destroyCbs = new Set<() => void>();
  private key = '';
  released = false;

  constructor(readonly win: XWindow, private site: SurfaceSite, private onRelease: (s: GLSurfaceImpl) => void) {
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.dataset.glSurface = String(win.id);
      Object.assign(c.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none', display: 'none' });
      this.canvas = c;
    } else this.canvas = null;
    this.update();
  }

  get xid() { return this.win.id; }
  get width() { return this.win.width; }
  get height() { return this.win.height; }

  /** Re-place the canvas after a structure change; tells listeners when anything moved. */
  update(): void {
    if (this.released) return;
    const w = this.win;
    const top = w.destroyed ? null : w.top();
    const overlay = top && top.mapped ? this.site.overlay(top) : null;
    const [ox, oy] = w.parent && !w.destroyed ? w.topOrigin() : [0, 0];
    const region = overlay ? visibleInTop(w) : [];
    this.x = ox; this.y = oy;
    this.clip = region.map((r) => ({ x: r.x - ox, y: r.y - oy, w: r.w, h: r.h }));
    this.visible = this.clip.length > 0;
    const c = this.canvas;
    if (c) {
      if (overlay && c.parentElement !== overlay) {
        // above the X pixels (the overlay's canvas), below DOM text
        const base = overlay.querySelector(':scope > canvas:not([data-gl-surface])');
        overlay.insertBefore(c, base ? base.nextSibling : overlay.firstChild);
      } else if (!overlay && c.parentElement) c.remove();
      const s = this.site.scale || 1;
      if (c.width !== w.width) c.width = w.width;
      if (c.height !== w.height) c.height = w.height;
      Object.assign(c.style, {
        display: this.visible ? 'block' : 'none',
        left: `${ox / s}px`, top: `${oy / s}px`, width: `${w.width / s}px`, height: `${w.height / s}px`,
        clipPath: this.clip.length === 1 && this.clip[0].x === 0 && this.clip[0].y === 0 && this.clip[0].w === w.width && this.clip[0].h === w.height
          ? '' : `path('${this.clip.map((r) => `M${r.x / s} ${r.y / s}h${r.w / s}v${r.h / s}h${-r.w / s}Z`).join('')}')`,
      });
    }
    const key = `${ox},${oy},${w.width},${w.height},${this.clip.map((r) => `${r.x} ${r.y} ${r.w} ${r.h}`).join(';')}`;
    if (key !== this.key) { this.key = key; for (const cb of [...this.changeCbs]) cb(); }
  }

  destroyed(): void {
    if (this.released) return;
    for (const cb of [...this.destroyCbs]) cb();
    this.release();
  }

  onChange(cb: () => void): () => void { this.changeCbs.add(cb); return () => this.changeCbs.delete(cb); }
  onDestroy(cb: () => void): () => void { this.destroyCbs.add(cb); return () => this.destroyCbs.delete(cb); }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.canvas?.remove();
    this.changeCbs.clear(); this.destroyCbs.clear();
    this.onRelease(this);
  }
}
