/**
 * Desktop window manager: the stable API every window on the desktop goes
 * through (the desktop's own apps, the terminal, and native GUI programs
 * from the display server on unix/gui). Contract: docs/DESKTOP.md. Keep it
 * additive: new options and methods are fine, renames and removals are not.
 *
 * The page reaches it as `window.__shiro.desktop` (also
 * `globalThis.__shiroDesktop`), or by importing `getDesktop()`.
 *
 * Content kinds a window can hold:
 *   dom      an element the caller fills (win.body)
 *   iframe   a URL or srcdoc
 *   terminal a Shiro terminal on a pty (registered by the desktop shell)
 *   surface  a canvas fed by a native GUI client (frames in, input out)
 * More kinds can be added with `registerContentKind`.
 */

export const DESKTOP_API_VERSION = 1;

export type WindowState = 'normal' | 'minimized' | 'maximized' | 'snapped-left' | 'snapped-right'
  | 'snapped-top-left' | 'snapped-top-right' | 'snapped-bottom-left' | 'snapped-bottom-right' | 'closed';

/** Where `snap()` puts a window: a half or a quarter of the work area */
export type SnapSide = 'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface Geometry { x: number; y: number; width: number; height: number }

export type WindowContent =
  | { kind: 'dom'; element?: HTMLElement }
  | { kind: 'iframe'; src?: string; srcdoc?: string; sandbox?: string; allow?: string }
  | { kind: 'terminal'; command?: string; cwd?: string; [k: string]: unknown }
  | ({ kind: 'surface' } & SurfaceOptions)
  | { kind: string; [k: string]: unknown };

export interface WindowOptions {
  /** Stable id (letters, digits, - and _). Generated ("w1", "w2", ...) when omitted. */
  id?: string;
  title?: string;
  /** App the window belongs to: groups windows in the dock and the menu bar. */
  appId?: string;
  /** Inline SVG markup or an image URL, for the dock when the app has no icon of its own. */
  icon?: string;
  content?: WindowContent;
  /** Client area size in CSS px (the frame adds the title bar). Default: about 60% of the work area. */
  width?: number;
  height?: number;
  /** Top-left of the frame in work-area coordinates. Default: centered, cascading. */
  x?: number;
  y?: number;
  minWidth?: number;
  minHeight?: number;
  /** Default true. */
  resizable?: boolean;
  /**
   * 'server' (default): the desktop draws the title bar and traffic lights.
   * 'none': no frame at all; the client draws its own (client-side
   * decorations) and can start moves/resizes with `beginMove`/`beginResize`.
   */
  decorations?: 'server' | 'none';
  /**
   * Override-redirect (X11 menus, tooltips, drag icons): no decorations, never
   * takes focus, not in the dock, positioned exactly where asked, above
   * normal windows.
   */
  override?: boolean;
  /** Parent window id (dialogs): stays above it and closes with it. */
  transientFor?: string;
  /** Keep above normal windows. */
  alwaysOnTop?: boolean;
  /** Leave out of the dock's running list and window cycling. */
  skipTaskbar?: boolean;
  /** Start maximized / minimized. */
  state?: 'normal' | 'maximized' | 'minimized';
  /** Take focus when shown. Default true (false for override windows). */
  focus?: boolean;
  /** Called before closing; return false to keep the window open. */
  onClose?: (win: DesktopWindow) => boolean | void;
}

export type WindowEvent = 'close' | 'focus' | 'blur' | 'move' | 'resize' | 'state' | 'title';

export interface DesktopWindow {
  readonly id: string;
  readonly appId: string | undefined;
  readonly kind: string;
  /** The whole frame (title bar + body). */
  readonly element: HTMLElement;
  /** The client area. For 'dom' windows, put content here. */
  readonly body: HTMLElement;
  /** The title bar's free area right of the title, for app buttons (absent with decorations: 'none'). */
  readonly titlebarExtra: HTMLElement | null;
  readonly options: Readonly<WindowOptions>;
  title: string;
  readonly state: WindowState;
  readonly focused: boolean;
  /** Set for 'iframe' windows. */
  readonly iframe?: HTMLIFrameElement;
  /** Set for 'surface' windows. */
  readonly surface?: Surface;
  /** Whatever the content kind's factory returned (the terminal view for 'terminal'). */
  readonly content?: unknown;
  setTitle(title: string): void;
  /** Frame geometry in work-area coordinates (x, y of the frame; width, height of the client area). */
  geometry(): Geometry;
  move(x: number, y: number): void;
  /** Resize the client area. */
  resize(width: number, height: number): void;
  setGeometry(g: Partial<Geometry>): void;
  focus(): void;
  minimize(): void;
  /** Back to normal from minimized / maximized / snapped. */
  restore(): void;
  maximize(): void;
  /** Toggle maximized (the green light). */
  zoom(): void;
  snap(side: SnapSide): void;
  /** Close (runs onClose first unless `force`). Returns false when vetoed. */
  close(force?: boolean): boolean;
  /** Start an interactive move from a pointerdown (client-side decorations). */
  beginMove(ev: PointerEvent): void;
  /** Start an interactive resize from a pointerdown; edges like 'se', 'n', 'w'. */
  beginResize(ev: PointerEvent, edges: string): void;
  /** Show a badge on the window (e.g. a busy spinner): '' clears. */
  setAttention(on: boolean): void;
  on(ev: WindowEvent, cb: (win: DesktopWindow) => void): () => void;
}

// ── Surfaces (native GUI clients) ────────────────────────────────────

export interface SurfaceOptions {
  /** Buffer size in device pixels the client renders at. Default: the client area times devicePixelRatio. */
  bufferWidth?: number;
  bufferHeight?: number;
  /** Device pixels per CSS px of the buffer (default window.devicePixelRatio). */
  scale?: number;
  /** CSS cursor while over the surface. */
  cursor?: string;
  /** Resize the buffer to follow the window automatically (default true). Off: the client handles onConfigure. */
  autoResize?: boolean;
}

export interface SurfaceInputEvent {
  type: 'pointerdown' | 'pointerup' | 'pointermove' | 'wheel' | 'keydown' | 'keyup' | 'enter' | 'leave' | 'focus' | 'blur';
  /** Buffer (device) pixel coordinates, for pointer events. */
  x: number;
  y: number;
  /** DOM button (0 left, 1 middle, 2 right) and buttons bitmask. */
  button: number;
  buttons: number;
  deltaX: number;
  deltaY: number;
  /** KeyboardEvent.key / .code; keyCode for X11-style mapping. */
  key: string;
  code: string;
  keyCode: number;
  repeat: boolean;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
  /** performance.now() */
  time: number;
}

export interface Surface {
  readonly canvas: HTMLCanvasElement;
  /** Current buffer size (device px). */
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  /** Draw a frame (or a damaged region at dx, dy) into the buffer. */
  present(src: CanvasImageSource | ImageData, dx?: number, dy?: number): void;
  /** Resize the buffer; with `resizeWindow` the window follows (client-initiated resize). */
  setBufferSize(width: number, height: number, resizeWindow?: boolean): void;
  setCursor(css: string): void;
  /** Input from the user, already in buffer coordinates. Returns unsubscribe. */
  onInput(cb: (ev: SurfaceInputEvent) => void): () => void;
  /** The window's client area changed size (user resize, maximize, snap). Buffer size in device px. */
  onConfigure(cb: (width: number, height: number, scale: number) => void): () => void;
}

// ── Apps ─────────────────────────────────────────────────────────────

export interface AppDescriptor {
  id: string;
  name: string;
  /** Inline SVG markup or an image URL. */
  icon?: string;
  /** Shown in the dock (default true for apps registered with a launcher). */
  dock?: boolean;
  /** Order in the dock (lower first). */
  order?: number;
  /** Opens a new window (or focuses an existing one). */
  launch: (args?: Record<string, unknown>) => DesktopWindow | null | Promise<DesktopWindow | null>;
  /** Menu bar menus while the app is focused, after the defaults. */
  menus?: () => MenuSpec[];
  /** Dock group (a stack that opens on tap) this app belongs to, see registerGroup. */
  group?: string;
}

/**
 * A dock stack: apps with `group: id` share one dock tile that opens into a
 * grid. 'always' keeps them stacked; 'auto' (default) stacks them when the
 * dock is crowded (phones) or the group has more than `maxLoose` apps.
 */
export interface DockGroup {
  id: string;
  name: string;
  order?: number;
  collapse?: 'always' | 'auto';
  /** With 'auto': stack once the group has more apps than this (default 4) */
  maxLoose?: number;
}

export interface MenuItem {
  label: string;
  /** Shortcut hint shown on the right ("Alt+Shift+W"). */
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
  action?: () => void;
}
export interface MenuSpec { title: string; items: (MenuItem | 'separator')[] }

/** Builds a content kind inside a fresh window. */
export type ContentFactory = (win: DesktopWindow, content: WindowContent, body: HTMLElement) => unknown;

export type DesktopEvent = 'window-created' | 'window-closed' | 'window-changed' | 'focus-changed' | 'apps-changed' | 'theme-changed';

export interface DesktopAPI {
  readonly version: number;
  createWindow(opts: WindowOptions): DesktopWindow;
  windows(): DesktopWindow[];
  get(id: string): DesktopWindow | undefined;
  focused(): DesktopWindow | null;
  /** Work area (between the menu bar and the dock) in page px. */
  workArea(): Geometry;
  registerContentKind(kind: string, factory: ContentFactory): void;
  registerApp(app: AppDescriptor): void;
  apps(): AppDescriptor[];
  /** Define (or redefine) a dock group. Additive (API v1.2). */
  registerGroup?(group: DockGroup): void;
  groups?(): DockGroup[];
  openApp(id: string, args?: Record<string, unknown>): Promise<DesktopWindow | null>;
  theme(): 'light' | 'dark';
  setTheme(pref: 'light' | 'dark' | 'system'): void;
  on(ev: DesktopEvent, cb: (win?: DesktopWindow) => void): () => void;
}

// ── Implementation ───────────────────────────────────────────────────

type Listener = (win: DesktopWindow) => void;

const prefersReducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const TITLEBAR_H = 38;
const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const SNAP_MARGIN = 6;

let instance: WindowManager | null = null;

/** The desktop, if this page booted one. */
export function getDesktop(): DesktopAPI | null {
  return instance;
}

export class WindowManager implements DesktopAPI {
  readonly version = DESKTOP_API_VERSION;
  /** Element windows live in (positioned over the whole page; work area excludes menu bar and dock). */
  readonly layer: HTMLElement;
  private wins = new Map<string, WindowImpl>();
  /** Bottom to top */
  private stack: WindowImpl[] = [];
  private focusedWin: WindowImpl | null = null;
  private nextId = 1;
  private cascade = 0;
  private kinds = new Map<string, ContentFactory>();
  private appMap = new Map<string, AppDescriptor>();
  private listeners = new Map<DesktopEvent, Set<(w?: DesktopWindow) => void>>();
  private themePref: 'light' | 'dark' | 'system';
  private snapPreview: HTMLElement;
  /** Returns the work area; set by the desktop shell (menu bar / dock heights). */
  workAreaFn: () => Geometry;
  /** Narrow screens: every window fills the work area. */
  compact = false;

  constructor(readonly root: HTMLElement, opts: { workArea: () => Geometry }) {
    instance = this;
    this.workAreaFn = opts.workArea;
    this.layer = document.createElement('div');
    this.layer.className = 'sd-layer';
    root.appendChild(this.layer);
    this.snapPreview = document.createElement('div');
    this.snapPreview.className = 'sd-snap-preview';
    this.layer.appendChild(this.snapPreview);
    let pref: string | null = null;
    try { pref = localStorage.getItem('shiro-desktop-theme'); } catch {}
    this.themePref = pref === 'light' || pref === 'dark' ? pref : 'system';
    this.applyTheme();
    if (typeof matchMedia === 'function') {
      matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (this.themePref === 'system') this.applyTheme(); });
    }
    this.kinds.set('dom', (_w, c, body) => { const el = (c as { element?: HTMLElement }).element; if (el) body.appendChild(el); return el; });
    this.kinds.set('iframe', (w, c, body) => {
      const o = c as { src?: string; srcdoc?: string; sandbox?: string; allow?: string };
      const f = document.createElement('iframe');
      f.className = 'sd-iframe';
      if (o.sandbox !== undefined) f.setAttribute('sandbox', o.sandbox);
      if (o.allow) f.allow = o.allow;
      if (o.srcdoc !== undefined) f.srcdoc = o.srcdoc; else if (o.src) f.src = o.src;
      body.appendChild(f);
      (w as WindowImpl).iframe = f;
      return f;
    });
    this.kinds.set('surface', (w, c, body) => {
      const s = new SurfaceImpl(w as WindowImpl, c as SurfaceOptions, body);
      (w as WindowImpl).surface = s;
      return s;
    });
    window.addEventListener('resize', () => this.relayout());
  }

  // ── DesktopAPI ──

  createWindow(opts: WindowOptions): DesktopWindow {
    let id = opts.id && /^[A-Za-z0-9_-]+$/.test(opts.id) && !this.wins.has(opts.id) ? opts.id : '';
    while (!id || this.wins.has(id)) id = 'w' + this.nextId++;
    const win = new WindowImpl(this, id, opts);
    this.wins.set(id, win);
    this.stack.push(win);
    this.layer.appendChild(win.element);
    this.restack();
    const content = opts.content ?? { kind: 'dom' };
    const factory = this.kinds.get(content.kind);
    if (!factory) throw new Error(`desktop: no content kind '${content.kind}'`);
    win.content = factory(win, content, win.body);
    if (opts.state === 'maximized' || this.compact) win.maximize(true);
    win.appear();
    if (opts.state === 'minimized') win.minimize();
    else if (opts.focus ?? !opts.override) win.focus();
    this.emit('window-created', win);
    return win;
  }

  windows(): DesktopWindow[] {
    return [...this.stack];
  }

  get(id: string): DesktopWindow | undefined {
    return this.wins.get(id);
  }

  focused(): DesktopWindow | null {
    return this.focusedWin;
  }

  workArea(): Geometry {
    return this.workAreaFn();
  }

  registerContentKind(kind: string, factory: ContentFactory): void {
    this.kinds.set(kind, factory);
  }

  registerApp(app: AppDescriptor): void {
    this.appMap.set(app.id, app);
    this.emit('apps-changed');
  }

  private groupMap = new Map<string, DockGroup>();

  registerGroup(group: DockGroup): void {
    this.groupMap.set(group.id, group);
    this.emit('apps-changed');
  }

  groups(): DockGroup[] {
    return [...this.groupMap.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  }

  apps(): AppDescriptor[] {
    return [...this.appMap.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  }

  app(id: string | undefined): AppDescriptor | undefined {
    return id ? this.appMap.get(id) : undefined;
  }

  async openApp(id: string, args?: Record<string, unknown>): Promise<DesktopWindow | null> {
    const app = this.appMap.get(id);
    if (!app) return null;
    return app.launch(args);
  }

  theme(): 'light' | 'dark' {
    if (this.themePref !== 'system') return this.themePref;
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  themePreference(): 'light' | 'dark' | 'system' {
    return this.themePref;
  }

  setTheme(pref: 'light' | 'dark' | 'system'): void {
    this.themePref = pref;
    try { localStorage.setItem('shiro-desktop-theme', pref); } catch {}
    this.applyTheme();
  }

  on(ev: DesktopEvent, cb: (win?: DesktopWindow) => void): () => void {
    let set = this.listeners.get(ev);
    if (!set) this.listeners.set(ev, set = new Set());
    set.add(cb);
    return () => { set!.delete(cb); };
  }

  // ── Internals ──

  emit(ev: DesktopEvent, win?: DesktopWindow): void {
    for (const cb of this.listeners.get(ev) ?? []) { try { cb(win); } catch (e) { console.error('[desktop]', e); } }
  }

  private applyTheme(): void {
    const t = this.theme();
    this.root.dataset.theme = t;
    document.documentElement.style.colorScheme = t;
    this.emit('theme-changed');
  }

  /** Windows that belong in the dock / cycling, top first. */
  visibleOrder(): WindowImpl[] {
    return [...this.stack].reverse().filter(w => !w.options.override && !w.options.skipTaskbar);
  }

  raise(win: WindowImpl): void {
    const i = this.stack.indexOf(win);
    if (i >= 0) this.stack.splice(i, 1);
    this.stack.push(win);
    // Transients stay above their parent
    for (const t of this.stack.filter(w => w.options.transientFor === win.id)) {
      this.stack.splice(this.stack.indexOf(t), 1);
      this.stack.push(t);
    }
    this.restack();
  }

  private restack(): void {
    let z = 10;
    const layer = (w: WindowImpl) => w.options.override ? 2 : w.options.alwaysOnTop ? 1 : 0;
    const ordered = [...this.stack].sort((a, b) => layer(a) - layer(b) || this.stack.indexOf(a) - this.stack.indexOf(b));
    for (const w of ordered) w.element.style.zIndex = String(z++);
  }

  setFocus(win: WindowImpl | null): void {
    if (this.focusedWin === win) return;
    const prev = this.focusedWin;
    this.focusedWin = win;
    if (prev && prev.state !== 'closed') { prev.element.classList.remove('sd-focused'); prev.fire('blur'); }
    if (win) { win.element.classList.add('sd-focused'); win.fire('focus'); }
    this.emit('focus-changed', win ?? undefined);
  }

  /** Focus the topmost window that can take focus (after a close or minimize). */
  focusTop(except?: WindowImpl): void {
    const next = [...this.stack].reverse().find(w => w !== except && w.state !== 'minimized' && w.state !== 'closed' && !w.options.override);
    if (next) next.focus(); else this.setFocus(null);
  }

  removeWindow(win: WindowImpl): void {
    this.wins.delete(win.id);
    const i = this.stack.indexOf(win);
    if (i >= 0) this.stack.splice(i, 1);
    if (this.focusedWin === win) { this.focusedWin = null; this.focusTop(win); }
    for (const t of [...this.stack]) if (t.options.transientFor === win.id) t.close(true);
    this.emit('window-closed', win);
  }

  /** Next position for a new window of this size. */
  placement(width: number, height: number): { x: number; y: number } {
    const wa = this.workArea();
    const step = 26;
    const off = (this.cascade++ % 6) * step;
    const x = Math.max(0, Math.round((wa.width - width) / 2) + off - step * 1.5);
    const y = Math.max(0, Math.round((wa.height - height - TITLEBAR_H) / 2.6) + off);
    return { x, y };
  }

  showSnapPreview(g: Geometry | null): void {
    if (!g) { this.snapPreview.classList.remove('sd-visible'); return; }
    const wa = this.workArea();
    Object.assign(this.snapPreview.style, { left: `${wa.x + g.x}px`, top: `${wa.y + g.y}px`, width: `${g.width}px`, height: `${g.height}px` });
    this.snapPreview.classList.add('sd-visible');
  }

  /** Geometry (frame, incl. title bar) of a snapped or maximized state. */
  stateGeometry(state: WindowState): Geometry | null {
    const wa = this.workArea();
    const gap = this.compact ? 0 : 6;
    const w = wa.width - gap * 2, h = wa.height - gap * 2;
    if (state === 'maximized') return { x: gap, y: gap, width: w, height: h };
    if (state === 'snapped-left') return { x: gap, y: gap, width: Math.floor((w - gap) / 2), height: h };
    if (state === 'snapped-right') { const half = Math.floor((w - gap) / 2); return { x: gap * 2 + half, y: gap, width: w - gap - half, height: h }; }
    const q = /^snapped-(top|bottom)-(left|right)$/.exec(state);
    if (q) {
      const hw = Math.floor((w - gap) / 2), hh = Math.floor((h - gap) / 2);
      const right = q[2] === 'right', bottom = q[1] === 'bottom';
      return { x: right ? gap * 2 + hw : gap, y: bottom ? gap * 2 + hh : gap, width: right ? w - gap - hw : hw, height: bottom ? h - gap - hh : hh };
    }
    return null;
  }

  relayout(): void {
    const compact = window.innerWidth <= 640;
    if (compact !== this.compact) {
      this.compact = compact;
      this.root.classList.toggle('sd-compact', compact);
      if (compact) for (const w of this.stack) if (!w.options.override && w.state === 'normal') w.maximize(true);
    }
    for (const w of this.stack) w.applyGeometry();
  }

  /** Cycle focus through windows (Alt+`). */
  cycle(back = false): void {
    // Top first. Raising the bottom one each time visits every window in turn.
    const list = this.visibleOrder().filter(w => w.state !== 'closed');
    if (!list.length) return;
    const next = back ? list[Math.min(1, list.length - 1)] : list[list.length - 1];
    next.focus();
  }
}

class WindowImpl implements DesktopWindow {
  readonly element: HTMLElement;
  readonly body: HTMLElement;
  readonly titlebarExtra: HTMLElement | null = null;
  readonly kind: string;
  iframe?: HTMLIFrameElement;
  surface?: SurfaceImpl;
  content?: unknown;
  state: WindowState = 'normal';
  private titleEl: HTMLElement | null = null;
  private _title: string;
  /** Normal-state frame geometry (frame x/y, client width/height) */
  private g: Geometry;
  private listeners = new Map<WindowEvent, Set<Listener>>();
  private stateBeforeMin: WindowState = 'normal';
  private minWidth: number;
  private minHeight: number;
  readonly options: WindowOptions;

  constructor(private wm: WindowManager, readonly id: string, opts: WindowOptions) {
    this.options = { ...opts };
    if (opts.override) this.options.decorations = 'none';
    this.kind = opts.content?.kind ?? 'dom';
    this._title = opts.title ?? '';
    this.minWidth = opts.minWidth ?? 220;
    this.minHeight = opts.minHeight ?? 120;
    const wa = wm.workArea();
    const width = Math.round(opts.width ?? Math.min(760, wa.width * 0.62));
    const height = Math.round(opts.height ?? Math.min(480, wa.height * 0.6));
    const pos = opts.x !== undefined && opts.y !== undefined ? { x: opts.x, y: opts.y } : wm.placement(width, height);
    this.g = { x: Math.round(pos.x), y: Math.round(pos.y), width, height };

    const el = document.createElement('div');
    el.className = 'sd-win';
    el.dataset.id = id;
    el.dataset.kind = this.kind;
    if (opts.appId) el.dataset.app = opts.appId;
    if (this.decorated) el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', this._title);
    if (opts.override) el.classList.add('sd-override');
    if (!this.decorated) el.classList.add('sd-undecorated');
    this.element = el;

    if (this.decorated) {
      const bar = document.createElement('div');
      bar.className = 'sd-titlebar';
      const lights = document.createElement('div');
      lights.className = 'sd-lights';
      const mk = (cls: string, label: string, fn: () => void) => {
        const b = document.createElement('button');
        b.className = `sd-light sd-${cls}`;
        b.type = 'button';
        b.title = label;
        b.setAttribute('aria-label', label);
        b.addEventListener('pointerdown', e => e.stopPropagation());
        // A click leaves keyboard focus where it was (typing after Zoom reaches the terminal)
        b.addEventListener('mousedown', e => e.preventDefault());
        b.addEventListener('click', e => { e.stopPropagation(); fn(); });
        lights.appendChild(b);
      };
      mk('close', 'Close', () => this.close());
      mk('min', 'Minimize', () => this.minimize());
      mk('zoom', 'Zoom', () => this.zoom());
      if (opts.resizable === false) lights.querySelector('.sd-zoom')?.setAttribute('disabled', '');
      const title = document.createElement('div');
      title.className = 'sd-title';
      title.textContent = this._title;
      this.titleEl = title;
      const extra = document.createElement('div');
      extra.className = 'sd-titlebar-extra';
      this.titlebarExtra = extra;
      bar.append(lights, title, extra);
      bar.addEventListener('pointerdown', e => {
        if (e.button !== 0 || (e.target as HTMLElement).closest('button, input, .sd-no-drag')) return;
        this.beginMove(e);
      });
      bar.addEventListener('dblclick', e => {
        if ((e.target as HTMLElement).closest('button, input, .sd-no-drag')) return;
        this.zoom();
      });
      el.appendChild(bar);
    }
    const body = document.createElement('div');
    body.className = 'sd-body';
    el.appendChild(body);
    this.body = body;
    if (this.decorated && opts.resizable !== false) {
      for (const edge of EDGES) {
        const h = document.createElement('div');
        h.className = `sd-resize sd-resize-${edge}`;
        h.addEventListener('pointerdown', e => { if (e.button === 0) this.beginResize(e, edge); });
        el.appendChild(h);
      }
    }
    // Any click inside focuses (override windows never take focus)
    el.addEventListener('pointerdown', () => { if (!opts.override && this.wm.focused() !== this) this.focus(); }, true);
    el.addEventListener('focusin', () => { if (!opts.override && this.wm.focused() !== this) this.focus(); });
    this.applyGeometry();
  }

  private get decorated(): boolean {
    return this.options.decorations !== 'none';
  }

  get title(): string { return this._title; }
  set title(t: string) { this.setTitle(t); }

  get focused(): boolean { return this.wm.focused() === this; }

  get appId(): string | undefined { return this.options.appId; }

  setTitle(title: string): void {
    title = String(title);
    if (title === this._title) return;
    this._title = title;
    if (this.titleEl) this.titleEl.textContent = title;
    this.element.setAttribute('aria-label', title);
    this.fire('title');
  }

  geometry(): Geometry {
    const f = this.frameGeometry();
    return { x: f.x, y: f.y, width: f.width, height: f.height - this.chromeHeight() };
  }

  private chromeHeight(): number {
    return this.decorated ? TITLEBAR_H : 0;
  }

  /** Frame rect in work-area coordinates for the current state. */
  frameGeometry(): Geometry {
    const s = this.wm.stateGeometry(this.state);
    if (s) return s;
    return { x: this.g.x, y: this.g.y, width: this.g.width, height: this.g.height + this.chromeHeight() };
  }

  applyGeometry(): void {
    const wa = this.wm.workArea();
    const f = this.frameGeometry();
    const s = this.element.style;
    // Override windows (menus) are placed exactly; others keep their title bar reachable
    if (!this.options.override && this.state === 'normal') {
      f.x = Math.min(Math.max(f.x, 40 - f.width), wa.width - 60);
      f.y = Math.min(Math.max(f.y, 0), Math.max(0, wa.height - TITLEBAR_H));
    }
    s.left = `${wa.x + f.x}px`;
    s.top = `${wa.y + f.y}px`;
    s.width = `${f.width}px`;
    s.height = `${f.height}px`;
    this.element.dataset.state = this.state;
  }

  move(x: number, y: number): void {
    if (this.state !== 'normal' && this.state !== 'minimized') this.setState('normal');
    this.g.x = Math.round(x);
    this.g.y = Math.round(y);
    this.applyGeometry();
    this.fire('move');
  }

  resize(width: number, height: number): void {
    if (this.state !== 'normal' && this.state !== 'minimized') this.setState('normal');
    this.g.width = Math.max(this.minWidth, Math.round(width));
    this.g.height = Math.max(this.minHeight, Math.round(height));
    this.applyGeometry();
    this.fire('resize');
  }

  setGeometry(g: Partial<Geometry>): void {
    if (g.x !== undefined || g.y !== undefined) this.move(g.x ?? this.g.x, g.y ?? this.g.y);
    if (g.width !== undefined || g.height !== undefined) this.resize(g.width ?? this.g.width, g.height ?? this.g.height);
  }

  focus(): void {
    if (this.state === 'closed') return;
    if (this.state === 'minimized') this.unminimize();
    this.wm.raise(this);
    if (this.options.override) return;
    this.wm.setFocus(this);
    // Give keyboard focus to the content unless it already has it
    if (!this.element.contains(document.activeElement)) {
      const target = this.body.querySelector<HTMLElement>('[data-autofocus], textarea.xterm-helper-textarea, canvas.sd-surface, iframe, [tabindex]');
      try { target?.focus({ preventScroll: true }); } catch {}
    }
  }

  private setState(state: WindowState): void {
    if (this.state === state) return;
    this.state = state;
    this.applyGeometry();
    this.fire('state');
    this.fire('resize');
    this.wm.emit('window-changed', this);
  }

  minimize(): void {
    if (this.state === 'minimized' || this.state === 'closed' || this.options.override) return;
    this.stateBeforeMin = this.state;
    const dock = document.querySelector<HTMLElement>(`.sd-dock [data-app="${CSS.escape(this.appId ?? '')}"]`);
    this.animateTo(dock, () => {
      this.element.classList.add('sd-minimized');
      this.state = 'minimized';
      this.element.dataset.state = 'minimized';
      this.fire('state');
      this.wm.emit('window-changed', this);
      if (this.wm.focused() === this) this.wm.focusTop(this);
    });
  }

  private unminimize(): void {
    this.element.classList.remove('sd-minimized');
    this.state = this.stateBeforeMin === 'minimized' ? 'normal' : this.stateBeforeMin;
    this.applyGeometry();
    this.appear();
    this.fire('state');
    this.wm.emit('window-changed', this);
  }

  restore(): void {
    if (this.state === 'minimized') { this.unminimize(); this.focus(); return; }
    if (this.wm.compact) return;
    this.setState('normal');
  }

  maximize(silent = false): void {
    if (this.options.resizable === false && !silent) return;
    if (this.state === 'minimized') this.unminimize();
    if (silent) { this.state = 'maximized'; this.applyGeometry(); return; }
    this.setState('maximized');
  }

  zoom(): void {
    if (this.options.resizable === false || this.wm.compact) return;
    this.withTransition(() => this.state === 'maximized' ? this.setState('normal') : this.setState('maximized'));
  }

  snap(side: SnapSide): void {
    if (this.options.resizable === false || this.wm.compact) return;
    this.withTransition(() => this.setState(`snapped-${side}` as WindowState));
  }

  private withTransition(fn: () => void): void {
    if (prefersReducedMotion()) { fn(); return; }
    this.element.classList.add('sd-animating');
    fn();
    setTimeout(() => this.element.classList.remove('sd-animating'), 240);
  }

  close(force = false): boolean {
    if (this.state === 'closed') return true;
    if (!force && this.options.onClose?.(this) === false) return false;
    const was = this.state;
    this.state = 'closed';
    this.fire('close');
    const finish = () => { this.element.remove(); this.surface?.dispose(); };
    if (prefersReducedMotion() || was === 'minimized') finish();
    else {
      this.element.classList.add('sd-closing');
      setTimeout(finish, 160);
    }
    this.wm.removeWindow(this);
    this.listeners.clear();
    return true;
  }

  appear(): void {
    if (prefersReducedMotion()) return;
    this.element.classList.add('sd-opening');
    requestAnimationFrame(() => requestAnimationFrame(() => this.element.classList.remove('sd-opening')));
  }

  /** Animate the frame into (or out of) a dock icon; just runs `done` with reduced motion. */
  private animateTo(target: HTMLElement | null, done: () => void): void {
    if (prefersReducedMotion() || !target) { done(); return; }
    const from = this.element.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    const scale = Math.max(0.05, to.width / from.width);
    const anim = this.element.animate([
      { transform: 'none', opacity: 1 },
      { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0 },
    ], { duration: 280, easing: 'cubic-bezier(.4,0,.2,1)' });
    anim.onfinish = done;
  }

  beginMove(ev: PointerEvent): void {
    if (this.wm.compact || this.options.override && !ev.isTrusted) return;
    ev.preventDefault();
    const startX = ev.clientX, startY = ev.clientY;
    const startState = this.state;
    const f0 = this.frameGeometry();
    let base = { x: f0.x, y: f0.y };
    let moved = false;
    let snapTo: WindowState | null = null;
    const wa = this.wm.workArea();
    this.element.classList.add('sd-dragging');
    track(ev, e => {
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      if (!moved) {
        moved = true;
        if (startState !== 'normal') {
          // Unsnap: keep the grab point proportionally under the pointer
          const ratio = (startX - (wa.x + f0.x)) / f0.width;
          this.state = 'normal';
          base = { x: startX - wa.x - this.g.width * ratio, y: f0.y };
          this.fire('state');
          this.fire('resize');
        }
      }
      this.g.x = Math.round(base.x + dx);
      this.g.y = Math.round(base.y + dy);
      this.applyGeometry();
      if (this.options.resizable !== false && !this.options.override) {
        const px = e.clientX - wa.x, py = e.clientY - wa.y;
        snapTo = snapZone(px, py, wa.width, wa.height);
        this.wm.showSnapPreview(snapTo ? this.wm.stateGeometry(snapTo) : null);
      }
    }, () => {
      this.element.classList.remove('sd-dragging');
      this.wm.showSnapPreview(null);
      if (snapTo) this.withTransition(() => this.setState(snapTo!));
      else if (moved) { this.fire('move'); this.wm.emit('window-changed', this); }
    });
  }

  beginResize(ev: PointerEvent, edges: string): void {
    if (this.wm.compact || this.options.resizable === false) return;
    ev.preventDefault();
    ev.stopPropagation();
    const f = this.frameGeometry();
    if (this.state !== 'normal') {
      this.g = { x: f.x, y: f.y, width: f.width, height: f.height - this.chromeHeight() };
      this.state = 'normal';
      this.fire('state');
    }
    const start = { ...this.g }, sx = ev.clientX, sy = ev.clientY;
    this.element.classList.add('sd-dragging');
    track(ev, e => {
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (edges.includes('e')) this.g.width = Math.max(this.minWidth, start.width + dx);
      if (edges.includes('s')) this.g.height = Math.max(this.minHeight, start.height + dy);
      if (edges.includes('w')) { const w = Math.max(this.minWidth, start.width - dx); this.g.x = start.x + start.width - w; this.g.width = w; }
      if (edges.includes('n')) { const h = Math.max(this.minHeight, start.height - dy); this.g.y = start.y + start.height - h; this.g.height = h; }
      this.applyGeometry();
      this.fire('resize');
    }, () => {
      this.element.classList.remove('sd-dragging');
      this.fire('move');
      this.wm.emit('window-changed', this);
    });
  }

  setAttention(on: boolean): void {
    this.element.classList.toggle('sd-attention', on);
    this.wm.emit('window-changed', this);
  }

  on(ev: WindowEvent, cb: Listener): () => void {
    let set = this.listeners.get(ev);
    if (!set) this.listeners.set(ev, set = new Set());
    set.add(cb);
    return () => { set!.delete(cb); };
  }

  fire(ev: WindowEvent): void {
    for (const cb of this.listeners.get(ev) ?? []) { try { cb(this); } catch (e) { console.error('[desktop]', e); } }
    if (ev === 'title' || ev === 'move' || ev === 'resize') this.wm.emit('window-changed', this);
  }
}

/**
 * The snap a drag released at (px, py) in the work area asks for: an edge
 * near a corner is that quarter, the left/right edge a half, the top edge
 * maximizes. null: no snap.
 */
export function snapZone(px: number, py: number, w: number, h: number): WindowState | null {
  const C = 64; // corner zone along each edge
  const left = px <= SNAP_MARGIN, right = px >= w - SNAP_MARGIN, top = py <= SNAP_MARGIN - 2, bottom = py >= h - SNAP_MARGIN;
  const nearTop = py < C, nearBottom = py > h - C, nearLeft = px < C, nearRight = px > w - C;
  if ((left && nearTop) || (top && nearLeft)) return 'snapped-top-left';
  if ((right && nearTop) || (top && nearRight)) return 'snapped-top-right';
  if ((left && nearBottom) || (bottom && nearLeft)) return 'snapped-bottom-left';
  if ((right && nearBottom) || (bottom && nearRight)) return 'snapped-bottom-right';
  if (top) return 'maximized';
  if (left) return 'snapped-left';
  if (right) return 'snapped-right';
  return null;
}

/** Follow a pointer until release, even when the element under it changes. */
function track(start: PointerEvent, move: (e: PointerEvent) => void, done: (e: PointerEvent) => void): void {
  const target = start.target as Element;
  try { target.setPointerCapture?.(start.pointerId); } catch {}
  // Iframes swallow pointer events mid-drag: a shield covers the page meanwhile
  const shield = document.createElement('div');
  shield.className = 'sd-drag-shield';
  shield.style.cursor = getComputedStyle(target).cursor;
  document.body.appendChild(shield);
  const onMove = (e: PointerEvent) => { if (e.pointerId === start.pointerId) move(e); };
  const onUp = (e: PointerEvent) => {
    if (e.pointerId !== start.pointerId) return;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    shield.remove();
    done(e);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

class SurfaceImpl implements Surface {
  readonly canvas: HTMLCanvasElement;
  scale: number;
  private ctx: CanvasRenderingContext2D | null = null;
  private inputCbs = new Set<(ev: SurfaceInputEvent) => void>();
  private configureCbs = new Set<(w: number, h: number, s: number) => void>();
  private ro: ResizeObserver | null = null;
  private autoResize: boolean;

  constructor(private win: WindowImpl, opts: SurfaceOptions, body: HTMLElement) {
    this.scale = opts.scale ?? (window.devicePixelRatio || 1);
    this.autoResize = opts.autoResize !== false;
    const c = document.createElement('canvas');
    c.className = 'sd-surface';
    c.tabIndex = 0;
    if (opts.cursor) c.style.cursor = opts.cursor;
    const g = win.geometry();
    c.width = Math.max(1, Math.round(opts.bufferWidth ?? g.width * this.scale));
    c.height = Math.max(1, Math.round(opts.bufferHeight ?? g.height * this.scale));
    body.appendChild(c);
    this.canvas = c;
    this.wireInput();
    if (typeof ResizeObserver !== 'undefined') {
      let last = '';
      this.ro = new ResizeObserver(() => {
        const r = body.getBoundingClientRect();
        const w = Math.max(1, Math.round(r.width * this.scale)), h = Math.max(1, Math.round(r.height * this.scale));
        const key = `${w}x${h}`;
        if (key === last || r.width === 0) return;
        last = key;
        if (this.autoResize) this.resizeKeeping(w, h);
        for (const cb of this.configureCbs) cb(w, h, this.scale);
      });
      this.ro.observe(body);
    }
  }

  get width(): number { return this.canvas.width; }
  get height(): number { return this.canvas.height; }

  private context(): CanvasRenderingContext2D | null {
    if (!this.ctx) this.ctx = this.canvas.getContext('2d');
    return this.ctx;
  }

  present(src: CanvasImageSource | ImageData, dx = 0, dy = 0): void {
    const ctx = this.context();
    if (!ctx) return;
    if (typeof ImageData !== 'undefined' && src instanceof ImageData) ctx.putImageData(src, dx, dy);
    else ctx.drawImage(src as CanvasImageSource, dx, dy);
  }

  /** Change the buffer size, keeping what's drawn (canvas resize clears it). */
  private resizeKeeping(w: number, h: number): void {
    if (w === this.canvas.width && h === this.canvas.height) return;
    let keep: ImageData | null = null;
    try { if (this.ctx) keep = this.ctx.getImageData(0, 0, Math.min(w, this.canvas.width), Math.min(h, this.canvas.height)); } catch {}
    this.canvas.width = w;
    this.canvas.height = h;
    if (keep) this.context()?.putImageData(keep, 0, 0);
  }

  setBufferSize(width: number, height: number, resizeWindow = false): void {
    this.resizeKeeping(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
    if (resizeWindow) this.win.resize(width / this.scale, height / this.scale);
  }

  setCursor(css: string): void {
    this.canvas.style.cursor = css;
  }

  onInput(cb: (ev: SurfaceInputEvent) => void): () => void {
    this.inputCbs.add(cb);
    return () => { this.inputCbs.delete(cb); };
  }

  onConfigure(cb: (w: number, h: number, s: number) => void): () => void {
    this.configureCbs.add(cb);
    return () => { this.configureCbs.delete(cb); };
  }

  private send(ev: Partial<SurfaceInputEvent> & { type: SurfaceInputEvent['type'] }, src?: MouseEvent | KeyboardEvent): void {
    const full: SurfaceInputEvent = {
      x: 0, y: 0, button: 0, buttons: 0, deltaX: 0, deltaY: 0, key: '', code: '', keyCode: 0, repeat: false,
      shift: !!src?.shiftKey, ctrl: !!src?.ctrlKey, alt: !!src?.altKey, meta: !!src?.metaKey,
      time: performance.now(), ...ev,
    };
    for (const cb of this.inputCbs) { try { cb(full); } catch (e) { console.error('[desktop surface]', e); } }
  }

  private wireInput(): void {
    const c = this.canvas;
    const pos = (e: MouseEvent) => {
      const r = c.getBoundingClientRect();
      return {
        x: Math.round((e.clientX - r.left) * (c.width / Math.max(1, r.width))),
        y: Math.round((e.clientY - r.top) * (c.height / Math.max(1, r.height))),
      };
    };
    const ptr = (type: 'pointerdown' | 'pointerup' | 'pointermove') => (e: PointerEvent) => {
      if (type === 'pointerdown') { c.focus({ preventScroll: true }); try { c.setPointerCapture(e.pointerId); } catch {} }
      this.send({ type, ...pos(e), button: e.button, buttons: e.buttons }, e);
    };
    c.addEventListener('pointerdown', ptr('pointerdown'));
    c.addEventListener('pointerup', ptr('pointerup'));
    c.addEventListener('pointermove', ptr('pointermove'));
    c.addEventListener('pointerenter', e => this.send({ type: 'enter', ...pos(e) }, e));
    c.addEventListener('pointerleave', e => this.send({ type: 'leave', ...pos(e) }, e));
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('wheel', e => {
      e.preventDefault();
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      this.send({ type: 'wheel', ...pos(e), deltaX: e.deltaX * k, deltaY: e.deltaY * k, buttons: e.buttons }, e);
    }, { passive: false });
    const key = (type: 'keydown' | 'keyup') => (e: KeyboardEvent) => {
      if (isDesktopShortcut(e)) return;
      e.preventDefault();
      this.send({ type, key: e.key, code: e.code, keyCode: e.keyCode, repeat: e.repeat }, e);
    };
    c.addEventListener('keydown', key('keydown'));
    c.addEventListener('keyup', key('keyup'));
    c.addEventListener('focus', () => this.send({ type: 'focus' }));
    c.addEventListener('blur', () => this.send({ type: 'blur' }));
  }

  dispose(): void {
    this.ro?.disconnect();
    this.inputCbs.clear();
    this.configureCbs.clear();
  }
}

/** Keys the desktop keeps for itself (Alt+Shift+…, Alt+`): see docs/DESKTOP.md. */
export function isDesktopShortcut(e: KeyboardEvent): boolean {
  if (e.altKey && e.code === 'Backquote' && !e.ctrlKey && !e.metaKey) return true;
  // Cmd+N / Cmd+W / Cmd+` / Cmd+Space (when the browser passes them on: installed app, fullscreen)
  if (e.metaKey && !e.ctrlKey && !e.altKey && ['KeyN', 'KeyW', 'Backquote', 'Space'].includes(e.code)) return true;
  // Ctrl+Space: the launcher (Ctrl+@ still sends NUL to the terminal)
  if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.code === 'Space') return true;
  // Ctrl+Alt+U/I/J/K: quarters
  if (e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey && ['KeyU', 'KeyI', 'KeyJ', 'KeyK'].includes(e.code)) return true;
  return e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey &&
    ['Space', 'Enter', 'KeyW', 'KeyM', 'KeyT', 'KeyF', 'Comma', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.code);
}
