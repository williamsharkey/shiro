# GUI app scoreboard

Debian 12 GUI apps installed from the streaming manifest (`public/gui/apps.json`, docs/GUI.md) in the built app, in headless Chromium (4 vCPUs), by `scripts/gui/score.mjs` (`npm run gui-score`). Each app in a fresh browser profile (nothing cached in the browser; the local server's .deb cache warm); text mode `overlay` (docs/DOM-RENDERING.md).

Columns: **installs**; **window**: a desktop window appears, with the time from launch (installed) to it; **renders**: its largest window isn't one flat colour after 8 s; **input**: focusing it and typing `abc 123` changes its pixels (or, if not, clicking into its middle and typing does, or Ctrl+O opens a window or changes them); **text**: the DOM text layer has spans for it (GTK via libshiro-text-hook.so, core X text; Qt and others draw pixels only).

**29/29 install, 24/29 open a window, 23/29 render, 19/29 react to input, 14/29 have DOM text.**


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
| krita | qt5 | 118.3 MB | 15 s | ✓ | 13 s | ✓ | ✓ | ✗ | input: probably nothing open to type into (not investigated) |
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
| audacity | gtk3 | 64.3 MB | 8.1 s | ✗ | – | – | – | – | error window: “Audacity Startup Failure”; wxWidgets: input and text not detected (not investigated) |

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
