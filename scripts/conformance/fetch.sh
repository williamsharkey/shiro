#!/bin/sh
# Fetch the external (not vendored) conformance suites at pinned commits
# into tests/conformance/.cache. Safe to re-run.
set -e
cd "$(dirname "$0")/../../tests/conformance"
mkdir -p .cache
fetch() { # name url commit sparse-path
  [ -d ".cache/$1/.git" ] && [ "$(git -C ".cache/$1" rev-parse HEAD)" = "$3" ] && return 0
  rm -rf ".cache/$1"
  git init -q ".cache/$1"
  git -C ".cache/$1" remote add origin "$2"
  git -C ".cache/$1" sparse-checkout set "$4"
  git -C ".cache/$1" fetch -q --depth 1 --filter=blob:none origin "$3"
  git -C ".cache/$1" checkout -q FETCH_HEAD
}
fetch busybox https://github.com/mirror/busybox 371fe9f71d445d18be28c82a2a6d82115c8af19d testsuite
echo "busybox testsuite: tests/conformance/.cache/busybox/testsuite"
fetch wasi-testsuite https://github.com/WebAssembly/wasi-testsuite e0aa527fab67f2f311882bcee4f62cc755433b73 tests
echo "wasi-testsuite: tests/conformance/.cache/wasi-testsuite/tests"
