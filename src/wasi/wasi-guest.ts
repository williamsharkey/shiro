/**
 * wasi-guest.ts — WASI preview1 for a WASM process, on top of kernel syscalls.
 *
 * Every import that touches I/O is a generator that yields kernel syscall
 * requests (./abi.ts) and gets replies back. The same code then runs two ways:
 *   - 'sync': in a Worker, each request is a blocking round trip over the
 *     SharedArrayBuffer channel (Atomics.wait), so fd_read on an empty pipe
 *     or a terminal simply blocks until data arrives.
 *   - 'jspi': on the main thread, imports are WebAssembly.Suspending and each
 *     request awaits the kernel directly.
 * Nothing is preloaded: files are opened, read and written through the
 * kernel when the program asks.
 *
 * Also implemented: `wasi.thread-spawn` (wasi-threads) and the process/pipe/
 * futex subset of WASIX `wasix_32v1` (proc_spawn2/3, proc_exec/2/3,
 * proc_join, proc_id, proc_parent, fd_pipe, fd_dup, getcwd, chdir,
 * futex_wait/wake/wake_all, thread_sleep, thread_id). Any other
 * import from a wasi or wasix module resolves to a stub returning ENOSYS, so binaries
 * that import more than they use still instantiate.
 */

import {
  AT_FDCWD, AT_REMOVEDIR, AT_SYMLINK_NOFOLLOW, F_GETFL, F_SETFL, FT_CHAR, FT_DIR,
  O_APPEND, O_CREAT, O_DIRECTORY, O_EXCL, O_NONBLOCK, O_RDONLY, O_RDWR, O_TRUNC, O_WRONLY,
  POLLERR, POLLHUP, POLLIN, POLLNVAL, POLLOUT, SIGABRT, STAT_SIZE, SpawnFileAction, SpawnRequest,
  SysReply, SysRequest, wasiErrno,
  SYS_chdir, SYS_close, SYS_dup, SYS_dup2, SYS_exit_group, SYS_fcntl, SYS_fstat, SYS_fsync,
  SYS_ftruncate, SYS_getcwd, SYS_getdents64, SYS_getpid, SYS_getppid, SYS_kill, SYS_linkat,
  SYS_lseek, SYS_mkdirat, SYS_newfstatat, SYS_openat, SYS_pipe2, SYS_ppoll, SYS_pread64,
  SYS_pwrite64, SYS_read, SYS_readlinkat, SYS_renameat, SYS_spawn, SYS_symlinkat,
  SYS_thread_spawn, SYS_unlinkat, SYS_wait4, SYS_write,
} from './abi';

// WASI errno values used directly
const E_SUCCESS = 0, E_BADF = 8, E_CHILD = 12, E_FAULT = 21, E_INVAL = 28, E_NOSYS = 52,
  E_NOTSUP = 58, E_OVERFLOW = 61;

const RIGHT_FD_SEEK = 1n << 2n, RIGHT_FD_TELL = 1n << 5n, RIGHT_FD_WRITE = 1n << 6n,
  RIGHT_FD_READ = 1n << 1n;
const ALL_RIGHTS = (1n << 30n) - 1n;

type Sys<T = number> = Generator<SysRequest, T, SysReply>;

/** Thrown to unwind the WASM stack once the kernel has ended the process. */
export class ProcExit extends Error {
  constructor(readonly status: number) { super(`exit status ${status}`); this.name = 'ProcExit'; }
}

export interface Preopen { fd: number; name: string }

export interface GuestOptions {
  args: string[];
  env: Record<string, string>;
  preopens: Preopen[];
  /** Max bytes per request/reply (the channel data area). */
  dataSize: number;
  /** wasi-threads id of this instance (0 for the main thread). */
  tid?: number;
}

export type SyncCall = (req: SysRequest) => SysReply;
export type AsyncCall = (req: SysRequest) => Promise<SysReply>;

const enc = new TextEncoder();
const dec = new TextDecoder();

export class WasiGuest {
  memory!: WebAssembly.Memory;
  readonly preopens = new Map<number, string>();
  private dirCache = new Map<number, Array<{ name: string; filetype: number }>>();
  private argBytes: Uint8Array[];
  private envBytes: Uint8Array[];

  constructor(readonly opts: GuestOptions) {
    for (const p of opts.preopens) this.preopens.set(p.fd, p.name);
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

  private *sys(nr: number, args: number[] = [], data?: Uint8Array): Sys<SysReply> {
    return yield { nr, args, data };
  }
  private *writeAll(fd: number, data: Uint8Array): Sys<number> {
    let done = 0;
    const max = this.opts.dataSize;
    while (done < data.length) {
      const r = yield* this.sys(SYS_write, [fd], data.subarray(done, Math.min(data.length, done + max)));
      if (r.ret < 0) return done || r.ret;
      if (r.ret === 0) break;
      done += r.ret;
    }
    return done;
  }

  // ── import table ──────────────────────────────────────────────────

  /** Import implementations: name → function returning a value or a Sys generator. */
  functions(): Record<string, Record<string, (...a: any[]) => any>> {
    const self = this;
    const g = <A extends any[]>(fn: (...a: A) => Sys<number>) => fn.bind(self) as (...a: A) => Sys<number>;
    return {
      wasi_snapshot_preview1: {
        args_sizes_get: (argc: number, size: number) => this.sizes(this.argBytes, argc, size),
        args_get: (argv: number, buf: number) => this.fill(this.argBytes, argv, buf),
        environ_sizes_get: (cnt: number, size: number) => this.sizes(this.envBytes, cnt, size),
        environ_get: (envp: number, buf: number) => this.fill(this.envBytes, envp, buf),
        clock_res_get: (_id: number, ptr: number) => { this.view().setBigUint64(ptr, 1000n, true); return 0; },
        clock_time_get: (id: number, _prec: bigint, ptr: number) => {
          this.view().setBigUint64(ptr, now(id), true);
          return 0;
        },
        random_get: (ptr: number, len: number) => {
          const tmp = new Uint8Array(len);
          for (let i = 0; i < len; i += 65536) crypto.getRandomValues(tmp.subarray(i, Math.min(len, i + 65536)));
          this.u8().set(tmp, ptr);
          return 0;
        },
        sched_yield: () => 0,
        fd_prestat_get: (fd: number, ptr: number) => {
          const name = this.preopens.get(fd);
          if (name === undefined) return E_BADF;
          const v = this.view();
          v.setUint8(ptr, 0);
          v.setUint32(ptr + 4, enc.encode(name).length, true);
          return 0;
        },
        fd_prestat_dir_name: (fd: number, ptr: number, len: number) => {
          const name = this.preopens.get(fd);
          if (name === undefined) return E_BADF;
          this.u8().set(enc.encode(name).subarray(0, len), ptr);
          return 0;
        },
        fd_fdstat_set_rights: () => 0,
        fd_advise: () => 0,
        fd_filestat_set_times: () => 0,
        path_filestat_set_times: () => 0,
        sock_accept: () => E_NOTSUP,
        sock_recv: () => E_NOTSUP,
        sock_send: () => E_NOTSUP,
        sock_shutdown: () => E_NOTSUP,
        fd_write: g(this.fd_write),
        fd_read: g(this.fd_read),
        fd_pwrite: g(this.fd_pwrite),
        fd_pread: g(this.fd_pread),
        fd_seek: g(this.fd_seek),
        fd_tell: g(function* (this: WasiGuest, fd: number, ptr: number) { return yield* this.fd_seek(fd, 0n, 1, ptr); }),
        fd_close: g(this.fd_close),
        fd_fdstat_get: g(this.fd_fdstat_get),
        fd_fdstat_set_flags: g(this.fd_fdstat_set_flags),
        fd_filestat_get: g(this.fd_filestat_get),
        fd_filestat_set_size: g(function* (this: WasiGuest, fd: number, size: bigint) {
          const r = yield* this.sys(SYS_ftruncate, [fd, Number(size & 0xffffffffn), Number(size >> 32n)]);
          return wasiErrno(r.ret);
        }),
        fd_allocate: () => 0,
        fd_sync: g(this.fd_sync),
        fd_datasync: g(this.fd_sync),
        fd_readdir: g(this.fd_readdir),
        fd_renumber: g(this.fd_renumber),
        path_open: g(this.path_open),
        path_create_directory: g(function* (this: WasiGuest, fd: number, p: number, l: number) {
          return wasiErrno((yield* this.sys(SYS_mkdirat, [fd, 0o777], this.bytes(p, l))).ret);
        }),
        path_filestat_get: g(function* (this: WasiGuest, fd: number, flags: number, p: number, l: number, buf: number) {
          const r = yield* this.sys(SYS_newfstatat, [fd, flags & 1 ? 0 : AT_SYMLINK_NOFOLLOW], this.bytes(p, l));
          if (r.ret < 0) return wasiErrno(r.ret);
          this.u8().set(r.out!.subarray(0, STAT_SIZE), buf);
          return 0;
        }),
        path_link: g(function* (this: WasiGuest) { return wasiErrno((yield* this.sys(SYS_linkat)).ret); }),
        path_readlink: g(function* (this: WasiGuest, fd: number, p: number, l: number, buf: number, bufLen: number, used: number) {
          const r = yield* this.sys(SYS_readlinkat, [fd], this.bytes(p, l));
          if (r.ret < 0) return wasiErrno(r.ret);
          const out = r.out ?? new Uint8Array(0);
          const n = Math.min(out.length, bufLen);
          this.u8().set(out.subarray(0, n), buf);
          this.view().setUint32(used, n, true);
          return 0;
        }),
        path_remove_directory: g(function* (this: WasiGuest, fd: number, p: number, l: number) {
          return wasiErrno((yield* this.sys(SYS_unlinkat, [fd, AT_REMOVEDIR], this.bytes(p, l))).ret);
        }),
        path_unlink_file: g(function* (this: WasiGuest, fd: number, p: number, l: number) {
          return wasiErrno((yield* this.sys(SYS_unlinkat, [fd, 0], this.bytes(p, l))).ret);
        }),
        path_rename: g(function* (this: WasiGuest, fd: number, op: number, ol: number, nfd: number, np: number, nl: number) {
          const data = enc.encode(this.str(op, ol) + '\0' + this.str(np, nl));
          return wasiErrno((yield* this.sys(SYS_renameat, [fd, nfd], data)).ret);
        }),
        path_symlink: g(function* (this: WasiGuest, op: number, ol: number, fd: number, np: number, nl: number) {
          const data = enc.encode(this.str(op, ol) + '\0' + this.str(np, nl));
          return wasiErrno((yield* this.sys(SYS_symlinkat, [fd], data)).ret);
        }),
        poll_oneoff: g(this.poll_oneoff),
        proc_exit: g(function* (this: WasiGuest, code: number) { return yield* this.exit(code); }),
        proc_raise: g(function* (this: WasiGuest, sig: number) {
          const pid = (yield* this.sys(SYS_getpid)).ret;
          return wasiErrno((yield* this.sys(SYS_kill, [pid, sig])).ret);
        }),
      },
      wasi: {
        'thread-spawn': g(function* (this: WasiGuest, arg: number) {
          const r = yield* this.sys(SYS_thread_spawn, [arg]);
          return r.ret < 0 ? -wasiErrno(r.ret) : r.ret;
        }),
      },
      wasix_32v1: {
        fd_pipe: g(function* (this: WasiGuest, rp: number, wp: number) {
          const r = yield* this.sys(SYS_pipe2, [0]);
          if (r.ret < 0) return wasiErrno(r.ret);
          const v = new DataView(r.out!.buffer, r.out!.byteOffset);
          const m = this.view();
          m.setUint32(rp, v.getInt32(0, true), true);
          m.setUint32(wp, v.getInt32(4, true), true);
          return 0;
        }),
        fd_dup: g(function* (this: WasiGuest, fd: number, ret: number) {
          const r = yield* this.sys(SYS_dup, [fd]);
          if (r.ret < 0) return wasiErrno(r.ret);
          this.view().setUint32(ret, r.ret, true);
          return 0;
        }),
        getcwd: g(function* (this: WasiGuest, ptr: number, lenPtr: number) {
          const r = yield* this.sys(SYS_getcwd);
          const cwd = r.out ?? new Uint8Array(0);
          const v = this.view();
          const cap = v.getUint32(lenPtr, true);
          v.setUint32(lenPtr, cwd.length, true);
          if (cwd.length > cap) return E_OVERFLOW;
          this.u8().set(cwd, ptr);
          return 0;
        }),
        chdir: g(function* (this: WasiGuest, p: number, l: number) {
          return wasiErrno((yield* this.sys(SYS_chdir, [], this.bytes(p, l))).ret);
        }),
        proc_id: g(function* (this: WasiGuest, ret: number) {
          this.view().setUint32(ret, (yield* this.sys(SYS_getpid)).ret, true);
          return 0;
        }),
        proc_parent: g(function* (this: WasiGuest, _pid: number, ret: number) {
          this.view().setUint32(ret, (yield* this.sys(SYS_getppid)).ret, true);
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
          yield* this.sys(SYS_ppoll, [0, Math.max(1, Math.ceil(Number(ns) / 1e6))]);
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
    const data = this.gather(this.iovs(iovs, n));
    const done = yield* this.writeAll(fd, data);
    if (done < 0) return wasiErrno(done);
    this.view().setUint32(nwritten, done, true);
    return 0;
  }

  private *fd_read(fd: number, iovsPtr: number, n: number, nread: number): Sys {
    const iovs = this.iovs(iovsPtr, n);
    const total = iovs.reduce((s, [, l]) => s + l, 0);
    // One read: it returns as soon as some data is there (a line from a tty, a pipe chunk)
    const r = yield* this.sys(SYS_read, [fd, Math.min(total, this.opts.dataSize)]);
    if (r.ret < 0) return wasiErrno(r.ret);
    if (r.out) this.scatter(iovs, r.out);
    this.view().setUint32(nread, r.ret, true);
    return 0;
  }

  private *fd_pread(fd: number, iovsPtr: number, n: number, offset: bigint, nread: number): Sys {
    const iovs = this.iovs(iovsPtr, n);
    const total = iovs.reduce((s, [, l]) => s + l, 0);
    const r = yield* this.sys(SYS_pread64, [fd, Math.min(total, this.opts.dataSize), Number(offset & 0xffffffffn), Number(offset >> 32n)]);
    if (r.ret < 0) return wasiErrno(r.ret);
    if (r.out) this.scatter(iovs, r.out);
    this.view().setUint32(nread, r.ret, true);
    return 0;
  }

  private *fd_pwrite(fd: number, iovs: number, n: number, offset: bigint, nwritten: number): Sys {
    const data = this.gather(this.iovs(iovs, n));
    let done = 0;
    while (done < data.length) {
      const off = offset + BigInt(done);
      const chunk = data.subarray(done, Math.min(data.length, done + this.opts.dataSize));
      const r = yield* this.sys(SYS_pwrite64, [fd, Number(off & 0xffffffffn), Number(off >> 32n)], chunk);
      if (r.ret < 0) { if (!done) return wasiErrno(r.ret); break; }
      done += r.ret;
    }
    this.view().setUint32(nwritten, done, true);
    return 0;
  }

  private *fd_seek(fd: number, offset: bigint, whence: number, ptr: number): Sys {
    const off = BigInt.asIntN(64, offset);
    const r = yield* this.sys(SYS_lseek, [fd, Number(BigInt.asUintN(32, off)) | 0, Number(off >> 32n), whence]);
    if (r.ret < 0) return wasiErrno(r.ret);
    this.view().setBigUint64(ptr, BigInt(r.ret), true);
    return 0;
  }

  private *fd_close(fd: number): Sys {
    const r = yield* this.sys(SYS_close, [fd]);
    if (r.ret >= 0) { this.preopens.delete(fd); this.dirCache.delete(fd); }
    return wasiErrno(r.ret);
  }

  private *fd_fdstat_get(fd: number, ptr: number): Sys {
    const st = yield* this.sys(SYS_fstat, [fd]);
    if (st.ret < 0) return wasiErrno(st.ret);
    const fl = yield* this.sys(SYS_fcntl, [fd, F_GETFL, 0]);
    const filetype = st.out![16];
    let flags = 0;
    if (fl.ret >= 0) {
      if (fl.ret & O_APPEND) flags |= 1;
      if (fl.ret & O_NONBLOCK) flags |= 4;
    }
    let rights = ALL_RIGHTS;
    if (filetype === FT_CHAR) rights &= ~(RIGHT_FD_SEEK | RIGHT_FD_TELL);
    if (fl.ret >= 0) {
      const acc = fl.ret & 3;
      if (acc === O_RDONLY) rights &= ~RIGHT_FD_WRITE;
      if (acc === O_WRONLY) rights &= ~RIGHT_FD_READ;
    }
    const v = this.view();
    v.setUint8(ptr, filetype);
    v.setUint16(ptr + 2, flags, true);
    v.setBigUint64(ptr + 8, rights, true);
    v.setBigUint64(ptr + 16, ALL_RIGHTS, true);
    return 0;
  }

  private *fd_fdstat_set_flags(fd: number, flags: number): Sys {
    let fl = 0;
    if (flags & 1) fl |= O_APPEND;
    if (flags & 4) fl |= O_NONBLOCK;
    return wasiErrno((yield* this.sys(SYS_fcntl, [fd, F_SETFL, fl])).ret);
  }

  private *fd_filestat_get(fd: number, ptr: number): Sys {
    const r = yield* this.sys(SYS_fstat, [fd]);
    if (r.ret < 0) return wasiErrno(r.ret);
    this.u8().set(r.out!.subarray(0, STAT_SIZE), ptr);
    return 0;
  }

  private *fd_sync(fd: number): Sys {
    return wasiErrno((yield* this.sys(SYS_fsync, [fd])).ret);
  }

  private *fd_readdir(fd: number, buf: number, bufLen: number, cookie: bigint, used: number): Sys {
    let list = this.dirCache.get(fd);
    if (!list || cookie === 0n) {
      const r = yield* this.sys(SYS_getdents64, [fd]);
      if (r.ret < 0) return wasiErrno(r.ret);
      list = [{ name: '.', filetype: FT_DIR }, { name: '..', filetype: FT_DIR }];
      const out = r.out ?? new Uint8Array(0);
      for (let off = 0; off + 3 <= out.length;) {
        const filetype = out[off];
        const len = out[off + 1] | (out[off + 2] << 8);
        list.push({ name: dec.decode(out.slice(off + 3, off + 3 + len)), filetype });
        off += 3 + len;
      }
      this.dirCache.set(fd, list);
    }
    const m = this.u8();
    const v = this.view();
    let off = 0;
    for (let i = Number(cookie); i < list.length && off < bufLen; i++) {
      const name = enc.encode(list[i].name);
      const ent = new Uint8Array(24 + name.length);
      const ev = new DataView(ent.buffer);
      ev.setBigUint64(0, BigInt(i + 1), true);
      ev.setBigUint64(8, BigInt(i + 1), true);
      ev.setUint32(16, name.length, true);
      ev.setUint8(20, list[i].filetype);
      ent.set(name, 24);
      const k = Math.min(ent.length, bufLen - off);
      m.set(ent.subarray(0, k), buf + off);
      off += k;
    }
    v.setUint32(used, off, true);
    return 0;
  }

  private *fd_renumber(from: number, to: number): Sys {
    const r = yield* this.sys(SYS_dup2, [from, to]);
    if (r.ret < 0) return wasiErrno(r.ret);
    yield* this.sys(SYS_close, [from]);
    const name = this.preopens.get(from);
    this.preopens.delete(to);
    if (name !== undefined) { this.preopens.delete(from); this.preopens.set(to, name); }
    return 0;
  }

  // ── path_open ─────────────────────────────────────────────────────

  private *path_open(dirfd: number, _dirflags: number, p: number, l: number, oflags: number,
    rightsBase: bigint, _rightsInh: bigint, fdflags: number, fdPtr: number): Sys {
    const path = this.bytes(p, l);
    const read = (rightsBase & (RIGHT_FD_READ | (1n << 14n))) !== 0n;
    const write = (rightsBase & RIGHT_FD_WRITE) !== 0n;
    let flags = write ? (read ? O_RDWR : O_WRONLY) : O_RDONLY;
    if (oflags & 1) flags |= O_CREAT;
    if (oflags & 2) flags = (flags & ~3) | O_DIRECTORY;
    if (oflags & 4) flags |= O_EXCL;
    if (oflags & 8) flags |= O_TRUNC;
    if (fdflags & 1) flags |= O_APPEND;
    if (fdflags & 4) flags |= O_NONBLOCK;
    let r = yield* this.sys(SYS_openat, [dirfd, flags, 0o666], path);
    // Programs that ask for every right (read+write) also open directories that way
    if (r.ret === -21 && !(flags & (O_CREAT | O_TRUNC))) {
      r = yield* this.sys(SYS_openat, [dirfd, O_RDONLY | O_DIRECTORY], path);
    }
    if (r.ret < 0) return wasiErrno(r.ret);
    this.view().setUint32(fdPtr, r.ret, true);
    return 0;
  }

  // ── poll_oneoff ───────────────────────────────────────────────────

  private *poll_oneoff(inPtr: number, outPtr: number, nsubs: number, neventsPtr: number): Sys {
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
        let ms = Number(t) / 1e6;
        if (abs) ms = Number(t - now(id)) / 1e6;
        ms = Math.max(0, ms);
        sub.deadline = start + ms;
        timeout = timeout < 0 ? ms : Math.min(timeout, ms);
      } else {
        sub.fd = v.getUint32(b + 16, true);
      }
      subs.push(sub);
    }
    const fdSubs = subs.filter(s => s.tag !== 0);
    const pollData = new Uint8Array(fdSubs.length * 8);
    const pv = new DataView(pollData.buffer);
    fdSubs.forEach((s, i) => {
      pv.setInt32(i * 8, s.fd, true);
      pv.setInt16(i * 8 + 4, s.tag === 1 ? POLLIN : POLLOUT, true);
    });
    const r = yield* this.sys(SYS_ppoll, [fdSubs.length, timeout < 0 ? -1 : Math.ceil(timeout)], pollData);
    const events: Array<{ userdata: bigint; error: number; type: number; nbytes: bigint; flags: number }> = [];
    if (r.ret > 0 && r.out) {
      const ov = new DataView(r.out.buffer, r.out.byteOffset, r.out.byteLength);
      fdSubs.forEach((s, i) => {
        const rev = ov.getInt16(i * 8 + 6, true);
        if (!rev) return;
        const error = rev & POLLNVAL ? E_BADF : 0;
        const hup = (rev & (POLLHUP | POLLERR)) ? 1 : 0;
        events.push({ userdata: s.userdata, error, type: s.tag, nbytes: rev & (POLLIN | POLLOUT) ? 1n : 0n, flags: hup });
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

  *exit(code: number, signal = 0): Sys<never> {
    yield* this.sys(SYS_exit_group, [code, signal]);
    throw new ProcExit(signal ? signal : (code & 0xff) << 8);
  }

  /** Report a trap on stderr and end the process like SIGABRT would. */
  *trap(e: unknown): Sys<never> {
    const msg = e instanceof Error ? e.message : String(e);
    yield* this.writeAll(2, enc.encode(`wasm trap: ${msg}\n`));
    return yield* this.exit(0, SIGABRT);
  }

  // ── WASIX processes ───────────────────────────────────────────────

  private *spawnReq(req: SpawnRequest): Sys {
    return (yield* this.sys(SYS_spawn, [], enc.encode(JSON.stringify(req)))).ret;
  }

  private fdOps(ptr: number, n: number): SpawnFileAction[] {
    const v = this.view();
    const out: SpawnFileAction[] = [];
    for (let i = 0; i < n; i++) {
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
        let flags = write ? (read ? O_RDWR : O_WRONLY) : O_RDONLY;
        if (oflags & 1) flags |= O_CREAT;
        if (oflags & 2) flags |= O_DIRECTORY;
        if (oflags & 4) flags |= O_EXCL;
        if (oflags & 8) flags |= O_TRUNC;
        if (fdflags & 1) flags |= O_APPEND;
        out.push({ op: 'open', fd, path: name, flags, mode: 0o666 });
      } else if (cmd === 3) out.push({ op: 'chdir', path: name });
      else if (cmd === 4) out.push({ op: 'fchdir', src });
    }
    return out;
  }

  private *proc_spawn2(n: number, nl: number, a: number, al: number, e: number, el: number,
    ops: number, opsLen: number, _sig: number, _sigLen: number, search: number, p: number, pl: number, ret: number): Sys {
    const pid = yield* this.spawnReq({
      name: this.str(n, nl), argv: splitList(this.str(a, al)),
      env: e ? envList(splitList(this.str(e, el))) : null,
      fileActions: ops ? this.fdOps(ops, opsLen) : [], searchPath: !!search,
      path: p ? this.str(p, pl) : undefined,
    });
    if (pid < 0) return wasiErrno(pid);
    this.view().setUint32(ret, pid, true);
    return 0;
  }

  private *proc_spawn3(n: number, nl: number, a: number, al: number, e: number, el: number,
    ops: number, opsLen: number, _sig: number, _sigLen: number, search: number, p: number, pl: number, ret: number): Sys {
    const strings = (ptr: number, count: number) => {
      const v = this.view();
      const out: string[] = [];
      for (let i = 0; i < count; i++) out.push(this.cstr(v.getUint32(ptr + i * 4, true)));
      return out;
    };
    const pid = yield* this.spawnReq({
      name: this.str(n, nl), argv: strings(a, al), env: e ? envList(strings(e, el)) : null,
      fileActions: ops ? this.fdOps(ops, opsLen) : [], searchPath: !!search,
      path: p ? this.str(p, pl) : undefined,
    });
    if (pid < 0) return wasiErrno(pid);
    this.view().setUint32(ret, pid, true);
    return 0;
  }

  private *exec(name: string, argv: string[], env: Record<string, string> | null, searchPath: boolean, path?: string): Sys {
    const r = yield* this.spawnReq({ name, argv, env, searchPath, path, exec: true });
    if (r < 0) return wasiErrno(r);
    // The kernel ended this process with the child's status
    throw new ProcExit(0);
  }

  private *proc_join(pidPtr: number, flags: number, statusPtr: number): Sys {
    const v = this.view();
    const pid = v.getUint8(pidPtr) === 1 ? v.getUint32(pidPtr + 4, true) : -1;
    v.setUint8(pidPtr, 0); v.setUint32(pidPtr + 4, 0, true);
    v.setUint8(statusPtr, 0); v.setUint16(statusPtr + 2, 0, true);
    const r = yield* this.sys(SYS_wait4, [pid, flags & 1 ? 1 : 0]);
    if (r.ret < 0) return r.ret === -10 ? E_CHILD : wasiErrno(r.ret);
    if (r.ret === 0) return 0; // WNOHANG and nothing exited: tag Nothing
    const status = new DataView(r.out!.buffer, r.out!.byteOffset).getInt32(0, true);
    const w = this.view();
    w.setUint8(pidPtr, 1); w.setUint32(pidPtr + 4, r.ret, true);
    if ((status & 0x7f) === 0) { w.setUint8(statusPtr, 1); w.setUint16(statusPtr + 2, (status >> 8) & 0xff, true); }
    else { w.setUint8(statusPtr, 2); w.setUint16(statusPtr + 2, 0, true); w.setUint8(statusPtr + 4, status & 0x7f); }
    return 0;
  }

  // ── futexes ───────────────────────────────────────────────────────

  private *futex_wait(ptr: number, expected: number, timeoutPtr: number, retPtr: number): Sys {
    const v = this.view();
    let ms = Infinity;
    if (timeoutPtr && v.getUint8(timeoutPtr) === 1) ms = Number(v.getBigUint64(timeoutPtr + 8, true)) / 1e6;
    let woken = false;
    if (this.memory.buffer instanceof SharedArrayBuffer && canAtomicsWait()) {
      const i32 = new Int32Array(this.memory.buffer);
      woken = Atomics.wait(i32, ptr >> 2, expected | 0, ms) === 'ok';
    } else if (v.getInt32(ptr, true) === (expected | 0) && Number.isFinite(ms)) {
      // Nobody else can change it in a single-threaded instance: just sleep
      yield* this.sys(SYS_ppoll, [0, Math.ceil(ms)]);
    }
    this.view().setUint8(retPtr, woken ? 1 : 0);
    return 0;
  }

  private futexWake(ptr: number, count: number, retPtr: number): number {
    let n = 0;
    if (this.memory.buffer instanceof SharedArrayBuffer) {
      n = Atomics.notify(new Int32Array(this.memory.buffer), ptr >> 2, count);
    }
    this.view().setUint8(retPtr, n > 0 ? 1 : 0);
    return 0;
  }
}

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

function splitList(s: string): string[] {
  return s.split('\n').filter((x, i, all) => x !== '' || i < all.length - 1);
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

/** Result directly when the generator never yields, else a promise. */
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
    const impl = impls[imp.module]?.[imp.name];
    if (!impl) {
      if (/^wasi|^wasix/.test(imp.module)) ns[imp.name] = () => E_NOSYS;
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

export { E_FAULT, E_INVAL, E_SUCCESS, FT_CHAR, AT_FDCWD };
