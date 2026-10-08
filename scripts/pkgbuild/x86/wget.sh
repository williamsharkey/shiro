#!/usr/bin/env bash
# GNU wget 1.25.0 (GPL-3.0-or-later) with OpenSSL and zlib -> static x86-64 wget
# Certificates: /etc/ssl/certs/ca-certificates.crt (pkg install ca-certificates)
. "$(dirname "$0")/common.sh"
VERSION=1.25.0
SRC=$(gnu_src wget $VERSION 766e48423e79359ea31e41db9e5c289675947a7fcf2efdcedb726ac9d0da3784 tar.gz)
setup_musl
deps_zlib
deps_openssl
export PKG_CONFIG_PATH="$SYSROOT/lib/pkgconfig:$SYSROOT/lib64/pkgconfig" PKG_CONFIG_LIBDIR="$SYSROOT/lib/pkgconfig"
configure_make "$SRC" --with-ssl=openssl --with-openssl=yes --without-libpsl --disable-pcre --disable-pcre2 --without-libidn \
  --without-libuuid --disable-iri --without-metalink --without-cares \
  CPPFLAGS="-I$SYSROOT/include" LDFLAGS="-L$SYSROOT/lib -static -no-pie" LIBS="-lssl -lcrypto -lz"
install_bin "$SRC/src/wget" wget/bin/wget
# wget's own CA default is OpenSSL's: /etc/ssl/cert.pem and /etc/ssl/certs, which ca-certificates provides
