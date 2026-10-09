/**
 * sh/bash command lines parsed as bash does, whoever starts the shell:
 * options before and after -c (Claude Code runs `sh -c -l 'cmd'`), long
 * options, $0/$1 after the command string (src/shell-args.ts).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createTestShell, run } from './helpers';
import { parseShellArgs } from '@shiro/shell-args';

describe('parseShellArgs', () => {
  it('options before and after -c; the first other argument is the command, then $0, $1…', () => {
    expect(parseShellArgs(['-c', '-l', 'echo hi'])).toMatchObject({ command: true, login: true, rest: ['echo hi'] });
    expect(parseShellArgs(['-l', '-c', 'echo $0 $1', 'a', 'b'])).toMatchObject({ command: true, login: true, rest: ['echo $0 $1', 'a', 'b'] });
    expect(parseShellArgs(['-c', '-e', 'false'])).toMatchObject({ command: true, on: ['errexit'], rest: ['false'] });
    expect(parseShellArgs(['--login', '--norc', '-c', 'x'])).toMatchObject({ command: true, login: true, rest: ['x'] });
    expect(parseShellArgs(['-lc', 'x'])).toMatchObject({ command: true, login: true, rest: ['x'] });
    expect(parseShellArgs(['-o', 'pipefail', '+o', 'noglob', '-c', 'x'])).toMatchObject({ on: ['pipefail'], off: ['noglob'], rest: ['x'] });
    expect(parseShellArgs(['-c', '--', '-x is the command'])).toMatchObject({ command: true, on: [], rest: ['-x is the command'] });
    expect(parseShellArgs(['script.sh', '-l'])).toMatchObject({ command: false, login: false, rest: ['script.sh', '-l'] });
    expect(parseShellArgs(['-s', 'a', 'b'])).toMatchObject({ stdin: true, rest: ['a', 'b'] });
    expect(parseShellArgs(['--rcfile', 'f', '-i'])).toMatchObject({ interactive: true, rest: [] });
    expect(parseShellArgs(['-Q', 'x']).error).toBe('-Q: invalid option');
    expect(parseShellArgs(['--frobnicate']).error).toBe('--frobnicate: invalid option');
  });
});

describe('the page shell', () => {
  it('sh/bash with options after -c and long options', async () => {
    const { shell } = await createTestShell();
    const out = async (cmd: string) => (await run(shell, cmd)).output.replace(/\r\n/g, '\n');
    expect(await out("sh -c -l 'echo hi'")).toBe('hi\n');
    expect(await out("bash -l -c 'echo $0 $1' a b")).toBe('a b\n');
    expect(await out("sh --login -c 'echo login'")).toBe('login\n');
    expect((await run(shell, "sh -c -e 'false; echo no'")).exitCode).toBe(1);
    expect(await out("sh -c 'echo $0' ; echo")).toBe('sh\n\n');
  });
});

// Static x86-64: the same execve's a native agent CLI makes, under Blink
const FIX = resolve(__dirname, 'fixtures/x86');
const out = mkdtempSync(join(tmpdir(), 'shiro-shexec-'));
const bin = join(out, 'shexec');
let haveGcc = false;
try { execFileSync('gcc', ['-static', '-O1', '-o', bin, 'shexec.c'], { cwd: FIX, stdio: 'pipe', timeout: 120_000 }); haveGcc = true; } catch { /* no compiler */ }

describe.skipIf(!haveGcc)('a native program execve\'s the shell (Blink → kernel → sh)', () => {
  it('options before and after -c, --login, -lc, --, $0 and $1', async () => {
    const { fs, shell } = await createTestShell();
    await fs.mkdir('/home/user/work', { recursive: true });
    await fs.writeFile('/home/user/work/prog', new Uint8Array(readFileSync(bin)), { mode: 0o755 });
    const r = await run(shell, '/home/user/work/prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe([
      'hi', '[1] status=0',
      'a b', '[2] status=0',
      '[3] status=1',
      'login', '[4] status=0',
      'lc', '[5] status=0',
      'dashdash zero', '[6] status=0',
      '',
    ].join('\n'));
  }, 120_000);
});

describe('node child_process runs the shell the same way', () => {
  it('spawn (as Claude Code\'s Bash tool runs it) with options after -c and $0/$1', async () => {
    const { fs, shell } = await createTestShell();
    await fs.writeFile('/tmp/cp.js', `
      const cp = require('child_process');
      const show = (args) => new Promise((res) => {
        const c = cp.spawn('/bin/sh', args);
        let out = '';
        c.stdout.on('data', (d) => { out += d; });
        c.on('close', (code) => { process.stdout.write(JSON.stringify([out, code]) + '\\n'); res(); });
      });
      (async () => {
        await show(['-c', '-l', 'echo hi']);
        await show(['-l', '-c', 'echo $0 $1', 'a', 'b']);
        await show(['--login', '-c', 'echo login']);
        await show(['-c', '-e', 'false; echo no']);
      })();
    `);
    const r = await run(shell, 'node /tmp/cp.js');
    expect(r.output.replace(/\r\n/g, '\n')).toBe([
      '["hi\\n",0]',
      '["a b\\n",0]',
      '["login\\n",0]',
      '["",1]',
      '',
    ].join('\n'));
  }, 60_000);
});
