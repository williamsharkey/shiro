#!/usr/bin/env bash
# Check that building a toolchain layer leaves the host's mounts alone.
#
#   sudo bash scripts/debian/check-layer-mounts.sh [BUILDER]
#
# Runs BUILDER (default scripts/debian/build-layers.sh) for a one-package set
# (`hello`) inside a mount namespace whose propagation is shared, as on a
# systemd host (containers often have private mounts, which hide the bug), and
# fails if that namespace's mount table differs afterwards. A build once
# unmounted the host's /sys/fs/cgroup this way (docs/DEBIAN.md "Toolchain layers").
# Needs root, network (snapshot.debian.org) and about a minute.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BUILDER="$(realpath "${1:-$HERE/build-layers.sh}")"
[ "$(id -u)" = 0 ] || { echo "check-layer-mounts.sh: run as root" >&2; exit 1; }
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
printf '{"format":1,"layers":{"probe":{"title":"Probe","description":"mount check","packages":["hello"]}}}\n' > "$TMP/spec.json"

unshare --mount --propagation unchanged env TMP="$TMP" BUILDER="$BUILDER" bash -c '
  set -euo pipefail
  mount --make-rshared /
  table() { awk "{ print \$5, \$9 }" /proc/self/mountinfo | sort; }
  before=$(table)
  SPEC="$TMP/spec.json" OUT="$TMP/out" WORK="$TMP/work" MIN_FREE_GB=1 bash "$BUILDER" probe > "$TMP/build.log" 2>&1 || { echo "build failed (exit $?):"; tail -20 "$TMP/build.log"; exit 1; }
  after=$(table)
  if [ "$before" != "$after" ]; then
    echo "FAIL: the build changed the mount table:"; diff <(echo "$before") <(echo "$after") || true; exit 1
  fi
  test -s "$TMP/out/probe/layer.json" || { echo "FAIL: no layer written"; exit 1; }
  echo "ok: layer built, mount table unchanged ($(echo "$after" | wc -l) mounts)"
'
