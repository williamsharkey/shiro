// Toolchain layers (opt-in: --suites toolchains; docs/DEBIAN.md "Toolchain
// layers"): from a fresh profile, `debian install`, `toolchain install ID`,
// then the first real use (compile and run hello world, import a module,
// typeset a page) and a warm second use. Layers come from
// TABCOMPUTER_DEBIAN_LAYERS (default .toolchain-build/layers, built by
// scripts/debian/build-layers.sh); without them every metric is skipped.
//
// BENCH_TOOLCHAINS=c,python picks sets (default: all). BENCH_TOOLCHAIN_APT=1
// also times the same sets installed with apt (`toolchain install --apt`,
// minutes each), the path layers replace.
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MB } from '../lib/harness.mjs';

export const name = 'toolchains';
export const ownPages = true;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const GO_HTTP = `package main

import (
\t"fmt"
\t"io"
\t"net"
\t"net/http"
)

func main() {
\tln, err := net.Listen("tcp", "127.0.0.1:0")
\tif err != nil {
\t\tpanic(err)
\t}
\tgo http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "ok from net/http") }))
\tres, err := http.Get("http://" + ln.Addr().String() + "/")
\tif err != nil {
\t\tpanic(err)
\t}
\tb, _ := io.ReadAll(res.Body)
\tfmt.Println(string(b))
}
`;

const USE = {
  c: { cmd: "printf '#include <stdio.h>\\nint main(void){puts(\"hello\");return 0;}\\n' > /tmp/hello.c && cd /tmp && gcc hello.c && ./a.out", ok: /^hello$/m, what: '`gcc hello.c && ./a.out`' },
  python: { cmd: "python3 -c 'import json; print(json.dumps([1]))'", ok: /^\[1\]$/m, what: "`python3 -c 'import json; ...'`" },
  node: { cmd: "/usr/bin/node -e 'console.log(6*7)'", ok: /42/, what: "`/usr/bin/node -e` (Debian's nodejs)" },
  java: { cmd: "printf 'class Hello { public static void main(String[] a) { System.out.println(\"hello\"); } }\\n' > /tmp/Hello.java && cd /tmp && javac Hello.java && java Hello", ok: /^hello$/m, what: '`javac Hello.java && java Hello`' },
  classic: { cmd: "printf 'program h\\nprint *, \"hello\"\\nend program h\\n' > /tmp/h.f90 && cd /tmp && gfortran h.f90 -o hf && ./hf", ok: /hello/, what: '`gfortran h.f90 && ./hf`' },
  go: {
    cmd: "printf 'package main\\nimport \"fmt\"\\nfunc main(){fmt.Println(\"hello\")}\\n' > /tmp/hello.go && cd /tmp && go run hello.go", ok: /^hello$/m, what: '`go run hello.go`',
    // net/http server and client in one program, over loopback
    extra: { name: 'nethttp', cmd: `echo ${Buffer.from(GO_HTTP).toString('base64')} | base64 -d > /tmp/srv.go && cd /tmp && go build -o srv srv.go && ./srv`, ok: /ok from net\/http/, what: "`go build` and run of a net/http server + client over loopback (`go run` of it hangs when its output is the shell's, see docs/COMPAT.md)" },
  },
  tex: { cmd: "printf '\\\\documentclass{article}\\\\begin{document}Hello, \\\\LaTeX.\\\\end{document}\\n' > /tmp/t.tex && cd /tmp && pdflatex -interaction=nonstopmode t.tex && test -s t.pdf && echo pdf-ok", ok: /pdf-ok/, what: '`pdflatex` on a one-line article' },
};

async function timed(h, cmd, limitS, check) {
  const r = await h.withPeakRss(() => h.eval(([c, ms]) => window.__bench.shLimit(c, ms), [`${cmd} > /tmp/tc.out 2>&1`, limitS * 1000]));
  const out = (await h.sh('cat /tmp/tc.out')).out;
  if (r.result.code !== 0 || (check && !check.test(out))) {
    throw new Error(`${cmd.slice(0, 60)}: ${r.result.code === 124 ? `timed out after ${limitS} s` : `exit ${r.result.code}`}: ${out.trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`);
  }
  return { ms: r.result.ms, peak: r.peakDelta / MB, out };
}

export async function run(h) {
  if (!h.isolated) { h.skip('workload.toolchain.suite', '', 'Debian needs a cross-origin isolated page (Blink)'); return; }
  const dir = process.env.TABCOMPUTER_DEBIAN_LAYERS || join(ROOT, '.toolchain-build', 'layers');
  if (!existsSync(join(dir, 'index.json'))) { h.skip('workload.toolchain.suite', '', `no layers in ${dir} (scripts/debian/build-layers.sh)`); return; }
  const ids = (process.env.BENCH_TOOLCHAINS || Object.keys(USE).join(',')).split(',').filter((id) => USE[id]);
  const rounds = h.quick ? 1 : Math.min(h.runs, 2);
  const modes = process.env.BENCH_TOOLCHAIN_APT === '1' ? ['layer', 'apt'] : ['layer'];

  for (const id of ids) {
    const use = USE[id];
    for (const mode of modes) {
      const R = {};
      const add = (k, v) => (R[k] ??= []).push(v);
      for (let i = 0; i < (mode === 'apt' ? 1 : rounds); i++) {
        await h.page?.context().close().catch(() => {});
        await h.boot({ path: '/?ui=terminal' });
        try {
          const deb = await timed(h, 'debian install', 300);
          const inst = await timed(h, `toolchain install ${id}${mode === 'apt' ? ' --apt' : ''}`, mode === 'apt' ? 3600 : 600);
          const first = await timed(h, use.cmd, 1200, use.ok);
          const warm = await timed(h, use.cmd, 1200, use.ok);
          add('install', inst.ms); add('install_peak', inst.peak);
          add('first', first.ms); add('first_peak', first.peak);
          add('warm', warm.ms);
          if (use.extra) { const x = await timed(h, use.extra.cmd, 1800, use.extra.ok); add('extra', x.ms); add('extra_peak', x.peak); }
          add('to_working', deb.ms + inst.ms + first.ms);
          add('storage', (await h.eval(async () => (await navigator.storage.estimate()).usage)) / MB);
        } catch (e) {
          h.skip(`workload.toolchain.${id}.${mode}`, '', `round ${i + 1} failed: ${String(e.message).slice(0, 300)}`);
        }
      }
      const p = mode === 'apt' ? `workload.toolchain_apt.${id}` : `workload.toolchain.${id}`;
      const how = mode === 'apt' ? `\`toolchain install ${id} --apt\` (apt-get update + install in Blink, packages from the mirror cache)` : `\`toolchain install ${id}\` (prebuilt layer: placeholders + dpkg database)`;
      const S = (n, key, unit, notes) => { if (R[key]?.length) h.sample(`${p}.${n}`, R[key], unit, { notes }); };
      S('to_working', 'to_working', 'ms', `fresh profile: \`debian install\` + ${how} + first ${use.what}`);
      S('install', 'install', 'ms', how);
      S('first_use', 'first', 'ms', `first ${use.what} after the install (fetches the programs' chunks)`);
      S('warm', 'warm', 'ms', `second ${use.what}`);
      if (use.extra) {
        S(use.extra.name, 'extra', 'ms', `then ${use.extra.what}`);
        S(`peak_rss_${use.extra.name}`, 'extra_peak', 'MiB', `renderer RSS peak above the pre-run level, ${use.extra.name}`);
      }
      S('peak_rss_install', 'install_peak', 'MiB', 'renderer RSS peak above the pre-run level, install');
      S('peak_rss_first_use', 'first_peak', 'MiB', 'renderer RSS peak above the pre-run level, first use');
      S('storage', 'storage', 'MiB', 'navigator.storage.estimate().usage at the end');
    }
  }
}
