/**
 * System V shared memory: the segments' identity and bookkeeping (shmget,
 * shmctl, attach counts), as Linux keeps them. The memory itself is the
 * engine's: Blink maps a segment on shmat and tells the kernel through
 * SYS_shiro_shmat / SYS_shiro_shmdt, so IPC_STAT's shm_nattch, IPC_RMID's
 * destroy-on-last-detach and the per-process attachments (inherited by fork,
 * dropped by exec and exit) are right. PostgreSQL's postmaster interlock is
 * the main user: shmget(IPC_CREAT|IPC_EXCL), shmat, shmctl(IPC_STAT) for
 * shm_nattch, shmdt, shmctl(IPC_RMID).
 *
 * ABI (data area as in kernel.ts):
 *   shmget  29 (key, sizeLo, sizeHi, shmflg)        → shmid
 *   shmctl  31 (shmid, cmd); IPC_STAT/SHM_STAT[_ANY] write a 112-byte
 *            struct shmid_ds (x86-64), IPC_SET reads one, IPC_INFO/SHM_INFO
 *            write struct shminfo / shm_info
 *   SYS_shiro_shmat 1013 (shmid, shmflg) → 0, data = u64 segment size
 *   SYS_shiro_shmdt 1014 (shmid)         → 0
 */
import * as A from './abi';
import type { Process } from './process';

export const IPC_PRIVATE = 0;
export const IPC_CREAT = 0o1000;
export const IPC_EXCL = 0o2000;
export const IPC_RMID = 0;
export const IPC_SET = 1;
export const IPC_STAT = 2;
export const IPC_INFO = 3;
export const SHM_LOCK = 11;
export const SHM_UNLOCK = 12;
export const SHM_STAT = 13;
export const SHM_INFO = 14;
export const SHM_STAT_ANY = 15;
export const SHM_RDONLY = 0o10000;
const SHM_DEST = 0o1000; // in shm_perm.mode: removed, waiting for the last detach
const SHM_LOCKED = 0o2000;
const SHMMIN = 1;
const SHMMAX = 0x7fffffffffff000; // Linux's default (ULONG_MAX - 2^24), rounded: no practical limit
const SHMMNI = 4096;
const SHMALL = 0x7fffffffffff000 / 4096;

interface Segment {
  id: number;
  key: number;
  size: number;
  mode: number;
  uid: number; gid: number; cuid: number; cgid: number;
  cpid: number; lpid: number;
  nattch: number;
  atime: number; dtime: number; ctime: number;
  seq: number;
  removed: boolean;
  locked: boolean;
}

const now = () => Math.floor(Date.now() / 1000);

/** One kernel's segments (Kernel.shm). */
export class SysvShm {
  private segs = new Map<number, Segment>();
  private nextIndex = 0;
  private seq = 0;

  /** Attachments per process: shmid → count (a process can attach a segment more than once). */
  private attached(proc: Process): Map<number, number> {
    let m = proc.data.shmAttached as Map<number, number> | undefined;
    if (!m) { m = new Map(); proc.data.shmAttached = m; }
    return m;
  }

  private canAccess(proc: Process, s: Segment, write: boolean): boolean {
    if (proc.uid === 0) return true;
    const shift = proc.uid === s.uid || proc.uid === s.cuid ? 6 : proc.gid === s.gid || (proc.groups ?? []).includes(s.gid) ? 3 : 0;
    const bits = (s.mode >> shift) & 7;
    return (bits & 4) !== 0 && (!write || (bits & 2) !== 0);
  }

  private isOwner(proc: Process, s: Segment): boolean {
    return proc.uid === 0 || proc.uid === s.uid || proc.uid === s.cuid;
  }

  shmget(proc: Process, key: number, size: number, flg: number): number {
    key |= 0;
    if (key !== IPC_PRIVATE) {
      const s = [...this.segs.values()].find((x) => x.key === key && !x.removed);
      if (s) {
        if ((flg & IPC_CREAT) && (flg & IPC_EXCL)) return -A.EEXIST;
        if (size > s.size) return -A.EINVAL;
        const want = flg & 0o777;
        if (want && !this.canAccess(proc, s, (want & 0o222) !== 0)) return -A.EACCES;
        return s.id;
      }
      if (!(flg & IPC_CREAT)) return -A.ENOENT;
    }
    if (size < SHMMIN || size > SHMMAX) return -A.EINVAL;
    if (this.segs.size >= SHMMNI) return -A.ENOSPC;
    const index = this.nextIndex++ % SHMMNI;
    const seq = this.seq++ & 0xffff;
    // Linux: index + seq * SHMMNI-sized slot (ipc_buildid), never 0 twice in a row
    const id = index + seq * 32768;
    const t = now();
    this.segs.set(id, {
      id, key, size, mode: flg & 0o777, uid: proc.uid, gid: proc.gid, cuid: proc.uid, cgid: proc.gid,
      cpid: proc.pid, lpid: 0, nattch: 0, atime: 0, dtime: 0, ctime: t, seq, removed: false, locked: false,
    });
    return id;
  }

  shmctl(proc: Process, id: number, cmd: number, data: Uint8Array): number {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    cmd &= ~0x100; // IPC_64
    if (cmd === IPC_INFO || cmd === SHM_INFO) {
      if (data.length < 64) return -A.EFAULT;
      data.fill(0, 0, 64);
      if (cmd === IPC_INFO) {
        // struct shminfo: shmmax, shmmin, shmmni, shmseg, shmall (unsigned long each)
        dv.setBigUint64(0, BigInt(SHMMAX), true); dv.setBigUint64(8, BigInt(SHMMIN), true);
        dv.setBigUint64(16, BigInt(SHMMNI), true); dv.setBigUint64(24, BigInt(SHMMNI), true);
        dv.setBigUint64(32, BigInt(SHMALL), true);
      } else {
        // struct shm_info: used_ids (int), shm_tot, shm_rss, shm_swp, swap_attempts, swap_successes
        const segs = [...this.segs.values()];
        dv.setInt32(0, segs.length, true);
        dv.setBigUint64(8, BigInt(segs.reduce((n, s) => n + Math.ceil(s.size / 4096), 0)), true);
      }
      return Math.max(0, ...[...this.segs.values()].map((s) => s.id % 32768));
    }
    const statById = cmd === SHM_STAT || cmd === SHM_STAT_ANY;
    const s = statById ? [...this.segs.values()].find((x) => x.id % 32768 === id) : this.segs.get(id);
    if (!s) return -A.EINVAL;
    switch (cmd) {
      case IPC_STAT: case SHM_STAT: case SHM_STAT_ANY: {
        if (cmd !== SHM_STAT_ANY && !this.canAccess(proc, s, false)) return -A.EACCES;
        if (data.length < 112) return -A.EFAULT;
        data.fill(0, 0, 112);
        // struct ipc_perm
        dv.setInt32(0, s.removed ? IPC_PRIVATE : s.key, true);
        dv.setUint32(4, s.uid, true); dv.setUint32(8, s.gid, true);
        dv.setUint32(12, s.cuid, true); dv.setUint32(16, s.cgid, true);
        dv.setUint16(20, s.mode | (s.removed ? SHM_DEST : 0) | (s.locked ? SHM_LOCKED : 0), true);
        dv.setUint16(24, s.seq, true);
        // struct shmid_ds after it
        dv.setBigUint64(48, BigInt(s.size), true);
        dv.setBigInt64(56, BigInt(s.atime), true);
        dv.setBigInt64(64, BigInt(s.dtime), true);
        dv.setBigInt64(72, BigInt(s.ctime), true);
        dv.setInt32(80, s.cpid, true);
        dv.setInt32(84, s.lpid, true);
        dv.setBigUint64(88, BigInt(s.nattch), true);
        return statById ? s.id : 0;
      }
      case IPC_SET: {
        if (!this.isOwner(proc, s)) return -A.EPERM;
        if (data.length < 24) return -A.EFAULT;
        s.uid = dv.getUint32(4, true);
        s.gid = dv.getUint32(8, true);
        s.mode = (s.mode & ~0o777) | (dv.getUint16(20, true) & 0o777);
        s.ctime = now();
        return 0;
      }
      case IPC_RMID: {
        if (!this.isOwner(proc, s)) return -A.EPERM;
        s.removed = true;
        s.ctime = now();
        if (s.nattch === 0) this.segs.delete(s.id);
        return 0;
      }
      case SHM_LOCK: case SHM_UNLOCK:
        if (!this.isOwner(proc, s)) return -A.EPERM;
        s.locked = cmd === SHM_LOCK;
        return 0;
    }
    return -A.EINVAL;
  }

  /** The engine is about to map segment `id` into `proc`: check access, count it; data = u64 size. */
  attach(proc: Process, id: number, flg: number, data: Uint8Array): number {
    const s = this.segs.get(id);
    if (!s || (s.removed && s.nattch === 0)) return -A.EINVAL;
    if (!this.canAccess(proc, s, !(flg & SHM_RDONLY))) return -A.EACCES;
    if (data.length < 8) return -A.EFAULT;
    new DataView(data.buffer, data.byteOffset, 8).setBigUint64(0, BigInt(s.size), true);
    s.nattch++;
    s.atime = now();
    s.lpid = proc.pid;
    const m = this.attached(proc);
    m.set(id, (m.get(id) ?? 0) + 1);
    return 0;
  }

  /** The engine unmapped one attachment of `id` from `proc` (shmdt, or a failed map after attach). */
  detach(proc: Process, id: number): number {
    const m = this.attached(proc);
    const n = m.get(id) ?? 0;
    if (!n) return -A.EINVAL;
    if (n === 1) m.delete(id); else m.set(id, n - 1);
    this.release(id, proc.pid);
    return 0;
  }

  private release(id: number, pid: number): void {
    const s = this.segs.get(id);
    if (!s) return;
    s.nattch = Math.max(0, s.nattch - 1);
    s.dtime = now();
    s.lpid = pid;
    if (s.removed && s.nattch === 0) this.segs.delete(id);
  }

  /** fork: the child has the parent's attachments. */
  forked(parent: Process, child: Process): void {
    const m = parent.data.shmAttached as Map<number, number> | undefined;
    if (!m?.size) return;
    child.data.shmAttached = new Map(m);
    for (const [id, n] of m) {
      const s = this.segs.get(id);
      if (s) s.nattch += n;
    }
  }

  /** exec and exit: every attachment goes. */
  detachAll(proc: Process): void {
    const m = proc.data.shmAttached as Map<number, number> | undefined;
    if (!m?.size) return;
    for (const [id, n] of m) for (let i = 0; i < n; i++) this.release(id, proc.pid);
    m.clear();
  }

  /** ipcs -m and /proc/sysvipc/shm: the live segments. */
  list(): ReadonlyArray<Readonly<Segment>> { return [...this.segs.values()]; }
}
