#!/usr/bin/env bash
# Perl 5.40.0 (Artistic or GPL) -> perl-5.40.0-x86_64.tar.gz, run by Blink
#
# A static x86-64 Linux perl (glibc, every XS module linked in, no dynamic
# loading) built with the host's gcc, installed under /usr/lib/pkg/perl.
# Shiro runs it in the Blink engine as a kernel process, so fork, exec,
# pipes, system() and backticks work. Pods and static archives are left
# out to keep the package small. Needs gcc and make on an x86-64 host.
. "$(dirname "$0")/common.sh"
VER=5.40.0
PREFIX=/usr/lib/pkg/perl
TGZ=$(fetch https://www.cpan.org/src/5.0/perl-$VER.tar.gz c740348f357396327a9795d3e8323bafd0fe8a5c7835fc1cbaba0cc8dfe7161f)
SRC=$(unpack "$TGZ" perl-$VER)
cd "$SRC"
# NO_LOCALE: static glibc can't load locales, and perl warned on every start
./Configure -des -Dprefix=$PREFIX -Uusedl -Dldflags=-static -Doptimize=-O2 \
  -Accflags=-DNO_LOCALE -Dlibs='-lm -lcrypt' -Dman1dir=none -Dman3dir=none >/dev/null
make -j"$(nproc)" >/dev/null
R="$PKG_WORK/build/perl-root"
rm -rf "$R"
make install DESTDIR="$R" >/dev/null
S="$R$PREFIX"
strip "$S/bin/perl"
rm -f "$S/bin/perl$VER" && ln -s perl "$S/bin/perl$VER"
find "$S/lib" \( -name '*.pod' -o -name '*.a' \) -delete
rm -rf "$S/lib/$VER/pod"
mkdir -p "$PKG_OUT/perl"
( cd "$S" && tar --sort=name --owner=0 --group=0 --mtime=2025-01-01 -czf "$PKG_OUT/perl/perl-$VER-x86_64.tar.gz" . )
sha256sum "$PKG_OUT/perl/perl-$VER-x86_64.tar.gz"
