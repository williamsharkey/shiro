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
import type { OpenFile } from './fd';
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

  /**
   * `notify` tells the kernel a request is posted: postMessage('sys') to the
   * page, or null when the kernel waits on the state word itself
   * (KernelChannel.watch; the start message then says `wake: 'atomics'`).
   */
  constructor(readonly sab: SharedArrayBuffer, private notify: (() => void) | null) {
    this.i32 = new Int32Array(sab, 0, A.CH_DATA / 4);
    this.data = new Uint8Array(sab, A.CH_DATA);
  }

  /**
   * How long a guest spins on the state word before it sleeps in
   * Atomics.wait. Most syscalls are answered within a few µs of the kernel
   * seeing them, and a sleeping guest costs an Atomics.notify on the
   * kernel's side and a thread wake-up on this one (~10–20 µs each).
   */
  static spinMs = 0.1;

  /** Raw syscall. Args are int32 slots; the data area must already hold any input. Returns the result or -errno. */
  call(nr: number, ...args: number[]): number {
    const i32 = this.i32;
    if (args.length > A.CH_NARGS) throw new Error(`syscall ${nr}: too many args`);
    i32[A.CH_SYSNO] = nr;
    for (let i = 0; i < A.CH_NARGS; i++) i32[A.CH_ARGS + i] = args[i] ?? 0;
    if (Atomics.compareExchange(i32, A.CH_STATE, A.STATE_IDLE, A.STATE_REQUEST_SPIN) !== A.STATE_IDLE) throw new ChannelClosed();
    Atomics.notify(i32, A.CH_STATE); // a kernel in watch() waits on this word
    this.notify?.();
    this.awaitReply();
    const result = i32[A.CH_RESULT];
    const hi = i32[A.CH_ARGS];
    if (Atomics.compareExchange(i32, A.CH_STATE, A.STATE_REPLY, A.STATE_IDLE) !== A.STATE_REPLY) throw new ChannelClosed();
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

  /** Spin briefly, then sleep, until the kernel replies (or closes the channel). */
  private awaitReply(): void {
    const i32 = this.i32;
    if (Atomics.load(i32, A.CH_STATE) === A.STATE_REQUEST_SPIN) {
      const end = now() + GuestChannel.spinMs;
      let n = 0;
      while (Atomics.load(i32, A.CH_STATE) === A.STATE_REQUEST_SPIN) {
        if ((++n & 63) === 0 && now() > end) break;
      }
    }
    // Going to sleep: from now on the kernel must notify
    if (Atomics.compareExchange(i32, A.CH_STATE, A.STATE_REQUEST_SPIN, A.STATE_REQUEST) === A.STATE_REQUEST_SPIN) {
      while (Atomics.load(i32, A.CH_STATE) === A.STATE_REQUEST) Atomics.wait(i32, A.CH_STATE, A.STATE_REQUEST);
    }
    if (Atomics.load(i32, A.CH_STATE) === A.STATE_DEAD) throw new ChannelClosed();
  }

  /**
   * Block until the kernel closes the channel, then throw ChannelClosed so
   * the worker unwinds to its event loop: browsers can't terminate a Worker
   * parked in Atomics.wait, so a guest must never park anywhere else.
   */
  park(): never {
    const i32 = this.i32;
    for (;;) {
      const s = Atomics.load(i32, A.CH_STATE);
      if (s === A.STATE_DEAD) throw new ChannelClosed();
      Atomics.wait(i32, A.CH_STATE, s);
    }
  }

  /** 64-bit result of the last call (lseek): low word is the return value, high word is in args[0]. */
  result64(lo: number): number {
    return lo < 0 && lo > -4096 ? lo : (this.i32[A.CH_ARGS] | 0) * 0x100000000 + (lo >>> 0);
  }
}

/**
 * Thrown in a guest when the kernel closed its channel (the process exited
 * or was killed, or the thread ended): the guest should unwind and return
 * to its event loop, where the host's terminate() takes effect.
 */
export class ChannelClosed extends Error {
  constructor() { super('syscall channel closed'); this.name = 'ChannelClosed'; }
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
    return this.ch.park();
  }

  /** exit_group; does not return. */
  exit(code: number): never {
    this.ch.call(A.SYS_exit_group, code);
    // The kernel closes the channel and terminates the worker
    return this.ch.park();
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
  /** 'atomics': the kernel watches the channel's state word, so don't post SYS_MESSAGE per request. */
  wake?: 'atomics' | 'message';
}

export function isStartMessage(m: unknown): m is GuestStartMessage {
  return !!m && (m as GuestStartMessage).type === 'shiro-start' && (m as GuestStartMessage).sab instanceof SharedArrayBuffer;
}

/**
 * Guest entry helper: GuestSys for a start message. `post` is the worker's
 * postMessage (self.postMessage, or parentPort.postMessage in Node).
 */
export function connectGuest(start: GuestStartMessage, post: (m: unknown) => void): GuestSys {
  return new GuestSys(new GuestChannel(start.sab, start.wake === 'atomics' ? null : () => post(SYS_MESSAGE)));
}

// ── Kernel side ─────────────────────────────────────────────────────────────

/** Atomics.waitAsync, where the engine has it. */
const waitAsync = (Atomics as any).waitAsync as
  ((a: Int32Array, i: number, v: number, t?: number) => { async: boolean; value: any }) | undefined;

/** True when KernelChannel.watch() can serve guests without SYS_MESSAGE. */
export function canWatch(): boolean { return typeof waitAsync === 'function'; }

/**
 * The page's time slice for serving requests back to back. A guest that is
 * spinning gets its next request answered in the same task (no event-loop
 * round trip), but only for this long; then watch() yields a macrotask so
 * input, rendering and timers still run.
 */
const SLICE_MS = 4;
/**
 * How long watch() spins for a hot guest's next request after a reply. A
 * guest that runs some JS between calls (node in a Worker: ~20-200 µs) is
 * otherwise served through Atomics.waitAsync, whose wake-up of an idle page
 * took 30-200 µs, longer the longer the page had been idle.
 */
const HOT_SPIN_MS = 0.25;
/** A request that came within this long of the previous reply (spin plus a waitAsync wake-up) makes the guest hot. */
const HOT_GAP_MS = 0.3;
const now: () => number = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();
let sliceStart = 0;
let yielder: MessagePort | null = null;
const yieldWaiters: (() => void)[] = [];

function yieldToEventLoop(): Promise<void> {
  if (typeof MessageChannel === 'undefined') return new Promise(r => setTimeout(r, 0));
  if (!yielder) {
    const mc = new MessageChannel();
    mc.port1.onmessage = () => { for (const w of yieldWaiters.splice(0)) w(); };
    (mc.port1 as any).unref?.();
    yielder = mc.port2;
  }
  return new Promise(r => {
    if (yieldWaiters.push(r) === 1) yielder!.postMessage(0);
  });
}

/** Channels served by watch(). */
const watching = new Set<KernelChannel>();
let pumping = false;
let pumpStopped: Promise<void> = Promise.resolve();

/**
 * While some guest is making syscalls back to back ("hot": its request came
 * soon after the previous reply), the page spins for up to HOT_SPIN_MS after
 * the last request it served, polling every hot channel and serving what is
 * posted. A spinning guest's next request is then picked up within a
 * microsecond instead of the ~20-30 µs it takes the page to run the task
 * that resolves Atomics.waitAsync. Calls served here complete in microtasks
 * (the awaits between polls); ones that block finish later and restart the
 * pump if their channel is still hot. Guests that compute between calls
 * aren't hot, so the page doesn't spin for them; SLICE_MS bounds each run.
 */
function pumpHot(): void {
  if (pumping) return;
  pumping = true;
  let stopped!: () => void;
  pumpStopped = new Promise(r => { stopped = r; });
  void (async () => {
    try {
      // Never inside the caller (a reply in progress): start from a microtask
      await null;
      let t = now(), last = t, idle = 0;
      for (;;) {
        let hot = false, inflight = false, served = false;
        for (const c of watching) {
          if (c.inCall) inflight = true;
          if (c.hot) hot = true;
          // Any posted request, not only hot guests': while the page spins here,
          // a guest that isn't hot (the other end of a pipe, asleep in
          // Atomics.wait) would otherwise wait for this loop to end before its
          // waitAsync task could run (kernel.pipe_throughput halved with a
          // 0.25 ms spin)
          if (c.ready) {
            if (!c.serveSync(t)) { void c.handle(); if (c.inCall) inflight = true; }
            served = true;
          }
        }
        if (!hot) return;
        // The clock costs about as much as a poll: read it after serving, and every few idle polls
        if (served) { t = last = now(); idle = 0; }
        else if ((++idle & 7) === 0) {
          t = now();
          if (t - last > HOT_SPIN_MS) return;
        }
        if (t - sliceStart > SLICE_MS) {
          await yieldToEventLoop();
          sliceStart = last = t = now();
        } else if (inflight || served) {
          await null; // let calls in progress (and ones a reply just woke) run their microtasks
        }
      }
    } finally {
      pumping = false;
      stopped();
    }
  })();
}

/**
 * Serves one guest's channel. Either call `handle()` whenever the guest
 * posts SYS_MESSAGE, or call `watch()` once: it waits on the state word with
 * Atomics.waitAsync, which wakes the page faster than a message, and
 * answers a spinning guest's next request without a round trip through the
 * event loop. The guest learns which from the start message (`wake`).
 */
export class KernelChannel {
  readonly i32: Int32Array;
  readonly data: Uint8Array;
  private busy = false;
  private stopped = false;
  /** The guest made its last request soon after the previous reply (see pumpHot). */
  hot = false;
  private repliedAt = 0;
  private readonly args: number[] = new Array(A.CH_NARGS).fill(0);

  /** Thread id served by this channel (the pid for the main thread). */
  readonly tid: number;
  private unlisten: () => void;

  /**
   * One channel per guest thread. Extra threads of a process pass `tid` and
   * `onThreadExit` (worker-host attachThread does): their SYS_exit ends only
   * that thread, and gettid returns their tid.
   */
  constructor(readonly sab: SharedArrayBuffer, readonly kernel: Kernel, readonly proc: Process,
    private opts: { tid?: number; onThreadExit?: (code: number) => void; offset?: number; size?: number; listen?: boolean } = {}) {
    // A channel can also live inside a larger buffer (Blink's direct channels
    // are in its wasm memory): `offset` bytes in, with a `size`-byte data area
    const off = opts.offset ?? 0;
    this.i32 = new Int32Array(sab, off, A.CH_DATA / 4);
    this.data = opts.size !== undefined ? new Uint8Array(sab, off + A.CH_DATA, opts.size) : new Uint8Array(sab, off + A.CH_DATA);
    this.tid = opts.tid ?? proc.pid;
    // `listen: false`: signals ride only on replies (Blink's direct channels:
    // host.mjs delivers the others, and an idle channel must not hold one)
    this.unlisten = opts.listen === false ? () => {} : proc.addSignalListener(() => this.flagSignals());
  }

  get isThread(): boolean { return this.tid !== this.proc.pid; }

  /** Move the next deliverable guest signal (kernel.takeSignal) into this channel's signal word if it is free. */
  flagSignals(): void {
    if (this.stopped || Atomics.load(this.i32, A.CH_SIGNAL) !== 0) return;
    if (this.proc.pendingSignals.size === 0) return;
    const sig = this.kernel.takeSignal(this.proc);
    if (sig) Atomics.store(this.i32, A.CH_SIGNAL, sig);
  }

  private reply(result: number): void {
    if (this.stopped) return; // never overwrite STATE_DEAD
    if (result > 0x7fffffff || result < -0x80000000) {
      this.i32[A.CH_ARGS] = Math.floor(result / 0x100000000);
      result = result >>> 0;
    } else {
      this.i32[A.CH_ARGS] = result < 0 ? -1 : 0;
    }
    this.i32[A.CH_RESULT] = result | 0;
    this.flagSignals();
    // A guest still spinning needs no wake-up
    if (Atomics.exchange(this.i32, A.CH_STATE, A.STATE_REPLY) !== A.STATE_REQUEST_SPIN) Atomics.notify(this.i32, A.CH_STATE);
  }

  /** A request is waiting (the guest may be spinning or asleep). */
  get pending(): boolean {
    const s = Atomics.load(this.i32, A.CH_STATE);
    return s === A.STATE_REQUEST || s === A.STATE_REQUEST_SPIN;
  }

  /** A request is waiting and nothing is serving it yet. */
  get ready(): boolean { return !this.busy && !this.stopped && this.pending; }

  /** A call is in progress on the async path (it needs microtasks to finish; readiness waits don't). */
  get inCall(): boolean { return this.asyncCall; }
  private asyncCall = false;

  private markPicked(t = now()): void {
    this.hot = this.repliedAt > 0 && t - this.repliedAt < HOT_GAP_MS;
  }

  private loadArgs(): number[] {
    // One args array per channel: a channel has one call in flight at a time
    const args = this.args;
    for (let i = 0; i < A.CH_NARGS; i++) args[i] = this.i32[A.CH_ARGS + i];
    return args;
  }

  /**
   * Serve the posted request if the kernel can answer it synchronously
   * (Kernel.syscallSync). False when it needs handle(). `t`: the caller's
   * reading of the clock, if it has a fresh one.
   */
  serveSync(t?: number): boolean {
    if (!this.ready) return false;
    const nr = this.i32[A.CH_SYSNO];
    // busy while the kernel runs it: the call can wake other channels' waiters, and they mustn't re-serve this one
    this.busy = true;
    let r: number | undefined;
    try {
      r = nr === A.SYS_gettid ? this.tid : this.kernel.syscallSync(this.proc, nr, this.loadArgs(), this.data);
    } finally {
      this.busy = false;
    }
    if (r === undefined) return false;
    t ??= now();
    this.markPicked(t);
    this.reply(r);
    this.repliedAt = t; // the call took well under a microsecond
    if (this.hot && !pumping && watching.has(this)) pumpHot();
    return true;
  }

  async handle(): Promise<void> {
    if (!this.ready || this.serveSync()) return;
    this.busy = true;
    this.markPicked();
    const nr = this.i32[A.CH_SYSNO];
    const args = this.loadArgs();
    if (nr === A.SYS_exit && this.isThread) {
      this.busy = false;
      this.stop();
      this.opts.onThreadExit?.(args[0]);
      return;
    }
    const f = this.kernel.readinessFile(this.proc, nr, args);
    if (f) return this.waitReady(f, nr, args);
    let result: number | undefined;
    this.asyncCall = true;
    try {
      result = await this.kernel.syscall(this.proc, nr, args, this.data);
    } finally {
      this.asyncCall = false;
      this.finish(result);
    }
  }

  /** End the call in progress: reply (unless the process is gone) and update the hot-guest bookkeeping. */
  private finish(result: number | undefined): void {
    this.busy = false;
    if (result !== undefined && !this.stopped && !this.proc.exiting) this.reply(result);
    this.repliedAt = now();
    if (this.hot && watching.has(this)) pumpHot();
  }

  /**
   * A read or write that would block: wait for the description's readiness
   * callback and finish the call synchronously inside it (when a writer
   * fills a pipe, the blocked reader's reply goes out before the writer's
   * call returns), instead of going through the async read/write path.
   * A signal ends the wait with -EINTR, as a blocked read/write would;
   * anything unusual (EPIPE, a stopped process) falls back to `syscall`.
   */
  private waitReady(f: OpenFile, nr: number, args: number[]): Promise<void> {
    return new Promise<void>(resolve => {
      const proc = this.proc;
      const sig = proc.syscallSignal;
      let done = false;
      let off = () => {};
      const end = (r: number | undefined, fallback = false) => {
        if (done) return;
        done = true;
        off();
        sig.removeEventListener('abort', onAbort);
        if (!fallback) { this.finish(r); resolve(); return; }
        this.asyncCall = true;
        void this.kernel.syscall(proc, nr, args, this.data).then(
          res => { this.asyncCall = false; this.finish(res); },
          () => { this.asyncCall = false; this.finish(undefined); }).finally(resolve);
      };
      // The call can wake its own description's listeners (a read makes room
      // for a blocked writer, whose write wakes readers): never re-enter it
      let busy = false, again = false;
      const attempt = () => {
        if (done) return;
        if (busy) { again = true; return; }
        busy = true;
        try {
          do {
            again = false;
            if (this.stopped || proc.exiting) { end(undefined); return; }
            const r = this.kernel.syscallSync(proc, nr, args, this.data);
            if (r !== undefined) { end(r); return; }
            // Not ready, or something only the full path handles
            if (proc.state !== 'running' || (nr === A.SYS_write && f.poll(A.POLLOUT) & A.POLLERR)) { end(undefined, true); return; }
          } while (again);
        } finally {
          busy = false;
        }
      };
      const onAbort = () => end(-A.EINTR);
      if (sig.aborted) { end(-A.EINTR); return; }
      off = f.onReady(attempt);
      sig.addEventListener('abort', onAbort, { once: true });
      attempt();
    });
  }

  /** Serve requests by waiting on the state word (no SYS_MESSAGE needed). Needs Atomics.waitAsync (canWatch()). */
  async watch(): Promise<void> {
    if (!waitAsync) throw new Error('Atomics.waitAsync unavailable');
    const i32 = this.i32;
    watching.add(this);
    try {
      while (!this.stopped && !this.proc.exiting) {
        const state = Atomics.load(i32, A.CH_STATE);
        if (state === A.STATE_DEAD) return;
        if ((state === A.STATE_REQUEST || state === A.STATE_REQUEST_SPIN) && !this.busy) {
          if (now() - sliceStart > SLICE_MS) {
            await yieldToEventLoop();
            sliceStart = now();
            continue;
          }
          await this.handle();
          continue;
        }
        if (this.hot && pumping) {
          // The pump serves this channel while it is hot; watch again once it stops
          await pumpStopped;
          continue;
        }
        // Idle, or a call in progress: the guest notifies with its next request
        const w = waitAsync(i32, A.CH_STATE, state);
        if (w.async) {
          await w.value;
          sliceStart = now(); // a new task
        }
      }
    } finally {
      watching.delete(this);
    }
  }

  /**
   * Stop serving and close the channel: a guest blocked on it (or that tries
   * another call) gets ChannelClosed and unwinds, so the Worker can be
   * terminated (browsers can't terminate one parked in Atomics.wait).
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.unlisten();
    Atomics.store(this.i32, A.CH_STATE, A.STATE_DEAD);
    Atomics.notify(this.i32, A.CH_STATE);
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
