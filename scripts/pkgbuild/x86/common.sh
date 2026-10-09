#!/usr/bin/env bash
# Shared helpers for x86-64 Linux package recipes (scripts/pkgbuild/x86/<name>.sh).
#
# These packages are static x86-64 musl ELF binaries that Shiro runs in Blink
# (docs/X86_ENGINES.md) as kernel processes. Every recipe builds one pinned
# upstream release with the musl.cc cross toolchain (also pinned), no Docker.
# Output lands in $PKG_OUT/<name>/ (bin/, share/, ...), which
# scripts/pkgbuild/publish.sh copies into public/pkg/ (gzip-compressed for
# the x86 ABI) and prints index entries for.
#
# Environment:
#   PKG_WORK   scratch dir for downloads and builds (default: ./.pkgbuild)
#   PKG_OUT    output dir (default: $PKG_WORK/out)
#   MUSL_CROSS existing x86_64-linux-musl-cross install; downloaded if unset
set -euo pipefail

PKG_WORK=${PKG_WORK:-$PWD/.pkgbuild}
PKG_OUT=${PKG_OUT:-$PKG_WORK/out}
mkdir -p "$PKG_WORK/dl" "$PKG_OUT"
# Reproducible builds: __DATE__/__TIME__ and friends come from here
export SOURCE_DATE_EPOCH=1704067200
PKGBUILD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# musl.cc's x86_64 cross toolchain: gcc 11.2.1, musl 1.2.2
MUSL_CROSS_URL=https://musl.cc/x86_64-linux-musl-cross.tgz
MUSL_CROSS_SHA256=c5d410d9f82a4f24c549fe5d24f988f85b2679b452413a9f7e5f7b956f2fe7ea

# fetch URL SHA256 [NAME] -> prints the local path; fails when the hash differs
fetch() {
  local url=$1 sha=$2 file
  file="$PKG_WORK/dl/${3:-$(basename "${url%%\?*}")}"
  if [ ! -f "$file" ] || ! echo "$sha  $file" | sha256sum -c --status; then
    curl -sSfL --retry 3 -o "$file.part" "$url"
    mv "$file.part" "$file"
  fi
  if ! echo "$sha  $file" | sha256sum -c --status; then
    echo "sha256 mismatch for $url" >&2
    echo "  expected $sha" >&2
    echo "  got      $(sha256sum "$file" | cut -d' ' -f1)" >&2
    exit 1
  fi
  echo "$file"
}

# fetch_git URL TAG COMMIT DIR -> shallow clone of TAG into $PKG_WORK/build/DIR,
# checked against the pinned COMMIT; prints the source dir.
# (For projects whose release tarballs are only on codeload.github.com.)
fetch_git() {
  local url=$1 tag=$2 commit=$3 dir="$PKG_WORK/build/$4"
  rm -rf "$dir"
  mkdir -p "$PKG_WORK/build"
  git -c advice.detachedHead=false clone -q --depth 1 --branch "$tag" "$url" "$dir"
  local got
  got=$(git -C "$dir" rev-parse HEAD)
  if [ "$got" != "$commit" ]; then
    echo "commit mismatch for $url $tag: expected $commit, got $got" >&2
    exit 1
  fi
  echo "$dir"
}

# unpack TARBALL DIR -> fresh $PKG_WORK/build/DIR; prints the source dir
unpack() {
  local tarball=$1 dir=$2
  rm -rf "$PKG_WORK/build/$dir"
  mkdir -p "$PKG_WORK/build"
  tar xf "$tarball" -C "$PKG_WORK/build"
  echo "$PKG_WORK/build/$dir"
}

setup_musl() {
  if [ -z "${MUSL_CROSS:-}" ]; then
    local tgz
    tgz=$(fetch "$MUSL_CROSS_URL" "$MUSL_CROSS_SHA256")
    MUSL_CROSS="$PKG_WORK/x86_64-linux-musl-cross"
    [ -x "$MUSL_CROSS/bin/x86_64-linux-musl-gcc" ] || tar xzf "$tgz" -C "$PKG_WORK"
  fi
  export MUSL_CROSS
  export PATH="$MUSL_CROSS/bin:$PATH"
  HOST=x86_64-linux-musl
  # -static in CC too: libtool drops it from LDFLAGS
  export CC="$HOST-gcc -static" CXX="$HOST-g++ -static" AR="$HOST-ar" RANLIB="$HOST-ranlib" STRIP="$HOST-strip"
  export CFLAGS="-Os -fno-pie -no-pie" LDFLAGS="-static -s -no-pie"
  # Static dependencies (ncurses, zlib, ...) are installed here by deps_* below
  SYSROOT="$PKG_WORK/sysroot-x86_64"
  mkdir -p "$SYSROOT"
  export CPPFLAGS="-I$SYSROOT/include -I$SYSROOT/include/ncursesw"
  export LDFLAGS="$LDFLAGS -L$SYSROOT/lib"
  export PKG_CONFIG_PATH="$SYSROOT/lib/pkgconfig"
  export PKG_CONFIG_LIBDIR="$SYSROOT/lib/pkgconfig"
}

# Terminals compiled into ncurses, so curses programs work without a terminfo
# database (Shiro also ships one: pkg install terminfo).
NCURSES_FALLBACKS=xterm-256color,xterm,xterm-color,vt100,vt220,linux,screen,screen-256color,tmux,tmux-256color,dumb

# deps_ncurses: static libncursesw (+ tinfo, panel, menu, form) into $SYSROOT
deps_ncurses() {
  [ -f "$SYSROOT/lib/libncursesw.a" ] && return 0
  local src
  src=$(unpack "$(fetch https://ftp.gnu.org/gnu/ncurses/ncurses-6.5.tar.gz 136d91bc269a9a5785e5f9e980bc76ab57428f604ce3e5a5a90cebc767971cc6)" ncurses-6.5)
  (cd "$src" && ./configure --host=$HOST --prefix="$SYSROOT" \
      --with-default-terminfo-dir=/usr/share/terminfo \
      --with-terminfo-dirs=/usr/share/terminfo:/lib/terminfo:/etc/terminfo \
      --with-fallbacks=$NCURSES_FALLBACKS --with-tic-path=/usr/bin/tic --with-infocmp-path=/usr/bin/infocmp \
      --enable-widec --with-normal --without-shared --without-debug --without-ada --without-cxx-binding \
      --without-manpages --without-tests --without-progs --disable-db-install --enable-pc-files --with-pkg-config-libdir="$SYSROOT/lib/pkgconfig" \
      --disable-stripping --enable-overwrite --with-termlib=no >configure.log &&
    make -j"$(nproc)" >make.log && make install >install.log)
  # Programs that ask for -lncurses / -ltinfo / -lcurses get the wide library
  for l in ncurses tinfo curses; do ln -sf libncursesw.a "$SYSROOT/lib/lib$l.a"; done
  ln -sf ncursesw.pc "$SYSROOT/lib/pkgconfig/ncurses.pc"
}

# deps_zlib: static zlib into $SYSROOT
deps_zlib() {
  [ -f "$SYSROOT/lib/libz.a" ] && return 0
  local src
  src=$(unpack "$(fetch https://zlib.net/fossils/zlib-1.3.1.tar.gz 9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23)" zlib-1.3.1)
  (cd "$src" && CFLAGS="-Os -fPIC" ./configure --static --prefix="$SYSROOT" >configure.log && make -j"$(nproc)" >make.log && make install >install.log)
}

# deps_libevent: static libevent 2.1 (core, no OpenSSL) into $SYSROOT
deps_libevent() {
  [ -f "$SYSROOT/lib/libevent_core.a" ] && return 0
  local src
  src=$(unpack "$(fetch https://github.com/libevent/libevent/releases/download/release-2.1.12-stable/libevent-2.1.12-stable.tar.gz 92e6de1be9ec176428fd2367677e61ceffc2ee1cb119035037a27d346b0403bb)" libevent-2.1.12-stable)
  (cd "$src" && ./configure --host=$HOST --prefix="$SYSROOT" --disable-shared --enable-static \
      --disable-openssl --disable-samples --disable-libevent-regress --disable-debug-mode >configure.log 2>&1 &&
    make -j"$(nproc)" >make.log 2>&1 && make install >install.log 2>&1)
}

# install_bin SRC DEST -> $PKG_OUT/DEST (stripped static ELF), prints sha256
install_bin() {
  local src=$1 dst="$PKG_OUT/$2"
  mkdir -p "$(dirname "$dst")"
  "$STRIP" -o "$dst" "$src"
  chmod 755 "$dst"
  if file "$dst" 2>/dev/null | grep -q dynamic; then echo "$dst is not static" >&2; exit 1; fi
  sha256sum "$dst"
}

# gnu_src NAME VERSION SHA256 [EXT]: unpack ftp.gnu.org's NAME-VERSION tarball; prints the source dir
gnu_src() {
  local ext=${4:-tar.xz}
  unpack "$(fetch "https://ftp.gnu.org/gnu/$1/$1-$2.$ext" "$3")" "$1-$2"
}

# configure_make SRC [configure args...]: ./configure with the musl compiler,
# then make. The build host is x86-64 Linux like the target, so configure's
# test programs (static musl binaries) run natively: no cross-compile guesses.
# MAKEINFO=true: manuals aren't built. MAKE_ARGS: extra make arguments
# (libtool projects need LDFLAGS=-all-static to link statically).
configure_make() {
  local src=$1
  shift
  (cd "$src" && ./configure --prefix=/usr --sysconfdir=/etc --localstatedir=/var --disable-nls "$@" \
      >configure.log 2>&1 && make -j"$(nproc)" MAKEINFO=true ${MAKE_ARGS:+"$MAKE_ARGS"} >make.log 2>&1) || {
    echo "build failed in $src (see configure.log / make.log)" >&2
    for f in configure.log make.log; do [ -f "$src/$f" ] && tail -n 20 "$src/$f" >&2; done
    exit 1
  }
}

# deps_openssl: static libssl/libcrypto 3.5 (LTS) into $SYSROOT; OPENSSLDIR=/etc/ssl
OPENSSL_VERSION=3.5.9
deps_openssl() {
  [ -f "$SYSROOT/lib/libssl.a" ] && return 0
  local src
  src=$(unpack "$(fetch https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VERSION/openssl-$OPENSSL_VERSION.tar.gz 603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a)" openssl-$OPENSSL_VERSION)
  (cd "$src" && ./Configure linux-x86_64 no-shared no-tests no-docs no-module no-dso no-afalgeng no-engine \
      --prefix="$SYSROOT" --libdir=lib --openssldir=/etc/ssl -static $CFLAGS >configure.log 2>&1 &&
    make -j"$(nproc)" >make.log 2>&1 && make install_sw >install.log 2>&1) || { echo "openssl build failed in $src" >&2; exit 1; }
}

# deps_curl: static libcurl (OpenSSL, zlib) into $SYSROOT, for git
CURL_VERSION=8.22.0
deps_curl() {
  [ -f "$SYSROOT/lib/libcurl.a" ] && return 0
  deps_zlib
  deps_openssl
  local src
  src=$(unpack "$(fetch https://curl.se/download/curl-$CURL_VERSION.tar.xz f7ef3ae8a22e521f289803fe93543eb64c329b58aa73a9e224dfd915a2a5f4f7)" curl-$CURL_VERSION)
  (cd "$src" && ./configure --prefix="$SYSROOT" --disable-shared --enable-static --with-openssl="$SYSROOT" --with-zlib="$SYSROOT" \
      --with-ca-bundle=/etc/ssl/certs/ca-certificates.crt --with-ca-path=/etc/ssl/certs \
      --without-libpsl --without-nghttp2 --without-brotli --without-zstd --without-libidn2 --without-librtmp --disable-ldap \
      --disable-manual --disable-docs --enable-ipv6 >configure.log 2>&1 &&
    make -j"$(nproc)" LDFLAGS="$LDFLAGS -all-static" >make.log 2>&1 && make install >install.log 2>&1) || { echo "curl build failed in $src" >&2; exit 1; }
}

# install_prebuilt FILE PKG/PATH: install an upstream static release binary
# as shipped (not stripped, so it still matches the release)
install_prebuilt() {
  local src=$1 dst="$PKG_OUT/$2"
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
  chmod 755 "$dst"
  if file "$dst" 2>/dev/null | grep -q dynamic; then echo "$dst is not static" >&2; exit 1; fi
  sha256sum "$dst"
}
