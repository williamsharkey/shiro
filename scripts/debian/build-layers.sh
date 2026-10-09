#!/usr/bin/env bash
# Build tabcomputer's toolchain layers (docs/DEBIAN.md "Toolchain layers"):
# for each set in src/debian/toolchains.json, apt-get install its packages in
# a chroot of exactly the base rootfs users install (rebuilt from
# public/debian by unpack-rootfs.mjs), from the base's pinned
# snapshot.debian.org timestamp, then pack what changed
# (pack-layer.mjs) into OUT/<id>/.
#
#   sudo bash scripts/debian/build-layers.sh [ID...]     # default: every set
#
# Environment:
#   BASE      packed base rootfs (default public/debian)
#   OUT       where layers go (default .toolchain-build/layers; server.mjs serves
#             TABCOMPUTER_DEBIAN_LAYERS at /debian/layers/)
#   WORK      scratch directory (default .toolchain-build/)
#   SPEC      the sets (default src/debian/toolchains.json)
#   SNAPSHOT  snapshot.debian.org timestamp (default: the base's)
#   MIRROR    archive URL prefix (default https://snapshot.debian.org/archive)
#   FORCE=1   rebuild layers whose recipe hash is unchanged
#   PRUNE=1   afterwards, delete chunks and indexes of all but each set's
#             current and previous build
#   MIN_FREE_GB  refuse to start with less free disk on WORK (default 6)
#   CA_BUNDLE CA certificates apt uses for https (default: the host's
#             /etc/ssl/certs/ca-certificates.crt; minbase has none)
#   HTTPS_PROXY  passed to apt as Acquire::https::Proxy when set
#
# A layer is rebuilt only when its recipe changes: the hash of the base id,
# the snapshot, the package list and this script and pack-layer.mjs. Old
# chunks stay (content-addressed; browsers that applied an older layer
# still fetch from them). Needs root (chroot, mounts), node, curl.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
BASE="${BASE:-$REPO/public/debian}"
OUT="${OUT:-$REPO/.toolchain-build/layers}"
WORK="${WORK:-$REPO/.toolchain-build}"
SPEC="${SPEC:-$REPO/src/debian/toolchains.json}"
SNAPSHOT="${SNAPSHOT:-$(node -p 'require(process.argv[1]).snapshot' "$BASE/rootfs.json")}"
MIRROR="${MIRROR:-https://snapshot.debian.org/archive}"
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1790812800}"

[ "$(id -u)" = 0 ] || { echo "build-layers.sh: run as root (it chroots)" >&2; exit 1; }
BASE_ID=$(node -p 'require(process.argv[1]).id' "$BASE/rootfs.json")
IDS=("$@")
[ ${#IDS[@]} -gt 0 ] || mapfile -t IDS < <(node -e 'for (const k of Object.keys(require(process.argv[1]).layers)) console.log(k)' "$SPEC")

mkdir -p "$WORK/debs" "$OUT"
free_gb=$(( $(df -Pk "$WORK" | awk 'NR==2 {print $4}') / 1024 / 1024 ))
if [ "$free_gb" -lt "${MIN_FREE_GB:-6}" ]; then
  echo "build-layers.sh: only ${free_gb} GB free on $WORK (need ${MIN_FREE_GB:-6}); not building" >&2; exit 1
fi
ROOT="$WORK/root"
BASEDIR="$WORK/base-$BASE_ID"
if [ ! -f "$BASEDIR/.complete" ]; then
  rm -rf "$WORK"/base-*
  node "$HERE/unpack-rootfs.mjs" "$BASE" "$BASEDIR"
  touch "$BASEDIR/.complete"
fi

umount_all() {
  for m in var/cache/apt/archives dev/pts dev sys proc; do mountpoint -q "$ROOT/$m" 2>/dev/null && umount -l "$ROOT/$m" || true; done
}
trap umount_all EXIT

CA_BUNDLE="${CA_BUNDLE:-/etc/ssl/certs/ca-certificates.crt}"
APT_OPTS=(-o Acquire::Retries=5 -o Acquire::https::CaInfo=/etc/apt/build-ca.crt)
[ -n "${HTTPS_PROXY:-${https_proxy:-}}" ] && APT_OPTS+=(-o "Acquire::https::Proxy=${HTTPS_PROXY:-$https_proxy}")

in_root() { chroot "$ROOT" /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C.UTF-8 \
  DEBIAN_FRONTEND=noninteractive SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" "$@"; }

for id in "${IDS[@]}"; do
  pkgs=$(node -e 'const l = require(process.argv[1]).layers[process.argv[2]]; if (!l) { console.error("no layer " + process.argv[2]); process.exit(1); } console.log(l.packages.join(" "))' "$SPEC" "$id")
  recipe=$( { echo "$BASE_ID $SNAPSHOT $MIRROR $pkgs"; cat "$0" "$HERE/pack-layer.mjs"; } | sha256sum | cut -c1-16)
  if [ -z "${FORCE:-}" ] && [ -f "$OUT/$id/layer.json" ] && grep -q "\"recipe\": \"$recipe\"" "$OUT/$id/layer.json"; then
    echo "== $id: up to date ($recipe)"; continue
  fi
  echo "== $id: $pkgs (recipe $recipe)"
  umount_all
  rm -rf "$ROOT"
  cp -a "$BASEDIR" "$ROOT"
  rm -f "$ROOT/.complete"

  mount -t proc proc "$ROOT/proc"
  mount --rbind /sys "$ROOT/sys"
  mount --rbind /dev "$ROOT/dev"
  mount --bind "$WORK/debs" "$ROOT/var/cache/apt/archives"
  cp -L /etc/resolv.conf "$ROOT/etc/resolv.conf.build"
  mv "$ROOT/etc/resolv.conf" "$ROOT/etc/resolv.conf.keep"
  cp "$ROOT/etc/resolv.conf.build" "$ROOT/etc/resolv.conf"

  # tabcomputer's overlay stubs (apt's http method is a `#!` to a page
  # program) can't run here: Debian's files stand in while apt runs, and
  # dpkg's diversions stay as they are.
  stubs=()
  while IFS=$'\t' read -r from to; do
    if [ -f "$ROOT$to" ]; then
      [ -e "$ROOT$from" ] && mv "$ROOT$from" "$ROOT$from.tc-stub"
      cp -a "$ROOT$to" "$ROOT$from"
      stubs+=("$from")
    fi
  done < <(paste - - - < "$ROOT/var/lib/dpkg/diversions" | awk -F'\t' '$3 == ":" && $2 == $1 ".debian" { print $1 "\t" $2 }')

  # The pinned archive, only for the build
  cp -a "$ROOT/etc/apt/sources.list.d/debian.sources" "$ROOT/etc/apt/debian.sources.keep"
  cat > "$ROOT/etc/apt/sources.list.d/debian.sources" <<EOF
Types: deb
URIs: $MIRROR/debian/$SNAPSHOT
Suites: trixie trixie-updates
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
Check-Valid-Until: no

Types: deb
URIs: $MIRROR/debian-security/$SNAPSHOT
Suites: trixie-security
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
Check-Valid-Until: no
EOF
  # The base leaves man pages out but keeps dpkg's man[1-9] includes; an
  # update-alternatives link into a missing man directory fails the
  # postinst (openjdk's java.1.gz), as on Docker's slim images
  mkdir -p "$ROOT"/usr/share/man/man{1..8}
  cp -L "$CA_BUNDLE" "$ROOT/etc/apt/build-ca.crt"
  in_root apt-get "${APT_OPTS[@]}" -o APT::Update::Error-Mode=any update
  # shellcheck disable=SC2086
  in_root apt-get "${APT_OPTS[@]}" -o APT::Keep-Downloaded-Packages=true install -y $pkgs
  in_root ldconfig

  # Back to the base's configuration and the overlay's stubs
  rm -f "$ROOT/etc/apt/build-ca.crt"
  mv "$ROOT/etc/apt/debian.sources.keep" "$ROOT/etc/apt/sources.list.d/debian.sources"
  mv "$ROOT/etc/resolv.conf.keep" "$ROOT/etc/resolv.conf"; rm -f "$ROOT/etc/resolv.conf.build"
  for from in "${stubs[@]}"; do
    rm -f "$ROOT$from"
    [ -e "$ROOT$from.tc-stub" ] && mv "$ROOT$from.tc-stub" "$ROOT$from"
  done
  umount_all

  rm -rf "$ROOT/var/cache/apt/"*.bin "$ROOT/var/lib/apt/lists/"* && mkdir -p "$ROOT/var/lib/apt/lists/partial"
  rm -rf "$ROOT/var/cache/apt/archives/"*.deb "$ROOT/var/cache/apt/archives/partial/"*
  find "$ROOT/var/log" -type f -delete
  rm -f "$ROOT/var/cache/debconf/"*-old "$ROOT/var/lib/dpkg/"*-old
  rm -rf "$ROOT/tmp/"* "$ROOT/var/tmp/"* "$ROOT/root/".bash_history "$ROOT/root/.cache"
  find "$ROOT" -xdev -newermt "@$SOURCE_DATE_EPOCH" -print0 | xargs -0r touch --no-dereference --date="@$SOURCE_DATE_EPOCH"

  node "$HERE/pack-layer.mjs" "$BASEDIR" "$ROOT" "$OUT" --id "$id" --spec "$SPEC" --base-id "$BASE_ID" --snapshot "$SNAPSHOT" --recipe "$recipe"
  # Each finished layer is served right away
  node "$HERE/pack-layer.mjs" --catalog "$OUT" --spec "$SPEC"
done
umount_all
rm -rf "$ROOT"
node "$HERE/pack-layer.mjs" --catalog "$OUT" --spec "$SPEC" ${PRUNE:+--prune}
