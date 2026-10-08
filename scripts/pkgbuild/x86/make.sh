#!/usr/bin/env bash
# GNU make 4.4.1 (GPL-3.0-or-later) -> static x86-64 make
. "$(dirname "$0")/common.sh"
SRC=$(gnu_src make 4.4.1 dd16fb1d67bfab79a72f5e8390735c49e3e8e70b4945a15ab1f81ddb78658fb3 tar.gz)
setup_musl
configure_make "$SRC" --without-guile
install_bin "$SRC/make" make/bin/make
