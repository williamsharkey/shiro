#!/usr/bin/env bash
# Shared helpers for the Shiro package build recipes (scripts/pkgbuild/<name>.sh).
#
# Every recipe builds one upstream release to wasm32-wasip1 with wasi-sdk,
# Dockerfile-free. Inputs are pinned by sha256; the output lands in
# $PKG_OUT/<name>/ and is what `scripts/pkgbuild/publish.sh` copies into
# public/pkg/ (served by shiro.computer and listed in src/pkg-index.json).
#
# Environment:
#   PKG_WORK   scratch dir for downloads and builds (default: ./.pkgbuild)
#   PKG_OUT    output dir (default: $PKG_WORK/out)
#   WASI_SDK   existing wasi-sdk install; downloaded and pinned if unset
set -euo pipefail

PKG_WORK=${PKG_WORK:-$PWD/.pkgbuild}
PKG_OUT=${PKG_OUT:-$PKG_WORK/out}
mkdir -p "$PKG_WORK/dl" "$PKG_OUT"

WASI_SDK_VERSION=25.0
WASI_SDK_SHA256=52640dde13599bf127a95499e61d6d640256119456d1af8897ab6725bcf3d89c

# fetch URL SHA256 -> prints the local path; fails when the hash differs
fetch() {
  local url=$1 sha=$2 file
  file="$PKG_WORK/dl/$(basename "$url")"
  if [ ! -f "$file" ] || ! echo "$sha  $file" | sha256sum -c --status; then
    curl -sSfL -o "$file.part" "$url"
    mv "$file.part" "$file"
  fi
  if ! echo "$sha  $file" | sha256sum -c --status; then
    echo "sha256 mismatch for $url" >&2
    echo "  expected $sha" >&2
    echo "  got      $(sha256sum "$file" | cut -d' ' -f1)" >&2
    exit 1
  fi
  echo "$file"
}

# unpack TARBALL into a fresh $PKG_WORK/build/<dir>; prints the source dir
unpack() {
  local tarball=$1 dir=$2
  rm -rf "$PKG_WORK/build/$dir"
  mkdir -p "$PKG_WORK/build"
  tar xzf "$tarball" -C "$PKG_WORK/build"
  echo "$PKG_WORK/build/$dir"
}

setup_wasi_sdk() {
  if [ -z "${WASI_SDK:-}" ]; then
    local tgz
    tgz=$(fetch "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK_VERSION%%.*}/wasi-sdk-${WASI_SDK_VERSION}-x86_64-linux.tar.gz" "$WASI_SDK_SHA256")
    WASI_SDK="$PKG_WORK/wasi-sdk-${WASI_SDK_VERSION}-x86_64-linux"
    [ -x "$WASI_SDK/bin/clang" ] || tar xzf "$tgz" -C "$PKG_WORK"
  fi
  export WASI_SDK
  export CC="$WASI_SDK/bin/clang --target=wasm32-wasip1 --sysroot=$WASI_SDK/share/wasi-sysroot"
  export CXX="$WASI_SDK/bin/clang++ --target=wasm32-wasip1 --sysroot=$WASI_SDK/share/wasi-sysroot"
  export AR="$WASI_SDK/bin/llvm-ar"
  export RANLIB="$WASI_SDK/bin/llvm-ranlib"
  export STRIP="$WASI_SDK/bin/llvm-strip"
  # setjmp/longjmp through wasm exception handling (Lua errors, sqlite shell)
  SJLJ_CFLAGS="-mllvm -wasm-enable-sjlj"
  SJLJ_LIBS="-lsetjmp"
  # POSIX bits WASI leaves out, provided as emulation libraries by wasi-libc
  EMU_CFLAGS="-D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_GETPID"
  EMU_LIBS="-lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-mman -lwasi-emulated-getpid"
}

# install_wasm SRC NAME -> $PKG_OUT/<pkg>/bin/NAME.wasm (stripped), prints sha256
install_wasm() {
  local src=$1 dst="$PKG_OUT/$2.wasm"
  mkdir -p "$(dirname "$dst")"
  "$STRIP" -o "$dst" "$src"
  sha256sum "$dst"
}

COMPAT_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/compat/wasi-compat.c"
