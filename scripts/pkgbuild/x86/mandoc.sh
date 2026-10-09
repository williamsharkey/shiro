#!/usr/bin/env bash
# mandoc 1.14.6 (ISC) -> static x86-64 man, mandoc, apropos/whatis, makewhatis,
# with its own manual pages
. "$(dirname "$0")/common.sh"
VERSION=1.14.6
SRC=$(unpack "$(fetch https://mandoc.bsd.lv/snapshots/mandoc-$VERSION.tar.gz 8bf0d570f01e70a6e124884088870cbed7537f36328d512909eb10cd53179d9c)" mandoc-$VERSION)
setup_musl
deps_zlib
cat >"$SRC/configure.local" <<CFG
PREFIX=/usr
MANDIR=/usr/share/man
CC="$CC"
CFLAGS="$CFLAGS -I$SYSROOT/include"
LDFLAGS="-L$SYSROOT/lib -static -no-pie"
LDADD="-lz"
HAVE_REWB_BSD=0
HAVE_WCHAR=1
MANPATH_DEFAULT=/usr/share/man:/usr/local/share/man
MANPATH_BASE=/usr/share/man
BINM_MAN=man
BINM_APROPOS=apropos
BINM_WHATIS=whatis
BINM_MAKEWHATIS=makewhatis
BINM_PAGER=less
UTF8_LOCALE=C.UTF-8
READ_ALLOWED_PATH=/usr/lib/pkg
CFG
# Packages ship no mandoc.db: finding a page by searching the directories is
# normal here, not a sign of an outdated database (apropos needs makewhatis)
sed -i 's/^\twarnx("outdated mandoc.db lacks/\tif (0) warnx("outdated mandoc.db lacks/' "$SRC/main.c"
(cd "$SRC" && ./configure >configure.log 2>&1 && make -j"$(nproc)" >make.log 2>&1) || { tail -20 "$SRC/configure.log" "$SRC/make.log" >&2; exit 1; }
rm -rf "$PKG_OUT/mandoc"
install_bin "$SRC/mandoc" mandoc/bin/mandoc
mkdir -p "$PKG_OUT/mandoc/share/man/man1" "$PKG_OUT/mandoc/share/man/man5" "$PKG_OUT/mandoc/share/man/man7" "$PKG_OUT/mandoc/share/man/man8"
for f in man.1 mandoc.1 apropos.1 man.conf.5 mandoc.db.5 mdoc.7 man.7 roff.7 eqn.7 tbl.7 mandoc_char.7 makewhatis.8; do
  sec=${f##*.}
  cp "$SRC/$f" "$PKG_OUT/mandoc/share/man/man$sec/$f"
done
