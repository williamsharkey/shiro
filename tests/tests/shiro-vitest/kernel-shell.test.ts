/**
 * The shell running WASM and x86 programs as kernel processes (src/shell-kernel.ts):
 * kernel pipes between them, builtins on either side, and on a terminal a
 * foreground process group on the pty with Ctrl-C / Ctrl-Z / fg / bg / jobs.
 *
 * WASM guests run in Node worker_threads (as in kernel-wasi.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Worker } from 'node:worker_threads';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import type { GuestWorker } from '@shiro/kernel/worker-host';
import { setGuestWorkerFactory, forceWasmProcessMode } from '@shiro/wasi/host';
import { TtySession } from '@shiro/kernel/pty';
import { jobsCmd, fgCmd, bgCmd, waitCmd } from '@shiro/commands/jobs';
import { Process } from '@shiro/kernel/process';
import { kernelForContext } from '@shiro/wasi/run-command';
import type { CommandContext } from '@shiro/commands/index';

const here = __dirname;
const fixtures = path.join(here, 'fixtures', 'wasi');
const srcWasi = path.resolve(here, '../../../src/wasi');
let tmp: string;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'shiro-kshell-'));
  const entry = path.join(tmp, 'entry.ts');
  writeFileSync(entry, `
    import { parentPort } from 'node:worker_threads';
    import { guestMain } from ${JSON.stringify(path.join(srcWasi, 'guest-worker.ts'))};
    const port: any = { postMessage: (m: unknown) => parentPort!.postMessage(m), onmessage: null };
    parentPort!.on('message', (data) => port.onmessage && port.onmessage({ data }));
    guestMain(port);
  `);
  const workerFile = path.join(tmp, 'guest-worker.mjs');
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: workerFile, logLevel: 'error' });
  setGuestWorkerFactory((): GuestWorker => {
    const w = new Worker(workerFile);
    return {
      postMessage: (m) => w.postMessage(m),
      terminate: () => w.terminate(),
      onMessage: (cb) => { w.on('message', cb); },
      onError: (cb) => { w.on('error', cb); },
    };
  });
  forceWasmProcessMode('sab');
}, 120_000);

afterAll(() => {
  setGuestWorkerFactory(null);
  forceWasmProcessMode(null);
  rmSync(tmp, { recursive: true, force: true });
});

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await tick(5);
  }
}

async function setupShell(): Promise<Shell> {
  const { fs, shell } = await createTestShell();
  for (const c of [jobsCmd, fgCmd, bgCmd, waitCmd]) shell.commands.register(c);
  await fs.mkdir('/usr/local/bin', { recursive: true });
  const bin = (name: string, file: string) => fs.writeFile(`/usr/local/bin/${name}`, new Uint8Array(readFileSync(file)));
  await bin('upper.wasm', path.join(fixtures, 'upper.wasm'));
  await bin('readloop.wasm', path.join(fixtures, 'readloop.wasm'));
  await bin('wseq', path.join(fixtures, 'seq.wasm')); // `seq` is a builtin
  await bin('hello', path.join(here, 'fixtures', 'hello-musl'));
  return shell;
}

describe('kernel programs from the prompt (no terminal)', () => {
  let shell: Shell;
  const run = async (cmd: string) => {
    let out = '';
    let err = '';
    const exitCode = await shell.execute(cmd, (s) => { out += s; }, (s) => { err += s; });
    return { out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n'), exitCode };
  };
  beforeEach(async () => { shell = await setupShell(); });

  it('runs an x86 ELF as a kernel process', async () => {
    const r = await run('hello');
    expect(r.out).toBe('Hello, world!\n');
    expect(r.exitCode).toBe(0);
  });

  it('builtin | wasm | builtin', async () => {
    const r = await run('echo abc | upper | tr B X');
    expect(r.out).toBe('AXC\n');
    expect(r.err).toContain('bytes: 4');
  });

  it('wasm | wasm over a kernel pipe, with PIPESTATUS and redirects', async () => {
    const r = await run('wseq 3 | upper');
    expect(r.out).toBe('LINE 1\nLINE 2\nLINE 3\n');
    expect((await run('echo ${PIPESTATUS[@]}')).out).toBe('0 0\n');
    await run('wseq 2 | upper > /tmp/o.txt 2>/dev/null');
    expect((await run('cat /tmp/o.txt')).out).toBe('LINE 1\nLINE 2\n');
    expect((await run('wseq 4 | upper | wc -l')).out.trim()).toBe('4');
  });

  it('filter builtins around kernel programs share real pipes', async () => {
    await run('printf "a\\nb\\nc\\n" > /tmp/in.txt');
    expect((await run('cat /tmp/in.txt | upper 2>/dev/null | tr A Z')).out).toBe('Z\nB\nC\n');
    expect((await run('wseq 3 | grep 2 | upper 2>/dev/null')).out).toBe('LINE 2\n');
    expect((await run('echo ${PIPESTATUS[@]}')).out).toBe('0 0 0\n');
    expect((await run('wseq 3 | grep nomatch')).exitCode).toBe(1);
  });

  it('x86 | wasm', async () => {
    expect((await run('hello | upper 2>/dev/null')).out).toBe('HELLO, WORLD!\n');
  });

  it('builtins and scripts still run in-page', async () => {
    expect((await run('echo hi | cat')).out).toBe('hi\n');
    expect((await run('nosuchprog')).exitCode).toBe(127);
  });
});

/** A terminal stand-in with a pty session; captures what reaches the screen */
function fakeTerminal() {
  const tty = new TtySession();
  let screen = '';
  tty.pty.onOutput((b) => { screen += new TextDecoder().decode(b); });
  return {
    tty,
    screen: () => screen,
    writeOutput: (s: string) => { screen += s; },
    enterStdinPassthrough() {}, exitStdinPassthrough() {}, enterRawMode() {}, exitRawMode() {},
    isRawMode: () => false, onResize: () => () => {},
    getSize: () => ({ rows: tty.pty.winsize.rows, cols: tty.pty.winsize.cols }),
    term: null,
  };
}

describe('kernel programs on the terminal pty', () => {
  let shell: Shell;
  let term: ReturnType<typeof fakeTerminal>;
  const sh = async (cmd: string) => {
    let out = '';
    const exitCode = await shell.execute(cmd, (s) => { out += s; }, (s) => { out += s; }, false, term);
    return { out: out.replace(/\r\n/g, '\n'), exitCode };
  };
  beforeEach(async () => {
    shell = await setupShell();
    term = fakeTerminal();
  });

  it('an interactive program reads the tty line by line; ^D ends it', async () => {
    const r = sh('readloop');
    await until(() => term.tty.jobInForeground);
    term.tty.pty.input('hi\r');
    await until(() => term.screen().includes('got: hi'));
    expect(term.screen()).toContain('hi\r\n'); // echoed by the line discipline
    term.tty.pty.input('there\r\x04');
    expect((await r).exitCode).toBe(2);
    expect(term.screen()).toContain('lines: 2');
    expect(term.tty.jobInForeground).toBe(false);
  });

  it('Ctrl-C kills the foreground job', async () => {
    const r = sh('readloop');
    await until(() => term.tty.jobInForeground);
    term.tty.pty.input('\x03');
    expect((await r).exitCode).toBe(130);
  });

  it('Ctrl-Z stops it, jobs lists it, fg resumes it', async () => {
    const r = sh('readloop');
    await until(() => term.tty.jobInForeground);
    term.tty.pty.input('\x1a');
    expect((await r).exitCode).toBe(148);
    expect(term.screen()).toMatch(/\[1\]\+\s+Stopped\s+readloop/);
    expect((await sh('jobs')).out).toMatch(/Stopped\s+readloop/);
    const fg = sh('fg');
    await until(() => term.tty.jobInForeground);
    term.tty.pty.input('one\r\x04');
    expect((await fg).exitCode).toBe(1);
    expect(term.screen()).toContain('got: one');
  });

  it('a pipeline is one job: ^C reaches every stage', async () => {
    const r = sh('readloop | upper');
    await until(() => term.tty.jobInForeground);
    term.tty.pty.input('x\r');
    term.tty.pty.input('\x03');
    expect((await r).exitCode).toBe(130);
  });

  it('$(kernel program) captures its stdout instead of writing to the tty', async () => {
    (shell as any).terminal = term; // the page shell's own terminal, as at the prompt
    const r = await sh('X=$(wseq 2); echo "got [$X]"');
    expect(r.out).toMatch(/got \[line 1\s+line 2\]/);
    expect(term.screen()).not.toContain('line 1');
  });

  it('sudo/timeout PROGRAM redirected or piped: its stdout goes there, not to the tty (sudo apt-get update | tail)', async () => {
    (shell as any).terminal = term;
    const r = await sh('sudo wseq 2 > /tmp/sudo.out; timeout 5 wseq 3 > /tmp/timeout.out; cat /tmp/sudo.out /tmp/timeout.out | wc -l');
    expect(r.out.trim()).toBe('5');
    expect(term.screen()).not.toContain('line 1');
  });

  it('kernel | filter builtin is one job: the builtin runs as a kernel process and writes to the tty', async () => {
    const r = await sh('wseq 3 | grep 2');
    expect(r.exitCode).toBe(0);
    expect(r.out).toBe('');
    expect(term.screen()).toContain('line 2\r\n');
  });

  it('Ctrl-Z stops every stage of a mixed pipeline', async () => {
    const r = sh('readloop | cat');
    await until(() => term.tty.jobInForeground);
    term.tty.pty.input('\x1a');
    expect((await r).exitCode).toBe(148);
    const job = shell.backgroundJobs.get(1)!;
    expect(job.pids!.length).toBe(2);
    const fg = sh('fg');
    await until(() => term.tty.jobInForeground);
    term.tty.pty.input('z\r\x04');
    expect((await fg).exitCode).toBe(0);
    expect(term.screen()).toContain('got: z');
  });

  it('prog & is a background job; reading the tty stops it with SIGTTIN', async () => {
    expect((await sh('readloop &')).exitCode).toBe(0);
    expect(term.screen()).toMatch(/\[1\] \d+/);
    await until(() => shell.backgroundJobs.get(1)?.status === 'stopped');
    expect((await sh('jobs')).out).toMatch(/Stopped\s+readloop/);
    expect((await sh('kill %1')).exitCode).toBe(0);
    await until(() => shell.backgroundJobs.get(1)?.status !== 'stopped');
  });
});

describe('job control in a kernel sh on a pty (a screen or tmux window)', () => {
  it('Ctrl-Z stops its job, not the shell; jobs, wait, bg and fg', async () => {
    const shell = await setupShell();
    const kernel = kernelForContext({ fs: shell.fs, shell } as unknown as CommandContext);
    const tty = new TtySession();
    let screen = '';
    tty.pty.onOutput((b) => { screen += new TextDecoder().decode(b); });
    const env = { ...shell.env, PATH: '/usr/local/bin:/usr/bin:/bin', PS1: 'K$ ' };
    const argv = ['sh'];
    const run = await kernel.findProgram('sh', new Process({ pid: -1, ppid: 1, path: 'sh', argv, env, cwd: '/tmp' }));
    const sh = tty.spawnJob(kernel, { path: 'sh', argv, env, cwd: '/tmp', run: run! });
    tty.pty.setForeground(sh.pgid);
    const prompts = () => screen.split('K$ ').length - 1;
    const type = async (line: string) => { const n = prompts(); tty.pty.input(line + '\r'); await until(() => prompts() > n); };
    await until(() => prompts() === 1);

    tty.pty.input('readloop\r');
    await until(() => tty.pty.fgPgrp !== sh.pgid); // the job has the terminal
    tty.pty.input('a\r');
    await until(() => screen.includes('got: a'));
    tty.pty.input('\x1a');
    await until(() => prompts() === 2);
    expect(sh.alive).toBe(true);
    expect(tty.pty.fgPgrp).toBe(sh.pgid);
    expect(screen).toMatch(/\[1\]\+\s+Stopped\s+readloop\r\n/);
    await type('jobs -l');
    expect(screen).toMatch(/\[1\]\+\s+\d+\s+Stopped\s+readloop/);
    await type('wait %1; echo "wait $?"');
    expect(screen).toContain('wait 148');
    // bg: it reads the tty from the background, so the tty stops it again (SIGTTIN)
    await type('bg');
    expect(screen).toContain('[1]+ readloop &');
    tty.pty.input('fg\r');
    await until(() => tty.pty.fgPgrp !== sh.pgid);
    tty.pty.input('b\r\x04');
    await until(() => screen.includes('got: b') && prompts() >= 6);
    expect(tty.pty.fgPgrp).toBe(sh.pgid);
    await type('echo "fg $?"; jobs; echo end');
    expect(screen).toMatch(/fg 2\r\nend/);
    tty.pty.input('exit\r');
    expect(await sh.wait()).toBe(0);
  }, 30_000);
});
