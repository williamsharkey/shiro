#!/usr/bin/env bash
# htop 3.5.3 (GPL-2.0-or-later) -> static x86-64 htop, with ncurses 6.5
. "$(dirname "$0")/common.sh"
VERSION=3.5.3
SRC=$(unpack "$(fetch https://github.com/htop-dev/htop/releases/download/$VERSION/htop-$VERSION.tar.xz a8b164386494cb85bb255a415a3f5f80afe7a0c4491da5d113b3a0f951087e65)" htop-$VERSION)
setup_musl
deps_ncurses
configure_make "$SRC" --enable-static --enable-unicode --disable-sensors --disable-capabilities --disable-hwloc --disable-delayacct \
  CPPFLAGS="-I$SYSROOT/include -I$SYSROOT/include/ncursesw" LDFLAGS="-L$SYSROOT/lib -static -no-pie" LIBS="-lncursesw"
install_bin "$SRC/htop" htop/bin/htop
