#!/bin/sh
# Builds the GL probes (x86-64, glibc ≤ 2.36) into $1 (default: this directory's out/).
set -e
cd "$(dirname "$0")"
out=${1:-out}
mkdir -p "$out"
gcc -O2 -Wall -U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=0 -fno-stack-protector -o "$out/glbench" glbench.c -lX11 -ldl
objdump -T "$out/glbench" | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1
