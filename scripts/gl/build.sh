#!/bin/sh
# Builds public/gui/lib/libGLX_tabcomputer.so.0 (x86-64, the glvnd GLX vendor
# library GL apps load in Blink; docs/research/GL.md). It may only need
# symbols Debian 12's glibc (2.36) has: checked below.
# gen/ comes from `node scripts/gl/gen.mjs` (committed).
set -e
cd "$(dirname "$0")"
out=${1:-../../public/gui/lib/libGLX_tabcomputer.so.0}
mkdir -p "$(dirname "$out")"
gcc -shared -fPIC -O2 -Wall -Wextra -Wno-unused-parameter -Wno-misleading-indentation -U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=0 -fno-stack-protector \
  -fvisibility=hidden -Wl,--hash-style=both -Wl,-z,norelro -Wl,-soname,libGLX_tabcomputer.so.0 \
  -o "$out" libGLX_tabcomputer.c gen/tc_gen.c -lX11 -lpthread
strip "$out"
objdump -T "$out" | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1 | awk '{ split($1, v, /[_.]/); if (v[2] > 2 || v[3] > 36) { print "needs " $1 " (Debian 12 has 2.36)"; exit 1 } else print "max " $1 }'
ls -l "$out"
