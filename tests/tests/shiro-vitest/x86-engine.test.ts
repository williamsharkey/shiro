/**
 * Blink x86-64 engine (public/engines/blink, src/x86-engine): static Linux
 * ELF binaries run through the shell's normal `./binary` exec path.
 *
 * Fixtures: fixtures/x86/hello-musl is committed (38 KB). The Go and static
 * glibc builds of the same programs are made in beforeAll when `go` / `gcc`
 * are available, and those cases are skipped otherwise.
 */
import { describe, it, expect, onTestFinished } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
