#!/usr/bin/env bash
# bat 0.26.1 (MIT/Apache-2.0): upstream's static x86_64-unknown-linux-musl release
. "$(dirname "$0")/common.sh"
VERSION=0.26.1
SRC=$(unpack "$(fetch https://github.com/sharkdp/bat/releases/download/v$VERSION/bat-v$VERSION-x86_64-unknown-linux-musl.tar.gz 0dcd8ac79732c0d5b136f11f4ee00e581440e16a44eab5b3105b611bbf2cf191)" bat-v$VERSION-x86_64-unknown-linux-musl)
rm -rf "$PKG_OUT/bat"
install_prebuilt "$SRC/bat" bat/bin/bat
