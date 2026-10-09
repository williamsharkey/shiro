#!/usr/bin/env bash
# file 5.46 (BSD-2-Clause) -> static x86-64 file, with its compiled magic database
. "$(dirname "$0")/common.sh"
VERSION=5.46
SRC=$(unpack "$(fetch https://astron.com/pub/file/file-$VERSION.tar.gz c9cc77c7c560c543135edc555af609d5619dbef011997e988ce40a3d75d86088)" file-$VERSION)
setup_musl
deps_zlib
MAKE_ARGS="LDFLAGS=$LDFLAGS -all-static" configure_make "$SRC" --disable-shared --enable-static --disable-libseccomp --disable-bzlib --disable-xzlib --disable-zstdlib --disable-lzlib --datadir=/usr/share
install_bin "$SRC/src/file" file/bin/file
mkdir -p "$PKG_OUT/file/share/misc"
cp "$SRC/magic/magic.mgc" "$PKG_OUT/file/share/misc/magic.mgc"
