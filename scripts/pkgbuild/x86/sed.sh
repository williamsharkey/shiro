#!/usr/bin/env bash
# GNU sed 4.10 (GPL-3.0-or-later) -> static x86-64 sed
. "$(dirname "$0")/common.sh"
SRC=$(gnu_src sed 4.10 b8e72182b2ec96a3574e2998c47b7aaa64cc20ce000d8e9ac313cc07cecf28c7)
setup_musl
configure_make "$SRC"
install_bin "$SRC/sed/sed" sed/bin/sed

# Manual pages (man, from pkg install mandoc)
install_man sed "$SRC/doc/sed.1"
