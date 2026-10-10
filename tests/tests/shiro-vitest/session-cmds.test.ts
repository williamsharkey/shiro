/**
 * tty, setsid and script (williamsharkey/tabcomputer#14): a command's
 * terminal, running without one, and running on a fresh one.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestOS } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';

let shell: Shell;
let fs: FileSystem;

beforeAll(async () => {
  ({ shell, fs } = await createTestOS());
  const s = await import('@shiro/commands/session');
  shell.commands.registerAll([s.ttyCmd, s.setsidCmd, s.scriptCmd]);
});

async function sh(cmd: string) {
  let out = '';
  let err = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { err += s; });
  return { out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n'), code };
}

describe('tty', () => {
  it('names the terminal on stdin', async () => {
    const r = await sh('tty');
    expect(r.out).toMatch(/^\/dev\/pts\/\d+\n$/);
    expect(r.code).toBe(0);
  });
  it('says "not a tty" for a pipe or a file, exit 1; -s prints nothing', async () => {
    expect(await sh('echo x | tty')).toMatchObject({ out: 'not a tty\n', code: 1 });
    expect(await sh('tty < /dev/null')).toMatchObject({ out: 'not a tty\n', code: 1 });
    expect(await sh('tty -s < /dev/null')).toMatchObject({ out: '', code: 1 });
  });
});

describe('setsid', () => {
  it('runs COMMAND without a controlling terminal and returns its status', async () => {
    const r = await sh('setsid sh -c "tty; exit 4"');
    expect(r.out).toBe('not a tty\n');
    expect(r.code).toBe(4);
  });
  it('-f returns at once and leaves COMMAND running', async () => {
    await sh('rm -f /tmp/setsid-late');
    const r = await sh('setsid -f sh -c "sleep 0.2; echo late > /tmp/setsid-late"');
    expect(r.code).toBe(0);
    expect((await sh('cat /tmp/setsid-late')).code).not.toBe(0);
    await new Promise((res) => setTimeout(res, 500));
    expect((await sh('cat /tmp/setsid-late')).out).toBe('late\n');
  });
  it('needs a command', async () => {
    expect((await sh('setsid')).code).toBe(1);
  });
});

describe('script', () => {
  it('-qc runs COMMAND on a new pty: it sees a tty even into a pipe', async () => {
    const r = await sh('script -qc tty /dev/null | cat');
    expect(r.out).toMatch(/^\/dev\/pts\/\d+\r?\n$/);
  });
  it('records the session to FILE and returns COMMAND\'s status', async () => {
    const r = await sh('script -q -c "echo recorded; exit 3" /tmp/ts');
    expect(r.code).toBe(3);
    const log = String(await fs.readFile('/tmp/ts', 'utf8'));
    expect(log).toMatch(/^Script started on .* \[COMMAND="echo recorded; exit 3"/);
    expect(log).toContain('recorded\r\n');
    expect(log).toContain('[COMMAND_EXIT_CODE="3"]');
  });
  it('without -q says where the log goes', async () => {
    const r = await sh('script -c true /dev/null');
    expect(r.err).toContain("Script started, output log file is '/dev/null'.");
    expect(r.err).toContain("Script done, output log file is '/dev/null'.");
  });
  it('an interactive session (no -c) is refused, not hung', async () => {
    const r = await sh('script /dev/null');
    expect(r.code).toBe(1);
    expect(r.err).toContain('script -c COMMAND');
  });
});
