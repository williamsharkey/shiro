#!/usr/bin/env bash
# Ruby 3.4.1 (Ruby/BSD-2-Clause) for WASI -> ruby-3.4.1-wasip1.tar.gz
#
# The official ruby.wasm CLI build (ruby/ruby.wasm release 2.10.1,
# wasm32-unknown-wasip1 "full": ruby plus the stdlib and default gems),
# repacked for Shiro: GitHub release assets can't be fetched from a page
# (no CORS), so the index serves this tarball from /pkg. Ruby was built with
# prefix /usr/local, so the package mounts its lib/ruby at
# /usr/local/lib/ruby for its processes (index "mounts"). Shiro adds
# ruby/socket.rb, io/wait.rb, io/console.rb and operating_system.rb under
# site_ruby, an io-console gemspec, and an irb launcher that uses the cooked tty.
. "$(dirname "$0")/common.sh"
TGZ=$(fetch https://github.com/ruby/ruby.wasm/releases/download/2.10.1/ruby-3.4-wasm32-unknown-wasip1-full.tar.gz 440f9a48a3bae258c70de610f7a78cfc56b536bdb9b81ef750f8d3918382515e)
B="$PKG_WORK/build/ruby"
rm -rf "$B"; mkdir -p "$B/src" "$B/stage/bin" "$B/stage/lib"
tar xzf "$TGZ" -C "$B/src"
L="$B/src/ruby-3.4-wasm32-unknown-wasip1-full/usr/local"
cp "$L/bin/ruby" "$B/stage/bin/ruby.wasm"
# the gem/irb/rake/... launchers are scripts (#!/usr/local/bin/ruby)
for s in gem irb rake bundle bundler erb rdoc ri; do cp "$L/bin/$s" "$B/stage/bin/$s"; done
# irb reads lines from the tty in its cooked mode (WASI has no raw mode for
# reline); --multiline after these brings reline back
sed -i "s/^if Gem.respond_to?(:activate_bin_path)\$/ARGV.unshift('--nomultiline', '--nosingleline') # Shiro: no raw tty\\n&/" "$B/stage/bin/irb"
grep -q "Shiro: no raw tty" "$B/stage/bin/irb"
cp -r "$L/lib/ruby" "$B/stage/lib/"
# no socket, io/wait or io/console extensions (WASI): stubs so libraries using
# them load (io-console's gemspec lets reline, and so irb, activate);
# RubyGems' operating_system hook keeps minitest single-threaded
H="$(cd "$(dirname "$0")" && pwd)/ruby"
SR="$B/stage/lib/ruby/site_ruby/3.4.0"
mkdir -p "$SR/rubygems/defaults"
cp "$H/socket.rb" "$SR/socket.rb"
mkdir -p "$SR/io/console" && cp "$H/io-wait.rb" "$SR/io/wait.rb"
cp "$H/io-console.rb" "$SR/io/console.rb"
cp "$H/io-console-size.rb" "$SR/io/console/size.rb"
cp "$H/io-console-0.8.0.gemspec" "$B/stage/lib/ruby/gems/3.4.0/specifications/default/"
cp "$H/operating_system.rb" "$SR/rubygems/defaults/operating_system.rb"
mkdir -p "$PKG_OUT/ruby"
( cd "$B/stage" && tar --sort=name --owner=0 --group=0 --mtime=2025-01-01 -czf "$PKG_OUT/ruby/ruby-3.4.1-wasip1.tar.gz" . )
sha256sum "$PKG_OUT/ruby/ruby-3.4.1-wasip1.tar.gz"
