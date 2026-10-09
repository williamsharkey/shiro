#!/usr/bin/env bash
# GNU bc 1.08.2 (GPL-3.0-or-later) -> static x86-64 bc, dc
. "$(dirname "$0")/common.sh"
SRC=$(gnu_src bc 1.08.2 ae470fec429775653e042015edc928d07c8c3b2fc59765172a330d3d87785f86 tar.gz)
setup_musl
configure_make "$SRC"
install_bin "$SRC/bc/bc" bc/bin/bc
install_bin "$SRC/dc/dc" bc/bin/dc

# Manual pages (man, from pkg install mandoc)
install_man bc "$SRC/doc/bc.1" "$SRC/doc/dc.1"
