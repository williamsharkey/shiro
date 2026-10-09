#!/usr/bin/env bash
# rsync 3.5.1 (GPL-3.0-or-later) -> static x86-64 rsync (zlib; built-in popt and md5)
. "$(dirname "$0")/common.sh"
VERSION=3.5.1
SRC=$(unpack "$(fetch https://download.samba.org/pub/rsync/src/rsync-$VERSION.tar.gz c55f9c9dc10fb8bec397b399a0fdded53cc9a2d8e30891bb0d63724d25c37bef)" rsync-$VERSION)
setup_musl
deps_zlib
configure_make "$SRC" --disable-xxhash --disable-zstd --disable-lz4 --disable-openssl --disable-md2man --disable-acl-support \
  --disable-xattr-support --disable-idn --with-included-popt --without-included-zlib --disable-locale \
  CPPFLAGS="-I$SYSROOT/include" LDFLAGS="-L$SYSROOT/lib -static -no-pie"
install_bin "$SRC/rsync" rsync/bin/rsync
