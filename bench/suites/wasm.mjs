// WASM programs: startup time and peak memory of real packages, a sqlite
// query, ripgrep over a 10k-file tree, and a CPU-bound loop against the
// same module in Node and native code.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MB } from '../lib/harness.mjs';
import { setupKbench } from './kernel.mjs';

export const name = 'wasm';
const BENCH = join(dirname(fileURLToPath(import.meta.url)), '..');

const PROGRAMS = [
  // [metric, package, command line (output goes to a file), needs threads (WASIX)]
  ['lua', 'lua', 'lua -e "print(1)"', false],
  ['sqlite3', 'sqlite', 'sqlite3 :memory: "select 1"', false],
  ['coreutils', 'coreutils', '/usr/bin/base64 --version', false],
  ['quickjs', 'quickjs', 'qjs -e "print(1)"', false],
  ['grep', 'grep', '/usr/bin/grep --version', true],
  ['ripgrep', 'ripgrep', '/usr/bin/rg --version', true],
  ['quickjs_ng', 'quickjs-ng', 'qjs-ng -e "print(1)"', true],
];

async function install(h, pkgs) {
  const r = await h.sh(`pkg install ${pkgs.join(' ')}`);
  if (r.code !== 0) h.log(`  pkg install: exit ${r.code} ${r.err.slice(-300)}`);
  return r;
}

/** Time `cmd > /tmp/bench.out` n times, sampling renderer RSS; returns { ms[], peak[] }. */
async function timedWithPeak(h, cmd, n) {
  const ms = [], peak = [];
  // First run compiles the module (kernel module cache); measured separately
  for (let i = 0; i < n; i++) {
    const r = await h.withPeakRss(() => h.sh(`${cmd} > /tmp/bench.out`));
    if (r.result.code !== 0) throw new Error(`exit ${r.result.code}: ${(r.result.err || r.result.out).slice(-200)}`);
    ms.push(r.result.ms);
    peak.push(r.peakDelta / MB);
  }
  return { ms, peak };
}

export async function run(h) {
  const n = h.runs;
  const threads = h.isolated; // WASIX packages import shared memory
  await install(h, PROGRAMS.filter((p) => (threads || !p[3]) && (!h.quick || ['lua', 'sqlite', 'ripgrep'].includes(p[1]))).map((p) => p[1]));

  for (const [metric, , cmd, needsThreads] of PROGRAMS) {
    const nm = `wasm.startup.${metric}`;
    if (!h.wants(nm)) continue;
    if (h.quick && !['lua', 'sqlite3', 'ripgrep'].includes(metric)) continue;
    if (needsThreads && !threads) { h.skip(nm, 'ms', 'WASIX: needs threads (SharedArrayBuffer)'); continue; }
    await h.try(nm, 'ms', async () => {
      // Cold: first run after install compiles the module
      const first = await h.withPeakRss(() => h.sh(`${cmd} > /tmp/bench.out`));
      if (first.result.code !== 0) throw new Error(`exit ${first.result.code}: ${(first.result.err || first.result.out).slice(-200)}`);
      const r = await timedWithPeak(h, cmd, n);
      h.sample(nm, r.ms, 'ms', { notes: `\`${cmd}\` through the shell, module cached; first run ${Math.round(first.result.ms)} ms` });
      h.sample(`wasm.peak_rss.${metric}`, r.peak, 'MiB', { notes: 'renderer RSS peak above the pre-run level (25 ms sampling)' });
    });
  }

  await h.try('wasm.sqlite.recursive_cte', 'ms', async () => {
    const q = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<300000) SELECT count(*), sum(x*x%7) FROM c;';
    const r = await timedWithPeak(h, `sqlite3 :memory: "${q}"`, n);
    const out = await h.sh('cat /tmp/bench.out');
    if (!/300000/.test(out.out)) throw new Error('unexpected sqlite output: ' + out.out.slice(0, 100));
    h.sample('wasm.sqlite.recursive_cte', r.ms, 'ms', { notes: '300k-row recursive CTE + aggregate, :memory:' });
    h.sample('wasm.peak_rss.sqlite_cte', r.peak, 'MiB', { notes: 'renderer RSS peak during the CTE' });
  });
  if (!h.quick) await h.try('wasm.sqlite.insert_10k_file', 'ms', async () => {
    const sql = "CREATE TABLE IF NOT EXISTS t(a INTEGER, b TEXT); DELETE FROM t; BEGIN; WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<10000) INSERT INTO t SELECT x, printf('row-%08d', x) FROM c; COMMIT; SELECT count(*) FROM t WHERE b LIKE '%7%';";
    const ms = [];
    for (let i = 0; i < n; i++) {
      const r = await h.sh(`sqlite3 /tmp/bench.db "${sql}" > /tmp/bench.out`);
      if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.err.slice(-200)}`);
      ms.push(r.ms);
    }
    h.sample('wasm.sqlite.insert_10k_file', ms, 'ms', { notes: '10k INSERTs in one transaction + LIKE scan, database file in /tmp (kernel file I/O)' });
  });

  // 10k-file tree for the recursive searches
  const files = h.quick ? 2000 : 10000;
  const treeReady = await h.try('wasm.tree', '', async () => {
    const t = await h.eval(async (files) => {
      const fs = window.__tabcomputer.fs;
      const root = `/tmp/bench-tree-${files}`;
      if (await fs.exists(root + '/d99/f' + (files / 100 - 1) + '.txt').catch(() => false)) return 0;
      const t0 = performance.now();
      for (let d = 0; d < 100; d++) {
        await fs.mkdir(`${root}/d${d}`, { recursive: true });
        const ps = [];
        for (let f = 0; f < files / 100; f++) {
          const body = `file ${d}/${f}\n` + 'lorem ipsum dolor sit amet\n'.repeat(5) + (f % 10 === 0 ? 'NEEDLE here\n' : 'nothing\n');
          ps.push(fs.writeFile(`${root}/d${d}/f${f}.txt`, body));
        }
        await Promise.all(ps);
      }
      return performance.now() - t0;
    }, files);
    if (t) h.sample('wasm.tree_create', [t], 'ms', { notes: `${files} files × ~160 B in 100 dirs via fs.writeFile (IndexedDB), one sample` });
  });
  const root = `/tmp/bench-tree-${files}`;
  const want = String(files / 10);
  if (threads) {
    await h.try('wasm.ripgrep.tree', 'ms', async () => {
      const r = await timedWithPeak(h, `/usr/bin/rg -l NEEDLE ${root}`, n);
      const c = await h.sh('wc -l < /tmp/bench.out');
      if (c.out.trim() !== want) throw new Error(`rg found ${c.out.trim()} files, want ${want}`);
      h.sample('wasm.ripgrep.tree', r.ms, 'ms', { notes: `\`rg -l NEEDLE\` over ${files} files (${want} match)` });
      h.sample('wasm.peak_rss.ripgrep_tree', r.peak, 'MiB', { notes: 'renderer RSS peak during the search' });
    });
  } else h.skip('wasm.ripgrep.tree', 'ms', 'WASIX: needs threads (SharedArrayBuffer)');
  await h.try('wasm.builtin_grep_r.tree', 'ms', async () => {
    const ms = [];
    for (let i = 0; i < n; i++) {
      const r = await h.sh(`grep -rl NEEDLE ${root} | wc -l`);
      if (r.out.trim() !== want) throw new Error(`grep -rl found ${r.out.trim()}, want ${want}`);
      ms.push(r.ms);
    }
    h.sample('wasm.builtin_grep_r.tree', ms, 'ms', { notes: `reference: Shiro's builtin \`grep -rl\` over the same ${files} files` });
  });

  // CPU-bound: the same kbench.wasm loop in Shiro, in Node, and native
  await h.try('wasm.cpu_loop', 'ms', async () => {
    await setupKbench(h);
    const N = 200_000_000;
    const shiro = await h.eval(async ([N, n]) => {
      const out = [];
      for (let i = 0; i < n; i++) {
        const r = await window.__bench.runProcs([['/home/user/b/kbench.wasm', 'cpu', String(N)]]);
        out.push(window.__bench.kv(r.out).ns / 1e6);
      }
      return out;
    }, [N, n]);
    const node = [];
    for (let i = 0; i < n; i++) node.push(runKbenchInNode(N));
    const native = nativeCpuLoop(N, n, h);
    const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
    h.sample('wasm.cpu_loop.shiro', shiro, 'ms', { notes: `kbench cpu ${N / 1e6}M as a Shiro process (guest clock)` });
    h.sample('wasm.cpu_loop.node', node, 'ms', { notes: 'same .wasm instantiated in Node (V8), same loop' });
    if (native) h.sample('wasm.cpu_loop.native', native, 'ms', { notes: 'same C loop, gcc -O2, native' });
    h.sample('wasm.cpu_loop.ratio_vs_node', [med(shiro) / med(node)], 'x', { notes: 'Shiro / Node median' });
  });
}

/** Instantiate kbench.wasm in this Node process with a minimal WASI and run `cpu N`; returns guest ms. */
function runKbenchInNode(N) {
  const bytes = readFileSync(join(BENCH, 'fixtures/kbench.wasm'));
  const args = ['kbench', 'cpu', String(N)].map((s) => Buffer.from(s + '\0'));
  let mem, out = '';
  const u8 = () => new Uint8Array(mem.buffer), dv = () => new DataView(mem.buffer);
  class Exit { constructor(c) { this.code = c; } }
  const wasi = {
    args_sizes_get: (c, s) => { dv().setUint32(c, args.length, true); dv().setUint32(s, args.reduce((a, b) => a + b.length, 0), true); return 0; },
    args_get: (argv, buf) => { let o = buf; args.forEach((a, i) => { dv().setUint32(argv + i * 4, o, true); u8().set(a, o); o += a.length; }); return 0; },
    clock_time_get: (_id, _p, t) => { dv().setBigUint64(t, process.hrtime.bigint(), true); return 0; },
    fd_write: (fd, iov, n, nw) => { let t = 0; for (let i = 0; i < n; i++) { const p = dv().getUint32(iov + i * 8, true), l = dv().getUint32(iov + i * 8 + 4, true); out += Buffer.from(u8().subarray(p, p + l)).toString(); t += l; } dv().setUint32(nw, t, true); return 0; },
    proc_exit: (c) => { throw new Exit(c); },
  };
  const stub = new Proxy(wasi, { get: (t, k) => t[k] || (() => 52) });
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { wasi_snapshot_preview1: stub });
  mem = inst.exports.memory;
  try { inst.exports._start(); } catch (e) { if (!(e instanceof Exit)) throw e; }
  const ns = Number(/ns=(\d+)/.exec(out)[1]);
  return ns / 1e6;
}

function nativeCpuLoop(N, n, h) {
  const dir = join(BENCH, '.cache', 'fixtures');
  const bin = join(dir, 'cpuloop-native');
  try {
    if (!existsSync(bin)) {
      mkdirSync(dir, { recursive: true });
      const src = join(dir, 'cpuloop-native.c');
      writeFileSync(src, `#include <stdio.h>
#include <stdlib.h>
#include <time.h>
int main(int c, char **v) { unsigned long long n = strtoull(v[1], 0, 10); struct timespec a, b;
  clock_gettime(CLOCK_MONOTONIC, &a); unsigned h = 2166136261u;
  for (unsigned long long i = 0; i < n; i++) { h ^= (unsigned)i; h *= 16777619u; h ^= h >> 13; }
  clock_gettime(CLOCK_MONOTONIC, &b);
  printf("hash=%u\\nns=%lld\\n", h, (long long)(b.tv_sec - a.tv_sec) * 1000000000LL + (b.tv_nsec - a.tv_nsec)); return 0; }
`);
      execFileSync('gcc', ['-O2', '-o', bin, src]);
    }
    const out = [];
    for (let i = 0; i < n; i++) out.push(Number(/ns=(\d+)/.exec(execFileSync(bin, [String(N)], { encoding: 'utf8' }))[1]) / 1e6);
    return out;
  } catch (e) { h.log(`  native loop: ${e.message.split('\n')[0]}`); return null; }
}
