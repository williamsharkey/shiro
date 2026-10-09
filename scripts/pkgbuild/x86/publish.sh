#!/usr/bin/env bash
# publish.sh NAME VERSION: copy an x86 recipe's output ($PKG_OUT/NAME/) into
# public/pkg/NAME/VERSION/ (served at /pkg/... by shiro.computer), compressed:
# every program in bin/ (and sbin/) as its own .gz, every other top-level
# directory (libexec/, share/, etc/, ...) as one reproducible .tar.gz, which
# keeps symlinks and modes.
# Prints the index "files" entries for src/pkg-index.json; with --index, also
# writes them into the package's entry there (which must exist), with a
# /usr/share/man link for every manual page in share/man.
set -euo pipefail
UPDATE_INDEX=
if [ "${1:-}" = --index ]; then UPDATE_INDEX=1; shift; fi
PKG_WORK=${PKG_WORK:-$PWD/.pkgbuild}
PKG_OUT=${PKG_OUT:-$PKG_WORK/out}
NAME=$1 VERSION=$2
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
DEST="$REPO/public/pkg/$NAME/$VERSION"
rm -rf "$DEST"
mkdir -p "$DEST"
cd "$PKG_OUT/$NAME"
entry() { # path file unpack
  printf '{ "path": "%s", "url": "/pkg/%s/%s/%s", "sha256": "%s", "size": %d, "unpack": "%s" }\n' \
    "$1" "$NAME" "$VERSION" "$(basename "$2")" "$(sha256sum "$2" | cut -d' ' -f1)" "$(stat -c %s "$2")" "$3"
}
ENTRIES=$(mktemp)
trap 'rm -f "$ENTRIES"' EXIT
exec 3>&1 >"$ENTRIES"
for dir in bin sbin; do
  [ -d "$dir" ] || continue
  find "$dir" -type f | sort | while read -r f; do
    out="$DEST/$(basename "$f").gz"
    gzip -9n <"$f" >"$out"
    entry "$f" "$out" gzip
  done
done
for dir in $(find . -mindepth 1 -maxdepth 1 -type d | sed 's|^\./||' | sort); do
  case $dir in bin|sbin) continue ;; esac
  out="$DEST/$dir.tar.gz"
  tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C "$dir" -cf - . | gzip -9n >"$out"
  entry "$dir" "$out" tar.gz
done
exec >&3
cat "$ENTRIES"
PAGES=$( [ -d share/man ] && find share/man -type f | sort || true)
if [ -n "$UPDATE_INDEX" ]; then
  node -e '
    const fs = require("fs");
    const [file, name, version, entries, pages] = process.argv.slice(1);
    const idx = JSON.parse(fs.readFileSync(file, "utf8"));
    const p = idx.packages.find((x) => x.name === name);
    if (!p) { console.error(`no package ${name} in ${file}`); process.exit(1); }
    p.version = version;
    p.files = fs.readFileSync(entries, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    // every manual page in share/man is linked into /usr/share/man
    const links = Object.fromEntries(Object.entries(p.links ?? {}).filter(([k]) => !k.startsWith("/usr/share/man/")));
    for (const m of pages.split("\n").filter(Boolean)) links["/usr/" + m] = m;
    if (Object.keys(links).length) p.links = links; else delete p.links;
    fs.writeFileSync(file, JSON.stringify(idx, null, 1) + "\n");
  ' "$REPO/src/pkg-index.json" "$NAME" "$VERSION" "$ENTRIES" "$PAGES"
fi
