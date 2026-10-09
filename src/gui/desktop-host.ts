/**
 * Window host on the desktop shell (unix/desktop, docs/DESKTOP.md): each X
 * toplevel is a desktop window with `content: {kind: 'surface'}`, so it gets
 * the desktop's frame, dock entry, focus, tiling and shortcuts. Surfaces run
 * at scale 1 (one X pixel per CSS px) without auto-resize: the X client
 * redraws at the new size and rootless.ts sets the buffer.
 */
import type { DesktopAPI, DesktopWindow, Surface } from '../desktop/wm';
import type { CanvasWindow, CanvasWindowEvents, CanvasWindowOptions, GuiInputEvent, WindowHost } from './window-host';

/** Height of the desktop's title bar (docs/DESKTOP.md: "the title bar adds 38 px"). */
const TITLE_H = 38;

export function createDesktopHost(d: DesktopAPI): WindowHost {
  return {
    name: 'desktop',
    desktopSize: () => { const g = d.workArea(); return { width: Math.round(g.width), height: Math.round(g.height) }; },
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

  constructor(d: DesktopAPI, opts: CanvasWindowOptions) {
    this.decorated = opts.decorated;
    const parent = opts.transientFor instanceof DesktopCanvasWindow ? opts.transientFor.win.id : undefined;
    this.win = d.createWindow({
      title: opts.title,
      appId: opts.appId ? `x11-${opts.appId}` : 'x11',
      width: opts.width,
      height: opts.height,
      x: opts.x,
      y: opts.decorated ? opts.y - TITLE_H : opts.y,
      content: { kind: 'surface', scale: 1, autoResize: false, bufferWidth: opts.width, bufferHeight: opts.height },
      override: !!opts.override,
      decorations: opts.decorated || opts.override ? 'server' : 'none',
      transientFor: parent,
      resizable: opts.resizable !== false,
      minWidth: opts.minWidth,
      minHeight: opts.minHeight,
      focus: !opts.override,
      onClose: () => {
        if (this.closing) return true;
        this.emit('close');
        return false;
      },
    } as never);
    this.surface = this.win.surface!;
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

  position(): { x: number; y: number } {
    const g = this.win.geometry();
    return { x: Math.round(g.x), y: Math.round(g.y + (this.decorated ? TITLE_H : 0)) };
  }

  setGeometry(g: { x?: number; y?: number; width?: number; height?: number }, fromUser = false): void {
    if (g.width !== undefined || g.height !== undefined) {
      const w = g.width ?? this.surface.width, h = g.height ?? this.surface.height;
      if (w !== this.surface.width || h !== this.surface.height || !fromUser) {
        this.surface.setBufferSize(w, h, !fromUser && this.win.state === 'normal');
      }
    }
    if (g.x !== undefined || g.y !== undefined) {
      const p = this.position();
      const x = g.x ?? p.x, y = g.y ?? p.y;
      if (x !== p.x || y !== p.y) this.win.move(x, this.decorated ? y - TITLE_H : y);
    }
  }

  present(img: ImageData, dx: number, dy: number, dirty?: { x: number; y: number; w: number; h: number }): void {
    this.ctx ??= this.surface.canvas.getContext('2d');
    if (!this.ctx) return;
    if (dirty) this.ctx.putImageData(img, dx, dy, dirty.x, dirty.y, dirty.w, dirty.h);
    else this.ctx.putImageData(img, dx, dy);
  }

  setTitle(title: string): void { this.win.setTitle(title); }
  show(): void { if (this.win.state === 'minimized') this.win.restore(); }
  hide(): void { /* rootless destroys unmapped windows instead */ }
  activate(): void { this.win.focus(); }
  setCursor(css: string): void { this.surface.setCursor(css); }
  destroy(): void {
    this.closing = true;
    if (this.win.state !== 'closed') this.win.close(true);
  }
}
