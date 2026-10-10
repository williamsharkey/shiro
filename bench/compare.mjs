#!/usr/bin/env node
// Diff two benchmark result files; flag only regressions that are real.
//   node bench/compare.mjs base.json new.json [--threshold 10] [--all]
//        [--ab ab.json | --no-confirm] [--rounds 5] [--assume-same-machine]
//
// 1. Same machine or nothing: results recorded on different machines (see
//    lib/machine.mjs; BENCH_MACHINE labels one) are listed for information
//    and never flagged, since a different CPU or a busier host moves every
//    metric.
// 2. Candidates: metrics whose median got worse by more than the threshold
//    (percent of the base median, in the metric's bad direction; ≥ 3 samples
//    on both sides), and metrics that broke (measured in base, failing now).
// 3. A/B-confirmed: candidates are re-measured with bench/ab.mjs, base
//    commit vs new commit interleaved on this machine, only those metrics
//    (--ab FILE reuses an ab.json instead). A candidate is a regression only
//    when the A/B calls it `regressed` (or, for a broken metric, the new side
//    still produces no samples).
//
// Exit 1 only for confirmed regressions. Exit 0 when the machines differ,
// when there are no candidates, with --no-confirm, or when the commits can't
// be built here (each case says so). Exit 2 on bad usage.
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { machineOf } from './lib/machine.mjs';

const BENCH = dirname(fileURLToPath(import.meta.url));
const ROOT = join(BENCH, '..');

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const valued = new Set(['--threshold', '--ab', '--rounds']);
const files = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1]));
const threshold = Number(opt('--threshold') ?? 10);
const rounds = Number(opt('--rounds') ?? 5);
const abFile = opt('--ab');
const showAll = argv.includes('--all');
const noConfirm = argv.includes('--no-confirm');
const assumeSame = argv.includes('--assume-same-machine');
if (files.length !== 2) {
  console.error('usage: node bench/compare.mjs <base.json> <new.json> [--threshold PCT] [--all] [--ab ab.json | --no-confirm] [--rounds N] [--assume-same-machine]');
  process.exit(2);
}
const [base, next] = files.map((f) => JSON.parse(readFileSync(f, 'utf8')));

// Units where bigger is better; everything else (ms, MiB, counts) is smaller-is-better
const HIGHER_BETTER = new Set(['MB/s', 'proc/s', 'ops/s']);
const key = (r) => `${r.mode}:${r.name}`;
const baseMap = new Map(base.results.map((r) => [key(r), r]));
const rows = [];
for (const r of next.results) {
  const b = baseMap.get(key(r));
  baseMap.delete(key(r));
  if (!b) { rows.push({ status: 'new', r }); continue; }
  if (b.median == null || r.median == null) {
    const status = b.median == null && r.median != null ? 'fixed' : b.median != null && r.median == null ? 'broken?' : 'n/a';
    rows.push({ status, r, b });
    continue;
  }
  const higher = HIGHER_BETTER.has(r.unit);
  const pct = b.median === 0 ? (r.median === 0 ? 0 : Infinity) : ((r.median - b.median) / Math.abs(b.median)) * 100;
  const worse = higher ? -pct : pct;
  const reliable = (b.n ?? 0) >= 3 && (r.n ?? 0) >= 3;
  // Ignore sub-noise absolute changes on tiny values (0 → 0.1 MiB etc.)
  // MiB: RSS peaks are sampled every 25 ms and sub-MiB swings are noise
  const tiny = Math.abs(r.median - b.median) < (r.unit === 'ms' ? 0.5 : r.unit === 'count' ? 1 : r.unit === 'MiB' ? 1 : 0.05);
  let status = 'same';
  if (worse > threshold && !tiny) status = reliable ? 'candidate' : 'worse?';
  else if (worse < -threshold && !tiny) status = 'improved';
  rows.push({ status, r, b, pct });
}
for (const b of baseMap.values()) rows.push({ status: 'gone', r: { ...b, median: null }, b });

const mBase = machineOf(base.env), mNew = machineOf(next.env);
const sameMachine = assumeSame || mBase.id === mNew.id;
console.log(`base ${base.env.git.short} (${base.env.date.slice(0, 10)}${base.env.quick ? ', quick' : ''})  →  new ${next.env.git.short}${next.env.git.dirty ? '+dirty' : ''} (${next.env.date.slice(0, 10)}${next.env.quick ? ', quick' : ''}), threshold ${threshold}%`);
console.log(`machine: ${sameMachine ? `same (${mNew.label})` : `DIFFERENT\n  base: ${mBase.label}\n  new:  ${mNew.label}`}`);
if (!!base.env.quick !== !!next.env.quick) console.log('note: one run is --quick and the other is not; some metrics use different sizes');

const candidates = rows.filter((x) => x.status === 'candidate' || x.status === 'broken?');
let confirmed = new Map(); // key → reason
const inconclusive = new Set(); // candidates the A/B produced no comparison for
let verdict = null; // why nothing could be flagged, if so
if (!sameMachine) verdict = 'different machines: informational only, nothing flagged';
else if (!candidates.length) verdict = 'no candidates';
else if (noConfirm) verdict = '--no-confirm: candidates not A/B-confirmed, nothing flagged';
else {
  const ab = abFile ? JSON.parse(readFileSync(abFile, 'utf8')) : runAb(candidates);
  if (typeof ab === 'string') verdict = ab;
  else {
    const abRows = new Map(ab.rows.map((x) => [x.metric, x]));
    for (const c of candidates) {
      const a = abRows.get(key(c.r));
      // A side without samples (a suite failed on that build) decides nothing
      if (!a || (c.status === 'candidate' && ['new', 'gone', 'n/a'].includes(a.status))) { inconclusive.add(key(c.r)); continue; }
      if (c.status === 'candidate' && a.status === 'regressed') confirmed.set(key(c.r), a.ci ? `A/B ${fmtPct(a.shiftPct)}, CI ${fmtPct(a.ci[0])}…${fmtPct(a.ci[1])}, rounds ${a.rounds}` : `A/B exact ${fmtPct(a.shiftPct)}`);
      if (c.status === 'broken?' && (a.status === 'gone' || (a.nNew === 0 && a.nBase > 0))) confirmed.set(key(c.r), 'A/B: still no samples on the new commit');
    }
  }
}

for (const x of rows) {
  if (confirmed.has(key(x.r))) { x.status = 'REGRESSED'; x.why = confirmed.get(key(x.r)); }
  else if (inconclusive.has(key(x.r))) { x.status = 'unconfirmed'; x.why = 'A/B had no samples on one side'; }
  else if (x.status === 'candidate') x.status = sameMachine && !verdict ? 'noise' : 'candidate';
  else if (x.status === 'broken?' && sameMachine && !verdict) x.status = 'flaky';
}
const order = { REGRESSED: 0, unconfirmed: 1, candidate: 1, 'broken?': 2, noise: 3, flaky: 3, 'worse?': 4, improved: 5, fixed: 6, new: 7, gone: 8, same: 9, 'n/a': 10 };
rows.sort((x, y) => order[x.status] - order[y.status] || key(x.r).localeCompare(key(y.r)));
console.log('');
const fmt = (x) => (x == null ? '—' : String(x));
for (const { status, r, b, pct, why } of rows) {
  if (!showAll && (status === 'same' || status === 'n/a')) continue;
  const change = pct == null ? '' : `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
  console.log(`${status.padEnd(10)} ${key(r).padEnd(52)} ${fmt(b?.median).padStart(10)} → ${fmt(r.median).padEnd(10)} ${r.unit.padEnd(6)} ${change}${why ? '  ' + why : ''}`);
}
const counts = rows.reduce((a, x) => ((a[x.status] = (a[x.status] || 0) + 1), a), {});
console.log('\n' + Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', '));
if (verdict) console.log(verdict);
if (inconclusive.size) console.log(`A/B inconclusive for ${inconclusive.size} candidate(s): one side produced no samples (a suite failed on that build; see the raw runs ab.mjs printed). Not flagged, not cleared.`);
console.log(confirmed.size ? `${confirmed.size} A/B-confirmed regression(s)` : 'no confirmed regressions');
process.exit(confirmed.size ? 1 : 0);

function fmtPct(v) { return v == null || !Number.isFinite(v) ? '?' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`; }

/** Run ab.mjs on just the candidates; returns its JSON, or a string saying why it couldn't. */
function runAb(cands) {
  const git = (...a) => { try { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  const ref = (env, side) => {
    const sha = env.git?.sha;
    if (!sha || git('cat-file', '-e', `${sha}^{commit}`) === null) return { err: `${side} commit ${env.git?.short ?? '?'} is not in this repository` };
    if (env.git.dirty) {
      // Only the working tree can stand for a dirty run, and only if it is that commit
      if (side === 'new' && git('rev-parse', 'HEAD') === sha) return { ref: '.' };
      return { err: `${side} run was from a dirty tree (${env.git.short}+dirty); A/B needs commits` };
    }
    return { ref: sha };
  };
  const b = ref(base.env, 'base'), n = ref(next.env, 'new');
  if (b.err || n.err) return `cannot confirm: ${b.err || n.err}; candidates not flagged (re-run with commits, or pass --ab)`;
  if (n.ref !== '.' && b.ref === n.ref) return 'cannot confirm: both runs are the same commit, so every candidate is noise';
  const suiteOf = (r) => r.suite || ({ node: 'node', npm: 'node', claude: 'node', workload: 'workloads' })[r.name.split('.')[0]] || r.name.split('.')[0];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const suites = [...new Set(cands.map((c) => suiteOf(c.r)))];
  const modes = [...new Set(cands.map((c) => c.r.mode))];
  // Suites gate whole groups with h.try(group) / h.wants(group) (kernel.spawn_throughput
  // records .builtin and .wasm), so match the metric and each dotted parent of it
  const names = new Set();
  for (const c of cands) {
    const parts = c.r.name.split('.');
    for (let i = 2; i <= parts.length; i++) names.add(parts.slice(0, i).join('.'));
  }
  const only = [...names].map((n) => `^${esc(n)}$`).join('|');
  const dir = join(BENCH, '.cache', 'ab', 'compare');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `ab-${Date.now()}.json`);
  const args = [join(BENCH, 'ab.mjs'), b.ref, ...(n.ref === '.' ? [] : [n.ref]), '--rounds', String(rounds), '--runs', String(next.env.runs || 5),
    '--suites', suites.join(','), '--modes', modes.join(','), '--only', only, '--out', out];
  if (next.env.quick) args.push('--quick');
  console.log(`\nconfirming ${cands.length} candidate(s) with an A/B on this machine:\n  node ${args.map((a) => (/[|^$ ]/.test(a) ? `'${a}'` : a)).join(' ').replace(ROOT + '/', '')}\n`);
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  if (!existsSync(out)) return `cannot confirm: the A/B run failed (exit ${r.status}); candidates not flagged`;
  return JSON.parse(readFileSync(out, 'utf8'));
}
