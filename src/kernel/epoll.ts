/**
 * Readiness waiting for poll/select/epoll, built on OpenFile.poll + onReady.
 *
 * EpollFile is the description behind an epoll fd: an interest list of open
 * file descriptions with level-triggered, edge-triggered (EPOLLET) and
 * one-shot (EPOLLONESHOT) reporting. Entries go away when their description
 * is closed (its last fd, in any process), like Linux.
 */

import {
  type KStat, EEXIST, ENOENT, EINVAL, EPERM, EINTR, ELOOP,
  EPOLL_CTL_ADD, EPOLL_CTL_DEL, EPOLL_CTL_MOD, EPOLLET, EPOLLONESHOT, EPOLLERR, EPOLLHUP,
  EPOLL_EVENT_SIZE, POLLIN, S_IFCHR,
} from './abi';
import { type OpenFile, type OpenFileKind, ReadyListeners, refCount } from './fd';

/**
 * Wait until `scan()` reports something (> 0 or an error < 0), `timeoutMs`
 * passes (then scan once more), or `signal` aborts (-EINTR). `timeoutMs` < 0
 * waits forever; 0 scans once.
 */
export function waitReady(files: Iterable<OpenFile>, scan: () => number, timeoutMs: number, signal?: AbortSignal): Promise<number> {
  const first = scan();
  if (first !== 0 || timeoutMs === 0) return Promise.resolve(first);
  if (signal?.aborted) return Promise.resolve(-EINTR);
  return new Promise<number>(resolve => {
    const offs: (() => void)[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const finish = (v: number) => {
      if (done) return;
      done = true;
      offs.forEach(o => o());
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(v);
    };
    const onAbort = () => finish(-EINTR);
    const check = () => { const r = scan(); if (r !== 0) finish(r); };
    for (const f of new Set(files)) offs.push(f.onReady(check));
    if (timeoutMs > 0) timer = setTimeout(() => finish(scan()), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    // Readiness may have changed while subscribing
    check();
  });
}

interface Interest {
  fd: number;
  file: OpenFile;
  events: number;
  dataLo: number;
  dataHi: number;
  /** EPOLLET: a readiness change happened since the last report. */
  armed: boolean;
  /** EPOLLONESHOT: reported once; disabled until EPOLL_CTL_MOD. */
  disabled: boolean;
  off: () => void;
}

export interface EpollEvent { events: number; dataLo: number; dataHi: number }

export class EpollFile implements OpenFile {
  kind: OpenFileKind = 'epoll';
  path = 'anon_inode:[eventpoll]';
  private interest = new Map<OpenFile, Map<number, Interest>>();
  private listeners = new ReadyListeners();
  private closed = false;

  constructor(public flags = 0) {}

  /** epoll_ctl. `fd` is the caller's fd for `file` (reported back and used as the key, with the description). */
  ctl(op: number, fd: number, file: OpenFile, events: number, dataLo: number, dataHi: number): number {
    if (file === this) return -EINVAL;
    if (file.kind === 'file' || file.kind === 'dir') return -EPERM;
    if (file instanceof EpollFile && file.watches(this)) return -ELOOP;
    const byFd = this.interest.get(file);
    const cur = byFd?.get(fd);
    switch (op) {
      case EPOLL_CTL_ADD: {
        if (cur) return -EEXIST;
        const entry: Interest = {
          fd, file, events, dataLo, dataHi, armed: true, disabled: false,
          off: () => {},
        };
        entry.off = file.onReady(() => { entry.armed = true; this.listeners.fire(); });
        const m = byFd ?? new Map<number, Interest>();
        m.set(fd, entry);
        this.interest.set(file, m);
        this.listeners.fire();
        return 0;
      }
      case EPOLL_CTL_MOD:
        if (!cur) return -ENOENT;
        cur.events = events;
        cur.dataLo = dataLo;
        cur.dataHi = dataHi;
        cur.armed = true;
        cur.disabled = false;
        this.listeners.fire();
        return 0;
      case EPOLL_CTL_DEL:
        if (!cur) return -ENOENT;
        this.drop(cur);
        return 0;
      default:
        return -EINVAL;
    }
  }

  private drop(e: Interest) {
    e.off();
    const m = this.interest.get(e.file);
    m?.delete(e.fd);
    if (m && m.size === 0) this.interest.delete(e.file);
  }

  /** Does this epoll (transitively) watch `ep`? Guards against loops. */
  watches(ep: EpollFile, depth = 0): boolean {
    if (depth > 5) return true;
    for (const f of this.interest.keys()) {
      if (f === ep) return true;
      if (f instanceof EpollFile && f.watches(ep, depth + 1)) return true;
    }
    return false;
  }

  /** Collect up to `max` ready events, applying ET/ONESHOT bookkeeping when `consume`. */
  collect(max: number, consume = true): EpollEvent[] {
    const out: EpollEvent[] = [];
    for (const [file, m] of [...this.interest]) {
      if (refCount(file) === 0) { for (const e of [...m.values()]) this.drop(e); continue; }
      for (const e of m.values()) {
        if (out.length >= max) return out;
        if (e.disabled) continue;
        if ((e.events & EPOLLET) && !e.armed) continue;
        const ready = file.poll(e.events & 0xffff) & ((e.events & 0xffff) | EPOLLERR | EPOLLHUP);
        if (!ready) continue;
        out.push({ events: ready, dataLo: e.dataLo, dataHi: e.dataHi });
        if (consume) {
          if (e.events & EPOLLET) e.armed = false;
          if (e.events & EPOLLONESHOT) e.disabled = true;
        }
      }
    }
    return out;
  }

  /** epoll_wait: events written to `out` (EPOLL_EVENT_SIZE each); returns the count or -errno. */
  async wait(out: Uint8Array, max: number, timeoutMs: number, signal?: AbortSignal): Promise<number> {
    if (max <= 0) return -EINVAL;
    max = Math.min(max, Math.floor(out.length / EPOLL_EVENT_SIZE));
    if (max <= 0) return -EINVAL;
    let got: EpollEvent[] = [];
    const n = await waitReady([this], () => { got = this.collect(max); return got.length; }, timeoutMs, signal);
    if (n < 0) return n;
    const dv = new DataView(out.buffer, out.byteOffset, got.length * EPOLL_EVENT_SIZE);
    got.forEach((e, i) => {
      dv.setUint32(i * 12, e.events >>> 0, true);
      dv.setUint32(i * 12 + 4, e.dataLo >>> 0, true);
      dv.setUint32(i * 12 + 8, e.dataHi >>> 0, true);
    });
    return got.length;
  }

  async read(): Promise<number> { return -EINVAL; }
  async write(): Promise<number> { return -EINVAL; }
  poll(events: number): number {
    return this.collect(1, false).length ? events & POLLIN : 0;
  }
  onReady(cb: () => void): () => void { return this.listeners.add(cb); }
  async stat(): Promise<KStat> {
    const now = Date.now();
    return {
      dev: 9, ino: 0, mode: S_IFCHR | 0o600, nlink: 1, uid: 1000, gid: 1000, rdev: 0,
      size: 0, blksize: 4096, blocks: 0, atimeMs: now, mtimeMs: now, ctimeMs: now,
    };
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const m of [...this.interest.values()]) for (const e of [...m.values()]) this.drop(e);
  }
}
