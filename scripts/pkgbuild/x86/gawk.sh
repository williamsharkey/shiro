#!/usr/bin/env bash
# GNU awk 5.4.1 (GPL-3.0-or-later) -> static x86-64 gawk (also awk)
. "$(dirname "$0")/common.sh"
SRC=$(gnu_src gawk 5.4.1 07f6f7342b7febe4313fc2c2542ad93d64fe20ad8717200109f105a826f5fd37)
setup_musl
configure_make "$SRC" --without-readline --without-mpfr --disable-extensions --disable-pma
install_bin "$SRC/gawk" gawk/bin/gawk

# Manual pages (man, from pkg install mandoc)
install_man gawk "$SRC/doc/gawk.1"
man_alias gawk awk.1 gawk.1
