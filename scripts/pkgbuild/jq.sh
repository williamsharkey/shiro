#!/usr/bin/env bash
# jq 1.8.1 (MIT; bundled oniguruma is BSD-2-Clause) -> jq.wasm
. "$(dirname "$0")/common.sh"
VERSION=1.8.1
SRC=$(unpack "$(fetch https://github.com/jqlang/jq/releases/download/jq-$VERSION/jq-$VERSION.tar.gz 2be64e7129cecb11d5906290eba10af694fb9e3e7f9fc208a311dc33ca837eb0)" jq-$VERSION)
setup_wasi_sdk
cd "$SRC"
$CC -O2 -c -o wasi-compat.o "$COMPAT_SRC" && $AR rcs libwasicompat.a wasi-compat.o
./configure --host=wasm32-wasip1 --build="$(./config/config.guess)" \
  --with-oniguruma=builtin --disable-docs --disable-valgrind --disable-maintainer-mode \
  --enable-all-static --disable-shared \
  CC="$CC" AR="$AR" RANLIB="$RANLIB" \
  CFLAGS="-O2 $SJLJ_CFLAGS $EMU_CFLAGS" LDFLAGS="$SJLJ_CFLAGS" \
  LIBS="-L$PWD -lwasicompat $SJLJ_LIBS $EMU_LIBS" >configure.log
make -j"$(nproc)" >make.log
install_wasm jq jq/bin/jq
