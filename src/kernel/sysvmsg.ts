/**
 * System V message queues (msgget, msgsnd, msgrcv, msgctl), as Linux keeps
 * them: typed messages in FIFO order per queue, msgrcv by type (0: the
 * first; > 0: the first of that type, or not of it with MSG_EXCEPT; < 0: the
 * lowest type up to |msgtyp|), senders blocking while the queue is full and
 * receivers while nothing matches (IPC_NOWAIT → EAGAIN / ENOMSG, a signal →
 * EINTR, IPC_RMID → EIDRM).
 *
 * ABI (data area as in kernel.ts):
 *   msgget 68 (key, msgflg)                                → msqid
 *   msgsnd 69 (msqid, msgsz, msgflg); data = struct msgbuf: i64 mtype, mtext[msgsz]
 *   msgrcv 70 (msqid, msgsz, msgtypLo, msgtypHi, msgflg)   → bytes of mtext;
 *            data = struct msgbuf as received (mtype, then the text)
 *   msgctl 71 (msqid, cmd); IPC_STAT/MSG_STAT[_ANY] write a 120-byte x86-64
 *            struct msqid_ds, IPC_SET reads one (perm uid/gid/mode, msg_qbytes),
 *            IPC_INFO/MSG_INFO write struct msginfo
 */
import * as A from './abi';
import type { Process } from './process';
import { IPC_PRIVATE, IPC_CREAT, IPC_EXCL, IPC_RMID, IPC_SET, IPC_STAT, IPC_INFO } from './sysvshm';

export const IPC_NOWAIT = 0o4000;
export const MSG_NOERROR = 0o10000;
export const MSG_EXCEPT = 0o20000;
export const MSG_COPY = 0o40000;
export const MSG_STAT = 11;
export const MSG_INFO = 12;
export const MSG_STAT_ANY = 13;

// Linux's defaults (include/uapi/linux/msg.h)
export const MSGMAX = 8192;
export const MSGMNB = 16384;
export const MSGMNI = 32000;
export const MSQID_DS_SIZE = 120;

interface Message { type: number; text: Uint8Array }

interface Queue {
  id: number;
  key: number;
  msgs: Message[];
  bytes: number;
  qbytes: number;
  mode: number;
  uid: number; gid: number; cuid: number; cgid: number;
  stime: number; rtime: number; ctime: number;
  lspid: number; lrpid: number;
  seq: number;
  removed: boolean;
  waiters: Set<() => void>;
}

const now = () => Math.floor(Date.now() / 1000);

/** One kernel's message queues (Kernel.msg). */
export class SysvMsg {
  private queues = new Map<number, Queue>();
  private nextIndex = 0;
  private seq = 0;

  private canAccess(proc: Process, q: Queue, write: boolean): boolean {
    if (proc.uid === 0) return true;
    const shift = proc.uid === q.uid || proc.uid === q.cuid ? 6 : proc.gid === q.gid || (proc.groups ?? []).includes(q.gid) ? 3 : 0;
    const bits = (q.mode >> shift) & 7;
    return write ? (bits & 2) !== 0 : (bits & 4) !== 0;
  }

  private isOwner(proc: Process, q: Queue): boolean {
    return proc.uid === 0 || proc.uid === q.uid || proc.uid === q.cuid;
  }

  private wakeAll(q: Queue): void {
    for (const w of [...q.waiters]) w();
  }

  /** Wait for a change to `q`: 'wake', or 'intr' on a signal. */
  private wait(q: Queue, signal?: AbortSignal): Promise<'wake' | 'intr'> {
    return new Promise((resolve) => {
      const done = (v: 'wake' | 'intr') => {
        q.waiters.delete(wake);
        signal?.removeEventListener('abort', onAbort);
        resolve(v);
      };
      const wake = () => done('wake');
      const onAbort = () => done('intr');
      q.waiters.add(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  msgget(proc: Process, key: number, flg: number): number {
    key |= 0;
    if (key !== IPC_PRIVATE) {
      const q = [...this.queues.values()].find((x) => x.key === key && !x.removed);
      if (q) {
        if ((flg & IPC_CREAT) && (flg & IPC_EXCL)) return -A.EEXIST;
        const want = flg & 0o777;
        if (((want & 0o444) && !this.canAccess(proc, q, false)) || ((want & 0o222) && !this.canAccess(proc, q, true))) return -A.EACCES;
        return q.id;
      }
      if (!(flg & IPC_CREAT)) return -A.ENOENT;
    }
    if (this.queues.size >= MSGMNI) return -A.ENOSPC;
    const index = this.nextIndex++ % MSGMNI;
    const seq = this.seq++ & 0xffff;
    const id = index + seq * 32768; // Linux's ipc_buildid
    this.queues.set(id, {
      id, key, msgs: [], bytes: 0, qbytes: MSGMNB, mode: flg & 0o777,
      uid: proc.uid, gid: proc.gid, cuid: proc.uid, cgid: proc.gid,
      stime: 0, rtime: 0, ctime: now(), lspid: 0, lrpid: 0, seq, removed: false, waiters: new Set(),
    });
    return id;
  }

  async msgsnd(proc: Process, id: number, size: number, flg: number, data: Uint8Array, signal?: AbortSignal): Promise<number> {
    size |= 0;
    if (size < 0 || size > MSGMAX) return -A.EINVAL;
    if (data.length < 8 + size) return -A.EFAULT;
    const type = Number(new DataView(data.buffer, data.byteOffset, 8).getBigInt64(0, true));
    if (type < 1) return -A.EINVAL;
    const text = data.slice(8, 8 + size);
    let q = this.queues.get(id);
    if (!q || q.removed) return -A.EINVAL;
    if (!this.canAccess(proc, q, true)) return -A.EACCES;
    for (;;) {
      q = this.queues.get(id);
      if (!q || q.removed) return -A.EIDRM;
      // Full: by bytes, or by count (a queue of empty messages is bounded too, as Linux's)
      if (q.bytes + size <= q.qbytes && q.msgs.length + 1 <= q.qbytes) break;
      if (flg & IPC_NOWAIT) return -A.EAGAIN;
      if (signal?.aborted || (await this.wait(q, signal)) === 'intr') return -A.EINTR;
    }
    q.msgs.push({ type, text });
    q.bytes += size;
    q.lspid = proc.pid;
    q.stime = now();
    this.wakeAll(q);
    return 0;
  }

  /** The index of the message msgrcv takes for `typ` and `flg`, or -1. */
  private pick(q: Queue, typ: number, flg: number): number {
    if (typ === 0) return q.msgs.length ? 0 : -1;
    if (typ > 0) {
      const except = (flg & MSG_EXCEPT) !== 0;
      return q.msgs.findIndex((m) => (m.type === typ) !== except);
    }
    let best = -1;
    for (let i = 0; i < q.msgs.length; i++) {
      const t = q.msgs[i].type;
      if (t <= -typ && (best < 0 || t < q.msgs[best].type)) best = i;
    }
    return best;
  }

  async msgrcv(proc: Process, id: number, size: number, typ: number, flg: number, data: Uint8Array, signal?: AbortSignal): Promise<number> {
    size |= 0;
    if (size < 0) return -A.EINVAL;
    if (data.length < 8 + Math.min(size, MSGMAX)) return -A.EFAULT;
    if ((flg & MSG_COPY) && ((flg & MSG_EXCEPT) || !(flg & IPC_NOWAIT))) return -A.EINVAL;
    let q = this.queues.get(id);
    if (!q || q.removed) return -A.EINVAL;
    if (!this.canAccess(proc, q, false)) return -A.EACCES;
    for (;;) {
      q = this.queues.get(id);
      if (!q || q.removed) return -A.EIDRM;
      // MSG_COPY: the message at index msgtyp, left in the queue
      const i = flg & MSG_COPY ? (typ >= 0 && typ < q.msgs.length ? typ : -1) : this.pick(q, typ, flg);
      if (i >= 0) {
        const m = q.msgs[i];
        if (m.text.length > size && !(flg & MSG_NOERROR)) return -A.E2BIG;
        const n = Math.min(m.text.length, size);
        const dv = new DataView(data.buffer, data.byteOffset, 8);
        dv.setBigInt64(0, BigInt(m.type), true);
        data.set(m.text.subarray(0, n), 8);
        if (!(flg & MSG_COPY)) {
          q.msgs.splice(i, 1);
          q.bytes -= m.text.length;
          q.lrpid = proc.pid;
          q.rtime = now();
          this.wakeAll(q); // room for blocked senders
        }
        return n;
      }
      if (flg & IPC_NOWAIT) return -A.ENOMSG;
      if (signal?.aborted || (await this.wait(q, signal)) === 'intr') return -A.EINTR;
    }
  }

  msgctl(proc: Process, id: number, cmd: number, data: Uint8Array): number {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    cmd &= ~0x100; // IPC_64
    if (cmd === IPC_INFO || cmd === MSG_INFO) {
      if (data.length < 32) return -A.EFAULT;
      // struct msginfo: msgpool msgmap msgmax msgmnb msgmni msgssz msgtql (int), msgseg (u16)
      const qs = [...this.queues.values()];
      const vals = cmd === MSG_INFO
        ? [qs.length, qs.reduce((n, q) => n + q.msgs.length, 0), MSGMAX, MSGMNB, MSGMNI, 16, qs.reduce((n, q) => n + q.bytes, 0)]
        : [MSGMNI * MSGMNB / 1024, MSGMNI * MSGMNB / 16, MSGMAX, MSGMNB, MSGMNI, 16, MSGMNI * MSGMNB / 16];
      vals.forEach((v, i) => dv.setInt32(i * 4, v, true));
      dv.setUint16(28, 0xffff, true);
      return Math.max(0, ...qs.map((q) => q.id % 32768));
    }
    const statById = cmd === MSG_STAT || cmd === MSG_STAT_ANY;
    const q = statById ? [...this.queues.values()].find((x) => x.id % 32768 === id) : this.queues.get(id);
    if (!q || q.removed) return -A.EINVAL;
    switch (cmd) {
      case IPC_STAT: case MSG_STAT: case MSG_STAT_ANY: {
        if (cmd !== MSG_STAT_ANY && !this.canAccess(proc, q, false)) return -A.EACCES;
        if (data.length < MSQID_DS_SIZE) return -A.EFAULT;
        data.fill(0, 0, MSQID_DS_SIZE);
        dv.setInt32(0, q.key, true);
        dv.setUint32(4, q.uid, true); dv.setUint32(8, q.gid, true);
        dv.setUint32(12, q.cuid, true); dv.setUint32(16, q.cgid, true);
        dv.setUint16(20, q.mode, true);
        dv.setUint16(24, q.seq, true);
        // struct msqid64_ds (x86-64)
        dv.setBigInt64(48, BigInt(q.stime), true);
        dv.setBigInt64(56, BigInt(q.rtime), true);
        dv.setBigInt64(64, BigInt(q.ctime), true);
        dv.setBigUint64(72, BigInt(q.bytes), true);
        dv.setBigUint64(80, BigInt(q.msgs.length), true);
        dv.setBigUint64(88, BigInt(q.qbytes), true);
        dv.setInt32(96, q.lspid, true);
        dv.setInt32(100, q.lrpid, true);
        return statById ? q.id : 0;
      }
      case IPC_SET: {
        if (!this.isOwner(proc, q)) return -A.EPERM;
        if (data.length < 96) return -A.EFAULT;
        const qbytes = Number(dv.getBigUint64(88, true));
        if (qbytes > MSGMNB && proc.uid !== 0) return -A.EPERM;
        q.uid = dv.getUint32(4, true);
        q.gid = dv.getUint32(8, true);
        q.mode = dv.getUint16(20, true) & 0o777;
        q.qbytes = qbytes;
        q.ctime = now();
        this.wakeAll(q);
        return 0;
      }
      case IPC_RMID: {
        if (!this.isOwner(proc, q)) return -A.EPERM;
        q.removed = true;
        this.queues.delete(q.id);
        this.wakeAll(q); // blocked senders and receivers end with EIDRM
        return 0;
      }
    }
    return -A.EINVAL;
  }

  /** ipcs -q and /proc/sysvipc/msg: the live queues. */
  list(): ReadonlyArray<Readonly<Omit<Queue, 'waiters' | 'msgs'> & { qnum: number }>> {
    return [...this.queues.values()].map((q) => ({ ...q, qnum: q.msgs.length }));
  }
}
