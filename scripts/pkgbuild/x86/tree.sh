#!/usr/bin/env bash
# tree 2.2.1 (GPL-2.0-or-later) -> static x86-64 tree
. "$(dirname "$0")/common.sh"
VERSION=2.2.1
SRC=$(unpack "$(fetch https://gitlab.com/OldManProgrammer/unix-tree/-/archive/$VERSION/unix-tree-$VERSION.tar.gz 70d9c6fc7c5f4cb1f7560b43e2785194594b9b8f6855ab53376f6bd88667ee04)" unix-tree-$VERSION)
setup_musl
make -C "$SRC" -j"$(nproc)" CC="$CC" CFLAGS="$CFLAGS -DLINUX -D_LARGEFILE64_SOURCE -D_FILE_OFFSET_BITS=64" LDFLAGS="$LDFLAGS" >"$SRC/make.log" 2>&1
install_bin "$SRC/tree" tree/bin/tree

# Manual pages (man, from pkg install mandoc)
install_man tree "$SRC/doc/tree.1"
