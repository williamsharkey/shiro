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
  EPOLL_CTL_ADD, EPOLL_CTL_DEL, EPOLL_CTL_MOD, EPOLLET, EPOLLONESHOT, EPOLLERR, EPOLLHUP, EPOLLEXCLUSIVE,
  EPOLL_EVENT_SIZE, POLLIN, S_IFCHR,
} from './abi';
import { type OpenFile, type OpenFileKind, ReadyListeners, refCount } from './fd';

/**
 * One setTimeout for every pending poll/epoll/select deadline. A wait that
 * ends early (the usual case: readiness) just marks its entry dead, so a
 * loop of epoll_wait(…, 1000) calls costs no setTimeout/clearTimeout pair
 * per call (~5 µs each in Chromium).
 */
interface Deadline { at: number; fire: () => void; dead: boolean }
const deadlines: Deadline[] = []; // sorted by `at`
let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
let deadlineAt = Infinity;
let cancelled = 0;

function armDeadlines(): void {
  while (deadlines.length && deadlines[0].dead) deadlines.shift();
  const next = deadlines[0]?.at ?? Infinity;
  if (next === deadlineAt) return;
  if (deadlineTimer) clearTimeout(deadlineTimer);
  deadlineTimer = null;
  deadlineAt = next;
  if (next === Infinity) return;
  deadlineTimer = setTimeout(() => {
    deadlineTimer = null;
    deadlineAt = Infinity;
    const now = Date.now();
    while (deadlines.length && (deadlines[0].dead || deadlines[0].at <= now)) {
      const d = deadlines.shift()!;
      if (!d.dead) { d.dead = true; d.fire(); }
    }
    armDeadlines();
  }, Math.max(0, next - Date.now()));
  (deadlineTimer as any)?.unref?.();
}

/** Call `fire` after `ms`; returns a cancel function. */
function addDeadline(ms: number, fire: () => void): () => void {
  const d: Deadline = { at: Date.now() + ms, fire, dead: false };
  let i = deadlines.length;
  while (i > 0 && deadlines[i - 1].at > d.at) i--;
  deadlines.splice(i, 0, d);
  if (i === 0) armDeadlines();
  return () => {
    if (d.dead) return;
    d.dead = true;
    // Cancelled entries wait for their deadline to pass; compact when they pile up
    if (++cancelled > 256 && cancelled * 2 > deadlines.length) {
      let w = 0;
      for (const e of deadlines) if (!e.dead) deadlines[w++] = e;
      deadlines.length = w;
      cancelled = 0;
    }
  };
}

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
    let cancelTimer: (() => void) | undefined;
    let done = false;
    const finish = (v: number) => {
      if (done) return;
      done = true;
      offs.forEach(o => o());
      cancelTimer?.();
      signal?.removeEventListener('abort', onAbort);
      resolve(v);
    };
    const onAbort = () => finish(-EINTR);
    const check = () => { const r = scan(); if (r !== 0) finish(r); };
    for (const f of new Set(files)) offs.push(f.onReady(check));
    if (timeoutMs > 0) cancelTimer = addDeadline(timeoutMs, () => finish(scan()));
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

/** EPOLLEXCLUSIVE: the bits it may be combined with (EPOLLIN/OUT/RDNORM/RDBAND/WRNORM/WRBAND, ERR, HUP, WAKEUP, ET) */
const EXCLUSIVE_OK = 0x1 | 0x4 | 0x40 | 0x80 | 0x100 | 0x200 | EPOLLERR | EPOLLHUP | (1 << 29) | EPOLLET | EPOLLEXCLUSIVE;
/** Files whose current readiness event an EPOLLEXCLUSIVE waiter already took (cleared after the event) */
const exclusiveTaken = new Set<OpenFile>();

export class EpollFile implements OpenFile {
  kind: OpenFileKind = 'epoll';
  path = 'anon_inode:[eventpoll]';
  private interest = new Map<OpenFile, Map<number, Interest>>();
  private listeners = new ReadyListeners();
  private closed = false;
  /** epoll_wait calls blocked on this epoll */
  private waiting = 0;

  constructor(public flags = 0) {}

  /** epoll_ctl. `fd` is the caller's fd for `file` (reported back and used as the key, with the description). */
  ctl(op: number, fd: number, file: OpenFile, events: number, dataLo: number, dataHi: number): number {
    if (file === this) return -EINVAL;
    if (file.kind === 'file' || file.kind === 'dir') return -EPERM;
    if (file instanceof EpollFile && file.watches(this)) return -ELOOP;
    // At most 5 epolls deep, like Linux (EP_MAX_NESTS)
    if (op === EPOLL_CTL_ADD && file instanceof EpollFile && file.depth() >= 5) return -EINVAL;
    const byFd = this.interest.get(file);
    const cur = byFd?.get(fd);
    if (op === EPOLL_CTL_MOD && cur && ((events | cur.events) & EPOLLEXCLUSIVE)) return -EINVAL;
    if (op === EPOLL_CTL_ADD && (events & EPOLLEXCLUSIVE) && (file instanceof EpollFile || (events & ~EXCLUSIVE_OK))) return -EINVAL;
    switch (op) {
      case EPOLL_CTL_ADD: {
        if (cur) return -EEXIST;
        const entry: Interest = {
          fd, file, events, dataLo, dataHi, armed: true, disabled: false,
          off: () => {},
        };
        entry.off = file.onReady(() => {
          // EPOLLEXCLUSIVE: one readiness event wakes the first exclusive entry with a blocked
          // waiter and skips the rest (entries without a waiter are still queued, like Linux)
          if (entry.events & EPOLLEXCLUSIVE) {
            if (exclusiveTaken.has(file)) return;
            if (this.waiting > 0) {
              exclusiveTaken.add(file);
              queueMicrotask(() => exclusiveTaken.delete(file));
            }
          }
          entry.armed = true;
          this.listeners.fire();
        });
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

  /** Epolls in the deepest chain below and including this one */
  depth(level = 0): number {
    if (level > 8) return level;
    let d = 0;
    for (const f of this.interest.keys()) if (f instanceof EpollFile) d = Math.max(d, f.depth(level + 1));
    return d + 1;
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
    const reported: OpenFile[] = [];
    const out = this.scanReady(max, consume, reported);
    // Reported entries go to the back, so a full events array doesn't starve the rest (like Linux's ready list)
    for (const f of reported) {
      const m = this.interest.get(f);
      if (m) { this.interest.delete(f); this.interest.set(f, m); }
    }
    return out;
  }

  private scanReady(max: number, consume: boolean, reported: OpenFile[]): EpollEvent[] {
    const out: EpollEvent[] = [];
    for (const [file, m] of [...this.interest]) {
      if (refCount(file) === 0) { for (const e of [...m.values()]) this.drop(e); continue; }
      for (const e of m.values()) {
        if (out.length >= max) return out;
        if (e.disabled) continue;
        if ((e.events & EPOLLET) && !e.armed) continue;
        const ready = file.poll(e.events & 0xffff) & ((e.events & 0xffff) | EPOLLERR | EPOLLHUP);
        if (!ready) {
          // EPOLLET: only a later readiness change reports it (ADD arms the entry, but an unready one waits)
          if (consume && (e.events & EPOLLET)) e.armed = false;
          continue;
        }
        out.push({ events: ready, dataLo: e.dataLo, dataHi: e.dataHi });
        if (consume) {
          if (e.events & EPOLLET) e.armed = false;
          if (e.events & EPOLLONESHOT) e.disabled = true;
          reported.push(file);
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
    this.waiting++;
    const n = await waitReady([this], () => { got = this.collect(max); return got.length; }, timeoutMs, signal)
      .finally(() => { this.waiting--; });
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
