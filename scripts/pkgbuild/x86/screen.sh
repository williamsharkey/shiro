#!/usr/bin/env bash
# GNU screen 5.0.2 (GPL-3.0-or-later) -> static x86-64 screen, with ncurses 6.5
. "$(dirname "$0")/common.sh"
VERSION=5.0.2
SRC=$(gnu_src screen $VERSION ca9a2c7e240919bc7ac12124593ae4529bb4eb5f7349d8857829b7e3f0b3b332 tar.gz)
setup_musl
deps_ncurses
# No PAM or utmp; sockets in ~/.screen (no setuid global socket directory)
configure_make "$SRC" --disable-pam --disable-utmp --disable-socket-dir --with-system_screenrc=/etc/screenrc \
  CPPFLAGS="-I$SYSROOT/include -I$SYSROOT/include/ncursesw" LDFLAGS="-L$SYSROOT/lib -static -no-pie" LIBS="-lncursesw"
install_bin "$SRC/screen" screen/bin/screen
