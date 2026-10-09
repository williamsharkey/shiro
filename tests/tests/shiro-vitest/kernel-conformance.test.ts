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
});
