#!/usr/bin/env node
// Diff two benchmark result files and flag regressions.
//   node bench/compare.mjs base.json new.json [--threshold 10] [--all]
// Exits 1 when any metric regressed by more than the threshold (percent of
// the base median, in the metric's bad direction). Metrics with fewer than
// 3 samples on either side are reported but never fail the comparison.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--') && !/^\d+(\.\d+)?$/.test(a));
const ti = args.indexOf('--threshold');
const threshold = ti >= 0 ? Number(args[ti + 1]) : 10;
const showAll = args.includes('--all');
if (files.length !== 2) {
  console.error('usage: node bench/compare.mjs <base.json> <new.json> [--threshold PCT] [--all]');
  process.exit(2);
}
const [base, next] = files.map((f) => JSON.parse(readFileSync(f, 'utf8')));

// Units where bigger is better; everything else (ms, MiB, counts) is smaller-is-better
const HIGHER_BETTER = new Set(['MB/s', 'proc/s', 'ops/s']);
const key = (r) => `${r.mode}:${r.name}`;
const baseMap = new Map(base.results.map((r) => [key(r), r]));
const rows = [];
let regressions = 0;
for (const r of next.results) {
  const b = baseMap.get(key(r));
  baseMap.delete(key(r));
  if (!b) { rows.push({ status: 'new', r }); continue; }
  if (b.median == null || r.median == null) {
    const status = b.median == null && r.median != null ? 'fixed' : b.median != null && r.median == null ? 'broken' : 'n/a';
    if (status === 'broken') regressions++;
    rows.push({ status, r, b });
    continue;
  }
  const higher = HIGHER_BETTER.has(r.unit);
  const pct = b.median === 0 ? (r.median === 0 ? 0 : Infinity) : ((r.median - b.median) / Math.abs(b.median)) * 100;
  const worse = higher ? -pct : pct;
  const reliable = (b.n ?? 0) >= 3 && (r.n ?? 0) >= 3;
  // Ignore sub-noise absolute changes on tiny values (0 → 0.1 MiB etc.)
  const tiny = Math.abs(r.median - b.median) < (r.unit === 'ms' ? 0.5 : r.unit === 'count' ? 1 : 0.05);
  let status = 'same';
  if (worse > threshold && !tiny) status = reliable ? 'REGRESSED' : 'worse?';
  else if (worse < -threshold && !tiny) status = 'improved';
  if (status === 'REGRESSED') regressions++;
  rows.push({ status, r, b, pct });
}
for (const b of baseMap.values()) rows.push({ status: 'gone', r: b });

const order = { REGRESSED: 0, broken: 1, 'worse?': 2, improved: 3, fixed: 4, new: 5, gone: 6, same: 7, 'n/a': 8 };
rows.sort((x, y) => order[x.status] - order[y.status] || key(x.r).localeCompare(key(y.r)));
console.log(`base ${base.env.git.short} (${base.env.date.slice(0, 10)})  →  new ${next.env.git.short} (${next.env.date.slice(0, 10)}), threshold ${threshold}%\n`);
const fmt = (x) => (x == null ? '—' : String(x));
for (const { status, r, b, pct } of rows) {
  if (!showAll && (status === 'same' || status === 'n/a')) continue;
  const change = pct == null ? '' : `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
  console.log(`${status.padEnd(10)} ${key(r).padEnd(52)} ${fmt(b?.median).padStart(10)} → ${fmt(r.median).padEnd(10)} ${r.unit.padEnd(6)} ${change}`);
}
const counts = rows.reduce((a, x) => ((a[x.status] = (a[x.status] || 0) + 1), a), {});
console.log('\n' + Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', '));
process.exit(regressions ? 1 : 0);
