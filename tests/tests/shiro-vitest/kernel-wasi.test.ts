/**
 * WASM programs as kernel processes (src/wasi/): blocking syscalls over the
 * SharedArrayBuffer channel, pipes between WASM processes, wasi-threads,
 * and WASIX proc_spawn running Shiro builtins.
 *
 * Guests run in Node worker_threads (they have SAB + Atomics.wait). The
 * test programs are freestanding C in fixtures/wasi (rebuild: build.sh).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Worker } from 'node:worker_threads';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { build } from 'esbuild';
import { createTestShell, createTestOS } from './helpers';
import type { FileSystem } from '@shiro/filesystem';
import type { Shell } from '@shiro/shell';
import { Kernel } from '@shiro/kernel/kernel';
import { createPipe } from '@shiro/kernel/pipe';
import { BufferFile, type OpenFile } from '@shiro/kernel/fd';
import type { GuestWorker } from '@shiro/kernel/worker-host';
import { shellExitCode, W_EXITCODE, WEXITSTATUS, SIGINT } from '@shiro/kernel/abi';
import { installWasmLoader, setGuestWorkerFactory, forceWasmProcessMode } from '@shiro/wasi/host';
import { SinkFile, TtyFile } from '@shiro/wasi/stdio';

// node:url and node:os are browser-polyfilled in this vitest config
const here = __dirname;
const fixtures = path.join(here, 'fixtures', 'wasi');
const srcWasi = path.resolve(here, '../../../src/wasi');
const PROGRAMS = ['readloop', 'seq', 'upper', 'cat', 'threads', 'spawn'];

let tmp: string;
let workerFile: string;
/** A Go GOOS=wasip1 build of fixtures/wasi/gotest, when Go is installed. */
let goWasm: Uint8Array | null = null;

function findGo(): string | null {
  for (const p of [process.env.GOROOT && path.join(process.env.GOROOT, 'bin/go'), '/usr/local/go/bin/go', '/usr/bin/go']) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'shiro-kwasi-'));
  const entry = path.join(tmp, 'entry.ts');
  writeFileSync(entry, `
    import { parentPort } from 'node:worker_threads';
    import { guestMain } from ${JSON.stringify(path.join(srcWasi, 'guest-worker.ts'))};
    const port: any = { postMessage: (m: unknown) => parentPort!.postMessage(m), onmessage: null };
    parentPort!.on('message', (data) => port.onmessage && port.onmessage({ data }));
    guestMain(port);
  `);
  workerFile = path.join(tmp, 'guest-worker.mjs');
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

  const go = findGo();
  if (go) {
    const out = path.join(tmp, 'gotest.wasm');
    try {
      execFileSync(go, ['build', '-o', out, '.'], {
        cwd: path.join(fixtures, 'gotest'),
        env: { ...process.env, GOOS: 'wasip1', GOARCH: 'wasm', GOFLAGS: '-mod=mod', GOTOOLCHAIN: 'local' },
        stdio: 'pipe',
      });
      goWasm = new Uint8Array(readFileSync(out));
    } catch (e: any) {
      console.warn('kernel-wasi: Go wasip1 build failed, skipping Go tests:', e?.stderr?.toString() ?? e);
    }
  }
}, 120_000);

afterAll(() => {
  setGuestWorkerFactory(null);
  forceWasmProcessMode(null);
  rmSync(tmp, { recursive: true, force: true });
});

async function setup(): Promise<{ fs: FileSystem; shell: Shell; kernel: Kernel }> {
  const { fs, shell } = await createTestShell();
  await fs.mkdir('/opt/wasi', { recursive: true });
  for (const p of PROGRAMS) await fs.writeFile(`/opt/wasi/${p}.wasm`, new Uint8Array(readFileSync(path.join(fixtures, `${p}.wasm`))));
  const kernel = new Kernel({ fs, shell, registerWithProcessTable: false });
  installWasmLoader(kernel);
  return { fs, shell, kernel };
}

function collector() {
  let text = '';
  const sink = new SinkFile((t) => { text += t; });
  return { sink, get text() { return text; } };
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 5));
  }
}

const enc = (s: string) => new TextEncoder().encode(s);

const empty = () => new BufferFile('', 0);

function spawn(kernel: Kernel, argv: string[], fds: Record<number, OpenFile>, cwd = '/home/user') {
  return kernel.spawn({ path: argv[0], argv, env: { PATH: '/opt/wasi:/usr/bin', HOME: '/home/user' }, cwd, fds });
}

describe('kernel WASI processes', () => {
  it('blocks fd_read on an empty pipe and wakes per line', async () => {
    const { kernel } = await setup();
    const [r, w] = createPipe();
    const out = collector();
    const proc = spawn(kernel, ['/opt/wasi/readloop.wasm'], { 0: r, 1: out.sink, 2: out.sink });

    await w.write(enc('hello\n'));
    await until(() => out.text.includes('got: hello\n'));
    // Still running: its next read is blocked in the kernel, not at EOF
    await new Promise(res => setTimeout(res, 100));
    expect(proc.exiting).toBe(false);
    expect(out.text).not.toContain('lines:');

    await w.write(enc('world\n'));
    await until(() => out.text.includes('got: world\n'));
    await w.close();
    const status = await proc.wait();
    expect(out.text).toBe('got: hello\ngot: world\nlines: 2\n');
    expect(WEXITSTATUS(status)).toBe(2);
  });

  it('reads a cooked terminal line by line, ^D is EOF', async () => {
    const { kernel } = await setup();
    let screen = '';
    const tty = new TtyFile({ output: (t) => { screen += t; }, signal: () => {} });
    const proc = spawn(kernel, ['/opt/wasi/readloop.wasm'], { 0: tty, 1: tty, 2: tty });
    tty.input('ab');
    tty.input('\x7fc\r');           // backspace then Enter: line is "ac"
    await until(() => screen.includes('got: ac\r\n'));
    expect(proc.exiting).toBe(false);
    tty.input('\x04');               // ^D on an empty line
    expect(shellExitCode(await proc.wait())).toBe(1);
    expect(screen).toContain('lines: 1\r\n');
  });

  it('pipes one WASM process into another with backpressure', async () => {
    const { kernel } = await setup();
    const [r, w] = createPipe();
    const out = collector();
    const err = collector();
    // ~110 KB through a 64 KB pipe: the writer has to block until upper drains it
    const producer = spawn(kernel, ['seq', '10000'], { 0: empty(), 1: w, 2: err.sink });
    const consumer = spawn(kernel, ['upper'], { 0: r, 1: out.sink, 2: err.sink });
    // Each end is referenced only by the fd table it was installed in
    expect(await producer.wait()).toBe(W_EXITCODE(0));
    expect(await consumer.wait()).toBe(W_EXITCODE(0));
    const lines = out.text.trimEnd().split('\n');
    expect(lines.length).toBe(10000);
    expect(lines[0]).toBe('LINE 1');
    expect(lines[9999]).toBe('LINE 10000');
    expect(err.text).toBe(`bytes: ${out.text.length}\n`);
  });

  it('runs a wasi-threads program with shared memory and futex waits', async () => {
    const { kernel } = await setup();
    const out = collector();
    const proc = spawn(kernel, ['threads'], { 0: empty(), 1: out.sink, 2: out.sink });
    expect(await proc.wait()).toBe(W_EXITCODE(0));
    expect(out.text).toBe('counter: 40000\n');
  });

  it('opens, reads and writes files on demand (no preloading)', async () => {
    const { fs, kernel } = await setup();
    await fs.mkdir('/tmp/deep/a/b/c/d', { recursive: true });
    const body = 'x'.repeat(5000) + '\nend\n';
    await fs.writeFile('/tmp/deep/a/b/c/d/in.txt', body);
    const out = collector();
    const proc = spawn(kernel, ['cat', '/tmp/deep/a/b/c/d/in.txt', '/tmp/out.txt'], { 0: empty(), 1: out.sink, 2: out.sink });
    expect(await proc.wait()).toBe(W_EXITCODE(0));
    expect(out.text).toBe(body);
    expect(await fs.readFile('/tmp/out.txt', 'utf8')).toBe(`copied ${body.length}\n`);
  });

  it('spawns ls (a Shiro builtin) with proc_spawn3 and reads it through a pipe', async () => {
    const { fs, kernel } = await setup();
    await fs.mkdir('/tmp/sp', { recursive: true });
    await fs.writeFile('/tmp/sp/alpha.txt', '1');
    await fs.writeFile('/tmp/sp/beta.txt', '2');
    const out = collector();
    const proc = spawn(kernel, ['spawn', 'ls', '/tmp/sp'], { 0: empty(), 1: out.sink, 2: out.sink });
    expect(await proc.wait()).toBe(W_EXITCODE(0));
    // ls sees a pipe: one name per line, plain \n endings
    expect(out.text.replace(/child: /g, '')).toBe('alpha.txt\nbeta.txt\nstatus: 0\n');
  });

  it('spawns a WASM child and reports its exit status; unknown programs fail with ENOENT', async () => {
    const { kernel } = await setup();
    const out = collector();
    const proc = spawn(kernel, ['spawn', 'seq', '3'], { 0: empty(), 1: out.sink, 2: out.sink });
    expect(await proc.wait()).toBe(W_EXITCODE(0));
    expect(out.text.replace(/child: /g, '')).toBe('line 1\nline 2\nline 3\nstatus: 0\n');

    const out2 = collector();
    const p2 = spawn(kernel, ['spawn', 'no-such-program'], { 0: empty(), 1: out2.sink, 2: out2.sink });
    expect(WEXITSTATUS(await p2.wait())).toBe(4);
    expect(out2.text).toBe('spawn failed: 44\n'); // WASI ENOENT
  });

  it('kill terminates a process blocked in read', async () => {
    const { kernel } = await setup();
    const [r, w] = createPipe();
    const out = collector();
    const proc = spawn(kernel, ['readloop'], { 0: r, 1: out.sink, 2: out.sink });
    await new Promise(res => setTimeout(res, 50));
    kernel.kill(proc.pid, SIGINT);
    expect(shellExitCode(await proc.wait())).toBe(130);
    await w.close();
  });

  it('`wasi run` uses a kernel process: piped stdin and buffered stdout', async () => {
    const { fs, shell } = await setup();
    await fs.writeFile('/tmp/in.txt', 'one\ntwo\nthree\n');
    let stdout = '', stderr = '';
    const code = await shell.execute('cat /tmp/in.txt | wasi run /opt/wasi/upper.wasm', (s) => { stdout += s; }, (s) => { stderr += s; });
    // The shell's writers use terminal line endings
    expect(stdout.replace(/\r\n/g, '\n')).toBe('ONE\nTWO\nTHREE\n');
    expect(stderr.replace(/\r\n/g, '\n')).toBe('bytes: 14\n');
    expect(code).toBe(0);
  });

  it('`wasi run` on a terminal is interactive: keystrokes reach a blocked read, ^D ends it', async () => {
    const { fs, shell, terminal, type } = await createTestOS();
    await fs.mkdir('/opt/wasi', { recursive: true });
    await fs.writeFile('/opt/wasi/readloop.wasm', new Uint8Array(readFileSync(path.join(fixtures, 'readloop.wasm'))));
    let screen = '';
    const orig = terminal.writeOutput.bind(terminal);
    terminal.writeOutput = (t: string) => { screen += t; orig(t); };
    let out = '';
    const done = shell.execute('wasi run /opt/wasi/readloop.wasm', (s) => { out += s; });
    await until(() => (terminal as any).stdinPassthrough !== null && (terminal as any).stdinPassthrough !== undefined);
    type('hi there\r');
    await until(() => screen.includes('got: hi there\r\n'));
    type('\x04');
    expect(await done).toBe(1);
    expect(screen).toContain('hi there\r\n');   // echoed by the line discipline
    expect(screen).toContain('lines: 1\r\n');
    expect((terminal as any).stdinPassthrough).toBeNull();
  });

  describe('a Go (GOOS=wasip1) program', () => {
    it('streams stdin line by line while it is still being written', async (t) => {
      if (!goWasm) return t.skip();
      const { fs, kernel } = await setup();
      await fs.writeFile('/opt/wasi/gotest.wasm', goWasm);
      const [r, w] = createPipe();
      const out = collector();
      const proc = spawn(kernel, ['gotest'], { 0: r, 1: out.sink, 2: out.sink });
      await w.write(enc('hello\n'));
      await until(() => out.text.includes('1: HELLO\n'), 15000);
      expect(proc.exiting).toBe(false);
      await w.write(enc('wasm\n'));
      await until(() => out.text.includes('2: WASM\n'));
      await w.close();
      expect(WEXITSTATUS(await proc.wait())).toBe(2);
      expect(out.text).toBe('1: HELLO\n2: WASM\ndone 2\n');
    }, 30_000);

    it('reads directories, resolves relative paths from the cwd and writes files', async (t) => {
      if (!goWasm) return t.skip();
      const { fs, kernel } = await setup();
      await fs.writeFile('/opt/wasi/gotest.wasm', goWasm);
      await fs.mkdir('/tmp/gd', { recursive: true });
      await fs.writeFile('/tmp/gd/b.txt', 'b');
      await fs.writeFile('/tmp/gd/a.txt', 'a');
      await fs.writeFile('/tmp/gd/rel.txt', 'relative!');
      const out = collector();
      const proc = spawn(kernel, ['gotest', 'ls', '/tmp/gd'], { 0: empty(), 1: out.sink, 2: out.sink }, '/tmp/gd');
      expect(await proc.wait()).toBe(W_EXITCODE(0));
      expect(out.text).toBe('a.txt,b.txt,rel.txt\nwd: /tmp/gd\nrel: "relative!" <nil>\n');
      expect(await fs.readFile('/tmp/gd/made-by-go.txt', 'utf8')).toBe('hi from go\n');
    }, 30_000);
  });
});
