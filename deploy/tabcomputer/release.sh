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
cp server.mjs "$rel/server.mjs"
cp profiles/tabcomputer/server.env "$rel/server.env"
echo "$sha" > "$rel/DEPLOYED_SHA"
echo "$sha" > "$rel/public/deployed.txt"
ln -sfn "$rel" "$root/current.new" && mv -T "$root/current.new" "$root/current"
systemctl restart tabcomputer
ls -1dt "$root"/releases/* | tail -n +4 | xargs -r rm -rf
echo "deployed $sha"
