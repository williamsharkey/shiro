#!/usr/bin/env bash
# procps-ng 4.0.7 (GPL-2.0-or-later, LGPL-2.1 libproc2) -> static x86-64 top, ps, free,
# uptime, pgrep, pkill, pidof, watch, vmstat, w, with ncurses 6.5
. "$(dirname "$0")/common.sh"
VERSION=4.0.7
SRC=$(unpack "$(fetch https://downloads.sourceforge.net/project/procps-ng/Production/procps-ng-$VERSION.tar.xz 9d2021f47a4501c667862c9942a92d1953694b21d11bcd1702e83eb594e3d67d)" procps-ng-$VERSION)
setup_musl
deps_ncurses
export PKG_CONFIG_PATH="$SYSROOT/lib/pkgconfig" PKG_CONFIG_LIBDIR="$SYSROOT/lib/pkgconfig"
MAKE_ARGS='LDFLAGS=-all-static -L'"$SYSROOT"'/lib -no-pie' configure_make "$SRC" --disable-shared --enable-static --without-systemd --without-elogind \
  --disable-numa --enable-watch8bit --disable-kill --disable-pidwait \
  CPPFLAGS="-I$SYSROOT/include -I$SYSROOT/include/ncursesw" LDFLAGS="-L$SYSROOT/lib -static -no-pie" \
  NCURSES_CFLAGS="-I$SYSROOT/include/ncursesw" NCURSES_LIBS="-lncursesw" NCURSESW_CFLAGS="-I$SYSROOT/include/ncursesw" NCURSESW_LIBS="-lncursesw"
rm -rf "$PKG_OUT/procps"
for p in src/top/top src/ps/pscommand src/free src/uptime src/pgrep src/pidof src/watch src/vmstat src/w; do
  name=$(basename "$p"); [ "$name" = pscommand ] && name=ps
  install_bin "$SRC/$p" procps/bin/$name
done

# Manual pages (man, from pkg install mandoc)
install_man procps "$SRC/man/ps.1" "$SRC/man/top.1" "$SRC/man/free.1" "$SRC/man/uptime.1" "$SRC/man/pgrep.1" "$SRC/man/pkill.1" "$SRC/man/pidof.1" "$SRC/man/watch.1" "$SRC/man/vmstat.8" "$SRC/man/w.1"
