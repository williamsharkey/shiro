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
import * as Abi from '@shiro/kernel/abi';

// fixtures/x86/sse4.c on an x86-64 host (Intel)
const NATIVE_SSE4 = 'blendv     e4abc65e766ee19d\nptest      7ba00a6efd7a4874\npmovx      b625e06221fbec95\nint        9681ac88d1b48510\nround      15342966be7d2f10\nblend      1772b0668d5f0605\ninsext     1ed641595d55738e\ninsertps   07a824bc4eee852a\ndp         b92c2b618267d645\nmpsadbw    732e9d86324c3735\ncrc32      ed946d3299e3b67d\npcmpestr   f9d8e2fd9893018c\npcmpistr   97a98d5fb234df8d\npcmpstr64  1141d2a07ff9295d\npinsrq 1\npcmpestri 5\ncrc32 0x1900b8ca\n';
// fixtures/x86/bitscan.c on an x86-64 host
const NATIVE_BITSCAN = 'bsf  zero64   reg dst=0x1122334455667788 zf=1\nbsf  zero64   mem dst=0x1122334455667788 zf=1\nbsr  zero64   reg dst=0x1122334455667788 zf=1\nbsr  zero64   mem dst=0x1122334455667788 zf=1\nbsf  val64    reg dst=0x8 zf=0\nbsf  val64    mem dst=0x8 zf=0\nbsr  val64    reg dst=0x34 zf=0\nbsr  val64    mem dst=0x34 zf=0\nbsf  zero32   reg dst=0x1122334455667788 zf=1\nbsf  zero32   mem dst=0x1122334455667788 zf=1\nbsr  zero32   reg dst=0x1122334455667788 zf=1\nbsr  zero32   mem dst=0x1122334455667788 zf=1\nbsf  val32    reg dst=0x8 zf=0\nbsf  val32    mem dst=0x8 zf=0\nbsr  val32    reg dst=0x14 zf=0\nbsr  val32    mem dst=0x14 zf=0\nbsf  zero16   reg dst=0x1122334455667788 zf=1\nbsf  zero16   mem dst=0x1122334455667788 zf=1\nbsr  zero16   reg dst=0x1122334455667788 zf=1\nbsr  zero16   mem dst=0x1122334455667788 zf=1\nbsf  val16    reg dst=0x1122334455660004 zf=0\nbsf  val16    mem dst=0x1122334455660004 zf=0\nbsr  val16    reg dst=0x1122334455660008 zf=0\nbsr  val16    mem dst=0x1122334455660008 zf=0\nclz64(0)=64 clz64(1)=63 clz64(1<<40)=23\nloop sum=5953906\n';

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
const goV2Bin = join(out, 'hello-go-v2');
const haveGoV2 = haveGo && tryBuild(goExe, ['build', '-ldflags=-s', '-o', goV2Bin, 'hello.go'], { CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64', GOAMD64: 'v2', GOCACHE: join(out, 'gocache') });
const haveHttp = haveGo && tryBuild(goExe, ['build', '-ldflags=-s', '-o', httpBin, 'nethttp.go'], { CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64', GOCACHE: join(out, 'gocache') });
const tcpBin = join(out, 'tcpecho');
const haveTcp = haveGo && tryBuild(goExe, ['build', '-ldflags=-s', '-o', tcpBin, 'tcpecho.go'], { CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64', GOCACHE: join(out, 'gocache') });
const ttyBin = join(out, 'tty');
const haveTty = haveGo && tryBuild(goExe, ['build', '-ldflags=-s', '-o', ttyBin, 'tty.go'], { CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64', GOCACHE: join(out, 'gocache') });
const haveGlibc = tryBuild('gcc', ['-static', '-Os', '-o', glibcBin, 'hello.c']);
const jitBin = join(out, 'jit');
const haveJit = tryBuild('gcc', ['-static', '-O1', '-pthread', '-o', jitBin, 'jit.c']);
const forkBin = join(out, 'forkcopy');
const haveFork = tryBuild('gcc', ['-static', '-O1', '-o', forkBin, 'forkcopy.c']);
const mtchildBin = join(out, 'mtchild');
const haveMtchild = tryBuild('gcc', ['-static', '-O1', '-pthread', '-o', mtchildBin, 'mtchild.c']);
const statnullBin = join(out, 'statnull');
const haveStatnull = tryBuild('gcc', ['-static', '-O1', '-o', statnullBin, 'statnull.c']);
const futexwakeBin = join(out, 'futexwake');
const haveFutexwake = tryBuild('gcc', ['-static', '-O1', '-pthread', '-o', futexwakeBin, 'futexwake.c']);
const shfutexBin = join(out, 'shfutex');
const haveShfutex = tryBuild('gcc', ['-static', '-O1', '-o', shfutexBin, 'shfutex.c']);
const orphanBin = join(out, 'orphan');
const haveOrphan = tryBuild('gcc', ['-static', '-O1', '-o', orphanBin, 'orphan.c']);
const futexintrBin = join(out, 'futexintr');
const haveFutexintr = tryBuild('gcc', ['-static', '-O1', '-o', futexintrBin, 'futexintr.c']);
const alarmforkBin = join(out, 'alarmfork');
const haveAlarmfork = tryBuild('gcc', ['-static', '-O1', '-o', alarmforkBin, 'alarmfork.c']);
const forkSharedBin = join(out, 'forkshared');
const haveForkShared = tryBuild('gcc', ['-static', '-O1', '-o', forkSharedBin, 'forkshared.c']);
const mremapBin = join(out, 'mremap');
const haveMremap = tryBuild('gcc', ['-static', '-O1', '-o', mremapBin, 'mremap.c']);
const sse4Bin = join(out, 'sse4');
const haveSse4 = tryBuild('gcc', ['-static', '-O1', '-msse4.2', '-o', sse4Bin, 'sse4.c']);
const bitscanBin = join(out, 'bitscan');
const haveBitscan = tryBuild('gcc', ['-static', '-O1', '-o', bitscanBin, 'bitscan.c']);
const mkfifoBin = join(out, 'mkfifo');
const haveMkfifo = tryBuild('gcc', ['-static', '-O1', '-o', mkfifoBin, 'mkfifo.c']);
const prctlcapBin = join(out, 'prctlcap');
const havePrctlcap = tryBuild('gcc', ['-static', '-O1', '-o', prctlcapBin, 'prctlcap.c']);
const lchownBin = join(out, 'lchown');
const haveLchown = tryBuild('gcc', ['-static', '-O1', '-o', lchownBin, 'lchown.c']);
const ssecmpBin = join(out, 'ssecmp');
const haveSsecmp = tryBuild('gcc', ['-static', '-O1', '-o', ssecmpBin, 'ssecmp.c', '-lm']);
const brkmapBin = join(out, 'brkmap');
const haveBrkmap = tryBuild('gcc', ['-static', '-O1', '-o', brkmapBin, 'brkmap.c']);
const getgroupsBin = join(out, 'getgroups');
const haveGetgroups = tryBuild('gcc', ['-static', '-O1', '-o', getgroupsBin, 'getgroups.c']);
const fionbioBin = join(out, 'fionbio');
const haveFionbio = tryBuild('gcc', ['-static', '-O1', '-o', fionbioBin, 'fionbio.c']);
const fuzzBin = join(out, 'jitfuzz');
const haveFuzz = tryBuild('gcc', ['-static', '-O1', '-o', fuzzBin, 'jitfuzz.c']);

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

// The wasm JIT (vendor/blink patch 0012) against the interpreter (BLINK_WJIT=0).
describe.skipIf(!haveJit || !haveFuzz)('Blink engine: wasm JIT', () => {
  it('computes the same results and flags as the interpreter', async () => {
    const { shell } = await setup(readFileSync(fuzzBin));
    const jit = await run(shell, './prog 3000');
    const interp = await run(shell, 'BLINK_WJIT=0 ./prog 3000');
    expect(jit.exitCode).toBe(0);
    expect(interp.exitCode).toBe(0);
    expect(jit.output.split('\n').length).toBeGreaterThan(100);
    expect(jit.output).toBe(interp.output);
  }, 120_000);

  it('sees code rewritten after mprotect, in RWX pages and after munmap', async () => {
    const { shell } = await setup(readFileSync(jitBin));
    const r = await run(shell, './prog smc');
    expect(r.output).toContain('smc 100350000 200350000 300350000 400350000 500350000');
    expect(r.exitCode).toBe(0);
  }, 60_000);

  it('runs signal handlers while a compiled loop spins', async () => {
    const { shell } = await setup(readFileSync(jitBin));
    const r = await run(shell, './prog signal');
    expect(r.output).toContain('signal ticks=5 spun=yes');
    expect(r.exitCode).toBe(0);
  }, 60_000);

  it('resumes a compiled loop after a SIGSEGV handler fixes the page', async () => {
    const { shell } = await setup(readFileSync(jitBin));
    const r = await run(shell, './prog fault; BLINK_WJIT=0 ./prog fault');
    const lines = r.output.trim().split(/\r?\n/);
    expect(lines[0]).toMatch(/^fault faults=3 sum=\d+$/);
    expect(lines[1]).toBe(lines[0]);
  }, 60_000);

  it('runs compiled code on four threads', async () => {
    const { shell } = await setup(readFileSync(jitBin));
    const r = await run(shell, './prog threads');
    expect(r.output).toContain('threads counter=800000 plain=300000,300000,300000,300000 locked=784');
    expect(r.exitCode).toBe(0);
  }, 60_000);
});

// fork() makes a copy of the guest in a new Blink (patch 0014); it used to
// run the child on the parent's thread with vfork semantics.
describe.skipIf(!haveFork)('Blink engine: fork', () => {
  it('gives the child its own memory; a child that never execs exits with its status', async () => {
    const { shell } = await setup(readFileSync(forkBin));
    const r = await run(shell, './prog copy');
    expect(r.output).toContain('child sees 100 c child');
    expect(r.output).toContain('parent sees 1 p parent status 7');
    expect(r.exitCode).toBe(0);
  }, 60_000);

  it('pipe + fork + dup2 + exec in the child (perl open STDOUT ">&W"; exec)', async () => {
    const { shell } = await setup(readFileSync(forkBin));
    const r = await run(shell, './prog pipe');
    expect(r.output).toContain('pipe got: from-exec');
    expect(r.exitCode).toBe(0);
  }, 60_000);

  it('a fork child forks again', async () => {
    const { shell } = await setup(readFileSync(forkBin));
    const r = await run(shell, './prog nested');
    expect(r.output).toContain('nested status 44 counter 1');
    expect(r.exitCode).toBe(0);
  }, 60_000);

  // LTP keeps its results and checkpoint futexes in MAP_SHARED pages
  it.skipIf(!haveForkShared)('MAP_SHARED memory stays shared with the child; unmapped, fork copies again', async () => {
    const { shell } = await setup(readFileSync(forkSharedBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe('anon shared 42\nfile shared 7\nprivate after unmap 100\n');
    expect(r.exitCode).toBe(0);
  }, 60_000);
});

// BLINK_SAME_INSTANCE_FORK=1 (patch 0031): the child is a System in the
// parent's Blink instance, sharing MAP_SHARED pages and running alongside
describe.skipIf(!haveFork || !haveForkShared || !haveShfutex || !haveOrphan || !haveAlarmfork)('Blink engine: same-instance fork', () => {
  const sif = 'BLINK_SAME_INSTANCE_FORK=1 ./prog';
  it('copies private memory; pipes, exec and nested forks work', async () => {
    const { shell } = await setup(readFileSync(forkBin));
    expect((await run(shell, `${sif} copy`)).output).toContain('parent sees 1 p parent status 7');
    expect((await run(shell, `${sif} pipe`)).output).toContain('pipe got: from-exec');
    expect((await run(shell, `${sif} nested`)).output).toContain('nested status 44 counter 1');
  }, 60_000);

  it('shares MAP_SHARED memory and its futexes with a child running alongside', async () => {
    const { shell } = await setup(readFileSync(forkSharedBin));
    expect((await run(shell, sif)).output.replace(/\r\n/g, '\n')).toBe('anon shared 42\nfile shared 7\nprivate after unmap 100\n');
    const f = await setup(readFileSync(shfutexBin));
    expect((await run(f.shell, sif)).output).toContain('futex across fork: child wrote 2, exit 3');
  }, 60_000);

  it('kills children, and a child outlives its parent', async () => {
    const { shell } = await setup(readFileSync(orphanBin));
    expect((await run(shell, sif)).output.replace(/\r\n/g, '\n')).toBe(
      'killed spinning child: signaled=1 sig=9\nSIGTERM to pausing child: signaled=1 sig=15\n');
    await run(shell, 'rm -f /tmp/orphan.out');
    await run(shell, `${sif} x`);
    await run(shell, 'sleep 1');
    expect((await run(shell, 'cat /tmp/orphan.out')).output).toContain('child outlived parent');
  }, 60_000);

  it.skipIf(!haveMtchild)("ends a child's other threads with it", async () => {
    const { shell } = await setup(readFileSync(mtchildBin));
    expect((await run(shell, sif)).output.replace(/\r\n/g, '\n')).toBe(
      'round 0: child exit 10, its threads stopped 1\nround 1: child exit 11, its threads stopped 1\n');
  }, 60_000);

  it('keeps alarms per process (here and with the default fork)', async () => {
    const { shell } = await setup(readFileSync(alarmforkBin));
    const want = "first alarm 0, child ok 1, parent's alarm still set 1";
    expect((await run(shell, sif)).output).toContain(want);
    expect((await run(shell, './prog')).output).toContain(want);
  }, 60_000);

  // LTP futex_wait07
  it.skipIf(!haveFutexintr)('a caught signal interrupts a futex wait (here and with the default fork)', async () => {
    const { shell } = await setup(readFileSync(futexintrBin));
    const want = 'main tid is pid 1\nalarm: Interrupted system call\nchild tid is pid 1\nchild state S\nkill: Interrupted system call\nchild exit 0\n';
    expect((await run(shell, sif)).output.replace(/\r\n/g, '\n')).toBe(want);
    expect((await run(shell, `${sif} nested`)).output.replace(/\r\n/g, '\n')).toBe(want);
    // the default fork runs a child sharing memory on the parent's thread:
    // the parent can't signal it before it's done
    const r = (await run(shell, './prog')).output.replace(/\r\n/g, '\n');
    expect(r).toMatch(/^main tid is pid 1\nalarm: Interrupted system call\nchild tid is pid 1\n/);
    expect(r).toContain('child exit 0\n');
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

// Blink patch 0014: fork() copies the process into a new worker.
describe('Blink engine: fork() without exec', () => {
  it('the child gets a copy of memory and runs alongside the parent', async () => {
    const { shell } = await setup(readFileSync(join(FIX, 'fork-musl')));
    const r = await run(shell, './prog');
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/child: pid=\d+ ppid=\d+ counter=101 heap=heap data/);
    expect(r.output).toContain('parent: counter=100 heap=heap data child exit=5');
    expect(r.output).toContain('echo child: HELLO');
  }, 60_000);
});

// Blink patches 0016-0018 (jemalloc, Rust's miniz_oxide and std need them).
describe('Blink engine: CPU and syscall fixes', () => {
  it('pextrw zero-extends, MADV_DONTNEED zeroes, FUTEX_WAIT_BITSET times out, GRND_INSECURE works', async () => {
    const { shell } = await setup(readFileSync(join(FIX, 'cpu-musl')));
    const r = await run(shell, './prog');
    expect(r.exitCode).toBe(0);
    expect(r.output.replace(/\r\n/g, '\n')).toBe('pextrw 0xfffe\nmadvise 0 0 0\nfutex_wait_bitset timedout on time\nfutex_wake_bitset 0\ngetrandom 16\n');
  }, 60_000);

  // apt's DynamicMMap grows its package cache with mremap(MREMAP_MAYMOVE)
  it.skipIf(!haveMremap)('mremap grows (in place or moving), shrinks and moves to a fixed place', async () => {
    const { shell } = await setup(readFileSync(mremapBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe(
      'no MAYMOVE: Cannot allocate memory\nmoved=1 first=7 mid=7 last=9\nold range free=1\n' +
      'shrunk same=1 tail free=1 last=7\nfixed at=1 first=7\nreadonly moved=1 byte=42\n');
    expect(r.exitCode).toBe(0);
  }, 60_000);

  // LTP futex_wake02, futex_wait_bitset01
  it.skipIf(!haveFutexwake)('FUTEX_WAKE wakes at most count waiters; bitset timeouts end by their own clock', async () => {
    const { shell } = await setup(readFileSync(futexwakeBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe(
      'wake(2)=2 woken=2\nwake(1)=1 woken=3\nwake(100)=3 woken=6\nwake(none)=0\n' +
      'monotonic bitset wait=-1 timedout=1 early=0\nrealtime bitset wait=-1 timedout=1 early=0\n');
    expect(r.exitCode).toBe(0);
  }, 60_000);

  // x86-64-v2: Bun (Claude Code's native build, opencode), GOAMD64=v2 Go
  it.skipIf(!haveSse4)('SSE4.1 and SSE4.2 match native', async () => {
    const { shell } = await setup(readFileSync(sse4Bin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe(NATIVE_SSE4);
    expect(r.exitCode).toBe(0);
  }, 120_000);

  it.skipIf(!haveGoV2)('runs Go built for x86-64-v2 (GOAMD64=v2)', async () => {
    const { shell } = await setup(readFileSync(goV2Bin));
    const r = await run(shell, './prog a b');
    expect(r.output).toContain('args: [a b]');
    expect(r.output).toContain('goroutines=344015.127');
    expect(r.exitCode).toBe(0);
  }, 120_000);

  // Rust's leading_zeros (LLVM: mov $127,%r8; bsr %rax,%r8): xAI's grok CLI
  it.skipIf(!haveBitscan)('bsf/bsr with a zero source leave the destination unchanged', async () => {
    const { shell } = await setup(readFileSync(bitscanBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe(NATIVE_BITSCAN);
  }, 60_000);

  // mkfifo for shell-stdio; needs the kernel's FIFOs (mknodat, unix/perf-kernel)
  it.skipIf(!haveMkfifo || !('SYS_mknodat' in Abi))('mkfifo and mknod(at) create kernel FIFOs; devices are EPERM', async () => {
    const { shell } = await setup(readFileSync(mkfifoBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe(
      'mkfifo=0  fifo=1\nmknod=0  fifo=1\nmknodat=0  fifo=1\n' +
      'chardev=-1 Operation not permitted\nagain=-1 File exists\n');
  }, 60_000);

  // LTP fstat03
  it.skipIf(!haveStatnull)('the stat family with a NULL buffer is EFAULT once the file is found', async () => {
    const { shell } = await setup(readFileSync(statnullBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe(
      'fstat(fd, NULL)=-1 Bad address\nfstat(-1, NULL)=-1 Bad file descriptor\nstat(file, NULL)=-1 Bad address\n' +
      'stat(missing, NULL)=-1 No such file or directory\nlstat(file, NULL)=-1 Bad address\nnewfstatat(file, NULL)=-1 Bad address\n');
  }, 60_000);

  // perl's $0 = ... (Debian's addgroup); libcap's cap_get_proc and iputils' PR_SET_KEEPCAPS (ping)
  it.skipIf(!havePrctlcap)('prctl PR_SET_NAME/PR_GET_NAME/PR_CAPBSET_READ, capget/capset', async () => {
    const { shell } = await setup(readFileSync(prctlcapBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe(
      'default name prog\nset 0 name renamed-thread-\ncapbset_read(0)=1 capbset_read(40)=1\n' +
      'capbset_read(64)=-1 Invalid argument\ncapget(version 0)=0 , version 0x20080522\n' +
      'capget=0 full=0\ncapset=0\n' +
      'keepcaps 0 set=0 now 1, set(2)=-1 Invalid argument\npdeathsig set=0 now 15\ndumpable 1 set=0\n' +
      'subreaper set=0 now 1\nno_new_privs 0 set=0 now 1\nambient is_set=0\n');
    expect(r.exitCode).toBe(0);
  }, 60_000);

  // dpkg lchowns NAME.dpkg-new symlinks before their targets exist
  it.skipIf(!haveLchown)('lchown and fchownat(AT_SYMLINK_NOFOLLOW) act on a dangling symlink', async () => {
    const { shell } = await setup(readFileSync(lchownBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe(
      'lchown(dangling)=0 \nfchownat(dangling, NOFOLLOW)=0 \nchown(dangling)=-1 No such file or directory\n' +
      'fchownat(dangling)=-1 No such file or directory\nlchown(missing)=-1 No such file or directory\n' +
      'fchownat(missing)=-1 No such file or directory\nfchownat(dirfd, dangling, NOFOLLOW)=0 \n' +
      'fchownat(fd, "", EMPTY_PATH)=0 \n');
    expect(r.exitCode).toBe(0);
  }, 60_000);

  // GTK's cubic-bezier easing selects with cmpltsd masks (Blink wrote -1.0)
  it.skipIf(!haveSsecmp)('cmpps/cmppd/cmpss/cmpsd write all-ones masks, NaN included', async () => {
    const { shell } = await setup(readFileSync(ssecmpBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe('ssecmp 288 cases, 0 wrong\n');
    expect(r.exitCode).toBe(0);
  }, 60_000);

  // apt's cache was mmapped at the break and malloc's brk overwrote it
  it.skipIf(!haveBrkmap)('brk never grows over a mapping; mmap(0) leaves the heap room', async () => {
    const { shell } = await setup(readFileSync(brkmapBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe(
      'mmap(0) clear of the break: 1\nmapping intact: 1\nsbrk over a mapping refused: 1, mapping kept: 1\n');
    expect(r.exitCode).toBe(0);
  }, 60_000);

  // coreutils id: "failed to get groups for the current process"
  it.skipIf(!haveGetgroups)('getgroups reports the process gid, and its count for size 0', async () => {
    const { shell } = await setup(readFileSync(getgroupsBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe('getgroups(0)=1 getgroups(64)=1 is-gid=1\n');
    expect(r.exitCode).toBe(0);
  }, 60_000);
});

// libuv makes every fd non-blocking with ioctl(FIONBIO); on /dev/null the
// kernel answered ENOTTY and cmake died (exit 139) in its uname probes.
describe.skipIf(!haveFionbio)('Blink engine: FIONBIO', () => {
  it('sets O_NONBLOCK on /dev/null, a pipe and a file', async () => {
    const { shell } = await setup(readFileSync(fionbioBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe('devnull 0 1 0 0\npipe 0 1 0 0\nfile 0 1 0 0\n');
    expect(r.exitCode).toBe(0);
  }, 60_000);
});

// AF_UNIX path sockets with SCM_RIGHTS through Blink's sendmsg/recvmsg (tmux, screen).
describe('Blink engine: AF_UNIX sockets', () => {
  it('a server and a forked client talk over a path socket and pass an fd', async () => {
    const { shell } = await setup(readFileSync(join(FIX, 'unix-musl')));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe("server: 2 bytes 'hi' fd ok peercred ok socket file ok\nclient: via the passed fd\n");
    expect(r.exitCode).toBe(0);
  }, 60_000);
});
