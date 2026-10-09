# Desktop, window manager API, and /dom

The Unix edition boots to a desktop: a menu bar, a dock, and windows. The
Terminal (the real Shiro terminal on a pty) opens front and center. The
classic full-page terminal of shiro.computer is still there behind a flag.

- Code: `src/desktop/` (window manager `wm.ts`, shell `index.ts`, Terminal
  `terminal-app.ts`, network sheet `network.ts`, lazy apps in `apps/`),
  `src/dom-fs.ts` (/dom), `src/net-signin.ts` (sign-in hook), `src/ui-mode.ts`.
- Screenshots (1440×900, and phone width at 390 px):

  | | |
  |---|---|
  | ![first visit, dark](screenshots/desktop-dark.png) | ![light: cowsay just installed, Files](screenshots/desktop-light.png) |
  | ![htop (x86-64, Blink) from the dock, next to Activity](screenshots/apps-dark.png) | ![driving windows through /dom](screenshots/dom-dark.png) |
  | ![the network sign-in sheet](screenshots/signin-sheet.png) | ![phone width](screenshots/phone-dark.png) ![phone width, light](screenshots/phone-light.png) |

## Changelog (API)

All changes are additive. Nothing below renames or removes an earlier name.

- **2026-10-09 (unix/desktop), v1.** First version: `DesktopAPI`,
  `DesktopWindow`, `Surface`, content kinds `dom`, `iframe`, `terminal`,
  `surface`, apps, desktop events, `/dom`, `requireNetworkSignIn`.

## Name

The Unix edition is **tabcomputer** (tabcomputer.com). The name, domain, tagline
and description live in `src/brand.json` only: the desktop reads it (`src/brand.ts`:
tab title, wallpaper wordmark, welcome banner, About), and `server.mjs`
(`brandAppShell`) gives the shared `index.html` that title plus description and
Open Graph tags for every host except shiro.computer, since link previews don't run JS.

## Choosing the UI

`uiMode()` (src/ui-mode.ts):

| condition | UI |
|---|---|
| `?ui=desktop` / `?ui=terminal` | that one, remembered in localStorage `shiro-ui` |
| `?demo=1`, embedded in another page (seeds), app ("become") mode | terminal |
| saved `shiro-ui` | that one |
| host `shiro.computer` or `*.shiro.computer` | terminal |
| anything else (tabcomputer.com, localhost) | desktop |

From a shell: `desktop` switches to the desktop and `desktop classic` switches
back. System menu → Classic Terminal does the same. Both modes keep
`window.__shiro.terminal`. On the desktop, that terminal is the first
Terminal window's first tab. Closing that tab parks the terminal (it is not
destroyed), and the next Terminal window adopts it again.

## Using it

- **Windows** have traffic lights (close, minimize, zoom). Drag a window by its
  title bar. Drag it to the left or right edge to tile it, or to the top edge
  to maximize. Double-click the title bar to zoom. Drag any edge or corner to
  resize.
- **The dock** shows Terminal, Files, Settings and Activity, then terminal
  programs: Vim, htop and Python, plus Neovim, Emacs, nano, tmux, Lua and
  SQLite once they are installed. A program that is not installed has a ↓
  badge; clicking it runs `apt install NAME && NAME` in a new Terminal
  window. A dot under an icon marks a running app. Right-click an icon to
  list its windows, open a new window, or close it.
- **Keyboard.** The browser keeps Ctrl/Cmd+N, T and W for itself, so desktop
  shortcuts use Alt+Shift. Terminal programs rarely use that combination.

  | keys | action |
  |---|---|
  | Alt+Shift+Enter | new Terminal window |
  | Alt+Shift+T | new tab (in a Terminal window) |
  | Alt+Shift+W | close window |
  | Alt+Shift+M | minimize |
  | Alt+Shift+↑ / ↓ | zoom / restore (or minimize) |
  | Alt+Shift+← / → | tile left / right |
  | Alt+\` (Alt+Shift+\`) | cycle windows |
  | Alt+Shift+F / Alt+Shift+, | Files / Settings |

- **Themes**: light, dark, or match the system (View menu, the sun/moon icon
  in the menu bar, or Settings → Appearance). Saved in localStorage
  `shiro-desktop-theme`. Terminals switch palettes with the theme.
- **Motion**: every animation and transition turns off under
  `prefers-reduced-motion: reduce`.
- **Phone width** (≤ 640 px): every window fills the work area. Menus collapse
  to the app name, and the dock scrolls sideways. On touch devices the
  virtual-key toolbar stays at the bottom, and the dock sits above it.
- **Fonts** are self-hosted: Inter and JetBrains Mono (latin, variable,
  `public/fonts/`, SIL OFL, license files next to them). Only the desktop
  loads them.

## Window manager API

The page exposes it as `window.__shiro.desktop` and `globalThis.__shiroDesktop`.
Code in this repo can call `getDesktop()` from `src/desktop/wm.ts` instead.
Both are `null` or `undefined` in the classic UI. The types live in `wm.ts`.

```ts
interface DesktopAPI {
  readonly version: number;                      // 1
  createWindow(opts: WindowOptions): DesktopWindow;
  windows(): DesktopWindow[];                    // bottom to top
  get(id: string): DesktopWindow | undefined;
  focused(): DesktopWindow | null;
  workArea(): Geometry;                          // page px between the menu bar and the dock
  registerContentKind(kind: string, factory: ContentFactory): void;
  registerApp(app: AppDescriptor): void;         // dock + `desktop open ID` + /dom/windows/ctl
  apps(): AppDescriptor[];
  openApp(id: string, args?: Record<string, unknown>): Promise<DesktopWindow | null>;
  theme(): 'light' | 'dark';
  setTheme(pref: 'light' | 'dark' | 'system'): void;
  on(ev: 'window-created' | 'window-closed' | 'window-changed' | 'focus-changed' | 'apps-changed' | 'theme-changed',
     cb: (win?: DesktopWindow) => void): () => void;
}
```

### WindowOptions

| option | meaning |
|---|---|
| `id` | stable id (`[A-Za-z0-9_-]+`, unique), else `w1`, `w2`, … It names `/dom/windows/<id>`. |
| `title`, `appId`, `icon` | `appId` groups windows under a dock icon. `icon` (inline SVG or URL) is used when the app has none. |
| `content` | `{kind:'dom', element?}`, `{kind:'iframe', src? \| srcdoc?, sandbox?, allow?}`, `{kind:'terminal', command?, cwd?}`, `{kind:'surface', ...SurfaceOptions}`, or a registered kind |
| `width`, `height` | client area size in CSS px (the title bar adds 38 px) |
| `x`, `y` | frame position in work-area coordinates. Without them, the window is centered and cascaded. |
| `minWidth`, `minHeight`, `resizable` | defaults 220, 120, `true` |
| `decorations` | `'server'` (default: title bar, lights, resize edges) or `'none'` (the client draws its own; see `beginMove`/`beginResize`) |
| `override` | override-redirect, for X11 menus, tooltips and DnD icons: no frame, never focused, not in the dock, placed exactly, above normal windows |
| `transientFor` | parent window id (dialogs): kept above the parent, closed with it |
| `alwaysOnTop`, `skipTaskbar` | layer above normal windows; leave out of dock and cycling |
| `state` | `'normal'`, `'maximized'` or `'minimized'` at creation |
| `focus` | take focus on creation (default `true`, `false` for override windows) |
| `onClose(win)` | runs before closing; returning `false` keeps the window open |

### DesktopWindow

```ts
interface DesktopWindow {
  readonly id: string; readonly appId?: string; readonly kind: string;
  readonly element: HTMLElement;      // frame
  readonly body: HTMLElement;         // client area
  readonly titlebarExtra: HTMLElement | null;   // put title-bar buttons here
  readonly options: Readonly<WindowOptions>;
  title: string; readonly state: 'normal' | 'minimized' | 'maximized' | 'snapped-left' | 'snapped-right' | 'closed';
  readonly focused: boolean;
  readonly iframe?: HTMLIFrameElement; readonly surface?: Surface; readonly content?: unknown;
  setTitle(t): void; geometry(): Geometry;      // {x, y} of the frame, {width, height} of the client area
  move(x, y): void; resize(w, h): void; setGeometry(partial): void;
  focus(): void; minimize(): void; restore(): void; maximize(): void; zoom(): void; snap('left' | 'right'): void;
  close(force?): boolean;                        // false when onClose vetoed it
  beginMove(ev: PointerEvent): void;             // client-side decorations start a move...
  beginResize(ev: PointerEvent, edges: string): void;   // ...or a resize ('n','se','w',...)
  setAttention(on: boolean): void;
  on('close' | 'focus' | 'blur' | 'move' | 'resize' | 'state' | 'title', cb): () => void;
}
```

`move`/`resize` on a maximized or tiled window first return it to normal.
Geometry changes fire `move`/`resize` on the window and `window-changed` on
the desktop.

### Surfaces: native GUI clients (unix/gui)

A display server (X11 or Wayland on unix/gui) maps each toplevel to
`createWindow({ content: { kind: 'surface', ... } })` and talks to its
`Surface`:

```ts
interface SurfaceOptions { bufferWidth?; bufferHeight?; scale?; cursor?; autoResize? /* default true */ }
interface Surface {
  readonly canvas: HTMLCanvasElement;            // or transferControlToOffscreen() it to a worker
  readonly width: number; readonly height: number; readonly scale: number;   // buffer, device px
  present(src: CanvasImageSource | ImageData, dx?, dy?): void;   // a frame or a damaged rect
  setBufferSize(w, h, resizeWindow?: boolean): void;   // client-initiated resize
  setCursor(css: string): void;
  onInput(cb: (ev: SurfaceInputEvent) => void): () => void;
  onConfigure(cb: (w, h, scale) => void): () => void;  // like xdg_toplevel.configure
}
interface SurfaceInputEvent {
  type: 'pointerdown' | 'pointerup' | 'pointermove' | 'wheel' | 'keydown' | 'keyup' | 'enter' | 'leave' | 'focus' | 'blur';
  x; y;                 // buffer (device-pixel) coordinates
  button; buttons; deltaX; deltaY;   // wheel deltas in px
  key; code; keyCode; repeat; shift; ctrl; alt; meta; time;
}
```

Mapping notes:

- **Toplevels** are decorated by the desktop (server-side decorations).
  `_NET_WM_NAME` or `xdg_toplevel.set_title` → `setTitle`. Minimize, maximize
  and close requests → `minimize()`, `maximize()`, `close()`. The close
  button fires the window's `close` event: send `WM_DELETE_WINDOW` or
  `xdg_toplevel.close` from it, and use `onClose` returning `false` to let the
  client decide.
- **Override-redirect windows and popups** (menus, tooltips) use
  `override: true` with exact `x`, `y` in work-area coordinates, relative to
  the parent's `geometry()`. Transient dialogs use `transientFor`.
- **Client-side decorations** (GTK headerbars) use `decorations: 'none'` and
  call `beginMove(ev)` / `beginResize(ev, edges)` from the pointerdown that
  `xdg_toplevel.move`/`resize` answers.
- **Resizing**: with `autoResize` (default), the canvas buffer follows the
  window and keeps its pixels, and `onConfigure` reports the new size. The
  client then redraws. With `autoResize: false`, the buffer only changes when
  the client calls `setBufferSize`.
- **Keyboard**: the canvas takes focus with the window. Keys are
  `preventDefault`ed, except the desktop's shortcuts (`isDesktopShortcut`).

A canvas client takes about 15 lines:

```js
const d = window.__shiro.desktop;
const w = d.createWindow({ title: 'xeyes', appId: 'x11', width: 300, height: 200, content: { kind: 'surface' } });
const ctx = w.surface.canvas.getContext('2d');
const draw = (mx = 0, my = 0) => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w.surface.width, w.surface.height);
  ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(mx, my, 10 * w.surface.scale, 0, 7); ctx.fill(); };
w.surface.onInput(e => e.type === 'pointermove' && draw(e.x, e.y));
w.surface.onConfigure(() => draw());
w.on('close', () => console.log('client gone'));
draw();
```

### Content kinds and apps

`registerContentKind(kind, (win, content, body) => instance)` adds a kind.
The factory fills `body`, and its return value becomes `win.content`. The
desktop registers `terminal`; the WM itself provides `dom`, `iframe` and
`surface`.

`registerApp({ id, name, icon, order, dock, launch(args), menus() })` puts an
app in the dock (if `dock` is not `false`), in `desktop open ID` and in
`/dom/windows/ctl` (`open ID`). `menus()` adds menu-bar menus while the app
has focus. Apps with `order` ≥ 20 sit after the dock's separator.

## Network sign-in

The desktop is never gated behind a login. When something needs outbound
network that requires a signed-in user, it calls the single hook:

```ts
import { requireNetworkSignIn } from './net-signin';   // or globalThis.__shiroRequireNetwork
const token = await requireNetworkSignIn({ host: 'example.com', port: 443, reason: 'curl wants to connect' });
if (!token) return -ENETUNREACH;   // the user said "Not now"
```

- **With a saved sign-in**, the hook resolves at once and later visits
  connect silently. The saved sign-in is the GitHub token in localStorage
  `shiro_github_token`, the same one `gh auth login` saves.
- **Without one**, the desktop shows a non-blocking sheet under the menu bar:
  "Connect to the internet — Sign in with GitHub", plus a small "Other ways to
  connect" link (a placeholder for now). Sign-in uses GitHub's device flow
  (`src/github-auth.ts`), and the sheet shows the code with Copy and Open
  GitHub buttons. Concurrent callers share one sheet. After "Not now", the
  hook returns `null` for 60 s instead of asking again.
- **In the classic UI** no handler is registered, so the hook returns `null`
  (or the saved token).
- **Same-origin requests never call it.** That covers package downloads, the
  npm registry proxy and `/api/*`. `needsSignIn(url)` tells them apart.

Today the hook has one caller: the TCP relay token request (`relayToken` in
`src/kernel/net.ts`). That request sends `Authorization: Bearer <token>` when
a sign-in is saved, and asks the hook when the server answers 401.

The server enforces sign-in only when `SHIRO_TCP_REQUIRE_SIGNIN=1` is set.
`POST /tcp/token` then needs a GitHub token that `api.github.com/user`
accepts (checks are cached for 10 minutes); without one it answers
`401 {"error":"signin_required","provider":"github"}`. When the variable is
unset, nothing changes.

The menu bar's network icon shows `online`, `signed-in`, `needs-sign-in`,
`offline` or `unavailable` (relay off). Clicking it opens a popover with Sign
in / Sign out. Settings → Network shows the same, plus a relay check.

## /dom: the page as files

`/dom` is mounted on the filesystem (a FileSystem virtual provider, so every
builtin sees it) and its event streams are kernel devices (so a blocking
`read(2)` from a WASM or x86 program waits for the next event). Reads and
writes happen synchronously against the live DOM. A trailing newline on
writes is dropped, so `echo` works.

```
/dom/ctl                     write JS to evaluate it; read the last result (JSON for non-strings)
/dom/<id-or-selector>/       the element with that id, else the first match of the CSS selector
    text html outerhtml      textContent / innerHTML (rw), outerHTML (r)
    value                    form value (rw; writing fires input + change)
    tag rect count           tag name, "x y w h", number of matches
    click                    write anything to click it
    attr/<name>              attribute (rw; writing a new name creates it)
    style/<prop>             inline value, else computed (rw; empty write removes)
    children/<n>/…           walk down the tree
    <n>/…                    the nth match of the selector
/dom/events/<type>           one line per event: type t=ms target=tag#id.class key=value…
/dom/windows/ctl             "open <app>" (read: the apps you can open)
/dom/windows/<id>/           desktop windows
    title                    rw
    geometry                 "x y width height" (rw)
    state app kind focused   r
    ctl                      close | move X Y | resize W H | focus | minimize | maximize | zoom | restore | snap left|right | title TEXT
```

Selectors can't contain `/`. URL-encode it as `%2F` (any `%XX` in a
component is decoded). Quote selectors with spaces or `>` for the shell.

**Event streams.** Kernel processes and `cat` at a terminal follow
`/dom/events/<type>` live until Ctrl-C. Other in-page builtins (`grep`,
`cat` into a pipe) get the most recent events (up to 200). Recording for a
type starts the first time anyone looks at it. `window` events are the
desktop's: `window-created`, `window-closed`, `focus-changed` and
`window-changed`. Password fields report `value="(hidden)"`.

Examples:

```sh
ls /dom                                   # ctl events windows html head body, plus element ids
cat /dom/windows/terminal/title           # user@shiro: ~
echo 'move 40 40' > /dom/windows/terminal/ctl
echo 'snap left'  > /dom/windows/terminal/ctl
echo '0 0 900 500' > /dom/windows/terminal/geometry
echo 'open files' > /dom/windows/ctl
for w in /dom/windows/w*; do echo "$w: $(cat $w/title)"; done
cat '/dom/.sd-mb-app/text'                # the focused app's name in the menu bar
echo 'Hello' > '/dom/.sd-wordmark/text'
echo 'document.title' > /dom/ctl; cat /dom/ctl
echo 'navigator.hardwareConcurrency * 2' > /dom/ctl; cat /dom/ctl
cat /dom/events/click                     # live, Ctrl-C to stop
cat /dom/events/window                    # window manager events
grep -c keydown /dom/events/keydown       # recent ones
echo 'red' > /dom/body/style/outline-color
cat /dom/body/children/0/tag
```

Errors come back as errno. A JS exception in `ctl` is EIO, with the
exception message in the shell's error. A bad ctl command is EINVAL, writing
a read-only file is EACCES, and a missing element is ENOENT.

Tests: `tests/tests/shiro-vitest/dom-fs.test.ts`, `desktop-wm.test.ts`.
