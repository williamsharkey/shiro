/**
 * open() of /proc/self/fd/N and /dev/fd/N opens what the fd refers to again,
 * as Linux does: a new description (own offset and flags) of the same file,
 * memfd or pipe; ENXIO for a socket (bash's <(…), `cat /dev/fd/3`, LTP splice07).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createTestShell } from './helpers';
import type { FileSystem } from '@shiro/filesystem';
import type { Shell } from '@shiro/shell';
import * as A from '@shiro/kernel/abi';
import { Kernel } from '@shiro/kernel/kernel';
import type { Process } from '@shiro/kernel/process';
import { installNet, NetStack } from '@shiro/kernel/net';

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('reopening /proc/self/fd/N and /dev/fd/N', () => {
  let fs: FileSystem;
  let shell: Shell;
  let kernel: Kernel;
  let proc: Process;
  const d = new Uint8Array(4096);
  const call = (nr: number, args: number[], data = d) => kernel.syscall(proc, nr, args, data);
  const open = async (path: string, flags: number, mode = 0o644) => {
    const b = enc.encode(path); d.fill(0); d.set(b);
    return call(A.SYS_openat, [A.AT_FDCWD, b.length, flags, mode]);
  };
  const write = async (fd: number, s: string) => { const b = enc.encode(s); d.set(b); return call(A.SYS_write, [fd, b.length]); };
  const read = async (fd: number, n = 64) => { const r = await call(A.SYS_read, [fd, n]); return r < 0 ? r : dec.decode(d.subarray(0, r)); };
  const seekPos = (fd: number) => call(A.SYS_lseek, [fd, 0, 0, A.SEEK_CUR]);

  beforeAll(async () => {
    ({ fs, shell } = await createTestShell());
    await fs.mkdir('/tmp', { recursive: true }).catch(() => {});
  });
  beforeEach(() => {
    kernel = new Kernel({ shell });
    proc = kernel.spawn({ path: 'p', cwd: '/tmp', uid: 1000, fds: {}, run: () => new Promise<number>(() => {}) });
  });
  afterEach(() => { kernel.kill(proc.pid, A.SIGKILL); kernel.dispose(); });

  it('a file: its own offset; unlinked, still the file; O_TRUNC truncates it', async () => {
    const fd = await open('/tmp/reopen.txt', A.O_RDWR | A.O_CREAT | A.O_TRUNC);
    expect(await write(fd, 'hello')).toBe(5);
    const again = await open(`/proc/self/fd/${fd}`, A.O_RDONLY);
    expect(again).toBeGreaterThanOrEqual(0);
    expect(await read(again)).toBe('hello'); // from 0, not the writer's offset
    expect(await seekPos(fd)).toBe(5);
    expect(await write(again, 'x')).toBe(-A.EBADF); // read-only, as asked
    const b = enc.encode('/tmp/reopen.txt'); d.set(b);
    expect(await call(A.SYS_unlinkat, [A.AT_FDCWD, b.length, 0])).toBe(0);
    const unlinked = await open(`/dev/fd/${fd}`, A.O_RDONLY);
    expect(await read(unlinked)).toBe('hello');
    const trunc = await open(`/proc/${proc.pid}/fd/${fd}`, A.O_WRONLY | A.O_TRUNC);
    expect(trunc).toBeGreaterThanOrEqual(0);
    expect(await call(A.SYS_pread64, [fd, 8, 0, 0])).toBe(0); // the same file, now empty
  });

  it('a memfd: same contents, its own offset and access mode', async () => {
    const name = enc.encode('m'); d.set(name);
    const fd = await call(A.SYS_memfd_create, [name.length, 0]);
    expect(await write(fd, 'abc')).toBe(3);
    const ro = await open(`/proc/self/fd/${fd}`, A.O_RDONLY);
    expect(await read(ro)).toBe('abc');
    expect(await write(ro, 'z')).toBe(-A.EBADF);
    expect(await write(fd, 'def')).toBe(3);
    expect(await read(ro)).toBe('def'); // what the other description wrote
    expect(await call(A.SYS_close, [fd])).toBe(0);
    expect(await call(A.SYS_pread64, [ro, 6, 0, 0])).toBe(6); // contents live while a description does
    expect(dec.decode(d.subarray(0, 6))).toBe('abcdef');
  });

  it('a pipe: either end by the access mode; a socket is ENXIO; a closed fd ENOENT', async () => {
    expect(await call(A.SYS_pipe2, [0])).toBe(0);
    const [r, w] = [new DataView(d.buffer).getInt32(0, true), new DataView(d.buffer).getInt32(4, true)];
    const w2 = await open(`/dev/fd/${r}`, A.O_WRONLY); // the write end, through the read end's fd
    expect(await write(w2, 'via w2')).toBe(6);
    const r2 = await open(`/proc/self/fd/${w}`, A.O_RDONLY);
    expect(await read(r2)).toBe('via w2');
    expect(await write(w, 'ok')).toBe(2);
    expect(await read(r)).toBe('ok');
    const stack = new NetStack();
    stack.configure({ relayUrl: null, tokenUrl: null, portHost: null, dohUrl: null });
    const off = installNet(kernel, stack);
    expect(await call(A.SYS_socketpair, [A.AF_UNIX, A.SOCK_STREAM, 0])).toBe(0);
    const s = new DataView(d.buffer).getInt32(0, true);
    expect(await open(`/proc/self/fd/${s}`, A.O_RDWR)).toBe(-A.ENXIO);
    off();
    expect(await open('/proc/self/fd/987', A.O_RDONLY)).toBe(-A.ENOENT);
  });

  it('fcntl leases: a read lease on a file open for writing is EAGAIN (LTP fcntl27); F_GETLEASE', async () => {
    const rw = await open('/tmp/lease.txt', A.O_RDWR | A.O_CREAT | A.O_TRUNC);
    expect(await call(A.SYS_fcntl, [rw, A.F_SETLEASE, 0 /* F_RDLCK */])).toBe(-A.EAGAIN);
    const ro = await open('/tmp/lease.txt', A.O_RDONLY);
    expect(await call(A.SYS_fcntl, [ro, A.F_SETLEASE, 1 /* F_WRLCK */])).toBe(-A.EAGAIN); // others have it open
    expect(await call(A.SYS_close, [rw])).toBe(0);
    expect(await call(A.SYS_fcntl, [ro, A.F_SETLEASE, 0])).toBe(0);
    expect(await call(A.SYS_fcntl, [ro, A.F_GETLEASE, 0])).toBe(0);
    expect(await call(A.SYS_fcntl, [ro, A.F_SETLEASE, 2 /* F_UNLCK */])).toBe(0);
    expect(await call(A.SYS_fcntl, [ro, A.F_GETLEASE, 0])).toBe(2);
    expect(await call(A.SYS_fcntl, [ro, A.F_SETLEASE, 7])).toBe(-A.EINVAL);
  });
});
