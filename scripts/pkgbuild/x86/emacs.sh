#!/usr/bin/env bash
# GNU Emacs 31.1 (GPL-3.0) for the terminal (emacs -nw) -> static x86-64
# with ncurses; no X/GUI, TLS, images, native compilation or tree-sitter.
# Lisp is installed byte-compiled only (no .el sources); the portable dump
# lives at its compiled-in /usr/libexec path.
. "$(dirname "$0")/common.sh"
VERSION=31.1
SRC=$(gnu_src emacs $VERSION 1da5790d9580c81932b5bf700633114468da7b3412d69faa767daebf974f4586)
setup_musl
deps_ncurses
configure_make "$SRC" --without-x --without-ns --with-x-toolkit=no --without-sound --with-gnutls=no \
  --without-libsystemd --without-dbus --without-gconf --without-gsettings --without-selinux --without-xml2 \
  --without-native-compilation --without-tree-sitter --without-imagemagick --without-jpeg --without-png \
  --without-gif --without-tiff --without-rsvg --without-webp --without-lcms2 --without-harfbuzz \
  --without-cairo --without-libotf --without-m17n-flt --without-xft --without-gpm --without-sqlite3 \
  --without-modules --without-mailutils --without-pop --without-libgmp --without-compress-install \
  --without-small-ja-dic --with-dumping=pdumper --with-file-notification=no --with-zlib \
  LIBS="-lncursesw" CFLAGS="-Os -fno-pie"
(cd "$SRC" && rm -rf stage && make install DESTDIR="$SRC/stage" >install.log 2>&1) || { tail -20 "$SRC/install.log" >&2; exit 1; }

rm -rf "$PKG_OUT/emacs"
install_bin "$SRC/src/emacs" emacs/bin/emacs
for p in emacsclient etags ebrowse; do install_bin "$SRC/lib-src/$p" "emacs/bin/$p"; done
mkdir -p "$PKG_OUT/emacs/share" "$PKG_OUT/emacs/libexec"
cp -r "$SRC/stage/usr/share/emacs" "$PKG_OUT/emacs/share/"
cp -r "$SRC/stage/usr/libexec/emacs" "$PKG_OUT/emacs/libexec/"
# Byte-compiled Lisp only: drop sources that have a .elc (keeps loaddefs and
# the few files that are never compiled), the site-lisp stubs stay
find "$PKG_OUT/emacs/share/emacs/$VERSION/lisp" -name '*.el' | while read -r f; do
  if [ -f "${f}c" ]; then rm -f "$f"; fi
done
# No GUI images or printable refcards; the Japanese input method's dictionary
# (4 MB) and the bootstrap autoloads aren't needed either
rm -rf "$PKG_OUT/emacs/share/emacs/$VERSION/etc/images" "$PKG_OUT/emacs/share/emacs/$VERSION/etc/refcards" \
  "$PKG_OUT/emacs/share/emacs/$VERSION/lisp/leim/ja-dic" "$PKG_OUT/emacs/share/emacs/$VERSION/lisp/ldefs-boot.el"

# Manual pages (man, from pkg install mandoc)
install_man emacs "$SRC/doc/man/emacs.1" "$SRC/doc/man/emacsclient.1" "$SRC/doc/man/etags.1" "$SRC/doc/man/ebrowse.1"
