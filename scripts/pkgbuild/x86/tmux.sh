#!/usr/bin/env bash
# tmux 3.8 (ISC) -> static x86-64 tmux, with libevent 2.1 and ncurses 6.5
. "$(dirname "$0")/common.sh"
VERSION=3.8
SRC=$(unpack "$(fetch https://github.com/tmux/tmux/releases/download/$VERSION/tmux-$VERSION.tar.gz e79c699c7e949dccd0a4a125e17b8d1261e311b16979dbc8eb34542f3966d82e)" tmux-$VERSION)
setup_musl
deps_ncurses
deps_libevent
export PKG_CONFIG_PATH="$SYSROOT/lib/pkgconfig" PKG_CONFIG_LIBDIR="$SYSROOT/lib/pkgconfig"
configure_make "$SRC" --enable-static --disable-utf8proc \
  CPPFLAGS="-I$SYSROOT/include -I$SYSROOT/include/ncursesw" LDFLAGS="-L$SYSROOT/lib -static" \
  LIBEVENT_CORE_CFLAGS="-I$SYSROOT/include" LIBEVENT_CORE_LIBS="-levent_core" \
  LIBNCURSES_CFLAGS="-I$SYSROOT/include/ncursesw" LIBNCURSES_LIBS="-lncursesw"
install_bin "$SRC/tmux" tmux/bin/tmux
