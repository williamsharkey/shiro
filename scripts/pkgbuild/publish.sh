#!/usr/bin/env bash
# publish.sh NAME VERSION: copy a recipe's output ($PKG_OUT/NAME/) into
# public/pkg/NAME/VERSION/ (served at /pkg/... by shiro.computer) and print
# the index "files" entries to paste into src/pkg-index.json.
. "$(dirname "$0")/common.sh"
NAME=$1 VERSION=$2
REPO=$(cd "$(dirname "$0")/../.." && pwd)
DEST="$REPO/public/pkg/$NAME/$VERSION"
mkdir -p "$DEST"
cd "$PKG_OUT/$NAME"
find . -type f | sort | while read -r f; do
  rel=${f#./}
  install -m 0644 "$f" "$DEST/$(basename "$rel")"
  printf '{ "path": "%s", "url": "/pkg/%s/%s/%s", "sha256": "%s", "size": %d }\n' \
    "$rel" "$NAME" "$VERSION" "$(basename "$rel")" "$(sha256sum "$f" | cut -d' ' -f1)" "$(stat -c %s "$f")"
done
