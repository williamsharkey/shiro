/**
 * Kernel syscall behaviour the LTP conformance run (tests/conformance/
 * syscalls-ltp.conf.ts) found missing; each case names the LTP test.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestShell } from './helpers';
import type { FileSystem } from '@shiro/filesystem';
import { Kernel } from '@shiro/kernel/kernel';
import type { Process } from '@shiro/kernel/process';
import * as A from '@shiro/kernel/abi';
import { NetStack, installNet } from '@shiro/kernel/net';

describe('kernel syscalls found by LTP', () => {
  let fs: FileSystem;
  let kernel: Kernel;
  let proc: Process;
  const enc = new TextEncoder();
  const call = (nr: number, args: number[], ...paths: string[]) => {
    const data = new Uint8Array(4096);
    let off = 0;
    for (const p of paths) { const b = enc.encode(p); data.set(b, off); off += b.length; }
    return kernel.syscall(proc, nr, args, data);
  };
  const L = (s: string) => enc.encode(s).length;
  const open = (p: string, flags: number) => call(A.SYS_openat, [A.AT_FDCWD, L(p), flags, 0o644], p);
  const pipe = async (flags = 0) => {
    const data = new Uint8Array(16);
    expect(await kernel.syscall(proc, A.SYS_pipe2, [flags], data)).toBe(0);
    const dv = new DataView(data.buffer);
    return [dv.getInt32(0, true), dv.getInt32(4, true)];
  };
  const fstatMode = async (fd: number) => {
    const data = new Uint8Array(256);
    expect(await kernel.syscall(proc, A.SYS_fstat, [fd], data)).toBe(0);
    return new DataView(data.buffer).getUint32(24, true);
  };

  beforeAll(async () => {
    ({ fs } = await createTestShell());
    kernel = new Kernel({ fs, registerWithProcessTable: false });
    await fs.mkdir('/tmp/kc', { recursive: true });
    await fs.writeFile('/tmp/kc/file', 'data');
    proc = kernel.spawn({ path: 'holder', cwd: '/tmp/kc', fds: {}, run: () => new Promise<number>(() => {}) });
  });
  afterAll(() => { kernel.kill(proc.pid, A.SIGKILL); });

  it('fchmod01: fstat of an open file sees the new mode', async () => {
    const fd = await open('file', A.O_RDWR);
    for (const mode of [0, 0o7, 0o700, 0o6777]) {
      expect(await kernel.syscall(proc, A.SYS_fchmod, [fd, mode], new Uint8Array(8))).toBe(0);
      expect((await fstatMode(fd)) & 0o7777).toBe(mode);
    }
    await kernel.syscall(proc, A.SYS_close, [fd], new Uint8Array(8));
  });

  it('chdir04/dup3_02/lstat02: ENAMETOOLONG, dup3 flags, ENOTDIR through a file', async () => {
    const long = 'x'.repeat(256);
    expect(await call(A.SYS_chdir, [L(long)], long)).toBe(-A.ENAMETOOLONG);
    expect(await call(A.SYS_dup3, [0, 5, -1])).toBe(-A.EINVAL);
    expect(await call(A.SYS_stat, [L('file/x')], 'file/x')).toBe(-A.ENOTDIR);
    expect(await call(A.SYS_stat, [L('nodir/x')], 'nodir/x')).toBe(-A.ENOENT);
  });

  it('open13: an O_PATH fd can be fstat-ed and dup-ed but not read, written or chmod-ed', async () => {
    const fd = await open('file', A.O_PATH);
    expect(fd).toBeGreaterThanOrEqual(0);
    expect((await fstatMode(fd)) & A.S_IFMT).toBe(A.S_IFREG);
    expect(await call(A.SYS_read, [fd, 4])).toBe(-A.EBADF);
    expect(await call(A.SYS_write, [fd, 4])).toBe(-A.EBADF);
    expect(await call(A.SYS_fchmod, [fd, 0o600])).toBe(-A.EBADF);
    const dup = await call(A.SYS_dup, [fd]);
    expect(await call(A.SYS_read, [dup, 4])).toBe(-A.EBADF);
    expect((await call(A.SYS_fcntl, [dup, A.F_GETFL])) & A.O_PATH).toBe(A.O_PATH);
  });

  it('fcntl30/37: F_GETPIPE_SZ and F_SETPIPE_SZ resize a pipe (pipe-max-size 1 MiB)', async () => {
    const [r, w] = await pipe(A.O_NONBLOCK);
    expect(await call(A.SYS_fcntl, [w, A.F_GETPIPE_SZ])).toBe(65536);
    expect(await call(A.SYS_fcntl, [w, A.F_SETPIPE_SZ, 4096])).toBe(4096);
    expect(await call(A.SYS_fcntl, [r, A.F_GETPIPE_SZ])).toBe(4096);
    const buf = new Uint8Array(8192).fill(97);
    expect(await kernel.syscall(proc, A.SYS_write, [w, 4096], buf)).toBe(4096);
    expect(await kernel.syscall(proc, A.SYS_write, [w, 4096], buf)).toBe(-A.EAGAIN);
    expect(await call(A.SYS_fcntl, [w, A.F_SETPIPE_SZ, 1048576])).toBe(1048576);
    expect(await call(A.SYS_fcntl, [w, A.F_SETPIPE_SZ, 1048577])).toBe(-A.EPERM);
    // shrinking below what's buffered: EBUSY; the data survives a resize
    expect(await kernel.syscall(proc, A.SYS_write, [w, 8192], buf)).toBe(8192);
    expect(await call(A.SYS_fcntl, [w, A.F_SETPIPE_SZ, 4096])).toBe(-A.EBUSY);
    const out = new Uint8Array(16384);
    expect(await kernel.syscall(proc, A.SYS_read, [r, 16384], out)).toBe(12288);
    const fd = await open('file', A.O_RDONLY);
    expect(await call(A.SYS_fcntl, [fd, A.F_GETPIPE_SZ])).toBe(-A.EBADF);
  });

  it('epoll_ctl04/epoll_wait14: nesting stops at 5 epolls; level-triggered reports rotate', async () => {
    const [r0] = await pipe();
    let inner = r0;
    for (let d = 0; d < 5; d++) {
      const ep = await call(A.SYS_epoll_create1, [0]);
      expect(await call(A.SYS_epoll_ctl, [ep, A.EPOLL_CTL_ADD, inner, A.EPOLLIN, 0, 0])).toBe(0);
      inner = ep;
    }
    const top = await call(A.SYS_epoll_create1, [0]);
    expect(await call(A.SYS_epoll_ctl, [top, A.EPOLL_CTL_ADD, inner, A.EPOLLIN, 0, 0])).toBe(-A.EINVAL);

    // 4 readable pipes, 2 events per wait: every pipe is reported equally often
    const ep = await call(A.SYS_epoll_create1, [0]);
    for (let i = 0; i < 4; i++) {
      const [r, w] = await pipe();
      await kernel.syscall(proc, A.SYS_write, [w, 1], new Uint8Array([1]));
      expect(await call(A.SYS_epoll_ctl, [ep, A.EPOLL_CTL_ADD, r, A.EPOLLIN, i, 0])).toBe(0);
    }
    const count = [0, 0, 0, 0];
    for (let round = 0; round < 4; round++) {
      const data = new Uint8Array(A.EPOLL_EVENT_SIZE * 2);
      expect(await kernel.syscall(proc, A.SYS_epoll_wait, [ep, 2, 0], data)).toBe(2);
      const dv = new DataView(data.buffer);
      for (let k = 0; k < 2; k++) count[dv.getUint32(k * A.EPOLL_EVENT_SIZE + 4, true)]++;
    }
    expect(count).toEqual([2, 2, 2, 2]);
  });

  it('fcntl14/15: record locks conflict across processes, F_GETLK names the holder, SETLKW waits, close releases', async () => {
    const other = kernel.spawn({ path: 'other', cwd: '/tmp/kc', fds: {}, run: () => new Promise<number>(() => {}) });
    const flock = (type: number, start: number, len: number) => {
      const d = new Uint8Array(A.FLOCK_SIZE);
      const dv = new DataView(d.buffer);
      dv.setInt16(0, type, true);
      dv.setBigInt64(8, BigInt(start), true);
      dv.setBigInt64(16, BigInt(len), true);
      return d;
    };
    const o = (p: Process) => kernel.syscall(p, A.SYS_openat, [A.AT_FDCWD, L('file'), A.O_RDWR, 0], enc.encode('file'));
    const fa = await o(proc), fb = await o(other);
    expect(await kernel.syscall(proc, A.SYS_fcntl, [fa, A.F_SETLK], flock(1, 0, 10))).toBe(0);
    // overlapping write lock from another process: EAGAIN; a disjoint one is fine
    expect(await kernel.syscall(other, A.SYS_fcntl, [fb, A.F_SETLK], flock(1, 5, 10))).toBe(-A.EAGAIN);
    expect(await kernel.syscall(other, A.SYS_fcntl, [fb, A.F_SETLK], flock(1, 10, 5))).toBe(0);
    const q = flock(0, 0, 0);
    expect(await kernel.syscall(other, A.SYS_fcntl, [fb, A.F_GETLK], q)).toBe(0);
    const qv = new DataView(q.buffer);
    expect([qv.getInt16(0, true), Number(qv.getBigInt64(16, true)), qv.getInt32(24, true)]).toEqual([1, 10, proc.pid]);
    // a bad l_type is EINVAL
    expect(await kernel.syscall(proc, A.SYS_fcntl, [fa, A.F_SETLK], flock(7, 0, 1))).toBe(-A.EINVAL);
    // F_SETLKW waits until the holder closes its fd
    let done = false;
    const waiting = kernel.syscall(other, A.SYS_fcntl, [fb, A.F_SETLKW], flock(1, 0, 10)).then((r) => { done = true; return r; });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    expect(await kernel.syscall(proc, A.SYS_close, [fa], new Uint8Array(8))).toBe(0);
    expect(await waiting).toBe(0);
    kernel.kill(other.pid, A.SIGKILL);
  });

  it('socket01/socketpair01/bind01: bad type EINVAL, inet socketpair EOPNOTSUPP after socket checks, AF_UNIX address on inet EAFNOSUPPORT', async () => {
    const stack = new NetStack();
    stack.configure({ relayUrl: null, tokenUrl: null, dohUrl: null, portHost: null });
    const off = installNet(kernel, stack);
    expect(await call(A.SYS_socket, [A.AF_INET, 75, 0])).toBe(-A.EINVAL);
    expect(await call(A.SYS_socket, [0, A.SOCK_STREAM, 0])).toBe(-A.EAFNOSUPPORT);
    expect(await call(A.SYS_socketpair, [A.AF_INET, 75, 0])).toBe(-A.EINVAL);
    expect(await call(A.SYS_socketpair, [A.AF_UNIX, 75, 0])).toBe(-A.EINVAL);
    expect(await call(A.SYS_socketpair, [A.AF_INET, 2, 6])).toBe(-A.EPROTONOSUPPORT); // TCP dgram
    expect(await call(A.SYS_socketpair, [A.AF_INET, 2, 17])).toBe(-A.EOPNOTSUPP); // UDP
    const s = await call(A.SYS_socket, [A.AF_INET, A.SOCK_STREAM, 0]);
    expect(s).toBeGreaterThanOrEqual(0);
    const sun = new Uint8Array(110);
    sun[0] = A.AF_UNIX;
    sun.set(enc.encode('.'), 2);
    expect(await kernel.syscall(proc, A.SYS_bind, [s, 110], sun)).toBe(-A.EAFNOSUPPORT);
    await call(A.SYS_close, [s]);
    off();
  });

  it('waitpid04/alarm02: wait4 rejects unknown options; an alarm past setTimeout\'s range keeps its time', async () => {
    expect(await call(A.SYS_wait4, [-1, 0xffffffff])).toBe(-A.EINVAL);
    expect(await call(A.SYS_wait4, [-1, A.WNOHANG])).toBe(-A.ECHILD);
    expect(await call(A.SYS_alarm, [2147483647])).toBe(0);
    await new Promise((r) => setTimeout(r, 10));
    expect(await call(A.SYS_alarm, [0])).toBe(2147483647);
  });

  it('getcwd03/wait403/waitid10: chdir through a symlink gives the physical cwd; /proc/sys files LTP reads', async () => {
    await fs.mkdir('/tmp/kc/real', { recursive: true });
    await fs.symlink('real', '/tmp/kc/lnk');
    expect(await call(A.SYS_chdir, [L('lnk')], 'lnk')).toBe(0);
    const data = new Uint8Array(256);
    const n = await kernel.syscall(proc, A.SYS_getcwd, [256], data);
    expect(new TextDecoder().decode(data.subarray(0, n - 1))).toBe('/tmp/kc/real');
    expect(await call(A.SYS_chdir, [L('/tmp/kc')], '/tmp/kc')).toBe(0);
    for (const p of ['/proc/sys/kernel/tainted', '/proc/sys/kernel/core_pattern', '/proc/sys/fs/pipe-user-pages-soft']) {
      const fd = await open(p, A.O_RDONLY);
      expect(fd).toBeGreaterThanOrEqual(0);
      expect(await kernel.syscall(proc, A.SYS_read, [fd, 64], new Uint8Array(64))).toBeGreaterThan(0);
      await call(A.SYS_close, [fd]);
    }
  });

  it('epoll_wait16: EPOLLEXCLUSIVE wakes one waiter per event; epoll_ctl05-style flag checks', async () => {
    const [r, w] = await pipe();
    const eps: number[] = [];
    for (let i = 0; i < 3; i++) {
      const ep = await call(A.SYS_epoll_create1, [0]);
      expect(await call(A.SYS_epoll_ctl, [ep, A.EPOLL_CTL_ADD, r, A.EPOLLIN | A.EPOLLET | A.EPOLLEXCLUSIVE, i, 0])).toBe(0);
      eps.push(ep);
    }
    expect(await call(A.SYS_epoll_ctl, [eps[0], A.EPOLL_CTL_MOD, r, A.EPOLLIN, 0, 0])).toBe(-A.EINVAL);
    expect(await call(A.SYS_epoll_ctl, [eps[0], A.EPOLL_CTL_ADD, eps[1], A.EPOLLIN | A.EPOLLEXCLUSIVE, 0, 0])).toBe(-A.EINVAL);
    expect(await call(A.SYS_epoll_ctl, [eps[0], A.EPOLL_CTL_ADD, w, A.EPOLLOUT | A.EPOLLONESHOT | A.EPOLLEXCLUSIVE, 0, 0])).toBe(-A.EINVAL);
    const waits = eps.map((ep) => kernel.syscall(proc, A.SYS_epoll_wait, [ep, 1, 300], new Uint8Array(A.EPOLL_EVENT_SIZE)));
    await new Promise((res) => setTimeout(res, 10));
    await kernel.syscall(proc, A.SYS_write, [w, 1], new Uint8Array([1]));
    expect((await Promise.all(waits)).sort()).toEqual([0, 0, 1]);
  });
});
