/**
 * Syscall conformance: a focused subset of the Linux Test Project's syscall
 * tests (tests/conformance/ltp/dirs.txt), built as static x86-64 binaries by
 * scripts/conformance/build-ltp.sh and run through Shiro's shell, so they
 * execute under the Blink engine as kernel processes (src/x86-engine,
 * src/kernel).
 *
 * A test passes when it prints its Summary with passed > 0 and nothing failed
 * or broken (lib/ltp.mjs). Only tests that pass natively on the build host as
 * uid 1000 (ltp/native-baseline.json) are scored. Results: results/syscalls-blink.json.
 */
import { describe, it } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Shell } from '@shiro/shell';
import { getKernel } from '@shiro/kernel/kernel';
import { createTestShell } from '../tests/shiro-vitest/helpers';
// @ts-ignore plain JS module shared with the native baseline script
import { judgeLtp } from './lib/ltp.mjs';

const CONF = resolve(__dirname, 'ltp');
const BIN = resolve(__dirname, '.cache/ltp-bin');
const RESULTS = resolve(__dirname, 'results');
const TEST_TIMEOUT = 60_000;
const dirs = readFileSync(join(CONF, 'dirs.txt'), 'utf8').split(/\s+/).filter(Boolean)
  .sort((a, b) => b.length - a.length); // longest prefix first (dup2 before dup)
const baseline: Record<string, unknown> = existsSync(join(CONF, 'native-baseline.json'))
  ? JSON.parse(readFileSync(join(CONF, 'native-baseline.json'), 'utf8')) : {};
const only = process.env.LTP_ONLY ? process.env.LTP_ONLY.split(',') : null;
const hangs: string[] = JSON.parse(readFileSync(join(CONF, 'hangs.json'), 'utf8'));
const progress = (s: string) => { if (process.env.LTP_PROGRESS) appendFileSync(process.env.LTP_PROGRESS, s + '\n'); };

type Failure = { name: string; reason?: string; timeout?: boolean };
type AreaResult = { pass: number; total: number; failures: Failure[] };

const areaOf = (name: string) => dirs.find((d) => name.startsWith(d)) ?? 'other';

async function runAll(): Promise<{ files: Record<string, AreaResult>; detail: Record<string, string> }> {
  const { fs, shell: base } = await createTestShell();
  await fs.mkdir('/ltp/bin', { recursive: true });
  // Every built binary (tests use helpers such as execve_child)
  for (const f of readdirSync(BIN)) {
    await fs.writeFile(`/ltp/bin/${f}`, new Uint8Array(readFileSync(join(BIN, f))), { mode: 0o755 });
  }
  const files: Record<string, AreaResult> = {};
  const detail: Record<string, string> = {};
  const names = Object.keys(baseline).filter((n) => !only || only.includes(n) || only.includes(areaOf(n))).sort();
  // One JSON line per finished test: a run that dies (LTP_RESUME=1) picks up where it stopped
  const journal = join(RESULTS, 'detail', 'syscalls-blink.jsonl');
  mkdirSync(join(RESULTS, 'detail'), { recursive: true });
  const done = new Map<string, { ok: boolean; reason?: string; timeout?: boolean }>();
  if (process.env.LTP_RESUME && existsSync(journal)) {
    for (const line of readFileSync(journal, 'utf8').split('\n')) if (line) { const r = JSON.parse(line); done.set(r.name, r); }
    // LTP_RERUN_FAILED=1: run the failures again (not the known hangs)
    if (process.env.LTP_RERUN_FAILED) {
      for (const [n, r] of [...done]) if (!r.ok && !hangs.includes(n)) done.delete(n);
      writeFileSync(journal, [...done.values()].map((r) => JSON.stringify(r) + '\n').join(''));
    }
  } else writeFileSync(journal, '');
  const record = (name: string, ok: boolean, f: Omit<Failure, 'name'> = {}) => {
    const res = (files[areaOf(name)] ??= { pass: 0, total: 0, failures: [] });
    res.total++;
    if (ok) res.pass++; else res.failures.push({ name, ...f });
    if (!done.has(name)) appendFileSync(journal, JSON.stringify({ name, ok, ...f }) + '\n');
  };
  for (const name of names) {
    const prev = done.get(name);
    if (prev) { record(name, prev.ok, { ...(prev.reason ? { reason: prev.reason } : {}), ...(prev.timeout ? { timeout: true } : {}) }); continue; }
    if (hangs.includes(name)) { record(name, false, { reason: 'skipped: hangs Shiro', timeout: true }); continue; }
    progress(name);
    const dir = `/tmp/ltp/${name}`;
    await fs.mkdir(dir, { recursive: true });
    const shell = new Shell(fs, base.commands);
    shell.cwd = dir;
    Object.assign(shell.env, { PWD: dir, TMPDIR: dir, PATH: `/ltp/bin:${shell.env.PATH}`, LTP_COLORIZE_OUTPUT: '0' });
    // LTP_ENV=NAME=VALUE,…: extra environment for the tests (BLINK_SAME_INSTANCE_FORK=1)
    if (process.env.LTP_ENV) Object.assign(shell.env, Object.fromEntries(process.env.LTP_ENV.split(',').map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)])));
    let out = '';
    let finished = false;
    const run = shell.execute(`/ltp/bin/${name}`, (s) => { out += s; }, (s) => { out += s; }, false, undefined, true)
      .catch((e) => { out += `\n[harness] ${e?.message ?? e}`; return -1; })
      .finally(() => { finished = true; });
    // Finished when it exits, or (it may hang in cleanup) shortly after its summary
    const start = Date.now();
    let summaryAt = 0;
    while (!finished && Date.now() - start < TEST_TIMEOUT) {
      await new Promise((r) => setTimeout(r, 100));
      if (!summaryAt && /^warnings\s+\d+/m.test(out.replace(/\r/g, ''))) summaryAt = Date.now();
      if (summaryAt && Date.now() - summaryAt > 1500) break;
    }
    void run;
    // Kill anything the test left running (a hung guest, its children)
    const k = getKernel();
    for (const p of [...k.procs.values()]) {
      if (p.pid !== 1 && p.state !== 'zombie') { try { k.kill(p.pid, 9); } catch { /* gone */ } }
    }
    const text = out.replace(/\r\n/g, '\n');
    const j = judgeLtp(text);
    detail[name] = text.slice(-3000);
    // Whole output per test (a resumed run's detail JSON only has its own tests)
    mkdirSync(join(RESULTS, 'detail', 'ltp'), { recursive: true });
    writeFileSync(join(RESULTS, 'detail', 'ltp', `${name}.txt`), text);
    record(name, j.ok, j.ok ? {} : { reason: j.reason || 'no summary', ...(!finished && !j.summary ? { timeout: true } : {}) });
  }
  return { files, detail };
}

describe.skipIf(!existsSync(BIN))('LTP syscall tests under Blink', () => {
  it('runs', async () => {
    const { files, detail } = await runAll();
    mkdirSync(join(RESULTS, 'detail'), { recursive: true });
    const name = only ? 'syscalls-blink.partial.json' : 'syscalls-blink.json';
    writeFileSync(join(RESULTS, 'detail', name), JSON.stringify(detail, null, 1));
    const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(join(RESULTS, name), JSON.stringify({
      suite: 'LTP syscalls',
      title: 'Syscalls: LTP under Blink (x86-64)',
      note: 'Static x86-64 LTP syscall tests (scripts/conformance/build-ltp.sh) run as kernel processes in the Blink engine; only tests that pass natively on the build host as an unprivileged user (uid 1000, like Shiro) are scored. Blink forks within one instance by default (patch 0048), so the child shares MAP_SHARED pages, where LTP keeps its result counts and checkpoints; with BLINK_SAME_INSTANCE_FORK=0 (snapshot fork) they are not shared, so when the Summary reads all zeros the TPASS/TFAIL/TBROK lines are counted instead (tests/conformance/lib/ltp.mjs). Trend: 146 (first run) → 172 → 148 (TBROK/TFAIL lines counted, snapshot fork) → 197 (same-instance fork opt-in, A/B against 155 without it) → 222 (same-instance fork the default, Blink 0034–0048, kernel O_PATH/locks/pipe sizes/epoll/errno fixes).',
      files: sorted,
    }, null, 1) + '\n');
  }, 7_200_000);
});
