/**
 * A command that doesn't read stdin returns at once even when stdin is a
 * pipe that stays open, as in an agent's shell (williamsharkey/tabcomputer#2:
 * `node -e 'console.log(1)'` from Claude Code's Bash tool never returned).
 * Programs that do read stdin still get all of it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';
import type { Kernel } from '@shiro/kernel/kernel';
import { Process } from '@shiro/kernel/process';
import { createPipe } from '@shiro/kernel/pipe';
import { SinkFile } from '@shiro/wasi/stdio';
import { kernelForContext } from '@shiro/wasi/run-command';
import type { CommandContext } from '@shiro/commands/index';

let fs: FileSystem;
let shell: Shell;
let kernel: Kernel;

beforeAll(async () => {
  ({ fs, shell } = await createTestShell());
  kernel = kernelForContext({ fs, shell } as unknown as CommandContext);
  await fs.writeFile('/tmp/f.txt', 'a\nb\n');
  await fs.writeFile('/tmp/f.json', '{"a":1}');
  await fs.writeFile('/tmp/s.js', 'console.log("script")\n');
});

/** `sh -c CMD` as a kernel process: stdin is a pipe; `input` is written, and closed only if `close` */
async function agentSh(cmd: string, opts: { input?: string; close?: boolean; ms?: number } = {}) {
  const env = { ...shell.env };
  const argv = ['/bin/sh', '-c', '-l', cmd];
  const run = await kernel.findProgram('/bin/sh', new Process({ pid: -1, ppid: 1, path: '/bin/sh', argv, env, cwd: '/tmp' }));
  const [rd, wr] = createPipe();
  let out = '';
  const p = kernel.spawn({ path: '/bin/sh', argv, env, cwd: '/tmp', fds: { 0: rd, 1: new SinkFile((t) => { out += t; }), 2: new SinkFile((t) => { out += t; }) }, run: run! });
  if (opts.input) await wr.write(new TextEncoder().encode(opts.input));
  if (opts.close) await wr.close();
  const t0 = Date.now();
  const status = await Promise.race([p.wait(), new Promise<'hung'>((r) => setTimeout(() => r('hung'), opts.ms ?? 5000))]);
  if (status === 'hung') kernel.kill(p.pid, 9);
  if (!opts.close) await wr.close();
  return { out, status, ms: Date.now() - t0 };
}

describe('commands that never read stdin return with the pipe still open', () => {
  it.each([
    ["node -e 'console.log(1)'", '1\n'],
    ['node /tmp/s.js', 'script\n'],
    ["node -p '1+1'", '2\n'],
    ['jq -n 1', '1\n'],
    ['jq -c . /tmp/f.json', '{"a":1}\n'],
    ["awk 'BEGIN{print 3}'", '3\n'],
    ['base64 /tmp/f.txt', 'YQpiCg==\n'],
    ['cat /tmp/f.txt', 'a\nb\n'],
    ['grep a /tmp/f.txt', 'a\n'],
  ])('%s', async (cmd, want) => {
    const r = await agentSh(cmd);
    expect(r.status).toBe(0);
    expect(r.out).toBe(want);
    expect(r.ms).toBeLessThan(3000);
  });
});

describe('programs that read stdin still get all of it', () => {
  it.each([
    ["node -e 'let s=\"\"; process.stdin.on(\"data\", d => s += d); process.stdin.on(\"end\", () => console.log(\"got\", JSON.stringify(s)))'", 'got "x\\ny\\n"\n'],
    ["node -e '(async () => { let s=\"\"; process.stdin.setEncoding(\"utf8\"); for await (const c of process.stdin) s += c; console.log(\"iter\", s.length) })()'", 'iter 4\n'],
    ["node -e 'process.stdin.on(\"data\", d => process.stdout.write(\"data \" + d))'", 'data x\ny\n'],
    ['node', 'from stdin\n'],
    ['jq -c .', '{"b":2}\n'],
    ["awk '{print NR\": \"$0}'", '1: x\n2: y\n'],
  ])('%s', async (cmd, want) => {
    const input = cmd === 'node' ? 'console.log("from stdin")\n' : cmd.startsWith('jq') ? '{"b":2}\n' : 'x\ny\n';
    const r = await agentSh(cmd, { input, close: true });
    expect(r.status).toBe(0);
    expect(r.out).toBe(want);
  });
});
