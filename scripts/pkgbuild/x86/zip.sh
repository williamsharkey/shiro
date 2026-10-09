#!/usr/bin/env bash
# Info-ZIP zip 3.0 with Debian's patches (Info-ZIP license) -> static x86-64 zip
. "$(dirname "$0")/common.sh"
SRC=$(unpack "$(fetch https://deb.debian.org/debian/pool/main/z/zip/zip_3.0.orig.tar.gz f0e8bb1f9b7eb0b01285495a2699df3a4b766784c1765a8f1aeedf63c0806369)" zip30)
DEB=$(fetch https://deb.debian.org/debian/pool/main/z/zip/zip_3.0-13.debian.tar.xz 4f5aca2d9f6021d2fd73f2fc16e9a392ab98673a940b44cf78fe38b8cdec1ab9)
tar xJf "$DEB" -C "$SRC"
(cd "$SRC" && while read -r p; do [ -n "$p" ] && [ "${p#\#}" = "$p" ] && patch -p1 -s <"debian/patches/$p"; done <debian/patches/series)
setup_musl
make -C "$SRC" -f unix/Makefile generic CC="$CC" LFLAGS1="$LDFLAGS" CFLAGS_NOOPT="-I. -DUNIX $CFLAGS -DLARGE_FILE_SUPPORT -DUNICODE_SUPPORT" >"$SRC/make.log" 2>&1
install_bin "$SRC/zip" zip/bin/zip

# Manual pages (man, from pkg install mandoc)
install_man zip "$SRC/man/zip.1"
