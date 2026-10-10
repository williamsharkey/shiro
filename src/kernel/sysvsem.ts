/**
 * System V semaphores (semget, semop/semtimedop, semctl), as Linux keeps
 * them: sets of counters with permissions, all-or-nothing semop that blocks
 * until it can apply (or EAGAIN with IPC_NOWAIT, EINTR on a signal, EIDRM
 * when the set is removed), and SEM_UNDO adjustments applied when the
 * process exits. Audacity's single-instance lock and PostgreSQL use them.
 * The counters live here (not in guest memory), so every engine and every
 * process sees the same sets.
 *
 * ABI (data area as in kernel.ts):
 *   semget      64  (key, nsems, semflg)                     → semid
 *   semop       65  (semid, nsops); data = struct sembuf[nsops] (6 bytes each:
 *                    u16 sem_num, i16 sem_op, i16 sem_flg)  → 0
 *   semtimedop 220  (semid, nsops, hasTimeout, tv_sec, tv_nsec); data as semop
 *   semctl      66  (semid, semnum, cmd, val):
 *                    SETVAL takes val; GETVAL/GETPID/GETNCNT/GETZCNT return it;
 *                    GETALL writes and SETALL reads u16[nsems] in data;
 *                    IPC_STAT/SEM_STAT[_ANY] write a 104-byte struct semid_ds
 *                    (x86-64), IPC_SET reads one; IPC_INFO/SEM_INFO write
 *                    struct seminfo (10 ints)
 * Blocking semop waits in the kernel: a signal ends it with EINTR (never
 * restarted, as on Linux), the timeout with EAGAIN.
 */
import * as A from './abi';
import type { Process } from './process';
import { IPC_PRIVATE, IPC_CREAT, IPC_EXCL, IPC_RMID, IPC_SET, IPC_STAT, IPC_INFO } from './sysvshm';

export const IPC_NOWAIT = 0o4000;
export const SEM_UNDO = 0x1000;
export const GETPID = 11;
export const GETVAL = 12;
export const GETALL = 13;
export const GETNCNT = 14;
export const GETZCNT = 15;
export const SETVAL = 16;
export const SETALL = 17;
export const SEM_STAT = 18;
export const SEM_INFO = 19;
export const SEM_STAT_ANY = 20;

// Linux's defaults (ipc/sem.c, include/uapi/linux/sem.h)
export const SEMMSL = 32000;
export const SEMMNI = 32000;
export const SEMMNS = SEMMSL * SEMMNI;
export const SEMOPM = 500;
export const SEMVMX = 32767;
export const SEMAEM = SEMVMX;
export const SEMID_DS_SIZE = 104;
const SEMBUF_SIZE = 6;

interface Waiter {
  /** The semaphore and kind the blocked operation waits on (GETNCNT/GETZCNT) */
  num: number;
  zero: boolean;
  wake: () => void;
}

interface SemSet {
  id: number;
  key: number;
  vals: Uint16Array;
  pids: Int32Array;
  mode: number;
  uid: number; gid: number; cuid: number; cgid: number;
  otime: number; ctime: number;
  seq: number;
  removed: boolean;
  waiters: Set<Waiter>;
}

const now = () => Math.floor(Date.now() / 1000);

/** One kernel's semaphore sets (Kernel.sem). */
export class SysvSem {
  private sets = new Map<number, SemSet>();
  private nextIndex = 0;
  private seq = 0;

  /** SEM_UNDO adjustments per process: semid → (sem_num → adjustment). */
  private undo(proc: Process): Map<number, Map<number, number>> {
    let m = proc.data.semUndo as Map<number, Map<number, number>> | undefined;
    if (!m) { m = new Map(); proc.data.semUndo = m; }
    return m;
  }

  private canAccess(proc: Process, s: SemSet, write: boolean): boolean {
    if (proc.uid === 0) return true;
    const shift = proc.uid === s.uid || proc.uid === s.cuid ? 6 : proc.gid === s.gid || (proc.groups ?? []).includes(s.gid) ? 3 : 0;
    const bits = (s.mode >> shift) & 7;
    return (bits & 4) !== 0 && (!write || (bits & 2) !== 0);
  }

  private isOwner(proc: Process, s: SemSet): boolean {
    return proc.uid === 0 || proc.uid === s.uid || proc.uid === s.cuid;
  }

  private wakeAll(s: SemSet): void {
    for (const w of [...s.waiters]) w.wake();
  }

  semget(proc: Process, key: number, nsems: number, flg: number): number {
    key |= 0;
    nsems |= 0;
    if (nsems < 0 || nsems > SEMMSL) return -A.EINVAL;
    if (key !== IPC_PRIVATE) {
      const s = [...this.sets.values()].find((x) => x.key === key && !x.removed);
      if (s) {
        if ((flg & IPC_CREAT) && (flg & IPC_EXCL)) return -A.EEXIST;
        if (nsems > s.vals.length) return -A.EINVAL;
        const want = flg & 0o777;
        if (want && !this.canAccess(proc, s, (want & 0o222) !== 0)) return -A.EACCES;
        return s.id;
      }
      if (!(flg & IPC_CREAT)) return -A.ENOENT;
    }
    if (nsems === 0) return -A.EINVAL;
    if (this.sets.size >= SEMMNI) return -A.ENOSPC;
    const index = this.nextIndex++ % SEMMNI;
    const seq = this.seq++ & 0xffff;
    const id = index + seq * 32768; // Linux's ipc_buildid
    this.sets.set(id, {
      id, key, vals: new Uint16Array(nsems), pids: new Int32Array(nsems), mode: flg & 0o777,
      uid: proc.uid, gid: proc.gid, cuid: proc.uid, cgid: proc.gid,
      otime: 0, ctime: now(), seq, removed: false, waiters: new Set(),
    });
    return id;
  }

  /**
   * semop/semtimedop: `ops` is struct sembuf[nsops]. Applies all of them or
   * none; waits (unless IPC_NOWAIT) until it can. `timeoutMs` < 0: no timeout.
   */
  async semop(proc: Process, id: number, nsops: number, ops: Uint8Array, timeoutMs = -1, signal?: AbortSignal): Promise<number> {
    if (nsops <= 0) return -A.EINVAL;
    if (nsops > SEMOPM) return -A.E2BIG;
    if (ops.length < nsops * SEMBUF_SIZE) return -A.EFAULT;
    const dv = new DataView(ops.buffer, ops.byteOffset, nsops * SEMBUF_SIZE);
    const list: { num: number; op: number; flg: number }[] = [];
    for (let i = 0; i < nsops; i++) {
      list.push({ num: dv.getUint16(i * 6, true), op: dv.getInt16(i * 6 + 2, true), flg: dv.getInt16(i * 6 + 4, true) });
    }
    let s = this.sets.get(id);
    if (!s || s.removed) return -A.EINVAL;
    if (list.some((o) => o.num >= s!.vals.length)) return -A.EFBIG;
    if (!this.canAccess(proc, s, list.some((o) => o.op !== 0))) return -A.EACCES;
    const deadline = timeoutMs >= 0 ? Date.now() + timeoutMs : Infinity;
    for (;;) {
      s = this.sets.get(id);
      if (!s || s.removed) return -A.EIDRM;
      const r = this.tryApply(proc, s, list);
      if (r === null) return 0;
      if (r.err) return r.err;
      if (list[r.blocked].flg & IPC_NOWAIT) return -A.EAGAIN;
      if (signal?.aborted) return -A.EINTR;
      const left = deadline - Date.now();
      if (left <= 0) return -A.EAGAIN;
      const set = s;
      const why = await new Promise<'wake' | 'intr' | 'timeout'>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const done = (v: 'wake' | 'intr' | 'timeout') => {
          set.waiters.delete(w);
          if (timer !== undefined) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(v);
        };
        const onAbort = () => done('intr');
        const w: Waiter = { num: list[r.blocked].num, zero: list[r.blocked].op === 0, wake: () => done('wake') };
        set.waiters.add(w);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (left !== Infinity) timer = setTimeout(() => done('timeout'), left);
      });
      if (why === 'intr') return -A.EINTR;
      if (why === 'timeout') {
        // One last try: the wake may have raced the timer
        const t = this.sets.get(id);
        if (!t || t.removed) return -A.EIDRM;
        const again = this.tryApply(proc, t, list);
        return again === null ? 0 : again.err || -A.EAGAIN;
      }
    }
  }

  /** null: applied; otherwise the operation that would block, or an error. */
  private tryApply(proc: Process, s: SemSet, list: { num: number; op: number; flg: number }[]): { blocked: number; err?: number } | null {
    const vals = Uint16Array.from(s.vals);
    for (let i = 0; i < list.length; i++) {
      const { num, op } = list[i];
      const v = vals[num];
      if (op > 0) {
        if (v + op > SEMVMX) return { blocked: i, err: -A.ERANGE };
        vals[num] = v + op;
      } else if (op < 0) {
        if (v < -op) return { blocked: i };
        vals[num] = v + op;
      } else if (v !== 0) {
        return { blocked: i };
      }
    }
    s.vals.set(vals);
    for (const { num, op, flg } of list) {
      s.pids[num] = proc.pid;
      if ((flg & SEM_UNDO) && op !== 0) {
        const u = this.undo(proc);
        this.undoOwners.add(proc);
        let m = u.get(s.id);
        if (!m) { m = new Map(); u.set(s.id, m); }
        const adj = (m.get(num) ?? 0) - op;
        if (adj === 0) m.delete(num); else m.set(num, adj);
      }
    }
    s.otime = now();
    if (list.some((o) => o.op !== 0)) this.wakeAll(s);
    return null;
  }

  semctl(proc: Process, id: number, num: number, cmd: number, val: number, data: Uint8Array): number {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    cmd &= ~0x100; // IPC_64
    if (cmd === IPC_INFO || cmd === SEM_INFO) {
      if (data.length < 40) return -A.EFAULT;
      // struct seminfo: semmap semmni semmns semmnu semmsl semopm semume semusz semvmx semaem
      const sets = [...this.sets.values()];
      const vals = cmd === SEM_INFO
        ? [SEMMNS, SEMMNI, SEMMNS, sets.length, SEMMSL, SEMOPM, SEMOPM, sets.reduce((n, s) => n + s.vals.length, 0), SEMVMX, SEMAEM]
        : [SEMMNS, SEMMNI, SEMMNS, SEMMNS, SEMMSL, SEMOPM, SEMOPM, 20, SEMVMX, SEMAEM];
      vals.forEach((v, i) => dv.setInt32(i * 4, v, true));
      return Math.max(0, ...sets.map((s) => s.id % 32768));
    }
    const statById = cmd === SEM_STAT || cmd === SEM_STAT_ANY;
    const s = statById ? [...this.sets.values()].find((x) => x.id % 32768 === id) : this.sets.get(id);
    if (!s || s.removed) return -A.EINVAL;
    const n = s.vals.length;
    const perSem = cmd === GETVAL || cmd === GETPID || cmd === GETNCNT || cmd === GETZCNT || cmd === SETVAL;
    if (perSem && (num < 0 || num >= n)) return -A.EINVAL;
    switch (cmd) {
      case IPC_STAT: case SEM_STAT: case SEM_STAT_ANY: {
        if (cmd !== SEM_STAT_ANY && !this.canAccess(proc, s, false)) return -A.EACCES;
        if (data.length < SEMID_DS_SIZE) return -A.EFAULT;
        data.fill(0, 0, SEMID_DS_SIZE);
        // struct ipc64_perm
        dv.setInt32(0, s.key, true);
        dv.setUint32(4, s.uid, true); dv.setUint32(8, s.gid, true);
        dv.setUint32(12, s.cuid, true); dv.setUint32(16, s.cgid, true);
        dv.setUint16(20, s.mode, true);
        dv.setUint16(24, s.seq, true);
        // struct semid64_ds (x86-64): sem_otime, unused, sem_ctime, unused, sem_nsems
        dv.setBigInt64(48, BigInt(s.otime), true);
        dv.setBigInt64(64, BigInt(s.ctime), true);
        dv.setBigUint64(80, BigInt(n), true);
        return statById ? s.id : 0;
      }
      case IPC_SET: {
        if (!this.isOwner(proc, s)) return -A.EPERM;
        if (data.length < 24) return -A.EFAULT;
        s.uid = dv.getUint32(4, true);
        s.gid = dv.getUint32(8, true);
        s.mode = dv.getUint16(20, true) & 0o777;
        s.ctime = now();
        return 0;
      }
      case IPC_RMID: {
        if (!this.isOwner(proc, s)) return -A.EPERM;
        s.removed = true;
        this.sets.delete(s.id);
        this.wakeAll(s); // blocked semops end with EIDRM
        return 0;
      }
      case GETVAL:
        return this.canAccess(proc, s, false) ? s.vals[num] : -A.EACCES;
      case GETPID:
        return this.canAccess(proc, s, false) ? s.pids[num] : -A.EACCES;
      case GETNCNT: case GETZCNT: {
        if (!this.canAccess(proc, s, false)) return -A.EACCES;
        let c = 0;
        for (const w of s.waiters) if (w.num === num && w.zero === (cmd === GETZCNT)) c++;
        return c;
      }
      case GETALL: {
        if (!this.canAccess(proc, s, false)) return -A.EACCES;
        if (data.length < n * 2) return -A.EFAULT;
        for (let i = 0; i < n; i++) dv.setUint16(i * 2, s.vals[i], true);
        return 0;
      }
      case SETVAL: {
        if (!this.canAccess(proc, s, true)) return -A.EACCES;
        val |= 0;
        if (val < 0 || val > SEMVMX) return -A.ERANGE;
        s.vals[num] = val;
        s.pids[num] = proc.pid;
        s.ctime = now();
        this.clearUndo(s.id, num);
        this.wakeAll(s);
        return 0;
      }
      case SETALL: {
        if (!this.canAccess(proc, s, true)) return -A.EACCES;
        if (data.length < n * 2) return -A.EFAULT;
        const vals: number[] = [];
        for (let i = 0; i < n; i++) {
          const v = dv.getUint16(i * 2, true);
          if (v > SEMVMX) return -A.ERANGE;
          vals.push(v);
        }
        vals.forEach((v, i) => { s.vals[i] = v; s.pids[i] = proc.pid; });
        s.ctime = now();
        this.clearUndo(s.id);
        this.wakeAll(s);
        return 0;
      }
    }
    return -A.EINVAL;
  }

  /** Processes with SEM_UNDO adjustments; SETVAL/SETALL clear theirs for those semaphores (as Linux's). */
  private undoOwners = new Set<Process>();
  private clearUndo(id: number, num?: number): void {
    for (const p of this.undoOwners) {
      const m = (p.data.semUndo as Map<number, Map<number, number>> | undefined)?.get(id);
      if (!m) continue;
      if (num === undefined) m.clear(); else m.delete(num);
    }
  }

  /** exit: apply the process's SEM_UNDO adjustments (clamped to 0..SEMVMX, as Linux does). */
  exited(proc: Process): void {
    this.undoOwners.delete(proc);
    const u = proc.data.semUndo as Map<number, Map<number, number>> | undefined;
    if (!u?.size) return;
    for (const [id, m] of u) {
      const s = this.sets.get(id);
      if (!s || s.removed || !m.size) continue;
      for (const [num, adj] of m) {
        if (num >= s.vals.length) continue;
        s.vals[num] = Math.min(SEMVMX, Math.max(0, s.vals[num] + adj));
        s.pids[num] = proc.pid;
      }
      s.otime = now();
      this.wakeAll(s);
    }
    u.clear();
  }

  /** fork: the child starts with no adjustments (Linux: semadj isn't inherited without CLONE_SYSVSEM). */
  forked(_parent: Process, child: Process): void {
    delete child.data.semUndo;
  }

  /** ipcs -s: the live sets. */
  list(): ReadonlyArray<Readonly<Omit<SemSet, 'waiters'>>> { return [...this.sets.values()]; }
}
