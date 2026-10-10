#!/bin/bash
# Build Blink (https://github.com/jart/blink, ISC) to WebAssembly for Shiro.
#
# Output: public/engines/blink/blink.mjs + blink.wasm (committed, so a normal
# `npm run build` does not need emscripten). Re-run this after changing
# vendor/blink/patches/ or BLINK_COMMIT.
#
# Needs emsdk EMSCRIPTEN_VERSION (the version the committed blink.wasm was
# built with): set EMSDK=/path/to/emsdk (sourced for emcc), or have emcc on PATH.
#   git clone https://github.com/emscripten-core/emsdk /opt/emsdk
#   /opt/emsdk/emsdk install 6.0.12 && /opt/emsdk/emsdk activate 6.0.12
#   EMSDK=/opt/emsdk vendor/blink/build.sh
# Blink is built in BLINK_WORK (default ../blink-build next to the repo). It
# must be outside this repository: configure runs its probe programs with
# node, and the repo's package.json "type": "module" makes node load them as
# ES modules, so every probe fails (no threads) and the build breaks.
set -euo pipefail

BLINK_COMMIT=f006a4fc6f9b8de9272504fdff0dbbe5ce5dc580
EMSCRIPTEN_VERSION=6.0.12
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$ROOT/public/engines/blink"
WORK="${BLINK_WORK:-$(dirname "$ROOT")/blink-build}"
case "$(cd "$(dirname "$WORK")" && pwd)/$(basename "$WORK")/" in
  "$ROOT"/*) echo "build.sh: BLINK_WORK must be outside $ROOT (see the comment at the top)" >&2; exit 1 ;;
esac

if ! command -v emcc >/dev/null; then
  # shellcheck disable=SC1091
  source "${EMSDK:?set EMSDK or put emcc on PATH}/emsdk_env.sh" >/dev/null
fi
if ! emcc --version | head -1 | grep -q " $EMSCRIPTEN_VERSION "; then
  echo "build.sh: warning: emcc is not $EMSCRIPTEN_VERSION: $(emcc --version | head -1)" >&2
fi

if [ ! -d "$WORK/.git" ]; then
  git clone https://github.com/jart/blink.git "$WORK"
fi
cd "$WORK"
git fetch -q origin "$BLINK_COMMIT" 2>/dev/null || true
git checkout -q -f "$BLINK_COMMIT"
git clean -qfdx
for p in "$HERE"/patches/*.patch; do
  git -c user.email=build@shiro -c user.name=shiro am -q --keep-cr "$p"
done

CFLAGS="-O2" emconfigure ./configure >/dev/null
emmake make -j"$(nproc)" o//blink/blink.a o//blink/blink.o >/dev/null

mkdir -p "$OUT"
# PROXY_TO_PTHREAD: the guest's main thread runs in a pthread, so the module's
# own thread (the Worker started by host.mjs) stays free to service proxied
# syscalls and to block on the page for filesystem requests.
emcc -O2 o//blink/blink.o o//blink/blink.a -lm -pthread \
  -o "$OUT/blink.mjs" \
  -sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createBlink \
  -sENVIRONMENT=web,worker,node \
  -sPROXY_TO_PTHREAD -sEXIT_RUNTIME -sINVOKE_RUN=0 \
  -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=4GB \
  -sPTHREAD_POOL_SIZE=4 -sSTACK_SIZE=1MB -sALLOW_TABLE_GROWTH \
  -sEXPORTED_RUNTIME_METHODS=callMain,FS,ENV,HEAPU8 -sEXPORTED_FUNCTIONS=_main,_malloc \
  --js-library "$HERE/shiro-net.js" --js-library "$HERE/shiro-kernel.js" \
  --emit-symbol-map \
  -fno-builtin-exit 2> >(grep -v 'Wpthreads-mem-growth' >&2)
# wasm function index -> name, for engine stacks ("wasm-function[979]");
# kept with the sources, not served
mv "$OUT/blink.mjs.symbols" "$HERE/blink.symbols" 2>/dev/null || mv "$OUT"/*.symbols "$HERE/blink.symbols"

ls -la "$OUT"
