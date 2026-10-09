#!/usr/bin/env bash
# XZ Utils 5.8.1 (0BSD / public domain; xzgrep etc. GPL) -> static x86-64 xz (unxz, xzcat, lzma)
. "$(dirname "$0")/common.sh"
VERSION=5.8.1
SRC=$(unpack "$(fetch https://github.com/tukaani-project/xz/releases/download/v$VERSION/xz-$VERSION.tar.gz 507825b599356c10dca1cd720c9d0d0c9d5400b9de300af00e4d1ea150795543)" xz-$VERSION)
setup_musl
MAKE_ARGS="LDFLAGS=$LDFLAGS -all-static" configure_make "$SRC" --disable-shared --enable-static --disable-doc --disable-scripts --disable-lzmadec --disable-xzdec --disable-lzmainfo
install_bin "$SRC/src/xz/xz" xz/bin/xz

# Manual pages (man, from pkg install mandoc)
install_man xz "$SRC/src/xz/xz.1"
man_alias xz unxz.1 xz.1
man_alias xz xzcat.1 xz.1
man_alias xz lzma.1 xz.1
