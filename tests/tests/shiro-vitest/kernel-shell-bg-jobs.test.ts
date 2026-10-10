/**
 * Background jobs in a shell that is a kernel process (an agent's `bash -c`),
 * with node as a kernel guest: $! is node's own pid, jobs -l/-p show it, kill
 * and wait give bash's statuses, and finished children are reaped at once
 * (no zombies under the shell), foreground ones too.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestShell } from './helpers';
import { installNodeWorker } from './node-worker-setup';
import { Process } from '@shiro/kernel/process';
import { BufferFile } from '@shiro/kernel/fd';
import { O_RDONLY } from '@shiro/kernel/abi';
import { SinkFile } from '@shiro/wasi/stdio';
import { kernelForContext } from '@shiro/wasi/run-command';
import type { CommandContext } from '@shiro/commands/index';

let cleanup: () => void;
beforeAll(async () => { cleanup = await installNodeWorker(); }, 120_000);
afterAll(() => cleanup?.());

/** `sh -c SCRIPT` as a kernel process with node in worker mode; its output */
async function shC(script: string): Promise<string> {
  const { shell, fs } = await createTestShell();
  const kernel = kernelForContext({ fs, shell } as unknown as CommandContext);
  await fs.mkdir('/tmp/bgk', { recursive: true });
  await fs.writeFile('/tmp/bgk/s.js', `setInterval(() => {}, 1000); console.log('up', process.pid);`);
  const argv = ['sh', '-c', `cd /tmp/bgk; ${script}`];
  const env = { ...shell.env, PATH: '/usr/local/bin:/usr/bin:/bin', TABCOMPUTER_NODE_WORKER: '1' };
  const run = await kernel.findProgram('sh', new Process({ pid: -1, ppid: 1, path: 'sh', argv, env, cwd: '/tmp' }));
  let out = '';
  const p = kernel.spawn({ path: 'sh', argv, env, cwd: '/tmp', run: run!, fds: {
    0: new BufferFile('', O_RDONLY), 1: new SinkFile((t) => { out += t; }), 2: new SinkFile((t) => { out += t; }),
  } });
  await p.wait();
  return out;
}

describe('background jobs of a kernel sh', () => {
  it('$! is node\'s pid; jobs -l and -p show it; kill and wait; no zombie after wait', async () => {
    const out = await shC('node s.js > log 2>&1 & p=$!; sleep 1; read -r _ pid < log; [ "$pid" = "$p" ] && echo own-pid; ' +
      'jobs -l | grep -q "^\\[1\\]+ $p Running" && echo jobs-l; jobs -p > jp; read -r jp < jp; [ "$jp" = "$p" ] && echo jobs-p; ' +
      'kill $p; wait $p; echo st=$?; test -e /proc/$p || echo reaped; kill -0 $p 2>/dev/null || echo gone');
    expect(out).toBe('own-pid\njobs-l\njobs-p\nst=143\nreaped\ngone\n');
  }, 60_000);

  it('kill -9 is 137; wait returns the exit status', async () => {
    const out = await shC('node s.js > log 2>&1 & q=$!; sleep 1; kill -9 $q; wait $q; echo st=$?; ' +
      'node -e "setTimeout(() => process.exit(5), 200)" & r=$!; wait $r; echo w=$?; test -e /proc/$r || echo reaped');
    expect(out).toBe('st=137\nw=5\nreaped\n');
  }, 60_000);

  it('a foreground kernel command leaves no zombie under the shell', async () => {
    const out = await shC('node -e "console.log(process.pid)" > fg; read -r p < fg; test -e /proc/$p && grep ^State /proc/$p/status || echo reaped');
    expect(out).toBe('reaped\n');
  }, 60_000);
});
