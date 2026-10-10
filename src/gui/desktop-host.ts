/**
 * Window host on the desktop shell (unix/desktop, docs/DESKTOP.md): each X
 * toplevel is a desktop window with `content: {kind: 'surface'}`, so it gets
 * the desktop's frame, dock entry, focus, tiling and shortcuts. X pixels are
 * device pixels (display-scale.ts): a surface's buffer is the X window and
 * its canvas is exactly buffer ÷ scale CSS px, never stretched (when the
 * desktop makes the window bigger than the client's size, e.g. a terminal
 * snapping to whole cells, the rest is background). No auto-resize: the X
 * client redraws at the new size and rootless.ts sets the buffer.
 */
import type { DesktopAPI, DesktopWindow, Surface, WindowOptions } from '../desktop/wm';
import type { CanvasWindow, CanvasWindowEvents, CanvasWindowOptions, GuiInputEvent, WindowHost } from './window-host';
import { displayScale } from './display-scale';

/** Height of the desktop's title bar (docs/DESKTOP.md: "the title bar adds 38 px"). */
const TITLE_H = 38;

export function createDesktopHost(d: DesktopAPI): WindowHost {
  return {
    name: 'desktop',
    scale: displayScale(),
    desktopSize: () => { const g = d.workArea(), s = displayScale(); return { width: Math.round(g.width * s), height: Math.round(g.height * s) }; },
    createCanvasWindow: (opts) => new DesktopCanvasWindow(d, opts),
  };
}

class DesktopCanvasWindow implements CanvasWindow {
  readonly win: DesktopWindow;
  private surface: Surface;
  private handlers: Partial<{ [K in keyof CanvasWindowEvents]: CanvasWindowEvents[K][] }> = {};
  private ctx: CanvasRenderingContext2D | null = null;
  private decorated: boolean;
  private closing = false;
  private readonly scale = displayScale();

  constructor(d: DesktopAPI, opts: CanvasWindowOptions) {
    this.decorated = opts.decorated;
    const s = this.scale;
    const parent = opts.transientFor instanceof DesktopCanvasWindow ? opts.transientFor.win.id : undefined;
    const options: WindowOptions = {
      title: opts.title,
      appId: opts.appId || 'x11',
      width: opts.width / s,
      height: opts.height / s,
      x: opts.x === undefined ? undefined : opts.x / s,
      y: opts.y === undefined ? undefined : opts.y / s - (opts.decorated ? TITLE_H : 0),
      content: { kind: 'surface', scale: s, autoResize: false, bufferWidth: opts.width, bufferHeight: opts.height },
      override: !!opts.override,
      decorations: opts.decorated || opts.override ? 'server' : 'none',
      transientFor: parent,
      resizable: opts.resizable !== false,
      minWidth: opts.minWidth === undefined ? undefined : opts.minWidth / s,
      minHeight: opts.minHeight === undefined ? undefined : opts.minHeight / s,
      focus: !opts.override,
      onClose: () => {
        if (this.closing) return true;
        this.emit('close');
        return false;
      },
    };
    this.win = d.createWindow(options);
    this.surface = this.win.surface!;
    // whole device pixels: no smoothing even where a size rounds
    if (Number.isInteger(s)) this.surface.canvas.style.imageRendering = 'pixelated';
    this.fitCanvas();
    this.surface.onConfigure((w, h) => this.emit('resize', w, h));
    this.win.on('move', () => { const p = this.position(); this.emit('move', p.x, p.y); });
    this.win.on('focus', () => this.emit('focus'));
    this.win.on('blur', () => this.emit('blur'));
  }

  private emit<K extends keyof CanvasWindowEvents>(ev: K, ...args: Parameters<CanvasWindowEvents[K]>): void {
    for (const cb of this.handlers[ev] ?? []) (cb as (...a: unknown[]) => void)(...args);
  }

  on<K extends keyof CanvasWindowEvents>(ev: K, cb: CanvasWindowEvents[K]): void {
    (this.handlers[ev] ??= [] as never[]).push(cb as never);
  }

  onInput(cb: (e: GuiInputEvent) => void): void { this.surface.onInput(cb as never); }

  /** The canvas shows the buffer 1:1 on the screen: buffer ÷ scale CSS px, top left */
  private fitCanvas(): void {
    const c = this.surface.canvas;
    c.style.width = `${c.width / this.scale}px`;
    c.style.height = `${c.height / this.scale}px`;
  }

  position(): { x: number; y: number } {
    const g = this.win.geometry(), s = this.scale;
    return { x: Math.round(g.x * s), y: Math.round((g.y + (this.decorated ? TITLE_H : 0)) * s) };
  }

  setGeometry(g: { x?: number; y?: number; width?: number; height?: number }, fromUser = false): void {
    if (g.width !== undefined || g.height !== undefined) {
      const w = g.width ?? this.surface.width, h = g.height ?? this.surface.height;
      if (w !== this.surface.width || h !== this.surface.height || !fromUser) {
        this.surface.setBufferSize(w, h, !fromUser && this.win.state === 'normal');
        this.fitCanvas();
      }
    }
    if (g.x !== undefined || g.y !== undefined) {
      const p = this.position();
      const x = g.x ?? p.x, y = g.y ?? p.y;
      if (x !== p.x || y !== p.y) this.win.move(x / this.scale, y / this.scale - (this.decorated ? TITLE_H : 0));
    }
  }

  present(img: ImageData, dx: number, dy: number, dirty?: { x: number; y: number; w: number; h: number }): void {
    this.ctx ??= this.surface.canvas.getContext('2d');
    if (!this.ctx) return;
    if (dirty) this.ctx.putImageData(img, dx, dy, dirty.x, dirty.y, dirty.w, dirty.h);
    else this.ctx.putImageData(img, dx, dy);
  }

  setTitle(title: string): void { this.win.setTitle(title); }
  overlay(): HTMLElement { return this.surface.canvas.parentElement!; }
  show(): void { if (this.win.state === 'minimized') this.win.restore(); }
  hide(): void { /* rootless destroys unmapped windows instead */ }
  activate(): void {
    // createWindow() already focused a new window, before the X side listened:
    // say so again, or the client never gets the focus until it is clicked
    const was = this.win.focused;
    this.win.focus();
    if (was) this.emit('focus');
  }
  setCursor(css: string): void { this.surface.setCursor(css); }
  destroy(): void {
    this.closing = true;
    if (this.win.state !== 'closed') this.win.close(true);
  }
}
