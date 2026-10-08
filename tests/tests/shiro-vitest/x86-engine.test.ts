/**
 * Blink x86-64 engine (public/engines/blink, src/x86-engine): static Linux
 * ELF binaries run through the shell's normal `./binary` exec path.
 *
 * Fixtures: fixtures/x86/hello-musl is committed (38 KB). The Go and static
 * glibc builds of the same programs are made in beforeAll when `go` / `gcc`
 * are available, and those cases are skipped otherwise.
 */
import { describe, it, expect, onTestFinished, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import { join, resolve } from 'node:path';
import { createTestShell, run } from './helpers';

const FIX = resolve(__dirname, 'fixtures/x86');

function tryBuild(cmd: string, args: string[], env: Record<string, string> = {}): boolean {
  try {
    execFileSync(cmd, args, { cwd: FIX, env: { ...process.env, ...env }, stdio: 'pipe', timeout: 120_000 });
    return true;
  } catch {
    return false;
  }
}

const out = mkdtempSync(join(tmpdir(), 'shiro-x86-engine-'));
const goBin = join(out, 'hello-go');
const httpBin = join(out, 'nethttp');
const glibcBin = join(out, 'hello-glibc');
const goExe = existsSync('/usr/local/go/bin/go') ? '/usr/local/go/bin/go' : 'go';
const haveGo = tryBuild(goExe, ['build', '-ldflags=-s', '-o', goBin, 'hello.go'], { CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64', GOCACHE: join(out, 'gocache') });
const haveHttp = haveGo && tryBuild(goExe, ['build', '-ldflags=-s', '-o', httpBin, 'nethttp.go'], { CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64', GOCACHE: join(out, 'gocache') });
const tcpBin = join(out, 'tcpecho');
const haveTcp = haveGo && tryBuild(goExe, ['build', '-ldflags=-s', '-o', tcpBin, 'tcpecho.go'], { CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64', GOCACHE: join(out, 'gocache') });
const ttyBin = join(out, 'tty');
const haveTty = haveGo && tryBuild(goExe, ['build', '-ldflags=-s', '-o', ttyBin, 'tty.go'], { CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64', GOCACHE: join(out, 'gocache') });
const haveGlibc = tryBuild('gcc', ['-static', '-Os', '-o', glibcBin, 'hello.c']);

async function setup(bin: Uint8Array) {
  const { fs, shell } = await createTestShell();
  await fs.mkdir('/home/user/work', { recursive: true });
  await fs.writeFile('/home/user/work/prog', bin, { mode: 0o755 });
  await fs.writeFile('/home/user/work/input.txt', 'hi from shiro\n');
  await shell.execute('cd /home/user/work', () => {});
  return { fs, shell };
}

describe('x86 engine selection', () => {
  it('chooses blink in Node (SharedArrayBuffer available)', async () => {
    const { chooseX86Engine } = await import('@shiro/x86-engine');
    expect(await chooseX86Engine({})).toBe('blink');
    expect(await chooseX86Engine({ SHIRO_X86_ENGINE: 'x86' })).toBe('x86');
  });

  it('chooseElfRunner falls back when the old engine is forced', async () => {
    const { chooseElfRunner } = await import('@shiro/x86-engine');
    const fallback = async () => 7;
    expect(await chooseElfRunner('/bin/x', { SHIRO_X86_ENGINE: 'x86' }, () => fallback)).toBe(fallback);
    expect(await chooseElfRunner('/bin/x', {}, () => fallback)).not.toBe(fallback);
  });
});

describe('Blink engine: static C (musl)', () => {
  it('runs via ./prog with args, env, files, stdin and stderr', async () => {
    const { fs, shell } = await setup(readFileSync(join(FIX, 'hello-musl')));
    const r = await run(shell, 'echo "piped line" | FIXTURE_VAR=yes ./prog a "b c"');
    expect(r.output).toContain('hello from c');
    expect(r.output).toContain('arg1=a');
    expect(r.output).toContain('arg2=b c');
    expect(r.output).toContain('env=yes');
    expect(r.output).toContain('read=hi from shiro');
    expect(r.output).toContain('stdin=piped line');
    expect(r.exitCode).toBe(0);
    expect(await fs.readFile('/home/user/work/out-c.txt', 'utf8')).toBe('written by c\n');
  }, 60_000);

  it('returns the exit status', async () => {
    const { shell } = await setup(readFileSync(join(FIX, 'hello-musl')));
    const r = await run(shell, './prog fail < /dev/null; echo "status=$?"');
    expect(r.output).toContain('status=7');
  }, 60_000);
});

describe.skipIf(!haveGlibc)('Blink engine: static C (glibc)', () => {
  it('runs a static glibc binary', async () => {
    const { shell } = await setup(readFileSync(glibcBin));
    const r = await run(shell, 'echo x | ./prog q');
    expect(r.output).toContain('hello from c');
    expect(r.output).toContain('arg1=q');
    expect(r.exitCode).toBe(0);
  }, 60_000);
});

describe.skipIf(!haveGo)('Blink engine: static Go', () => {
  it('runs a Go binary with goroutines, file I/O and args', async () => {
    const { fs, shell } = await setup(readFileSync(goBin));
    const r = await run(shell, './prog one two');
    expect(r.output).toContain('hello from go');
    expect(r.output).toContain('args: [one two]');
    expect(r.output).toContain('read=hi from shiro');
    expect(r.output).toContain('goroutines=344015.127');
    expect(r.exitCode).toBe(0);
    expect(await fs.readFile('/home/user/work/out-go.txt', 'utf8')).toBe('written by go\n');
  }, 120_000);

  it('returns os.Exit status', async () => {
    const { shell } = await setup(readFileSync(goBin));
    const r = await run(shell, './prog fail; echo "status=$?"');
    expect(r.output).toContain('status=5');
  }, 120_000);
});

describe.skipIf(!haveHttp)('Blink engine: Go net/http over loopback', () => {
  it('serves and fetches 4 concurrent requests in one process', async () => {
    const { shell } = await setup(readFileSync(httpBin));
    const r = await run(shell, './prog');
    for (let i = 0; i < 4; i++) expect(r.output).toContain(`pong /${i}`);
    expect(r.exitCode).toBe(0);
  }, 120_000);
});

describe('Blink engine: kernel processes', () => {
  it('kernel.spawn() runs an ELF through the Blink loader', async () => {
    // Browsers refuse to decode views of a SharedArrayBuffer (Node doesn't);
    // make the page side behave like a browser here.
    const decode = TextDecoder.prototype.decode;
    TextDecoder.prototype.decode = function (input?: any, opts?: any) {
      if (input && input.buffer instanceof SharedArrayBuffer) throw new TypeError('The provided ArrayBufferView value must not be shared.');
      return decode.call(this, input, opts);
    };
    onTestFinished(() => { TextDecoder.prototype.decode = decode; });
    const { fs } = await setup(readFileSync(join(FIX, 'hello-musl')));
    const { Kernel } = await import('@shiro/kernel/kernel');
    const { BufferFile } = await import('@shiro/kernel/fd');
    const { registerBlinkLoader } = await import('@shiro/x86-engine/blink');
    const kernel = new Kernel({ fs, registerWithProcessTable: false });
    registerBlinkLoader(kernel);
    const out = new BufferFile(null);
    const p = kernel.spawn({ path: './prog', argv: ['prog', 'k'], cwd: '/home/user/work', fds: { 0: new BufferFile('from kernel\n'), 1: out, 2: out } });
    const status = await p.wait();
    expect(status).toBe(0);
    expect(out.text()).toContain('arg1=k');
    expect(out.text()).toContain('stdin=from kernel');
  }, 60_000);

  it('blocks on a pipe for stdin until input arrives', async () => {
    const { fs } = await setup(readFileSync(join(FIX, 'hello-musl')));
    const { Kernel } = await import('@shiro/kernel/kernel');
    const { BufferFile } = await import('@shiro/kernel/fd');
    const { createPipe } = await import('@shiro/kernel/pipe');
    const { blinkRunner } = await import('@shiro/x86-engine/blink');
    const kernel = new Kernel({ fs, registerWithProcessTable: false });
    const [r, w] = createPipe();
    const out = new BufferFile(null);
    const p = kernel.spawn({ path: '/home/user/work/prog', argv: ['prog'], cwd: '/home/user/work', fds: { 0: r, 1: out, 2: out }, run: blinkRunner('/home/user/work/prog') });
    await new Promise((res) => setTimeout(res, 1500));
    expect(p.exitStatus).toBeUndefined();          // still waiting on stdin
    await w.write(new TextEncoder().encode('late line\n'));
    await w.close();
    expect(await p.wait()).toBe(0);
    expect(out.text()).toContain('stdin=late line');
  }, 60_000);
});

describe.skipIf(!haveTcp)('Blink engine: real TCP through the kernel relay', () => {
  let harness: ChildProcess;
  let ports: { echoPort: number; relayA: number; origin: string };
  let restore: () => void = () => {};
  let doh: Server;

  beforeAll(async () => {
    const path = new URL('./fixtures/tcp-relay-harness.mjs', import.meta.url).pathname;
    harness = spawn('node', [path], { stdio: ['pipe', 'pipe', 'inherit'] });
    ports = await new Promise((resolve, reject) => {
      let buf = '';
      harness.stdout!.on('data', (d) => {
        buf += d;
        const line = buf.split('\n').find((l) => l.startsWith('{'));
        if (line) resolve(JSON.parse(line));
      });
      harness.once('exit', (c) => reject(new Error(`harness exited ${c}`)));
    });
    // Point the kernel's network stack at relay A (which may dial 127.0.0.1),
    // talking like a page on the allowed origin.
    const { netStack } = await import('@shiro/kernel/net');
    const origin = ports.origin;
    class OriginWebSocket extends WebSocket {
      constructor(url: string | URL) { super(url, { headers: { origin } } as any); }
    }
    // A DNS-over-HTTPS endpoint that answers A queries for echo.test.
    // node:http is polyfilled for the browser build in this config; use Node's.
    const { createServer } = (process as any).getBuiltinModule('http') as typeof import('node:http');
    doh = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (d) => parts.push(d));
      req.on('end', () => {
        const q = Buffer.concat(parts);
        let off = 12;
        while (q[off]) off += q[off] + 1;
        const qtype = q.readUInt16BE(off + 1);
        const question = q.subarray(12, off + 5);
        const name = q.subarray(12, off).toString('latin1');
        const hit = qtype === 1 && /echo.test$/.test(name.replace(/[\x00-\x1f]/g, '.'));
        const head = Buffer.from([q[0], q[1], 0x81, hit ? 0x80 : 0x83, 0, 1, 0, hit ? 1 : 0, 0, 0, 0, 0]);
        const answer = hit ? Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 127, 0, 0, 1]) : Buffer.alloc(0);
        res.writeHead(200, { 'content-type': 'application/dns-message' });
        res.end(Buffer.concat([head, question, answer]));
      });
    });
    const dohPort = await new Promise<number>((r) => doh.listen(0, '127.0.0.1', () => r((doh.address() as any).port)));
    const saved = { ...(netStack as any).config };
    netStack.configure({
      relayUrl: `ws://127.0.0.1:${ports.relayA}/tcp`,
      tokenUrl: `http://127.0.0.1:${ports.relayA}/tcp/token`,
      fetch: ((u: any, init: any = {}) => fetch(u, { ...init, headers: { ...(init.headers || {}), origin } })) as typeof fetch,
      WebSocket: OriginWebSocket as unknown as typeof WebSocket,
      relayLoopback: true,
      portHost: null,
      dohUrl: `http://127.0.0.1:${dohPort}/dns-query`,
    });
    restore = () => netStack.configure(saved);
  }, 30_000);

  afterAll(() => { restore(); harness?.kill(); doh?.close(); });

  it('a Go client reaches a TCP server outside the page', async () => {
    const { shell } = await setup(readFileSync(tcpBin));
    const r = await run(shell, `./prog 127.0.0.1:${ports.echoPort}`);
    expect(r.output).toContain('echo: ping from go');
    expect(r.output).toContain(`remote 127.0.0.1:${ports.echoPort}`);
    expect(r.exitCode).toBe(0);
  }, 120_000);

  it('resolves a name over UDP 53 (kernel DoH) and dials it', async () => {
    const { shell } = await setup(readFileSync(tcpBin));
    const r = await run(shell, `./prog echo.test:${ports.echoPort}`);
    expect(r.output).toContain('echo: ping from go');
    expect(r.exitCode).toBe(0);
  }, 120_000);
});


describe.skipIf(!haveTty)('Blink engine: interactive program on a kernel pty', () => {
  it('sees a tty, its size, raw keys without echo, SIGWINCH and Ctrl-C', async () => {
    const { fs } = await setup(readFileSync(ttyBin));
    const { Kernel } = await import('@shiro/kernel/kernel');
    const { TtySession, attachKernelTty } = await import('@shiro/kernel/pty');
    const { JobControl } = await import('@shiro/kernel/signals');
    const { blinkRunner } = await import('@shiro/x86-engine/blink');
    const kernel = new Kernel({ fs, registerWithProcessTable: false });
    const jc = new JobControl();
    attachKernelTty(kernel, jc);
    const tty = new TtySession({ jc });
    let screen = '';
    tty.pty.onOutput((b: Uint8Array) => { screen += new TextDecoder().decode(b); });
    tty.resize(33, 101);
    const until = async (re: RegExp, ms = 30_000) => {
      const t0 = Date.now();
      while (!re.test(screen)) {
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${re}; screen: ${JSON.stringify(screen)}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    const p = tty.spawnJob(kernel, { path: '/home/user/work/prog', argv: ['prog'], cwd: '/home/user/work', run: blinkRunner('/home/user/work/prog') });
    const done = tty.foreground({ pgid: p.pgid });
    await until(/raw: press a key/);
    expect(screen).toContain('tty rows=33 cols=101');
    tty.pty.input('x');
    await until(/key='x'/);
    expect(screen).not.toMatch(/key\r?\nx|^x/m);       // raw mode: no echo
    await until(/waiting for signals/);
    tty.resize(40, 120);
    await until(/got window changed/);
    tty.pty.input('\x03');
    await until(/got interrupt/);
    expect(await done).toEqual({ type: 'exited', status: 0 });
  }, 120_000);

  it('Ctrl-C ends a C program blocked reading the tty (no handler)', async () => {
    const { fs } = await setup(readFileSync(join(FIX, 'hello-musl')));
    const { Kernel } = await import('@shiro/kernel/kernel');
    const { TtySession, attachKernelTty } = await import('@shiro/kernel/pty');
    const { JobControl } = await import('@shiro/kernel/signals');
    const { shellExitCode } = await import('@shiro/kernel/abi');
    const { blinkRunner } = await import('@shiro/x86-engine/blink');
    const kernel = new Kernel({ fs, registerWithProcessTable: false });
    const jc = new JobControl();
    attachKernelTty(kernel, jc);
    const tty = new TtySession({ jc });
    let screen = '';
    tty.pty.onOutput((b: Uint8Array) => { screen += new TextDecoder().decode(b); });
    const p = tty.spawnJob(kernel, { path: '/home/user/work/prog', argv: ['prog'], cwd: '/home/user/work', run: blinkRunner('/home/user/work/prog') });
    const done = tty.foreground({ pgid: p.pgid });
    const t0 = Date.now();
    while (!/read=/.test(screen) && Date.now() - t0 < 30_000) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 300)); // now blocked in fgets(stdin)
    tty.pty.input('\x03');
    const r = await done;
    expect(r.type).toBe('exited');
    expect(shellExitCode((r as any).status)).toBe(130);
  }, 120_000);
});

// Blink patch 0011: the guest's fds and processes are the kernel's.
describe('Blink engine: kernel processes (fork, exec, pipes)', () => {
  it('fork+exec+wait, posix_spawn over a pipe, popen and system through /bin/sh', async () => {
    const { shell } = await setup(readFileSync(join(FIX, 'proc-musl')));
    const r = await run(shell, './prog');
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/child pid=\d+ ppid=\d+ arg=forked/);
    expect(r.output).toContain('fork: pid>0=1 exit=7');
    expect(r.output).toMatch(/spawn read: child pid=\d+ ppid=\d+ arg=spawned\r?\nspawn exit=7/);
    expect(r.output).toContain('popen: HELLO FROM SH');
    expect(r.output).toContain('pclose=0');
    expect(r.output).toContain('system=3');
    expect(r.output).toContain('execfail exit=42');
  }, 60_000);

  it('a writev is one write on a pipe; the guest sees kernel files and /dev/null', async () => {
    const { shell, fs } = await setup(readFileSync(join(FIX, 'proc-musl')));
    expect((await run(shell, './prog child x | od -c | head -3')).output).toContain('a   r   g   =   x  \\n');
    expect((await run(shell, './prog child y > out.txt 2>/dev/null; echo $?')).output.trim()).toBe('7');
    expect(await fs.readFile('/home/user/work/out.txt', 'utf8')).toMatch(/^child pid=\d+ ppid=\d+ arg=y\n$/);
  }, 60_000);
});
