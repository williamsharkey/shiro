/**
 * In-page background jobs (`sleep 30 &` with the builtin sleep) are processes
 * to ps, /proc and kill(2) (williamsharkey/tabcomputer#14).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';
import type { CommandContext } from '@shiro/commands/index';
import { kernelForContext } from '@shiro/wasi/run-command';
import { processTable } from '@shiro/process-table';

let shell: Shell;
let fs: FileSystem;

beforeAll(async () => {
  ({ shell, fs } = await createTestShell());
});

async function sh(cmd: string) {
  let out = '';
  let err = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { err += s; });
  return { out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n'), code };
}

describe('in-page background jobs as processes', () => {
  it('ps and /proc/$! show the job while it runs', async () => {
    const r = await sh('sleep 30 & p=$!; ps; cat /proc/$p/comm; tr "\\0" " " < /proc/$p/cmdline; echo; grep ^State /proc/$p/status; kill $p; wait $p; echo st=$?');
    const pid = r.out.match(/^\s+(\d+)\s+running\s+\S+\s+sleep 30$/m)?.[1];
    expect(pid).toBeDefined();
    expect(r.out).toContain('\nsleep\nsleep 30 \nState:\tS (sleeping)\n');
    expect(r.out).toContain('st=143');
    expect((await sh(`ls /proc/${pid}`)).code).not.toBe(0);
    expect(processTable.get(Number(pid))).toBeUndefined();
  });

  it('kill -9, kill -0 and a non-terminating signal', async () => {
    const r = await sh('sleep 30 & p=$!; kill -0 $p; echo alive=$?; kill -CONT $p; kill -0 $p; echo still=$?; kill -9 $p; wait $p; echo st=$?; kill -0 $p 2>/dev/null; echo gone=$?');
    expect(r.out).toContain('alive=0');
    expect(r.out).toContain('still=0');
    expect(r.out).toContain('st=137');
    expect(r.out).toContain('gone=1');
  });

  it('kill(2) from a kernel process reaches it', async () => {
    const kernel = kernelForContext({ fs, shell } as unknown as CommandContext);
    await sh('sleep 30 &');
    const pid = Number(shell.env['!']);
    expect(kernel.kill(pid, 0)).toBe(0);
    expect(kernel.kill(pid, 15)).toBe(0);
    expect((await sh(`wait ${pid}; echo st=$?`)).out).toContain('st=143');
    expect(kernel.kill(pid, 0)).toBeLessThan(0); // ESRCH once it's gone
  });

  it('its pid comes from the kernel\'s pid space', async () => {
    await sh('sleep 30 &');
    const pid = Number(shell.env['!']);
    expect(pid).toBeLessThan(40000);
    await sh(`kill ${pid}; wait ${pid}`);
  });
});
