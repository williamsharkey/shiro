#!/bin/bash
# Build a focused subset of LTP's syscall tests (tests/conformance/ltp/dirs.txt)
# as static x86-64 binaries into tests/conformance/.cache/ltp-bin, for
# tests/conformance/syscalls-ltp.conf.ts (they run under Blink in Shiro).
# LTP is GPL-2.0 and is fetched at a pinned commit, not vendored.
# Needs gcc with static glibc, autoconf/automake, make.
set -e
LTP_COMMIT=78e6353fdff663b2fc2f77704ceec6c3ca786b96
CONF="$(cd "$(dirname "$0")/../../tests/conformance" && pwd)"
SRC="$CONF/.cache/ltp"
BIN="$CONF/.cache/ltp-bin"
if [ ! -d "$SRC/.git" ] || [ "$(git -C "$SRC" rev-parse HEAD)" != "$LTP_COMMIT" ]; then
  rm -rf "$SRC"
  git init -q "$SRC"
  git -C "$SRC" remote add origin https://github.com/linux-test-project/ltp
  git -C "$SRC" fetch -q --depth 1 origin "$LTP_COMMIT"
  git -C "$SRC" checkout -q FETCH_HEAD
fi
cd "$SRC"
if [ ! -f include/config.h ]; then
  make autotools >/dev/null
  LDFLAGS=-static ./configure >/dev/null
fi
make -C lib -j"$(nproc)" >/dev/null 2>&1 || test -f lib/libltp.a
mkdir -p "$BIN"
for d in $(cat "$CONF/ltp/dirs.txt"); do
  dir="testcases/kernel/syscalls/$d"
  [ -d "$dir" ] || continue
  make -C "$dir" -k -j"$(nproc)" >/dev/null 2>&1 || true
  for f in "$dir"/*; do
    if [ -f "$f" ] && [ -x "$f" ] && head -c4 "$f" | grep -q ELF; then cp "$f" "$BIN/"; fi
  done
done
echo "LTP: $(ls "$BIN" | wc -l) test binaries in $BIN"
