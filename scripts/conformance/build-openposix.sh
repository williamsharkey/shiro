#!/bin/bash
# Build the Open POSIX Test Suite's conformance tests (open_posix_testsuite in
# the pinned LTP checkout, fetched by build-ltp.sh) as static x86-64 binaries
# into tests/conformance/.cache/openposix-bin, for
# tests/conformance/posix-openposix.conf.ts (they run under Blink in Shiro).
# A test is conformance/interfaces/AREA/N-M.c; its binary is AREA_N-M. Tests
# that don't build here (missing APIs) are left out, as the suite's own
# Makefile does. The suite is GPL-2.0, fetched, not vendored.
set -e
CONF="$(cd "$(dirname "$0")/../../tests/conformance" && pwd)"
SRC="$CONF/.cache/ltp/testcases/open_posix_testsuite"
BIN="$CONF/.cache/openposix-bin"
[ -d "$SRC" ] || bash "$(dirname "$0")/build-ltp.sh"
mkdir -p "$BIN"
build() {
  local c="$1" area name
  area=$(basename "$(dirname "$c")")
  name="${area}_$(basename "$c" .c)"
  [ -x "$BIN/$name" ] && [ "$BIN/$name" -nt "$c" ] && return 0
  gcc -static -O1 -w -D_GNU_SOURCE -D_POSIX_C_SOURCE=200809L -D_XOPEN_SOURCE=700 -I "$SRC/include" \
    -o "$BIN/$name" "$c" "$SRC/lib/common.c" -pthread -lrt -lm 2>/dev/null || rm -f "$BIN/$name"
}
export -f build
export SRC BIN
find "$SRC/conformance/interfaces" -name '[0-9]*-[0-9]*.c' | xargs -P "$(nproc)" -I{} bash -c 'build {}'
echo "Open POSIX: $(ls "$BIN" | wc -l) test binaries in $BIN"
