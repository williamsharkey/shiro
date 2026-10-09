#!/usr/bin/env bash
# GNU gzip 1.15 (GPL-3.0-or-later) -> static x86-64 gzip (gunzip, zcat are scripts upstream; links here)
. "$(dirname "$0")/common.sh"
SRC=$(gnu_src gzip 1.15 9aa0cc780dec156b8282844833b342ab7cb08c25d2cd9a1869cdd0df31deff48)
setup_musl
configure_make "$SRC"
install_bin "$SRC/gzip" gzip/bin/gzip
