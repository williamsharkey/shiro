#!/usr/bin/env bash
# GNU tar 1.35 (GPL-3.0-or-later) -> static x86-64 tar (runs gzip/xz/zstd/bzip2 for -z/-J/--zstd/-j)
. "$(dirname "$0")/common.sh"
SRC=$(gnu_src tar 1.35 4d62ff37342ec7aed748535323930c7cf94acf71c3591882b26a7ea50f3edc16)
setup_musl
export FORCE_UNSAFE_CONFIGURE=1
configure_make "$SRC" --without-selinux --without-posix-acls --without-xattrs
install_bin "$SRC/src/tar" tar/bin/tar
