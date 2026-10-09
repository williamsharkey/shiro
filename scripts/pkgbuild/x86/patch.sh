#!/usr/bin/env bash
# GNU patch 2.8 (GPL-3.0-or-later) -> static x86-64 patch
. "$(dirname "$0")/common.sh"
SRC=$(gnu_src patch 2.8 f87cee69eec2b4fcbf60a396b030ad6aa3415f192aa5f7ee84cad5e11f7f5ae3)
setup_musl
configure_make "$SRC"
install_bin "$SRC/src/patch" patch/bin/patch

# Manual pages (man, from pkg install mandoc)
install_man patch "$SRC/patch.man:patch.1"
