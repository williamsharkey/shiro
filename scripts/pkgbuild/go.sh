#!/usr/bin/env bash
# Go 1.24.7 (BSD-3-Clause) toolchain for GOOS=wasip1 -> go-1.24.7-wasip1.tar.gz
# (a GOROOT: bin/, pkg/, src/, cache/, go.env; the index unpacks its parts)
#
# The go command and its tools (compile, link, asm, buildid, vet), built for
# wasip1, with a GOROOT holding the standard library sources. Go's wasip1
# port can't start processes, so go/wasip1-processes.patch gives syscall,
# os and os/exec real StartProcess/Wait4/Pipe/LookPath on the WASIX calls
# Shiro's kernel provides (proc_spawn3, proc_join, fd_pipe), polls Wait4 so
# goroutines keep running, makes cmd/go's file locks no-ops, and stops the
# runtime starving the netpoller while os/signal waits (go test hung). The same
# patched std is shipped, so Go programs built in Shiro can run commands too.
# Needs a host Go >= 1.22.6 for make.bash ($GOROOT_BOOTSTRAP, else pinned).
. "$(dirname "$0")/common.sh"
VER=1.24.7
PREFIX=/usr/lib/pkg/go
SRC_TGZ=$(fetch https://go.dev/dl/go$VER.src.tar.gz 2a8f50db0f88803607c50d7ea8834dcb7bd483c6b428a91e360fdf8624b46464)
if [ -z "${GOROOT_BOOTSTRAP:-}" ]; then
  BOOT=$(fetch https://go.dev/dl/go$VER.linux-amd64.tar.gz da18191ddb7db8a9339816f3e2b54bdded8047cdc2a5d67059478f8d1595c43f)
  mkdir -p "$PKG_WORK/go-bootstrap"
  [ -x "$PKG_WORK/go-bootstrap/go/bin/go" ] || tar xzf "$BOOT" -C "$PKG_WORK/go-bootstrap"
  export GOROOT_BOOTSTRAP="$PKG_WORK/go-bootstrap/go"
fi
B="$PKG_WORK/build/go"
rm -rf "$B"; mkdir -p "$B"
tar xzf "$SRC_TGZ" -C "$B"
G="$B/go"
PATCH="$(cd "$(dirname "$0")" && pwd)/go/wasip1-processes.patch"
( cd "$G" && patch -p1 -s < "$PATCH" )
# No toolchain downloads, and no module proxy (wasip1 has no sockets)
sed -i 's/^GOTOOLCHAIN=auto$/GOTOOLCHAIN=local/' "$G/go.env"
cat >> "$G/go.env" <<'EOF'

# Shiro: wasip1 has no network for the go command; vendor modules or use
# replace directives. Builds use 4 kernel processes (wasip1 reports 1 CPU).
GOPROXY=off
GOSUMDB=off
GOFLAGS=-p=4
# The build cache starts with common std packages compiled for wasip1
GOCACHE=/usr/lib/pkg/go/cache
EOF

# 1. a host toolchain from the patched tree, 2. the tools for wasip1
( cd "$G/src" && ./make.bash >/dev/null )
OUT="$B/out"; mkdir -p "$OUT"
( cd "$G/src" && GOOS=wasip1 GOARCH=wasm "$G/bin/go" build -trimpath \
    -ldflags "-s -w -X runtime.defaultGOROOT=$PREFIX" -o "$OUT/" \
    cmd/go cmd/gofmt cmd/compile cmd/link cmd/asm cmd/buildid cmd/vet )

# 3. the GOROOT: tools, std sources (no tests, testdata or cmd), headers
S="$B/stage"; rm -rf "$S"; mkdir -p "$S/bin" "$S/pkg/tool/wasip1_wasm"
cp "$OUT/go" "$OUT/gofmt" "$S/bin/"
for t in compile link asm buildid vet; do cp "$OUT/$t" "$S/pkg/tool/wasip1_wasm/"; done
cp "$G/VERSION" "$G/go.env" "$G/LICENSE" "$S/"
cp -r "$G/pkg/include" "$S/pkg/"
( cd "$G" && find src -path src/cmd -prune -o -type d -name testdata -prune -o -type f ! -name '*_test.go' -print ) > "$B/src.list"
( cd "$G" && tar cf - -T "$B/src.list" ) | ( cd "$S" && tar xf - )
# 4. a build cache of common std packages for wasip1, compiled by the host
#    build of the same patched toolchain: release tool IDs are the version,
#    so the wasm go command hits these entries (the first `go build` of a
#    small program takes seconds instead of a minute or two)
CACHE_PKGS="bufio bytes crypto/sha256 encoding/base64 encoding/hex encoding/json errors flag fmt io log math
  math/rand net/url os os/exec path/filepath regexp sort strconv strings sync text/template time unicode/utf8"
GOROOT="$G" GOCACHE="$S/cache" GOOS=wasip1 GOARCH=wasm GOTOOLCHAIN=local GOFLAGS= GOPROXY=off "$G/bin/go" build $CACHE_PKGS
mkdir -p "$PKG_OUT/go"
( cd "$S" && tar --sort=name --owner=0 --group=0 --mtime=2025-01-01 -czf "$PKG_OUT/go/go-$VER-wasip1.tar.gz" . )
sha256sum "$PKG_OUT/go/go-$VER-wasip1.tar.gz"
