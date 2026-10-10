# Fontconfig caches for the font packages' directories

Files named `PACKAGE/md5(directory)-le64.cache-8`, made by Debian 12's fontconfig in
Blink and shipped as overlays (gen-apps.py) with the package that owns the
directory. Fontconfig keeps a directory's mtime in its cache and rescans when
it differs, so the installer gives each font directory that holds exactly its
package's files the fixed mtime `FONT_DIR_MTIME_MS` (2023-01-01,
`src/gui/apps.ts` `pinFontDirs`); these caches were made with that mtime.

To remake them (after a font package changes):

1. Build and serve the app with the current manifest (its `fontDirs`).
2. In the desktop's shell, install apps that bring the font packages
   (`gui install l3afpad`, `gui install libreoffice-writer`, …).
3. Run a program that calls `FcInit()` (any GTK app does it at start), which
   writes `/var/cache/fontconfig/*.cache-8`.
4. Copy each leaf directory's cache out, into the subdirectory named after the
   package whose files alone are in that directory (e.g. `od -An -v -tx1 FILE` and decode
   it on the host) into this directory, then run gen-apps.py.
