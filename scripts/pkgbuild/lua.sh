#!/usr/bin/env bash
# Lua 5.4.7 (MIT) -> lua.wasm, luac.wasm
# Errors use setjmp/longjmp, so this needs wasm exception handling
# (all current browsers and Node >= 17).
. "$(dirname "$0")/common.sh"
VERSION=5.4.7
SRC=$(unpack "$(fetch https://www.lua.org/ftp/lua-$VERSION.tar.gz 9fbf5e28ef86c69858f6d3d34eccc32e911c1a28b4120ff3e84aaa70cfbf1e30)" lua-$VERSION)
setup_wasi_sdk
cd "$SRC/src"
# LUA_USE_POSIX-lite: no dlopen, no popen (no child processes), no readline.
# tmpnam/system are absent from wasi-libc; loslib falls back to errors.
# lua.c assumes stdin is a terminal unless told how to check (isatty).
make -j"$(nproc)" a lua.o luac.o \
  CC="$CC" AR="$AR rcu" RANLIB="$RANLIB" \
  MYCFLAGS="-O2 $SJLJ_CFLAGS $EMU_CFLAGS -include unistd.h -Dlua_stdin_is_tty\(\)=isatty\(0\) -DLUA_USE_C89 -Dl_system\(c\)=-1 -DLUA_TMPNAMBUFSIZE=32 -Dlua_tmpnam\(b,e\)=\{e=-1\;\}" \
  MYLIBS=""
$CC -O2 -c -o wasi-compat.o "$COMPAT_SRC"
$CC -O2 $SJLJ_CFLAGS -o lua.wasm lua.o wasi-compat.o liblua.a $SJLJ_LIBS $EMU_LIBS
$CC -O2 $SJLJ_CFLAGS -o luac.wasm luac.o wasi-compat.o liblua.a $SJLJ_LIBS $EMU_LIBS
install_wasm lua.wasm lua/bin/lua
install_wasm luac.wasm lua/bin/luac
