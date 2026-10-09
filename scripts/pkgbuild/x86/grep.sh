#!/usr/bin/env bash
# GNU grep 3.12 (GPL-3.0-or-later) -> static x86-64 grep (egrep, fgrep)
. "$(dirname "$0")/common.sh"
SRC=$(gnu_src grep 3.12 2649b27c0e90e632eadcd757be06c6e9a4f48d941de51e7c0f83ff76408a07b9)
setup_musl
configure_make "$SRC" --disable-perl-regexp
install_bin "$SRC/src/grep" grep/bin/grep

# Manual pages (man, from pkg install mandoc)
install_man grep "$SRC/doc/grep.1"
man_alias grep egrep.1 grep.1
man_alias grep fgrep.1 grep.1
