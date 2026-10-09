#!/usr/bin/env bash
# CPython 3.13.7 (PSF) -> python3.wasm + lib/python313.zip (the stdlib, as .pyc)
#
# Upstream's own WASI port (Tools/wasm, tier 2 in 3.13), configured with
# --prefix=/usr/lib/pkg/python3 so the interpreter finds its stdlib where
# `pkg install python3` puts it, plus zlib (zipimport, wheels) and sqlite3.
# Linked with the compat shims (compat/wasi-proc.c, compat/wasi-sock.c), so
# os.posix_spawn/waitpid/pipe/dup/kill, sockets and getaddrinfo work over
# the kernel's WASIX calls, and with OpenSSL 3.5 for _ssl/hashlib
# (OPENSSLDIR=/etc/ssl: the ca-certificates package's cert.pem). subprocess
# runs on os.posix_spawn (compat/python3-wasi-subprocess.patch).
# Needs a native toolchain for the build python.
. "$(dirname "$0")/common.sh"
PYVER=3.13.7
PYSHORT=3.13
PREFIX=/usr/lib/pkg/python3
PYSRC=$(fetch https://www.python.org/ftp/python/$PYVER/Python-$PYVER.tar.xz 5462f9099dfd30e238def83c71d91897d8caa5ff6ebc7a50f14d4802cdaaa79a)
ZLIB=$(fetch https://zlib.net/fossils/zlib-1.3.1.tar.gz 9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23)
SQLITE=$(fetch https://sqlite.org/2025/sqlite-autoconf-3500400.tar.gz a3db587a1b92ee5ddac2f66b3edb41b26f9c867275782d46c3a088977d6a5b18)
OPENSSL=$(fetch https://github.com/openssl/openssl/releases/download/openssl-3.5.4/openssl-3.5.4.tar.gz 967311f84955316969bdb1d8d4b983718ef42338639c621ec4c34fddef355e99)
setup_wasi_sdk
setup_proc
setup_sock
B="$PKG_WORK/build/python"
rm -rf "$B"; mkdir -p "$B/deps/include" "$B/deps/lib"
tar xJf "$PYSRC" -C "$B"
tar xzf "$ZLIB" -C "$B"
tar xzf "$SQLITE" -C "$B"
tar xzf "$OPENSSL" -C "$B"
SRC="$B/Python-$PYVER"
JOBS=$(nproc)
patch -d "$SRC" -p1 < "$COMPAT_DIR/python3-wasi-subprocess.patch"

# zlib and sqlite as static wasm libraries
( cd "$B/zlib-1.3.1" && CFLAGS=-O2 CHOST=wasm32 ./configure --static --prefix="$B/deps" >/dev/null && make -j"$JOBS" libz.a >/dev/null && make install >/dev/null )
( cd "$B/sqlite-autoconf-3500400" && $CC -O2 -c -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_OMIT_WAL \
    -DSQLITE_MAX_MMAP_SIZE=0 -DSQLITE_DEFAULT_LOCKING_MODE=1 -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_MATH_FUNCTIONS \
    -D_WASI_EMULATED_GETPID sqlite3.c -o sqlite3.o && $AR rcs "$B/deps/lib/libsqlite3.a" sqlite3.o && cp sqlite3.h "$B/deps/include/" )

# OpenSSL (libssl/libcrypto) without threads, assembly or AF_UNIX; its
# socket BIO uses compat/wasi-sock.c
( cd "$B/openssl-3.5.4" && ./Configure linux-generic32 no-asm no-threads no-shared no-dso no-afalgeng \
    no-secure-memory no-ui-console no-tests no-apps no-docs no-engine no-async no-module no-legacy no-dgram no-ktls \
    --prefix="$B/deps" --libdir=lib --openssldir=/etc/ssl -O2 $EMU_CFLAGS $SOCK_CFLAGS \
    -DNO_SYSLOG -DOPENSSL_NO_SECURE_MEMORY -DOPENSSL_NO_UNIX_SOCK >/dev/null && \
  make -j"$JOBS" build_libs >/dev/null && make install_dev >/dev/null )

# 1. the build python (native, same version)
mkdir -p "$SRC/cross-build/build"
( cd "$SRC/cross-build/build" && CC=cc CXX=c++ AR=ar RANLIB=ranlib STRIP=strip ../../configure -q && make -j"$JOBS" all >/dev/null )
BUILD_PYTHON="$SRC/cross-build/build/python"

# 2. the WASI python. CONFIG_SITE disables what WASI lacks, minus what the
#    compat shims provide; HOSTRUNNER is only used by `make test`, so it
#    needn't exist. OPENSSL_THREADS: CPython insists on a thread-safe
#    OpenSSL; on WASI it runs one thread, so the no-threads build is safe.
mkdir -p "$SRC/cross-build/wasm32-wasip1"
cd "$SRC/cross-build/wasm32-wasip1"
{ cat ../../Tools/wasm/config.site-wasm32-wasi
  echo 'ac_cv_func_pipe=yes'
  echo 'ac_cv_func_dup=yes'
  echo 'ac_cv_func_dup3=yes'
  echo 'ac_cv_func_wait3=no'  # wasi-libc's struct rusage has only the times
  echo 'ac_cv_func_wait4=no'
} > config.site-tabcomputer
CONFIG_SITE=./config.site-tabcomputer HOSTRUNNER=true \
CPPFLAGS="$PROC_CFLAGS -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_GETPID -D_WASI_EMULATED_PROCESS_CLOCKS -DOPENSSL_THREADS" LIBS="$SOCK_LIBS $PROC_LIBS" \
CC="$WASI_SDK/bin/clang --sysroot=$WASI_SDK/share/wasi-sysroot" \
CPP="$WASI_SDK/bin/clang-cpp --sysroot=$WASI_SDK/share/wasi-sysroot" \
CXX="$WASI_SDK/bin/clang++ --sysroot=$WASI_SDK/share/wasi-sysroot" \
PKG_CONFIG_PATH= PKG_CONFIG_LIBDIR="$WASI_SDK/share/wasi-sysroot/lib/pkgconfig" \
ZLIB_CFLAGS="-I$B/deps/include" ZLIB_LIBS="-L$B/deps/lib -lz" \
LIBSQLITE3_CFLAGS="-I$B/deps/include" LIBSQLITE3_LIBS="-L$B/deps/lib -lsqlite3" \
  ../../configure -q --host=wasm32-wasip1 --build="$(../../config.guess)" \
    --with-build-python="$BUILD_PYTHON" --prefix=$PREFIX --disable-test-modules \
    --with-openssl="$B/deps" --with-openssl-rpath=no
make -j"$JOBS" all >/dev/null
rm -rf "$B/root"
make install DESTDIR="$B/root" >/dev/null

# 3. package: the binary, and the stdlib zipped as optimized .pyc (no tests,
#    idle, tkinter, ensurepip; Shiro's `pip` installs wheels itself)
OUT="$PKG_OUT/python3"
rm -rf "$OUT"; mkdir -p "$OUT/bin" "$OUT/lib/python$PYSHORT/lib-dynload" "$OUT/lib/python$PYSHORT/site-packages"
install_wasm python.wasm python3/bin/python3
LIB="$B/root$PREFIX/lib/python$PYSHORT"
"$BUILD_PYTHON" - "$LIB" "$OUT/lib/python${PYSHORT/./}.zip" <<'EOF'
import sys, os, zipfile, py_compile, importlib.util, tempfile
lib, out = sys.argv[1], sys.argv[2]
skip = {'test', 'idlelib', 'tkinter', 'turtledemo', 'ensurepip', 'site-packages', 'lib-dynload',
        'config-3.13-wasm32-wasi', '__pycache__', 'lib2to3', 'pydoc_data'}
tmp = tempfile.mkdtemp()
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for root, dirs, files in os.walk(lib):
        dirs[:] = sorted(d for d in dirs if d not in skip and not d.startswith('test'))
        for f in sorted(files):
            p = os.path.join(root, f)
            rel = os.path.relpath(p, lib)
            info = lambda name: zipfile.ZipInfo(name, date_time=(2025, 1, 1, 0, 0, 0))
            if f.endswith('.py'):
                c = os.path.join(tmp, 'x.pyc')
                py_compile.compile(p, c, dfile=rel, doraise=True,
                                   invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH)
                zi = info(rel + 'c'); zi.compress_type = zipfile.ZIP_DEFLATED
                z.writestr(zi, open(c, 'rb').read())
            elif not f.endswith(('.pyc', '.exe', '.a')):
                zi = info(rel); zi.compress_type = zipfile.ZIP_DEFLATED
                z.writestr(zi, open(p, 'rb').read())
EOF
# getpath's landmarks: lib/python3.13/os.py for the prefix (os itself is a
# frozen module), lib-dynload for exec_prefix; and site-packages
cp "$LIB/os.py" "$OUT/lib/python$PYSHORT/os.py"
touch "$OUT/lib/python$PYSHORT/lib-dynload/.keep" "$OUT/lib/python$PYSHORT/site-packages/README.txt"
ls -la "$OUT/bin" "$OUT/lib"
