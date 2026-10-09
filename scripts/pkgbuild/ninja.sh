#!/usr/bin/env bash
# Ninja 1.12.1 (Apache-2.0) -> ninja-1.12.1-x86_64.tar.gz (bin/ninja), run by Blink
#
# A static x86-64 Linux ninja built with the host's g++ by ninja's own
# bootstrap. In Blink it starts build commands with posix_spawn and reads
# their output through pipes with ppoll, as on Linux; commands that name
# Shiro programs (clang from the llvm package, the shell) run as kernel
# processes. Needs g++ and python3 on an x86-64 host.
. "$(dirname "$0")/common.sh"
VER=1.12.1
SRC=$(fetch_git https://github.com/ninja-build/ninja v$VER 2daa09ba270b0a43e1929d29b073348aa985dfaa ninja-$VER)
cd "$SRC"
CXX=g++ CFLAGS=-O2 LDFLAGS=-static python3 configure.py --bootstrap >/dev/null
R="$PKG_WORK/build/ninja-root"
rm -rf "$R" && mkdir -p "$R/bin"
strip -o "$R/bin/ninja" ninja
mkdir -p "$PKG_OUT/ninja"
( cd "$R" && tar --sort=name --owner=0 --group=0 --mtime=2025-01-01 -czf "$PKG_OUT/ninja/ninja-$VER-x86_64.tar.gz" . )
sha256sum "$PKG_OUT/ninja/ninja-$VER-x86_64.tar.gz"
