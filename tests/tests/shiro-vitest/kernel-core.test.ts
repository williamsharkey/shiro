/**
 * Kernel core: fd semantics, pipes, process lifecycle, builtins as kernel
 * processes, and real Worker guests making blocking syscalls over the SAB
 * channel (Node worker threads have SharedArrayBuffer + Atomics.wait).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { createTestShell } from './helpers';
import type { FileSystem } from '@shiro/filesystem';
import type { Shell } from '@shiro/shell';
import * as A from '@shiro/kernel/abi';
import { FdTable, BufferFile, DevNull, DevZero, DevRandom, refCount, type OpenFile } from '@shiro/kernel/fd';
import { createPipe } from '@shiro/kernel/pipe';
import { Kernel } from '@shiro/kernel/kernel';
import { canBlock } from '@shiro/kernel/channel';
import { startWorker, attachThread, type GuestWorker } from '@shiro/kernel/worker-host';
import { Process } from '@shiro/kernel/process';
import { EpollFile } from '@shiro/kernel/epoll';
import { processTable } from '@shiro/process-table';

const enc = new TextEncoder();
const dec = new TextDecoder();
const bytes = (s: string) => enc.encode(s);

async function readStr(f: OpenFile, n = 1024): Promise<string | number> {
  const buf = new Uint8Array(n);
  const r = await f.read(buf);
  return r < 0 ? r : dec.decode(buf.subarray(0, r));
}

describe('abi', () => {
  it('wait status encoding matches Linux', () => {
    const exited = A.W_EXITCODE(3);
    expect(exited).toBe(0x300);
    expect(A.WIFEXITED(exited)).toBe(true);
    expect(A.WEXITSTATUS(exited)).toBe(3);
    const killed = A.W_TERMSIG(A.SIGKILL);
    expect(A.WIFSIGNALED(killed)).toBe(true);
    expect(A.WTERMSIG(killed)).toBe(9);
    expect(A.shellExitCode(killed)).toBe(137);
    const stopped = A.W_STOPCODE(A.SIGTSTP);
    expect(A.WIFSTOPPED(stopped)).toBe(true);
    expect(A.WSTOPSIG(stopped)).toBe(A.SIGTSTP);
  });

  it('struct stat round-trips', () => {
    const st: A.KStat = {
      dev: 1, ino: 42, mode: A.S_IFREG | 0o644, nlink: 1, uid: 1000, gid: 1000, rdev: 0,
      size: 5_000_000_000, blksize: 4096, blocks: 9, atimeMs: 1700000000123, mtimeMs: 1700000001456, ctimeMs: 1700000002789,
    };
    const buf = new Uint8Array(A.STAT_SIZE);
    A.encodeStat(st, buf);
    expect(A.decodeStat(buf)).toEqual(st);
  });
});

describe('fd table', () => {
  it('allocates the lowest free fd and shares descriptions across dup', async () => {
    const t = new FdTable();
    const f = new BufferFile('abcdef');
    expect(t.alloc(f)).toBe(0);
    expect(t.alloc(new DevNull())).toBe(1);
    expect(t.dup(0)).toBe(2);
    expect(refCount(f)).toBe(2);
    // dup'd fds share the offset
    expect(await readStr(t.get(0)!, 3)).toBe('abc');
    expect(await readStr(t.get(2)!, 3)).toBe('def');
    expect(await t.close(1)).toBe(0);
    expect(t.alloc(new DevNull())).toBe(1);
    expect(await t.close(9)).toBe(-A.EBADF);
    expect(t.dup(9)).toBe(-A.EBADF);
  });

  it('dup2 replaces the target and closes the old description when unreferenced', async () => {
    const t = new FdTable();
    const [r, w] = createPipe();
    t.alloc(r, 0);
    t.alloc(w, 1);
    const sink = new BufferFile();
    t.alloc(sink, 5);
    expect(await t.dup2(5, 1)).toBe(1);
    // the only write end was closed: reader sees EOF
    expect(await r.read(new Uint8Array(4))).toBe(0);
    expect(await t.dup2(5, 5)).toBe(5);
    expect(await t.dup2(7, 3)).toBe(-A.EBADF);
  });

  it('fork shares descriptions and closeOnExec drops cloexec fds', async () => {
    const t = new FdTable();
    const f = new BufferFile('x');
    t.alloc(f, 0);
    t.alloc(new DevNull(), 3, true);
    const child = t.fork();
    expect(refCount(f)).toBe(2);
    await child.closeOnExec();
    expect(child.has(3)).toBe(false);
    expect(child.has(0)).toBe(true);
    expect(t.getCloexec(3)).toBe(true);
    await child.closeAll();
    expect(refCount(f)).toBe(1);
  });

  it('devices behave like Linux', async () => {
    const buf = new Uint8Array(8).fill(7);
    expect(await new DevNull().read(buf)).toBe(0);
    expect(await new DevNull().write(buf)).toBe(8);
    expect(await new DevZero().read(buf)).toBe(8);
    expect([...buf]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    const rnd = new Uint8Array(70000);
    expect(await new DevRandom().read(rnd)).toBe(70000);
    expect(rnd.some(b => b !== 0)).toBe(true);
  });
});

describe('pipes', () => {
  it('read blocks until data arrives, then returns EOF after the writer closes', async () => {
    const [r, w] = createPipe();
    const buf = new Uint8Array(16);
    let done = false;
    const pending = r.read(buf).then(n => { done = true; return n; });
    await new Promise(res => setTimeout(res, 10));
    expect(done).toBe(false);
    expect(r.poll(A.POLLIN)).toBe(0);
    expect(await w.write(bytes('hi'))).toBe(2);
    expect(await pending).toBe(2);
    expect(dec.decode(buf.subarray(0, 2))).toBe('hi');
    await w.close();
    expect(r.poll(A.POLLIN) & A.POLLHUP).toBeTruthy();
    expect(await r.read(buf)).toBe(0);
  });

  it('write to a pipe with no reader is EPIPE', async () => {
    const [r, w] = createPipe();
    await r.close();
    expect(await w.write(bytes('x'))).toBe(-A.EPIPE);
    expect(w.poll(A.POLLOUT) & A.POLLERR).toBeTruthy();
  });

  it('write blocks when full and resumes as the reader drains', async () => {
    const [r, w] = createPipe(0, 8192);
    const big = new Uint8Array(20000).map((_, i) => i & 0xff);
    let written = -1;
    const writing = w.write(big).then(n => { written = n; });
    await new Promise(res => setTimeout(res, 10));
    expect(written).toBe(-1);
    const got: number[] = [];
    const buf = new Uint8Array(3000);
    while (got.length < big.length) {
      const n = await r.read(buf);
      got.push(...buf.subarray(0, n));
    }
    await writing;
    expect(written).toBe(20000);
    expect(got).toEqual([...big]);
  });

  it('O_NONBLOCK returns EAGAIN, and an aborted read is EINTR', async () => {
    const [r, w] = createPipe(A.O_NONBLOCK);
    expect(await r.read(new Uint8Array(4))).toBe(-A.EAGAIN);
    expect(await w.write(new Uint8Array(A.PIPE_CAPACITY))).toBe(A.PIPE_CAPACITY);
    expect(await w.write(bytes('x'))).toBe(-A.EAGAIN);
    const ac = new AbortController();
    const [blocked] = createPipe();
    const p = blocked.read(new Uint8Array(4), ac.signal);
    ac.abort();
    expect(await p).toBe(-A.EINTR);
  });

  it('writes up to PIPE_BUF are atomic', async () => {
    const [r, w] = createPipe(A.O_NONBLOCK, 8192);
    expect(await w.write(new Uint8Array(6000))).toBe(6000);
    // 2192 bytes free: a 4096-byte write must not be split
    expect(await w.write(new Uint8Array(A.PIPE_BUF))).toBe(-A.EAGAIN);
    await r.read(new Uint8Array(6000));
    expect(await w.write(new Uint8Array(A.PIPE_BUF))).toBe(A.PIPE_BUF);
  });
});

// OpenFile.close() runs when the last fd referencing a description closes. Ends
// handed to spawn() are owned by the child's fd table from then on, so these
// tests only close() ends that no process holds.

describe('kernel processes', () => {
  let fs: FileSystem;
  let shell: Shell;
  let kernel: Kernel;

  beforeAll(async () => {
    ({ fs, shell } = await createTestShell());
    await fs.mkdir('/tmp', { recursive: true }).catch(() => {});
  });
  beforeEach(() => { kernel = new Kernel({ shell }); });
  afterEach(() => kernel.dispose());

  it('spawn/waitpid reports exit status in wait encoding', async () => {
    const p = kernel.spawn({ path: 'x', run: async () => 3 });
    expect(p.ppid).toBe(1);
    expect(p.pgid).toBe(1);
    const r = await kernel.waitpid(p.pid);
    expect(r.pid).toBe(p.pid);
    expect(A.WEXITSTATUS(r.status)).toBe(3);
    // reaped
    expect(kernel.procs.has(p.pid)).toBe(false);
    expect((await kernel.waitpid(p.pid)).pid).toBe(-A.ECHILD);
  });

  it('WNOHANG, waitpid(-1) and process groups', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const a = kernel.spawn({ path: 'a', pgid: 0, run: async () => { await gate; return 1; } });
    const b = kernel.spawn({ path: 'b', pgid: a.pid, run: async () => { await gate; return 2; } });
    expect(a.pgid).toBe(a.pid);
    expect(b.pgid).toBe(a.pid);
    expect(await kernel.waitpid(-1, A.WNOHANG)).toEqual({ pid: 0, status: 0 });
    release();
    const first = await kernel.waitpid(-a.pid);
    const second = await kernel.waitpid(-1);
    expect(new Set([first.pid, second.pid])).toEqual(new Set([a.pid, b.pid]));
  });

  it('kill: SIGTERM terminates, SIGKILL cannot be caught, signal 0 probes, ESRCH', async () => {
    const forever = () => new Promise<number>(() => {});
    const p = kernel.spawn({ path: 'sleepy', run: forever });
    expect(kernel.kill(p.pid, 0)).toBe(0);
    expect(kernel.kill(p.pid, A.SIGTERM)).toBe(0);
    const st = await p.wait();
    expect(A.WIFSIGNALED(st) && A.WTERMSIG(st)).toBe(A.SIGTERM);

    const q = kernel.spawn({ path: 'stubborn', run: forever });
    q.dispositions.set(A.SIGTERM, 'ignore');
    kernel.kill(q.pid, A.SIGTERM);
    await new Promise(r => setTimeout(r, 5));
    expect(q.state).toBe('running');
    kernel.kill(q.pid, A.SIGKILL);
    expect(A.WTERMSIG(await q.wait())).toBe(A.SIGKILL);
    expect(kernel.kill(999999, A.SIGTERM)).toBe(-A.ESRCH);
  });

  it('SIGSTOP/SIGCONT are reported with WUNTRACED/WCONTINUED', async () => {
    const p = kernel.spawn({ path: 'job', run: () => new Promise<number>(() => {}) });
    kernel.kill(p.pid, A.SIGSTOP);
    const s = await kernel.waitpid(p.pid, A.WUNTRACED);
    expect(A.WIFSTOPPED(s.status)).toBe(true);
    kernel.kill(p.pid, A.SIGCONT);
    const c = await kernel.waitpid(p.pid, A.WCONTINUED);
    expect(A.WIFCONTINUED(c.status)).toBe(true);
    kernel.kill(p.pid, A.SIGKILL);
    await kernel.waitpid(p.pid);
  });

  it('closing a process closes its fds (pipe EOF) and orphans go to init', async () => {
    const [r, w] = createPipe();
    const parent = kernel.spawn({ path: 'parent', fds: { 1: w }, run: async (proc, k) => {
      k.spawn({ path: 'child', parent: proc, fds: {}, run: () => new Promise<number>(() => {}) });
      await k.writeAll(proc, 1, bytes('bye'));
      return 0;
    } });
    expect(await readStr(r)).toBe('bye');
    expect(await r.read(new Uint8Array(4))).toBe(0);
    await parent.wait();
    const orphan = [...kernel.procs.values()].find(p => p.argv[0] === 'child')!;
    expect(orphan.ppid).toBe(1);
    kernel.kill(orphan.pid, A.SIGKILL);
  });

  it('kernel processes show up in the page process table', async () => {
    const p = kernel.spawn({ path: 'visible', argv: ['visible', '--flag'], run: () => new Promise<number>(() => {}) });
    const v = processTable.get(p.pid);
    expect(v?.command).toBe('visible --flag');
    expect(v?.status).toBe('running');
    expect(processTable.list().some(x => x.pid === p.pid)).toBe(true);
    expect(processTable.kill(p.pid)).toBe(true);
    expect(A.WTERMSIG(await p.wait())).toBe(A.SIGTERM);
  });

  it('runBuiltin: Shiro builtins run as kernel processes over pipes', async () => {
    await fs.writeFile('/tmp/kls-a.txt', 'a');
    await fs.writeFile('/tmp/kls-b.txt', 'b');
    const out = new BufferFile();
    const ls = kernel.spawn({ path: 'ls', argv: ['ls', '/tmp'], fds: { 0: new DevNull(), 1: out, 2: out } });
    expect(A.WEXITSTATUS(await ls.wait())).toBe(0);
    expect(out.text()).toContain('kls-a.txt');

    // echo hello world | tr a-z A-Z | wc -c   through kernel pipes
    const [r1, w1] = createPipe();
    const [r2, w2] = createPipe();
    const sink = new BufferFile();
    const err = new BufferFile();
    const p1 = kernel.spawn({ path: 'echo', argv: ['echo', 'hello world'], fds: { 0: new DevNull(), 1: w1, 2: err } });
    const p2 = kernel.spawn({ path: 'tr', argv: ['tr', 'a-z', 'A-Z'], fds: { 0: r1, 1: w2, 2: err } });
    const p3 = kernel.spawn({ path: 'cat', argv: ['cat'], fds: { 0: r2, 1: sink, 2: err } });
    await Promise.all([p1.wait(), p2.wait(), p3.wait()]);
    expect(err.text()).toBe('');
    expect(sink.text()).toBe('HELLO WORLD\n');

    const missing = kernel.spawn({ path: 'no-such-cmd-xyz', fds: { 0: new DevNull(), 1: out, 2: err } });
    expect(A.WEXITSTATUS(await missing.wait())).toBe(127);
    expect(err.text()).toContain('command not found');
  });

  it('rename and unlink of a file that is still open (temp file + rename, as compilers do)', async () => {
    const proc = kernel.spawn({ path: 'holder', cwd: '/tmp', run: () => new Promise<number>(() => {}) });
    const enc = new TextEncoder();
    const call = (nr: number, a: number[], paths: string[]) => {
      const data = new Uint8Array(4096);
      let off = 0;
      for (const p of paths) { const b = enc.encode(p); data.set(b, off); off += b.length; }
      return kernel.syscall(proc, nr, a, data);
    };
    const f = (await kernel.open(proc, 'obj.tmp', A.O_CREAT | A.O_RDWR | A.O_TRUNC)) as OpenFile;
    await f.write(enc.encode('first half, '));
    expect(await call(A.SYS_rename, [7, 5], ['obj.tmp', 'obj.o'])).toBe(0);
    await f.write(enc.encode('second half'));
    await f.close();
    expect(await fs.readFile('/tmp/obj.o', 'utf8')).toBe('first half, second half');
    expect(await fs.exists('/tmp/obj.tmp')).toBe(false);

    // Unlinked while open: the fd keeps working, and nothing brings the file back
    const g = (await kernel.open(proc, 'gone.txt', A.O_CREAT | A.O_RDWR | A.O_TRUNC)) as OpenFile;
    await g.write(enc.encode('data'));
    expect(await call(A.SYS_unlink, [8], ['gone.txt'])).toBe(0);
    await g.write(enc.encode(' more'));
    await g.close();
    expect(await fs.exists('/tmp/gone.txt')).toBe(false);
    await kernel.exit(proc, 0);
  });

  it('open: files, O_CREAT|O_EXCL, O_APPEND, O_TRUNC, directories, /dev', async () => {
    const proc = kernel.spawn({ path: 'holder', cwd: '/tmp', run: () => new Promise<number>(() => {}) });
    const f = await kernel.open(proc, 'kopen.txt', A.O_CREAT | A.O_RDWR | A.O_TRUNC);
    expect(typeof f).toBe('object');
    const file = f as OpenFile;
    await file.write(bytes('12345'));
    expect(await kernel.open(proc, 'kopen.txt', A.O_CREAT | A.O_EXCL | A.O_WRONLY)).toBe(-A.EEXIST);
    // a second description sees the shared contents, with its own offset
    const g = (await kernel.open(proc, '/tmp/kopen.txt', A.O_WRONLY | A.O_APPEND)) as OpenFile;
    await g.write(bytes('67'));
    expect(file.seek!(0, A.SEEK_SET)).toBe(0);
    expect(await readStr(file)).toBe('1234567');
    expect((await file.stat()).size).toBe(7);
    await file.close();
    await g.close();
    expect(await fs.readFile('/tmp/kopen.txt', 'utf8')).toBe('1234567');
    const t = (await kernel.open(proc, 'kopen.txt', A.O_WRONLY | A.O_TRUNC)) as OpenFile;
    await t.close();
    expect(await fs.readFile('/tmp/kopen.txt', 'utf8')).toBe('');
    expect(await kernel.open(proc, '/tmp', A.O_WRONLY)).toBe(-A.EISDIR);
    expect((await kernel.open(proc, '/tmp', A.O_RDONLY | A.O_DIRECTORY) as OpenFile).kind).toBe('dir');
    expect(await kernel.open(proc, 'kopen.txt', A.O_RDONLY | A.O_DIRECTORY)).toBe(-A.ENOTDIR);
    expect(await kernel.open(proc, 'nope/x', A.O_RDONLY)).toBe(-A.ENOENT);
    expect((await kernel.open(proc, '/dev/null', A.O_RDWR) as OpenFile).kind).toBe('dev');
    expect(await kernel.open(proc, '/dev/tty', A.O_RDWR)).toBe(-A.ENXIO);
    kernel.kill(proc.pid, A.SIGKILL);
  });

  it('/proc: self, PID directories, fd links, stat/status/cmdline, getdents, system files', async () => {
    const proc = kernel.spawn({ path: '/usr/bin/prog', argv: ['prog', '-x', 'a b'], cwd: '/tmp', fds: { 3: new BufferFile('') }, run: () => new Promise<number>(() => {}) });
    const data = new Uint8Array(8192);
    const enc2 = new TextEncoder();
    const readlink = async (p: string) => {
      const b = enc2.encode(p); data.set(b);
      const n = await kernel.syscall(proc, A.SYS_readlink, [b.length, 4096], data);
      return n < 0 ? n : new TextDecoder().decode(data.subarray(0, n));
    };
    const cat = async (p: string) => {
      const f = await kernel.open(proc, p, A.O_RDONLY);
      if (typeof f === 'number') return f;
      const buf = new Uint8Array(8192);
      const n = await f.read(buf);
      await f.close();
      return new TextDecoder().decode(buf.subarray(0, n));
    };
    expect(await readlink('/proc/self')).toBe(String(proc.pid));
    expect(await readlink('/proc/self/cwd')).toBe('/tmp');
    expect(await readlink('/proc/self/exe')).toBe('/usr/bin/prog');
    expect(await readlink(`/proc/${proc.pid}/fd/9`)).toBe(-A.ENOENT);
    await fs.writeFile('/tmp/procfd.txt', 'x');
    const f = await kernel.open(proc, '/tmp/procfd.txt', A.O_RDONLY);
    const fd = proc.fds.alloc(f as any);
    expect(await readlink(`/proc/self/fd/${fd}`)).toBe('/tmp/procfd.txt');
    expect(await readlink('/proc/99999/cwd')).toBe(-A.ENOENT);

    const stat = (await cat(`/proc/${proc.pid}/stat`)) as string;
    const fields = stat.trim().split(' ');
    expect(fields.length).toBe(52);
    expect(fields.slice(0, 2)).toEqual([String(proc.pid), '(prog)']);
    expect(fields[2]).toMatch(/^[RS]$/);
    expect(Number(fields[3])).toBe(proc.ppid);
    expect(await cat('/proc/self/cmdline')).toBe('prog\0-x\0a b\0');
    expect(await cat('/proc/self/comm')).toBe('prog\n');
    expect(await cat('/proc/self/status')).toMatch(new RegExp(`^Name:\\tprog\n[^]*Pid:\\t${proc.pid}\n[^]*Uid:\\t1000`));
    const pst = await kernel.statPath(proc, `/proc/${proc.pid}`);
    expect(typeof pst !== 'number' && (pst.mode & A.S_IFMT)).toBe(A.S_IFDIR);
    const lst = await kernel.statPath(proc, '/proc/self', false);
    expect(typeof lst !== 'number' && (lst.mode & A.S_IFMT)).toBe(A.S_IFLNK);

    // getdents of /proc lists the processes and the system files
    const dirfd = proc.fds.alloc((await kernel.open(proc, '/proc', A.O_RDONLY | A.O_DIRECTORY)) as any);
    const n = await kernel.syscall(proc, A.SYS_getdents64, [dirfd, 8192], data);
    const names: string[] = [];
    for (let off = 0; off < n;) {
      const reclen = new DataView(data.buffer).getUint16(off + 16, true);
      const end = data.indexOf(0, off + 19);
      names.push(new TextDecoder().decode(data.subarray(off + 19, end)));
      off += reclen;
    }
    expect(names).toEqual(expect.arrayContaining(['self', String(proc.pid), 'stat', 'meminfo', 'uptime', 'loadavg']));
    expect(await cat('/proc/stat')).toMatch(/^cpu  \d+ 0 0 \d+ /);
    expect(await cat('/proc/loadavg')).toMatch(/^\d+\.\d\d \d+\.\d\d \d+\.\d\d \d+\/\d+ \d+\n$/);
    expect(await cat('/proc/uptime')).toMatch(/^\d+\.\d\d \d+\.\d\d\n$/);
    expect(await kernel.open(proc, '/proc/self/stat', A.O_WRONLY)).toBe(-A.EACCES);
    // a /proc file kept open and rewound reads fresh text (top's refresh)
    const up = (await kernel.open(proc, '/proc/uptime', A.O_RDONLY)) as OpenFile;
    const b1 = new Uint8Array(64);
    const first = new TextDecoder().decode(b1.subarray(0, await up.read(b1)));
    expect(await up.read(b1)).toBe(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(up.seek!(0, A.SEEK_SET)).toBe(0);
    const second = new TextDecoder().decode(b1.subarray(0, await up.read(b1)));
    expect(parseFloat(second)).toBeGreaterThan(parseFloat(first));
    // CLOCK_BOOTTIME counts from the same boot as /proc/uptime
    expect(await kernel.syscall(proc, A.SYS_clock_gettime, [7], data)).toBe(0);
    const bootSecs = Number(new DataView(data.buffer).getBigInt64(0, true));
    expect(Math.abs(bootSecs - parseFloat(second))).toBeLessThanOrEqual(1);
    expect(await kernel.syscall(proc, A.SYS_clock_gettime, [99], data)).toBe(-A.EINVAL);
    kernel.kill(proc.pid, A.SIGKILL);
  });

  it('an open file follows rename(2); an unlinked or replaced one is not written back', async () => {
    const proc = kernel.spawn({ path: 'rn', cwd: '/tmp', fds: {}, run: () => new Promise<number>(() => {}) });
    const data = new Uint8Array(4096);
    const enc = (s: string) => { const b = new TextEncoder().encode(s); data.set(b); return b.length; };
    const open = async (p: string, flags: number) => kernel.syscall(proc, A.SYS_openat, [A.AT_FDCWD, enc(p), flags, 0o644], data);
    const rename = async (a: string, b: string) => { const n = enc(a); data.set(new TextEncoder().encode(b), n); return kernel.syscall(proc, A.SYS_rename, [n, b.length], data); };
    // write a temp file, rename it over the target while still open, keep writing (GNU patch, editors)
    await fs.writeFile('/tmp/target.txt', 'old\n');
    const fd = await open('/tmp/tmp.XXXX', A.O_WRONLY | A.O_CREAT | A.O_TRUNC);
    data.set(new TextEncoder().encode('new\n'));
    expect(await kernel.syscall(proc, A.SYS_write, [fd, 4], data)).toBe(4);
    expect(await rename('/tmp/tmp.XXXX', '/tmp/target.txt')).toBe(0);
    data.set(new TextEncoder().encode('more\n'));
    expect(await kernel.syscall(proc, A.SYS_write, [fd, 5], data)).toBe(5);
    expect(await kernel.syscall(proc, A.SYS_close, [fd], data)).toBe(0);
    expect(await fs.readFile('/tmp/target.txt', 'utf8')).toBe('new\nmore\n');
    expect(await fs.exists('/tmp/tmp.XXXX')).toBe(false);
    // unlink while open: still readable, never recreated
    const fd2 = await open('/tmp/gone.txt', A.O_RDWR | A.O_CREAT);
    data.set(new TextEncoder().encode('data'));
    await kernel.syscall(proc, A.SYS_write, [fd2, 4], data);
    expect(await kernel.syscall(proc, A.SYS_unlink, [enc('/tmp/gone.txt')], data)).toBe(0);
    await kernel.syscall(proc, A.SYS_write, [fd2, 4], data);
    expect(await kernel.syscall(proc, A.SYS_close, [fd2], data)).toBe(0);
    await new Promise((r) => setTimeout(r, 10));
    expect(await fs.exists('/tmp/gone.txt')).toBe(false);
    kernel.kill(proc.pid, A.SIGKILL);
  });

  it('link(2) copies the file but reports the source inode number (git local clone checks it)', async () => {
    const proc = kernel.spawn({ path: 'ln', cwd: '/tmp', fds: {}, run: () => new Promise<number>(() => {}) });
    const data = new Uint8Array(4096);
    const two = (a: string, b: string) => { const x = new TextEncoder().encode(a); data.set(x); data.set(new TextEncoder().encode(b), x.length); return [x.length, b.length]; };
    const ino = async (p: string) => ((await (kernel as any).statPath(proc, p, false)) as { ino: number }).ino;
    await fs.writeFile('/tmp/lsrc', 'content');
    expect(await kernel.syscall(proc, A.SYS_link, two('/tmp/lsrc', '/tmp/ldst'), data)).toBe(0);
    expect(await fs.readFile('/tmp/ldst', 'utf8')).toBe('content');
    expect(await ino('/tmp/ldst')).toBe(await ino('/tmp/lsrc'));
    expect(await kernel.syscall(proc, A.SYS_link, two('/tmp/lsrc', '/tmp/ldst'), data)).toBe(-A.EEXIST);
    // a removed and recreated path is a new inode
    const n = new TextEncoder().encode('/tmp/ldst'); data.set(n);
    expect(await kernel.syscall(proc, A.SYS_unlink, [n.length], data)).toBe(0);
    await fs.writeFile('/tmp/ldst', 'other');
    expect(await ino('/tmp/ldst')).not.toBe(await ino('/tmp/lsrc'));
    kernel.kill(proc.pid, A.SIGKILL);
  });

  it('a burst of file writes is stored once it pauses, not after every write', async () => {
    const proc = kernel.spawn({ path: 'holder', cwd: '/tmp', run: () => new Promise<number>(() => {}) });
    const f = (await kernel.open(proc, 'kburst.bin', A.O_CREAT | A.O_WRONLY | A.O_TRUNC)) as OpenFile;
    const real = fs.writeFile.bind(fs);
    let stores = 0;
    (fs as any).writeFile = (...a: Parameters<typeof fs.writeFile>) => { stores++; return real(...a); };
    try {
      // Timers get to run between writes, as they do for a Worker guest
      for (let i = 0; i < 40; i++) {
        expect(await f.write(new Uint8Array(1024).fill(i))).toBe(1024);
        await new Promise(res => setTimeout(res, 0));
      }
      expect(stores).toBeLessThanOrEqual(2);
      await new Promise(res => setTimeout(res, 60)); // writes paused: stored now
      const st = await fs.stat('/tmp/kburst.bin');
      expect(st.size).toBe(40 * 1024);
      await f.close();
    } finally {
      (fs as any).writeFile = real;
      kernel.kill(proc.pid, A.SIGKILL);
    }
  });

  it("a process's writes reach the FileSystem when it exits, though a forked child still holds the file", async () => {
    const parent = kernel.spawn({ path: 'agent', cwd: '/tmp', run: () => new Promise<number>(() => {}) });
    const f = (await kernel.open(parent, 'kshared.txt', A.O_CREAT | A.O_WRONLY | A.O_TRUNC)) as OpenFile;
    const data = new Uint8Array(64);
    const fd = parent.fds.alloc(f);
    const child = kernel.vfork(parent); // shares the description, as ssh-agent's daemon does
    expect(await f.write(new TextEncoder().encode('one\n'))).toBe(4);
    expect(await f.write(new TextEncoder().encode('two\n'))).toBe(4);
    expect(kernel.syscallSync(parent, A.SYS_close, [fd], data)).toBeUndefined(); // dirty: needs a write-back
    expect(await kernel.syscall(parent, A.SYS_close, [fd], data)).toBe(0);
    expect(await fs.readFile('/tmp/kshared.txt', 'utf8')).toBe('one\ntwo\n');
    expect(refCount(f)).toBe(1);
    kernel.kill(child.pid, A.SIGKILL);
    kernel.kill(parent.pid, A.SIGKILL);
  });

  it('syscallSync answers open/stat/close of cached files like the async path', async () => {
    await fs.mkdir('/tmp/ksync', { recursive: true });
    await fs.writeFile('/tmp/ksync/a.txt', 'hello');
    await fs.symlink('/tmp/ksync/a.txt', '/tmp/ksync/link');
    await fs.readdir('/tmp/ksync'); // loads the key index
    const proc = kernel.spawn({ path: 'holder', cwd: '/tmp/ksync', run: () => new Promise<number>(() => {}) });
    const data = new Uint8Array(4096);
    const put = (s: string) => { const b = bytes(s); data.set(b); return b.length; };
    const fd = kernel.syscallSync(proc, A.SYS_openat, [A.AT_FDCWD, put('link'), A.O_RDONLY, 0], data)!;
    expect(fd).toBeGreaterThanOrEqual(0);
    expect(kernel.syscallSync(proc, A.SYS_read, [fd, 100], data)).toBe(5);
    expect(dec.decode(data.subarray(0, 5))).toBe('hello');
    expect(kernel.syscallSync(proc, A.SYS_newfstatat, [A.AT_FDCWD, put('a.txt'), 0], data)).toBe(0);
    expect(A.decodeStat(data).size).toBe(5);
    expect(kernel.syscallSync(proc, A.SYS_newfstatat, [A.AT_FDCWD, put('link'), A.AT_SYMLINK_NOFOLLOW], data)).toBe(0);
    expect(A.decodeStat(data).mode & A.S_IFMT).toBe(A.S_IFLNK);
    expect(kernel.syscallSync(proc, A.SYS_openat, [A.AT_FDCWD, put('nope'), A.O_RDONLY, 0], data)).toBe(-A.ENOENT);
    expect(kernel.syscallSync(proc, A.SYS_openat, [A.AT_FDCWD, put('a.txt'), A.O_RDONLY | A.O_DIRECTORY, 0], data)).toBe(-A.ENOTDIR);
    // O_CREAT and O_TRUNC take the async path
    expect(kernel.syscallSync(proc, A.SYS_openat, [A.AT_FDCWD, put('b.txt'), A.O_CREAT | A.O_WRONLY, 0o644], data)).toBeUndefined();
    expect(kernel.syscallSync(proc, A.SYS_close, [fd], data)).toBe(0);
    expect(kernel.syscallSync(proc, A.SYS_close, [fd], data)).toBe(-A.EBADF);
    // A file with unwritten data closes through the async path, which stores it
    const w = (await kernel.open(proc, 'a.txt', A.O_WRONLY | A.O_APPEND)) as OpenFile;
    const wfd = proc.fds.alloc(w);
    await w.write(bytes(' world'));
    expect(kernel.syscallSync(proc, A.SYS_close, [wfd], data)).toBeUndefined();
    expect(await kernel.syscall(proc, A.SYS_close, [wfd], data)).toBe(0);
    expect(await fs.readFile('/tmp/ksync/a.txt', 'utf8')).toBe('hello world');
    kernel.kill(proc.pid, A.SIGKILL);
  });

  it('readdir keeps its directory index current across create, unlink and rename', async () => {
    await fs.mkdir('/tmp/kidx/sub', { recursive: true });
    await fs.writeFile('/tmp/kidx/one', '1');
    expect(await fs.readdir('/tmp/kidx')).toEqual(['one', 'sub']);
    await fs.writeFile('/tmp/kidx/two', '2');
    await fs.unlink('/tmp/kidx/one');
    await fs.rename('/tmp/kidx/two', '/tmp/kidx/sub/three');
    expect(await fs.readdir('/tmp/kidx')).toEqual(['sub']);
    expect(await fs.readdir('/tmp/kidx/sub')).toEqual(['three']);
    await fs.rmdir('/tmp/kidx/sub').catch(async () => { await fs.unlink('/tmp/kidx/sub/three'); await fs.rmdir('/tmp/kidx/sub'); });
    expect(await fs.readdir('/tmp/kidx')).toEqual([]);
  });

  it('syscall dispatch: pipe2/dup2/fcntl/getdents in-page', async () => {
    const proc = kernel.spawn({ path: 'sc', cwd: '/tmp', fds: {}, run: () => new Promise<number>(() => {}) });
    const data = new Uint8Array(4096);
    expect(await kernel.syscall(proc, A.SYS_pipe2, [A.O_CLOEXEC], data)).toBe(0);
    const dv = new DataView(data.buffer);
    const [r, w] = [dv.getInt32(0, true), dv.getInt32(4, true)];
    expect([r, w]).toEqual([0, 1]);
    expect(await kernel.syscall(proc, A.SYS_fcntl, [r, A.F_GETFD], data)).toBe(A.FD_CLOEXEC);
    expect(await kernel.syscall(proc, A.SYS_dup2, [w, 9], data)).toBe(9);
    expect(await kernel.syscall(proc, A.SYS_fcntl, [9, A.F_GETFD], data)).toBe(0);
    data.set(bytes('xyz'));
    expect(await kernel.syscall(proc, A.SYS_write, [9, 3], data)).toBe(3);
    expect(await kernel.syscall(proc, A.SYS_read, [r, 10], data)).toBe(3);
    expect(dec.decode(data.subarray(0, 3))).toBe('xyz');
    expect(await kernel.syscall(proc, 4242, [], data)).toBe(-A.ENOSYS);
    // FIONBIO on a pipe (Rust's Command::output() makes its pipes non-blocking so)
    dv.setInt32(0, 1, true);
    expect(await kernel.syscall(proc, A.SYS_ioctl, [r, A.FIONBIO, 4], data)).toBe(0);
    expect(await kernel.syscall(proc, A.SYS_read, [r, 10], data)).toBe(-A.EAGAIN);

    await fs.mkdir('/tmp/kdir', { recursive: true });
    await fs.writeFile('/tmp/kdir/f1', '1');
    const path = bytes('kdir');
    data.set(path);
    const dfd = await kernel.syscall(proc, A.SYS_openat, [A.AT_FDCWD, path.length, A.O_RDONLY | A.O_DIRECTORY, 0], data);
    expect(dfd).toBeGreaterThanOrEqual(0);
    const n = await kernel.syscall(proc, A.SYS_getdents64, [dfd, 4096], data);
    const names: string[] = [];
    for (let off = 0; off < n;) {
      const reclen = dv.getUint16(off + 16, true);
      const nameBytes = data.subarray(off + 19, off + reclen);
      names.push(dec.decode(nameBytes.subarray(0, nameBytes.indexOf(0))));
      if (names[names.length - 1] === 'f1') expect(dv.getUint8(off + 18)).toBe(A.DT_REG);
      off += reclen;
    }
    expect(names).toEqual(['.', '..', 'f1']);
    expect(await kernel.syscall(proc, A.SYS_getdents64, [dfd, 4096], data)).toBe(0);
    kernel.kill(proc.pid, A.SIGKILL);
  });

  it('registerSyscalls: handlers run first and can pass calls on', async () => {
    const proc = kernel.spawn({ path: 'r', fds: {}, run: () => new Promise<number>(() => {}) });
    const seen: number[] = [];
    const off = kernel.registerSyscalls({ lo: 2000, hi: 2001 }, (_p, nr, args) => { seen.push(nr); return nr === 2000 ? args[0] * 2 : undefined; });
    const offGetpid = kernel.registerSyscalls([A.SYS_getpid], () => undefined);
    const data = new Uint8Array(16);
    expect(await kernel.syscall(proc, 2000, [21], data)).toBe(42);
    expect(await kernel.syscall(proc, 2001, [], data)).toBe(-A.ENOSYS);
    expect(await kernel.syscall(proc, A.SYS_getpid, [], data)).toBe(proc.pid);
    off();
    offGetpid();
    expect(await kernel.syscall(proc, 2000, [21], data)).toBe(-A.ENOSYS);
    expect(seen).toEqual([2000, 2001]);
    // socket numbers fall through to ENOSYS until net.ts registers them
    expect(await kernel.syscall(proc, A.SYS_socket, [A.AF_INET, A.SOCK_STREAM, 0], data)).toBe(-A.ENOSYS);
    kernel.kill(proc.pid, A.SIGKILL);
  });

  it('onSpawn sees processes before they run; spawn inherits non-cloexec fds', async () => {
    const order: string[] = [];
    const off = kernel.onSpawn(p => order.push(`spawn ${p.argv[0]}`));
    const keep = new BufferFile();
    const secret = new BufferFile();
    const parent = kernel.spawn({ path: 'parent', fds: { 0: new DevNull(), 1: keep, 2: keep }, run: () => new Promise<number>(() => {}) });
    parent.fds.alloc(new BufferFile(), 5);
    parent.fds.alloc(secret, 6, true);
    const child = kernel.spawn({ path: 'child', parent, run: async () => { order.push('run child'); return 0; } });
    expect(order).toEqual(['spawn parent', 'spawn child']);
    expect(child.fds.get(1)).toBe(keep);
    expect(child.fds.has(5)).toBe(true);
    expect(child.fds.has(6)).toBe(false);
    const mapped = kernel.spawn({ path: 'm', parent, fds: { 1: secret }, inheritFds: true, run: async () => 0 });
    expect(mapped.fds.get(1)).toBe(secret);
    expect(mapped.fds.get(0)).toBe(parent.fds.get(0));
    expect(mapped.fds.has(6)).toBe(false);
    await child.wait();
    expect(order).toContain('run child');
    off();
    kernel.kill(parent.pid, A.SIGKILL);
  });

  it('stopped processes show as stopped in the process table', async () => {
    const p = kernel.spawn({ path: 'stopme', run: () => new Promise<number>(() => {}) });
    kernel.kill(p.pid, A.SIGTSTP);
    expect(processTable.get(p.pid)?.status).toBe('stopped');
    kernel.kill(p.pid, A.SIGCONT);
    expect(processTable.get(p.pid)?.status).toBe('running');
    kernel.kill(p.pid, A.SIGKILL);
  });

  it('ioctl receives the caller, and Process.fromSyscallSignal maps it back', async () => {
    let caller: Process | undefined;
    const dev: OpenFile = Object.assign(new DevNull(), {
      ioctl: async (_req: number, _arg: Uint8Array, sig?: AbortSignal) => { caller = Process.fromSyscallSignal(sig); return 0; },
    });
    const proc = kernel.spawn({ path: 'io', fds: { 0: dev }, run: () => new Promise<number>(() => {}) });
    expect(await kernel.syscall(proc, A.SYS_ioctl, [0, A.TCGETS, 0], new Uint8Array(64))).toBe(0);
    expect(caller).toBe(proc);
    kernel.kill(proc.pid, A.SIGKILL);
  });

  it('epoll in-page: one-shot, closed descriptions drop out', async () => {
    const ep = new EpollFile();
    const [r, w] = createPipe();
    const t = new FdTable();
    t.alloc(r, 3);
    t.alloc(w, 4);
    expect(ep.ctl(A.EPOLL_CTL_ADD, 3, r, A.EPOLLIN | A.EPOLLONESHOT, 3, 0)).toBe(0);
    const out = new Uint8Array(120);
    const waiting = ep.wait(out, 10, -1);
    await w.write(bytes('z'));
    expect(await waiting).toBe(1);
    expect(await ep.wait(out, 10, 0)).toBe(0); // one-shot: disabled until MOD
    expect(ep.ctl(A.EPOLL_CTL_MOD, 3, r, A.EPOLLIN, 3, 0)).toBe(0);
    expect(await ep.wait(out, 10, 0)).toBe(1);
    expect(ep.poll(A.POLLIN)).toBe(A.POLLIN);
    await t.close(3);
    expect(await ep.wait(out, 10, 0)).toBe(0);
    expect(ep.ctl(A.EPOLL_CTL_DEL, 3, r, 0, 0, 0)).toBe(-A.ENOENT);
  });

  it('rt_sigprocmask defers default-action signals until unblocked', async () => {
    const p = kernel.spawn({ path: 'masked', fds: {}, run: () => new Promise<number>(() => {}) });
    const data = new Uint8Array(16);
    new DataView(data.buffer).setUint32(0, 1 << (A.SIGTERM - 1), true);
    expect(await kernel.syscall(p, A.SYS_rt_sigprocmask, [A.SIG_BLOCK, 1, 0], data)).toBe(0);
    kernel.kill(p.pid, A.SIGTERM);
    await new Promise(r => setTimeout(r, 5));
    expect(p.state).toBe('running');
    expect(await kernel.syscall(p, A.SYS_rt_sigpending, [], data)).toBe(0);
    expect(new DataView(data.buffer).getUint32(0, true)).toBe(1 << (A.SIGTERM - 1));
    expect(await kernel.syscall(p, A.SYS_rt_sigprocmask, [A.SIG_UNBLOCK, 1, 0], data)).toBe(0);
    expect(A.WTERMSIG(await p.wait())).toBe(A.SIGTERM);
  });

  it('SIGPIPE kills a writer whose reader is gone', async () => {
    const [r, w] = createPipe();
    await r.close();
    const p = kernel.spawn({ path: 'yes', run: async (proc, k) => {
      await k.syscall(proc, A.SYS_write, [1, 1], bytes('y'));
      return 0;
    }, fds: { 1: w } });
    expect(A.WTERMSIG(await p.wait())).toBe(A.SIGPIPE);
  });
});

describe('worker guests over the SAB channel', () => {
  let fs: FileSystem;
  let shell: Shell;
  let kernel: Kernel;
  let guestCode: string;

  const nodeWorker = (): GuestWorker => {
    const w = new Worker(guestCode, { eval: true });
    return {
      postMessage: m => w.postMessage(m),
      terminate: () => w.terminate(),
      onMessage: cb => w.on('message', cb),
      onError: cb => w.on('error', cb),
      onExit: cb => w.on('exit', cb),
    };
  };
  const guest = (argv: string[], fds: Record<number, OpenFile>, opts: { dataSize?: number; cwd?: string } = {}) =>
    startWorker(kernel, nodeWorker, { path: '/bin/kernel-guest', argv: ['kernel-guest', ...argv], fds, cwd: opts.cwd }, { dataSize: opts.dataSize });

  // Browsers throw on TextDecoder.decode of SharedArrayBuffer views; Node
  // doesn't. Make the kernel side behave like a browser for these tests (the
  // guest fixture does the same in its worker).
  const realDecode = TextDecoder.prototype.decode;
  let sharedDecodes = 0;
  beforeAll(() => {
    TextDecoder.prototype.decode = function (input?: AllowSharedBufferSource, o?: TextDecodeOptions) {
      const buf = input && ArrayBuffer.isView(input) ? input.buffer : input;
      if (buf instanceof SharedArrayBuffer) { sharedDecodes++; throw new TypeError('decode of SharedArrayBuffer-backed input'); }
      return realDecode.call(this, input, o);
    };
  });
  afterAll(() => {
    TextDecoder.prototype.decode = realDecode;
    expect(sharedDecodes).toBe(0);
  });

  beforeAll(async () => {
    ({ fs, shell } = await createTestShell());
    await fs.mkdir('/tmp', { recursive: true }).catch(() => {});
    const result = await build({
      entryPoints: [`${__dirname}/fixtures/kernel-guest.ts`],
      bundle: true, platform: 'node', format: 'cjs', write: false, target: 'node18',
    });
    guestCode = result.outputFiles[0].text;
  }, 30000);
  beforeEach(() => { kernel = new Kernel({ shell }); });
  afterEach(() => kernel.dispose());

  it('canBlock reports sab in Node', () => {
    expect(canBlock()).toBe('sab');
  });

  it('blocking read on stdin, write to stdout, exit status', async () => {
    const [r, w] = createPipe();
    const out = new BufferFile();
    const p = guest(['upper'], { 0: r, 1: out, 2: out });
    // The guest is blocked in read() until this arrives
    await new Promise(res => setTimeout(res, 50));
    expect(p.state).toBe('running');
    await w.write(bytes('blocking '));
    await new Promise(res => setTimeout(res, 20));
    await w.write(bytes('syscalls'));
    await w.close();
    expect(A.WEXITSTATUS(await p.wait())).toBe(0);
    expect(out.text()).toBe('BLOCKING SYSCALLS');
  }, 20000);

  it('exit code and process info', async () => {
    const out = new BufferFile();
    expect(A.WEXITSTATUS(await guest(['exit', '42'], { 1: out }).wait())).toBe(42);
    const p = guest(['info'], { 1: out }, { cwd: '/tmp' });
    await p.wait();
    const info = JSON.parse(out.text());
    expect(info).toMatchObject({ pid: p.pid, ppid: 1, cwd: '/tmp', argv: ['kernel-guest', 'info'] });
  }, 20000);

  it('pipes and files from inside the guest', async () => {
    const out = new BufferFile();
    await guest(['pipe'], { 1: out }).wait();
    expect(out.text()).toBe('through the pipe\n');
    const out2 = new BufferFile();
    expect(A.WEXITSTATUS(await guest(['files'], { 1: out2 }).wait())).toBe(0);
    expect(JSON.parse(out2.text())).toEqual({ size: 12, isReg: true, pos: 6, tail: 'kernel', missing: -A.ENOENT });
    expect(await fs.readFile('/tmp/kguest.txt', 'utf8')).toBe('hello kernel');
  }, 20000);

  it("guest posix_spawn runs Shiro's ls and waits for it", async () => {
    await fs.mkdir('/tmp/kspawn', { recursive: true });
    await fs.writeFile('/tmp/kspawn/one.txt', '1');
    await fs.writeFile('/tmp/kspawn/two.txt', '2');
    const out = new BufferFile();
    const p = guest(['spawn', 'ls', '/tmp/kspawn'], { 0: new DevNull(), 1: out, 2: out });
    expect(A.WEXITSTATUS(await p.wait())).toBe(0);
    const res = JSON.parse(out.text());
    expect(res).toMatchObject({ pid: true, exited: true, code: 0 });
    expect(res.out.split(/\s+/).filter(Boolean)).toEqual(['one.txt', 'two.txt']);

    const out2 = new BufferFile();
    await guest(['spawn', 'definitely-not-a-command'], { 1: out2, 2: out2 }).wait();
    expect(out2.text()).toBe(`spawn failed ${-A.ENOENT}\n`);
  }, 20000);

  it('SIGKILL terminates a guest blocked in read()', async () => {
    const [r, w] = createPipe();
    const out = new BufferFile();
    const p = guest(['block'], { 0: r, 1: out });
    for (let i = 0; i < 200 && !out.text(); i++) await new Promise(res => setTimeout(res, 10));
    expect(out.text()).toBe('blocking\n');
    expect(p.state).toBe('running');
    expect(kernel.kill(p.pid, A.SIGKILL)).toBe(0);
    const st = await p.wait();
    expect(A.WIFSIGNALED(st) && A.WTERMSIG(st)).toBe(A.SIGKILL);
    // its read end closed with it: writers now get EPIPE
    expect(await w.write(bytes('x'))).toBe(-A.EPIPE);
  }, 20000);

  it('splits writes larger than the data area', async () => {
    const [r, w] = createPipe();
    const size = 300_000;
    const p = guest(['big', String(size)], { 1: w }, { dataSize: 65536 });
    const got: number[] = [];
    const buf = new Uint8Array(50000);
    for (;;) {
      const n = await r.read(buf);
      if (n <= 0) break;
      for (let i = 0; i < n; i++) got.push(buf[i]);
    }
    expect(A.WEXITSTATUS(await p.wait())).toBe(0);
    expect(got.length).toBe(size);
    expect(got.every((b, i) => b === (i & 0xff))).toBe(true);
  }, 20000);

  it('the decode trap catches shared-memory decodes', () => {
    const shared = new Uint8Array(new SharedArrayBuffer(4));
    expect(() => new TextDecoder().decode(shared)).toThrow();
    sharedDecodes--; // that one was on purpose
    expect(A.decodeText(shared)).toBe('\0\0\0\0');
  });

  it('path syscalls decode copies of the shared data area', async () => {
    const out = new BufferFile();
    const p = guest(['paths'], { 1: out, 2: out }, { cwd: '/tmp' });
    expect(A.WEXITSTATUS(await p.wait())).toBe(0);
    expect(out.text()).toBe('true 2 /tmp\n');
  }, 20000);

  it('*at syscalls, symlinks, rename, utimensat, link, pread/pwrite', async () => {
    await fs.rm('/tmp/kat', { recursive: true }).catch(() => {});
    const out = new BufferFile();
    const p = guest(['at'], { 1: out, 2: out });
    expect(A.WEXITSTATUS(await p.wait())).toBe(0);
    expect(JSON.parse(out.text())).toEqual({
      mkdirat: 0, pread: '3AB6', posAfterPread: 0, size: 10, mode: 0o600 & ~0o022,
      symlink: 0, readlink: 'sub/f.txt', isLink: true, rename: 0, noreplace: -A.EEXIST,
      utime: 0, mtime: 1_000_000_000_000, rmdirNotEmpty: -A.ENOTEMPTY, unlinkDir: -A.EISDIR, unlink: 0,
      link: 0, linked: '0123AB6789',
    });
  }, 20000);

  it('rt_sigaction handlers run with the signal masked; blocked signals wait; EINTR', async () => {
    const out = new BufferFile();
    const p = guest(['signals'], { 1: out, 2: out });
    for (let i = 0; i < 300 && !out.text().includes(']'); i++) await new Promise(res => setTimeout(res, 10));
    expect(JSON.parse(out.text().split('\n')[0])).toEqual([
      'old 0',
      `handler ${A.SIGUSR1} masked=true`,
      'after masked=false',
      `pending ${A.SIGUSR2}`,
      `handler ${A.SIGUSR2} masked=true`,
      'unblocked',
      `kill-handler ${-A.EINVAL}`,
    ]);
    // The guest is now blocked reading an empty pipe: a caught signal interrupts it
    await new Promise(res => setTimeout(res, 20));
    expect(kernel.kill(p.pid, A.SIGUSR1)).toBe(0);
    expect(A.WEXITSTATUS(await p.wait())).toBe(0);
    expect(out.text().split('\n')[1]).toBe(`read ${-A.EINTR}`);
  }, 20000);

  it('epoll (level, edge, modify, delete) and select', async () => {
    const out = new BufferFile();
    const p = guest(['epoll'], { 1: out, 2: out });
    expect(A.WEXITSTATUS(await p.wait())).toBe(0);
    const r = 0, w = 3; // fds 1 and 2 are taken
    expect(JSON.parse(out.text())).toEqual({
      ctl: 0, dup: -A.EEXIST, empty: [], ready: [{ events: A.EPOLLIN, data: 1234 }], edgeConsumed: [],
      edgeAgain: 1, mod: 0, level1: 1, level2: 1, regular: -A.EPERM,
      select: { n: 2, read: [r], write: [w] }, selectTimeout: 0, selectBad: -A.EBADF, del: 0, delAgain: -A.ENOENT,
    });
  }, 20000);

  it('posix_spawn without an fd map inherits non-cloexec fds', async () => {
    const out = new BufferFile();
    const p = guest(['spawn-inherit'], { 0: new DevNull(), 1: out, 2: out });
    expect(A.WEXITSTATUS(await p.wait())).toBe(0);
    expect(out.text()).toBe('inherited\n');
  }, 20000);

  it('attachThread runs a second Worker as a thread of the same process', async () => {
    const [r] = createPipe();
    const out = new BufferFile();
    const p = guest(['block'], { 0: r, 1: out });
    for (let i = 0; i < 200 && !out.text(); i++) await new Promise(res => setTimeout(res, 10));
    const t = attachThread(kernel, p, () => nodeWorker());
    expect(await t.exited).toBe(0);
    expect(out.text()).toBe(`blocking\nthread tid=${t.tid} pid=${p.pid} start=${t.tid}\n`);
    expect(p.state).toBe('running');
    expect(p.tids.has(t.tid)).toBe(false);
    expect(kernel.processOfTid(p.pid)).toBe(p);
    // a second thread dies with the process
    const t2 = attachThread(kernel, p, () => nodeWorker());
    expect(kernel.processOfTid(t2.tid)).toBe(p);
    kernel.kill(p.pid, A.SIGKILL);
    await p.wait();
    expect([undefined, 0]).toContain(await t2.exited);
  }, 20000);

  it('poll times out, then wakes when input arrives; nanosleep sleeps', async () => {
    const [r, w] = createPipe();
    const out = new BufferFile();
    const p = guest(['poll'], { 0: r, 1: out });
    for (let i = 0; i < 200 && !out.text(); i++) await new Promise(res => setTimeout(res, 10));
    expect(out.text()).toBe('first 0\n');
    await w.write(bytes('ping'));
    await p.wait();
    expect(out.text()).toBe('first 0\nsecond 1 in ping\n');

    const out2 = new BufferFile();
    await guest(['sleep', '60'], { 1: out2 }).wait();
    expect(Number(out2.text())).toBeGreaterThanOrEqual(55);
  }, 20000);
});
