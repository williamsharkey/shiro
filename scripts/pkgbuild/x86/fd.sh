#!/usr/bin/env bash
# fd 10.3.0 (MIT/Apache-2.0): upstream's static x86_64-unknown-linux-musl release
. "$(dirname "$0")/common.sh"
VERSION=10.3.0
SRC=$(unpack "$(fetch https://github.com/sharkdp/fd/releases/download/v$VERSION/fd-v$VERSION-x86_64-unknown-linux-musl.tar.gz 2b6bfaae8c48f12050813c2ffe1884c61ea26e750d803df9c9114550a314cd14)" fd-v$VERSION-x86_64-unknown-linux-musl)
rm -rf "$PKG_OUT/fd"
install_prebuilt "$SRC/fd" fd/bin/fd
