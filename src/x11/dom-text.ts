/**
 * DOM-text mode (docs/DOM-RENDERING.md): core X text (ImageText/PolyText)
 * shown as positioned <span>s over a window's canvas instead of glyph
 * pixels, so it is sharp at any scale, selectable and readable by assistive
 * tech. The server reports each run (XServer.domText, hooks.text) and paints
 * everything else as usual; this layer keeps the spans in step with the
 * pixels: drawing over a span's area removes it, CopyArea (scrolling) moves
 * the spans it carries. Hold Alt to select text with the mouse.
 *
 * Turned on with `xserver text dom|overlay`, `?xtext=dom|overlay` in the page
 * URL, or localStorage `shiro-x-dom-text`; it applies to text drawn from then
 * on. `overlay` keeps the glyph pixels and makes the spans transparent (the
 * PDF.js text-layer model): pixel-exact, still selectable and accessible.
 */
import type { TextRun } from './server';

/** How core X text is shown: glyph pixels (default), DOM spans instead of glyphs, or pixels with transparent spans over them */
export type DomTextMode = 'pixels' | 'dom' | 'overlay';

let mode: DomTextMode | null = null;

export function domTextMode(): DomTextMode {
  if (mode === null) {
    let m: string | null = null;
    try { m = /[?&]xtext=(dom|overlay|pixels)\b/.exec(location.search)?.[1] ?? localStorage.getItem('shiro-x-dom-text'); } catch { /* no page */ }
    mode = m === '1' ? 'dom' : m === 'dom' || m === 'overlay' ? m : 'pixels';
  }
  return mode;
}

export function setDomTextMode(m: DomTextMode, persist = false): void {
  mode = m;
  if (persist) { try { localStorage.setItem('shiro-x-dom-text', m); } catch { /* none */ } }
}

interface Span { el: HTMLSpanElement; x: number; y: number; w: number; h: number; run: TextRun }
interface Rect { x: number; y: number; w: number; h: number }

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a: Rect, b: Rect) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;

let measureCtx: CanvasRenderingContext2D | null = null;

/** CSS for an XLFD (or an alias like "fixed", "6x13"): monospace unless the font is proportional */
function cssFont(name: string, px: number): string {
  if (name === 'pango') return `400 ${px}px Inter, sans-serif`;
  const f = name.split('-');
  const xlfd = f.length >= 14;
  const mono = !xlfd || /^[cm]$/i.test(f[11]);
  const bold = xlfd && /bold|demi/i.test(f[3]);
  const italic = xlfd && /^[io]$/i.test(f[4]);
  return `${italic ? 'italic ' : ''}${bold ? '700 ' : '400 '}${px}px ${mono ? "'JetBrains Mono', monospace" : "Inter, sans-serif"}`;
}

/** Fixed cell width of a run (every glyph the same advance), or 0 */
const cellWidth = (run: TextRun) => {
  const c = run.text.length ? run.width / run.text.length : 0;
  return Number.isInteger(c) && /-[cm]-\d+-|^fixed$|^\d+x\d+/i.test(run.font) ? c : 0;
};

const cssColor = (pixel: number) => `#${(pixel & 0xffffff).toString(16).padStart(6, '0')}`;

/**
 * Clicks belong to the X app, so the spans ignore the pointer, except while
 * Alt is held: then they take it and the text can be selected and copied.
 */
let selectWired = false;
function wireSelection(): void {
  if (selectWired || typeof document === 'undefined') return;
  selectWired = true;
  const style = document.createElement('style');
  style.textContent = '.shiro-x11-selecting .shiro-x11-text{pointer-events:auto!important;cursor:text}' +
    // transparent (overlay) text still shows what is selected
    '.shiro-x11-text ::selection{background:rgba(70,120,255,.35)}';
  document.head.appendChild(style);
  const set = (on: boolean) => document.documentElement.classList.toggle('shiro-x11-selecting', on);
  window.addEventListener('keydown', (e) => { if (e.key === 'Alt') set(true); }, true);
  window.addEventListener('keyup', (e) => { if (e.key === 'Alt') set(false); }, true);
  window.addEventListener('blur', () => set(false));
  // the window frame focuses its canvas on pointerdown, which would cancel the selection starting here
  const keep = (e: Event) => {
    if (document.documentElement.classList.contains('shiro-x11-selecting') && (e.target as Element | null)?.closest?.('.shiro-x11-text')) e.stopPropagation();
  };
  window.addEventListener('pointerdown', keep, true);
  window.addEventListener('mousedown', keep, true);
}

export class TextLayer {
  readonly el: HTMLDivElement;
  private spans: Span[] = [];
  private moving: Span[] = [];

  /** `scale`: X (device) pixels per CSS px; `transparent`: the glyphs are pixels underneath */
  constructor(parent: HTMLElement, private scale: number, private transparent = false) {
    const el = document.createElement('div');
    el.className = 'shiro-x11-text';
    el.style.cssText = 'position:absolute;left:0;top:0;right:0;bottom:0;overflow:hidden;pointer-events:none;user-select:text;-webkit-user-select:text;white-space:pre';
    el.setAttribute('role', 'document');
    // selecting focuses the layer; the window frame would move focus to its canvas (ending the selection)
    el.tabIndex = -1;
    el.style.outline = 'none';
    el.addEventListener('focusin', (e) => e.stopPropagation());
    parent.appendChild(el);
    this.el = el;
    wireSelection();
  }

  add(run: TextRun): void {
    if (!run.text.trim() && run.bg !== null) return; // ImageText of blanks: only its background, already painted
    const h = run.ascent + run.descent;
    const rect = { x: run.x, y: run.y - run.ascent, w: run.width, h };
    // A run replaces the text it is drawn over in its window (PolyText has no background, but redraws the same text)
    this.drop(rect, true, run.win === undefined ? undefined : (id) => id === run.win);
    // Terminals draw a line in pieces (each typed character; blank cells skipped): continue the
    // run it extends, so a line is one span and selecting it copies words with their spaces
    const cell = cellWidth(run);
    const prev = cell ? this.spans.find((sp) => sp.y === rect.y && sp.h === h && sp.run.font === run.font && sp.run.fg === run.fg && sp.run.win === run.win &&
      cellWidth(sp.run) === cell && sp.x + sp.w <= run.x && (run.x - (sp.x + sp.w)) % cell === 0 && run.x - (sp.x + sp.w) <= 8 * cell) : undefined;
    if (prev) {
      const gap = (run.x - (prev.x + prev.w)) / cell;
      this.remove(prev);
      return this.add({ ...prev.run, text: prev.run.text + ' '.repeat(gap) + run.text, width: run.x + run.width - prev.x });
    }
    this.span(run);
  }

  private span(run: TextRun): void {
    const s = this.scale, h = run.ascent + run.descent;
    const el = document.createElement('span');
    // X font height is ascent + descent; an outline font's line box is ~1.17 em
    const px = Math.max(1, Math.round((h / s) / 1.17 * 4) / 4);
    const font = cssFont(run.font, px);
    measureCtx ??= document.createElement('canvas').getContext('2d');
    let spacing = 0;
    if (measureCtx && run.text.length) {
      measureCtx.font = font;
      spacing = (run.width / s - measureCtx.measureText(run.text).width) / run.text.length;
    }
    // a line break at the end (not visible: the box is one line high) so copied text keeps its lines
    el.textContent = run.text + '\n';
    el.style.cssText = `position:absolute;left:${run.x / s}px;top:${(run.y - run.ascent) / s}px;height:${h / s}px;` +
      `font:${font};line-height:${h / s}px;letter-spacing:${spacing.toFixed(3)}px;color:${cssColor(run.fg)}` +
      // overlay: invisible glyphs (the pixels show them) but a real colour, so selections are painted
      (this.transparent || run.overlay ? ';-webkit-text-fill-color:transparent' : '');
    this.el.appendChild(el);
    this.spans.push({ el, x: run.x, y: run.y - run.ascent, w: run.width, h, run });
  }

  private remove(sp: Span): void {
    sp.el.remove();
    this.spans.splice(this.spans.indexOf(sp), 1);
  }

  /**
   * Pixels in `r` (toplevel coordinates) were drawn: the text there is gone.
   * `covers(id)`: whether that drawing covers text drawn on window `id` (default: all text).
   */
  damage(r: Rect, covers?: (win: number) => boolean): void { this.drop(r, false, covers); }

  /** Remove the text under `r`; a fixed-cell run keeps the cells left and right of it. */
  private drop(r: Rect, sameLineOnly: boolean, covers?: (win: number) => boolean): void {
    for (const sp of this.spans.filter((sp) => overlaps(sp, r) && (!sameLineOnly || sp.y === r.y) && (!covers || sp.run.win === undefined || covers(sp.run.win)))) {
      this.remove(sp);
      const cell = cellWidth(sp.run);
      if (!cell) continue;
      const c0 = Math.floor((r.x - sp.x) / cell), c1 = Math.ceil((r.x + r.w - sp.x) / cell);
      const left = sp.run.text.slice(0, Math.max(0, c0)), right = sp.run.text.slice(Math.max(0, c1));
      if (left.trim()) this.span({ ...sp.run, text: left, width: left.length * cell });
      if (right.trim() && c1 > 0) this.span({ ...sp.run, text: right, x: sp.x + c1 * cell, width: right.length * cell });
    }
  }

  /** CopyArea from (sx, sy) to (dx, dy): the spans wholly inside the source move with the pixels. */
  copyBegin(sx: number, sy: number, w: number, h: number, dx: number, dy: number, win?: number): void {
    const src = { x: sx, y: sy, w, h };
    this.moving = [];
    this.spans = this.spans.filter((sp) => {
      if (!inside(sp, src) || (win !== undefined && sp.run.win !== undefined && sp.run.win !== win)) return true;
      sp.x += dx - sx; sp.y += dy - sy;
      this.moving.push(sp);
      return false;
    });
  }

  copyEnd(): void {
    const s = this.scale;
    for (const sp of this.moving) {
      sp.el.style.left = `${sp.x / s}px`;
      sp.el.style.top = `${sp.y / s}px`;
      this.spans.push(sp);
    }
    this.moving = [];
  }

  /** The text of all spans, top to bottom (tests, accessibility checks). */
  text(): string {
    return [...this.spans].sort((a, b) => a.y - b.y || a.x - b.x).map((s) => s.run.text).join('\n');
  }

  get size(): number { return this.spans.length; }

  destroy(): void { this.el.remove(); this.spans = []; }
}
