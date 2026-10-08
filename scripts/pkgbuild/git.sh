#!/usr/bin/env bash
# Git 2.47.1 (GPL-2.0-only) -> git-2.47.1-x86_64.tar.gz, run by Blink
#
# A static x86-64 Linux git (glibc, zlib; no curl/OpenSSL, expat, gettext,
# Perl, Python or Tcl) built with the host's gcc, installed under
# /usr/lib/pkg/git. In Blink it forks and execs its helpers and the commands
# a hook or alias names, so local workflows work as upstream: branches,
# merge, rebase, stash, blame, bisect, worktrees, clone from a path. No
# http(s) transport (git-remote-https needs curl). Needs gcc, make and a
# static libz.a on an x86-64 host.
. "$(dirname "$0")/common.sh"
VER=2.47.1
PREFIX=/usr/lib/pkg/git
SRC=$(unpack "$(fetch https://mirrors.edge.kernel.org/pub/software/scm/git/git-$VER.tar.gz f4c4e98667800585d218dfdf415eb72f73baa7abcac4569e2ce497970f8d6665)" git-$VER)
cd "$SRC"
OPTS=(prefix=$PREFIX NO_CURL=1 NO_OPENSSL=1 NO_EXPAT=1 NO_GETTEXT=1 NO_TCLTK=1 NO_PERL=1 NO_PYTHON=1
  NO_ICONV=1 NO_GITWEB=1 SKIP_DASHED_BUILT_INS=1 NO_INSTALL_HARDLINKS=1 INSTALL_SYMLINKS=
  CFLAGS=-O2 LDFLAGS=-static)
make -j"$(nproc)" "${OPTS[@]}" all >/dev/null 2>&1
R="$PKG_WORK/build/git-root"
rm -rf "$R"
make "${OPTS[@]}" DESTDIR="$R" install >/dev/null 2>&1
S="$R$PREFIX"
# The helpers git execs are copies of git or programs of their own; links
# don't survive the package tarball, so the duplicates of git go (git runs
# its builtins in-process, and `git foo` helpers it execs are found on PATH)
find "$S" -type l -delete
for f in "$S"/bin/* "$S"/libexec/git-core/*; do
  [ -f "$f" ] && cmp -s "$f" "$SRC/git" && [ "$f" != "$S/bin/git" ] && rm -f "$f"
done
# ...except the dashed commands other gits exec by name (clone and fetch run
# git-upload-pack, push git-receive-pack): a small static program that runs
# `git <name>` instead of a 5 MB copy each (and not a #! script: those run
# through Shiro's shell, which hands a program its stdin only at EOF)
cat > "$PKG_WORK/build/git-dashed.c" <<'C'
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  const char *base = strrchr(argv[0], '/') ? strrchr(argv[0], '/') + 1 : argv[0];
  char *args[argc + 2];
  args[0] = "git";
  args[1] = (char *)base + 4; /* "git-upload-pack" -> "upload-pack" */
  for (int i = 1; i <= argc; i++) args[i + 1] = argv[i];
  execv("/usr/lib/pkg/git/bin/git", args);
  return 127;
}
C
gcc -static -Os -s -o "$PKG_WORK/build/git-dashed" "$PKG_WORK/build/git-dashed.c"
for c in upload-pack receive-pack upload-archive; do
  rm -f "$S/bin/git-$c"
  cp "$PKG_WORK/build/git-dashed" "$S/libexec/git-core/git-$c"
done
find "$S/bin" "$S/libexec" -type f -perm -u+x -exec sh -c 'file "$1" | grep -q ELF && strip "$1"' _ {} \;
# server-side and mail helpers stay out
rm -f "$S"/bin/{git-shell,scalar} "$S"/libexec/git-core/{git-shell,scalar,git-daemon,git-http-backend,git-imap-send}
rm -rf "$S/share/gitweb" "$S/share/perl5" "$S/share/man" "$S/share/git-gui" "$S/share/gitk"
mkdir -p "$PKG_OUT/git"
( cd "$S" && tar --sort=name --owner=0 --group=0 --mtime=2025-01-01 -czf "$PKG_OUT/git/git-$VER-x86_64.tar.gz" . )
sha256sum "$PKG_OUT/git/git-$VER-x86_64.tar.gz"
