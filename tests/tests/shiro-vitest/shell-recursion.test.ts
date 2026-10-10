import { describe, it, expect } from 'vitest';
import { createTestShell } from './helpers';

// Unbounded recursion never yielded to the page: a ~/.profile and ~/.bashrc
// that source each other froze every boot (terminal.ts sources ~/.profile).
// bash would recurse until its process crashed; here it fails with an error.
describe('shell recursion limits', () => {
  const run = async (cmd: string) => {
    const { fs, shell } = await createTestShell();
    let out = '';
    const t0 = Date.now();
    const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
    return { fs, code, out: out.replace(/\r\n/g, '\n'), ms: Date.now() - t0 };
  };

  it('files that source each other fail at nesting level 100, and the shell goes on', async () => {
    const { fs, shell } = await createTestShell();
    await fs.writeFile('/home/user/.profile', '. /home/user/.bashrc\n');
    await fs.writeFile('/home/user/.bashrc', 'export FROM_BASHRC=1\n. /home/user/.profile\n');
    let out = '';
    await shell.execute('. /home/user/.profile; echo after=$? $FROM_BASHRC', (s) => { out += s; }, (s) => { out += s; });
    expect(out.replace(/\r\n/g, '\n')).toBe('source: /home/user/.profile: maximum nesting level exceeded (100)\nafter=1 1\n');
  }, 30000);

  it('infinite function recursion fails at FUNCNEST, 1000 when unset', async () => {
    const r = await run('f() { f; }; f; echo done=$?');
    expect(r.out).toBe('f: maximum function nesting level exceeded (1000)\ndone=1\n');
    expect((await run('FUNCNEST=5; g() { g; }; g; echo $?')).out).toBe('g: maximum function nesting level exceeded (5)\n1\n');
    // deep but finite recursion still works
    expect((await run('n=0; h() { n=$((n+1)); [ $n -lt 500 ] && h; }; h; echo n=$n')).out).toBe('n=500\n');
  }, 30000);
});
