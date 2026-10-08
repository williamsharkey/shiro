#!/usr/bin/env bash
# Ruby 3.4.1 (Ruby/BSD-2-Clause) for WASI -> ruby-3.4.1-wasip1.tar.gz
#
# The official ruby.wasm CLI build (ruby/ruby.wasm release 2.10.1,
# wasm32-unknown-wasip1 "full": ruby plus the stdlib and default gems),
# repacked for Shiro: GitHub release assets can't be fetched from a page
# (no CORS), so the index serves this tarball from /pkg. Ruby was built with
# prefix /usr/local, so the package mounts its lib/ruby at
# /usr/local/lib/ruby for its processes (index "mounts"). Shiro adds
# ruby/socket.rb and ruby/operating_system.rb under site_ruby.
. "$(dirname "$0")/common.sh"
TGZ=$(fetch https://github.com/ruby/ruby.wasm/releases/download/2.10.1/ruby-3.4-wasm32-unknown-wasip1-full.tar.gz 440f9a48a3bae258c70de610f7a78cfc56b536bdb9b81ef750f8d3918382515e)
B="$PKG_WORK/build/ruby"
rm -rf "$B"; mkdir -p "$B/src" "$B/stage/bin" "$B/stage/lib"
tar xzf "$TGZ" -C "$B/src"
L="$B/src/ruby-3.4-wasm32-unknown-wasip1-full/usr/local"
cp "$L/bin/ruby" "$B/stage/bin/ruby.wasm"
# the gem/irb/rake/... launchers are scripts (#!/usr/local/bin/ruby)
for s in gem irb rake bundle bundler erb rdoc ri; do cp "$L/bin/$s" "$B/stage/bin/$s"; done
cp -r "$L/lib/ruby" "$B/stage/lib/"
# no socket or io/wait extensions (WASI): stubs so libraries using them load;
# RubyGems' operating_system hook keeps minitest single-threaded
H="$(cd "$(dirname "$0")" && pwd)/ruby"
SR="$B/stage/lib/ruby/site_ruby/3.4.0"
mkdir -p "$SR/rubygems/defaults"
cp "$H/socket.rb" "$SR/socket.rb"
mkdir -p "$SR/io" && cp "$H/io-wait.rb" "$SR/io/wait.rb"
cp "$H/operating_system.rb" "$SR/rubygems/defaults/operating_system.rb"
mkdir -p "$PKG_OUT/ruby"
( cd "$B/stage" && tar --sort=name --owner=0 --group=0 --mtime=2025-01-01 -czf "$PKG_OUT/ruby/ruby-3.4.1-wasip1.tar.gz" . )
sha256sum "$PKG_OUT/ruby/ruby-3.4.1-wasip1.tar.gz"
