# Linux GUI apps (X11)

Unmodified Linux GUI programs run in Shiro and show up as ordinary desktop
windows: an X11 server written in TypeScript runs in the page (`Xshiro :0`,
a kernel process), x86-64 Debian binaries run in Blink and connect to it over
the kernel's AF_UNIX socket `/tmp/.X11-unix/X0`, and each top-level X window
becomes a desktop window (unix/desktop's `surface` windows, docs/DESKTOP.md).
Apps and their libraries come from Debian bookworm, fetched the first time an
app starts and cached in the browser by content hash.

```sh
gui                      # the apps, what the first launch downloads, installed or not
gui xterm                # install on first use, then start it (in the background)
gui install featherpad   # just install
gui info l3afpad         # packages, sizes, what was left out
xserver                  # display :0: process, clients, windows
```

On the desktop the dock has XTerm, L3afpad, Ristretto, FeatherPad and xeyes
(more with `desktop open ID`); the first click shows a download window, then
the app's own window. Any X client can be started directly too
(`DISPLAY=:0` is set in the shell): `xterm &` after `gui install xterm`.

Screenshots: [docs/screenshots/](screenshots/) (`gui-*.png`): the desktop
with xeyes, xclock, xterm, FeatherPad (Qt 5) and GPicView (GTK 2) in
Chromium (`gui-desktop.png`), one per app, and GTK 3 l3afpad composed by the
server under Node (`gui-l3afpad-node.png`, see the GTK 3 note below).

![Debian GUI apps on the desktop](screenshots/gui-desktop.png)

## What runs

Measured in headless Chromium 141 (cross-origin isolated, local `server.mjs`
with network to deb.debian.org; 4-vCPU container), `scripts/gui/shoot.mjs`.
"First launch" counts from `gui APP` (packages already installed) to the
window, and to its first drawn frame; "warm" is a second launch in the same
page. Install = download + unpack + triggers, from the network; "from cache" =
the same install again from the browser's Cache Storage (after a filesystem
reset, e.g.).

| App | Toolkit | Download (first run) | Install | From cache | First frame | Warm | Status |
|---|---|---:|---:|---:|---:|---:|---|
| xeyes | Xlib/Xt, SHAPE | 7.5 MB (25 pkgs) | 1.9–2.0 s | 1.4–1.5 s | 0.9–1.3 s | 0.5 s | works (shaped window, follows the pointer) |
| xclock | Xaw, RENDER | 8.9 MB | 0.2–0.5 s¹ | 1.7 s | 2.6–2.8 s | 1.4 s | works (antialiased hands via RENDER) |
| xterm | Xaw, core fonts, pty | 9.3 MB (33 pkgs) | 2.1 s | 1.7 s | 2.5–2.7 s | 1.6–1.9 s | works: Shiro's shell in its pty, typing |
| featherpad | Qt 5.15 (xcb) | 35.0 MB (73 pkgs; closure 84 MB) | 6.1–7.8 s | 7.0–8.2 s | 10.5–16 s | 8.9–14.7 s | works (menus, icons, editing) |
| gpicview | GTK 2.24 | 26.8 MB (64 pkgs) | 4.8–7.6 s | 7.2–7.6 s | 6.9–9.7 s | 6.7 s | works (opens a PNG) |
| l3afpad | GTK 3.24 | 33.1 MB (81 pkgs; closure 51 MB) | 10.3 s | — | **stalls**² | — | renders under Node: first frame ~9 s (JIT), ~20 s (`BLINK_WJIT=0`) |
| ristretto, mousepad | GTK 3 | 34.8 / 45.1 MB | — | — | — | — | not checked (GTK 3, as l3afpad) |
| lximage-qt | Qt 5 | 38.1 MB | — | — | — | — | not checked |

Ranges are the runs of this session (the 4-vCPU container was busy to
different degrees). "Warm" is close + start again in the same page: it is
about as slow as the first start because startup time is Blink loading and
relocating ~70 shared libraries and running toolkit init, not downloading.

¹ xclock shares all packages with xeyes, installed just before.
² GTK 3 maps its window, then the guest stops making syscalls while one core
stays at 100%. Blink-side; reported to the perf-blink session with a repro.
Under Node it also stalls in ~2 of 3 runs with the JIT on, never with
`BLINK_WJIT=0`; in Chromium both stall. GTK 2 and Qt 5 work in the same
browser, so GTK apps launch with `BLINK_WJIT=0` until it's fixed.

Status per app also in [COMPAT.md](COMPAT.md#linux-gui-apps-unixgui).

## How it works

### Choosing the display route (measured)

| Route | Result |
|---|---|
| Debian's real Xvfb (x86-64) in Blink, plus a compositing bridge | Starts (3 s to keyboard init) but needs hard links (`/tmp/.X0-lock`), uid 0 for `-nolock`, and an xkbcomp child through `popen`; pulls 69 MB of debs (Mesa, LLVM); and has no rootless mode: every window's pixels would have to be read back through the socket, rendered by an interpreted pixman. |
| Wayland compositor (wl_shm) | wl_shm needs a client's memfd mapping to be shared with the compositor. Blink copies `MAP_SHARED` file mappings into the guest and writes them back only on `msync`/`munmap`, so buffers never reach the compositor. GTK 3 and Qt 5 both speak X11 anyway. |
| **X11 server in the page (this)** | Rootless by construction, zero download (the 180 KB gzip chunk loads on the first client), drawing in V8-compiled JS straight into per-window backing stores, composed into the desktop's canvases. Debian xeyes connected through Blink + the kernel's AF_UNIX socket and mapped its window 1.1 s after spawn on the first try. |

### The server (`src/x11/`)

- `server.ts`: connection setup (one 24-bit TrueColor screen plus a 32-bit
  ARGB visual; pixmap depths 1/8/16/24/32), the core protocol (windows and
  stacking, properties, atoms, selections, GCs, all drawing requests,
  images, core fonts, colors, cursors, grabs, focus, keyboard and pointer
  events with propagation and implicit grabs), and extensions BIG-REQUESTS,
  XC-MISC and SHAPE. Every drawable owns a `Pix` (Uint32Array of X pixel
  values); there is no shared framebuffer, so nothing needs Expose for being
  uncovered.
- `raster.ts`: the core rasterizer: spans clipped by GC clip rectangles or
  masks, raster functions, plane masks, tiles and stipples, thin/wide/dashed
  lines, arcs, polygons with both fill rules, images (XYBitmap, XYPixmap,
  ZPixmap; LSBFirst, pad 32), glyph text.
- `render.ts`: RENDER 0.11 in software: formats a8r8g8b8, x8r8g8b8, a8, a1,
  r5g6b5; Porter-Duff operators (premultiplied), solid/linear/radial/conical
  sources, transforms with nearest/bilinear filters, repeat modes, clips;
  glyph sets (Xft, cairo, Qt text); antialiased trapezoids and triangles
  (4× vertical, exact horizontal coverage); ARGB cursors.
- `fonts.ts` + `fonts-data.ts`: the misc-fixed bitmap fonts of Debian's
  xfonts-base (public domain), converted by `scripts/gui/gen-fonts.py`, with
  their XLFD names and aliases (`fixed`, `9x15`, ...). Names that match
  nothing fall back to the closest fixed size instead of BadName.
- `keymap.ts`: KeyboardEvent.code → evdev keycodes (+8, like Xorg), a US
  core keymap; characters the layout can't type get a spare keycode remapped
  on the fly (MappingNotify), and Shift is synthesized when a shifted
  character arrives without a Shift keydown.
- The root window carries a `RESOURCE_MANAGER` with `Xft.dpi: 96` and font
  rendering defaults (Qt drew 1 px text without it).
- `compose.ts`: composes a toplevel's subtree (borders, stacking, SHAPE
  clipping of descendants, ARGB windows) into RGBA for `putImageData`, only
  over the damaged rectangle.
- `rootless.ts`: toplevels ↔ desktop windows. Title (`_NET_WM_NAME`,
  `WM_NAME`), size hints (min/max, resize increments), transient dialogs,
  undecorated windows (override-redirect, `_MOTIF_WM_HINTS`, menu/tooltip
  window types), close → `WM_DELETE_WINDOW` (or kill the client), focus →
  `SetInputFocus` + `WM_TAKE_FOCUS`, user moves → synthetic ConfigureNotify
  like a reparenting WM, user resizes → ConfigureWindow. Pointer, buttons,
  wheel (40 px per click → buttons 4/5/6/7) and keys come in as normalized
  input events. The window's app id is the `WM_CLASS` instance, so dock
  icons find their windows.
- `display.ts`: `Xshiro :N`, a kernel process (it shows in `ps`) listening on
  `/tmp/.X11-unix/XN` and on the abstract name libxcb tries first; started at
  boot, ~1 KB. `session.ts` creates the server on the first connection.

### Window hosts (`src/gui/`)

`window-host.ts` is the interface rootless windows need (shaped like the
desktop's Surface: `present`, normalized input, configure). `desktop-host.ts`
implements it with `createWindow({content: {kind: 'surface', scale: 1,
autoResize: false}})`; one X pixel is one CSS px. `standin-host.ts` is a
self-contained floating-window host for the classic full-page terminal UI.

### Packages: content addressed, streamed on first use

- `public/gui/apps.json` is generated offline by `scripts/gui/gen-apps.py`
  from Debian's Packages index: for each app, the dependency closure is
  unpacked and reduced to what the app needs to *start*: the ELF `DT_NEEDED`
  closure of its binaries and of the toolkit plugins it always loads (Qt's
  xcb platform plugin, gdk-pixbuf loaders), plus architecture-independent
  data packages (themes, icons, fonts, schemas). Libraries reached only by
  `dlopen` of optional modules — Mesa and LLVM through libglvnd (Qt asks for
  GLX, which Xshiro doesn't offer), CUPS print backends, Kerberos, ICU via
  libxml2 — are never downloaded. That halves Qt (84 → 35 MB).
- Each package is identified by the sha256 of its `.deb` from the signed
  index. `src/gui/apps.ts` looks it up in the browser's Cache Storage under
  that hash (shared by all apps, kept across filesystem resets), else fetches
  `GET /debian/pool/...` (server.mjs proxies the mirror, which sends no CORS
  headers; it caches on disk and falls back to snapshot.debian.org when a
  point release removed the file), verifies the hash, and unpacks it in the
  page (ar, then data.tar.xz/zst/gz with Shiro's JS codecs). Docs, man pages
  and translations are skipped; files a library package would put over
  Shiro's own commands in `/usr/bin` are skipped too.
- Then the postinst work dpkg triggers would do runs in Blink:
  `gdk-pixbuf-query-loaders --update-cache`, `glib-compile-schemas`.
  Generated files whose generator would cost more than they do are built
  once by gen-apps.py and shipped content-addressed as overlays
  (`public/gui/overlay/<sha256>`): today `/usr/share/mime/mime.cache`
  (148 KB), without which GIO can't sniff file types and gdk-pixbuf can't
  load PNGs (update-mime-database needs libxml2 + ICU, 10 MB).
- State: `/var/lib/shiro-gui/status.json` (package versions, apps).
- unix/debian builds the general route (a lazily streamed Debian rootfs with
  real apt under Blink); this is the GUI-specific fast path and uses the same
  identities (Debian package files by hash), so it can be replaced by or fed
  from apt's cache.

## Tests

- `tests/tests/shiro-vitest/x11.test.ts`: protocol (setup, windows, Expose,
  drawing and composition, PutImage/GetImage/CopyArea, properties, input
  events with implicit grabs, resize with bit gravity, core fonts, selections,
  SHAPE, RENDER fills/glyphs/trapezoids, key mapping), and the kernel path:
  a static x86-64 client (`fixtures/x86/xclient.c`, raw protocol) in Blink
  connects to `Xshiro :0`, draws, gets a button press and resizes itself.
- `gui-apps.test.ts`: `.deb` parsing, install (hash check, symlinks, skipped
  docs, status), launching the installed ELF on the display.
- `kernel-pty.test.ts`: `/dev/tty` after a session leader acquires a pty
  (xterm's child needed it).
- `gui-probe.test.ts` (manual, `GUI_PROBE_ROOT`): run any Debian rootfs X
  client in Blink against a headless Xshiro; reports timings, X request
  counts, syscalls in flight and PNGs (`scripts/gui/debfetch.py` builds the
  rootfs).
- `scripts/gui/shoot.mjs`: the browser numbers and screenshots above.
- `scripts/gui/xdev.ts`: the server on a real Unix socket under Node for
  native clients (fast protocol debugging).

## Known gaps and next steps

1. **GTK 3 in Chromium** (stall after map, Blink side) — with perf-blink.
   Until then GTK apps start with `BLINK_WJIT=0`.
2. **Speed of toolkit startup** is Blink's: Qt reaches its first frame in
   ~10 s, GTK 2 ~15 s. Snapshotting a started process, caching JIT output
   across runs, and WASM builds of the toolkits (Qt for WebAssembly has an
   xcb-less platform; GTK's Broadway) are the levers.
3. **Clipboard**: X selections work between X clients; bridging CLIPBOARD
   and PRIMARY to the browser clipboard is next (the server already has
   `hostOwnSelection`).
4. **Extensions not yet offered**: MIT-SHM (Blink can't share guest memory
   with the page yet), XKEYBOARD (toolkits fall back to the core keymap),
   XInputExtension 2 (core input only: no smooth scrolling or touch),
   RANDR (one fixed screen = the work area when the server starts), XFIXES,
   DAMAGE, Composite, GLX.
5. **HiDPI**: surfaces run at scale 1; a device-pixel screen plus
   `Xft.dpi = 96 × devicePixelRatio` would make text sharp.
6. **Per-file laziness**: packages are fetched whole, before start; a kernel
   open hook (unix/kernel) would let files materialize on first open.
7. **Wayland** (wl_shm) once Blink can share mappings with the page.
8. Stretch apps (GIMP 139 MB closure, Inkscape 94 MB) after GTK 3 runs.
