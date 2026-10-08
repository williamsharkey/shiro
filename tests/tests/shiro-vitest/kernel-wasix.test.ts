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
import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { NetStack, installNet } from '@shiro/kernel/net';
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
  curl: { sha: 'ae64ae867b8272abac2d660c374220b3fae13b5e4299d25aae05e2b89607ac02', atom: 'curl' },
  python: { sha: 'a9fa8202f1bf6a4eca8d31ee5f2b1970c8f45af5c5520cc954d28a133333d8e7', atom: 'python' },
  clang: { sha: 'c127b7bfc0041d02c94045f40be7fb4b3eeb98cede25fad96261b7b90a82f405', atom: 'clang-16-slim' },
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
  // Not /usr/bin: test shells share one filesystem, and pkg install won't replace a regular file there
  await fs.mkdir('/opt/wasix', { recursive: true });
  for (const n of names) {
    const wasm = await pkgWasm(n);
    if (!wasm) return null;
    await fs.writeFile(`/opt/wasix/${n}`, wasm);
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
  return kernel.spawn({ path: argv[0], argv, env: { PATH: '/opt/wasix:/usr/bin:/bin', HOME: '/home/user' }, cwd, fds });
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
      + 'ls /opt/wasix | grep -c dash; /opt/wasix/dash -c "echo nested; exit 2"; echo "nested $?"; ls /nope 2>/dev/null || echo missing');
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

describe('WASIX sockets: curl through the TCP relay', () => {
  let harness: ChildProcess | undefined;
  let P: { httpPort: number; httpsPort: number; relayPort: number; origin: string };

  beforeAll(async () => {
    const file = new URL('./fixtures/wasix-net-harness.mjs', import.meta.url).pathname;
    harness = spawnChild('node', [file], { stdio: ['pipe', 'pipe', 'inherit'] });
    P = await new Promise((resolve, reject) => {
      let out = '';
      harness!.stdout!.on('data', (d) => {
        out += d;
        const line = out.split('\n').find((l) => l.startsWith('{'));
        if (line) resolve(JSON.parse(line));
      });
      harness!.once('exit', (c) => reject(new Error(`harness exited ${c}`)));
    });
  }, 30_000);
  afterAll(() => { harness?.kill(); });

  /** A kernel whose sockets go through the harness relay, like a page on its origin. */
  async function netSetup() {
    const env = await setup(['curl']);
    if (!env) return null;
    const stack = new NetStack();
    const origin = P.origin;
    class OriginWebSocket extends WebSocket {
      constructor(url: string | URL) { super(url, { headers: { origin } } as any); }
    }
    stack.configure({
      relayUrl: `ws://127.0.0.1:${P.relayPort}/tcp`,
      tokenUrl: `http://127.0.0.1:${P.relayPort}/tcp/token`,
      fetch: ((u: any, init: any = {}) => fetch(u, { ...init, headers: { ...(init.headers || {}), origin } })) as typeof fetch,
      WebSocket: OriginWebSocket as unknown as typeof WebSocket,
      relayLoopback: true, portHost: null, dohUrl: null,
    });
    installNet(env.kernel, stack);
    return env;
  }

  async function curl(kernel: Kernel, args: string[]) {
    const out = collector();
    const err = collector();
    const proc = spawn(kernel, ['curl', ...args], { 0: empty(), 1: out.sink, 2: err.sink });
    const status = await proc.wait();
    return { out: out.text, err: err.text, code: WEXITSTATUS(status), status };
  }

  it('fetches over HTTP, resolving the name through the relay', async (t) => {
    const env = await netSetup();
    if (!env) return t.skip();
    const r = await curl(env.kernel, ['-sS', `http://web.test:${P.httpPort}/path?q=1`]);
    expect(r.err).toBe('');
    expect(r.out).toBe('hello over http: GET /path?q=1\n');
    const post = await curl(env.kernel, ['-sS', '-d', 'x=1', '-i', `http://127.0.0.1:${P.httpPort}/form`]);
    expect(post.out).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    expect(post.out).toContain('x-scheme: http');
    expect(post.out).toContain('hello over http: POST /form body=x=1\n');
    const nx = await curl(env.kernel, ['-sS', `http://nx.test:${P.httpPort}/`]);
    expect(nx.code).toBe(6); // CURLE_COULDNT_RESOLVE_HOST
  }, 60_000);

  it('fetches over HTTPS (OpenSSL in the guest, TLS end to end through the relay)', async (t) => {
    const env = await netSetup();
    if (!env || !P.httpsPort) return t.skip();
    const r = await curl(env.kernel, ['-sSk', `https://web.test:${P.httpsPort}/secure`]);
    expect(r.err).toBe('');
    expect(r.out).toBe('hello over https: GET /secure\n');
    // Without -k the self-signed certificate is refused
    expect((await curl(env.kernel, ['-sS', `https://web.test:${P.httpsPort}/`])).code).toBe(60);
  }, 60_000);
});

describe('WASIX python: a position-independent (dylink.0) module (62 MB, network once)', () => {
  it('runs -c and imports stdlib modules (PYTHONHOME on a copy of its library volume)', async (t) => {
    const env = await setup(['python']);
    if (!env) return t.skip();
    const sha = PACKAGES.python.sha;
    const vol = [...parseWebc(new Uint8Array(readFileSync(path.join(CACHE, `${sha}.webc`)))).volumes.entries()]
      .find(([n]) => n.includes('python3-static'))![1];
    for (const f of vol.files) {
      await env.fs.mkdir(path.posix.dirname(`/opt/py${f.path}`), { recursive: true });
      await env.fs.writeFile(`/opt/py${f.path}`, f.data);
    }
    const out = collector();
    const err = collector();
    const proc = env.kernel.spawn({
      path: 'python', argv: ['python', '-c', 'import json, os, sys; print(1); print(json.dumps({"v": sys.version_info[:2]}), os.getcwd())'],
      env: { PATH: '/opt/wasix:/usr/bin', HOME: '/home/user', PYTHONHOME: '/opt/py' }, cwd: '/tmp', fds: { 0: empty(), 1: out.sink, 2: err.sink },
    });
    const status = await proc.wait();
    expect(err.text).toBe('');
    expect(out.text).toBe('1\n{"v": [3, 13]} /tmp\n');
    expect(WEXITSTATUS(status)).toBe(0);
  }, 180_000);
});

describe('package mounts', () => {
  it('pkg-installed python finds its standard library at its /nix/store prefix', async (t) => {
    if (!(await pkgWasm('python'))) return t.skip();
    vi.stubGlobal('fetch', vi.fn(cachedFetch));
    try {
      const { shell } = await createTestShell();
      const inst = await sh(shell, 'pkg install python');
      expect(inst.err).toBe('');
      const r = await sh(shell, `cd /tmp && python3.13 -c 'import json, zoneinfo, sys; print(json.dumps(sys.prefix.startswith("/nix/store")), zoneinfo.ZoneInfo("Europe/Paris").key)'`);
      expect(r.err).toBe('');
      expect(r.out).toBe('true Europe/Paris\n');
    } finally {
      vi.unstubAllGlobals();
    }
  }, 300_000);

  it('curl reads its CA directory at /openssl', async (t) => {
    if (!(await pkgWasm('curl'))) return t.skip();
    vi.stubGlobal('fetch', vi.fn(cachedFetch));
    try {
      const { shell } = await createTestShell();
      expect((await sh(shell, 'pkg install curl')).exitCode).toBe(0);
      // /usr/bin/curl: the package doesn't take the name from Shiro's builtin curl
      const r = await sh(shell, '/usr/bin/curl -sS file:///openssl/ssl/certs/002c0b4f.0 | head -1');
      expect(r.out).toBe('-----BEGIN CERTIFICATE-----\n');
    } finally {
      vi.unstubAllGlobals();
    }
  }, 120_000);
});

describe('WASIX clang (111 MB, network once)', () => {
  it('compiles and links hello.c to wasm inside Shiro, and the result runs', async (t) => {
    if (!(await pkgWasm('clang'))) return t.skip();
    vi.stubGlobal('fetch', vi.fn(cachedFetch));
    try {
      const { shell, fs } = await createTestShell();
      const inst = await sh(shell, 'pkg install clang');
      expect(inst.err).toBe('');
      await fs.writeFile('/tmp/hello.c', '#include <stdio.h>\nint main(int argc, char **argv) { printf("hello from clang, %d args\\n", argc); return 3; }\n');
      const cc = await sh(shell, 'cd /tmp && clang hello.c -o hello.wasm');
      expect(cc).toMatchObject({ err: '', exitCode: 0 });
      const run = await sh(shell, 'cd /tmp && wasi run hello.wasm a b');
      expect(run.out).toBe('hello from clang, 3 args\n');
      expect(run.exitCode).toBe(3);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 600_000);
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
