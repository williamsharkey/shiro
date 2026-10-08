#!/usr/bin/env bash
# LLVM 21 (clang, clang++, wasm-ld, llvm-ar, ...) for WASI -> the llvm package
#
# The compiler itself is YoWASP's build of LLVM for wasm32-wasip1
# (@yowasp/clang on npm, ISC packaging of Apache-2.0 WITH LLVM-exception):
# gen/llvm.core.wasm is a plain preview1 multi-call binary and
# gen/llvm-resources.tar the wasi-libc sysroot and clang's headers. The
# index takes both straight out of the npm tarball (pinned by sha256), so
# only the driver is built here: compat/clang-driver.c runs `clang -###`
# and then each step as a kernel process, because WASI LLVM can't spawn.
. "$(dirname "$0")/common.sh"
TGZ=$(fetch https://registry.npmjs.org/@yowasp/clang/-/clang-21.1.4-3.tgz 9c082ea5cac9489966adbe381529bf13bde18646126e98b8b089d83f57fe5e27)
setup_wasi_sdk
setup_proc
D="$PKG_WORK/build/llvm"
rm -rf "$D"; mkdir -p "$D"
$CC -O2 $EMU_CFLAGS $PROC_CFLAGS -o "$D/clang.wasm" "$COMPAT_DIR/clang-driver.c" $PROC_LIBS $EMU_LIBS
install_wasm "$D/clang.wasm" llvm/bin/clang
# For reference (the index points at the tarball itself):
tar tzf "$TGZ" | grep -E 'llvm\.core\.wasm|llvm-resources\.tar'
