#!/usr/bin/env bash
# uutils coreutils 0.12.0 (MIT) -> coreutils.wasm, a multi-call binary
# (`coreutils ls`, or argv[0] = applet name). Built with the upstream
# `feat_wasm` feature set; needs rustup's wasm32-wasip1 target.
. "$(dirname "$0")/common.sh"
VERSION=0.12.0
CRATE=$(fetch https://static.crates.io/crates/coreutils/coreutils-$VERSION.crate a179dc3f3af0389cbd0a8d238ea047abbd72b47225bb49cbadb9a3824a44938e)
rm -rf "$PKG_WORK/build/coreutils-$VERSION"
mkdir -p "$PKG_WORK/build"
tar xzf "$CRATE" -C "$PKG_WORK/build"
cd "$PKG_WORK/build/coreutils-$VERSION"
rustup target add wasm32-wasip1 >/dev/null
cargo build --profile release-small --locked --target wasm32-wasip1 --no-default-features --features feat_wasm >cargo.log 2>&1 || { tail -40 cargo.log; exit 1; }
setup_wasi_sdk
install_wasm target/wasm32-wasip1/release-small/coreutils.wasm coreutils/bin/coreutils
