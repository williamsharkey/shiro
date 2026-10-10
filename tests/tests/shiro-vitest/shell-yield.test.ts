/**
 * Function calls and `source` give the page a turn when the shell has held
 * the event loop a while: deep recursion doing real work lets timers run, and
 * runaway recursion (a ~/.profile and ~/.bashrc sourcing each other) can be
 * stopped instead of freezing the tab.
 */
import { describe, it, expect } from 'vitest';
import { createTestShell } from './helpers';

/** Run cmd, counting how often a 1 ms interval fired meanwhile */
async function timed(cmd: string, prep?: (fs: any) => Promise<void>) {
  const { shell, fs } = await createTestShell();
  if (prep) await prep(fs);
  let ticks = 0;
  const iv = setInterval(() => ticks++, 1);
  let out = '';
  const t0 = Date.now();
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
  clearInterval(iv);
  return { out: out.replace(/\r\n/g, '\n'), code, ticks, ms: Date.now() - t0 };
}

describe('the shell yields to the page', () => {
  it('during deep but finite recursion doing real work', async () => {
    const r = await timed('f() { local d=$1; x=$(echo $d); [ "$d" -gt 0 ] && f $((d - 1)); true; }; f 200; echo done');
    expect(r.out).toBe('done\n');
    // at least one turn for every ~30 ms the recursion took
    expect(r.ticks).toBeGreaterThanOrEqual(Math.floor(r.ms / 60));
    expect(r.ticks).toBeGreaterThan(0);
  }, 60_000);

  it('runaway function recursion can be stopped (timeout), below FUNCNEST too', async () => {
    // (a FUNCNEST high enough that only timeout can end it)
    const r = await timed('timeout 1 sh -c "FUNCNEST=100000000; g() { g; }; g"; echo st=$?');
    expect(r.out).toBe('st=124\n');
  }, 30_000);

  it('a file sourcing itself ends at the nesting limit, the page alive meanwhile', async () => {
    const r = await timed('sh -c "source /tmp/self-src.sh" 2>&1 | grep -c "maximum nesting level exceeded"',
      (fs) => fs.writeFile('/tmp/self-src.sh', 'source /tmp/self-src.sh\n'));
    expect(r.out).toBe('1\n');
  }, 30_000);
});
