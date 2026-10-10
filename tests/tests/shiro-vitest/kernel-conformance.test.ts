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
import { NetStack, installNet, encodeSockaddr } from '@shiro/kernel/net';
import { JobControl, attachKernel } from '@shiro/kernel/signals';
import { ProcFs } from '@shiro/kernel/procfs';

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
    // accept03: socket calls on it are EBADF, not ENOTSOCK
    expect(await call(A.SYS_accept, [fd, 0, 0])).toBe(-A.EBADF);
    expect(await call(A.SYS_accept4, [fd, 0, 0, 0])).toBe(-A.EBADF);
    expect(await call(A.SYS_listen, [fd, 1])).toBe(-A.EBADF);
  });

  it('epoll_wait06: a pipe is writable again only once a read empties a page, not after a partial read', async () => {
    const [r, w] = await pipe(A.O_NONBLOCK);
    expect(await call(A.SYS_fcntl, [w, A.F_SETPIPE_SZ, 4096])).toBe(4096);
    expect(await kernel.syscall(proc, A.SYS_write, [w, 4096], new Uint8Array(4096))).toBe(4096);
    const pollOut = async () => {
      const pfd = new Uint8Array(8);
      new DataView(pfd.buffer).setInt32(0, w, true);
      new DataView(pfd.buffer).setInt16(4, A.POLLOUT, true);
      await kernel.syscall(proc, A.SYS_poll, [1, 0], pfd);
      return new DataView(pfd.buffer).getInt16(6, true) & A.POLLOUT;
    };
    expect(await pollOut()).toBe(0);
    // an edge-triggered reader isn't woken by a read making room (only data arriving arms it)
    const ep = await call(A.SYS_epoll_create1, [0]);
    expect(await call(A.SYS_epoll_ctl, [ep, A.EPOLL_CTL_ADD, r, A.POLLIN | A.EPOLLET, r, 0])).toBe(0);
    expect(await call(A.SYS_epoll_ctl, [ep, A.EPOLL_CTL_ADD, w, A.POLLOUT | A.EPOLLET, w, 0])).toBe(0);
    const evs = new Uint8Array(64);
    expect(await kernel.syscall(proc, A.SYS_epoll_wait, [ep, 4, 0], evs)).toBe(1); // the reader: data
    expect(await kernel.syscall(proc, A.SYS_read, [r, 2048], new Uint8Array(2048))).toBe(2048);
    expect(await pollOut()).toBe(0);
    expect(await kernel.syscall(proc, A.SYS_epoll_wait, [ep, 4, 0], evs)).toBe(0);
    expect(await kernel.syscall(proc, A.SYS_read, [r, 2048], new Uint8Array(2048))).toBe(2048);
    expect(await pollOut()).toBe(A.POLLOUT);
    expect(await kernel.syscall(proc, A.SYS_epoll_wait, [ep, 4, 0], evs)).toBe(1); // the writer: a page is free
    for (const fd of [r, w, ep]) await call(A.SYS_close, [fd]);
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
    // sendfile07: a socket is O_RDWR to F_GETFL (Blink checks sendfile's out fd by it)
    expect((await call(A.SYS_fcntl, [s, A.F_GETFL])) & A.O_ACCMODE).toBe(A.O_RDWR);
    const sun = new Uint8Array(110);
    sun[0] = A.AF_UNIX;
    sun.set(enc.encode('.'), 2);
    expect(await kernel.syscall(proc, A.SYS_bind, [s, 110], sun)).toBe(-A.EAFNOSUPPORT);
    await call(A.SYS_close, [s]);
    off();
  });

  it('dup06/pipe07/creat05: RLIMIT_NOFILE is the fd table\'s (prlimit64), and clone(CLONE_PARENT) makes a sibling (clone08)', async () => {
    const lim = new Uint8Array(16);
    const dv = new DataView(lim.buffer);
    expect(await kernel.syscall(proc, A.SYS_prlimit64, [0, A.RLIMIT_NOFILE, 0], lim)).toBe(0);
    expect([dv.getBigUint64(0, true), dv.getBigUint64(8, true)]).toEqual([1024n, 1048576n]);
    // lower the soft limit: fds stop below it, and F_DUPFD past it is EINVAL
    const child = kernel.vfork(proc);
    const set = (cur: bigint, max: bigint) => { dv.setBigUint64(0, cur, true); dv.setBigUint64(8, max, true); return kernel.syscall(child, A.SYS_prlimit64, [0, A.RLIMIT_NOFILE, 1], lim); };
    const openFile = () => kernel.syscall(child, A.SYS_openat, [A.AT_FDCWD, L('file'), A.O_RDONLY, 0], enc.encode('file'));
    const first = await openFile();
    expect(first).toBeGreaterThanOrEqual(0);
    expect(await set(BigInt(first + 3), 1048576n)).toBe(0);
    const fds: number[] = [first];
    for (let fd; (fd = await openFile()) >= 0;) fds.push(fd);
    expect(Math.max(...fds)).toBe(first + 2);
    expect(await openFile()).toBe(-A.EMFILE);
    expect(await kernel.syscall(child, A.SYS_fcntl, [first, A.F_DUPFD, first + 3], new Uint8Array(8))).toBe(-A.EINVAL);
    // soft above hard is EINVAL; raising the hard limit takes root, and nothing goes past fs.nr_open
    expect(await set(16n, 8n)).toBe(-A.EINVAL);
    expect(await set(8n, 1048577n)).toBe(-A.EPERM);
    // a fork keeps the limit
    const grandchild = kernel.vfork(child);
    expect(grandchild.fds.limit).toBe(first + 3);
    // CLONE_PARENT: the new process is the caller's sibling
    const sib = await kernel.syscall(child, A.SYS_shiro_vfork, [A.CLONE_PARENT], new Uint8Array(8));
    expect(kernel.procs.get(sib)!.ppid).toBe(proc.pid);
    for (const pid of [grandchild.pid, sib, child.pid]) kernel.kill(pid, A.SIGKILL);
    for (const pid of [sib, child.pid]) await kernel.syscall(proc, A.SYS_wait4, [pid, 0], new Uint8Array(8));
  });

  it('memfd_create: an in-memory regular file that seeks, truncates, and epoll refuses (epoll_ctl06 /proc/self/maps)', async () => {
    const fd = await call(A.SYS_memfd_create, [L('maps'), A.MFD_CLOEXEC], 'maps');
    expect(fd).toBeGreaterThanOrEqual(0);
    expect(await kernel.syscall(proc, A.SYS_write, [fd, 5], enc.encode('hello'))).toBe(5);
    expect(await call(A.SYS_lseek, [fd, 1, 0, A.SEEK_SET])).toBe(1);
    const buf = new Uint8Array(8);
    expect(await kernel.syscall(proc, A.SYS_read, [fd, 8], buf)).toBe(4);
    expect(new TextDecoder().decode(buf.subarray(0, 4))).toBe('ello');
    expect((await fstatMode(fd)) & A.S_IFMT).toBe(A.S_IFREG);
    expect(await call(A.SYS_ftruncate, [fd, 2, 0])).toBe(0);
    expect(await kernel.syscall(proc, A.SYS_pread64, [fd, 8, 0, 0], buf)).toBe(2);
    const ep = await call(A.SYS_epoll_create1, [0]);
    expect(await call(A.SYS_epoll_ctl, [ep, A.EPOLL_CTL_ADD, fd, A.POLLIN, 0, 0])).toBe(-A.EPERM);
    expect(await call(A.SYS_memfd_create, [L('x'), 8], 'x')).toBe(-A.EINVAL);
    for (const f of [fd, ep]) await call(A.SYS_close, [f]);
  });

  it('memfd seals: F_ADD_SEALS/F_GET_SEALS with MFD_ALLOW_SEALING, enforced on truncate and write (memfd_create01)', async () => {
    const fd = await call(A.SYS_memfd_create, [L('s'), A.MFD_ALLOW_SEALING], 's');
    expect(await call(A.SYS_ftruncate, [fd, 4096, 0])).toBe(0);
    expect(await call(A.SYS_fcntl, [fd, A.F_GET_SEALS, 0])).toBe(0);
    expect(await call(A.SYS_fcntl, [fd, A.F_ADD_SEALS, A.F_SEAL_GROW | A.F_SEAL_SHRINK])).toBe(0);
    expect(await call(A.SYS_fcntl, [fd, A.F_GET_SEALS, 0])).toBe(A.F_SEAL_GROW | A.F_SEAL_SHRINK);
    expect(await call(A.SYS_ftruncate, [fd, 8192, 0])).toBe(-A.EPERM);
    expect(await call(A.SYS_ftruncate, [fd, 10, 0])).toBe(-A.EPERM);
    expect(await kernel.syscall(proc, A.SYS_pwrite64, [fd, 5, 4094, 0], enc.encode('hello'))).toBe(-A.EPERM);
    expect(await kernel.syscall(proc, A.SYS_pwrite64, [fd, 5, 0, 0], enc.encode('hello'))).toBe(5);
    expect(await call(A.SYS_fcntl, [fd, A.F_ADD_SEALS, A.F_SEAL_WRITE | A.F_SEAL_SEAL])).toBe(0);
    expect(await kernel.syscall(proc, A.SYS_pwrite64, [fd, 5, 0, 0], enc.encode('hello'))).toBe(-A.EPERM);
    expect(await call(A.SYS_fcntl, [fd, A.F_ADD_SEALS, A.F_SEAL_FUTURE_WRITE])).toBe(-A.EPERM);
    // without MFD_ALLOW_SEALING it starts sealed against seals; other files have none
    const plain = await call(A.SYS_memfd_create, [L('p'), 0], 'p');
    expect(await call(A.SYS_fcntl, [plain, A.F_GET_SEALS, 0])).toBe(A.F_SEAL_SEAL);
    expect(await call(A.SYS_fcntl, [plain, A.F_ADD_SEALS, A.F_SEAL_GROW])).toBe(-A.EPERM);
    const ep = await call(A.SYS_epoll_create1, [0]);
    expect(await call(A.SYS_fcntl, [ep, A.F_GET_SEALS, 0])).toBe(-A.EINVAL);
    for (const f of [fd, plain, ep]) await call(A.SYS_close, [f]);
  });

  it('Open POSIX mq_*: POSIX message queues by priority, full/empty, timeouts, attributes, notify', async () => {
    const attr = (maxmsg: number, msgsize: number) => {
      const b = new Uint8Array(32); const v = new DataView(b.buffer);
      v.setBigInt64(8, BigInt(maxmsg), true); v.setBigInt64(16, BigInt(msgsize), true);
      return b;
    };
    const open = (name: string, oflag: number, a?: Uint8Array) => {
      const d = new Uint8Array(512); d.set(enc.encode(name)); if (a) d.set(a, name.length);
      return kernel.syscall(proc, A.SYS_mq_open, [name.length, oflag, 0o600, a ? 1 : 0], d);
    };
    const send = (fd: number, text: string, prio: number) => kernel.syscall(proc, A.SYS_mq_timedsend, [fd, text.length, prio, 0], enc.encode(text));
    const recv = async (fd: number, len = 64, ts?: [number, number]) => {
      const d = new Uint8Array(8 + len);
      if (ts) { const v = new DataView(d.buffer); v.setBigInt64(0, BigInt(ts[0]), true); v.setBigInt64(8, BigInt(ts[1]), true); }
      const n = await kernel.syscall(proc, A.SYS_mq_timedreceive, [fd, len, ts ? 1 : 0], d);
      return n < 0 ? n : `${new DataView(d.buffer).getUint32(0, true)}:${new TextDecoder().decode(d.subarray(8, 8 + n))}`;
    };
    const fd = await open('q1', A.O_RDWR | A.O_CREAT | A.O_NONBLOCK, attr(3, 64));
    expect(fd).toBeGreaterThanOrEqual(0);
    expect(await open('q1', A.O_RDWR | A.O_CREAT | A.O_EXCL)).toBe(-A.EEXIST);
    expect(await open('nope', A.O_RDONLY)).toBe(-A.ENOENT);
    expect(await open('big', A.O_RDWR | A.O_CREAT, attr(11, 64))).toBe(-A.EINVAL); // past msg_max, unprivileged
    expect(await send(fd, 'low', 1)).toBe(0);
    expect(await send(fd, 'high', 9)).toBe(0);
    expect(await send(fd, 'low2', 1)).toBe(0);
    expect(await send(fd, 'full', 1)).toBe(-A.EAGAIN);
    expect(await send(fd, 'x'.repeat(65), 1)).toBe(-A.EMSGSIZE);
    expect(await recv(fd, 8)).toBe(-A.EMSGSIZE); // the buffer must hold mq_msgsize
    expect([await recv(fd), await recv(fd), await recv(fd)]).toEqual(['9:high', '1:low', '1:low2']);
    expect(await recv(fd)).toBe(-A.EAGAIN);
    // attributes: clear O_NONBLOCK, then a receive times out at its absolute deadline
    const ga = new Uint8Array(32);
    expect(await kernel.syscall(proc, A.SYS_mq_getsetattr, [fd, 1], ga)).toBe(0);
    expect(Number(new DataView(ga.buffer).getBigInt64(8, true))).toBe(3);
    const t = Date.now() + 50;
    expect(await recv(fd, 64, [Math.floor(t / 1000), (t % 1000) * 1e6])).toBe(-A.ETIMEDOUT);
    // mq_notify: a message to the empty queue sends the signal, once
    const sev = new Uint8Array(16); new DataView(sev.buffer).setInt32(8, A.SIGUSR1, true);
    expect(await kernel.syscall(proc, A.SYS_mq_notify, [fd, 1], sev)).toBe(0);
    expect(await kernel.syscall(proc, A.SYS_mq_notify, [fd, 1], sev)).toBe(-A.EBUSY);
    const got: number[] = [];
    const old = kernel.deliver.bind(kernel);
    kernel.deliver = (p, sig) => { if (p === proc) got.push(sig); else old(p, sig); };
    expect(await send(fd, 'ping', 0)).toBe(0);
    kernel.deliver = old;
    expect(got).toEqual([A.SIGUSR1]);
    const un = enc.encode('q1');
    expect(await kernel.syscall(proc, A.SYS_mq_unlink, [2], un)).toBe(0);
    expect(await kernel.syscall(proc, A.SYS_mq_unlink, [2], un)).toBe(-A.ENOENT);
    expect(await recv(fd)).toBe('0:ping'); // still open after the unlink
    await call(A.SYS_close, [fd]);
  });

  it('Open POSIX timer_*: POSIX timers send their signal and count overruns while it is held', async () => {
    const t = kernel.vfork(proc);
    kernel.setSigmask(t, new Set([A.SIGUSR1]));
    const sev = new Uint8Array(24);
    new DataView(sev.buffer).setInt32(8, A.SIGUSR1, true); // SIGEV_SIGNAL
    const id = await kernel.syscall(t, A.SYS_timer_create, [1 /* CLOCK_MONOTONIC */, 1], sev);
    expect(id).toBe(0);
    expect(await kernel.syscall(t, A.SYS_timer_create, [77, 0], new Uint8Array(24))).toBe(-A.EINVAL);
    const its = (intervalMs: number, valueMs: number) => {
      const b = new Uint8Array(32); const v = new DataView(b.buffer);
      v.setBigInt64(8, BigInt(intervalMs * 1e6), true); v.setBigInt64(24, BigInt(valueMs * 1e6), true);
      return b;
    };
    // every 20 ms from 20 ms; the signal is blocked, so expiries after the first are overruns
    expect(await kernel.syscall(t, A.SYS_timer_settime, [id, 0], its(20, 20))).toBe(0);
    const cur = new Uint8Array(32);
    expect(await kernel.syscall(t, A.SYS_timer_gettime, [id], cur)).toBe(0);
    expect(Number(new DataView(cur.buffer).getBigInt64(8, true))).toBe(20e6);
    await new Promise((r) => setTimeout(r, 130));
    expect(t.deferredSignals.has(A.SIGUSR1)).toBe(true);
    // once the held signal is taken (sigwait), the overruns of that one are reported
    t.deferredSignals.delete(A.SIGUSR1);
    expect(await kernel.syscall(t, A.SYS_timer_getoverrun, [id], new Uint8Array(8))).toBeGreaterThanOrEqual(3);
    expect(await kernel.syscall(t, A.SYS_timer_delete, [id], new Uint8Array(8))).toBe(0);
    expect(await kernel.syscall(t, A.SYS_timer_delete, [id], new Uint8Array(8))).toBe(-A.EINVAL);
    kernel.kill(t.pid, A.SIGKILL);
    await kernel.syscall(proc, A.SYS_wait4, [t.pid, 0], new Uint8Array(8));
  });

  it('Open POSIX sigqueue/sigwaitinfo: real-time signals queue with their values; siginfo for handlers and sigwait', async () => {
    const t = kernel.vfork(proc);
    const RT = A.SIGRTMIN + 2;
    kernel.setSigmask(t, new Set([RT, A.SIGUSR1]));
    const queue = (target: number, signo: number, value: number, code = A.SI_QUEUE, from = t) => {
      const si = new Uint8Array(A.SIGINFO_SIZE);
      A.encodeSiginfo({ signo, code, pid: from.pid, uid: from.uid, value: BigInt(value) }, si);
      return kernel.syscall(from, A.SYS_rt_sigqueueinfo, [target, signo], si);
    };
    // three of a real-time signal queue, in order, with their values; a standard one coalesces
    for (const v of [5, 6, 7]) expect(await queue(t.pid, RT, v)).toBe(0);
    for (const v of [1, 2]) expect(await queue(t.pid, A.SIGUSR1, v)).toBe(0);
    const take = async (signo: number) => {
      const d = new Uint8Array(A.SIGINFO_SIZE);
      new DataView(d.buffer).setUint32(signo > 32 ? 4 : 0, 1 << ((signo - 1) % 32), true);
      const got = await kernel.syscall(t, A.SYS_rt_sigtimedwait, [0], d);
      return got < 0 ? got : `${got}:${A.decodeSiginfo(d).code}:${A.decodeSiginfo(d).value}`;
    };
    expect([await take(RT), await take(RT), await take(RT), await take(RT)]).toEqual([`${RT}:-1:5`, `${RT}:-1:6`, `${RT}:-1:7`, -A.EAGAIN]);
    expect([await take(A.SIGUSR1), await take(A.SIGUSR1)]).toEqual([`${A.SIGUSR1}:-1:1`, -A.EAGAIN]);
    // SI_USER (or any code >= 0) to another process is the kernel's to claim; signal 0 probes
    expect(await queue(proc.pid, A.SIGUSR2, 1, A.SI_USER)).toBe(-A.EPERM);
    expect(await queue(t.pid, 0, 0)).toBe(0);
    expect(await queue(99999, A.SIGUSR2, 1)).toBe(-A.ESRCH);
    // a handler's signal: the guest takes it from the channel, then asks for its siginfo
    t.dispositions.set(A.SIGUSR2, 0x1234);
    expect(await queue(t.pid, A.SIGUSR2, 42)).toBe(0);
    expect(kernel.takeSignal(t)).toBe(A.SIGUSR2);
    const si = new Uint8Array(A.SIGINFO_SIZE);
    expect(await kernel.syscall(t, A.SYS_shiro_siginfo, [A.SIGUSR2], si)).toBe(0);
    expect(A.decodeSiginfo(si)).toMatchObject({ signo: A.SIGUSR2, code: A.SI_QUEUE, pid: t.pid, value: 42n });
    expect(await kernel.syscall(t, A.SYS_shiro_siginfo, [A.SIGHUP], si)).toBe(-A.ENOENT);
    // a timer's signal says so, with its id and sigev_value
    const sev = new Uint8Array(24); const sv = new DataView(sev.buffer);
    sv.setBigInt64(0, 77n, true); sv.setInt32(8, RT, true);
    const id = await kernel.syscall(t, A.SYS_timer_create, [1, 1], sev);
    const its = new Uint8Array(32); new DataView(its.buffer).setBigInt64(24, 5_000_000n, true);
    expect(await kernel.syscall(t, A.SYS_timer_settime, [id, 0], its)).toBe(0);
    await new Promise((r) => setTimeout(r, 40));
    const d = new Uint8Array(A.SIGINFO_SIZE);
    new DataView(d.buffer).setUint32(4, 1 << ((RT - 1) % 32), true);
    expect(await kernel.syscall(t, A.SYS_rt_sigtimedwait, [0], d)).toBe(RT);
    const ti = new DataView(d.buffer);
    expect([ti.getInt32(8, true), ti.getInt32(16, true), ti.getBigInt64(24, true)]).toEqual([A.SI_TIMER, id, 77n]);
    kernel.kill(t.pid, A.SIGKILL);
    await kernel.syscall(proc, A.SYS_wait4, [t.pid, 0], new Uint8Array(8));
  });

  it('Open POSIX sigwaitinfo_3-1: a signal the wait names is the wait\'s even when not blocked; the mask comes back', async () => {
    const t = kernel.vfork(proc);
    t.dispositions.set(A.SIGUSR1, 0x1234);
    const d = new Uint8Array(A.SIGINFO_SIZE);
    new DataView(d.buffer).setUint32(0, 1 << (A.SIGUSR1 - 1), true);
    const waiting = kernel.syscall(t, A.SYS_rt_sigtimedwait, [2000], d);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.sigmask.has(A.SIGUSR1)).toBe(true);
    expect(kernel.kill(t.pid, A.SIGUSR1, proc)).toBe(0);
    expect(await waiting).toBe(A.SIGUSR1);
    expect(A.decodeSiginfo(d)).toMatchObject({ signo: A.SIGUSR1, code: A.SI_USER, pid: proc.pid });
    // no handler runs, and SIGUSR1 is unblocked again
    expect(t.pendingSignals.has(A.SIGUSR1)).toBe(false);
    expect(t.sigmask.has(A.SIGUSR1)).toBe(false);
    // one that came for the handler after the wait ended goes to it
    expect(await kernel.syscall(t, A.SYS_rt_sigtimedwait, [0], d)).toBe(-A.EAGAIN);
    kernel.kill(t.pid, A.SIGUSR1, proc);
    expect(t.pendingSignals.has(A.SIGUSR1)).toBe(true);
    kernel.kill(t.pid, A.SIGKILL);
    await kernel.syscall(proc, A.SYS_wait4, [t.pid, 0], new Uint8Array(8));
  });

  it('Open POSIX sigaction_21-1: with SA_NOCLDWAIT or SIGCHLD ignored, children leave no zombie and wait is ECHILD', async () => {
    const z = new Uint8Array(8);
    for (const how of ['nocldwait', 'ignore'] as const) {
      const parent = kernel.vfork(proc);
      const act = new Uint8Array(A.SIGACTION_SIZE * 2);
      const dv = new DataView(act.buffer);
      dv.setUint32(0, how === 'ignore' ? A.SIG_IGN : 0x4000, true);
      dv.setUint32(8, how === 'nocldwait' ? A.SA_NOCLDWAIT : 0, true);
      expect(await kernel.syscall(parent, A.SYS_rt_sigaction, [A.SIGCHLD, 1, 0], act)).toBe(0);
      const child = kernel.vfork(parent);
      const waiting = kernel.syscall(parent, A.SYS_wait4, [-1, 0], z);
      await new Promise((r) => setTimeout(r, 10));
      await kernel.exit(child, 0);
      expect(kernel.procs.has(child.pid)).toBe(false);
      expect(await waiting).toBe(-A.ECHILD);
      expect(await kernel.syscall(parent, A.SYS_wait4, [-1, A.WNOHANG], z)).toBe(-A.ECHILD);
      kernel.kill(parent.pid, A.SIGKILL);
      await kernel.syscall(proc, A.SYS_wait4, [parent.pid, 0], z);
    }
  });

  it('Open POSIX timer_getoverrun_2-3: overruns of a signal discarded at unblock stay reported while the timer runs on', async () => {
    const t = kernel.vfork(proc);
    kernel.setSigmask(t, new Set([A.SIGCONT]));
    const sev = new Uint8Array(24); new DataView(sev.buffer).setInt32(8, A.SIGCONT, true);
    const id = await kernel.syscall(t, A.SYS_timer_create, [1, 1], sev);
    const its = new Uint8Array(32); const iv = new DataView(its.buffer);
    iv.setBigInt64(8, 2_000_000n, true); iv.setBigInt64(24, 2_000_000n, true);
    expect(await kernel.syscall(t, A.SYS_timer_settime, [id, 0], its)).toBe(0);
    await new Promise((r) => setTimeout(r, 80));
    kernel.setSigmask(t, new Set());
    const first = await kernel.syscall(t, A.SYS_timer_getoverrun, [id], new Uint8Array(8));
    expect(first).toBeGreaterThan(10);
    await new Promise((r) => setTimeout(r, 20));
    expect(await kernel.syscall(t, A.SYS_timer_getoverrun, [id], new Uint8Array(8))).toBe(first);
    expect(await kernel.syscall(t, A.SYS_timer_delete, [id], new Uint8Array(8))).toBe(0);
    kernel.kill(t.pid, A.SIGKILL);
    await kernel.syscall(proc, A.SYS_wait4, [t.pid, 0], new Uint8Array(8));
  });

  it('Open POSIX sigaction_10-1: SIGCHLD says what happened to the child (CLD_STOPPED, CLD_CONTINUED, CLD_EXITED), with or without job control; SA_NOCLDSTOP', async () => {
    const z = new Uint8Array(8);
    const take = async (p: Process) => {
      const d = new Uint8Array(A.SIGINFO_SIZE);
      new DataView(d.buffer).setUint32(0, 1 << (A.SIGCHLD - 1), true);
      const got = await kernel.syscall(p, A.SYS_rt_sigtimedwait, [500], d);
      const i = A.decodeSiginfo(d);
      return got < 0 ? got : `${i.code}:${i.status}:${i.pid}`;
    };
    for (const jc of [false, true]) {
      const detach = jc ? attachKernel(kernel, new JobControl()) : () => {};
      try {
        const parent = kernel.vfork(proc);
        kernel.setSigmask(parent, new Set([A.SIGCHLD]));
        const child = kernel.vfork(parent);
        kernel.kill(child.pid, A.SIGSTOP, parent);
        expect(await take(parent)).toBe(`${A.CLD_STOPPED}:${A.SIGSTOP}:${child.pid}`);
        kernel.kill(child.pid, A.SIGCONT, parent);
        expect(await take(parent)).toBe(`${A.CLD_CONTINUED}:${A.SIGCONT}:${child.pid}`);
        // SA_NOCLDSTOP: no report for a stop or a continue, only the exit
        const act = new Uint8Array(A.SIGACTION_SIZE * 2);
        new DataView(act.buffer).setUint32(8, A.SA_NOCLDSTOP, true);
        expect(await kernel.syscall(parent, A.SYS_rt_sigaction, [A.SIGCHLD, 1, 0], act)).toBe(0);
        kernel.kill(child.pid, A.SIGSTOP, parent);
        kernel.kill(child.pid, A.SIGCONT, parent);
        await kernel.exit(child, A.W_EXITCODE(3));
        expect(await take(parent)).toBe(`${A.CLD_EXITED}:3:${child.pid}`);
        expect(await take(parent)).toBe(-A.EAGAIN);
        await kernel.syscall(parent, A.SYS_wait4, [child.pid, 0], z);
        kernel.kill(parent.pid, A.SIGKILL);
        await kernel.syscall(proc, A.SYS_wait4, [parent.pid, 0], z);
      } finally { detach(); }
    }
  });

  it('Open POSIX shm_open_32-1/34-1: a file whose owner bits deny the access is EACCES to open (not to root)', async () => {
    const z = new Uint8Array(8);
    const op = (p: Process, path: string, flags: number, mode = 0) =>
      kernel.syscall(p, A.SYS_openat, [A.AT_FDCWD, L(path), flags, mode], enc.encode(path));
    const name = '/dev/shm/perm_' + Date.now();
    let fd = await op(proc, name, A.O_RDWR | A.O_CREAT, 0);
    expect(fd).toBeGreaterThanOrEqual(0); // creating it is allowed whatever its mode
    await kernel.syscall(proc, A.SYS_close, [fd], z);
    expect(await op(proc, name, A.O_RDWR)).toBe(-A.EACCES);
    expect(await op(proc, name, A.O_RDONLY)).toBe(-A.EACCES);
    await fs.chmod(name, 0o400);
    fd = await op(proc, name, A.O_RDONLY);
    expect(fd).toBeGreaterThanOrEqual(0);
    await kernel.syscall(proc, A.SYS_close, [fd], z);
    expect(await op(proc, name, A.O_RDWR | A.O_TRUNC)).toBe(-A.EACCES);
    expect(await op(proc, name, A.O_WRONLY)).toBe(-A.EACCES);
    // root opens it anyway
    const root = kernel.vfork(proc);
    root.uid = 0; root.ruid = 0; root.suid = 0;
    fd = await op(root, name, A.O_RDWR);
    expect(fd).toBeGreaterThanOrEqual(0);
    kernel.kill(root.pid, A.SIGKILL);
    await kernel.syscall(proc, A.SYS_wait4, [root.pid, 0], z);
    await fs.unlink(name);
  });

  it('timer_delete discards the timer\'s still-pending signal, not another sender\'s', async () => {
    const t = kernel.vfork(proc);
    const RT = A.SIGRTMIN + 4;
    kernel.setSigmask(t, new Set([A.SIGUSR1, RT]));
    const z = new Uint8Array(8);
    const make = async (signo: number) => {
      const sev = new Uint8Array(24); new DataView(sev.buffer).setInt32(8, signo, true);
      const id = await kernel.syscall(t, A.SYS_timer_create, [1, 1], sev);
      const its = new Uint8Array(32); new DataView(its.buffer).setBigInt64(24, 2_000_000n, true);
      expect(await kernel.syscall(t, A.SYS_timer_settime, [id, 0], its)).toBe(0);
      return id;
    };
    const a = await make(A.SIGUSR1);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.deferredSignals.has(A.SIGUSR1)).toBe(true);
    expect(await kernel.syscall(t, A.SYS_timer_delete, [a], z)).toBe(0);
    expect(t.deferredSignals.has(A.SIGUSR1)).toBe(false);
    // a real-time signal also queued by kill stays, with its own siginfo
    const b = await make(RT);
    await new Promise((r) => setTimeout(r, 20));
    kernel.kill(t.pid, RT, proc);
    expect(await kernel.syscall(t, A.SYS_timer_delete, [b], z)).toBe(0);
    expect(t.deferredSignals.has(RT)).toBe(true);
    expect(t.siginfo.get(RT)?.map((i) => i.code)).toEqual([A.SI_USER]);
    kernel.kill(t.pid, A.SIGKILL);
    await kernel.syscall(proc, A.SYS_wait4, [t.pid, 0], z);
  });

  it('Open POSIX fsync_7-1, mmap_14-1: fsync of a pipe is EINVAL; a write (and chmod) moves st_ctime', async () => {
    const [r, w] = await pipe();
    expect(await kernel.syscall(proc, A.SYS_fsync, [r], new Uint8Array(8))).toBe(-A.EINVAL);
    await kernel.syscall(proc, A.SYS_close, [r], new Uint8Array(8));
    await kernel.syscall(proc, A.SYS_close, [w], new Uint8Array(8));
    const name = '/tmp/ctime_' + Date.now();
    const fd = await open(name, A.O_RDWR | A.O_CREAT);
    const ctime = async () => { const d = new Uint8Array(256); await kernel.syscall(proc, A.SYS_fstat, [fd], d); return Number(new DataView(d.buffer).getBigInt64(104, true)); };
    const c0 = await ctime();
    await new Promise((res) => setTimeout(res, 1100));
    expect(await kernel.syscall(proc, A.SYS_write, [fd, 3], enc.encode('abc'))).toBe(3);
    const c1 = await ctime();
    expect(c1).toBeGreaterThan(c0);
    expect(await kernel.syscall(proc, A.SYS_fsync, [fd], new Uint8Array(8))).toBe(0);
    await kernel.syscall(proc, A.SYS_close, [fd], new Uint8Array(8));
    expect((await fs.stat(name)).ctime.getTime()).toBeGreaterThanOrEqual(c1 * 1000);
    await new Promise((res) => setTimeout(res, 10));
    const before = (await fs.stat(name)).ctime.getTime();
    await fs.chmod(name, 0o600);
    expect((await fs.stat(name)).ctime.getTime()).toBeGreaterThan(before);
    await fs.unlink(name);
  });

  it('Open POSIX fork_13-1: ITIMER_VIRTUAL and ITIMER_PROF are per process, signal SIGVTALRM/SIGPROF, and a fork child has none', async () => {
    const t = kernel.vfork(proc);
    kernel.setSigmask(t, new Set([A.SIGVTALRM, A.SIGPROF]));
    const it = (which: number, ms: number) => {
      const d = new Uint8Array(32); const dv = new DataView(d.buffer);
      dv.setBigInt64(16, BigInt(Math.floor(ms / 1000)), true); dv.setBigInt64(24, BigInt((ms % 1000) * 1000), true);
      return kernel.syscall(t, A.SYS_setitimer, [which, 1], d);
    };
    expect(await it(1, 20)).toBe(0);
    expect(await it(2, 20)).toBe(0);
    expect(await it(3, 20)).toBe(-A.EINVAL);
    const got = new Uint8Array(32);
    expect(await kernel.syscall(t, A.SYS_getitimer, [1], got)).toBe(0);
    expect(Number(new DataView(got.buffer).getBigInt64(24, true))).toBeGreaterThan(0);
    const child = kernel.vfork(t);
    expect(await kernel.syscall(child, A.SYS_getitimer, [1], got)).toBe(0);
    expect(new DataView(got.buffer).getBigInt64(24, true)).toBe(0n);
    await new Promise((r) => setTimeout(r, 60));
    expect(t.deferredSignals.has(A.SIGVTALRM) && t.deferredSignals.has(A.SIGPROF)).toBe(true);
    for (const p of [child, t]) { kernel.kill(p.pid, A.SIGKILL); await kernel.syscall(proc, A.SYS_wait4, [p.pid, 0], new Uint8Array(8)); }
  });

  it('Open POSIX sigqueue_3-1/12-1, LTP kill05: signalling another user\'s process (or init) is EPERM', async () => {
    const t = kernel.vfork(proc), other = kernel.vfork(proc);
    other.uid = 0; other.ruid = 0; other.suid = 0;
    const z = new Uint8Array(8);
    const sq = (from: Process, pid: number, signo: number) => {
      const si = new Uint8Array(A.SIGINFO_SIZE);
      A.encodeSiginfo({ signo, code: A.SI_QUEUE, pid: from.pid, uid: from.uid }, si);
      return kernel.syscall(from, A.SYS_rt_sigqueueinfo, [pid, signo], si);
    };
    // init stands in for Linux's root-owned pid 1
    expect(await kernel.syscall(t, A.SYS_kill, [1, 0], z)).toBe(-A.EPERM);
    expect(await sq(t, 1, 0)).toBe(-A.EPERM);
    expect(await kernel.syscall(t, A.SYS_kill, [other.pid, 0], z)).toBe(-A.EPERM);
    expect(await sq(t, other.pid, 0)).toBe(-A.EPERM);
    // the same user's process, a saved uid that matches, root, and SIGCONT within a session
    expect(await kernel.syscall(t, A.SYS_kill, [proc.pid, 0], z)).toBe(0);
    expect(await kernel.syscall(other, A.SYS_kill, [t.pid, 0], z)).toBe(0);
    other.suid = 1000;
    expect(await kernel.syscall(t, A.SYS_kill, [other.pid, 0], z)).toBe(0);
    other.suid = 0;
    expect(await kernel.syscall(t, A.SYS_kill, [other.pid, A.SIGCONT], z)).toBe(other.sid === t.sid ? 0 : -A.EPERM);
    // the kernel's own sends (from init) are always allowed
    expect(kernel.kill(other.pid, 0)).toBe(0);
    for (const p of [t, other]) { kernel.kill(p.pid, A.SIGKILL); await kernel.syscall(proc, A.SYS_wait4, [p.pid, 0], z); }
  });

  it('signals routed through job control keep their siginfo (sigwaitinfo sees kill as SI_USER, sigqueue values queue)', async () => {
    const jc = new JobControl();
    const detach = attachKernel(kernel, jc);
    try {
      const t = kernel.vfork(proc);
      expect(t.signalHook).toBeTruthy();
      const RT = A.SIGRTMIN + 3;
      kernel.setSigmask(t, new Set([RT, A.SIGUSR1]));
      expect(await kernel.syscall(t, A.SYS_kill, [t.pid, A.SIGUSR1], new Uint8Array(8))).toBe(0);
      for (const v of [8, 9]) {
        const si = new Uint8Array(A.SIGINFO_SIZE);
        A.encodeSiginfo({ signo: RT, code: A.SI_QUEUE, pid: t.pid, uid: t.uid, value: BigInt(v) }, si);
        expect(await kernel.syscall(t, A.SYS_rt_sigqueueinfo, [t.pid, RT], si)).toBe(0);
      }
      const take = async (signo: number) => {
        const d = new Uint8Array(A.SIGINFO_SIZE);
        new DataView(d.buffer).setUint32(signo > 32 ? 4 : 0, 1 << ((signo - 1) % 32), true);
        const got = await kernel.syscall(t, A.SYS_rt_sigtimedwait, [0], d);
        return got < 0 ? got : `${got}:${A.decodeSiginfo(d).code}:${A.decodeSiginfo(d).pid === t.pid}:${A.decodeSiginfo(d).value}`;
      };
      expect(await take(A.SIGUSR1)).toBe(`${A.SIGUSR1}:0:true:0`);
      expect([await take(RT), await take(RT), await take(RT)]).toEqual([`${RT}:-1:true:8`, `${RT}:-1:true:9`, -A.EAGAIN]);
      kernel.kill(t.pid, A.SIGKILL);
      await kernel.syscall(proc, A.SYS_wait4, [t.pid, 0], new Uint8Array(8));
    } finally { detach(); }
  });

  it('connect03: connecting to an AF_UNIX socket file takes write permission on it', async () => {
    const stack = new NetStack();
    stack.configure({ relayUrl: null, tokenUrl: null, dohUrl: null, portHost: null });
    const off = installNet(kernel, stack);
    const sun = new Uint8Array(110);
    sun[0] = A.AF_UNIX;
    sun.set(enc.encode('/tmp/kc/c03.sock'), 2);
    const srv = await call(A.SYS_socket, [A.AF_UNIX, A.SOCK_STREAM, 0]);
    expect(await kernel.syscall(proc, A.SYS_bind, [srv, 110], sun)).toBe(0);
    expect(await call(A.SYS_listen, [srv, 5])).toBe(0);
    const cli = await call(A.SYS_socket, [A.AF_UNIX, A.SOCK_STREAM, 0]);
    expect(proc.uid).not.toBe(0);
    await fs.chmod('/tmp/kc/c03.sock', 0o500);
    expect(await kernel.syscall(proc, A.SYS_connect, [cli, 110], sun)).toBe(-A.EACCES);
    await fs.chmod('/tmp/kc/c03.sock', 0o700);
    expect(await kernel.syscall(proc, A.SYS_connect, [cli, 110], sun)).toBe(0);
    for (const fd of [cli, srv]) await call(A.SYS_close, [fd]);
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

  it('unlinkat01/wait403/epoll_ctl06: bad unlinkat flags EINVAL, wait4(INT_MIN) ESRCH, /dev/zero not pollable', async () => {
    expect(await call(A.SYS_unlinkat, [A.AT_FDCWD, L('file'), 9999], 'file')).toBe(-A.EINVAL);
    expect(await fs.exists('/tmp/kc/file')).toBe(true);
    expect(await call(A.SYS_wait4, [-0x80000000, 0])).toBe(-A.ESRCH);
    const ep = await call(A.SYS_epoll_create1, [0]);
    for (const dev of ['/dev/zero', '/dev/null']) {
      const fd = await open(dev, A.O_RDONLY);
      expect(fd).toBeGreaterThanOrEqual(0);
      expect(await call(A.SYS_epoll_ctl, [ep, A.EPOLL_CTL_ADD, fd, A.EPOLLIN, 0, 0])).toBe(-A.EPERM);
    }
  });

  it('poll02/select02/pselect01: a timeout never ends early (sub-millisecond select timeouts too)', async () => {
    const [r] = await pipe();
    const pfd = new Uint8Array(8);
    new DataView(pfd.buffer).setInt32(0, r, true);
    new DataView(pfd.buffer).setInt16(4, A.POLLIN, true);
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      expect(await kernel.syscall(proc, A.SYS_poll, [1, 3], pfd)).toBe(0);
      expect(performance.now() - t0).toBeGreaterThanOrEqual(3);
      const t1 = performance.now();
      // select(0, …, {0 s, 1500 µs}): no fds, just the timeout
      expect(await kernel.syscall(proc, A.SYS_select, [0, 0, 0, 1500], new Uint8Array(64))).toBe(0);
      expect(performance.now() - t1).toBeGreaterThanOrEqual(1.5);
    }
  });

  it('socket01/socketpair01/bind04/connect03: AF_UNIX SOCK_DGRAM keeps message boundaries; named datagram sockets; EPROTOTYPE', async () => {
    const stack = new NetStack();
    stack.configure({ relayUrl: null, tokenUrl: null, dohUrl: null, portHost: null });
    const off = installNet(kernel, stack);
    const sv = new Uint8Array(8);
    expect(await kernel.syscall(proc, A.SYS_socketpair, [A.AF_UNIX, A.SOCK_DGRAM, 0], sv)).toBe(0);
    const [a, b] = [new DataView(sv.buffer).getInt32(0, true), new DataView(sv.buffer).getInt32(4, true)];
    expect(await kernel.syscall(proc, A.SYS_write, [a, 3], enc.encode('abc'))).toBe(3);
    expect(await kernel.syscall(proc, A.SYS_write, [a, 4], enc.encode('defg'))).toBe(4);
    const buf = new Uint8Array(16);
    expect(await kernel.syscall(proc, A.SYS_read, [b, 2], buf)).toBe(2); // "ab"; the "c" is dropped
    expect(await kernel.syscall(proc, A.SYS_read, [b, 16], buf)).toBe(4);
    expect(new TextDecoder().decode(buf.subarray(0, 4))).toBe('defg');
    // A named datagram socket: sendto it, or connect and write; a stream socket can't connect to it
    const s = await call(A.SYS_socket, [A.AF_UNIX, A.SOCK_DGRAM, 0]);
    const sun = new Uint8Array(110);
    sun[0] = A.AF_UNIX;
    sun.set(enc.encode('/tmp/kc/dg'), 2);
    expect(await kernel.syscall(proc, A.SYS_bind, [s, 110], sun)).toBe(0);
    expect(await call(A.SYS_listen, [s, 1])).toBe(-A.EOPNOTSUPP);
    const c = await call(A.SYS_socket, [A.AF_UNIX, A.SOCK_DGRAM, 0]);
    const csun = new Uint8Array(110);
    csun[0] = A.AF_UNIX;
    csun.set(enc.encode('/tmp/kc/dg2'), 2);
    expect(await kernel.syscall(proc, A.SYS_bind, [c, 110], csun)).toBe(0);
    const msg = new Uint8Array(2 + 110);
    msg.set(enc.encode('hi'));
    msg.set(sun, 2);
    expect(await kernel.syscall(proc, A.SYS_sendto, [c, 2, 0, 110], msg)).toBe(2);
    expect(await kernel.syscall(proc, A.SYS_connect, [c, 110], sun)).toBe(0);
    expect(await kernel.syscall(proc, A.SYS_write, [c, 3], enc.encode('bye'))).toBe(3);
    // recvfrom names the (bound) sender, so a reply can go back (bind05)
    const rf = new Uint8Array(16 + 128);
    expect(await kernel.syscall(proc, A.SYS_recvfrom, [s, 16, 0], rf)).toBe(2);
    expect(new TextDecoder().decode(rf.subarray(18, 29))).toBe('/tmp/kc/dg2');
    expect(await kernel.syscall(proc, A.SYS_read, [s, 16], buf)).toBe(3);
    // With an address room (recvfrom's 4th argument), its last 4 bytes give the address length:
    // an abstract sender bound with the whole sockaddr_un keeps its 108-byte name
    const ab = await call(A.SYS_socket, [A.AF_UNIX, A.SOCK_DGRAM, 0]);
    const asun = new Uint8Array(110);
    asun[0] = A.AF_UNIX;
    asun.set(enc.encode('\0abs'), 2);
    expect(await kernel.syscall(proc, A.SYS_bind, [ab, 110], asun)).toBe(0);
    msg.set(enc.encode('yo'));
    expect(await kernel.syscall(proc, A.SYS_sendto, [ab, 2, 0, 110], msg)).toBe(2);
    const roomy = new Uint8Array(16 + 128);
    expect(await kernel.syscall(proc, A.SYS_recvfrom, [s, 16, 0, 128], roomy)).toBe(2);
    expect(new DataView(roomy.buffer).getUint32(16 + 124, true)).toBe(110);
    expect(roomy.subarray(18, 22)).toEqual(enc.encode('\0abs'));
    await call(A.SYS_close, [ab]);
    const st = await call(A.SYS_socket, [A.AF_UNIX, A.SOCK_STREAM, 0]);
    expect(await kernel.syscall(proc, A.SYS_connect, [st, 110], sun)).toBe(-A.EPROTOTYPE);
    for (const fd of [a, b, s, c, st]) await call(A.SYS_close, [fd]);
    off();
  });

  it('O_CREAT/O_TRUNC/O_EXCL/O_NOFOLLOW opens and unlink are answered synchronously from the cache', async () => {
    const enc2 = new TextEncoder();
    const sync = (nr: number, args: number[], path: string) => {
      const d = new Uint8Array(512);
      const b = enc2.encode(path);
      d.set(b);
      return kernel.syscallSync(proc, nr, nr === A.SYS_unlink ? [b.length] : [A.AT_FDCWD, b.length, ...args], d);
    };
    await fs.writeFile('/tmp/kc/old', 'abc');
    await fs.readFile('/tmp/kc/old'); // cached
    const fd = sync(A.SYS_openat, [A.O_WRONLY | A.O_CREAT | A.O_TRUNC, 0o640], '/tmp/kc/new');
    expect(fd).toBeGreaterThanOrEqual(0);
    expect((await fs.stat('/tmp/kc/new')).size).toBe(0);
    expect((await fs.stat('/tmp/kc/new')).mode & 0o777).toBe(0o640 & ~proc.umask);
    expect(sync(A.SYS_openat, [A.O_WRONLY | A.O_CREAT | A.O_EXCL, 0o600], '/tmp/kc/new')).toBe(-A.EEXIST);
    const t = sync(A.SYS_openat, [A.O_WRONLY | A.O_TRUNC, 0], '/tmp/kc/old');
    expect(t).toBeGreaterThanOrEqual(0);
    await call(A.SYS_close, [t]);
    expect(await fs.readFile('/tmp/kc/old', 'utf8')).toBe('');
    expect(sync(A.SYS_openat, [A.O_RDONLY, 0], '/tmp/kc/nope')).toBe(-A.ENOENT);
    await fs.symlink('/tmp/kc/old', '/tmp/kc/ln');
    await fs.lstat('/tmp/kc/ln');
    expect(sync(A.SYS_openat, [A.O_RDONLY | A.O_NOFOLLOW, 0], '/tmp/kc/ln')).toBe(-A.ELOOP);
    // unlink: done in memory unless the file is open (fd is still open: async path)
    expect(sync(A.SYS_unlink, [], '/tmp/kc/new')).toBe(undefined);
    await call(A.SYS_close, [fd]);
    expect(sync(A.SYS_unlink, [], '/tmp/kc/new')).toBe(0);
    expect(await fs.exists('/tmp/kc/new')).toBe(false);
    expect(sync(A.SYS_unlink, [], '/tmp/kc/new')).toBe(-A.ENOENT);
    expect(sync(A.SYS_unlink, [], '/tmp/kc')).toBe(-A.EISDIR);
    expect(sync(A.SYS_unlink, [], '/tmp/kc/ln')).toBe(0); // the link, not its target
    expect(await fs.exists('/tmp/kc/old')).toBe(true);
  });

  it('paths below /proc/self/fd/N (and /dev/fd/N) name entries of that open directory', async () => {
    await fs.mkdir('/tmp/kc/pinned', { recursive: true });
    const dfd = await open('/tmp/kc/pinned', A.O_PATH | A.O_DIRECTORY | A.O_NOFOLLOW);
    expect(dfd).toBeGreaterThanOrEqual(0);
    const via = `/proc/self/fd/${dfd}`;
    expect(await call(A.SYS_mkdir, [L(`${via}/sub`), 0o700], `${via}/sub`)).toBe(0);
    expect((await fs.stat('/tmp/kc/pinned/sub')).isDirectory()).toBe(true);
    const f = await open(`/dev/fd/${dfd}/sub/new.tmp`, A.O_WRONLY | A.O_CREAT | A.O_EXCL);
    expect(f).toBeGreaterThanOrEqual(0);
    await kernel.syscall(proc, A.SYS_close, [f], new Uint8Array(8));
    const from = `${via}/sub/new.tmp`, to = `/proc/${proc.pid}/fd/${dfd}/sub/new.txt`;
    expect(await call(A.SYS_rename, [L(from), L(to)], from, to)).toBe(0);
    expect(await fs.exists('/tmp/kc/pinned/sub/new.txt')).toBe(true);
    expect(await call(A.SYS_stat, [L('/proc/self/fd/999/x')], '/proc/self/fd/999/x')).toBe(-A.ENOENT);
    const file = await open('file', A.O_RDONLY);
    expect(await call(A.SYS_stat, [L(`/proc/self/fd/${file}/x`)], `/proc/self/fd/${file}/x`)).toBe(-A.ENOTDIR);
    for (const fd of [dfd, file]) await kernel.syscall(proc, A.SYS_close, [fd], new Uint8Array(8));
  });

  it('epoll_wait: a full events array rotates, so every ready fd gets reported (no starvation)', async () => {
    const ep = await call(A.SYS_epoll_create1, [0]);
    const reads: number[] = [];
    for (let i = 0; i < 3; i++) {
      const [r, w] = await pipe();
      await kernel.syscall(proc, A.SYS_write, [w, 1], new Uint8Array([1]));
      expect(await call(A.SYS_epoll_ctl, [ep, A.EPOLL_CTL_ADD, r, A.EPOLLIN, i, 0])).toBe(0);
      reads.push(r);
    }
    const ev = new Uint8Array(A.EPOLL_EVENT_SIZE);
    const seen: number[] = [];
    for (let k = 0; k < 3; k++) {
      expect(await kernel.syscall(proc, A.SYS_epoll_wait, [ep, 1, 0], ev)).toBe(1);
      seen.push(new DataView(ev.buffer).getUint32(4, true));
    }
    expect(seen.sort()).toEqual([0, 1, 2]);
  });

  it('Redis: [::]:port with IPV6_V6ONLY shares the port with 0.0.0.0:port; without it, EADDRINUSE (bindv6only=0)', async () => {
    const stack = new NetStack();
    stack.configure({ relayUrl: null, tokenUrl: null, dohUrl: null, portHost: null });
    const off = installNet(kernel, stack);
    const d = new Uint8Array(256);
    const sys = (nr: number, args: number[]) => kernel.syscall(proc, nr, args, d);
    const bindTo = (fd: number, family: number, address: string) => {
      d.fill(0); d.set(encodeSockaddr({ family, address, port: 6379 }));
      return sys(A.SYS_bind, [fd, family === A.AF_INET6 ? 28 : 16]);
    };
    const v4 = await sys(A.SYS_socket, [A.AF_INET, A.SOCK_STREAM, 0]);
    expect(await bindTo(v4, A.AF_INET, '0.0.0.0')).toBe(0);
    expect(await sys(A.SYS_listen, [v4, 8])).toBe(0);
    // without IPV6_V6ONLY, [::] takes IPv4 too: the port is in use
    const dual = await sys(A.SYS_socket, [A.AF_INET6, A.SOCK_STREAM, 0]);
    expect(await bindTo(dual, A.AF_INET6, '::')).toBe(-A.EADDRINUSE);
    const v6 = await sys(A.SYS_socket, [A.AF_INET6, A.SOCK_STREAM, 0]);
    expect(await sys(A.SYS_setsockopt, [v6, A.IPPROTO_IPV6, A.IPV6_V6ONLY, 1])).toBe(0);
    expect(await bindTo(v6, A.AF_INET6, '::')).toBe(0);
    expect(await sys(A.SYS_listen, [v6, 8])).toBe(0);
    // each family's connection reaches its own listener
    const reach = async (family: number, address: string, listener: number) => {
      const c = await sys(A.SYS_socket, [family, A.SOCK_STREAM, 0]);
      d.fill(0); d.set(encodeSockaddr({ family, address, port: 6379 }));
      expect(await sys(A.SYS_connect, [c, family === A.AF_INET6 ? 28 : 16])).toBe(0);
      const a = await sys(A.SYS_accept4, [listener, A.SOCK_NONBLOCK]);
      expect(a).toBeGreaterThanOrEqual(0);
      for (const fd of [a, c]) await call(A.SYS_close, [fd]);
    };
    await reach(A.AF_INET, '127.0.0.1', v4);
    await reach(A.AF_INET6, '::1', v6);
    // a second v4 wildcard still conflicts
    const v4b = await sys(A.SYS_socket, [A.AF_INET, A.SOCK_STREAM, 0]);
    expect(await bindTo(v4b, A.AF_INET, '0.0.0.0')).toBe(-A.EADDRINUSE);
    for (const fd of [v4, dual, v6, v4b]) await call(A.SYS_close, [fd]);
    // once the v4 listener is gone, a dual-stack [::] can have the port
    const dual2 = await sys(A.SYS_socket, [A.AF_INET6, A.SOCK_STREAM, 0]);
    expect(await bindTo(dual2, A.AF_INET6, '::')).toBe(0);
    await call(A.SYS_close, [dual2]);
    off();
  });

  it('splice, tee, vmsplice and copy_file_range move bytes between pipes and files as Linux checks them (LTP splice01-07, tee01-02, vmsplice01-04, copy_file_range03)', async () => {
    const off = (a: number | null, b: number | null) => {
      const d = new Uint8Array(4096); const dv = new DataView(d.buffer);
      if (a !== null) dv.setBigInt64(0, BigInt(a), true);
      if (b !== null) dv.setBigInt64(8, BigInt(b), true);
      return d;
    };
    await fs.writeFile('/tmp/kc/spl', 'hello world');
    const f = await open('/tmp/kc/spl', A.O_RDWR);
    const [r, w] = await pipe();
    const [r2, w2] = await pipe();
    // file → pipe at an offset (the offset moves, the file position doesn't)
    let d = off(6, null);
    expect(await kernel.syscall(proc, A.SYS_splice, [f, 1, w, 0, 5, 0], d)).toBe(5);
    expect(new DataView(d.buffer).getBigInt64(0, true)).toBe(11n);
    // tee copies without taking; then pipe → file at its position
    expect(await kernel.syscall(proc, A.SYS_tee, [r, w2, 100, 0], new Uint8Array(0))).toBe(5);
    expect(await kernel.syscall(proc, A.SYS_splice, [r, 0, f, 0, 100, 0], off(null, null))).toBe(5);
    const back = new Uint8Array(32);
    expect(await kernel.syscall(proc, A.SYS_pread64, [f, 32, 0, 0], back)).toBe(11);
    expect(new TextDecoder().decode(back.subarray(0, 11))).toBe('worldworld\0'.slice(0, 5) + ' world');
    expect(await kernel.syscall(proc, A.SYS_read, [r2, 32], back)).toBe(5);
    // errors: no pipe, an offset on a pipe, the same pipe, a nonblocking empty pipe
    expect(await kernel.syscall(proc, A.SYS_splice, [f, 0, f, 0, 1, 0], off(null, null))).toBe(-A.EINVAL);
    expect(await kernel.syscall(proc, A.SYS_splice, [r, 1, f, 0, 1, 0], off(0, null))).toBe(-A.ESPIPE);
    expect(await kernel.syscall(proc, A.SYS_tee, [r, w, 1, 0], new Uint8Array(0))).toBe(-A.EINVAL);
    expect(await kernel.syscall(proc, A.SYS_splice, [r, 0, f, 0, 1, 2], off(null, null))).toBe(-A.EAGAIN);
    // vmsplice moves what fits in the pipe (64 KiB of 128 KiB)
    const big = new Uint8Array(128 * 1024).fill(7);
    expect(await kernel.syscall(proc, A.SYS_vmsplice, [w, big.length, 0], big)).toBe(65536);
    expect(await kernel.syscall(proc, A.SYS_vmsplice, [f, 1, 0], big)).toBe(-A.EBADF);
    const out = new Uint8Array(70000);
    expect(await kernel.syscall(proc, A.SYS_vmsplice, [r, out.length, 0], out)).toBe(65536);
    // copy_file_range within one file: overlapping ranges are EINVAL
    d = off(0, 20);
    expect(await kernel.syscall(proc, A.SYS_copy_file_range, [f, 1, f, 1, 5, 0], d)).toBe(5);
    expect(new DataView(d.buffer).getBigInt64(8, true)).toBe(25n);
    expect(await kernel.syscall(proc, A.SYS_copy_file_range, [f, 1, f, 1, 5, 0], off(0, 2))).toBe(-A.EINVAL);
    expect(await kernel.syscall(proc, A.SYS_copy_file_range, [f, 1, f, 1, 5, 1], off(0, 40))).toBe(-A.EINVAL);
    for (const fd of [f, r, w, r2, w2]) await call(A.SYS_close, [fd]);
  });

  it('flock: whole-file locks of the open file description, apart from fcntl locks; LOCK_NB, conversion, release at the last close and at exit (LTP flock02-04)', async () => {
    await fs.writeFile('/tmp/kc/flk', 'x');
    const a = await open('/tmp/kc/flk', A.O_RDWR), b = await open('/tmp/kc/flk', A.O_RDWR);
    expect(await call(A.SYS_flock, [a, 0])).toBe(-A.EINVAL);
    expect(await call(A.SYS_flock, [a, A.LOCK_SH])).toBe(0);
    expect(await call(A.SYS_flock, [b, A.LOCK_SH | A.LOCK_NB])).toBe(0);
    expect(await call(A.SYS_flock, [b, A.LOCK_EX | A.LOCK_NB])).toBe(-A.EAGAIN);
    expect(await call(A.SYS_flock, [a, A.LOCK_UN])).toBe(0);
    expect(await call(A.SYS_flock, [b, A.LOCK_EX | A.LOCK_NB])).toBe(0); // (converted)
    expect(await call(A.SYS_flock, [a, A.LOCK_SH | A.LOCK_NB])).toBe(-A.EAGAIN);
    // a dup shares the description (and its lock); the last close drops it
    const c = await call(A.SYS_dup, [b]);
    expect(await call(A.SYS_close, [b])).toBe(0);
    expect(await call(A.SYS_flock, [a, A.LOCK_SH | A.LOCK_NB])).toBe(-A.EAGAIN);
    expect(await call(A.SYS_close, [c])).toBe(0);
    expect(await call(A.SYS_flock, [a, A.LOCK_EX | A.LOCK_NB])).toBe(0);
    // a waiter gets it once the holder exits
    const p = kernel.spawn({ path: 'flk', cwd: '/tmp/kc', fds: {}, run: () => new Promise<number>(() => {}) });
    const d = new Uint8Array(64); d.set(new TextEncoder().encode('/tmp/kc/flk'));
    const pf = await kernel.syscall(p, A.SYS_openat, [A.AT_FDCWD, 11, A.O_RDWR, 0], d);
    const waiting = kernel.syscall(p, A.SYS_flock, [pf, A.LOCK_EX], new Uint8Array(0));
    expect(await call(A.SYS_close, [a])).toBe(0);
    expect(await waiting).toBe(0);
    expect(await call(A.SYS_flock, [await open('/tmp/kc/flk', A.O_RDWR), A.LOCK_EX | A.LOCK_NB])).toBe(-A.EAGAIN);
    await kernel.exit(p, 0);
    expect(await call(A.SYS_flock, [await open('/tmp/kc/flk', A.O_RDWR), A.LOCK_EX | A.LOCK_NB])).toBe(0);
  });

  it('timer_create SIGEV_THREAD_ID to a thread the engine vouches for; its signal\'s siginfo names the thread in its last word (Blink 0510, Open POSIX fork_18-1)', async () => {
    const p = kernel.spawn({ path: 'tt', cwd: '/tmp/kc', fds: {}, run: () => new Promise<number>(() => {}) });
    p.dispositions.set(34, 0x1234);
    const sev = new Uint8Array(24);
    const dv = new DataView(sev.buffer);
    dv.setBigInt64(0, 7n, true); dv.setInt32(8, 34, true); dv.setInt32(12, 4, true); dv.setInt32(16, 262145, true); // SIGEV_THREAD_ID
    expect(await kernel.syscall(p, A.SYS_timer_create, [1, 1], sev.slice())).toBe(-A.EINVAL); // a thread the kernel doesn't know
    const id = await kernel.syscall(p, A.SYS_timer_create, [1, 1, 1], sev.slice());
    expect(id).toBeGreaterThanOrEqual(0);
    const its = new Uint8Array(32);
    new DataView(its.buffer).setBigInt64(24, 1_000_000n, true); // 1 ms, once
    expect(await kernel.syscall(p, A.SYS_timer_settime, [id, 0], its)).toBe(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(kernel.takeSignal(p)).toBe(34);
    const si = new Uint8Array(A.SIGINFO_SIZE);
    expect(await kernel.syscall(p, A.SYS_shiro_siginfo, [34], si)).toBe(0);
    expect(A.decodeSiginfo(si)).toMatchObject({ signo: 34, code: A.SI_TIMER, value: 7n });
    expect(new DataView(si.buffer).getInt32(A.SIGINFO_SIZE - 4, true)).toBe(262145);
  });

  it('SYS_shiro_cputimes: the CPU estimate leaves out engine sleeps and long calls, and a parent counts what it reaped (Blink 0509, Open POSIX fork_8-1)', async () => {
    const p = kernel.spawn({ path: 'cpu', cwd: '/tmp/kc', fds: {}, run: () => new Promise<number>(() => {}) });
    const times = async () => {
      const d = new Uint8Array(16);
      expect(await kernel.syscall(p, A.SYS_shiro_cputimes, [0], d)).toBe(0);
      const dv = new DataView(d.buffer);
      return [Number(dv.getBigInt64(0, true)) / 1000, Number(dv.getBigInt64(8, true)) / 1000];
    };
    // 150 ms reported asleep by the engine: not CPU
    expect(await kernel.syscall(p, A.SYS_shiro_sleeping, [1], new Uint8Array(0))).toBe(0);
    await new Promise((r) => setTimeout(r, 150));
    const [during] = await times();
    expect(await kernel.syscall(p, A.SYS_shiro_sleeping, [-1], new Uint8Array(0))).toBe(0);
    const [self, kids] = await times();
    expect(during).toBeLessThan(100);
    expect(self).toBeLessThan(100);
    expect(kids).toBe(0);
    // a reaped child's CPU goes to the parent, and to wait4's reply after the status
    p.childCpuMs = 0;
    const c = kernel.spawn({ path: 'kid', cwd: '/tmp/kc', fds: {}, parent: p, run: () => new Promise<number>((r) => setTimeout(() => r(0), 120)) });
    c.syscalls = 1;
    const d = new Uint8Array(16);
    expect(await kernel.syscall(p, A.SYS_wait4, [c.pid, 0], d)).toBe(c.pid);
    const us = Number(new DataView(d.buffer).getBigInt64(4, true));
    expect(us).toBeGreaterThan(50_000);
    expect((await times())[1]).toBeCloseTo(us / 1000, 0);
  });

  it('a SIG_SETMASK marked as the process mask (Blink 0507) is what rt_sigreturn restores for a signal handed over meanwhile (Open POSIX pthread_kill_8-1)', async () => {
    const p = kernel.spawn({ path: 'mt', cwd: '/tmp/kc', fds: {}, run: () => new Promise<number>(() => {}) });
    const sys = (nr: number, args: number[], data = new Uint8Array(256)) => kernel.syscall(p, nr, args, data);
    const set = (...sigs: number[]) => {
      const d = new Uint8Array(16);
      const [lo, hi] = A.sigsetToWords(sigs);
      new DataView(d.buffer).setUint32(0, lo, true); new DataView(d.buffer).setUint32(4, hi, true);
      return d;
    };
    p.dispositions.set(A.SIGUSR1, 0x1234);
    p.dispositions.set(A.SIGUSR2, 0x1234);
    // USR1 is handed over (its frame blocks it until rt_sigreturn); meanwhile one
    // thread's handler blocks USR2, and then all of them unblock it again
    kernel.deliver(p, A.SIGUSR1);
    expect(kernel.takeSignal(p)).toBe(A.SIGUSR1);
    expect(await sys(A.SYS_rt_sigprocmask, [A.SIG_SETMASK, 1, 0, 1], set(A.SIGUSR2))).toBe(0);
    expect(await sys(A.SYS_rt_sigreturn, [])).toBe(0);
    expect([...p.sigmask]).toEqual([A.SIGUSR2]);
    // a USR2 the new mask releases is taken within the call: its own frame
    // gets the mask that was sent, not one with USR2 in it
    kernel.deliver(p, A.SIGUSR2);
    expect(await sys(A.SYS_rt_sigprocmask, [A.SIG_SETMASK, 1, 0, 1], set())).toBe(0);
    expect(kernel.takeSignal(p)).toBe(A.SIGUSR2);
    expect(await sys(A.SYS_rt_sigprocmask, [A.SIG_SETMASK, 1, 0, 1], set())).toBe(0);
    expect(await sys(A.SYS_rt_sigreturn, [])).toBe(0);
    expect([...p.sigmask]).toEqual([]);
    // without the mark, rt_sigreturn restores the mask from before the handler (Linux)
    kernel.deliver(p, A.SIGUSR1);
    expect(kernel.takeSignal(p)).toBe(A.SIGUSR1);
    expect(await sys(A.SYS_rt_sigprocmask, [A.SIG_SETMASK, 1, 0], set(A.SIGUSR2))).toBe(0);
    expect(await sys(A.SYS_rt_sigreturn, [])).toBe(0);
    expect([...p.sigmask]).toEqual([]);
  });

  it('signalfd: blocked signals in its mask are read as signalfd_siginfo; poll/epoll readiness; mask updates (PostgreSQL 17)', async () => {
    const p = kernel.spawn({ path: 'pg', cwd: '/tmp/kc', fds: {}, run: () => new Promise<number>(() => {}) });
    const sys = (nr: number, args: number[], data = new Uint8Array(256)) => kernel.syscall(p, nr, args, data);
    const set = (...sigs: number[]) => {
      const d = new Uint8Array(16);
      const [lo, hi] = A.sigsetToWords(sigs);
      new DataView(d.buffer).setUint32(0, lo, true); new DataView(d.buffer).setUint32(4, hi, true);
      return d;
    };
    const SIGUSR1 = 10, SIGUSR2 = 12, SIGURG = 23;
    expect(await sys(A.SYS_rt_sigprocmask, [A.SIG_BLOCK, 1, 0], set(SIGUSR1, SIGUSR2, SIGURG))).toBe(0);
    expect(await sys(A.SYS_signalfd4, [-1, 8, 0x40], set(SIGUSR1))).toBe(-A.EINVAL); // bad flags
    expect(await sys(A.SYS_signalfd4, [-1, 4, 0], set(SIGUSR1))).toBe(-A.EINVAL); // bad sigset size
    const fd = await sys(A.SYS_signalfd4, [-1, 8, A.SFD_NONBLOCK | A.SFD_CLOEXEC], set(SIGUSR1, SIGURG));
    expect(fd).toBeGreaterThanOrEqual(0);
    expect(await sys(A.SYS_fcntl, [fd, A.F_GETFD])).toBe(A.FD_CLOEXEC);
    const buf = new Uint8Array(256);
    expect(await sys(A.SYS_read, [fd, 128], buf)).toBe(-A.EAGAIN);
    expect(await sys(A.SYS_read, [fd, 64], buf)).toBe(-A.EINVAL); // smaller than one record
    // epoll sees it readable once a signal in its mask is pending
    const ep = await sys(A.SYS_epoll_create1, [0]);
    expect(await sys(A.SYS_epoll_ctl, [ep, A.EPOLL_CTL_ADD, fd, A.EPOLLIN, 7, 0])).toBe(0);
    const waiting = sys(A.SYS_epoll_wait, [ep, 1, 2000], new Uint8Array(A.EPOLL_EVENT_SIZE));
    expect(kernel.kill(p.pid, SIGUSR1)).toBe(0);
    expect(await waiting).toBe(1);
    expect(p.state).not.toBe('zombie'); // blocked: not delivered (SIGUSR1 would terminate)
    kernel.kill(p.pid, SIGURG); // ignored by default, but blocked: it stays pending for the fd
    kernel.kill(p.pid, SIGUSR2); // pending, not in the mask
    expect(await sys(A.SYS_read, [fd, 256], buf)).toBe(256);
    const dv = new DataView(buf.buffer);
    expect([dv.getUint32(0, true), dv.getUint32(128, true)]).toEqual([SIGUSR1, SIGURG]);
    expect(await sys(A.SYS_read, [fd, 128], buf)).toBe(-A.EAGAIN);
    // signalfd(fd, …) replaces the mask: now SIGUSR2 is readable
    expect(await sys(A.SYS_signalfd4, [fd, 8, 0], set(SIGUSR2))).toBe(fd);
    expect(await sys(A.SYS_read, [fd, 128], buf)).toBe(128);
    expect(dv.getUint32(0, true)).toBe(SIGUSR2);
    // a blocking read waits for the signal
    const blocking = await sys(A.SYS_signalfd, [-1, 8], set(SIGUSR1));
    const r = sys(A.SYS_read, [blocking, 128], buf);
    await new Promise((res) => setTimeout(res, 10));
    kernel.kill(p.pid, SIGUSR1);
    expect(await r).toBe(128);
    expect(await sys(A.SYS_signalfd4, [99, 8, 0], set(SIGUSR1))).toBe(-A.EBADF);
    expect(await sys(A.SYS_signalfd4, [ep, 8, 0], set(SIGUSR1))).toBe(-A.EINVAL); // not a signalfd
    kernel.kill(p.pid, A.SIGKILL);
  });

  it('eventfd overflow waits, close_range flags, fstat of a removed directory, /proc/config.gz (LTP eventfd02/04, close_range02, readahead01, needs_kconfigs)', async () => {
    const u64 = (v: bigint) => { const d = new Uint8Array(8); new DataView(d.buffer).setBigUint64(0, v, true); return d; };
    const max = 0xfffffffffffffffen;
    // a write that would pass the maximum is EAGAIN nonblocking, and waits for a read otherwise
    const nb = await kernel.syscall(proc, A.SYS_eventfd2, [0, A.O_NONBLOCK], new Uint8Array(8));
    expect(await kernel.syscall(proc, A.SYS_write, [nb, 8], u64(max))).toBe(8);
    expect(await kernel.syscall(proc, A.SYS_write, [nb, 8], u64(1n))).toBe(-A.EAGAIN);
    const ev = await kernel.syscall(proc, A.SYS_eventfd2, [0, 0], new Uint8Array(8));
    expect(await kernel.syscall(proc, A.SYS_write, [ev, 8], u64(max))).toBe(8);
    let done = false;
    const w = kernel.syscall(proc, A.SYS_write, [ev, 8], u64(5n)).then((n) => { done = true; return n; });
    await new Promise((res) => setTimeout(res, 10));
    expect(done).toBe(false);
    const got = new Uint8Array(8);
    expect(await kernel.syscall(proc, A.SYS_read, [ev, 8], got)).toBe(8);
    expect(new DataView(got.buffer).getBigUint64(0, true)).toBe(max);
    expect(await w).toBe(8);
    expect(await kernel.syscall(proc, A.SYS_read, [ev, 8], got)).toBe(8);
    expect(new DataView(got.buffer).getBigUint64(0, true)).toBe(5n);
    for (const fd of [nb, ev]) await call(A.SYS_close, [fd]);
    // close_range: unknown flags
    expect(await call(A.SYS_close_range, [100, 200, 1])).toBe(-A.EINVAL);
    expect(await call(A.SYS_close_range, [100, 200, 4])).toBe(0);
    // a removed directory's fd still fstats, with nlink 0
    await fs.mkdir('/tmp/kc/gone');
    const d = await open('/tmp/kc/gone', A.O_RDONLY | A.O_DIRECTORY);
    await fs.rmdir('/tmp/kc/gone');
    const st = new Uint8Array(256);
    expect(await kernel.syscall(proc, A.SYS_fstat, [d], st)).toBe(0);
    expect(new DataView(st.buffer).getBigUint64(16, true)).toBe(0n);
    await call(A.SYS_close, [d]);
    // /proc/config.gz is gzip of the options
    const cfg = await open('/proc/config.gz', A.O_RDONLY);
    const gz = new Uint8Array(65536);
    const n = await kernel.syscall(proc, A.SYS_read, [cfg, gz.length], gz);
    expect(n).toBeGreaterThan(20);
    const text = await new Response(new Blob([gz.subarray(0, n)]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    expect(text).toContain('CONFIG_EVENTFD=y');
    await call(A.SYS_close, [cfg]);
  });

  it('RLIMIT_CPU is the kernel\'s: prlimit64 sets and reads it, SIGXCPU at the soft limit, SIGKILL at the hard one, inherited by fork; a call blocked now is not CPU (LTP setrlimit06)', async () => {
    const INF = 0xffffffffffffffffn;
    const lim = new Uint8Array(16), dv = new DataView(lim.buffer);
    const p = kernel.spawn({ path: 'cpulim', cwd: '/tmp/kc', fds: {}, run: () => new Promise<number>(() => {}) });
    const set = (cur: bigint, max: bigint) => { dv.setBigUint64(0, cur, true); dv.setBigUint64(8, max, true); return kernel.syscall(p, A.SYS_prlimit64, [0, A.RLIMIT_CPU, 1], lim); };
    expect(await kernel.syscall(p, A.SYS_prlimit64, [0, A.RLIMIT_CPU, 0], lim)).toBe(0);
    expect([dv.getBigUint64(0, true), dv.getBigUint64(8, true)]).toEqual([INF, INF]);
    expect(await set(3n, 2n)).toBe(-A.EINVAL);
    expect(await set(1n, 2n)).toBe(0);
    expect(await kernel.syscall(p, A.SYS_prlimit64, [0, A.RLIMIT_CPU, 0], lim)).toBe(0);
    expect([dv.getBigUint64(0, true), dv.getBigUint64(8, true)]).toEqual([1n, 2n]);
    expect(await set(1n, 5n)).toBe(-A.EPERM); // raising the hard limit takes root
    expect(kernel.cpuLimit(kernel.vfork(p))).toEqual({ cur: 1, max: 2 });
    // a blocked call (a pipe read) isn't CPU time while it waits
    const pd = new Uint8Array(16);
    expect(await kernel.syscall(p, A.SYS_pipe2, [0], pd)).toBe(0);
    const rfd = new DataView(pd.buffer).getInt32(0, true);
    p.syscalls = 1;
    const sigs: number[] = [];
    const deliver = kernel.deliver.bind(kernel);
    kernel.deliver = ((q: typeof p, sig: number, ...rest: unknown[]) => { if (q === p) sigs.push(sig); return (deliver as any)(q, sig, ...rest); }) as typeof kernel.deliver;
    void kernel.syscall(p, A.SYS_read, [rfd, 1], new Uint8Array(1));
    await new Promise((r) => setTimeout(r, 300));
    expect(ProcFs.cpuMs(p)).toBeLessThan(100);
    expect(sigs).toEqual([]);
    // computing (its time since start counts) past the soft limit, then the hard one
    // (SIGXCPU blocked, as a handler would keep it running)
    p.sigmask.add(A.SIGXCPU);
    p.inSyscall = 0;
    const st = p as { startTime: number };
    st.startTime = Date.now() - 1200;
    await new Promise((r) => setTimeout(r, 300));
    expect(sigs).toEqual([A.SIGXCPU]);
    st.startTime -= 1000;
    await new Promise((r) => setTimeout(r, 300));
    kernel.deliver = deliver;
    expect(sigs).toEqual([A.SIGXCPU, A.SIGKILL]);
  });
});
