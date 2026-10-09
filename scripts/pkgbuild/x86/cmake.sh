#!/usr/bin/env bash
# CMake 3.31.9 (BSD-3-Clause) -> $PKG_OUT/cmake/cmake-3.31.9-x86_64.tar.gz, run by Blink
#
# Static x86-64 musl cmake and ctest (bundled libuv/curl/zlib..., no OpenSSL,
# no curses or Qt UI), installed under /usr/lib/pkg/cmake, where cmake finds
# its modules (share/cmake-3.31) next to the binary. In Shiro it generates
# Makefiles or build.ninja for the llvm package's clang (wasm32-wasip1) and
# runs the compiler checks through it. musl, not glibc: Blink faults in a
# static glibc cmake's malloc start-up. Needs a host cmake and ninja.
. "$(dirname "$0")/common.sh"
setup_musl
VER=3.31.9
PREFIX=/usr/lib/pkg/cmake
SRC=$(unpack "$(fetch https://cmake.org/files/v3.31/cmake-$VER.tar.gz 5d4fdec04247ca8a8e8f63692f0d0f1e9d6d082a2bdd008dff8ab3ba7215aa83)" cmake-$VER)
B="$PKG_WORK/build/cmake-build"
rm -rf "$B"
cmake -S "$SRC" -B "$B" -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=$PREFIX \
  -DCMAKE_C_COMPILER="$CC" -DCMAKE_CXX_COMPILER="$CXX" -DCMAKE_EXE_LINKER_FLAGS="-static -no-pie" \
  -DCMAKE_C_FLAGS="-O2 -fno-pie" -DCMAKE_CXX_FLAGS="-O2 -fno-pie" \
  -DBUILD_TESTING=OFF -DCMAKE_USE_OPENSSL=OFF -DBUILD_CursesDialog=OFF -DBUILD_QtDialog=OFF >/dev/null
cmake --build "$B" >/dev/null
R="$PKG_WORK/build/cmake-root"
rm -rf "$R"
DESTDIR="$R" cmake --install "$B" >/dev/null
S="$R$PREFIX"
"$STRIP" "$S/bin/cmake" "$S/bin/ctest"
# cmake + ctest; docs, cpack and editor/shell integrations stay out
rm -rf "$S/doc" "$S/share/doc" "$S/share/man" "$S/share/aclocal" "$S/share/bash-completion" \
  "$S/share/emacs" "$S/share/vim" "$S/bin/cpack"
mkdir -p "$PKG_OUT/cmake"
( cd "$S" && tar --sort=name --owner=0 --group=0 --mtime=2025-01-01 -czf "$PKG_OUT/cmake/cmake-$VER-x86_64.tar.gz" . )
sha256sum "$PKG_OUT/cmake/cmake-$VER-x86_64.tar.gz"
