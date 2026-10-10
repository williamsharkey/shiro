# GUI app scoreboard

Debian 12 GUI apps installed from the streaming manifest (`public/gui/apps.json`, docs/GUI.md) in the built app, in headless Chromium (4 vCPUs), by `scripts/gui/score.mjs` (`npm run gui-score`). Each app in a fresh browser profile (nothing cached in the browser; the local server's .deb cache warm); text mode `overlay` (docs/DOM-RENDERING.md).

Columns: **installs**; **window**: a desktop window appears, with the time from launch (installed) to it; **renders**: its largest window isn't one flat colour after 8 s; **input**: focusing it and typing `abc 123` changes its pixels (or, if not, clicking into its middle and typing does, or Ctrl+O opens a window or changes them); **text**: the DOM text layer has spans for it (GTK via libshiro-text-hook.so, core X text; Qt and others draw pixels only).

**29/29 install, 24/29 open a window, 23/29 render, 18/29 react to input, 14/29 have DOM text.**


### Editors & viewers

| App | Toolkit | Download | Install | Window | First window | Renders | Input | Text | Notes |
|---|---|---:|---:|:-:|---:|:-:|:-:|:-:|---|
| mousepad | gtk3 | 47.3 MB | 5.2 s | ✓ | 17 s | ✓ | ✓ | ✓ (7) |  |
| gedit | gtk3 | 52.1 MB | 5.8 s | ✓ | 14 s | ✓ | ✓ | ✓ (11) |  |
| l3afpad | gtk3 | 45.8 MB | 4.9 s | ✓ | 7.1 s | ✓ | ✓ | ✓ (5) |  |
| evince | gtk3 | 55.4 MB | 6.3 s | ✓ | 15 s | ✓ | ✓ | ✓ (3) |  |
| eog | gtk3 | 53 MB | 6.5 s | ✓ | 15 s | ✓ | ✗ | ✗ | input: probably nothing open to type into (not investigated) |
| ristretto | gtk3 | 47.8 MB | 6.2 s | ✓ | 9.3 s | ✓ | ✓ | ✓ (6) |  |
| gpicview | gtk2 | 39.6 MB | 4.9 s | ✓ | 4.0 s | ✓ | ✗ | ✗ | input: probably nothing open to type into (not investigated) |

### Graphics

| App | Toolkit | Download | Install | Window | First window | Renders | Input | Text | Notes |
|---|---|---:|---:|:-:|---:|:-:|:-:|:-:|---|
| gimp | gtk2 | 66.1 MB | 7.0 s | ✓ | 24 s | ✓ | ✓ | ✓ (2) |  |
| inkscape | gtk3 | 83 MB | 9.9 s | ✓ | 38 s | ✓ | ✓ | ✓ (18) |  |
| krita | qt5 | 118.3 MB | 8.3 s | ✓ | 13 s | ✓ | ✗ | ✗ | input: passed in one of two runs (start screen, nothing open) |
| blender | gl | 231.5 MB | 14 s | ✗ | – | – | – | – | exited (status 134) before a window; OpenCV aborts: "SSE/SSE2 not available" (the x86 engine reports CPU family 0) |

### Desktop

| App | Toolkit | Download | Install | Window | First window | Renders | Input | Text | Notes |
|---|---|---:|---:|:-:|---:|:-:|:-:|:-:|---|
| pcmanfm | gtk2 | 43.6 MB | 3.7 s | ✓ | 6.6 s | ✓ | ✓ | ✓ (5) |  |
| thunar | gtk3 | 48.6 MB | 6.3 s | ✓ | 10 s | ✓ | ✗ | ✓ (14) | input not detected (not investigated) |
| xterm | x11 | 9.3 MB | 1.0 s | ✓ | 1.8 s | ✓ | ✓ | ✓ (1) |  |
| galculator | gtk3 | 46 MB | 5.9 s | ✓ | 11 s | ✓ | ✓ | ✓ (59) |  |

### Office

| App | Toolkit | Download | Install | Window | First window | Renders | Input | Text | Notes |
|---|---|---:|---:|:-:|---:|:-:|:-:|:-:|---|
| gnumeric | gtk3 | 64.3 MB | 5.9 s | ✓ | 20 s | ✓ | ✓ | ✓ (16) |  |
| abiword | gtk3 | 81.2 MB | 6.7 s | ✓ | 21 s | ✓ | ✓ | ✓ (21) |  |
| libreoffice-writer | gtk3 | 154.8 MB | 12 s | ✗ | – | – | – | – | exited (status 139) before a window; soffice.bin is loaded as a flat binary (".bin" name; x86 engine) |

### Internet & media

| App | Toolkit | Download | Install | Window | First window | Renders | Input | Text | Notes |
|---|---|---:|---:|:-:|---:|:-:|:-:|:-:|---|
| firefox-esr | gtk3 | 125.1 MB | 17 s | ✗ | – | – | – | – | exited (status 2816) before a window; crashes itself (MOZ_CRASH) ~20 s into startup |
| netsurf | gtk3 | 56.6 MB | 5.8 s | ✓ | 9.1 s | ✓ | ✓ | ✓ (41) |  |
| dillo | fltk | 11.4 MB | 1.2 s | ✓ | 3.3 s | ✓ | ✓ | ✗ | FLTK draws its text as pixels |
| vlc | qt5 | 36.1 MB | 3.5 s | ✓ | 5.0 s | ✗ | – | ✗ | its window opens, then the Qt interface exits (status 0) |
| audacity | gtk3 | 64.3 MB | 7.1 s | ✗ | – | – | – | – | error window: “Audacity Startup Failure”; SysV shared memory (shmget) is ENOSYS in the x86 engine |

### Qt

| App | Toolkit | Download | Install | Window | First window | Renders | Input | Text | Notes |
|---|---|---:|---:|:-:|---:|:-:|:-:|:-:|---|
| featherpad | qt5 | 34.9 MB | 3.3 s | ✓ | 5.6 s | ✓ | ✓ | ✗ |  |
| qterminal | qt5 | 34.2 MB | 3.1 s | ✓ | 5.8 s | ✓ | ✓ | ✗ |  |
| qpdfview | qt5 | 39.2 MB | 3.3 s | ✓ | 24 s | ✓ | ✗ | ✗ | input: probably nothing open to type into (not investigated) |
| keepassxc | qt5 | 48 MB | 3.8 s | ✓ | 15 s | ✓ | ✓ | ✗ |  |
| kcalc | qt5 | 44.4 MB | 3.7 s | ✓ | 7.8 s | ✓ | ✓ | ✗ |  |
| lximage-qt | qt5 | 36.8 MB | 3.3 s | ✗ | – | – | – | – | exited (status 0) before a window; single-instance check needs a D-Bus session bus |

2026-10-10; per-app details (output tails, window titles) in .gui-score/results.json.

<!-- notes: everything below is kept when the tables are regenerated -->

![The scored apps, each a few seconds after its first window](screenshots/gui-score.png)

## Failures and fixes

Fixed while building the scoreboard (scores above are after these):

- **GIMP's toolbox and dock icons were blank.** Two causes. GTK apps had no SVG
  loader for gdk-pixbuf: `librsvg2-common` is now part of every GTK app's set,
  with a loaders.cache overlay that lists it (`scripts/gui/overlays/gdk-pixbuf-loaders-svg.cache`).
  That made plain SVG icons work, but GIMP's own themes (Symbolic, Color) draw
  every icon with a gradient fill, and librsvg's gradients come out fully
  transparent in the x86 engine (cairo and pixman gradients called directly are
  fine; reported to the engine owners with a repro). Until that is fixed, GIMP
  starts with its PNG "Legacy" icon theme: the launcher writes
  `~/.config/GIMP/2.10/gimprc` with `(icon-theme "Legacy")` when there isn't one
  (manifest field `home`; GIMP ignores the setting in its system gimprc).
  ![GIMP with its toolbox icons](screenshots/gui-gimp-icons.png)
  Cost: the SVG loader adds librsvg and its dependencies, about 12.7 MB per GTK
  app (l3afpad 33.1 → 45.8 MB, GIMP 53.2 → 66.1 MB) — cached once, shared by all.
- **Krita and Audacity were missing libraries** (Audacity then stops at SysV IPC, below): the library closure
  now follows each ELF's RUNPATH/RPATH (PulseAudio's private `libpulsecommon`
  pulls `libsndfile` from there) and Audacity gained `libsoxr0`.
- **Krita opened a "Fatal error" window**: its resources live in an SQLite
  database and Qt's SQLite driver is a plugin (not in the ELF closure):
  `libqt5sql5-sqlite` is now in its set.
- **Blender failed to find LAPACK/BLAS**: Debian picks them with
  update-alternatives in a postinst; the manifest now carries those symlinks
  (`links`) and the installer makes them.
- **Galculator couldn't save its settings** (`~/.config` missing): the
  installer creates the XDG base directories in the home.
- **The scoreboard itself**: one fresh browser profile per app (a shared one
  filled its storage), early exit detection (no 7-minute wait for an app that
  died), windows titled like errors ("Fatal error", "Startup Failure") count as
  no window.

Known failures, not fixed here:

| App | What happens | Where it has to be fixed |
|---|---|---|
| blender | aborts (status 134): OpenCV reports "SSE/SSE2 not available" because CPUID leaf 1 reports family 0, and `/proc/cpuinfo` has no `flags` line | x86 engine (reported) |
| libreoffice-writer | `soffice.bin` is run as a flat binary (by its `.bin` name) and crashes at once (status 139) | x86 engine (reported) |
| firefox-esr | MOZ_CRASH via `tgkill` about 20 s into startup, before a window; e10s and sandbox settings don't change it | not diagnosed |
| audacity | "Audacity Startup Failure: Unable to create shared memory segment" — SysV IPC (`shmget`, `semget`) returns ENOSYS | x86 engine syscalls (reported) |
| vlc | the Qt interface's window appears for a moment, then VLC exits with status 0 and logs nothing (even with `-vv`); most of its 350 plugins are left out (their libraries aren't in the set) | not diagnosed |
| lximage-qt | exits at once: its single-instance check needs a D-Bus session bus | needs a session bus |

Input ✗ on viewers (eog, gpicview, qpdfview) most likely means nothing was open
to type into and Ctrl+O's file dialog didn't open a new window in time; the text
column is ✗ for Qt, FLTK and wxWidgets apps by design: only GTK (through
`libshiro-text-hook.so`) and core X text report their text.

### Re-running

```
npm run build
npm run gui-score                     # every app not scored for its current package versions
npm run gui-score -- --only gimp,krita --rescore
npm run gui-score -- --report-only    # rewrite the tables from .gui-score/results.json
```

Results are cached per app by its exact package versions in
`.gui-score/results.json`, screenshots in `.gui-score/shots/`.
