#!/bin/sh
# Rebuild the kernel-wasi test programs (freestanding, no wasi-sysroot needed).
# Needs clang and wasm-ld with the WebAssembly target (LLVM 15+).
set -e
cd "$(dirname "$0")"
CFLAGS="--target=wasm32 -O2 -nostdlib -ffreestanding -fno-builtin"
for p in readloop seq upper cat spawn ping; do
  clang $CFLAGS -Wl,--export=_start -Wl,--no-entry -Wl,--strip-all -o $p.wasm $p.c
done
clang $CFLAGS -matomics -mbulk-memory -Wl,--export=_start -Wl,--no-entry -Wl,--strip-all \
  -Wl,--import-memory -Wl,--shared-memory -Wl,--max-memory=1048576 \
  -o threads.wasm threads.c thread-start.s
ls -l *.wasm
