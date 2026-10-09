/**
 * Every built-in answers `--version` and `--help` (alone) with something
 * sensible and status 0, as agents and scripts probe tools; shell syntax
 * and builtins where the flag is an argument (echo --help) are left alone.
 * Table-driven over the command registry, so a new command is covered.
 */
import { describe, expect, it } from 'vitest';
import { createTestShell } from './helpers';
import { FLAG_IS_ARGUMENT } from '@shiro/commands/help-flags';

describe('--help and --version for every built-in', () => {
  it('status 0, an answer (on stderr for bzip2, as upstream), no error and no side effects', async () => {
    const { shell, fs } = await createTestShell();
    await fs.mkdir('/tmp/flags', { recursive: true });
    const names: string[] = (shell as any).commands.list().map((c: { name: string }) => c.name).sort();
    expect(names.length).toBeGreaterThan(100);
    const bad: string[] = [];
    for (const name of names) {
      if (FLAG_IS_ARGUMENT.has(name)) continue;
      for (const flag of ['--version', '--help']) {
        let out = '', err = '';
        const code = await Promise.race([
          shell.execute(`cd /tmp/flags && ${name} ${flag} < /dev/null`, (s) => { out += s; }, (s) => { err += s; }),
          new Promise<string>((res) => setTimeout(() => res('timeout'), 10_000)),
        ]);
        const made = await fs.readdir('/tmp/flags');
        if (made.length) {
          bad.push(`${name} ${flag}: made ${made.join(', ')}`);
          for (const f of made) await fs.rm(`/tmp/flags/${f}`, { recursive: true });
        }
        if (code !== 0 || !(out + err).trim() || /unrecognized|unknown (option|command|predicate)|invalid option|not found|No such file/i.test(out + err)) {
          bad.push(`${name} ${flag}: ${code} ${JSON.stringify((out + err).slice(0, 80))}`);
        }
      }
    }
    // (nothing may be taken for a file name or run for real either: touch --help, mktemp --version, nohup --help)
    expect(bad).toEqual([]);
  }, 300_000);

  it('the tools agents probe answer like the real ones', async () => {
    const { shell } = await createTestShell();
    const sh = async (cmd: string) => { let out = ''; const code = await shell.execute(cmd, (s) => { out += s; }); return { code, out: out.replace(/\r\n/g, '\n') }; };
    expect((await sh('grep --version')).out).toMatch(/^grep \(tabcomputer\) \d+\.\d+\.\d+\n$/);
    expect((await sh('grep --help')).out).toMatch(/^Usage: grep /);
    expect((await sh('node --version')).out).toMatch(/^v\d+\.\d+\.\d+\n$/);
    expect((await sh('git --version')).out).toMatch(/^git version /);
    // an argument there, as in bash
    expect((await sh('echo --help')).out).toBe('--help\n');
    // with other arguments the command runs as usual
    expect((await sh('echo abc | grep --count b')).out).toBe('1\n');
  });
});
