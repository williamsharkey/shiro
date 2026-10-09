#!/usr/bin/env bash
# Info-ZIP unzip 6.0 with Debian's patches (security fixes; Info-ZIP license) -> static x86-64 unzip, zipinfo
. "$(dirname "$0")/common.sh"
SRC=$(unpack "$(fetch https://deb.debian.org/debian/pool/main/u/unzip/unzip_6.0.orig.tar.gz 036d96991646d0449ed0aa952e4fbe21b476ce994abc276e49d30e686708bd37)" unzip60)
DEB=$(fetch https://deb.debian.org/debian/pool/main/u/unzip/unzip_6.0-28.debian.tar.xz e51364116c84739c591728ecc841113a914fa11358fd10ff0d6813524d811bb9)
tar xJf "$DEB" -C "$SRC"
(cd "$SRC" && while read -r p; do [ -n "$p" ] && [ "${p#\#}" = "$p" ] && patch -p1 -s <"debian/patches/$p"; done <debian/patches/series)
setup_musl
make -C "$SRC" -f unix/Makefile unzips CC="$CC" LF2="$LDFLAGS" \
  CF="$CFLAGS -I. -DUNIX -DLARGE_FILE_SUPPORT -DUNICODE_SUPPORT -DUNICODE_WCHAR -DUTF8_MAYBE_NATIVE -DNO_LCHMOD -DDATE_FORMAT=DF_YMD -DNOMEMCPY -DIZ_HAVE_UXUIDGID -DNO_WORKING_ISPRINT" >"$SRC/make.log" 2>&1
install_bin "$SRC/unzip" unzip/bin/unzip
