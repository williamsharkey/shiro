/**
 * The syscall channel between a guest Worker and the kernel.
 *
 * One SharedArrayBuffer per guest (layout in abi.ts / KERNEL_ABI.md). The
 * guest writes the syscall number, args and data, sets state=1, notifies the
 * kernel and blocks in Atomics.wait. The kernel runs the syscall, writes the
 * result, sets state=2 and Atomics.notify()s. A blocking read just doesn't
 * reply until data exists.
 *
 * - GuestChannel / GuestSys: worker side (import only this file and abi.ts
 *   in guest bundles; no kernel code).
 * - KernelChannel: kernel side; serves requests through Kernel.syscall.
 * - jspiSyscall: the no-SAB path for WASM guests on the main thread.
 */

import * as A from './abi';
import type { Kernel } from './kernel';
import type { Process } from './process';

/** How a guest can block on a syscall here. */
export function canBlock(): 'sab' | 'jspi' | 'none' {
  const g = globalThis as any;
  const sab = typeof SharedArrayBuffer !== 'undefined' && typeof Atomics !== 'undefined' && typeof Atomics.wait === 'function';
  // Browsers only expose a usable SAB to cross-origin isolated pages; Node has no such flag.
  if (sab && g.crossOriginIsolated !== false) return 'sab';
  if (typeof WebAssembly !== 'undefined' && typeof (WebAssembly as any).Suspending === 'function') return 'jspi';
  return 'none';
}

export function createChannelBuffer(dataSize = A.CH_DEFAULT_DATA_SIZE): SharedArrayBuffer {
  return new SharedArrayBuffer(A.CH_DATA + dataSize);
}

/** The message a guest posts to tell the kernel a request is waiting. */
export const SYS_MESSAGE = 'sys';

// ── Guest side ──────────────────────────────────────────────────────────────

export class GuestChannel {
  readonly i32: Int32Array;
  readonly data: Uint8Array;
  /**
   * Runs the guest's handler for a signal the kernel flagged in the signal
   * word (checked after every reply). The kernel blocked the handler's mask
   * when it flagged the signal; `call` sends rt_sigreturn after this returns
   * (also when no onSignal is set) so the mask is restored.
   */
  onSignal?: (sig: number) => void;

  /** `notify` tells the kernel a request is posted: postMessage('sys') to the page, or nothing when the kernel waits on the SAB itself. */
  constructor(readonly sab: SharedArrayBuffer, private notify: () => void) {
    this.i32 = new Int32Array(sab, 0, A.CH_DATA / 4);
    this.data = new Uint8Array(sab, A.CH_DATA);
  }

  /** Raw syscall. Args are int32 slots; the data area must already hold any input. Returns the result or -errno. */
  call(nr: number, ...args: number[]): number {
    const i32 = this.i32;
    if (args.length > A.CH_NARGS) throw new Error(`syscall ${nr}: too many args`);
    i32[A.CH_SYSNO] = nr;
    for (let i = 0; i < A.CH_NARGS; i++) i32[A.CH_ARGS + i] = args[i] ?? 0;
    Atomics.store(i32, A.CH_STATE, A.STATE_REQUEST);
    Atomics.notify(i32, A.CH_STATE);
    this.notify();
    while (Atomics.load(i32, A.CH_STATE) === A.STATE_REQUEST) Atomics.wait(i32, A.CH_STATE, A.STATE_REQUEST);
    const result = i32[A.CH_RESULT];
    Atomics.store(i32, A.CH_STATE, A.STATE_IDLE);
    const hi = i32[A.CH_ARGS];
    const sig = Atomics.exchange(i32, A.CH_SIGNAL, 0);
    if (sig) {
      try { this.onSignal?.(sig); }
      finally {
        this.call(A.SYS_rt_sigreturn);
        i32[A.CH_ARGS] = hi; // keep result64() valid across the handler's syscalls
      }
    }
    return result;
  }

  /** 64-bit result of the last call (lseek): low word is the return value, high word is in args[0]. */
  result64(lo: number): number {
    return lo < 0 && lo > -4096 ? lo : (this.i32[A.CH_ARGS] | 0) * 0x100000000 + (lo >>> 0);
  }
}

const enc = new TextEncoder();
const decode = A.decodeText;

/** Thrown by GuestSys helpers on -errno results. */
export class SysError extends Error {
  constructor(readonly errno: number, op: string) {
    super(`${op}: errno ${errno}`);
  }
}

/**
 * Typed wrappers over GuestChannel for JS guests. Raw methods return
 * -errno like the syscalls; transfers larger than the data area are split
 * here (writes loop; reads return a short count, as POSIX allows).
 */
export class GuestSys {
  constructor(readonly ch: GuestChannel) {}

  private putStr(s: string, off = 0): number {
    const b = enc.encode(s);
    if (off + b.length > this.ch.data.length) return -A.ENAMETOOLONG;
    this.ch.data.set(b, off);
    return b.length;
  }

  read(fd: number, buf: Uint8Array): number {
    const n = Math.min(buf.length, this.ch.data.length);
    const r = this.ch.call(A.SYS_read, fd, n);
    if (r > 0) buf.set(this.ch.data.subarray(0, r));
    return r;
  }

  /** Writes everything (looping over chunks and short writes); returns bytes written or -errno. */
  write(fd: number, data: Uint8Array | string): number {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    let off = 0;
    while (off < bytes.length) {
      const n = Math.min(bytes.length - off, this.ch.data.length);
      this.ch.data.set(bytes.subarray(off, off + n));
      const r = this.ch.call(A.SYS_write, fd, n);
      if (r < 0) return off > 0 ? off : r;
      if (r === 0) break;
      off += r;
    }
    return off;
  }

  /** Read until EOF. */
  readAll(fd: number): Uint8Array | number {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const buf = new Uint8Array(Math.min(65536, this.ch.data.length));
    for (;;) {
      const n = this.read(fd, buf);
      if (n < 0) return n;
      if (n === 0) break;
      chunks.push(buf.slice(0, n));
      total += n;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  open(path: string, flags = A.O_RDONLY, mode = 0o666): number {
    const len = this.putStr(path);
    return len < 0 ? len : this.ch.call(A.SYS_openat, A.AT_FDCWD, len, flags, mode);
  }

  close(fd: number): number { return this.ch.call(A.SYS_close, fd); }

  /** [readFd, writeFd] or -errno. */
  pipe(flags = 0): [number, number] | number {
    const r = this.ch.call(A.SYS_pipe2, flags);
    if (r < 0) return r;
    const dv = new DataView(this.ch.sab, A.CH_DATA, 8);
    return [dv.getInt32(0, true), dv.getInt32(4, true)];
  }

  dup(fd: number): number { return this.ch.call(A.SYS_dup, fd); }
  dup2(a: number, b: number): number { return this.ch.call(A.SYS_dup2, a, b); }
  fcntl(fd: number, cmd: number, arg = 0): number { return this.ch.call(A.SYS_fcntl, fd, cmd, arg); }

  lseek(fd: number, off: number, whence: number): number {
    const lo = this.ch.call(A.SYS_lseek, fd, off >>> 0, Math.floor(off / 0x100000000), whence);
    return this.ch.result64(lo);
  }

  fstat(fd: number): A.KStat | number {
    const r = this.ch.call(A.SYS_fstat, fd);
    return r < 0 ? r : A.decodeStat(this.ch.data);
  }

  stat(path: string): A.KStat | number {
    const len = this.putStr(path);
    if (len < 0) return len;
    const r = this.ch.call(A.SYS_stat, len);
    return r < 0 ? r : A.decodeStat(this.ch.data);
  }

  getpid(): number { return this.ch.call(A.SYS_getpid); }
  getppid(): number { return this.ch.call(A.SYS_getppid); }
  getpgrp(): number { return this.ch.call(A.SYS_getpgrp); }
  setpgid(pid: number, pgid: number): number { return this.ch.call(A.SYS_setpgid, pid, pgid); }
  setsid(): number { return this.ch.call(A.SYS_setsid); }
  kill(pid: number, sig: number): number { return this.ch.call(A.SYS_kill, pid, sig); }

  getcwd(): string | number {
    const r = this.ch.call(A.SYS_getcwd, this.ch.data.length);
    return r < 0 ? r : decode(this.ch.data.subarray(0, r - 1));
  }

  chdir(path: string): number {
    const len = this.putStr(path);
    return len < 0 ? len : this.ch.call(A.SYS_chdir, len);
  }

  /**
   * posix_spawn. Without `fds` the child inherits every non-cloexec fd; `fds`
   * maps child fd → parent fd (only those, unless `inherit`). Returns the pid or -errno.
   */
  spawn(path: string, argv: string[] = [path], opts: { env?: Record<string, string>; cwd?: string; fds?: [number, number][]; inherit?: boolean; pgid?: number; setsid?: boolean; sigdefault?: number[] } = {}): number {
    const len = this.putStr(JSON.stringify({ path, argv, ...opts }));
    return len < 0 ? -A.E2BIG : this.ch.call(A.SYS_spawn, len);
  }

  /** { pid, status } (pid < 0 = -errno, 0 = WNOHANG and nothing to report). */
  waitpid(pid: number, options = 0): { pid: number; status: number } {
    const r = this.ch.call(A.SYS_wait4, pid, options);
    const status = r > 0 ? new DataView(this.ch.sab, A.CH_DATA, 4).getInt32(0, true) : 0;
    return { pid: r, status };
  }

  sleep(ms: number): number {
    return this.ch.call(A.SYS_nanosleep, Math.floor(ms / 1000), (ms % 1000) * 1e6);
  }

  poll(fds: { fd: number; events: number }[], timeoutMs: number): { ready: number; revents: number[] } {
    const dv = new DataView(this.ch.sab, A.CH_DATA, Math.max(8, fds.length * 8));
    fds.forEach((p, i) => { dv.setInt32(i * 8, p.fd, true); dv.setInt16(i * 8 + 4, p.events, true); dv.setInt16(i * 8 + 6, 0, true); });
    const ready = this.ch.call(A.SYS_poll, fds.length, timeoutMs);
    return { ready, revents: fds.map((_, i) => dv.getInt16(i * 8 + 6, true)) };
  }

  // ── Files: *at forms and positional I/O ──

  private putTwo(a: string, b: string): [number, number] | number {
    const la = this.putStr(a);
    if (la < 0) return la;
    const lb = this.putStr(b, la);
    return lb < 0 ? lb : [la, lb];
  }

  openat(dirfd: number, path: string, flags = A.O_RDONLY, mode = 0o666): number {
    const len = this.putStr(path);
    return len < 0 ? len : this.ch.call(A.SYS_openat, dirfd, len, flags, mode);
  }

  fstatat(dirfd: number, path: string, flags = 0): A.KStat | number {
    const len = path === '' ? 0 : this.putStr(path);
    if (len < 0) return len;
    const r = this.ch.call(A.SYS_newfstatat, dirfd, len, flags);
    return r < 0 ? r : A.decodeStat(this.ch.data);
  }

  mkdirat(dirfd: number, path: string, mode = 0o777): number {
    const len = this.putStr(path);
    return len < 0 ? len : this.ch.call(A.SYS_mkdirat, dirfd, len, mode);
  }
  mkdir(path: string, mode = 0o777): number { return this.mkdirat(A.AT_FDCWD, path, mode); }

  unlinkat(dirfd: number, path: string, flags = 0): number {
    const len = this.putStr(path);
    return len < 0 ? len : this.ch.call(A.SYS_unlinkat, dirfd, len, flags);
  }
  unlink(path: string): number { return this.unlinkat(A.AT_FDCWD, path); }
  rmdir(path: string): number { return this.unlinkat(A.AT_FDCWD, path, A.AT_REMOVEDIR); }

  renameat(olddirfd: number, from: string, newdirfd: number, to: string, flags = 0): number {
    const l = this.putTwo(from, to);
    return typeof l === 'number' ? l : this.ch.call(A.SYS_renameat2, olddirfd, l[0], newdirfd, l[1], flags);
  }
  rename(from: string, to: string): number { return this.renameat(A.AT_FDCWD, from, A.AT_FDCWD, to); }

  symlinkat(target: string, dirfd: number, path: string): number {
    const l = this.putTwo(target, path);
    return typeof l === 'number' ? l : this.ch.call(A.SYS_symlinkat, l[0], dirfd, l[1]);
  }
  symlink(target: string, path: string): number { return this.symlinkat(target, A.AT_FDCWD, path); }

  linkat(olddirfd: number, from: string, newdirfd: number, to: string, flags = 0): number {
    const l = this.putTwo(from, to);
    return typeof l === 'number' ? l : this.ch.call(A.SYS_linkat, olddirfd, l[0], newdirfd, l[1], flags);
  }

  readlinkat(dirfd: number, path: string): string | number {
    const len = this.putStr(path);
    if (len < 0) return len;
    const r = this.ch.call(A.SYS_readlinkat, dirfd, len, this.ch.data.length);
    return r < 0 ? r : decode(this.ch.data.subarray(0, r));
  }
  readlink(path: string): string | number { return this.readlinkat(A.AT_FDCWD, path); }

  /** utimensat; times in ms (undefined = now). */
  utimensat(dirfd: number, path: string, atimeMs?: number, mtimeMs?: number, flags = 0): number {
    const len = path === '' ? 0 : this.putStr(path);
    if (len < 0) return len;
    const has = atimeMs !== undefined || mtimeMs !== undefined;
    if (has) {
      const dv = new DataView(this.ch.sab, A.CH_DATA + len, 32);
      const put = (o: number, ms?: number) => {
        if (ms === undefined) { dv.setUint32(o, 0, true); dv.setUint32(o + 4, 0, true); dv.setUint32(o + 8, A.UTIME_NOW, true); dv.setUint32(o + 12, 0, true); return; }
        const sec = Math.floor(ms / 1000);
        dv.setUint32(o, sec >>> 0, true);
        dv.setUint32(o + 4, Math.floor(sec / 0x100000000), true);
        dv.setUint32(o + 8, Math.round((ms % 1000) * 1e6), true);
        dv.setUint32(o + 12, 0, true);
      };
      put(0, atimeMs);
      put(16, mtimeMs);
    }
    return this.ch.call(A.SYS_utimensat, dirfd, len, flags, has ? 1 : 0);
  }

  pread(fd: number, buf: Uint8Array, off: number): number {
    const n = Math.min(buf.length, this.ch.data.length);
    const r = this.ch.call(A.SYS_pread64, fd, n, off >>> 0, Math.floor(off / 0x100000000));
    if (r > 0) buf.set(this.ch.data.subarray(0, r));
    return r;
  }

  pwrite(fd: number, data: Uint8Array, off: number): number {
    let done = 0;
    while (done < data.length) {
      const n = Math.min(data.length - done, this.ch.data.length);
      this.ch.data.set(data.subarray(done, done + n));
      const at = off + done;
      const r = this.ch.call(A.SYS_pwrite64, fd, n, at >>> 0, Math.floor(at / 0x100000000));
      if (r < 0) return done > 0 ? done : r;
      if (r === 0) break;
      done += r;
    }
    return done;
  }

  // ── Signals ──

  /**
   * rt_sigaction. `handler` is SIG_DFL, SIG_IGN or any other number the
   * guest uses to find its handler (the kernel only stores it). Returns the
   * previous action or -errno.
   */
  sigaction(sig: number, act?: { handler: number; flags?: number; mask?: number[] }): { handler: number; flags: number; mask: number[] } | number {
    const dv = new DataView(this.ch.sab, A.CH_DATA, A.SIGACTION_SIZE * 2);
    if (act) {
      const [lo, hi] = A.sigsetToWords(act.mask ?? []);
      dv.setUint32(0, act.handler >>> 0, true);
      dv.setUint32(4, Math.floor(act.handler / 0x100000000), true);
      dv.setUint32(8, (act.flags ?? 0) >>> 0, true);
      dv.setUint32(12, 0, true);
      dv.setUint32(16, 0, true);
      dv.setUint32(20, 0, true);
      dv.setUint32(24, lo, true);
      dv.setUint32(28, hi, true);
    }
    const r = this.ch.call(A.SYS_rt_sigaction, sig, act ? 1 : 0, 1);
    if (r < 0) return r;
    const o = A.SIGACTION_SIZE;
    return {
      handler: dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 0x100000000,
      flags: dv.getUint32(o + 8, true),
      mask: [...A.sigsetFromWords(dv.getUint32(o + 24, true), dv.getUint32(o + 28, true))],
    };
  }

  /** rt_sigprocmask; returns the old mask or -errno. */
  sigprocmask(how: number, set?: number[]): number[] | number {
    const dv = new DataView(this.ch.sab, A.CH_DATA, 16);
    if (set) {
      const [lo, hi] = A.sigsetToWords(set);
      dv.setUint32(0, lo, true);
      dv.setUint32(4, hi, true);
    }
    const r = this.ch.call(A.SYS_rt_sigprocmask, how, set ? 1 : 0, 1);
    return r < 0 ? r : [...A.sigsetFromWords(dv.getUint32(8, true), dv.getUint32(12, true))];
  }

  sigpending(): number[] {
    this.ch.call(A.SYS_rt_sigpending);
    const dv = new DataView(this.ch.sab, A.CH_DATA, 8);
    return [...A.sigsetFromWords(dv.getUint32(0, true), dv.getUint32(4, true))];
  }

  /** Wait for a signal with `mask` temporarily installed; always -EINTR. */
  sigsuspend(mask: number[]): number {
    const [lo, hi] = A.sigsetToWords(mask);
    const dv = new DataView(this.ch.sab, A.CH_DATA, 8);
    dv.setUint32(0, lo, true);
    dv.setUint32(4, hi, true);
    return this.ch.call(A.SYS_rt_sigsuspend, 8);
  }

  gettid(): number { return this.ch.call(A.SYS_gettid); }
  tgkill(tgid: number, tid: number, sig: number): number { return this.ch.call(A.SYS_tgkill, tgid, tid, sig); }

  // ── poll layer: select / epoll ──

  /** select(2); sets are fd lists. timeoutMs < 0 waits forever. Returns ready fds per set, or -errno. */
  select(nfds: number, read: number[] = [], write: number[] = [], except: number[] = [], timeoutMs = -1):
    { n: number; read: number[]; write: number[]; except: number[] } | number {
    const setBytes = Math.ceil(nfds / 64) * 8;
    if (setBytes * 3 > this.ch.data.length) return -A.EINVAL;
    const d = this.ch.data;
    d.fill(0, 0, setBytes * 3);
    [read, write, except].forEach((fds, set) => fds.forEach(fd => { d[set * setBytes + (fd >> 3)] |= 1 << (fd & 7); }));
    const present = (read.length ? 1 : 0) | (write.length ? 2 : 0) | (except.length ? 4 : 0);
    const sec = timeoutMs < 0 ? -1 : Math.floor(timeoutMs / 1000);
    const r = this.ch.call(A.SYS_select, nfds, present, sec, timeoutMs < 0 ? 0 : (timeoutMs % 1000) * 1000);
    if (r < 0) return r;
    const out = (set: number) => {
      const fds: number[] = [];
      for (let fd = 0; fd < nfds; fd++) if ((d[set * setBytes + (fd >> 3)] >> (fd & 7)) & 1) fds.push(fd);
      return fds;
    };
    return { n: r, read: present & 1 ? out(0) : [], write: present & 2 ? out(1) : [], except: present & 4 ? out(2) : [] };
  }

  epollCreate(flags = 0): number { return this.ch.call(A.SYS_epoll_create1, flags); }

  /** epoll_ctl; `data` is the 64-bit user data (default: the fd). */
  epollCtl(epfd: number, op: number, fd: number, events = 0, data = fd): number {
    return this.ch.call(A.SYS_epoll_ctl, epfd, op, fd, events | 0, data >>> 0, Math.floor(data / 0x100000000));
  }

  /** epoll_wait; returns the ready events or -errno. */
  epollWait(epfd: number, maxEvents: number, timeoutMs = -1): { events: number; data: number }[] | number {
    const max = Math.min(maxEvents, Math.floor(this.ch.data.length / A.EPOLL_EVENT_SIZE));
    const r = this.ch.call(A.SYS_epoll_wait, epfd, max, timeoutMs);
    if (r < 0) return r;
    const dv = new DataView(this.ch.sab, A.CH_DATA, r * A.EPOLL_EVENT_SIZE);
    return Array.from({ length: r }, (_, i) => ({
      events: dv.getUint32(i * 12, true),
      data: dv.getUint32(i * 12 + 4, true) + dv.getUint32(i * 12 + 8, true) * 0x100000000,
    }));
  }

  // ── Sockets (served by net.ts through the syscall registry) ──
  // Addresses are raw struct sockaddr bytes (sockaddr_in / sockaddr_in6 / sockaddr_un).

  socket(domain: number, type: number, protocol = 0): number { return this.ch.call(A.SYS_socket, domain, type, protocol); }

  socketpair(domain: number, type: number, protocol = 0): [number, number] | number {
    const r = this.ch.call(A.SYS_socketpair, domain, type, protocol);
    if (r < 0) return r;
    const dv = new DataView(this.ch.sab, A.CH_DATA, 8);
    return [dv.getInt32(0, true), dv.getInt32(4, true)];
  }

  connect(fd: number, addr: Uint8Array): number {
    this.ch.data.set(addr);
    return this.ch.call(A.SYS_connect, fd, addr.length);
  }

  bind(fd: number, addr: Uint8Array): number {
    this.ch.data.set(addr);
    return this.ch.call(A.SYS_bind, fd, addr.length);
  }

  listen(fd: number, backlog = 128): number { return this.ch.call(A.SYS_listen, fd, backlog); }

  /** accept4; the peer address comes back as raw sockaddr bytes. */
  accept(fd: number, flags = 0): { fd: number; addr: Uint8Array } | number {
    const r = this.ch.call(A.SYS_accept4, fd, flags);
    return r < 0 ? r : { fd: r, addr: this.ch.data.slice(0, A.SOCKADDR_ROOM) };
  }

  /** send/sendto: loops until everything is sent (stream sockets) or one datagram went out. */
  sendto(fd: number, data: Uint8Array | string, flags = 0, addr?: Uint8Array): number {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    const room = this.ch.data.length - A.SOCKADDR_ROOM;
    if (addr) {
      if (bytes.length > room) return -A.EMSGSIZE;
      this.ch.data.set(bytes);
      this.ch.data.set(addr, bytes.length);
      return this.ch.call(A.SYS_sendto, fd, bytes.length, flags, addr.length);
    }
    let off = 0;
    while (off < bytes.length) {
      const n = Math.min(bytes.length - off, room);
      this.ch.data.set(bytes.subarray(off, off + n));
      const r = this.ch.call(A.SYS_sendto, fd, n, flags, 0);
      if (r < 0) return off > 0 ? off : r;
      if (r === 0) break;
      off += r;
    }
    return off;
  }
  send(fd: number, data: Uint8Array | string, flags = 0): number { return this.sendto(fd, data, flags); }

  /** recvfrom: bytes received into `buf`, and the sender address (SOCKADDR_ROOM bytes after the payload). */
  recvfrom(fd: number, buf: Uint8Array, flags = 0): { n: number; addr: Uint8Array } | number {
    const n = Math.min(buf.length, this.ch.data.length - A.SOCKADDR_ROOM);
    const r = this.ch.call(A.SYS_recvfrom, fd, n, flags);
    if (r < 0) return r;
    buf.set(this.ch.data.subarray(0, r));
    return { n: r, addr: this.ch.data.slice(n, n + A.SOCKADDR_ROOM) };
  }
  recv(fd: number, buf: Uint8Array, flags = 0): number {
    const r = this.recvfrom(fd, buf, flags);
    return typeof r === 'number' ? r : r.n;
  }

  shutdown(fd: number, how: number): number { return this.ch.call(A.SYS_shutdown, fd, how); }
  setsockopt(fd: number, level: number, name: number, value: number): number { return this.ch.call(A.SYS_setsockopt, fd, level, name, value); }
  getsockopt(fd: number, level: number, name: number): number { return this.ch.call(A.SYS_getsockopt, fd, level, name); }

  private sockname(nr: number, fd: number): Uint8Array | number {
    const r = this.ch.call(nr, fd);
    return r < 0 ? r : this.ch.data.slice(0, r);
  }
  getsockname(fd: number): Uint8Array | number { return this.sockname(A.SYS_getsockname, fd); }
  getpeername(fd: number): Uint8Array | number { return this.sockname(A.SYS_getpeername, fd); }

  /** argv/env/cwd/pid of this process. */
  procInfo(): { argv: string[]; env: Record<string, string>; cwd: string; pid: number } {
    const r = this.ch.call(A.SYS_getenv);
    if (r < 0) throw new SysError(r, 'getenv');
    return JSON.parse(decode(this.ch.data.subarray(0, r)));
  }

  /** End only the calling thread (SYS_exit from an attachThread worker; the main thread's exit ends the process). */
  exitThread(code: number): never {
    this.ch.call(A.SYS_exit, code);
    const park = new Int32Array(new SharedArrayBuffer(4));
    for (;;) Atomics.wait(park, 0, 0);
  }

  /** exit_group; does not return. */
  exit(code: number): never {
    this.ch.call(A.SYS_exit_group, code);
    // The kernel terminates the worker; until it does, park here.
    const park = new Int32Array(new SharedArrayBuffer(4));
    for (;;) Atomics.wait(park, 0, 0);
  }
}

/** First message the host posts to a guest worker. */
export interface GuestStartMessage {
  type: 'shiro-start';
  sab: SharedArrayBuffer;
  pid: number;
  /** Set for an extra thread (worker-host attachThread). */
  tid?: number;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
}

export function isStartMessage(m: unknown): m is GuestStartMessage {
  return !!m && (m as GuestStartMessage).type === 'shiro-start' && (m as GuestStartMessage).sab instanceof SharedArrayBuffer;
}

/**
 * Guest entry helper: GuestSys for a start message. `post` is the worker's
 * postMessage (self.postMessage, or parentPort.postMessage in Node).
 */
export function connectGuest(start: GuestStartMessage, post: (m: unknown) => void): GuestSys {
  return new GuestSys(new GuestChannel(start.sab, () => post(SYS_MESSAGE)));
}

// ── Kernel side ─────────────────────────────────────────────────────────────

/**
 * Serves one guest's channel. Call `handle()` whenever the guest posts
 * SYS_MESSAGE (worker-host does this); `watch()` instead polls the state word
 * with Atomics.waitAsync, for guests that only Atomics.notify.
 */
export class KernelChannel {
  readonly i32: Int32Array;
  readonly data: Uint8Array;
  private busy = false;
  private stopped = false;

  /** Thread id served by this channel (the pid for the main thread). */
  readonly tid: number;
  private unlisten: () => void;

  /**
   * One channel per guest thread. Extra threads of a process pass `tid` and
   * `onThreadExit` (worker-host attachThread does): their SYS_exit ends only
   * that thread, and gettid returns their tid.
   */
  constructor(readonly sab: SharedArrayBuffer, readonly kernel: Kernel, readonly proc: Process,
    private opts: { tid?: number; onThreadExit?: (code: number) => void } = {}) {
    this.i32 = new Int32Array(sab, 0, A.CH_DATA / 4);
    this.data = new Uint8Array(sab, A.CH_DATA);
    this.tid = opts.tid ?? proc.pid;
    this.unlisten = proc.addSignalListener(() => this.flagSignals());
  }

  get isThread(): boolean { return this.tid !== this.proc.pid; }

  /** Move the next deliverable guest signal (kernel.takeSignal) into this channel's signal word if it is free. */
  flagSignals(): void {
    if (this.stopped || Atomics.load(this.i32, A.CH_SIGNAL) !== 0) return;
    const sig = this.kernel.takeSignal(this.proc);
    if (sig) Atomics.store(this.i32, A.CH_SIGNAL, sig);
  }

  private reply(result: number): void {
    if (result > 0x7fffffff || result < -0x80000000) {
      this.i32[A.CH_ARGS] = Math.floor(result / 0x100000000);
      result = result >>> 0;
    } else {
      this.i32[A.CH_ARGS] = result < 0 ? -1 : 0;
    }
    this.i32[A.CH_RESULT] = result | 0;
    this.flagSignals();
    Atomics.store(this.i32, A.CH_STATE, A.STATE_REPLY);
    Atomics.notify(this.i32, A.CH_STATE);
  }

  async handle(): Promise<void> {
    if (this.busy || this.stopped) return;
    if (Atomics.load(this.i32, A.CH_STATE) !== A.STATE_REQUEST) return;
    this.busy = true;
    try {
      const nr = this.i32[A.CH_SYSNO];
      const args = Array.from(this.i32.subarray(A.CH_ARGS, A.CH_ARGS + A.CH_NARGS));
      if (nr === A.SYS_gettid) { this.reply(this.tid); return; }
      if (nr === A.SYS_exit && this.isThread) {
        this.stop();
        this.opts.onThreadExit?.(args[0]);
        return;
      }
      const result = await this.kernel.syscall(this.proc, nr, args, this.data);
      if (this.stopped || this.proc.exiting) return;
      this.reply(result);
    } finally {
      this.busy = false;
    }
  }

  /** Serve requests by waiting on the state word (no postMessage needed). Needs Atomics.waitAsync. */
  async watch(): Promise<void> {
    const waitAsync = (Atomics as any).waitAsync as ((a: Int32Array, i: number, v: number) => { async: boolean; value: any }) | undefined;
    if (!waitAsync) throw new Error('Atomics.waitAsync unavailable');
    while (!this.stopped && !this.proc.exiting) {
      const state = Atomics.load(this.i32, A.CH_STATE);
      if (state === A.STATE_REQUEST) { await this.handle(); continue; }
      const w = waitAsync(this.i32, A.CH_STATE, state);
      if (w.async) await w.value;
    }
  }

  stop(): void {
    this.stopped = true;
    this.unlisten();
  }
}

// ── JSPI fallback (no SharedArrayBuffer) ────────────────────────────────────

/**
 * An async syscall function over a guest's own memory, for WASM guests on
 * the main thread. Same ABI as the SAB channel, with the data area at
 * `memory.buffer[dataPtr .. dataPtr + dataLen)`. Wrap it in
 * `new WebAssembly.Suspending(fn)` and the guest calls it as a blocking import:
 *
 *   sys(nr, dataPtr, dataLen, a0, a1, a2, a3, a4, a5) -> result
 */
export function jspiSyscall(kernel: Kernel, proc: Process, memory: { buffer: ArrayBufferLike }) {
  return async (nr: number, dataPtr: number, dataLen: number, ...args: number[]): Promise<number> => {
    const data = new Uint8Array(memory.buffer, dataPtr, dataLen);
    const r = await kernel.syscall(proc, nr, args, data);
    return r > 0x7fffffff ? -A.EFBIG : r;
  };
}

/** `jspiSyscall` wrapped for a WASM import, or null when JSPI is unavailable. */
export function jspiImport(kernel: Kernel, proc: Process, memory: { buffer: ArrayBufferLike }): unknown {
  const Suspending = (WebAssembly as any).Suspending;
  return typeof Suspending === 'function' ? new Suspending(jspiSyscall(kernel, proc, memory)) : null;
}
