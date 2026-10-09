#!/usr/bin/env bash
# less 710 (GPL-3.0-or-later / BSD-2-Clause) -> static x86-64 less, lessecho
. "$(dirname "$0")/common.sh"
VERSION=710
SRC=$(unpack "$(fetch https://www.greenwoodsoftware.com/less/less-$VERSION.tar.gz d1008fb78dcae1323ddab664bcb352a61f022b1b131bd8018548e021d975ec7a)" less-$VERSION)
setup_musl
deps_ncurses
cd "$SRC"
./configure --host=$HOST --prefix=/usr --sysconfdir=/etc --with-regex=posix >configure.log
make -j"$(nproc)" less lessecho >make.log
for b in less lessecho; do install_bin $b less/bin/$b; done

# Manual pages (man, from pkg install mandoc)
install_man less "$SRC/less.nro:less.1" "$SRC/lessecho.nro:lessecho.1"
