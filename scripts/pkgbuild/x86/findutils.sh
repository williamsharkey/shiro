#!/usr/bin/env bash
# GNU findutils 4.11.0 (GPL-3.0-or-later) -> static x86-64 find, xargs
. "$(dirname "$0")/common.sh"
SRC=$(gnu_src findutils 4.11.0 bfd19cb06cc71f3352d567e90284d8cdac02ac89774bbeadf0b533b0c11432fd)
setup_musl
configure_make "$SRC"
install_bin "$SRC/find/find" findutils/bin/find
install_bin "$SRC/xargs/xargs" findutils/bin/xargs
