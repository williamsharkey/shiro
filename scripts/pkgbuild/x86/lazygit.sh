#!/usr/bin/env bash
# lazygit 0.55.1 (MIT): upstream's static linux x86_64 release (Go)
. "$(dirname "$0")/common.sh"
VERSION=0.55.1
TGZ=$(fetch https://github.com/jesseduffield/lazygit/releases/download/v$VERSION/lazygit_${VERSION}_linux_x86_64.tar.gz 6385a699dde302b7fdcd1cc8910ae225ed0c19a230285569c586051576f0d6a3)
SRC="$PKG_WORK/build/lazygit-$VERSION"
rm -rf "$SRC" && mkdir -p "$SRC" && tar xzf "$TGZ" -C "$SRC"
rm -rf "$PKG_OUT/lazygit"
install_prebuilt "$SRC/lazygit" lazygit/bin/lazygit
