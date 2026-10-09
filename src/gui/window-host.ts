/**
 * The window-manager surface native GUI apps (src/x11) draw into: a desktop
 * window whose content is a canvas, fed frames and reporting input. It is
 * shaped like the desktop's `surface` windows (docs/DESKTOP.md,
 * src/desktop/wm.ts): `desktop-host.ts` maps it onto that API when the
 * desktop is up; `standin-host.ts` is a self-contained floating-window
 * version for the classic full-page terminal UI.
 *
 * Coordinates are CSS px in "desktop" space: the root window's origin is the
 * desktop work area's top-left. One X pixel is one CSS px.
 */

/** Normalized input, the same fields as the desktop's SurfaceInputEvent. */
export interface GuiInputEvent {
  type: 'pointerdown' | 'pointerup' | 'pointermove' | 'wheel' | 'keydown' | 'keyup' | 'enter' | 'leave' | 'focus' | 'blur';
  /** Pointer position in the content (buffer) pixels. */
  x: number;
  y: number;
  button: number;
  buttons: number;
  /** Wheel deltas in px. */
  deltaX: number;
  deltaY: number;
  key: string;
  code: string;
  keyCode: number;
  repeat: boolean;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
  time: number;
}

export interface CanvasWindowOptions {
  title: string;
  /** Content-area origin in desktop coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** false: no frame or title bar (X override-redirect menus, tooltips) */
  decorated: boolean;
  /** Override-redirect: exact placement, never focused, above normal windows. */
  override?: boolean;
  transientFor?: CanvasWindow | null;
  minWidth?: number; minHeight?: number;
  resizable?: boolean;
  /** App identity for docks/taskbars (X WM_CLASS). */
  appId?: string;
}

export interface CanvasWindowEvents {
  /** The user asked to close the window (title-bar close button). */
  close(): void;
  /** The user moved the window; new content origin in desktop coordinates. */
  move(x: number, y: number): void;
  /** The user resized the window (or it was maximized/tiled); new content size. */
  resize(width: number, height: number): void;
  focus(): void;
  blur(): void;
}

export interface CanvasWindow {
  setTitle(title: string): void;
  /**
   * The app moved/resized its window (X ConfigureWindow); the frame follows.
   * `fromUser`: the size answers the user's own resize (only the buffer changes).
   */
  setGeometry(g: { x?: number; y?: number; width?: number; height?: number }, fromUser?: boolean): void;
  /** Current content origin in desktop coordinates. */
  position(): { x: number; y: number };
  /** Draw `img` at (dx, dy); with a dirty rect only that part of img is copied. */
  present(img: ImageData, dx: number, dy: number, dirty?: { x: number; y: number; w: number; h: number }): void;
  show(): void;
  hide(): void;
  /** Raise and give keyboard focus. */
  activate(): void;
  setCursor(css: string): void;
  onInput(cb: (e: GuiInputEvent) => void): void;
  on<K extends keyof CanvasWindowEvents>(ev: K, cb: CanvasWindowEvents[K]): void;
  /** The app closed the window. */
  destroy(): void;
}

export interface WindowHost {
  readonly name: string;
  createCanvasWindow(opts: CanvasWindowOptions): CanvasWindow;
  /** The desktop area windows live in (the X root window size), CSS px. */
  desktopSize(): { width: number; height: number };
  /** Where a new window of this size should go (cascade/center). */
  placeWindow?(width: number, height: number): { x: number; y: number };
}

let host: WindowHost | null = null;

/** Install a host explicitly (tests, or a future desktop). */
export function setWindowHost(h: WindowHost | null): void { host = h; }

/** The desktop's host when the desktop UI is up, else the stand-in. */
export async function getWindowHost(): Promise<WindowHost> {
  if (host) return host;
  const desktop = (globalThis as { __shiroDesktop?: unknown }).__shiroDesktop;
  if (desktop) {
    const m = await import('./desktop-host');
    return m.createDesktopHost(desktop as never);
  }
  const m = await import('./standin-host');
  host = m.createStandinHost();
  return host;
}

/** Fill a GuiInputEvent from a DOM event (stand-in host). */
export function inputEvent(type: GuiInputEvent['type'], src: Partial<MouseEvent & KeyboardEvent & WheelEvent> | null, extra: Partial<GuiInputEvent> = {}): GuiInputEvent {
  return {
    type, x: 0, y: 0, button: src?.button ?? 0, buttons: src?.buttons ?? 0, deltaX: 0, deltaY: 0,
    key: src?.key ?? '', code: src?.code ?? '', keyCode: src?.keyCode ?? 0, repeat: !!src?.repeat,
    shift: !!src?.shiftKey, ctrl: !!src?.ctrlKey, alt: !!src?.altKey, meta: !!src?.metaKey,
    time: typeof performance !== 'undefined' ? performance.now() : Date.now(), ...extra,
  };
}
