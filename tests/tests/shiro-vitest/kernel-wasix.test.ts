/**
 * WASIX runtime features in the kernel guest (src/wasi/): fork and
 * setjmp/longjmp through asyncify stack capture, real exec, signals, and
 * the real packages that needed them (dash, bash).
 *
 * The packages come from Wasmer's CDN once and are cached in
 * tests/.pkg-cache (shared with pkg.test.ts); offline, these tests skip.
 * Guests run in Node worker_threads (SAB + Atomics.wait), as in
 * kernel-wasi.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Worker } from 'node:worker_threads';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { createTestShell } from './helpers';
import type { FileSystem } from '@shiro/filesystem';
import type { Shell } from '@shiro/shell';
import { Kernel } from '@shiro/kernel/kernel';
import { createPipe } from '@shiro/kernel/pipe';
import { BufferFile, type OpenFile } from '@shiro/kernel/fd';
import type { GuestWorker } from '@shiro/kernel/worker-host';
import { WEXITSTATUS, WIFSIGNALED, WTERMSIG, SIGINT } from '@shiro/kernel/abi';
import { installWasmLoader, setGuestWorkerFactory, forceWasmProcessMode } from '@shiro/wasi/host';
import { SinkFile } from '@shiro/wasi/stdio';
import { parseWebc } from '@shiro/webc';
import { TtySession } from '@shiro/kernel/pty';

const here = __dirname;
const srcWasi = path.resolve(here, '../../../src/wasi');
const CACHE = path.resolve(here, '../../.pkg-cache');

/** WebC containers used here: sha256 (= CDN file name) and the atom to take. */
const PACKAGES: Record<string, { sha: string; atom: string }> = {
  dash: { sha: 'c81513a53f11a2a23ea305fa008049d15fa1b5f52b696cedbf63554077ea5998', atom: 'dash' },
  bash: { sha: '059606d132e2e6bc1afe3b432ee64dcb1b1b059815c8bb213cf3b24798ef21e1', atom: 'bash' },
  php: { sha: 'da8d3fcfcf02d2401787532c4af3fdaf5b680b05144a9591ca70b97131ee2f32', atom: 'php' },
};

let tmp: string;
const atoms = new Map<string, Uint8Array>();

/** The package's WASM (downloaded once into tests/.pkg-cache), or null offline. */
async function pkgWasm(name: string): Promise<Uint8Array | null> {
  if (atoms.has(name)) return atoms.get(name)!;
  const { sha, atom } = PACKAGES[name];
  const file = path.join(CACHE, `${sha}.webc`);
  if (!existsSync(file)) {
    try {
      const resp = await fetch(`https://cdn.wasmer.io/webcimages/${sha}.webc`);
      if (!resp.ok) return null;
      mkdirSync(CACHE, { recursive: true });
      writeFileSync(file, new Uint8Array(await resp.arrayBuffer()));
    } catch {
      return null;
    }
  }
  const bytes = parseWebc(new Uint8Array(readFileSync(file))).atoms.get(atom) ?? null;
  if (bytes) atoms.set(name, bytes);
  return bytes;
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'shiro-kwasix-'));
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
}, 60_000);

afterAll(() => {
  setGuestWorkerFactory(null);
  forceWasmProcessMode(null);
  rmSync(tmp, { recursive: true, force: true });
});

async function setup(names: string[]): Promise<{ fs: FileSystem; shell: Shell; kernel: Kernel } | null> {
  const { fs, shell } = await createTestShell();
  await fs.mkdir('/usr/bin', { recursive: true });
  for (const n of names) {
    const wasm = await pkgWasm(n);
    if (!wasm) return null;
    await fs.writeFile(`/usr/bin/${n}`, wasm);
  }
  const kernel = new Kernel({ fs, shell, registerWithProcessTable: false });
  installWasmLoader(kernel);
  return { fs, shell, kernel };
}

function collector() {
  let text = '';
  const sink = new SinkFile((t) => { text += t; });
  return { sink, get text() { return text; } };
}

const empty = () => new BufferFile('', 0);

function spawn(kernel: Kernel, argv: string[], fds: Record<number, OpenFile>, cwd = '/home/user') {
  return kernel.spawn({ path: argv[0], argv, env: { PATH: '/usr/bin:/bin', HOME: '/home/user' }, cwd, fds });
}

/** Run `sh -c script` with the given shell; output and exit code. */
async function run(kernel: Kernel, sh: string, script: string, stdin: OpenFile = empty()) {
  const out = collector();
  const err = collector();
  const proc = spawn(kernel, [sh, '-c', script], { 0: stdin, 1: out.sink, 2: err.sink });
  const status = await proc.wait();
  return { out: out.text, err: err.text, status, code: WIFSIGNALED(status) ? 128 + WTERMSIG(status) : WEXITSTATUS(status) };
}

describe('WASIX dash', () => {
  it('runs commands, $(...), pipelines, subshells and exit codes (fork, setjmp, exec)', async (t) => {
    const env = await setup(['dash']);
    if (!env) return t.skip();
    const r = await run(env.kernel, 'dash', 'echo hi; x=$(echo sub); echo "got $x"; (exit 3); echo "status $?"; '
      + 'for i in 1 2 3; do echo $i; done | tr 1 x | cat; f() { return 4; }; f; echo "fn $?"');
    expect(r.err).toBe('');
    expect(r.out).toBe('hi\ngot sub\nstatus 3\nx\n2\n3\nfn 4\n');
    expect(r.code).toBe(0);
    expect((await run(env.kernel, 'dash', 'exit 7')).code).toBe(7);
  }, 60_000);

  it('runs Shiro builtins found on PATH, nested shells, files and redirects', async (t) => {
    const env = await setup(['dash']);
    if (!env) return t.skip();
    const r = await run(env.kernel, 'dash', 'cd /tmp && echo hi > f.txt && cat f.txt && wc -c < f.txt | tr -d " "; '
      + 'ls /usr/bin | grep -c dash; /usr/bin/dash -c "echo nested; exit 2"; echo "nested $?"; ls /nope 2>/dev/null || echo missing');
    expect(r.out).toBe('hi\n3\n1\nnested\nnested 2\nmissing\n');
  }, 60_000);

  it('`wait` sees background children (SIGCHLD reaches a guest spinning in sigsuspend)', async (t) => {
    const env = await setup(['dash']);
    if (!env) return t.skip();
    const t0 = Date.now();
    const r = await run(env.kernel, 'dash', 'sleep 0.2 & echo started; wait $!; echo "rc $?"; (exit 3) & wait $!; echo "rc $?"');
    expect(r.out).toBe('started\nrc 0\nrc 3\n');
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 60_000);

  it('a signal with the default action ends the shell by that signal, without libc\'s "Program recieved" message', async (t) => {
    const env = await setup(['dash']);
    if (!env) return t.skip();
    for (const sig of ['TERM', 'USR1', 'HUP']) {
      const r = await run(env.kernel, 'dash', `echo up; kill -${sig} $$; echo after`);
      expect(r.out).toBe('up\n');
      expect(r.err).toBe('');
      expect(WIFSIGNALED(r.status)).toBe(true);
    }
    // trapped instead: the handler runs and the shell goes on
    const r = await run(env.kernel, 'dash', 'trap "echo caught" USR1; kill -USR1 $$; echo after');
    expect(r.out).toBe('caught\nafter\n');
  }, 60_000);
});

describe('WASIX bash', () => {
  it('runs scripts with arrays, [[ ]], functions, pipelines, $(...) and exported variables', async (t) => {
    const env = await setup(['bash', 'dash']);
    if (!env) return t.skip();
    const r = await run(env.kernel, 'bash', 'arr=(a b c); echo ${#arr[@]} ${arr[1]}; [[ abc == a* ]] && echo glob; '
      + 'f() { local v=$1; echo "f $v"; }; f 7; x=$(echo sub | tr a-z A-Z); echo $x; (exit 9); echo $?; '
      + 'export FOO=bar; bash -c \'echo "child $FOO"\'; true & wait; echo waited');
    expect(r.err).toBe('');
    expect(r.out).toBe('3 b\nglob\nf 7\nSUB\n9\nchild bar\nwaited\n');
  }, 60_000);
});

describe('WASIX php (86 MB, network once)', () => {
  it('runs code, exceptions and a fatal error (zend_bailout longjmps)', async (t) => {
    const env = await setup(['php']);
    if (!env) return t.skip();
    const out = collector();
    const proc = spawn(env.kernel, ['php', '-r', 'echo 6*7, "\\n"; try { throw new Exception("boom"); } catch (Exception $e) { echo $e->getMessage(), "\\n"; } echo intdiv(7, 0);'],
      { 0: empty(), 1: out.sink, 2: out.sink });
    expect(WEXITSTATUS(await proc.wait())).toBe(255);
    expect(out.text).toMatch(/^42\nboom\n\nFatal error: Uncaught DivisionByZeroError: Division by zero/);
  }, 120_000);
});

// ── through the shell: pkg install, the prompt's pty ─────────────────

const realFetch = globalThis.fetch;
/** Registry downloads from tests/.pkg-cache (filled by pkgWasm). */
async function cachedFetch(input: any): Promise<Response> {
  const url = String(input);
  const m = url.match(/^https:\/\/cdn\.wasmer\.io\/webcimages\/([0-9a-f]{64})\.webc$/);
  if (m && existsSync(path.join(CACHE, `${m[1]}.webc`))) return new Response(readFileSync(path.join(CACHE, `${m[1]}.webc`)));
  return realFetch(input);
}

/** A terminal stand-in with a pty session (as in pkg.test.ts). */
function fakeTerminal() {
  const tty = new TtySession();
  let screen = '';
  tty.pty.onOutput((b) => { screen += new TextDecoder().decode(b); });
  return {
    tty,
    screen: () => screen,
    clear: () => { screen = ''; },
    writeOutput: (t: string) => { screen += t; },
    enterStdinPassthrough() {}, exitStdinPassthrough() {}, enterRawMode() {}, exitRawMode() {},
    isRawMode: () => false, onResize: () => () => {},
    getSize: () => ({ rows: tty.pty.winsize.rows, cols: tty.pty.winsize.cols }),
    term: null,
  };
}

async function until(cond: () => boolean, ms = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 5));
  }
}

async function sh(shell: Shell, cmd: string) {
  let out = '', err = '';
  const exitCode = await shell.execute(cmd, s => { out += s; }, s => { err += s; });
  return { out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n'), exitCode };
}

describe('WASIX shells from the prompt', () => {
  it('pkg installs dash and bash (no longer gated) and runs them interactively on the pty', async (t) => {
    if (!(await pkgWasm('dash')) || !(await pkgWasm('bash'))) return t.skip();
    vi.stubGlobal('fetch', vi.fn(cachedFetch));
    try {
      const { shell } = await createTestShell();
      const inst = await sh(shell, 'pkg install dash bash');
      expect(inst.err).toBe('');
      expect(inst.exitCode).toBe(0);
      expect((await sh(shell, `/usr/bin/dash -c 'echo $(echo ok) | tr o O'`)).out).toBe('Ok\n');
      // Absolute paths resolve through the "/" preopen (no per-directory preopens for WASIX libcs)
      expect((await sh(shell, `/usr/bin/dash -c 'test -d /home/user && test -e /usr/bin/bash && echo paths-ok'`)).out).toBe('paths-ok\n');

      let term = fakeTerminal();
      let r = shell.execute('/usr/bin/dash', () => {}, () => {}, false, term);
      await until(() => term.tty.jobInForeground && /[$#] $/.test(term.screen())).catch((e) => { throw new Error(e.message + ' fg=' + term.tty.jobInForeground + ' screen=' + JSON.stringify(term.screen())); });
      term.clear();
      term.tty.pty.input('echo $((6*7)) | tr 4 X; x=$(echo sub); echo "[$x]"\r');
      await until(() => term.screen().includes('[sub]'));
      expect(term.screen()).toContain('X2');
      // ^C interrupts the foreground child; dash survives and prompts again
      term.clear();
      term.tty.pty.input('sleep 30; echo not-reached\r');
      await new Promise(res => setTimeout(res, 300));
      const t0 = Date.now();
      term.tty.pty.input('\x03');
      await until(() => /[$#] $/.test(term.screen()));
      expect(Date.now() - t0).toBeLessThan(5000);
      term.clear();
      term.tty.pty.input('echo alive $?\r');
      await until(() => term.screen().includes('alive 130'));
      expect(term.screen()).not.toContain('not-reached');
      expect(term.screen()).not.toContain('Program recieved');
      // ^C at the prompt drops the line (dash longjmps back to its main loop)
      term.clear();
      term.tty.pty.input('echo half-typed');
      term.tty.pty.input('\x03');
      await until(() => /[$#] $/.test(term.screen()));
      term.tty.pty.input('echo next\r');
      await until(() => term.screen().includes('next\r\n'));
      expect(term.screen()).not.toContain('half-typed\r\n');
      term.tty.pty.input('exit 5\r');
      expect(await r).toBe(5);

      term = fakeTerminal();
      r = shell.execute('/usr/bin/bash', () => {}, () => {}, false, term);
      await until(() => term.tty.jobInForeground && /[$#] $/.test(term.screen()), 30_000);
      term.clear();
      term.tty.pty.input('for i in a b; do echo "it-$i"; done | cat\r');
      await until(() => term.screen().includes('it-b'));
      term.clear();
      term.tty.pty.input('sleep 30\r');
      await new Promise(res => setTimeout(res, 300));
      term.tty.pty.input('\x03');
      await until(() => /[$#] $/.test(term.screen()));
      term.clear();
      term.tty.pty.input('echo alive $?\r');
      await until(() => term.screen().includes('alive 130'));
      term.tty.pty.input('exit\r');
      expect(await r).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 120_000);
});
