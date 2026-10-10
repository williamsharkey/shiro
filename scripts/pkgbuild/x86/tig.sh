#!/usr/bin/env bash
# tig 2.5.12 (GPL-2.0-or-later) -> static x86-64 tig, a text-mode interface for git
. "$(dirname "$0")/common.sh"
VERSION=2.5.12
SRC=$(unpack "$(fetch https://github.com/jonas/tig/releases/download/tig-$VERSION/tig-$VERSION.tar.gz 5dda8a098810bb499096e17fc9f69c0a5915a23f46be27209fc8195d7a792108)" tig-$VERSION)
setup_musl
deps_ncurses
cd "$SRC"
./configure --host=$HOST --prefix=/usr --sysconfdir=/etc --with-ncursesw --without-readline \
  CPPFLAGS="$CPPFLAGS -I$SYSROOT/include/ncursesw" LIBS="-lncursesw" >configure.log
make -j"$(nproc)" >make.log
install_bin src/tig tig/bin/tig
# its default key bindings and colours (tig reads /etc/tigrc first)
mkdir -p "$PKG_OUT/tig/etc"
cp tigrc "$PKG_OUT/tig/etc/tigrc"
install_man tig doc/tig.1 doc/tigrc.5 2>/dev/null || true
