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
  /** Called after every reply whose signal word is non-zero (signals.ts installs the handler runner). */
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
    const sig = Atomics.exchange(i32, A.CH_SIGNAL, 0);
    if (sig && this.onSignal) this.onSignal(sig);
    return result;
  }

  /** 64-bit result of the last call (lseek): low word is the return value, high word is in args[0]. */
  result64(lo: number): number {
    return lo < 0 && lo > -4096 ? lo : (this.i32[A.CH_ARGS] | 0) * 0x100000000 + (lo >>> 0);
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

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
    return r < 0 ? r : dec.decode(this.ch.data.slice(0, r - 1));
  }

  chdir(path: string): number {
    const len = this.putStr(path);
    return len < 0 ? len : this.ch.call(A.SYS_chdir, len);
  }

  /** posix_spawn. `fds` maps child fd → parent fd (default 0,1,2 inherited). Returns the pid or -errno. */
  spawn(path: string, argv: string[] = [path], opts: { env?: Record<string, string>; cwd?: string; fds?: [number, number][]; pgid?: number } = {}): number {
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

  /** argv/env/cwd/pid of this process. */
  procInfo(): { argv: string[]; env: Record<string, string>; cwd: string; pid: number } {
    const r = this.ch.call(A.SYS_getenv);
    if (r < 0) throw new SysError(r, 'getenv');
    return JSON.parse(dec.decode(this.ch.data.slice(0, r)));
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

  constructor(readonly sab: SharedArrayBuffer, readonly kernel: Kernel, readonly proc: Process) {
    this.i32 = new Int32Array(sab, 0, A.CH_DATA / 4);
    this.data = new Uint8Array(sab, A.CH_DATA);
    proc.data.onSignal = () => this.flagSignals();
  }

  /** Mirror the process's pending signals into the channel's signal word (lowest first). */
  flagSignals(): void {
    const next = [...this.proc.pendingSignals].sort((a, b) => a - b)[0];
    if (next !== undefined && Atomics.load(this.i32, A.CH_SIGNAL) === 0) {
      this.proc.pendingSignals.delete(next);
      Atomics.store(this.i32, A.CH_SIGNAL, next);
    }
  }

  async handle(): Promise<void> {
    if (this.busy || this.stopped) return;
    if (Atomics.load(this.i32, A.CH_STATE) !== A.STATE_REQUEST) return;
    this.busy = true;
    try {
      const nr = this.i32[A.CH_SYSNO];
      const args = Array.from(this.i32.subarray(A.CH_ARGS, A.CH_ARGS + A.CH_NARGS));
      let result = await this.kernel.syscall(this.proc, nr, args, this.data);
      if (this.stopped || this.proc.exiting) return;
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
