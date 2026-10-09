/**
 * POSIX record locks (fcntl F_GETLK/F_SETLK/F_SETLKW) and open file
 * description locks (F_OFD_*), per file path. A process's POSIX locks on a
 * file all go when it closes any fd for that file or exits; OFD locks belong
 * to the open file description and go when it closes.
 */

export const F_RDLCK = 0;
export const F_WRLCK = 1;
export const F_UNLCK = 2;

interface Lock {
  /** A pid (POSIX locks) or an open file description (OFD locks) */
  owner: unknown;
  /** Reported as l_pid (-1 for OFD locks, like Linux) */
  pid: number;
  type: number;
  start: number;
  /** Exclusive; Infinity = to the end of the file and beyond */
  end: number;
}

export interface LockQuery { type: number; start: number; end: number; pid: number }

export class LockTable {
  private locks = new Map<string, Lock[]>();
  private waiters = new Set<() => void>();

  private conflict(path: string, owner: unknown, type: number, start: number, end: number): Lock | undefined {
    for (const l of this.locks.get(path) ?? []) {
      if (l.owner === owner || l.end <= start || l.start >= end) continue;
      if (l.type === F_WRLCK || type === F_WRLCK) return l;
    }
    return undefined;
  }

  /** F_GETLK: the first lock that would block `type` over [start, end), or null */
  get(path: string, owner: unknown, type: number, start: number, end: number): LockQuery | null {
    const l = this.conflict(path, owner, type, start, end);
    return l ? { type: l.type, start: l.start, end: l.end, pid: l.pid } : null;
  }

  /** F_SETLK(W): 0, -EAGAIN (would block, no wait), or -EINTR (wait aborted) */
  async set(path: string, owner: unknown, pid: number, type: number, start: number, end: number,
    wait: boolean, signal?: AbortSignal): Promise<number> {
    if (type !== F_UNLCK) {
      while (this.conflict(path, owner, type, start, end)) {
        if (!wait) return -11; // EAGAIN
        if (signal?.aborted) return -4; // EINTR
        await new Promise<void>((resolve) => {
          const done = () => { this.waiters.delete(done); signal?.removeEventListener('abort', done); resolve(); };
          this.waiters.add(done);
          signal?.addEventListener('abort', done, { once: true });
        });
      }
    }
    // Cut [start, end) out of this owner's locks, then add the new one
    const next: Lock[] = [];
    for (const l of this.locks.get(path) ?? []) {
      if (l.owner !== owner || l.end <= start || l.start >= end) { next.push(l); continue; }
      if (l.start < start) next.push({ ...l, end: start });
      if (l.end > end) next.push({ ...l, start: end });
    }
    if (type !== F_UNLCK) next.push({ owner, pid, type, start, end });
    if (next.length) this.locks.set(path, next); else this.locks.delete(path);
    this.wake();
    return 0;
  }

  /** Drop every lock `owner` holds (on `path`, or everywhere) */
  release(owner: unknown, path?: string): void {
    let changed = false;
    for (const [p, list] of this.locks) {
      if (path !== undefined && p !== path) continue;
      const keep = list.filter((l) => l.owner !== owner);
      if (keep.length === list.length) continue;
      changed = true;
      if (keep.length) this.locks.set(p, keep); else this.locks.delete(p);
    }
    if (changed) this.wake();
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }
}
