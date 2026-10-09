/**
 * The prebuilt CPython package (`pkg install python3`, WASI, built by
 * scripts/pkgbuild/python3.sh) as a kernel process: tabcomputer issues #5
 * (cwd, `python3 -` on a pipe, subprocess, ssl/https) and #3 (CPython is the
 * default `python3`, installed on first use; Pyodide stays as `pyodide`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Worker } from 'node:worker_threads';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';
import type { GuestWorker } from '@shiro/kernel/worker-host';
import { setGuestWorkerFactory, forceWasmProcessMode } from '@shiro/wasi/host';
import { TtySession } from '@shiro/kernel/pty';
import { NetStack, installNet } from '@shiro/kernel/net';
import { kernelForContext } from '@shiro/wasi/run-command';
import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { cpython3Cmd, cpythonCmd, cpipCmd } from '@shiro/commands/python-default';

/** A terminal stand-in with a pty session (as in pkg.test.ts). */
function fakeTerminal() {
  const tty = new TtySession();
  let screen = '';
  tty.pty.onOutput((b) => { screen += new TextDecoder().decode(b); });
  return {
    tty,
    screen: () => screen,
    writeOutput: (t: string) => { screen += t; },
    enterStdinPassthrough() {}, exitStdinPassthrough() {}, enterRawMode() {}, exitRawMode() {},
    isRawMode: () => false, onResize: () => () => {},
    getSize: () => ({ rows: tty.pty.winsize.rows, cols: tty.pty.winsize.cols }),
    term: null,
  };
}

/** Run `cmd` at a terminal's prompt; what the terminal shows. */
async function onTerminal(shell: Shell, cmd: string): Promise<{ screen: string; exitCode: number }> {
  const term = fakeTerminal();
  const exitCode = await shell.execute(cmd, (s) => term.writeOutput(s), (s) => term.writeOutput(s), false, term as any);
  return { screen: term.screen().replace(/\r\n/g, '\n'), exitCode };
}

const here = __dirname;
const REPO = path.resolve(here, '../../..');
const srcWasi = path.join(REPO, 'src/wasi');
let tmp: string;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'shiro-cpython-'));
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
  // "/pkg/..." (the mirror) comes from public/pkg
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const m = url.match(/^https?:\/\/[^/]+(\/pkg\/.*)$/);
    if (m) {
      const file = `${REPO}/public${m[1]}`;
      return existsSync(file) ? new Response(readFileSync(file)) : new Response('not found', { status: 404 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
}, 120_000);

afterAll(() => {
  globalThis.fetch = realFetch;
  setGuestWorkerFactory(null);
  forceWasmProcessMode(null);
  rmSync(tmp, { recursive: true, force: true });
});

async function sh(shell: Shell, cmd: string) {
  let out = '', err = '';
  const exitCode = await shell.execute(cmd, s => { out += s; }, s => { err += s; });
  return { out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n'), exitCode };
}

/** The relay harness of kernel-wasix.test.ts: HTTP/HTTPS servers and a TCP relay reaching them. */
type Harness = { httpPort: number; httpsPort: number; relayPort: number; origin: string; certFile: string };
let harness: ChildProcess | undefined;
async function startHarness(): Promise<Harness> {
  const file = path.join(here, 'fixtures/wasix-net-harness.mjs');
  harness = spawnChild('node', [file], { stdio: ['pipe', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    let out = '';
    harness!.stdout!.on('data', (d) => {
      out += d;
      const line = out.split('\n').find((l) => l.startsWith('{'));
      if (line) resolve(JSON.parse(line));
    });
    harness!.once('exit', (c) => reject(new Error(`harness exited ${c}`)));
  });
}

/** Route the test shell's kernel sockets through the harness relay, like a page on its origin. */
function netThroughRelay(fs: FileSystem, shell: Shell, P: Harness) {
  const stack = new NetStack();
  const origin = P.origin;
  class OriginWebSocket extends WebSocket {
    constructor(url: string | URL) { super(url, { headers: { origin } } as any); }
  }
  stack.configure({
    relayUrl: `ws://127.0.0.1:${P.relayPort}/tcp`,
    tokenUrl: `http://127.0.0.1:${P.relayPort}/tcp/token`,
    fetch: ((u: any, init: any = {}) => realFetch(u, { ...init, headers: { ...(init.headers || {}), origin } })) as typeof fetch,
    WebSocket: OriginWebSocket as unknown as typeof WebSocket,
    relayLoopback: true, portHost: null, dohUrl: null,
  });
  installNet(kernelForContext({ fs, shell } as any), stack);
}

describe('python3 (CPython WASI package)', () => {
  let shell: Shell;
  let fs: FileSystem;
  beforeAll(async () => {
    ({ fs, shell } = await createTestShell());
    const r = await sh(shell, 'pkg install python3');
    expect(r.exitCode).toBe(0);
  }, 120_000);

  it('os.getcwd() is the shell\'s directory, and relative paths resolve there', async () => {
    const r = await sh(shell, `mkdir -p /tmp/pyc && cd /tmp/pyc && python3 -c 'import os; print(os.getcwd()); open("f", "w").write("x")' && cat /tmp/pyc/f`);
    expect(r.err).toBe('');
    expect(r.out).toBe('/tmp/pyc\nx');
  }, 60_000);

  it('`python3 -` reads the program from a pipe without the REPL; /dev/null is no tty', async () => {
    const r = await sh(shell, `printf 'import sys\\nprint("hi", sys.argv[1:])\\n' | python3 - arg`);
    expect(r.err).toBe('');
    expect(r.out).toBe("hi ['arg']\n");
    const n = await sh(shell, `python3 -c 'import sys; print(sys.stdin.isatty(), sys.stdout.isatty())' < /dev/null | cat`);
    expect(n.out).toBe('False False\n');
    // `python3 < /dev/null`: no banner, no prompt
    const e = await sh(shell, 'python3 < /dev/null');
    expect(e).toEqual({ out: '', err: '', exitCode: 0 });
  }, 60_000);

  it('subprocess runs programs (os.posix_spawn over WASIX)', async () => {
    const r = await sh(shell, `cd /tmp && python3 -c '
import subprocess, os
print(subprocess.run(["echo", "hi"], capture_output=True, text=True).stdout, end="")
print(subprocess.check_output("printf a; echo b | tr b c", shell=True, text=True))
os.makedirs("/tmp/sp", exist_ok=True)
print(subprocess.run(["pwd"], cwd="/tmp/sp", stdout=subprocess.PIPE).stdout.decode(), end="")
p = subprocess.Popen(["cat"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
print(p.communicate(b"via stdin")[0].decode(), p.returncode)
print(subprocess.call(["sh", "-c", "exit 3"]), os.getcwd())
try:
    subprocess.run(["no-such-program"])
except FileNotFoundError as e:
    print("FileNotFoundError")
'`);
    expect(r.err).toBe('');
    expect(r.out).toBe('hi\nac\n\n/tmp/sp\nvia stdin 0\n3 /tmp\nFileNotFoundError\n');
  }, 60_000);

  it('imports ssl (OpenSSL 3) and hashlib', async () => {
    const r = await sh(shell, `python3 -c 'import ssl, hashlib, socket; print(ssl.OPENSSL_VERSION.split()[:2], hashlib.sha256(b"x").hexdigest()[:8], hasattr(socket, "create_connection"))'`);
    expect(r.err).toBe('');
    expect(r.out).toBe("['OpenSSL', '3.5.4'] 2d711642 True\n");
  }, 60_000);

  describe('through the TCP relay', () => {
    let P: Harness;
    beforeAll(async () => {
      P = await startHarness();
      netThroughRelay(fs, shell, P);
      if (P.certFile) await fs.writeFile('/tmp/test-ca.pem', readFileSync(P.certFile));
    }, 30_000);
    afterAll(() => { harness?.kill(); });

    it('urllib fetches over HTTP, resolving the name through the relay', async () => {
      const r = await sh(shell, `python3 -c 'import urllib.request as u; print(u.urlopen("http://web.test:${P.httpPort}/py?q=1").read().decode(), end="")'`);
      expect(r.err).toBe('');
      expect(r.out).toBe('hello over http: GET /py?q=1\n');
    }, 60_000);

    it('urllib fetches over HTTPS, verifying the certificate', async (t) => {
      if (!P.httpsPort) return t.skip();
      const r = await sh(shell, `SSL_CERT_FILE=/tmp/test-ca.pem python3 -c 'import urllib.request as u; print(u.urlopen("https://web.test:${P.httpsPort}/secure").read().decode(), end="")'`);
      expect(r.err).toBe('');
      expect(r.out).toBe('hello over https: GET /secure\n');
      // Without the CA the self-signed certificate is refused
      const bad = await sh(shell, `python3 -c 'import urllib.request as u; u.urlopen("https://web.test:${P.httpsPort}/")'`);
      expect(bad.exitCode).toBe(1);
      expect(bad.err).toContain('CERTIFICATE_VERIFY_FAILED');
    }, 60_000);
  });
});

describe('CPython as the default python3 (profile shims.python = "cpython")', () => {
  it('installs the python3 package on first use, saying so on the terminal only', async () => {
    const { fs, shell } = await createTestShell();
    for (const c of [cpythonCmd, cpython3Cmd, cpipCmd]) shell.commands.register(c);
    // Test shells share storage: start without the package
    expect((await sh(shell, 'pkg remove python3')).exitCode).toBe(0);
    expect(await fs.exists('/usr/lib/pkg/python3/bin/python3.wasm')).toBe(false);
    const first = await onTerminal(shell, `python3 -c 'import sys; print(sys.implementation.name, sys.platform)'`);
    expect(first.exitCode).toBe(0);
    expect(first.screen).toContain('installing CPython');
    expect(first.screen).toContain('cpython wasi\n');
    expect(await fs.exists('/usr/lib/pkg/python3/bin/python3.wasm')).toBe(true);
    // Installed: no notice, and scripts' output is clean
    const again = await sh(shell, `python -c 'print(6 * 7)'`);
    expect(again).toEqual({ out: '42\n', err: '', exitCode: 0 });
  }, 120_000);
});
