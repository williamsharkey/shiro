#!/usr/bin/env bash
# OpenSSL 3.5 LTS (Apache-2.0) -> static x86-64 openssl CLI and /etc/ssl/openssl.cnf
. "$(dirname "$0")/common.sh"
setup_musl
deps_openssl
install_bin "$PKG_WORK/build/openssl-$OPENSSL_VERSION/apps/openssl" openssl/bin/openssl
mkdir -p "$PKG_OUT/openssl/etc/ssl"
cp "$PKG_WORK/build/openssl-$OPENSSL_VERSION/apps/openssl.cnf" "$PKG_OUT/openssl/etc/ssl/openssl.cnf"
