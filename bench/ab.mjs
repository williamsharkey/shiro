#!/usr/bin/env node
// A/B two builds with interleaved runs and a significance test.
//   node bench/ab.mjs <base-ref> [<new-ref>] [--rounds 3] [--runs 5] [--suites a,b] [--only re,re]
//                     [--modes isolated] [--quick] [--alpha 0.01] [--min-effect 3] [--out file.json]
// <new-ref> defaults to the working tree as it is (uncommitted changes included).
// Each ref is checked out once per commit in bench/.cache/ab/<sha> and built
// there (cached); every round runs both sides with this checkout's harness,
// alternating which goes first. See bench/README.md ("A/B").
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH = dirname(fileURLToPath(import.meta.url));
const ROOT = join(BENCH, '..');
const AB = join(BENCH, '.cache', 'ab');
const HIGHER_BETTER = new Set(['MB/s', 'proc/s', 'ops/s']);

function parseArgs(argv) {
  const a = { refs: [], rounds: 3, runs: 5, suites: null, only: null, modes: 'isolated', quick: false, alpha: 0.01, minEffect: 3, out: null, build: true, gh: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = () => argv[++i];
    if (k === '--rounds') a.rounds = Number(v());
    else if (k === '--runs') a.runs = Number(v());
    else if (k === '--suites') a.suites = v();
    else if (k === '--only') a.only = v();
    else if (k === '--modes') a.modes = v();
    else if (k === '--quick') a.quick = true;
    else if (k === '--alpha') a.alpha = Number(v());
    else if (k === '--min-effect') a.minEffect = Number(v());
    else if (k === '--out') a.out = v();
    else if (k === '--no-build') a.build = false;
    else if (k === '--gh') a.gh = true;
    else if (k.startsWith('-')) throw new Error(`unknown option ${k}`);
    else a.refs.push(k);
  }
  if (a.refs.length < 1 || a.refs.length > 2) {
    console.error('usage: node bench/ab.mjs <base-ref> [<new-ref>] [--rounds N] [--runs N] [--suites ..] [--only ..] [--modes ..] [--quick]');
    process.exit(2);
  }
  return a;
}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

/** { label, sha, dir } for a ref; '.' (or omitted) is the working tree itself. */
function prepare(ref, build, log) {
  if (ref === '.') {
    const sha = git('rev-parse', 'HEAD');
    const dirty = !!git('status', '--porcelain', '--', 'src', 'index.html', 'vite.config.ts', 'server.mjs', 'public');
    if (build) { log(`[ab] building the working tree`); viteBuild(ROOT); }
    return { label: `worktree (${sha.slice(0, 9)}${dirty ? '+dirty' : ''})`, sha, dir: ROOT };
  }
  const sha = git('rev-parse', '--verify', `${ref}^{commit}`);
  const dir = join(AB, sha.slice(0, 12));
  if (!existsSync(join(dir, '.git'))) {
    log(`[ab] checking out ${ref} (${sha.slice(0, 9)}) in ${relative(ROOT, dir)}`);
    mkdirSync(AB, { recursive: true });
    git('worktree', 'add', '--detach', '--force', dir, sha);
  }
  // Dependencies come from this checkout (same lockfile in practice; a ref
  // with different deps needs its own npm ci in that directory)
  if (!existsSync(join(dir, 'node_modules'))) symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
  if (!existsSync(join(dir, 'dist', 'index.html'))) { log(`[ab] building ${ref}`); viteBuild(dir); }
  return { label: `${ref} (${sha.slice(0, 9)})`, sha, dir };
}

function viteBuild(dir) {
  const r = spawnSync('npx', ['vite', 'build', '--logLevel', 'error'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`vite build in ${dir} failed:\n${(r.stdout + r.stderr).slice(-3000)}`);
}

function runOnce(side, a, out, log) {
  const args = [join(BENCH, 'run.mjs'), '--src', side.dir, '--no-build', '--no-docs', '--runs', String(a.runs), '--modes', a.modes, '--out', out];
  if (a.quick) args.push('--quick');
  if (a.suites) args.push('--suites', a.suites);
  if (a.only) args.push('--only', a.only);
  if (!a.gh) args.push('--no-gh');
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`bench run for ${side.label} failed:\n${(r.stdout + r.stderr).slice(-2000)}`);
  log(`[ab]   ${side.label}: ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return JSON.parse(readFileSync(out, 'utf8'));
}

// ── statistics ───────────────────────────────────────────────────────

const median = (xs) => { const s = [...xs].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };

function normalCdf(z) {
  // Abramowitz–Stegun 7.1.26 erf approximation (|error| < 1.5e-7)
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Two-sided Mann–Whitney U p-value: exact by enumeration for small samples without ties, else normal approximation with tie and continuity correction. */
export function mannWhitney(x, y) {
  const n1 = x.length, n2 = y.length;
  if (!n1 || !n2) return 1;
  const all = [...x.map((v) => [v, 0]), ...y.map((v) => [v, 1])].sort((p, q) => p[0] - q[0]);
  const ranks = new Array(all.length);
  let tie = 0;
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = r;
    const t = j - i + 1;
    tie += t ** 3 - t;
    i = j + 1;
  }
  let r1 = 0;
  all.forEach((p, i) => { if (p[1] === 0) r1 += ranks[i]; });
  const u1 = r1 - (n1 * (n1 + 1)) / 2;
  const u = Math.min(u1, n1 * n2 - u1);
  if (tie === 0 && n1 + n2 <= 30) {
    // Exact null distribution of U: f(a, b, k) = f(a-1, b, k-b) + f(a, b-1, k)
    const memo = new Map();
    const f = (a, b, k) => {
      if (k < 0) return 0;
      if (a === 0 || b === 0) return k === 0 ? 1 : 0;
      const key = `${a},${b},${k}`;
      let v = memo.get(key);
      if (v === undefined) { v = f(a - 1, b, k - b) + f(a, b - 1, k); memo.set(key, v); }
      return v;
    };
    let le = 0, total = 0;
    for (let k = 0; k <= n1 * n2; k++) { const c = f(n1, n2, k); total += c; if (k <= u) le += c; }
    return Math.min(1, (2 * le) / total);
  }
  const mu = (n1 * n2) / 2;
  const sigma = Math.sqrt((n1 * n2 / 12) * ((n1 + n2 + 1) - tie / ((n1 + n2) * (n1 + n2 - 1))));
  if (sigma === 0) return 1;
  const z = (Math.abs(u - mu) - 0.5) / sigma;
  return Math.min(1, 2 * (1 - normalCdf(Math.max(0, z))));
}

/** Hodges–Lehmann shift: median of all pairwise new − base differences. */
const hlShift = (base, next) => median(base.flatMap((b) => next.map((n) => n - b)));

const fmt = (v) => (v == null || Number.isNaN(v) ? '—' : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(2));

/**
 * Per metric: medians, HL shift (% of the base median, in the bad direction),
 * Mann–Whitney p over all rounds, and whether every round moved the same way.
 * A metric is flagged only when p < alpha, every round agrees, and the shift
 * is at least minEffect percent. Metrics whose samples are all identical on
 * each side are compared exactly.
 */
export function analyze(rounds, { alpha, minEffect }) {
  const keys = new Map();
  for (const [ri, rd] of rounds.entries()) {
    for (const side of ['base', 'new']) {
      for (const r of rd[side].results) {
        const k = `${r.mode}:${r.name}`;
        if (!keys.has(k)) keys.set(k, { key: k, unit: r.unit, base: [], new: [], perRound: [] });
        const m = keys.get(k);
        const xs = (r.samples ?? []).filter((v) => typeof v === 'number' && Number.isFinite(v));
        m[side].push(...xs);
        (m.perRound[ri] ??= { base: [], new: [] })[side].push(...xs);
      }
    }
  }
  const rows = [];
  for (const m of keys.values()) {
    const higher = HIGHER_BETTER.has(m.unit);
    const bMed = median(m.base), nMed = median(m.new);
    const row = { metric: m.key, unit: m.unit, base: bMed, new: nMed, nBase: m.base.length, nNew: m.new.length };
    if (!m.base.length || !m.new.length) { row.status = !m.base.length && !m.new.length ? 'n/a' : m.new.length ? 'new' : 'gone'; rows.push(row); continue; }
    const constant = (xs) => xs.every((v) => v === xs[0]);
    if (constant(m.base) && constant(m.new)) {
      row.exact = true;
      row.delta = nMed - bMed;
      row.status = row.delta === 0 ? 'same' : (higher ? row.delta < 0 : row.delta > 0) ? 'regressed' : 'improved';
      rows.push(row);
      continue;
    }
    const shift = hlShift(m.base, m.new);
    const pct = bMed === 0 ? (shift === 0 ? 0 : Infinity * Math.sign(shift)) : (shift / Math.abs(bMed)) * 100;
    const worsePct = higher ? -pct : pct;
    const dirs = m.perRound.filter(Boolean).map((p) => Math.sign(median(p.new) - median(p.base)));
    const consistent = dirs.length > 0 && dirs.every((d) => d !== 0 && d === dirs[0]);
    const p = mannWhitney(m.base, m.new);
    Object.assign(row, { shiftPct: worsePct, p, rounds: dirs.map((d) => (d > 0 ? '+' : d < 0 ? '-' : '=')).join('') });
    if (p < alpha && consistent && Math.abs(worsePct) >= minEffect) row.status = worsePct > 0 ? 'regressed' : 'improved';
    else if (p < alpha && Math.abs(worsePct) >= minEffect) row.status = 'inconsistent';
    else row.status = 'same';
    rows.push(row);
  }
  return rows;
}

function report(rows, a, sides, log) {
  const order = { regressed: 0, inconsistent: 1, improved: 2, new: 3, gone: 3, same: 4, 'n/a': 5 };
  rows.sort((x, y) => order[x.status] - order[y.status] || x.metric.localeCompare(y.metric));
  log(`\n[ab] ${sides.base.label} → ${sides.new.label}; ${a.rounds} rounds × ${a.runs} runs, alpha ${a.alpha}, min effect ${a.minEffect}%`);
  log('     shift = Hodges–Lehmann estimate, + is worse; rounds = direction of new vs base per round');
  for (const r of rows) {
    if (r.status === 'same' && !process.env.AB_ALL) continue;
    const head = `${r.status.padEnd(12)} ${r.metric.padEnd(48)} ${fmt(r.base).padStart(8)} → ${fmt(r.new).padStart(8)} ${(r.unit || '').padEnd(6)}`;
    if (r.exact) log(`${head} exact (Δ ${fmt(r.delta)})`);
    else if (r.p != null) log(`${head} shift ${(r.shiftPct >= 0 ? '+' : '') + fmt(r.shiftPct)}%  p=${r.p.toPrecision(2)}  rounds ${r.rounds}  n=${r.nBase}/${r.nNew}`);
    else log(head);
  }
  const counts = {};
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  log(`\n[ab] ${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', ')}${process.env.AB_ALL ? '' : ' (AB_ALL=1 lists the unchanged ones)'}`);
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const log = (s) => console.log(s);
  const sides = { base: prepare(a.refs[0], a.build, log), new: prepare(a.refs[1] ?? '.', a.build, log) };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(AB, 'runs', stamp);
  mkdirSync(runDir, { recursive: true });
  const rounds = [];
  for (let i = 0; i < a.rounds; i++) {
    log(`[ab] round ${i + 1}/${a.rounds}`);
    const order = i % 2 === 0 ? ['base', 'new'] : ['new', 'base'];
    const rd = {};
    for (const s of order) rd[s] = runOnce(sides[s], a, join(runDir, `r${i + 1}-${s}.json`), log);
    rounds.push(rd);
  }
  const rows = analyze(rounds, a);
  report(rows, a, sides, log);
  const out = a.out || join(runDir, 'ab.json');
  writeFileSync(out, JSON.stringify({ base: sides.base, new: sides.new, options: a, rows }, null, 1) + '\n');
  log(`[ab] wrote ${relative(ROOT, out)} (raw runs in ${relative(ROOT, runDir)})`);
  process.exit(rows.some((r) => r.status === 'regressed') ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.stack || e); process.exit(2); });
