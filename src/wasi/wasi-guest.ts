/**
 * wasi-guest.ts — WASI preview1 for a WASM process, on kernel syscalls.
 *
 * Every import that touches I/O is a generator that yields kernel syscall
 * requests (src/kernel/abi.ts numbering and argument conventions, see
 * docs/KERNEL_ABI.md) and receives the replies. The same code runs two ways:
 *   - 'sync': in a Worker, each request is a blocking round trip over the
 *     SharedArrayBuffer channel (Atomics.wait), so fd_read on an empty pipe
 *     or a terminal simply blocks until data arrives.
 *   - 'jspi': on the main thread, imports are WebAssembly.Suspending and each
 *     request awaits Kernel.syscall directly.
 * Nothing is preloaded: files are opened, read and written through the
 * kernel when the program asks.
 *
 * Also implemented: `wasi.thread-spawn` (wasi-threads) and the process/pipe/
 * futex subset of WASIX `wasix_32v1` (proc_spawn2/3, proc_exec/2/3,
 * proc_join, proc_id, proc_parent, fd_pipe, fd_dup, getcwd, chdir,
 * futex_wait/wake/wake_all, thread_sleep, thread_id). Any other import from
 * a wasi or wasix module resolves to a stub returning ENOSYS, so binaries
 * that import more than they use still instantiate.
 *
 * Path operations map onto the kernel's *at syscalls with the WASI dirfd;
 * preview1 sockets (sock_accept/recv/send/shutdown) onto accept4/recvfrom/
 * sendto/shutdown.
 */

import * as A from '../kernel/abi';
import {
  SysReply, SysRequest, filetypeFromDtype, filetypeFromMode, wasiErrno, writeFilestat,
  FT_CHAR, WASI_EBADF, WASI_ECHILD, WASI_EINVAL, WASI_ENOSYS, WASI_ENOTSUP, WASI_EOVERFLOW,
} from './abi';

const RIGHT_FD_READ = 1n << 1n, RIGHT_FD_SEEK = 1n << 2n, RIGHT_FD_TELL = 1n << 5n,
  RIGHT_FD_WRITE = 1n << 6n, RIGHT_FD_READDIR = 1n << 14n;
const ALL_RIGHTS = (1n << 30n) - 1n;

type Sys<T = number> = Generator<SysRequest, T, SysReply>;

/** Thrown to unwind the WASM stack once the kernel has ended the process. */
export class ProcExit extends Error {
  constructor(readonly status: number) { super(`exit status ${status}`); this.name = 'ProcExit'; }
}

export interface Preopen {
  fd: number;
  /** Name the program sees (fd_prestat_dir_name). */
  name: string;
  /** Absolute path in Shiro's filesystem. */
  path: string;
}

export interface GuestOptions {
  args: string[];
  env: Record<string, string>;
  preopens: Preopen[];
  /** Max bytes per request/reply (the channel data area). */
  dataSize: number;
  /** wasi-threads id of this instance (0 for the main thread). */
  tid?: number;
  /** Start a thread running wasi_thread_start(tid, startArg); returns tid or -errno. */
  threadSpawn?(startArg: number): number;
}

export type SyncCall = (req: SysRequest) => SysReply;
export type AsyncCall = (req: SysRequest) => Promise<SysReply>;

const enc = new TextEncoder();
const dec = new TextDecoder();
const DIRENT_BUF = 64 * 1024;

function normalize(path: string): string {
  const stack: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop(); else stack.push(part);
  }
  return '/' + stack.join('/');
}

export class WasiGuest {
  memory!: WebAssembly.Memory;
  readonly preopens = new Map<number, string>();
  /** Absolute paths of fds usable as a dirfd (preopens and opened paths). */
  private fdPaths = new Map<number, string>();
  private dirCache = new Map<number, Array<{ name: string; filetype: number; ino: bigint }>>();
  private argBytes: Uint8Array[];
  private envBytes: Uint8Array[];

  constructor(readonly opts: GuestOptions) {
    for (const p of opts.preopens) { this.preopens.set(p.fd, p.name); this.fdPaths.set(p.fd, p.path); }
    this.argBytes = opts.args.map(a => enc.encode(a + '\0'));
    this.envBytes = Object.entries(opts.env).map(([k, v]) => enc.encode(`${k}=${v}\0`));
  }

  // ── memory helpers ────────────────────────────────────────────────

  private view(): DataView { return new DataView(this.memory.buffer); }
  private u8(): Uint8Array { return new Uint8Array(this.memory.buffer); }
  /** Copy bytes out of guest memory (never a view: memory may be shared). */
  private bytes(ptr: number, len: number): Uint8Array { return this.u8().slice(ptr, ptr + len); }
  private str(ptr: number, len: number): string { return dec.decode(this.bytes(ptr, len)); }
  private cstr(ptr: number): string {
    const m = this.u8();
    let end = ptr;
    while (end < m.length && m[end] !== 0) end++;
    return dec.decode(m.slice(ptr, end));
  }
  private iovs(ptr: number, n: number): Array<[number, number]> {
    const v = this.view();
    const out: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) out.push([v.getUint32(ptr + i * 8, true), v.getUint32(ptr + i * 8 + 4, true)]);
    return out;
  }
  private gather(iovs: Array<[number, number]>): Uint8Array {
    const total = iovs.reduce((s, [, l]) => s + l, 0);
    const out = new Uint8Array(total);
    const m = this.u8();
    let off = 0;
    for (const [p, l] of iovs) { out.set(m.subarray(p, p + l), off); off += l; }
    return out;
  }
  private scatter(iovs: Array<[number, number]>, data: Uint8Array): void {
    const m = this.u8();
    let off = 0;
    for (const [p, l] of iovs) {
      if (off >= data.length) break;
      const k = Math.min(l, data.length - off);
      m.set(data.subarray(off, off + k), p);
      off += k;
    }
  }

  // ── syscall helpers (generators) ──────────────────────────────────

  private *sys(nr: number, args: number[] = [], data?: Uint8Array, out?: number): Sys<SysReply> {
    return yield { nr, args, data, out };
  }
  private *call(nr: number, ...args: number[]): Sys<number> {
    return (yield* this.sys(nr, args)).ret;
  }
  /** Syscall taking one path at data offset 0, length in the first arg. */
  private *pathCall(nr: number, path: string, args: number[] = [], out?: number): Sys<SysReply> {
    const b = enc.encode(path);
    return yield* this.sys(nr, [b.length, ...args], b, out);
  }
  /** *at syscall: (dirfd, pathLen, ...args) with the path at data offset 0. */
  private *atCall(nr: number, dirfd: number, path: string, args: number[] = [], out?: number): Sys<SysReply> {
    const b = enc.encode(path);
    return yield* this.sys(nr, [dirfd, b.length, ...args], b, out);
  }
  /** Two paths back to back, with their byte lengths. */
  private twoPaths(x: string, y: string): [Uint8Array, number, number] {
    const a = enc.encode(x), b = enc.encode(y);
    const data = new Uint8Array(a.length + b.length);
    data.set(a); data.set(b, a.length);
    return [data, a.length, b.length];
  }
  /** utimensat for WASI fst_flags (ATIM=1, ATIM_NOW=2, MTIM=4, MTIM_NOW=8); empty path = the fd itself. */
  private *utimens(dirfd: number, path: string, atim: bigint, mtim: bigint, fst: number, flags: number): Sys {
    const p = enc.encode(path);
    const data = new Uint8Array(p.length + 32);
    data.set(p);
    const v = new DataView(data.buffer, p.length, 32);
    const put = (off: number, t: bigint, set: boolean, now: boolean) => {
      v.setBigUint64(off, set ? t / 1_000_000_000n : 0n, true);
      v.setBigUint64(off + 8, BigInt(now ? A.UTIME_NOW : set ? Number(t % 1_000_000_000n) : A.UTIME_OMIT), true);
    };
    put(0, atim, !!(fst & 1), !!(fst & 2));
    put(16, mtim, !!(fst & 4), !!(fst & 8));
    return wasiErrno((yield* this.sys(A.SYS_utimensat, [dirfd, p.length, flags, 1], data)).ret);
  }
  private *writeAll(fd: number, data: Uint8Array): Sys<number> {
    let done = 0;
    const max = this.opts.dataSize;
    while (done < data.length) {
      const chunk = data.subarray(done, Math.min(data.length, done + max));
      const r = yield* this.sys(A.SYS_write, [fd, chunk.length], chunk);
      if (r.ret < 0) return done || r.ret;
      if (r.ret === 0) break;
      done += r.ret;
    }
    return done;
  }
  private *fstat(fd: number): Sys<A.KStat | number> {
    const r = yield* this.sys(A.SYS_fstat, [fd], undefined, A.STAT_SIZE);
    return r.ret < 0 ? r.ret : A.decodeStat(r.data);
  }
  private *lseek(fd: number, off: number, whence: number): Sys<number> {
    return yield* this.call(A.SYS_lseek, fd, off >>> 0, Math.floor(off / 0x100000000), whence);
  }

  /** Absolute path for `path` relative to a dirfd we opened, or -errno (only fchdir spawn actions need it). */
  private resolve(dirfd: number, path: string): string | number {
    if (!path) return -A.ENOENT;
    if (path.startsWith('/')) return normalize(path);
    const base = this.fdPaths.get(dirfd);
    if (base === undefined) return -A.EBADF;
    return normalize(base + '/' + path);
  }

  // ── import table ──────────────────────────────────────────────────

  /** Import implementations: module → name → function returning a value or a Sys generator. */
  functions(): Record<string, Record<string, (...a: any[]) => any>> {
    const g = <Args extends any[]>(fn: (...a: Args) => Sys<number>) => fn.bind(this) as (...a: Args) => Sys<number>;
    return {
      wasi_snapshot_preview1: {
        args_sizes_get: (argc: number, size: number) => this.sizes(this.argBytes, argc, size),
        args_get: (argv: number, buf: number) => this.fill(this.argBytes, argv, buf),
        environ_sizes_get: (cnt: number, size: number) => this.sizes(this.envBytes, cnt, size),
        environ_get: (envp: number, buf: number) => this.fill(this.envBytes, envp, buf),
        clock_res_get: (_id: number, ptr: number) => { this.view().setBigUint64(ptr, 1000n, true); return 0; },
        clock_time_get: (id: number, _prec: bigint, ptr: number) => { this.view().setBigUint64(ptr, now(id), true); return 0; },
        random_get: (ptr: number, len: number) => {
          // getRandomValues refuses views of shared memory: fill a copy
          const tmp = new Uint8Array(len);
          for (let i = 0; i < len; i += 65536) crypto.getRandomValues(tmp.subarray(i, Math.min(len, i + 65536)));
          this.u8().set(tmp, ptr);
          return 0;
        },
        sched_yield: () => 0,
        fd_prestat_get: (fd: number, ptr: number) => {
          const name = this.preopens.get(fd);
          if (name === undefined) return WASI_EBADF;
          const v = this.view();
          v.setUint8(ptr, 0);
          v.setUint32(ptr + 4, enc.encode(name).length, true);
          return 0;
        },
        fd_prestat_dir_name: (fd: number, ptr: number, len: number) => {
          const name = this.preopens.get(fd);
          if (name === undefined) return WASI_EBADF;
          this.u8().set(enc.encode(name).subarray(0, len), ptr);
          return 0;
        },
        fd_fdstat_set_rights: () => 0,
        fd_advise: () => 0,
        fd_allocate: () => 0,
        fd_filestat_set_times: g(function* (this: WasiGuest, fd: number, atim: bigint, mtim: bigint, fst: number) {
          return yield* this.utimens(fd, '', atim, mtim, fst, 0);
        }),
        path_filestat_set_times: g(function* (this: WasiGuest, fd: number, flags: number, p: number, l: number, atim: bigint, mtim: bigint, fst: number) {
          return yield* this.utimens(fd, this.str(p, l), atim, mtim, fst, flags & 1 ? 0 : A.AT_SYMLINK_NOFOLLOW);
        }),
        path_link: g(function* (this: WasiGuest, ofd: number, oflags: number, op: number, ol: number, nfd: number, np: number, nl: number) {
          const [data, a, b] = this.twoPaths(this.str(op, ol), this.str(np, nl));
          return wasiErrno((yield* this.sys(A.SYS_linkat, [ofd, a, nfd, b, oflags & 1 ? A.AT_SYMLINK_FOLLOW : 0], data)).ret);
        }),
        path_symlink: g(function* (this: WasiGuest, op: number, ol: number, fd: number, np: number, nl: number) {
          const [data, a, b] = this.twoPaths(this.str(op, ol), this.str(np, nl));
          return wasiErrno((yield* this.sys(A.SYS_symlinkat, [a, fd, b], data)).ret);
        }),
        sock_accept: g(function* (this: WasiGuest, fd: number, flags: number, ret: number) {
          const r = yield* this.sys(A.SYS_accept4, [fd, flags & 4 ? A.O_NONBLOCK : 0], undefined, A.SOCKADDR_ROOM);
          if (r.ret < 0) return wasiErrno(r.ret);
          this.view().setUint32(ret, r.ret, true);
          return 0;
        }),
        sock_recv: g(this.sock_recv),
        sock_send: g(this.sock_send),
        sock_shutdown: g(function* (this: WasiGuest, fd: number, how: number) {
          // WASI sdflags RD=1, WR=2 → SHUT_RD=0, SHUT_WR=1, SHUT_RDWR=2
          if (!(how & 3)) return WASI_EINVAL;
          return wasiErrno(yield* this.call(A.SYS_shutdown, fd, (how & 3) - 1));
        }),
        fd_write: g(this.fd_write),
        fd_read: g(this.fd_read),
        fd_pwrite: g(this.fd_pwrite),
        fd_pread: g(this.fd_pread),
        fd_seek: g(this.fd_seek),
        fd_tell: g(function* (this: WasiGuest, fd: number, ptr: number) { return yield* this.fd_seek(fd, 0n, A.SEEK_CUR, ptr); }),
        fd_close: g(this.fd_close),
        fd_fdstat_get: g(this.fd_fdstat_get),
        fd_fdstat_set_flags: g(function* (this: WasiGuest, fd: number, flags: number) {
          let fl = 0;
          if (flags & 1) fl |= A.O_APPEND;
          if (flags & 4) fl |= A.O_NONBLOCK;
          return wasiErrno(yield* this.call(A.SYS_fcntl, fd, A.F_SETFL, fl));
        }),
        fd_filestat_get: g(function* (this: WasiGuest, fd: number, ptr: number) {
          const st = yield* this.fstat(fd);
          if (typeof st === 'number') return wasiErrno(st);
          writeFilestat(st, this.view(), ptr);
          return 0;
        }),
        fd_filestat_set_size: g(function* (this: WasiGuest, fd: number, size: bigint) {
          return wasiErrno(yield* this.call(A.SYS_ftruncate, fd, Number(size & 0xffffffffn), Number(size >> 32n)));
        }),
        fd_sync: g(function* (this: WasiGuest, fd: number) { return wasiErrno(yield* this.call(A.SYS_fsync, fd)); }),
        fd_datasync: g(function* (this: WasiGuest, fd: number) { return wasiErrno(yield* this.call(A.SYS_fsync, fd)); }),
        fd_readdir: g(this.fd_readdir),
        fd_renumber: g(this.fd_renumber),
        path_open: g(this.path_open),
        path_create_directory: g(function* (this: WasiGuest, fd: number, p: number, l: number) {
          return wasiErrno((yield* this.atCall(A.SYS_mkdirat, fd, this.str(p, l), [0o777])).ret);
        }),
        path_filestat_get: g(function* (this: WasiGuest, fd: number, flags: number, p: number, l: number, buf: number) {
          const r = yield* this.atCall(A.SYS_newfstatat, fd, this.str(p, l), [flags & 1 ? 0 : A.AT_SYMLINK_NOFOLLOW], A.STAT_SIZE);
          if (r.ret < 0) return wasiErrno(r.ret);
          writeFilestat(A.decodeStat(r.data), this.view(), buf);
          return 0;
        }),
        path_readlink: g(function* (this: WasiGuest, fd: number, p: number, l: number, buf: number, bufLen: number, used: number) {
          const r = yield* this.atCall(A.SYS_readlinkat, fd, this.str(p, l), [bufLen], bufLen);
          if (r.ret < 0) return wasiErrno(r.ret);
          this.u8().set(r.data.subarray(0, r.ret), buf);
          this.view().setUint32(used, r.ret, true);
          return 0;
        }),
        path_remove_directory: g(function* (this: WasiGuest, fd: number, p: number, l: number) {
          return wasiErrno((yield* this.atCall(A.SYS_unlinkat, fd, this.str(p, l), [A.AT_REMOVEDIR])).ret);
        }),
        path_unlink_file: g(function* (this: WasiGuest, fd: number, p: number, l: number) {
          return wasiErrno((yield* this.atCall(A.SYS_unlinkat, fd, this.str(p, l), [0])).ret);
        }),
        path_rename: g(function* (this: WasiGuest, fd: number, op: number, ol: number, nfd: number, np: number, nl: number) {
          const [data, a, b] = this.twoPaths(this.str(op, ol), this.str(np, nl));
          return wasiErrno((yield* this.sys(A.SYS_renameat, [fd, a, nfd, b], data)).ret);
        }),
        poll_oneoff: g(this.poll_oneoff),
        proc_exit: g(function* (this: WasiGuest, code: number) { return yield* this.exit(code); }),
        proc_raise: g(function* (this: WasiGuest, sig: number) {
          const pid = yield* this.call(A.SYS_getpid);
          return wasiErrno(yield* this.call(A.SYS_kill, pid, sig));
        }),
      },
      wasi: {
        'thread-spawn': (arg: number) => {
          if (!this.opts.threadSpawn) return -WASI_ENOSYS;
          const r = this.opts.threadSpawn(arg);
          return r < 0 ? -wasiErrno(r) : r;
        },
      },
      wasix_32v1: {
        // WASIX libc startup asks for the inherited signal dispositions and
        // exits 71 through proc_exit2 when that fails. None are inherited here.
        proc_signals_sizes_get: (ptr: number) => { this.view().setUint32(ptr, 0, true); return 0; },
        proc_signals_get: () => 0,
        proc_exit2: g(function* (this: WasiGuest, code: number) { return yield* this.exit(code); }),
        // path_open plus WASIX fd flags (bit 0: close-on-exec)
        path_open2: g(function* (this: WasiGuest, dirfd: number, dirflags: number, p: number, l: number, oflags: number,
          rb: bigint, ri: bigint, fdflags: number, fdflagsExt: number, fdPtr: number) {
          const r = yield* this.path_open(dirfd, dirflags, p, l, oflags, rb, ri, fdflags, fdPtr);
          if (r === 0 && (fdflagsExt & 1)) yield* this.call(A.SYS_fcntl, this.view().getUint32(fdPtr, true), A.F_SETFD, A.FD_CLOEXEC);
          return r;
        }),
        fd_fdflags_get: g(function* (this: WasiGuest, fd: number, ptr: number) {
          const r = yield* this.call(A.SYS_fcntl, fd, A.F_GETFD, 0);
          if (r < 0) return wasiErrno(r);
          this.view().setUint16(ptr, r & A.FD_CLOEXEC ? 1 : 0, true);
          return 0;
        }),
        fd_fdflags_set: g(function* (this: WasiGuest, fd: number, flags: number) {
          return wasiErrno(yield* this.call(A.SYS_fcntl, fd, A.F_SETFD, flags & 1 ? A.FD_CLOEXEC : 0));
        }),
        fd_pipe: g(function* (this: WasiGuest, rp: number, wp: number) {
          const r = yield* this.sys(A.SYS_pipe2, [0], undefined, 8);
          if (r.ret < 0) return wasiErrno(r.ret);
          const v = new DataView(r.data.buffer, r.data.byteOffset, 8);
          const m = this.view();
          m.setUint32(rp, v.getInt32(0, true), true);
          m.setUint32(wp, v.getInt32(4, true), true);
          return 0;
        }),
        fd_dup: g(function* (this: WasiGuest, fd: number, ret: number) {
          const r = yield* this.call(A.SYS_dup, fd);
          if (r < 0) return wasiErrno(r);
          const p = this.fdPaths.get(fd);
          if (p !== undefined) this.fdPaths.set(r, p);
          this.view().setUint32(ret, r, true);
          return 0;
        }),
        getcwd: g(function* (this: WasiGuest, ptr: number, lenPtr: number) {
          const r = yield* this.sys(A.SYS_getcwd, [4096], undefined, 4096);
          if (r.ret < 0) return wasiErrno(r.ret);
          const cwd = r.data.slice(0, r.ret - 1); // without the NUL
          const v = this.view();
          const cap = v.getUint32(lenPtr, true);
          v.setUint32(lenPtr, cwd.length, true);
          if (cwd.length > cap) return WASI_EOVERFLOW;
          this.u8().set(cwd, ptr);
          return 0;
        }),
        chdir: g(function* (this: WasiGuest, p: number, l: number) {
          return wasiErrno((yield* this.pathCall(A.SYS_chdir, this.str(p, l))).ret);
        }),
        proc_id: g(function* (this: WasiGuest, ret: number) {
          this.view().setUint32(ret, yield* this.call(A.SYS_getpid), true);
          return 0;
        }),
        proc_parent: g(function* (this: WasiGuest, _pid: number, ret: number) {
          this.view().setUint32(ret, yield* this.call(A.SYS_getppid), true);
          return 0;
        }),
        proc_spawn2: g(this.proc_spawn2),
        proc_spawn3: g(this.proc_spawn3),
        proc_exec: g(function* (this: WasiGuest, n: number, nl: number, a: number, al: number) {
          return yield* this.exec(this.str(n, nl), splitList(this.str(a, al)), null, true);
        }),
        proc_exec2: g(function* (this: WasiGuest, n: number, nl: number, a: number, al: number, e: number, el: number) {
          return yield* this.exec(this.str(n, nl), splitList(this.str(a, al)), e ? envList(splitList(this.str(e, el))) : null, true);
        }),
        proc_exec3: g(function* (this: WasiGuest, n: number, nl: number, a: number, al: number, e: number, el: number, search: number, p: number, pl: number) {
          return yield* this.exec(this.str(n, nl), splitList(this.str(a, al)), e ? envList(splitList(this.str(e, el))) : null, !!search, p ? this.str(p, pl) : undefined);
        }),
        proc_join: g(this.proc_join),
        futex_wait: g(this.futex_wait),
        futex_wake: (ptr: number, ret: number) => this.futexWake(ptr, 1, ret),
        futex_wake_all: (ptr: number, ret: number) => this.futexWake(ptr, Infinity, ret),
        thread_sleep: g(function* (this: WasiGuest, ns: bigint) {
          const n = Number(ns);
          yield* this.call(A.SYS_nanosleep, Math.floor(n / 1e9), n % 1e9);
          return 0;
        }),
        thread_id: (ret: number) => { this.view().setUint32(ret, this.opts.tid ?? 0, true); return 0; },
        sched_yield: () => 0,
      },
    };
  }

  // ── args / env ────────────────────────────────────────────────────

  private sizes(items: Uint8Array[], countPtr: number, sizePtr: number): number {
    const v = this.view();
    v.setUint32(countPtr, items.length, true);
    v.setUint32(sizePtr, items.reduce((s, b) => s + b.length, 0), true);
    return 0;
  }
  private fill(items: Uint8Array[], ptrs: number, buf: number): number {
    const v = this.view();
    const m = this.u8();
    let off = buf;
    items.forEach((b, i) => { v.setUint32(ptrs + i * 4, off, true); m.set(b, off); off += b.length; });
    return 0;
  }

  // ── fd_* ──────────────────────────────────────────────────────────

  private *fd_write(fd: number, iovs: number, n: number, nwritten: number): Sys {
    const done = yield* this.writeAll(fd, this.gather(this.iovs(iovs, n)));
    if (done < 0) return wasiErrno(done);
    this.view().setUint32(nwritten, done, true);
    return 0;
  }

  private *fd_read(fd: number, iovsPtr: number, n: number, nread: number): Sys {
    const iovs = this.iovs(iovsPtr, n);
    const total = Math.min(iovs.reduce((s, [, l]) => s + l, 0), this.opts.dataSize);
    // One read: it returns as soon as some data is there (a line from a tty, a pipe chunk)
    const r = yield* this.sys(A.SYS_read, [fd, total], undefined, total);
    if (r.ret < 0) return wasiErrno(r.ret);
    this.scatter(iovs, r.data.subarray(0, r.ret));
    this.view().setUint32(nread, r.ret, true);
    return 0;
  }

  private *fd_pread(fd: number, iovsPtr: number, n: number, offset: bigint, nread: number): Sys {
    const iovs = this.iovs(iovsPtr, n);
    const total = Math.min(iovs.reduce((s, [, l]) => s + l, 0), this.opts.dataSize);
    const r = yield* this.sys(A.SYS_pread64, [fd, total, Number(offset & 0xffffffffn), Number(offset >> 32n)], undefined, total);
    if (r.ret < 0) return wasiErrno(r.ret);
    this.scatter(iovs, r.data.subarray(0, r.ret));
    this.view().setUint32(nread, r.ret, true);
    return 0;
  }

  private *fd_pwrite(fd: number, iovs: number, n: number, offset: bigint, nwritten: number): Sys {
    const data = this.gather(this.iovs(iovs, n));
    let done = 0;
    while (done < data.length) {
      const chunk = data.subarray(done, Math.min(data.length, done + this.opts.dataSize));
      const off = offset + BigInt(done);
      const r = yield* this.sys(A.SYS_pwrite64, [fd, chunk.length, Number(off & 0xffffffffn), Number(off >> 32n)], chunk);
      if (r.ret < 0) { if (!done) return wasiErrno(r.ret); break; }
      if (r.ret === 0) break;
      done += r.ret;
    }
    this.view().setUint32(nwritten, done, true);
    return 0;
  }

  // ── sockets (preview1) ────────────────────────────────────────────

  private *sock_recv(fd: number, iovsPtr: number, n: number, riFlags: number, lenPtr: number, roFlagsPtr: number): Sys {
    const iovs = this.iovs(iovsPtr, n);
    const total = Math.min(iovs.reduce((s, [, l]) => s + l, 0), this.opts.dataSize - A.SOCKADDR_ROOM);
    let flags = 0;
    if (riFlags & 1) flags |= A.MSG_PEEK;
    if (riFlags & 2) flags |= A.MSG_WAITALL;
    const r = yield* this.sys(A.SYS_recvfrom, [fd, total, flags], undefined, total + A.SOCKADDR_ROOM);
    if (r.ret < 0) return wasiErrno(r.ret);
    this.scatter(iovs, r.data.subarray(0, r.ret));
    const v = this.view();
    v.setUint32(lenPtr, r.ret, true);
    v.setUint16(roFlagsPtr, 0, true);
    return 0;
  }

  private *sock_send(fd: number, iovs: number, n: number, _siFlags: number, lenPtr: number): Sys {
    const data = this.gather(this.iovs(iovs, n));
    const room = this.opts.dataSize - A.SOCKADDR_ROOM;
    let done = 0;
    while (done < data.length) {
      const chunk = data.subarray(done, Math.min(data.length, done + room));
      const r = yield* this.sys(A.SYS_sendto, [fd, chunk.length, 0, 0], chunk);
      if (r.ret < 0) { if (!done) return wasiErrno(r.ret); break; }
      if (r.ret === 0) break;
      done += r.ret;
    }
    this.view().setUint32(lenPtr, done, true);
    return 0;
  }

  private *fd_seek(fd: number, offset: bigint, whence: number, ptr: number): Sys {
    const off = BigInt.asIntN(64, offset);
    const r = yield* this.call(A.SYS_lseek, fd, Number(BigInt.asUintN(32, off)) | 0, Number(off >> 32n), whence);
    if (r < 0) return wasiErrno(r);
    this.view().setBigUint64(ptr, BigInt(r), true);
    return 0;
  }

  private *fd_close(fd: number): Sys {
    const r = yield* this.call(A.SYS_close, fd);
    if (r >= 0) { this.preopens.delete(fd); this.fdPaths.delete(fd); this.dirCache.delete(fd); }
    return wasiErrno(r);
  }

  private *fd_fdstat_get(fd: number, ptr: number): Sys {
    const st = yield* this.fstat(fd);
    if (typeof st === 'number') return wasiErrno(st);
    const fl = yield* this.call(A.SYS_fcntl, fd, A.F_GETFL, 0);
    const filetype = filetypeFromMode(st.mode);
    let flags = 0;
    let rights = ALL_RIGHTS;
    // wasi-libc's isatty(): a character device without seek/tell rights
    if (filetype === FT_CHAR) rights &= ~(RIGHT_FD_SEEK | RIGHT_FD_TELL);
    if (fl >= 0) {
      if (fl & A.O_APPEND) flags |= 1;
      if (fl & A.O_NONBLOCK) flags |= 4;
      const acc = fl & A.O_ACCMODE;
      if (acc === A.O_RDONLY) rights &= ~RIGHT_FD_WRITE;
      if (acc === A.O_WRONLY) rights &= ~(RIGHT_FD_READ | RIGHT_FD_READDIR);
    }
    const v = this.view();
    v.setUint8(ptr, filetype);
    v.setUint8(ptr + 1, 0);
    v.setUint16(ptr + 2, flags, true);
    v.setUint32(ptr + 4, 0, true);
    v.setBigUint64(ptr + 8, rights, true);
    v.setBigUint64(ptr + 16, ALL_RIGHTS, true);
    return 0;
  }

  private *fd_readdir(fd: number, buf: number, bufLen: number, cookie: bigint, used: number): Sys {
    let list = this.dirCache.get(fd);
    if (!list || cookie === 0n) {
      // Restart the stream and read every entry; cookies index this list
      const s = yield* this.lseek(fd, 0, A.SEEK_SET);
      if (s < 0 && s !== -A.ESPIPE) return wasiErrno(s);
      list = [];
      for (;;) {
        const size = Math.min(DIRENT_BUF, this.opts.dataSize);
        const r = yield* this.sys(A.SYS_getdents64, [fd, size], undefined, size);
        if (r.ret < 0) return wasiErrno(r.ret);
        if (r.ret === 0) break;
        const dv = new DataView(r.data.buffer, r.data.byteOffset, r.ret);
        for (let off = 0; off < r.ret;) {
          const reclen = dv.getUint16(off + 16, true);
          const type = dv.getUint8(off + 18);
          let end = off + 19;
          while (end < off + reclen && r.data[end] !== 0) end++;
          list.push({ name: dec.decode(r.data.slice(off + 19, end)), filetype: filetypeFromDtype(type), ino: dv.getBigUint64(off, true) });
          off += reclen;
        }
      }
      this.dirCache.set(fd, list);
    }
    const m = this.u8();
    let off = 0;
    for (let i = Number(cookie); i < list.length && off < bufLen; i++) {
      const name = enc.encode(list[i].name);
      const ent = new Uint8Array(24 + name.length);
      const ev = new DataView(ent.buffer);
      ev.setBigUint64(0, BigInt(i + 1), true);
      ev.setBigUint64(8, list[i].ino, true);
      ev.setUint32(16, name.length, true);
      ev.setUint8(20, list[i].filetype);
      ent.set(name, 24);
      const k = Math.min(ent.length, bufLen - off);
      m.set(ent.subarray(0, k), buf + off);
      off += k;
    }
    this.view().setUint32(used, off, true);
    return 0;
  }

  private *fd_renumber(from: number, to: number): Sys {
    const r = yield* this.call(A.SYS_dup2, from, to);
    if (r < 0) return wasiErrno(r);
    yield* this.call(A.SYS_close, from);
    for (const m of [this.preopens, this.fdPaths] as Map<number, string>[]) {
      const v = m.get(from);
      m.delete(to);
      if (v !== undefined) { m.delete(from); m.set(to, v); }
    }
    this.dirCache.delete(from);
    this.dirCache.delete(to);
    return 0;
  }

  // ── path_open ─────────────────────────────────────────────────────

  private *path_open(dirfd: number, _dirflags: number, p: number, l: number, oflags: number,
    rightsBase: bigint, _rightsInh: bigint, fdflags: number, fdPtr: number): Sys {
    const rel = this.str(p, l);
    const read = (rightsBase & (RIGHT_FD_READ | RIGHT_FD_READDIR)) !== 0n;
    const write = (rightsBase & RIGHT_FD_WRITE) !== 0n;
    let flags = write ? (read ? A.O_RDWR : A.O_WRONLY) : A.O_RDONLY;
    if (oflags & 1) flags |= A.O_CREAT;
    if (oflags & 2) flags = (flags & ~A.O_ACCMODE) | A.O_DIRECTORY;
    if (oflags & 4) flags |= A.O_EXCL;
    if (oflags & 8) flags |= A.O_TRUNC;
    if (fdflags & 1) flags |= A.O_APPEND;
    if (fdflags & 4) flags |= A.O_NONBLOCK;
    const b = enc.encode(rel);
    let fd = (yield* this.sys(A.SYS_openat, [dirfd, b.length, flags, 0o666], b)).ret;
    // Programs that ask for every right (read+write) also open directories that way
    if (fd === -A.EISDIR && !(flags & (A.O_CREAT | A.O_TRUNC))) {
      fd = (yield* this.sys(A.SYS_openat, [dirfd, b.length, A.O_RDONLY | A.O_DIRECTORY, 0], b)).ret;
    }
    if (fd < 0) return wasiErrno(fd);
    const abs = this.resolve(dirfd, rel);
    if (typeof abs === 'string') this.fdPaths.set(fd, abs);
    this.dirCache.delete(fd);
    this.view().setUint32(fdPtr, fd, true);
    return 0;
  }

  // ── poll_oneoff ───────────────────────────────────────────────────

  private *poll_oneoff(inPtr: number, outPtr: number, nsubs: number, neventsPtr: number): Sys {
    if (nsubs === 0) return WASI_EINVAL;
    const v = this.view();
    type Sub = { userdata: bigint; tag: number; fd: number; deadline: number };
    const subs: Sub[] = [];
    const start = performance.now();
    let timeout = -1;
    for (let i = 0; i < nsubs; i++) {
      const b = inPtr + i * 48;
      const tag = v.getUint8(b + 8);
      const sub: Sub = { userdata: v.getBigUint64(b, true), tag, fd: -1, deadline: Infinity };
      if (tag === 0) {
        const id = v.getUint32(b + 16, true);
        const t = v.getBigUint64(b + 24, true);
        const abs = (v.getUint16(b + 40, true) & 1) !== 0;
        const ms = Math.max(0, abs ? Number(t - now(id)) / 1e6 : Number(t) / 1e6);
        sub.deadline = start + ms;
        timeout = timeout < 0 ? ms : Math.min(timeout, ms);
      } else {
        sub.fd = v.getUint32(b + 16, true);
      }
      subs.push(sub);
    }
    const fdSubs = subs.filter(s => s.tag !== 0);
    const pollData = new Uint8Array(Math.max(8, fdSubs.length * A.POLLFD_SIZE));
    const pv = new DataView(pollData.buffer);
    fdSubs.forEach((s, i) => {
      pv.setInt32(i * 8, s.fd, true);
      pv.setInt16(i * 8 + 4, s.tag === 1 ? A.POLLIN : A.POLLOUT, true);
    });
    const r = yield* this.sys(A.SYS_poll, [fdSubs.length, timeout < 0 ? -1 : Math.ceil(timeout)], pollData, pollData.length);
    const events: Array<{ userdata: bigint; error: number; type: number; nbytes: bigint; flags: number }> = [];
    if (r.ret > 0) {
      const ov = new DataView(r.data.buffer, r.data.byteOffset, fdSubs.length * A.POLLFD_SIZE);
      fdSubs.forEach((s, i) => {
        const rev = ov.getInt16(i * 8 + 6, true);
        if (!rev) return;
        events.push({
          userdata: s.userdata, error: rev & A.POLLNVAL ? WASI_EBADF : 0, type: s.tag,
          nbytes: rev & (A.POLLIN | A.POLLOUT) ? 1n : 0n, flags: rev & (A.POLLHUP | A.POLLERR) ? 1 : 0,
        });
      });
    }
    if (!events.length) {
      const t = performance.now();
      for (const s of subs) if (s.tag === 0 && s.deadline <= t + 1) events.push({ userdata: s.userdata, error: 0, type: 0, nbytes: 0n, flags: 0 });
      if (!events.length && r.ret < 0) return wasiErrno(r.ret);
    }
    const w = this.view();
    events.forEach((e, i) => {
      const b = outPtr + i * 32;
      w.setBigUint64(b, e.userdata, true);
      w.setUint16(b + 8, e.error, true);
      w.setUint8(b + 10, e.type);
      w.setBigUint64(b + 16, e.nbytes, true);
      w.setUint16(b + 24, e.flags, true);
    });
    w.setUint32(neventsPtr, events.length, true);
    return 0;
  }

  // ── exit ──────────────────────────────────────────────────────────

  /** exit_group: in a Worker the kernel never replies (it terminates us); under JSPI we unwind. */
  *exit(code: number): Sys<never> {
    yield* this.call(A.SYS_exit_group, code & 0xff);
    throw new ProcExit(A.W_EXITCODE(code));
  }

  /** End the process by a signal (default action: terminate with that status). */
  *exitBySignal(sig: number): Sys<never> {
    const pid = yield* this.call(A.SYS_getpid);
    yield* this.call(A.SYS_kill, pid, sig);
    throw new ProcExit(A.W_TERMSIG(sig));
  }

  /** Report a trap on stderr and abort (SIGABRT, exit status 134). */
  *trap(e: unknown): Sys<never> {
    const msg = e instanceof Error ? e.message : String(e);
    yield* this.writeAll(2, enc.encode(`wasm trap: ${msg}\n`));
    return yield* this.exitBySignal(A.SIGABRT);
  }

  // ── WASIX processes ───────────────────────────────────────────────

  /**
   * posix_spawn through SYS_spawn. The child inherits our non-cloexec fds
   * (`inherit: true`); WASIX file actions become fd overrides (dup2, open)
   * and, for close, the parent fd is marked close-on-exec just for the spawn.
   */
  private *spawn(req: {
    name: string; argv: string[]; env: Record<string, string> | null; searchPath: boolean; path?: string;
    actions?: SpawnAction[];
  }): Sys<number> {
    const map = new Map<number, number>();
    const temps: number[] = [];
    const cloexecSet: number[] = [];
    let cwd: string | undefined;
    const self = this;
    function* cleanup() {
      for (const t of temps) yield* self.call(A.SYS_close, t);
      for (const fd of cloexecSet) yield* self.call(A.SYS_fcntl, fd, A.F_SETFD, 0);
    }
    for (const act of req.actions ?? []) {
      let err = 0;
      if (act.op === 'close') {
        map.delete(act.fd);
        const fl = yield* this.call(A.SYS_fcntl, act.fd, A.F_GETFD, 0);
        if (fl >= 0 && !(fl & A.FD_CLOEXEC)) {
          yield* this.call(A.SYS_fcntl, act.fd, A.F_SETFD, A.FD_CLOEXEC);
          cloexecSet.push(act.fd);
        }
      } else if (act.op === 'dup2') {
        map.set(act.fd, map.has(act.src) ? map.get(act.src)! : act.src);
      } else if (act.op === 'open') {
        // Relative to the child's cwd so far (a chdir action), else ours
        const p = act.path.startsWith('/') || !cwd ? act.path : normalize(cwd + '/' + act.path);
        const b = enc.encode(p);
        const fd = (yield* this.sys(A.SYS_openat, [A.AT_FDCWD, b.length, act.flags | A.O_CLOEXEC, act.mode], b)).ret;
        if (fd < 0) err = fd; else { temps.push(fd); map.set(act.fd, fd); }
      } else if (act.op === 'chdir') {
        cwd = act.path.startsWith('/') || !cwd ? act.path : normalize(cwd + '/' + act.path);
      } else if (act.op === 'fchdir') {
        const p = this.resolve(act.src, '.');
        if (typeof p === 'number') err = p; else cwd = p;
      }
      if (err < 0) { yield* cleanup(); return err; }
    }
    let env = req.env;
    if (req.searchPath && req.path) env = { ...(env ?? this.opts.env), PATH: req.path };
    // Without a PATH search a bare name is a file in the cwd, as for execve
    const path = req.searchPath || req.name.includes('/') ? req.name : './' + req.name;
    const json = enc.encode(JSON.stringify({
      path, argv: req.argv.length ? req.argv : [req.name], ...(env ? { env } : {}), ...(cwd ? { cwd } : {}),
      inherit: true, fds: [...map].sort((a, b) => a[0] - b[0]),
    }));
    if (json.length > this.opts.dataSize) { yield* cleanup(); return -A.E2BIG; }
    const pid = (yield* this.sys(A.SYS_spawn, [json.length], json)).ret;
    yield* cleanup();
    return pid;
  }

  private fdOps(ptr: number, n: number): SpawnAction[] {
    const v = this.view();
    const out: SpawnAction[] = [];
    for (let i = 0; i < n; i++) {
      // ProcSpawnFdOp<Memory32>: cmd u8, fd u32 @4, src_fd @8, name ptr @12, len @16,
      // dirflags @20, oflags u16 @24, rights_base u64 @32, rights_inh @40, fdflags u16 @48 (56 bytes)
      const b = ptr + i * 56;
      const cmd = v.getUint8(b);
      const fd = v.getUint32(b + 4, true);
      const src = v.getUint32(b + 8, true);
      const name = this.str(v.getUint32(b + 12, true), v.getUint32(b + 16, true));
      const oflags = v.getUint16(b + 24, true);
      const rights = v.getBigUint64(b + 32, true);
      const fdflags = v.getUint16(b + 48, true);
      if (cmd === 0) out.push({ op: 'close', fd });
      else if (cmd === 1) out.push({ op: 'dup2', fd, src });
      else if (cmd === 2) {
        const write = (rights & RIGHT_FD_WRITE) !== 0n, read = (rights & RIGHT_FD_READ) !== 0n;
        let flags = write ? (read ? A.O_RDWR : A.O_WRONLY) : A.O_RDONLY;
        if (oflags & 1) flags |= A.O_CREAT;
        if (oflags & 2) flags |= A.O_DIRECTORY;
        if (oflags & 4) flags |= A.O_EXCL;
        if (oflags & 8) flags |= A.O_TRUNC;
        if (fdflags & 1) flags |= A.O_APPEND;
        out.push({ op: 'open', fd, path: name, flags, mode: 0o666 });
      } else if (cmd === 3) out.push({ op: 'chdir', path: name });
      else if (cmd === 4) out.push({ op: 'fchdir', src });
    }
    return out;
  }

  private *spawnReturn(pid: number, ret: number): Sys {
    if (pid < 0) return wasiErrno(pid);
    this.view().setUint32(ret, pid, true);
    return 0;
  }

  private *proc_spawn2(n: number, nl: number, a: number, al: number, e: number, el: number,
    ops: number, opsLen: number, _sig: number, _sigLen: number, search: number, p: number, pl: number, ret: number): Sys {
    const pid = yield* this.spawn({
      name: this.str(n, nl), argv: splitList(this.str(a, al)),
      env: e ? envList(splitList(this.str(e, el))) : null,
      actions: ops ? this.fdOps(ops, opsLen) : [], searchPath: !!search, path: p ? this.str(p, pl) : undefined,
    });
    return yield* this.spawnReturn(pid, ret);
  }

  private *proc_spawn3(n: number, nl: number, a: number, al: number, e: number, el: number,
    ops: number, opsLen: number, _sig: number, _sigLen: number, search: number, p: number, pl: number, ret: number): Sys {
    const strings = (ptr: number, count: number) => {
      const v = this.view();
      const out: string[] = [];
      for (let i = 0; i < count; i++) out.push(this.cstr(v.getUint32(ptr + i * 4, true)));
      return out;
    };
    const pid = yield* this.spawn({
      name: this.str(n, nl), argv: strings(a, al), env: e ? envList(strings(e, el)) : null,
      actions: ops ? this.fdOps(ops, opsLen) : [], searchPath: !!search, path: p ? this.str(p, pl) : undefined,
    });
    return yield* this.spawnReturn(pid, ret);
  }

  /** exec emulated as spawn + wait + exit with the child's status. */
  private *exec(name: string, argv: string[], env: Record<string, string> | null, searchPath: boolean, path?: string): Sys {
    const pid = yield* this.spawn({ name, argv, env, searchPath, path });
    if (pid < 0) return wasiErrno(pid);
    const r = yield* this.sys(A.SYS_wait4, [pid, 0], undefined, 4);
    const status = r.ret > 0 ? new DataView(r.data.buffer, r.data.byteOffset, 4).getInt32(0, true) : 0;
    if (A.WIFSIGNALED(status)) return yield* this.exitBySignal(A.WTERMSIG(status));
    return yield* this.exit(A.WEXITSTATUS(status));
  }

  private *proc_join(pidPtr: number, flags: number, statusPtr: number): Sys {
    const v = this.view();
    const pid = v.getUint8(pidPtr) === 1 ? v.getUint32(pidPtr + 4, true) : -1;
    v.setUint8(pidPtr, 0); v.setUint32(pidPtr + 4, 0, true);
    v.setUint8(statusPtr, 0); v.setUint16(statusPtr + 2, 0, true);
    const r = yield* this.sys(A.SYS_wait4, [pid, flags & 1 ? A.WNOHANG : 0], undefined, 4);
    if (r.ret < 0) return r.ret === -A.ECHILD ? WASI_ECHILD : wasiErrno(r.ret);
    if (r.ret === 0) return 0; // WNOHANG with nothing to report: tag Nothing
    const status = new DataView(r.data.buffer, r.data.byteOffset, 4).getInt32(0, true);
    const w = this.view();
    // OptionPid {tag u8, pid u32 @4}; JoinStatus {tag u8, union @2: exit code u16 | {code u16, signal u8}}
    w.setUint8(pidPtr, 1); w.setUint32(pidPtr + 4, r.ret, true);
    if (A.WIFEXITED(status)) { w.setUint8(statusPtr, 1); w.setUint16(statusPtr + 2, A.WEXITSTATUS(status), true); }
    else { w.setUint8(statusPtr, 2); w.setUint16(statusPtr + 2, 0, true); w.setUint8(statusPtr + 4, A.WTERMSIG(status)); }
    return 0;
  }

  // ── futexes ───────────────────────────────────────────────────────

  private *futex_wait(ptr: number, expected: number, timeoutPtr: number, retPtr: number): Sys {
    const v = this.view();
    let ms = Infinity;
    if (timeoutPtr && v.getUint8(timeoutPtr) === 1) ms = Number(v.getBigUint64(timeoutPtr + 8, true)) / 1e6;
    let woken = false;
    if (this.memory.buffer instanceof SharedArrayBuffer && canAtomicsWait()) {
      woken = Atomics.wait(new Int32Array(this.memory.buffer), ptr >> 2, expected | 0, ms) === 'ok';
    } else if (v.getInt32(ptr, true) === (expected | 0) && Number.isFinite(ms)) {
      // Single-threaded instance: nobody else can change the word, just sleep
      yield* this.call(A.SYS_nanosleep, Math.floor(ms / 1000), Math.floor((ms % 1000) * 1e6));
    }
    this.view().setUint8(retPtr, woken ? 1 : 0);
    return 0;
  }

  private futexWake(ptr: number, count: number, retPtr: number): number {
    let n = 0;
    if (this.memory.buffer instanceof SharedArrayBuffer) n = Atomics.notify(new Int32Array(this.memory.buffer), ptr >> 2, count);
    this.view().setUint8(retPtr, n > 0 ? 1 : 0);
    return 0;
  }
}

type SpawnAction =
  | { op: 'close'; fd: number }
  | { op: 'dup2'; fd: number; src: number }
  | { op: 'open'; fd: number; path: string; flags: number; mode: number }
  | { op: 'chdir'; path: string }
  | { op: 'fchdir'; src: number };

function now(clockId: number): bigint {
  if (clockId === 0) {
    const ms = performance.timeOrigin + performance.now();
    return BigInt(Math.floor(ms)) * 1_000_000n + BigInt(Math.floor((ms % 1) * 1e6));
  }
  return BigInt(Math.floor(performance.now() * 1e6));
}

function canAtomicsWait(): boolean {
  // Atomics.wait throws on the browser main thread
  return typeof (globalThis as any).document === 'undefined';
}

/** WASIX legacy lists: entries separated by line feeds. */
function splitList(s: string): string[] {
  const parts = s.split('\n');
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function envList(items: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const it of items) {
    const i = it.indexOf('=');
    if (i > 0) env[it.slice(0, i)] = it.slice(i + 1);
  }
  return env;
}

// ── Drivers: run the generators over a transport ─────────────────────

export function runSync<T>(gen: Sys<T>, call: SyncCall): T {
  let r = gen.next();
  while (!r.done) r = gen.next(call(r.value));
  return r.value;
}

/** The result directly when the generator never yields, else a promise. */
export function runMaybeAsync<T>(gen: Sys<T>, call: AsyncCall): T | Promise<T> {
  let r = gen.next();
  if (r.done) return r.value;
  return (async () => {
    while (!r.done) r = gen.next(await call(r.value));
    return r.value;
  })();
}

const isGen = (x: any): x is Sys<any> => x && typeof x.next === 'function' && typeof x.throw === 'function';

/**
 * Build the import object for `module`. In 'sync' mode imports block on
 * `call`; in 'jspi' mode they are WebAssembly.Suspending functions.
 * `extra` supplies non-WASI imports (env.memory for threaded modules).
 */
export function buildImports(
  guest: WasiGuest, module: WebAssembly.Module, mode: 'sync' | 'jspi',
  call: SyncCall | AsyncCall, extra: Record<string, Record<string, any>> = {},
): WebAssembly.Imports {
  const impls = guest.functions();
  const imports: Record<string, Record<string, any>> = {};
  const W = WebAssembly as any;
  for (const imp of WebAssembly.Module.imports(module)) {
    const ns = (imports[imp.module] ??= {});
    if (extra[imp.module]?.[imp.name] !== undefined) { ns[imp.name] = extra[imp.module][imp.name]; continue; }
    if (imp.kind !== 'function') continue;
    // Early WASIX builds (dash) import the preview1 calls under wasix_32v1
    const impl = impls[imp.module]?.[imp.name] ??
      (imp.module === 'wasix_32v1' ? impls.wasi_snapshot_preview1?.[imp.name] : undefined);
    if (!impl) {
      if (/^wasi|^wasix/.test(imp.module)) ns[imp.name] = () => WASI_ENOSYS;
      else ns[imp.name] = () => { throw new Error(`unresolved import ${imp.module}.${imp.name}`); };
      continue;
    }
    if (mode === 'sync') {
      ns[imp.name] = (...a: any[]) => {
        const out = impl(...a);
        return isGen(out) ? runSync(out, call as SyncCall) : out;
      };
    } else {
      ns[imp.name] = new W.Suspending((...a: any[]) => {
        const out = impl(...a);
        return isGen(out) ? runMaybeAsync(out, call as AsyncCall) : out;
      });
    }
  }
  return imports;
}

