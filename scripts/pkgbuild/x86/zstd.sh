#!/usr/bin/env bash
# Zstandard 1.5.7 (BSD-3-Clause OR GPL-2.0) -> static x86-64 zstd (unzstd, zstdcat)
. "$(dirname "$0")/common.sh"
VERSION=1.5.7
SRC=$(unpack "$(fetch https://github.com/facebook/zstd/releases/download/v$VERSION/zstd-$VERSION.tar.gz eb33e51f49a15e023950cd7825ca74a4a2b43db8354825ac24fc1b7ee09e6fa3)" zstd-$VERSION)
setup_musl
make -C "$SRC/programs" -j"$(nproc)" zstd CC="$CC" CFLAGS="$CFLAGS" LDFLAGS="$LDFLAGS" HAVE_ZLIB=0 HAVE_LZMA=0 HAVE_LZ4=0 HAVE_THREAD=1 >"$SRC/make.log" 2>&1
install_bin "$SRC/programs/zstd" zstd/bin/zstd
