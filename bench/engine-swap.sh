#!/bin/bash
# bench/engine-swap.sh <tree-ref> <emulator-ref> <host-ref>
# Measure x86 go_hello / go_nethttp (9 runs) on <tree-ref>'s build with Blink's
# emulator (public/engines/blink/blink.{wasm,mjs}) taken from <emulator-ref> and
# its Worker glue (host.mjs) from <host-ref>. Separates an engine regression
# from one in the kernel/net/page around it. <tree-ref> must already be built
# in bench/.cache/ab/<sha12> (bench/ab.mjs or a run with --src does that).
# Swaps the files in dist (the hashed copy from engines/manifest.json too):
# TABCOMPUTER_BLINK_ASSETS is read only under Node, so in the browser it has no effect.
cd "$(dirname "$0")/.."
P=bench/.cache
sha=$(git rev-parse --verify "$1^{commit}"); w=$(git rev-parse --verify "$2^{commit}"); hm=$(git rev-parse --verify "$3^{commit}"); d=bench/.cache/ab/${sha:0:12}
ov=bench/.cache/ov/m-${sha:0:7}-${w:0:7}-${hm:0:7}; rm -rf $ov; mkdir -p $ov; cp -r $d/dist $ov/dist
git show $w:public/engines/blink/blink.mjs > $ov/dist/engines/blink/blink.mjs
git show $w:public/engines/blink/blink.wasm > $ov/dist/engines/blink/blink.wasm
git show $hm:public/engines/blink/host.mjs > $ov/dist/engines/blink/host.mjs
for f in $ov/dist/engines/blink/blink.*.wasm; do [ -e "$f" ] && cp $ov/dist/engines/blink/blink.wasm $f; done
timeout 900 node bench/run.mjs --src $ov --no-build --no-docs --suites x86 --only 'go_nethttp$|go_hello$' --modes isolated --runs 9 --no-gh --quick --out $P/mp.json > /dev/null 2>&1
node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]));const g=n=>{const r=d.results.find(r=>r.name===n);return r?(r.median??("ERR "+(r.notes||"").slice(0,100))):"-"};console.log(process.argv[2], "go_hello", g("x86.blink.go_hello"), "go_nethttp", g("x86.blink.go_nethttp"))' $P/mp.json "tree ${sha:0:7} wasm ${w:0:7} host ${hm:0:7}"
rm -rf $ov
