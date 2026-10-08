#!/usr/bin/env bash
# SQLite 3.50.4 (public domain) -> sqlite3.wasm (the CLI shell)
. "$(dirname "$0")/common.sh"
VERSION=3500400
SRC=$(unpack "$(fetch https://sqlite.org/2025/sqlite-autoconf-$VERSION.tar.gz a3db587a1b92ee5ddac2f66b3edb41b26f9c867275782d46c3a088977d6a5b18)" sqlite-autoconf-$VERSION)
setup_wasi_sdk
cd "$SRC"
# Single-threaded, no extensions/WAL/mmap (no shared memory or dlopen in WASI);
# file locking is a no-op ("unix-none" VFS is the default under __wasi__).
DEFS="-DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_OMIT_WAL -DSQLITE_MAX_MMAP_SIZE=0
  -DSQLITE_OMIT_POPEN -DSQLITE_DEFAULT_LOCKING_MODE=1 -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_MATH_FUNCTIONS
  -DSQLITE_ENABLE_DBSTAT_VTAB -DHAVE_READLINE=0 -DSQLITE_NOHAVE_SYSTEM"
$CC -O2 $SJLJ_CFLAGS $EMU_CFLAGS $DEFS -o sqlite3.wasm shell.c sqlite3.c "$COMPAT_SRC" $SJLJ_LIBS $EMU_LIBS
install_wasm sqlite3.wasm sqlite/bin/sqlite3
