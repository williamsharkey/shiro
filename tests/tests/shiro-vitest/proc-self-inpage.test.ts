/**
 * /proc/self for an in-page builtin is the command itself: its fds 0-2 point
 * where the segment's stdin and stdout really go, and its cmdline is its argv.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestOS } from './helpers';
import type { Shell } from '@shiro/shell';

let shell: Shell;

beforeAll(async () => {
  ({ shell } = await createTestOS());
});

async function sh(cmd: string) {
  let out = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
  return { out: out.replace(/\r\n/g, '\n'), code };
}

describe('/proc/self of an in-page command', () => {
  it('fd 1 is the redirect\'s file, a pipe, the tty, or $(…)\'s pipe', async () => {
    expect((await sh('readlink /proc/self/fd/1 > /tmp/ps1; cat /tmp/ps1')).out).toBe('/tmp/ps1\n');
    expect((await sh('readlink /proc/self/fd/1 | cat')).out).toMatch(/^pipe:\[\d+\]\n$/);
    expect((await sh('readlink /proc/self/fd/1')).out).toMatch(/^\/dev\/pts\/\d+\n$/);
    expect((await sh('x=$(readlink /proc/self/fd/1); echo $x')).out).toMatch(/^pipe:\[\d+\]\n$/);
  });

  it('fd 0 is the pipe from the previous segment, a < file, or /dev/null', async () => {
    const r = await sh('readlink /proc/self/fd/1 | readlink /proc/self/fd/0');
    expect(r.out).toMatch(/^pipe:\[\d+\]\n$/);
    expect((await sh('readlink /proc/self/fd/0 < /dev/null')).out).toBe('/dev/null\n');
    expect((await sh('echo hi > /tmp/ps0; readlink /proc/self/fd/0 < /tmp/ps0')).out).toBe('/tmp/ps0\n');
  });

  it('2>&1 and 2> follow their order', async () => {
    expect((await sh('readlink /proc/self/fd/2 > /tmp/ps2 2>&1; cat /tmp/ps2')).out).toBe('/tmp/ps2\n');
    expect((await sh('readlink /proc/self/fd/2 2>&1 > /tmp/ps3; cat /tmp/ps3')).out).toMatch(/^\/dev\/pts\/\d+\n$/);
    expect((await sh('readlink /proc/self/fd/2 2>/tmp/ps4')).out).toBe('/tmp/ps4\n');
  });

  it('stat -L of fd 1 sees the file; cmdline is the command; self is not $$', async () => {
    expect((await sh('stat -L -c %F /proc/self/fd/1 > /tmp/ps5; cat /tmp/ps5')).out).toBe('regular file\n');
    expect((await sh('cat /proc/self/cmdline | tr "\\0" " "')).out).toBe('cat /proc/self/cmdline ');
    const r = await sh('echo $$; readlink /proc/self; cat /proc/self/stat | cut -d" " -f4');
    const [shellPid, self, ppid] = r.out.trim().split('\n');
    expect(self).not.toBe(shellPid);
    expect(ppid).toBe(shellPid);
  });
});
