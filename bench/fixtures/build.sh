#!/bin/sh
# Rebuild bench fixtures that are committed (kbench.wasm, kbench-native).
# Needs clang + wasm-ld with the WebAssembly target. Go/C x86 fixtures are
# built at bench time into bench/.cache (see bench/lib/fixtures.mjs).
set -e
cd "$(dirname "$0")"
clang --target=wasm32 -O2 -nostdlib -ffreestanding -fno-builtin \
  -Wl,--export=_start -Wl,--no-entry -Wl,--strip-all -o kbench.wasm kbench.c
ls -l kbench.wasm
