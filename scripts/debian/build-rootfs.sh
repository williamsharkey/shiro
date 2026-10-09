#!/usr/bin/env bash
# Build Shiro's Debian root filesystem: Debian stable (trixie) amd64,
# debootstrap --variant=minbase from a pinned snapshot.debian.org timestamp,
# then customize it for Shiro and pack it into content-addressed chunks
# (scripts/debian/pack-rootfs.mjs) under public/debian/.
#
#   sudo bash scripts/debian/build-rootfs.sh          # needs root (chroot, mknod)
#
# Environment:
#   SNAPSHOT   snapshot.debian.org timestamp (default below; pins every byte)
#   MIRROR     archive to bootstrap from (default: the snapshot)
#   WORK       scratch directory (default .debian-build/)
#   OUT        where the packed rootfs goes (default public/debian/)
#
# The result is reproducible given the same SNAPSHOT: packages come from the
# snapshot with sha256s checked by debootstrap against the signed Release,
# file times are clamped to SOURCE_DATE_EPOCH, and logs, caches and
# machine-specific files are removed. See docs/DEBIAN.md.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SUITE=trixie
SNAPSHOT="${SNAPSHOT:-20261001T000000Z}"
MIRROR="${MIRROR:-https://snapshot.debian.org/archive/debian/$SNAPSHOT}"
WORK="${WORK:-$REPO/.debian-build}"
OUT="${OUT:-$REPO/public/debian}"
ROOT="$WORK/rootfs"
# 2026-10-01T00:00:00Z: file times in the image
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1790812800}"

# Tools debootstrap needs, pinned by sha256 (from the snapshot's Packages).
DEBOOTSTRAP_DEB=pool/main/d/debootstrap/debootstrap_1.0.141_all.deb
DEBOOTSTRAP_SHA=8c02cb8ad712eb67afb0d23fab175c562804cc97eda70b70cb0f3bc2a21732d7
KEYRING_DEB=pool/main/d/debian-archive-keyring/debian-archive-keyring_2025.1_all.deb
KEYRING_SHA=9ea7778e443144ca490668737a8ab22dd3e748bb99e805e22ec055abeb3c7fac

[ "$(id -u)" = 0 ] || { echo "build-rootfs.sh: run as root (debootstrap chroots)" >&2; exit 1; }
mkdir -p "$WORK/dl"

fetch() { # url sha256 dest
  if [ ! -f "$3" ] || ! echo "$2  $3" | sha256sum -c --status; then
    curl -fsSL --retry 5 -o "$3.tmp" "$1"
    echo "$2  $3.tmp" | sha256sum -c --status || { echo "sha256 mismatch: $1" >&2; exit 1; }
    mv "$3.tmp" "$3"
  fi
}

fetch "$MIRROR/$DEBOOTSTRAP_DEB" "$DEBOOTSTRAP_SHA" "$WORK/dl/debootstrap.deb"
fetch "$MIRROR/$KEYRING_DEB" "$KEYRING_SHA" "$WORK/dl/keyring.deb"
rm -rf "$WORK/tools" && mkdir -p "$WORK/tools"
dpkg-deb -x "$WORK/dl/debootstrap.deb" "$WORK/tools"
dpkg-deb -x "$WORK/dl/keyring.deb" "$WORK/tools"
KEYRING="$WORK/tools/usr/share/keyrings/debian-archive-keyring.gpg"

umount_all() {
  for m in proc sys dev/pts dev; do mountpoint -q "$ROOT/$m" 2>/dev/null && umount -l "$ROOT/$m" || true; done
}
trap umount_all EXIT

if [ ! -f "$ROOT/.debootstrap-done" ]; then
  umount_all
  rm -rf "$ROOT"
  # Downloaded .debs are kept in $WORK/debs so a rebuild doesn't refetch them.
  mkdir -p "$WORK/debs" "$ROOT/var/cache/apt/archives"
  cp -l "$WORK/debs/"*.deb "$ROOT/var/cache/apt/archives/" 2>/dev/null || true
  DEBOOTSTRAP_DIR="$WORK/tools/usr/share/debootstrap" \
    "$WORK/tools/usr/sbin/debootstrap" --variant=minbase --arch=amd64 \
      --keyring="$KEYRING" --keep-debootstrap-dir \
      "$SUITE" "$ROOT" "$MIRROR"
  cp -n "$ROOT/var/cache/apt/archives/"*.deb "$WORK/debs/" 2>/dev/null || true
  touch "$ROOT/.debootstrap-done"
fi
umount_all

# ── Shiro customization (everything below is replayed on every build) ──
in_root() { chroot "$ROOT" /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C.UTF-8 SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" "$@"; }

# apt sources: the real archive names. Inside Shiro, apt's http method is
# Shiro's (shiro-apt-method), which fetches them from the page's same-origin
# mirror path; see docs/DEBIAN.md "Package mirror".
cat > "$ROOT/etc/apt/sources.list.d/debian.sources" <<EOF
Types: deb
URIs: http://deb.debian.org/debian
Suites: $SUITE $SUITE-updates
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg

Types: deb
URIs: http://deb.debian.org/debian-security
Suites: $SUITE-security
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
EOF
rm -f "$ROOT/etc/apt/sources.list"

cat > "$ROOT/etc/apt/apt.conf.d/90shiro" <<'EOF'
// Shiro (browser) defaults; see docs/DEBIAN.md.
// No translations: Translation-en is ~8 MB to fetch and parse for nothing.
Acquire::Languages "none";
// Downloads run as root: the kernel has one user per process, not setresuid.
APT::Sandbox::User "root";
// Don't keep .debs after installing them (they live in the browser's quota).
APT::Keep-Downloaded-Packages "false";
Binary::apt::APT::Keep-Downloaded-Packages "false";
// No recommends by default, like Docker's Debian images: smaller installs.
APT::Install-Recommends "false";
// The progress bar redraws per byte over a slow terminal.
Dpkg::Progress-Fancy "false";
Acquire::PDiffs "false";
EOF

# Like Docker's debian:slim: keep docs, man pages and translations out of
# the image and out of later installs (dpkg still lists them; see dpkg(1)
# --path-exclude).
cat > "$ROOT/etc/dpkg/dpkg.cfg.d/90shiro-slim" <<'EOF'
path-exclude /usr/share/doc/*
path-include /usr/share/doc/*/copyright
path-exclude /usr/share/man/*
path-exclude /usr/share/info/*
path-exclude /usr/share/locale/*
path-include /usr/share/locale/locale.alias
path-exclude /usr/share/lintian/*
path-exclude /usr/share/linda/*
EOF
cat > "$ROOT/etc/dpkg/dpkg.cfg.d/91shiro-io" <<'EOF'
# The browser filesystem commits asynchronously; fsync per file is wasted work.
force-unsafe-io
EOF
find "$ROOT/usr/share/doc" -mindepth 1 -not -name copyright -not -type d -delete 2>/dev/null || true
find "$ROOT/usr/share/doc" -mindepth 1 -type d -empty -delete 2>/dev/null || true
rm -rf "$ROOT/usr/share/man/"* "$ROOT/usr/share/info/"* "$ROOT/usr/share/lintian" "$ROOT/usr/share/linda"
find "$ROOT/usr/share/locale" -mindepth 1 -maxdepth 1 -not -name locale.alias -exec rm -rf {} + 2>/dev/null || true

# The Shiro user (uid 1000, as the kernel runs everything) with sudo rights
# through Shiro's sudo, and the hostname the kernel reports.
if ! grep -q '^user:' "$ROOT/etc/passwd"; then
  in_root groupadd -g 1000 user
  in_root useradd -u 1000 -g 1000 -G sudo -d /home/user -s /bin/bash -M user
  in_root passwd -d user >/dev/null
fi
echo shiro > "$ROOT/etc/hostname"
printf '127.0.0.1\tlocalhost\n127.0.1.1\tshiro\n::1\t\tlocalhost ip6-localhost ip6-loopback\n' > "$ROOT/etc/hosts"
# The kernel answers DNS on this address over DNS-over-HTTPS (docs/NETWORKING.md).
echo 'nameserver 10.0.2.3' > "$ROOT/etc/resolv.conf"

# The overlay's defaults (src/debian/overlay-policy.json), recorded the way
# dpkg records them: local diversions, made by dpkg-divert itself. Programs
# that must exist as files get a stub naming the Shiro kernel program.
node -e '
  const p = require(process.argv[1]).programs;
  for (const [path, pol] of Object.entries(p)) if (pol.default === "shiro") console.log(path, pol.command, pol.stub ? 1 : 0);
' "$REPO/src/debian/overlay-policy.json" | while read -r path command stub; do
  if ! in_root dpkg-divert --list "$path" | grep -q "local diversion"; then
    in_root dpkg-divert --local --rename --divert "$path.debian" --add "$path"
  fi
  if [ "$stub" = 1 ]; then printf '#!/usr/bin/%s\n' "$command" > "$ROOT$path"; chmod 755 "$ROOT$path"; fi
done

# Machine-specific and build-time state out.
rm -rf "$ROOT/debootstrap" "$ROOT/.debootstrap-done.tmp"
rm -f "$ROOT/etc/machine-id" "$ROOT/var/lib/dbus/machine-id"
: > "$ROOT/etc/machine-id"
rm -rf "$ROOT/var/cache/apt/"*.bin "$ROOT/var/cache/apt/archives/"*.deb "$ROOT/var/cache/apt/archives/partial/"*
rm -rf "$ROOT/var/lib/apt/lists/"* && mkdir -p "$ROOT/var/lib/apt/lists/partial"
find "$ROOT/var/log" -type f -delete
rm -f "$ROOT/var/cache/debconf/"*-old "$ROOT/var/lib/dpkg/"*-old
rm -rf "$ROOT/tmp/"* "$ROOT/var/tmp/"* "$ROOT/root/".bash_history
find "$ROOT" -xdev -newermt "@$SOURCE_DATE_EPOCH" -print0 | xargs -0r touch --no-dereference --date="@$SOURCE_DATE_EPOCH"

node "$HERE/pack-rootfs.mjs" "$ROOT" "$OUT" --snapshot "$SNAPSHOT" --suite "$SUITE" ${PACK_ARGS:-}
