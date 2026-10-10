/**
 * `cmd > f` opens f before cmd runs, as bash does: a builtin's redirect file
 * is truncated first and gets what is left when it ends, so a command that
 * writes f itself isn't overwritten afterwards.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';

let shell: Shell;
let fs: FileSystem;

beforeAll(async () => {
  ({ shell, fs } = await createTestShell());
});

async function sh(cmd: string) {
  let out = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
  return { out: out.replace(/\r\n/g, '\n'), code };
}

describe('redirect files are opened before the command runs', () => {
  it('a builtin that writes the file itself keeps what it wrote', async () => {
    await sh('echo old > /tmp/r1');
    const r = await sh(`js-eval "await shiro.fs.writeFile('/tmp/r1', 'mine\\\\n'); undefined" > /tmp/r1; cat /tmp/r1`);
    expect(r.out).toBe('mine\n');
  });

  it('`sort f > f` empties f, as in bash', async () => {
    const r = await sh('printf "b\\na\\n" > /tmp/r2; sort /tmp/r2 > /tmp/r2; wc -c < /tmp/r2');
    expect(r.out.trim()).toBe('0');
  });

  it('the file is truncated while the command runs', async () => {
    await sh('echo previous > /tmp/r3');
    const r = await sh('js-eval "await shiro.fs.readFile(\'/tmp/r3\', \'utf8\')" > /tmp/r3; cat /tmp/r3');
    expect(r.out).toBe('\n');
  });

  it('output, append, an empty run, 2> and a failing command', async () => {
    expect((await sh('seq 3 > /tmp/r4; echo 4 >> /tmp/r4; cat /tmp/r4')).out).toBe('1\n2\n3\n4\n');
    expect((await sh('rm -f /tmp/r5; true > /tmp/r5; test -f /tmp/r5 && wc -c < /tmp/r5')).out.trim()).toBe('0');
    expect((await sh('cat /nonexistent 2> /tmp/r6 > /tmp/r7; cat /tmp/r6; wc -c < /tmp/r7')).out)
      .toMatch(/^cat: \/nonexistent: No such file or directory\n0\n$/);
    expect((await sh('echo x > /tmp; echo $?')).out).toContain('Is a directory\n1\n');
  });

  it('a new file is made by one write (one add for a watcher)', async () => {
    await sh('rm -f /tmp/r8');
    const writes: string[] = [];
    const orig = fs.writeFile.bind(fs);
    const origAppend = fs.appendFile.bind(fs);
    // (appendFile writes through writeFile: count the outer call only)
    let inAppend = 0;
    (fs as any).writeFile = async (p: string, d: any, ...a: any[]) => { if (p === '/tmp/r8' && !inAppend) writes.push('write'); return orig(p, d, ...a); };
    (fs as any).appendFile = async (p: string, d: any, ...a: any[]) => {
      if (p === '/tmp/r8') writes.push('append');
      inAppend++;
      try { return await origAppend(p, d, ...a); } finally { inAppend--; }
    };
    try {
      await sh('echo b > /tmp/r8');
    } finally {
      (fs as any).writeFile = orig;
      (fs as any).appendFile = origAppend;
    }
    expect(writes.length).toBe(1);
    expect(String(await fs.readFile('/tmp/r8', 'utf8'))).toBe('b\n');
  });
});
