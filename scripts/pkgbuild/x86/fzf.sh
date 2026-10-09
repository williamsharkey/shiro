#!/usr/bin/env bash
# fzf 0.74.0 (MIT): upstream's static linux_amd64 release (Go)
. "$(dirname "$0")/common.sh"
VERSION=0.74.0
TGZ=$(fetch https://github.com/junegunn/fzf/releases/download/v$VERSION/fzf-$VERSION-linux_amd64.tar.gz cf919f05b7581b4c744d764eaa704665d61dd6d3ca785f0df2351281dff60cda)
rm -rf "$PKG_WORK/build/fzf-$VERSION" "$PKG_OUT/fzf"
mkdir -p "$PKG_WORK/build/fzf-$VERSION"
tar xzf "$TGZ" -C "$PKG_WORK/build/fzf-$VERSION"
install_prebuilt "$PKG_WORK/build/fzf-$VERSION/fzf" fzf/bin/fzf
