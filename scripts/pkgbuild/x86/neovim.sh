#!/usr/bin/env bash
# Neovim 0.12.5 (Apache-2.0 / Vim) -> static x86-64 musl, with PUC Lua 5.1
# (LuaJIT's JIT would generate x86 code for Blink to translate again), its
# bundled libuv, luv, lpeg, unibilium, utf8proc, tree-sitter and the bundled
# parsers (c, lua, vim, vimdoc, query, markdown). Runtime in /usr/share/nvim.
. "$(dirname "$0")/common.sh"
VERSION=0.12.5
setup_musl
SRC=$(fetch_git https://github.com/neovim/neovim.git v$VERSION 5885a30e1e1225349079e7a1c4a3848aa8e43e42 neovim-$VERSION)
# A static nvim cannot dlopen parser/*.so: link the bundled parsers in
git -C "$SRC" apply "$(cd "$(dirname "$0")" && pwd)/neovim/static-parsers.patch"

# cmake.deps downloads GitHub archive tarballs; clone the same tags instead
# (pinned by commit) into the source dirs it expects (USE_EXISTING_SRC_DIR)
DEPS="$SRC/.deps"
DSRC="$DEPS/build/src"
mkdir -p "$DSRC"
dep() { # NAME REPO TAG COMMIT
  local dir
  dir=$(fetch_git "https://github.com/$2.git" "$3" "$4" "nvim-dep-$1")
  rm -rf "${DSRC:?}/$1"
  mv "$dir" "$DSRC/$1"
}
dep libuv libuv/libuv v1.52.1 1cfa32ff59c076ffb6ed735bbc8c18361558661f
dep luv luvit/luv 1.52.1-0 f65fe9d7616f9fbcd20227fc7a73b38d1c5c180d
dep lua_compat53 lunarmodules/lua-compat-5.3 v0.13 7af7bf7e0db3c9d88881fdf10d880a6e2ab1d095
dep unibilium neovim/unibilium v2.1.2 bfcb0350129dd76893bc90399cf37c45812268a2
dep utf8proc juliastrings/utf8proc v2.11.3 e5e799221b45bbb90f5fdc5c69b6b8dfbf017e78
dep treesitter tree-sitter/tree-sitter v0.26.13 d97971e24500218865c05ed1febdee2acf41bae1
dep treesitter_c tree-sitter/tree-sitter-c v0.24.1 7fa1be1b694b6e763686793d97da01f36a0e5c12
dep treesitter_lua tree-sitter-grammars/tree-sitter-lua v0.5.0 10fe0054734eec83049514ea2e718b2a56acd0c9
dep treesitter_vim tree-sitter-grammars/tree-sitter-vim v0.8.1 3092fcd99eb87bbd0fc434aa03650ba58bd5b43b
dep treesitter_vimdoc neovim/tree-sitter-vimdoc v4.1.0 f061895a0eff1d5b90e4fb60d21d87be3267031a
dep treesitter_query tree-sitter-grammars/tree-sitter-query v0.8.0 a225e21d81201be77da58de614e2b7851735677a
dep treesitter_markdown tree-sitter-grammars/tree-sitter-markdown v0.5.3 f969cd3ae3f9fbd4e43205431d0ae286014c05b5
rm -rf "$DSRC/lua" "$DSRC/lpeg"
tar xzf "$(fetch https://www.lua.org/ftp/lua-5.1.5.tar.gz 2640fc56a795f29d28ef15e13c34a47e223960b0240e8cb0a82d9b0738695333)" -C "$DSRC" && mv "$DSRC/lua-5.1.5" "$DSRC/lua"
# lpeg's tarball lives in the neovim/deps repository (same sha256 as deps.txt)
LPEG_REPO="$PKG_WORK/build/nvim-deps-repo"
if [ ! -f "$LPEG_REPO/opt/lpeg-1.1.0.tar.gz" ]; then
  rm -rf "$LPEG_REPO" && git init -q "$LPEG_REPO"
  git -C "$LPEG_REPO" fetch -q --depth 1 https://github.com/neovim/deps.git d495ee6f79e7962a53ad79670cb92488abe0b9b4
  git -C "$LPEG_REPO" -c advice.detachedHead=false checkout -q FETCH_HEAD
fi
echo "4b155d67d2246c1ffa7ad7bc466c1ea899bbc40fef0257cc9c03cecbaed4352a  $LPEG_REPO/opt/lpeg-1.1.0.tar.gz" | sha256sum -c --status
mkdir -p "$DSRC/lpeg" && tar xzf "$LPEG_REPO/opt/lpeg-1.1.0.tar.gz" -C "$DSRC/lpeg" --strip-components=1

# luv's FindLua looks for libm where the build host keeps it, not in the musl sysroot
sed -i "s|-D BUILD_MODULE=OFF)|-D BUILD_MODULE=OFF -D LUA_MATH_LIBRARY=$MUSL_CROSS/$HOST/lib/libm.a)|" "$SRC/cmake.deps/cmake/BuildLuv.cmake"

# CC carries -static for configure-style builds; CMake wants the bare compiler
export CC=$HOST-gcc CXX=$HOST-g++
STATIC=(-DCMAKE_EXE_LINKER_FLAGS="-static -no-pie" -DCMAKE_POSITION_INDEPENDENT_CODE=OFF)
(cd "$SRC" &&
  cmake -S cmake.deps -B .deps -G Ninja -DCMAKE_BUILD_TYPE=Release -DUSE_EXISTING_SRC_DIR=ON \
    -DUSE_BUNDLED_LUAJIT=OFF -DUSE_BUNDLED_LUA=ON -DUSE_BUNDLED_GETTEXT=OFF -DUSE_BUNDLED_LIBICONV=OFF \
    -DCMAKE_C_FLAGS="-Os -fno-pie" "${STATIC[@]}" >deps-configure.log 2>&1 &&
  cmake --build .deps >deps-build.log 2>&1) || {
  echo "neovim deps build failed in $SRC" >&2; tail -n 25 "$SRC/deps-configure.log" "$SRC/deps-build.log" >&2; exit 1; }

PARSERS="$DEPS/parsers"
rm -rf "$PARSERS" && mkdir -p "$PARSERS"
for d in treesitter_c treesitter_lua treesitter_vim treesitter_vimdoc treesitter_query \
    treesitter_markdown/tree-sitter-markdown treesitter_markdown/tree-sitter-markdown-inline; do
  for f in "$DSRC/$d"/src/*.c; do
    $CC -Os -fno-pie -w -I"$DSRC/$d/src" -c "$f" -o "$PARSERS/$(echo "$d" | tr / _)-$(basename "$f" .c).o"
  done
done
$HOST-ar rcs "$DEPS/usr/lib/libnvimparsers.a" "$PARSERS"/*.o

# The code generators run the deps' Lua (a dynamic musl program that dlopens
# libnlua0.so, built with the same compiler): musl's libc.so is its loader
(cd "$SRC" &&
  printf '#!/bin/sh\nexec %s %s "$@"\n' "$MUSL_CROSS/$HOST/lib/libc.so" "$DEPS/usr/bin/lua" >"$DEPS/lua-gen" &&
  chmod +x "$DEPS/lua-gen" &&
  cmake -S . -B build -G Ninja -DLUA_PRG="$DEPS/lua-gen" -DLUA_GEN_PRG="$DEPS/lua-gen" -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr -DPREFER_LUA=ON \
    -DENABLE_LIBINTL=OFF -DENABLE_TRANSLATIONS=OFF -DCMAKE_C_FLAGS="-Os -fno-pie" "${STATIC[@]}" \
    -DDEPS_PREFIX="$DEPS/usr" -DICONV_INCLUDE_DIR="$MUSL_CROSS/$HOST/include" \
    -DLUA_MATH_LIBRARY="$MUSL_CROSS/$HOST/lib/libm.a" -DNVIM_STATIC_PARSERS_LIB="$DEPS/usr/lib/libnvimparsers.a" >configure.log 2>&1 &&
  cmake --build build >make.log 2>&1 &&
  DESTDIR="$SRC/stage" cmake --install build >install.log 2>&1) || {
  echo "neovim build failed in $SRC" >&2
  for f in configure.log make.log install.log; do [ -f "$SRC/$f" ] && tail -n 25 "$SRC/$f" >&2; done
  exit 1
}
rm -rf "$PKG_OUT/neovim"
install_bin "$SRC/stage/usr/bin/nvim" neovim/bin/nvim
mkdir -p "$PKG_OUT/neovim/share"
cp -r "$SRC/stage/usr/share/nvim" "$PKG_OUT/neovim/share/"
# No translations, desktop files or icons
rm -rf "$PKG_OUT/neovim/share/nvim/runtime/lang"
