/**
 * doctor --agents: the agent-readiness self-test, through the native probe
 * (a static x86-64 binary under Blink) and the Node runtime.
 */
import { describe, it, expect } from 'vitest';
import { createTestShell } from './helpers';
import { doctorCmd } from '@shiro/commands/doctor';
import { parseProbe, agentSummary, stdinRetry, AGENT_STEPS } from '@shiro/commands/doctor-agents';

async function run(cmd: string) {
  const { shell } = await createTestShell();
  shell.commands.register(doctorCmd);
  shell.env.GITHUB_TOKEN = 'ghp_neverPrintMe';
  let out = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
  return { out: out.replace(/\r\n/g, '\n'), code };
}

describe('doctor --agents', () => {
  it('runs every step through both runtimes; the native probe passes under Blink', async () => {
    const t0 = Date.now();
    const { out } = await run('doctor --agents');
    expect(Date.now() - t0).toBeLessThan(20_000);
    const lines = out.trim().split('\n');
    for (const l of lines) expect(l).toMatch(/^(OK|WARN|FAIL|INFO)\s+\S/);
    for (const step of AGENT_STEPS) {
      expect(out).toMatch(new RegExp(`^OK\\s+native ${step}\\s`, 'm'));
      expect(out).toMatch(new RegExp(`^(OK|FAIL|WARN)\\s+node ${step}\\s`, 'm'));
    }
    expect(out).toMatch(/^OK\s+native mkdir\s+mode 700 uid 1000 \(getuid 1000\)/m);
    expect(out).toMatch(/^OK\s+native realpath\s+\/tmp\/doctor-1000\/native\/a\/b\/c$/m);
    expect(out).toMatch(/^INFO\s+claude native\s+not installed/m);
    // node -v and node -e are their own lines
    expect(out).toMatch(/^OK\s+node -v\s+v\d+\.\d+\.\d+$/m);
    expect(out).toMatch(/^OK\s+node -e\s+42$/m);
    expect(out).not.toContain('ghp_');
  }, 60_000);

  it('plain doctor has one agents summary line', async () => {
    const { out } = await run('doctor');
    expect(out).toMatch(/^(OK|FAIL)\s+agents\s+native 5\/5 · node \d\/5/m);
  }, 60_000);
});

describe('probe output', () => {
  it('errno lines, skipped steps and a probe that printed nothing', () => {
    const c = parseProbe('native', 'OK mkdir mode 700\nFAIL atomic-write errno=13 EACCES open(O_CREAT|O_EXCL)\n', 1);
    expect(c[1]).toEqual({ label: 'native atomic-write', status: 'FAIL', detail: 'errno=13 EACCES open(O_CREAT|O_EXCL)' });
    expect(c.filter((x) => x.status === 'WARN').map((x) => x.label)).toEqual(['native stat', 'native realpath', 'native child']);
    expect(parseProbe('node', 'node: command not found\n', 127)).toEqual([{ label: 'node probe', status: 'FAIL', detail: 'exit 127: node: command not found' }]);
    const sum = agentSummary([...parseProbe('native', AGENT_STEPS.map((s) => `OK ${s} x`).join('\n'), 0), ...c.map((x) => ({ ...x, label: x.label.replace('native', 'node') }))]);
    expect(sum).toEqual({ label: 'agents', status: 'FAIL', detail: 'native 5/5 · node 1/5 (atomic-write failed) (doctor --agents for details)' });
  });

  it('a failing node probe is run again with stdin on /dev/null, which says which run failed', () => {
    const term = parseProbe('node', 'OK mkdir x\nOK atomic-write x\nOK stat x\nOK realpath x\nFAIL child sh -c did not exit in 10 s\n', 1);
    const good = parseProbe('node', AGENT_STEPS.map((s) => `OK ${s} x`).join('\n'), 0);
    expect(stdinRetry(term, good)).toEqual({ label: 'node < /dev/null', status: 'WARN', detail: 'passes with stdin on /dev/null, fails on this terminal (child): a stdin problem' });
    expect(stdinRetry(term, term)).toEqual({ label: 'node < /dev/null', status: 'FAIL', detail: 'fails with stdin on /dev/null too (child): not a stdin problem' });
    const hung = [{ label: 'node probe', status: 'FAIL' as const, detail: 'no answer in 20 s' }];
    expect(stdinRetry(hung, good).detail).toBe('passes with stdin on /dev/null, fails on this terminal (probe): a stdin problem');
    // node -v / -e and the rerun count in the summary only when they fail
    const all = [...parseProbe('native', AGENT_STEPS.map((s) => `OK ${s} x`).join('\n'), 0), ...good];
    expect(agentSummary([...all, { label: 'node -v', status: 'OK', detail: 'v22.12.0' }]).status).toBe('OK');
    expect(agentSummary([...all, { label: 'node -e', status: 'FAIL', detail: 'exited 1, no output' }]))
      .toEqual({ label: 'agents', status: 'FAIL', detail: 'native 5/5 · node 5/5 · node -e: exited 1, no output (doctor --agents for details)' });
  });
});
