#!/usr/bin/env bash
# GNU diffutils 3.12 (GPL-3.0-or-later) -> static x86-64 diff, cmp, diff3, sdiff
. "$(dirname "$0")/common.sh"
SRC=$(gnu_src diffutils 3.12 7c8b7f9fc8609141fdea9cece85249d308624391ff61dedaf528fcb337727dfd)
setup_musl
configure_make "$SRC"
for b in diff cmp diff3 sdiff; do install_bin "$SRC/src/$b" diffutils/bin/$b; done

# Manual pages (man, from pkg install mandoc)
install_man diffutils "$SRC/man/diff.1" "$SRC/man/cmp.1" "$SRC/man/diff3.1" "$SRC/man/sdiff.1"
