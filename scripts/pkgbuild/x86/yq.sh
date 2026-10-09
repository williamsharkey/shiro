#!/usr/bin/env bash
# yq 4.52.1 (mikefarah, MIT): upstream's static linux_amd64 release (Go)
. "$(dirname "$0")/common.sh"
VERSION=4.52.1
TGZ=$(fetch https://github.com/mikefarah/yq/releases/download/v$VERSION/yq_linux_amd64.tar.gz a20741acaf5b8e014690ee02185dc8b15ecc9f25dd7a39ece9da0dcf75ad8c3c yq-$VERSION-linux_amd64.tar.gz)
rm -rf "$PKG_WORK/build/yq-$VERSION" "$PKG_OUT/yq"
mkdir -p "$PKG_WORK/build/yq-$VERSION"
tar xzf "$TGZ" -C "$PKG_WORK/build/yq-$VERSION"
install_prebuilt "$PKG_WORK/build/yq-$VERSION/yq_linux_amd64" yq/bin/yq
