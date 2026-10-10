/**
 * The conformance harnesses' watchdog (tests/conformance/lib/watchdog.mjs):
 * a test whose guest keeps the harness thread busy is still recorded as a
 * timeout, and the run stops so *_RESUME=1 can continue after it.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const lib = resolve(__dirname, '../../conformance/lib/watchdog.mjs');

describe('conformance watchdog', () => {
  it('records a test that blocks the harness thread past its deadline and ends the run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wd-'));
    const journal = join(dir, 'j.jsonl');
    // the harness thread arms, finishes one test, then spins synchronously in the next
    const script = `
      import { startWatchdog } from ${JSON.stringify(lib)};
      const w = startWatchdog({ journal: ${JSON.stringify(journal)}, detailDir: ${JSON.stringify(dir)}, grace: 300 });
      w.arm('quick', 100); w.disarm();
      w.arm('stuck', 200);
      setTimeout(() => { const end = Date.now() + 20000; while (Date.now() < end); }, 50);`;
    const t0 = Date.now();
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000 });
    expect(r.signal).toBe('SIGKILL');
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.stderr).toContain('[watchdog] stuck hung the harness');
    const lines = readFileSync(journal, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toEqual([{ name: 'stuck', ok: false, reason: 'timeout: the harness stopped responding (watchdog)', timeout: true }]);
    expect(existsSync(join(dir, 'stuck.txt'))).toBe(true);
  });

  it('lets a run that disarms each test end normally', () => {
    const script = `
      import { startWatchdog } from ${JSON.stringify(lib)};
      const w = startWatchdog({ journal: '/dev/null', detailDir: '/tmp', grace: 100 });
      w.arm('a', 50); setTimeout(() => { w.disarm(); w.stop(); console.log('done'); }, 20);`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('done');
  });
});
