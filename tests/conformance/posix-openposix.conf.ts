/**
 * POSIX conformance: the Open POSIX Test Suite's conformance tests
 * (open_posix_testsuite in LTP), built as static x86-64 binaries by
 * scripts/conformance/build-openposix.sh and run through Shiro's shell, so
 * they execute under the Blink engine as kernel processes: signals,
 * pthreads, semaphores, message queues, timers, clocks, mmap, scheduling.
 *
 * A test passes when it exits 0 (PTS_PASS). Only tests that pass natively on
 * the build host as uid 1000 (openposix/native-baseline.json) are scored.
 * Results: results/posix-openposix.json. OPENPOSIX_ONLY=a,b runs some tests
 * or areas; OPENPOSIX_RESUME=1 continues a run that stopped.
 */
import { describe, it } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Shell } from '@shiro/shell';
import { getKernel } from '@shiro/kernel/kernel';
import { createTestShell } from '../tests/shiro-vitest/helpers';

const CONF = resolve(__dirname, 'openposix');
const BIN = resolve(__dirname, '.cache/openposix-bin');
const RESULTS = resolve(__dirname, 'results');
/** A test gets 20x its native time, between 8 s and 30 s (most take milliseconds; a hang shouldn't cost 30 s) */
const timeoutFor = (name: string) => Math.min(30_000, Math.max(8_000, 20 * ((baseline[name] as { ms?: number } | undefined)?.ms ?? 1500)));
const baseline: Record<string, unknown> = existsSync(join(CONF, 'native-baseline.json'))
  ? JSON.parse(readFileSync(join(CONF, 'native-baseline.json'), 'utf8')) : {};
const hangs: string[] = existsSync(join(CONF, 'hangs.json')) ? JSON.parse(readFileSync(join(CONF, 'hangs.json'), 'utf8')) : [];
const only = process.env.OPENPOSIX_ONLY ? process.env.OPENPOSIX_ONLY.split(',') : null;
const progress = (s: string) => { if (process.env.OPENPOSIX_PROGRESS) appendFileSync(process.env.OPENPOSIX_PROGRESS, s + '\n'); };
const STATUS: Record<number, string> = { 1: 'FAIL', 2: 'UNRESOLVED', 3: 'UNINITIATED', 4: 'UNSUPPORTED', 5: 'UNTESTED' };

type Failure = { name: string; reason?: string; timeout?: boolean };
type AreaResult = { pass: number; total: number; failures: Failure[] };

/** sigaction_1-1 → sigaction */
const areaOf = (name: string) => name.replace(/_\d+-\d+$/, '');

async function runAll(): Promise<Record<string, AreaResult>> {
  const { fs, shell: base } = await createTestShell();
  await fs.mkdir('/openposix/bin', { recursive: true });
  const files: Record<string, AreaResult> = {};
  const names = Object.keys(baseline).filter((n) => !only || only.includes(n) || only.includes(areaOf(n))).sort();
  const journal = join(RESULTS, 'detail', 'posix-openposix.jsonl');
  mkdirSync(join(RESULTS, 'detail', 'openposix'), { recursive: true });
  const done = new Map<string, { ok: boolean; reason?: string; timeout?: boolean }>();
  if (process.env.OPENPOSIX_RESUME && existsSync(journal)) {
    for (const line of readFileSync(journal, 'utf8').split('\n')) if (line) { const r = JSON.parse(line); done.set(r.name, r); }
    if (process.env.OPENPOSIX_RERUN_FAILED) {
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
    if (hangs.includes(name)) { record(name, false, { reason: 'skipped: hangs tabcomputer', timeout: true }); continue; }
    if (!existsSync(join(BIN, name))) { record(name, false, { reason: 'not built' }); continue; }
    progress(name);
    await fs.writeFile(`/openposix/bin/${name}`, new Uint8Array(readFileSync(join(BIN, name))), { mode: 0o755 });
    const dir = `/tmp/openposix/${name}`;
    await fs.mkdir(dir, { recursive: true });
    const shell = new Shell(fs, base.commands);
    shell.cwd = dir;
    Object.assign(shell.env, { PWD: dir, TMPDIR: dir });
    let out = '';
    let status: number | undefined;
    const run = shell.execute(`/openposix/bin/${name}`, (s) => { out += s; }, (s) => { out += s; }, false, undefined, true)
      .then((c) => { status = c; }, (e) => { out += `\n[harness] ${e?.message ?? e}`; status = -1; });
    const start = Date.now();
    const limit = timeoutFor(name);
    while (status === undefined && Date.now() - start < limit) await new Promise((r) => setTimeout(r, 50));
    void run;
    const k = getKernel();
    for (const p of [...k.procs.values()]) {
      if (p.pid !== 1 && p.state !== 'zombie') { try { k.kill(p.pid, 9); } catch { /* gone */ } }
    }
    try { await fs.unlink(`/openposix/bin/${name}`); } catch { /* gone */ }
    const text = out.replace(/\r\n/g, '\n');
    writeFileSync(join(RESULTS, 'detail', 'openposix', `${name}.txt`), `${text}\n[exit ${status ?? 'timeout'}]\n`);
    const last = text.trim().split('\n').filter(Boolean).pop() ?? '';
    if (status === 0) record(name, true);
    else if (status === undefined) record(name, false, { reason: `timeout: ${last}`.slice(0, 200), timeout: true });
    else record(name, false, { reason: `${STATUS[status] ?? `exit ${status}`}: ${last}`.slice(0, 200) });
  }
  return files;
}

describe.skipIf(!existsSync(BIN))('Open POSIX Test Suite under Blink', () => {
  it('runs', async () => {
    const files = await runAll();
    const name = only ? 'posix-openposix.partial.json' : 'posix-openposix.json';
    const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(join(RESULTS, name), JSON.stringify({
      suite: 'Open POSIX Test Suite',
      title: 'POSIX: Open POSIX Test Suite under Blink (x86-64)',
      note: 'The Open POSIX Test Suite\'s conformance tests (open_posix_testsuite in LTP, scripts/conformance/build-openposix.sh) run as static x86-64 kernel processes in the Blink engine: signals, pthreads, semaphores, message queues, timers, clocks, mmap, scheduling. A test passes when it exits 0; only tests that pass natively on the build host as uid 1000 are scored (openposix/native-baseline.json). First run: 1173/1448, with Blink 0080–0084 built locally (raise(SIGKILL) and sigqueue/AIO fixed from this suite); the gaps are POSIX message queues (mq_*), POSIX timers (timer_*), sigwait/sigtimedwait, sched_* policies and shm_open. → 1326/1448 (kernel POSIX message queues and timers, Blink 0086–0089 and 0093 built locally: mq_*, timer_*, sigtimedwait/sigwait, sched_*; sigqueue waits on siginfo in Blink\'s handler frames; fork_21-1 and pthread_attr_destroy_1-1 hit a Blink page-lock assertion, fixed in perf-blink\'s 0092). → 1353/1448 with perf-blink\'s Blink 0092 (fork keeps page lock counts) and 0095 (siginfo in SA_SIGINFO frames, real-time signals queue): sigqueue, sigwait/sigwaitinfo, fork_21-1, pthread_attr_destroy_1-1, lio_listio and aio_* now pass. Left: shm_open and mmap of shared objects, mlock*, pthread_cancel and cancellation points, process-shared pthread objects, pthread_kill interrupting another thread\'s call (mq_timedsend_12-1). → 1379/1448 (kernel: kill/sigqueue permissions, SIGCHLD\'s CLD_* siginfo and SA_NOCLDSTOP/SA_NOCLDWAIT, sigtimedwait taking unblocked waited signals, timer overruns, open() owner bits; Blink 0096–0099 built locally: raise of a blocked real-time signal queues, sigprocmask/sigaltstack modes, write-only pages readable, shared kernel-file maps written back before a new map and at exit, mlock/mmap errors). Left: mmap of shared objects across instances and SIGBUS past EOF, pthread_cancel and cancellation points, process-shared pthread objects, fork cases, pthread_kill interrupting another thread\'s call (mq_timedsend_12-1); sigqueue_1-1 is fixed by perf-blink\'s 0110. Measured on integration bab5481 (perf-blink\'s engine through 0110, which has 0096–0098 but not this branch\'s 0500/0501): 1370/1448, rerun on a quiet machine; 0500 (mlock/mmap errors) and 0501 (pthread_cancel) add 15 more when built (1379 + pthread_cancel\'s 9 locally). → 1375/1448 on integration dff2c0d (perf-blink\'s engine through 0114 with 0500–0504, quiet rerun of the failures): pthread_cancel and cancellation points, CPU clock ids, mlock/mmap errors, fsync, st_ctime and the process-shared mutexes/condition variables of perf-blink\'s 0112 pass; 26 named-semaphore and /dev/shm tests (sem_*, shm_open_5-1/28-1/28-3, mmap_11-5) abort in 0112\'s munmap (memorymalloc.c:834), and clock_getcpuclockid_1-2 (another process\'s CPU clock) is fixed by 0506.',
      files: sorted,
    }, null, 1) + '\n');
  }, 14_400_000);
});
