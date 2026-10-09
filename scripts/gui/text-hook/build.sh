#!/bin/sh
# Builds public/gui/lib/libshiro-text-hook.so (x86-64, loaded by GTK apps in Blink).
# It may only need symbols Debian 12's glibc (2.36) has: checked below.
set -e
cd "$(dirname "$0")"
out=../../../public/gui/lib/libshiro-text-hook.so
mkdir -p "$(dirname "$out")"
gcc -shared -fPIC -O2 -Wall -Wextra -U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=0 -fno-stack-protector \
  -Wl,--hash-style=both -Wl,-z,norelro -o "$out" shiro-text-hook.c -ldl
strip "$out"
objdump -T "$out" | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1 | awk '{ split($1, v, /[_.]/); if (v[2] > 2 || v[3] > 36) { print "needs " $1 " (Debian 12 has 2.36)"; exit 1 } else print "max " $1 }'
ls -l "$out"
