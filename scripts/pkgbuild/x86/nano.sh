#!/usr/bin/env bash
# GNU nano 9.2 (GPL-3.0-or-later) -> static x86-64 nano, with its syntax files
. "$(dirname "$0")/common.sh"
VERSION=9.2
SRC=$(unpack "$(fetch https://www.nano-editor.org/dist/v9/nano-$VERSION.tar.xz 05ecb99247b782e8a5b3a25ed4101dd034b0236902f7449bc9795b717642f7e9)" nano-$VERSION)
setup_musl
deps_ncurses
configure_make "$SRC" --enable-utf8 --disable-libmagic --disable-speller NCURSESW_LIBS=-lncursesw
install_bin "$SRC/src/nano" nano/bin/nano
rm -rf "$PKG_OUT/nano/share" && mkdir -p "$PKG_OUT/nano/share/nano"
cp "$SRC"/syntax/*.nanorc "$PKG_OUT/nano/share/nano/"
# Highlighting on by default, as distributions ship it
mkdir -p "$PKG_OUT/nano/etc"
printf 'include "/usr/share/nano/*.nanorc"\nset linenumbers\n' >"$PKG_OUT/nano/etc/nanorc"
