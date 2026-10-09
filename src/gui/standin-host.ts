/**
 * Stand-in window host for the classic (full-page terminal) UI, where there
 * is no desktop: floating DOM windows with a title bar, a traffic-light
 * close button, drag to move and a corner grip to resize, holding a canvas.
 * Implements src/gui/window-host.ts; on the desktop, desktop-host.ts is used.
 * Geometry is in X (device) pixels, shown at ÷ displayScale() CSS px.
 */
import { inputEvent, type CanvasWindow, type CanvasWindowEvents, type CanvasWindowOptions, type GuiInputEvent, type WindowHost } from './window-host';
import { displayScale } from './display-scale';

const TITLE_H = 28;
let zTop = 100000;
let cascade = 0;

export function createStandinHost(root: HTMLElement = document.body): WindowHost {
  return {
    name: 'standin',
    scale: displayScale(),
    desktopSize: () => { const s = displayScale(); return { width: Math.round(Math.max(640, window.innerWidth) * s), height: Math.round(Math.max(480, window.innerHeight) * s) }; },
    placeWindow: createStandinPlacement,
    createCanvasWindow: (opts) => new StandinWindow(root, opts),
  };
}

/** A cascaded spot for a window of this X size, in X pixels. */
function createStandinPlacement(width: number, height: number): { x: number; y: number } {
  const s = displayScale();
  const vw = window.innerWidth, vh = window.innerHeight, w = width / s, h = height / s;
  const step = (cascade++ % 8) * 28;
  return {
    x: Math.round(Math.max(8, Math.min(vw - w - 8, Math.round((vw - w) / 2) - 120 + step)) * s),
    y: Math.round(Math.max(TITLE_H + 8, Math.min(vh - h - 8, Math.round((vh - h) / 3) + step)) * s),
  };
}

class StandinWindow implements CanvasWindow {
  readonly canvas: HTMLCanvasElement;
  private frame: HTMLDivElement;
  private titleEl: HTMLSpanElement | null = null;
  private handlers: Partial<{ [K in keyof CanvasWindowEvents]: CanvasWindowEvents[K][] }> = {};
  private inputs: ((e: GuiInputEvent) => void)[] = [];
  private ctx: CanvasRenderingContext2D | null = null;
  private x: number;
  private y: number;
  private w: number;
  private h: number;
  private readonly s = displayScale();
  private wrap: HTMLDivElement;

  constructor(root: HTMLElement, private opts: CanvasWindowOptions) {
    this.w = opts.width; this.h = opts.height;
    const auto = opts.x === undefined || opts.y === undefined ? createStandinPlacement(opts.width, opts.height) : null;
    this.x = opts.x ?? auto!.x; this.y = opts.y ?? auto!.y;
    const f = document.createElement('div');
    f.className = 'shiro-x11-window';
    f.dataset.x11Window = opts.title;
    const S = f.style;
    S.position = 'fixed';
    S.zIndex = String(opts.override ? 2147483000 : ++zTop);
    S.display = 'none';
    S.flexDirection = 'column';
    if (opts.decorated) {
      S.borderRadius = '8px';
      S.overflow = 'hidden';
      S.boxShadow = '0 10px 30px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.12)';
      S.background = '#1e1e24';
      const bar = document.createElement('div');
      bar.style.cssText = `height:${TITLE_H}px;display:flex;align-items:center;gap:8px;padding:0 10px;background:linear-gradient(#3a3a42,#2c2c33);color:#ddd;font:13px -apple-system,BlinkMacSystemFont,sans-serif;user-select:none;cursor:default;flex:none`;
      const dot = (color: string, title: string) => {
        const d = document.createElement('span');
        d.title = title;
        d.style.cssText = `width:12px;height:12px;border-radius:50%;background:${color};flex:none;display:inline-block`;
        return d;
      };
      const close = dot('#ff5f57', 'Close');
      close.style.cursor = 'pointer';
      close.addEventListener('pointerdown', (e) => e.stopPropagation());
      close.addEventListener('click', () => this.emit('close'));
      bar.append(close, dot('#febc2e', ''), dot('#28c840', ''));
      const t = document.createElement('span');
      t.style.cssText = 'flex:1;text-align:center;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;margin-right:56px';
      t.textContent = opts.title;
      this.titleEl = t;
      bar.append(t);
      f.append(bar);
      this.dragMove(bar);
    }
    const c = document.createElement('canvas');
    c.width = opts.width; c.height = opts.height;
    c.tabIndex = 0;
    c.style.cssText = `display:block;width:${opts.width / this.s}px;height:${opts.height / this.s}px;outline:none;touch-action:none`;
    if (Number.isInteger(this.s)) c.style.imageRendering = 'pixelated';
    this.canvas = c;
    // positioned, so DOM layers (overlay()) can sit on the canvas
    this.wrap = document.createElement('div');
    this.wrap.style.position = 'relative';
    this.wrap.append(c);
    f.append(this.wrap);
    if (opts.decorated && opts.resizable !== false) this.addResizeGrip(f);
    if (!opts.override) f.addEventListener('pointerdown', () => this.activate(), true);
    this.wireInput(c);
    this.frame = f;
    this.place();
    root.append(f);
  }

  private wireInput(c: HTMLCanvasElement): void {
    const pos = (e: MouseEvent) => {
      const r = c.getBoundingClientRect();
      return { x: Math.round((e.clientX - r.left) * (c.width / Math.max(1, r.width))), y: Math.round((e.clientY - r.top) * (c.height / Math.max(1, r.height))) };
    };
    const send = (e: GuiInputEvent) => { for (const cb of this.inputs) cb(e); };
    for (const type of ['pointerdown', 'pointerup', 'pointermove'] as const) {
      c.addEventListener(type, (e) => {
        if (type === 'pointerdown') {
          e.preventDefault();
          if (!this.opts.override) c.focus({ preventScroll: true });
          try { c.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
        }
        send(inputEvent(type, e, pos(e)));
      });
    }
    c.addEventListener('pointerenter', (e) => send(inputEvent('enter', e, pos(e))));
    c.addEventListener('pointerleave', (e) => send(inputEvent('leave', e, pos(e))));
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      send(inputEvent('wheel', e, { ...pos(e), deltaX: e.deltaX * k, deltaY: e.deltaY * k }));
    }, { passive: false });
    for (const type of ['keydown', 'keyup'] as const) {
      c.addEventListener(type, (e) => {
        e.preventDefault(); e.stopPropagation();
        send(inputEvent(type, e));
      });
    }
    c.addEventListener('focus', () => { send(inputEvent('focus', null)); this.emit('focus'); });
    c.addEventListener('blur', () => { send(inputEvent('blur', null)); this.emit('blur'); });
  }

  private place(): void {
    const S = this.frame.style;
    S.left = `${this.x / this.s}px`;
    S.top = `${this.y / this.s - (this.opts.decorated ? TITLE_H : 0)}px`;
    S.width = `${this.w / this.s}px`;
  }

  private dragMove(bar: HTMLElement): void {
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY, ox = this.x, oy = this.y;
      bar.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        this.x = Math.round(ox + (ev.clientX - sx) * this.s);
        this.y = Math.max(Math.round(TITLE_H * this.s), Math.round(oy + (ev.clientY - sy) * this.s));
        this.place();
      };
      const up = () => {
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        this.emit('move', this.x, this.y);
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
    });
  }

  private addResizeGrip(f: HTMLElement): void {
    const g = document.createElement('div');
    g.style.cssText = 'position:absolute;right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize;z-index:2';
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const sx = e.clientX, sy = e.clientY, ow = this.w, oh = this.h;
      g.setPointerCapture(e.pointerId);
      const o = this.opts;
      const move = (ev: PointerEvent) => {
        const w = Math.max(o.minWidth ?? 32, Math.round(ow + (ev.clientX - sx) * this.s));
        const h = Math.max(o.minHeight ?? 24, Math.round(oh + (ev.clientY - sy) * this.s));
        if (w !== this.w || h !== this.h) this.emit('resize', w, h);
      };
      const up = () => { g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); };
      g.addEventListener('pointermove', move);
      g.addEventListener('pointerup', up);
    });
    f.append(g);
  }

  private emit<K extends keyof CanvasWindowEvents>(ev: K, ...args: Parameters<CanvasWindowEvents[K]>): void {
    for (const cb of this.handlers[ev] ?? []) (cb as (...a: unknown[]) => void)(...args);
  }

  on<K extends keyof CanvasWindowEvents>(ev: K, cb: CanvasWindowEvents[K]): void {
    (this.handlers[ev] ??= [] as never[]).push(cb as never);
  }

  onInput(cb: (e: GuiInputEvent) => void): void { this.inputs.push(cb); }

  present(img: ImageData, dx: number, dy: number, dirty?: { x: number; y: number; w: number; h: number }): void {
    this.ctx ??= this.canvas.getContext('2d');
    if (!this.ctx) return;
    if (dirty) this.ctx.putImageData(img, dx, dy, dirty.x, dirty.y, dirty.w, dirty.h);
    else this.ctx.putImageData(img, dx, dy);
  }

  setTitle(title: string): void {
    if (this.titleEl) this.titleEl.textContent = title;
    this.frame.dataset.x11Window = title;
  }

  setGeometry(g: { x?: number; y?: number; width?: number; height?: number }): void {
    if (g.x !== undefined) this.x = g.x;
    if (g.y !== undefined) this.y = g.y;
    if (g.width !== undefined || g.height !== undefined) {
      this.w = g.width ?? this.w; this.h = g.height ?? this.h;
      if (this.canvas.width !== this.w) this.canvas.width = this.w;
      if (this.canvas.height !== this.h) this.canvas.height = this.h;
      this.canvas.style.width = `${this.w / this.s}px`;
      this.canvas.style.height = `${this.h / this.s}px`;
    }
    this.place();
  }

  position() { return { x: this.x, y: this.y }; }
  show(): void { this.frame.style.display = 'flex'; }
  hide(): void { this.frame.style.display = 'none'; }
  activate(): void {
    if (this.opts.override) return;
    this.frame.style.zIndex = String(++zTop);
    if (document.activeElement !== this.canvas) this.canvas.focus({ preventScroll: true });
  }
  setCursor(css: string): void { this.canvas.style.cursor = css; }
  overlay(): HTMLElement { return this.wrap; }
  destroy(): void { this.frame.remove(); }
}
