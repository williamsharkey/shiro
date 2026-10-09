#!/bin/bash
# Build the checked-out commit and make it the live release.
# Called by the droplet's tabcomputer-deploy (cloud-init.yaml) from the checkout:
#   release.sh <src checkout> <root, /opt/tabcomputer> <commit sha>
set -euo pipefail
src=$1 root=$2 sha=$3
cd "$src"
npm ci --no-audit --no-fund
npm run build
rel=$root/releases/$sha
rm -rf "$rel"; mkdir -p "$rel/public"
rsync -a dist/ "$rel/public/"
# Tabs opened before this deploy still import the old hashed chunks, so keep
# the live release's assets (themselves carried forward) for a week.
if [ -d "$root/current/public/assets" ]; then
  (cd "$root/current/public/assets" && find . -type f -mtime -7 -print0) |
    rsync -a --ignore-existing --from0 --files-from=- "$root/current/public/assets/" "$rel/public/assets/"
fi
cp server.mjs "$rel/server.mjs"
cp profiles/tabcomputer/server.env "$rel/server.env"
echo "$sha" > "$rel/DEPLOYED_SHA"
echo "$sha" > "$rel/public/deployed.txt"
ln -sfn "$rel" "$root/current.new" && mv -T "$root/current.new" "$root/current"
systemctl restart tabcomputer
bash deploy/tabcomputer/tls-install.sh "$src" || true
# Toolchain layers (docs/DEBIAN.md "Toolchain layers") build in the
# background, outside the release, and never fail or hold up the deploy:
# only sets whose recipe changed are rebuilt (usually none), at idle
# priority with half a CPU, and server.mjs serves $root/layers (server.env).
# The builder runs from a copy, so the next deploy's checkout can't change
# it mid-build, and in its own mount namespace (PrivateMounts), so its chroot
# mounts can never reach the host's (a shared rbind of /sys once unmounted
# the host's cgroup tree and left systemd unable to start any unit).
start_layer_build() {
  if systemctl is-active --quiet tabcomputer-layers; then
    echo "layer build still running; this release's recipes are built on the next deploy"; return 0
  fi
  local tools=$root/layer-build/tools
  rm -rf "$tools"; mkdir -p "$tools"
  cp scripts/debian/build-layers.sh scripts/debian/pack-layer.mjs scripts/debian/unpack-rootfs.mjs src/debian/toolchains.json "$tools/"
  systemctl reset-failed tabcomputer-layers 2>/dev/null || true
  systemd-run --unit=tabcomputer-layers --no-block -p PrivateMounts=yes -p Nice=19 -p IOSchedulingClass=idle -p CPUQuota=50% \
    -E BASE="$rel/public/debian" -E OUT="$root/layers" -E WORK="$root/layer-build" -E SPEC="$tools/toolchains.json" -E PRUNE=1 \
    bash "$tools/build-layers.sh"
}
start_layer_build || echo "layer build not started"
ls -1dt "$root"/releases/* | tail -n +4 | xargs -r rm -rf
echo "deployed $sha"
