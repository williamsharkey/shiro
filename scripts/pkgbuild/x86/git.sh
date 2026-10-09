#!/usr/bin/env bash
# Git 2.56 (GPL-2.0-only) with libcurl/OpenSSL -> static x86-64 git, its helpers
# (git-remote-https, ...) under libexec/git-core, and templates
. "$(dirname "$0")/common.sh"
VERSION=2.56.0
SRC=$(unpack "$(fetch https://mirrors.edge.kernel.org/pub/software/scm/git/git-$VERSION.tar.xz 26c56c296b38c0695b26fa95f475f1d01704d2d38e73465ca30b0b2f5dc789d3)" git-$VERSION)
setup_musl
deps_curl
GITMAKE=(prefix=/usr gitexecdir=/usr/libexec/git-core sysconfdir=/etc template_dir=/usr/share/git-core/templates
  CC="$CC" AR="$AR" CFLAGS="$CFLAGS $CPPFLAGS" LDFLAGS="$LDFLAGS"
  NO_GETTEXT=YesPlease NO_TCLTK=YesPlease NO_PERL=YesPlease NO_PYTHON=YesPlease NO_EXPAT=YesPlease
  NO_ICONV=YesPlease NO_REGEX=NeedsStartEnd NO_SVN_TESTS=YesPlease NO_INSTALL_HARDLINKS=YesPlease
  SKIP_DASHED_BUILT_INS=YesPlease INSTALL_SYMLINKS=YesPlease
  CURL_CONFIG="$SYSROOT/bin/curl-config" CURL_LDFLAGS="$("$SYSROOT/bin/curl-config" --static-libs)"
  ZLIB_PATH="$SYSROOT" OPENSSLDIR="$SYSROOT" HAVE_DEV_TTY=YesPlease)
make -C "$SRC" -j"$(nproc)" "${GITMAKE[@]}" all >"$SRC/make.log" 2>&1 || { tail -20 "$SRC/make.log" >&2; exit 1; }
rm -rf "$PKG_WORK/git-root"
make -C "$SRC" "${GITMAKE[@]}" DESTDIR="$PKG_WORK/git-root" install >"$SRC/install.log" 2>&1 || { tail -20 "$SRC/install.log" >&2; exit 1; }
R="$PKG_WORK/git-root/usr"
rm -rf "$PKG_OUT/git" && mkdir -p "$PKG_OUT/git/bin" "$PKG_OUT/git/libexec" "$PKG_OUT/git/share"
install_bin "$R/bin/git" git/bin/git
cp -a "$R/libexec/git-core" "$PKG_OUT/git/libexec/"
# Leave out what needs perl/python/a server, and the dumb-HTTP/IMAP helpers
(cd "$PKG_OUT/git/libexec/git-core" && rm -f git-archimport git-cvs* git-daemon git-http-backend git-http-fetch \
  git-imap-send git-instaweb git-p4 git-send-email git-svn git-shell scalar)
# programs in libexec are stripped copies; links to git stay links
find "$PKG_OUT/git/libexec/git-core" -type f -exec sh -c 'head -c4 "$1" | grep -q ELF && "$STRIP" "$1"' _ {} \;
find "$PKG_OUT/git/libexec/git-core" -type l -lname '*bin/git' -exec ln -sf /usr/bin/git {} \;
cp -a "$R/share/git-core" "$PKG_OUT/git/share/"
# /etc/gitconfig (linked from the package): no automatic background maintenance,
# which costs seconds of CPU per run in Blink. Users can turn it back on.
mkdir -p "$PKG_OUT/git/etc"
cat > "$PKG_OUT/git/etc/gitconfig" <<'CFG'
# Shiro: no automatic maintenance. After commits, fetches and merges git
# would start `git maintenance run --auto --detach` (gc, commit-graph, ...)
# in the background, which costs seconds of CPU per run in the browser.
# To have it back: git config --global maintenance.auto true; gc.auto 6700
[maintenance]
	auto = false
[gc]
	auto = 0
CFG
