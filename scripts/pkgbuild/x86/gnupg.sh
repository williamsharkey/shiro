#!/usr/bin/env bash
# GnuPG 2.5.24 (GPL-3.0) with libgpg-error, libgcrypt, libassuan, libksba,
# npth (LGPL) and pinentry (curses and tty) -> static x86-64.
# gpg, gpgv, gpg-agent, gpgconf, gpg-connect-agent, gpgsm, gpgtar, gpg-card,
# pinentry; helpers in /usr/libexec. No dirmngr (keyservers), keyboxd,
# scdaemon/tpm2d (smartcards, TPM), LDAP, SQLite (TOFU) or GnuTLS.
. "$(dirname "$0")/common.sh"
VERSION=2.5.24
GCRYPT=https://www.gnupg.org/ftp/gcrypt
setup_musl
deps_zlib
deps_ncurses

# lib NAME VERSION SHA256 [configure args...]: a static GnuPG library into $SYSROOT
lib() {
  local name=$1 ver=$2 sha=$3 src
  shift 3
  [ -f "$SYSROOT/lib/lib${name#lib}.a" ] && return 0
  src=$(unpack "$(fetch "$GCRYPT/$name/$name-$ver.tar.bz2" "$sha")" "$name-$ver")
  # libtool drops -static from CC and LDFLAGS: its helper programs must run at build time
  (cd "$src" && ./configure --host=$HOST --prefix="$SYSROOT" --disable-shared --enable-static --disable-doc \
      --with-libgpg-error-prefix="$SYSROOT" "$@" >configure.log 2>&1 &&
    make -j"$(nproc)" LDFLAGS="$LDFLAGS -all-static" >make.log 2>&1 && make install >install.log 2>&1) || {
    echo "$name build failed in $src" >&2; tail -n 20 "$src/configure.log" "$src/make.log" >&2; exit 1; }
}
lib libgpg-error 1.61 7a85413f2bc354f4f8aa832b718af122e48965e9e0eb9012ee659c13c6385c93 --disable-tests --disable-languages --enable-install-gpg-error-config
lib libgcrypt 1.12.4 d77f68f48879510e79a2f65977ccc68981781ea0923e5bdffac2a193ea3d660e --disable-asm
lib libassuan 3.0.2 d2931cdad266e633510f9970e1a2f346055e351bb19f9b78912475b8074c36f6
lib libksba 1.8.1 c2f84393011827219ae117131dba8e7684c2bed0961eed11b0642c2acba440b5
lib npth 1.8 8bd24b4f23a3065d6e5b26e98aba9ce783ea4fd781069c1b35d149694e90ca3e --enable-install-npth-config

LIBS_ARGS=(--with-libgpg-error-prefix="$SYSROOT" --with-libgcrypt-prefix="$SYSROOT" --with-libassuan-prefix="$SYSROOT"
  --with-ksba-prefix="$SYSROOT" --with-npth-prefix="$SYSROOT")

PIN=$(unpack "$(fetch $GCRYPT/pinentry/pinentry-1.3.3.tar.bz2 \
  c2970f16d6afb66ecddfca767d743936c86239bff936eed7fd7597a678414b63)" pinentry-1.3.3)
configure_make "$PIN" "${LIBS_ARGS[@]}" --enable-pinentry-curses --enable-pinentry-tty --disable-pinentry-qt \
  --disable-pinentry-qt5 --disable-pinentry-gtk2 --disable-pinentry-gnome3 --disable-pinentry-emacs \
  --disable-pinentry-fltk --disable-pinentry-efl --disable-libsecret --disable-fallback-curses \
  --with-ncurses-include-dir="$SYSROOT/include/ncursesw"

SRC=$(unpack "$(fetch $GCRYPT/gnupg/gnupg-$VERSION.tar.bz2 bf149d01a2b9fcc0e4589b8ae8697d3d5c557ea48ed95a3fa55dd3b1187e6039)" gnupg-$VERSION)
configure_make "$SRC" "${LIBS_ARGS[@]}" --libexecdir=/usr/libexec --with-zlib="$SYSROOT" --without-bzip2 --without-readline \
  --disable-dirmngr --disable-keyboxd --disable-scdaemon --disable-tpm2d --disable-ldap --disable-sqlite \
  --disable-gnutls --disable-ntbtls --disable-wks-tools --disable-doc --disable-tests \
  --with-pinentry-pgm=/usr/bin/pinentry

rm -rf "$PKG_OUT/gnupg"
for p in g10/gpg g10/gpgv agent/gpg-agent tools/gpgconf tools/gpg-connect-agent sm/gpgsm tools/gpgtar tools/gpg-card; do
  install_bin "$SRC/$p" "gnupg/bin/${p##*/}"
done
for p in agent/gpg-protect-tool agent/gpg-preset-passphrase tools/gpg-check-pattern; do
  install_bin "$SRC/$p" "gnupg/libexec/${p##*/}"
done
install_bin "$PIN/curses/pinentry-curses" gnupg/bin/pinentry-curses
install_bin "$PIN/tty/pinentry-tty" gnupg/bin/pinentry-tty
