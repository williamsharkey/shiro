/**
 * A kernel process's shell (Kernel.forkShell → Shell.forProcess) gets what
 * exec passes on and nothing more, and nothing it does reaches the page's
 * shell: env, cwd, aliases, traps, functions, options, $$/$PPID.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createTestShell, run } from './helpers';
import type { FileSystem } from '@shiro/filesystem';
import type { Shell } from '@shiro/shell';
import { Kernel } from '@shiro/kernel/kernel';
import { SinkFile } from '@shiro/wasi/stdio';
import { DevNull } from '@shiro/kernel/fd';
import * as A from '@shiro/kernel/abi';

describe('a kernel process\'s shell', () => {
  let fs: FileSystem;
  let shell: Shell;
  let kernel: Kernel;
  beforeAll(async () => {
    ({ fs, shell } = await createTestShell());
    await fs.mkdir('/tmp/ps', { recursive: true }).catch(() => {});
  });
  beforeEach(() => { kernel = new Kernel({ shell }); });
  afterEach(() => kernel.dispose());

  const spawnSh = async (script: string, env: Record<string, string> = { ...shell.exportedEnv() }) => {
    let out = '';
    const sink = new SinkFile((t: string) => { out += t; });
    const p = kernel.spawn({ path: '/bin/sh', argv: ['sh', '-c', script], cwd: '/tmp', env, fds: { 0: new DevNull(A.O_RDONLY), 1: sink, 2: sink } });
    const status = await p.wait();
    return { out: out.replace(/\r\n/g, '\n'), status, pid: p.pid, ppid: p.ppid };
  };

  it('changes nothing in the page shell', async () => {
    await run(shell, 'cd /tmp/ps; unset KPS_X; unalias kps_a 2>/dev/null; unset -f kps_f; trap - USR1');
    const r = await spawnSh('export KPS_X=1; cd /; alias kps_a=echo; trap "" USR1; kps_f() { :; }; set -e; echo done');
    expect(r.out).toBe('done\n');
    expect(shell.env.KPS_X).toBeUndefined();
    expect(shell.cwd).toBe('/tmp/ps');
    expect((await run(shell, 'alias kps_a')).exitCode).not.toBe(0);
    expect((await run(shell, 'type kps_f')).exitCode).not.toBe(0);
    expect((await run(shell, 'trap -p USR1')).output).toBe('');
    expect((await run(shell, 'case $- in *e*) echo set-e;; *) echo no-e;; esac')).output.trim()).toBe('no-e');
  });

  it('its $$ and $PPID are the process\'s; exported functions cross, others don\'t', async () => {
    const r = await spawnSh('echo "$$ $PPID"');
    expect(r.out).toBe(`${r.pid} ${r.ppid}\n`);
    await run(shell, 'kps_exp() { echo exported-fn; }; export -f kps_exp; kps_loc() { echo local-fn; }');
    const f = await spawnSh('kps_exp; kps_loc 2>/dev/null || echo no-local');
    expect(f.out).toBe('exported-fn\nno-local\n');
    await run(shell, 'unset -f kps_exp kps_loc');
  });

  it('page options and aliases don\'t carry in; a builtin\'s cd moves only its process', async () => {
    await run(shell, 'alias kps_b=false; set -o noglob');
    try {
      const r = await spawnSh('alias kps_b >/dev/null 2>&1 && echo has-alias || echo no-alias; case $- in *f*) echo noglob;; *) echo glob;; esac');
      expect(r.out).toBe('no-alias\nglob\n');
    } finally {
      await run(shell, 'unalias kps_b; set +o noglob');
    }
    const p = kernel.spawn({ path: 'cd', argv: ['cd', '/'], cwd: '/tmp', fds: {} });
    expect(await p.wait()).toBe(0);
    expect(p.cwd).toBe('/');
    expect(shell.cwd).not.toBe('/');
  });
});
