/**
 * POSIX message queues (mq_open, mq_unlink, mq_timedsend, mq_timedreceive,
 * mq_notify, mq_getsetattr), as Linux keeps them: named queues of messages
 * received highest priority first (FIFO within a priority), opened as file
 * descriptors that poll readable while a message waits and writable while
 * there is room. Senders block while the queue is full and receivers while
 * it is empty (O_NONBLOCK → EAGAIN, a timeout → ETIMEDOUT, a signal →
 * EINTR). An unprivileged queue holds at most 10 messages of 8192 bytes
 * (/proc/sys/fs/mqueue msg_max, msgsize_max), the defaults too.
 *
 * ABI (data area as in kernel.ts; names come without glibc's leading '/'):
 *   mq_open 240 (nameLen, oflag, mode, hasAttr); data = name, then struct
 *            mq_attr (4 × i64: flags, maxmsg, msgsize, curmsgs)  → fd
 *   mq_unlink 241 (nameLen); data = name
 *   mq_timedsend 242 (fd, len, prio, hasTimeout); data = message, then an
 *            absolute CLOCK_REALTIME struct timespec
 *   mq_timedreceive 243 (fd, len, hasTimeout); data in = timespec; out =
 *            u32 priority at 0, the message at 8                → its length
 *   mq_notify 244 (fd, hasSigevent); data = struct sigevent (value i64,
 *            signo i32, notify i32)
 *   mq_getsetattr 245 (fd, hasNew); data in = the new mq_attr (only
 *            O_NONBLOCK in mq_flags counts); out = the old one
 */
import * as A from './abi';
import type { KStat } from './abi';
import type { OpenFile, OpenFileKind } from './fd';
import { ReadyListeners } from './fd';
import type { Process } from './process';

export const MQ_PRIO_MAX = 32768;
/** /proc/sys/fs/mqueue: the limits (and defaults) for unprivileged queues */
export const MQ_MSG_MAX = 10;
export const MQ_MSGSIZE_MAX = 8192;
/** What root may ask for (Linux's HARD_MSGMAX, HARD_MSGSIZEMAX) */
const HARD_MSGMAX = 65536;
const HARD_MSGSIZEMAX = 16 * 1024 * 1024;
const SIGEV_SIGNAL = 0;
const SIGEV_NONE = 1;
const SIGEV_THREAD = 2;

interface Message { prio: number; data: Uint8Array }

interface Notify { pid: number; uid: number; file: MqFile; signo: number; value: bigint }

class Queue {
  msgs: Message[] = [];
  waiters = new Set<() => void>();
  listeners = new ReadyListeners();
  notify: Notify | null = null;
  /** receivers blocked in mq_timedreceive (a notification only goes out when none waits) */
  receiving = 0;
  ino: number;
  constructor(public maxmsg: number, public msgsize: number, public mode: number, public uid: number, public gid: number) {
    this.ino = nextIno++;
  }
  wake(mask: number): void {
    for (const w of [...this.waiters]) w();
    this.listeners.fire(mask);
  }
}

let nextIno = 1;

/** An open queue (struct file of an mqueue inode) */
export class MqFile implements OpenFile {
  kind: OpenFileKind = 'dev';
  constructor(readonly q: Queue, public flags: number, readonly owner: MessageQueues, public path: string) {}
  async read(): Promise<number> { return -A.EINVAL; }
  async write(): Promise<number> { return -A.EINVAL; }
  poll(events: number): number {
    let r = 0;
    if (this.q.msgs.length > 0) r |= A.POLLIN;
    if (this.q.msgs.length < this.q.maxmsg) r |= A.POLLOUT;
    return r & events;
  }
  onReady(cb: () => void): () => void { return this.q.listeners.add(cb); }
  async stat(): Promise<KStat> {
    const now = Date.now();
    return {
      dev: 7, ino: this.q.ino, mode: A.S_IFREG | this.q.mode, nlink: 1, uid: this.q.uid, gid: this.q.gid, rdev: 0,
      size: 0, blksize: 4096, blocks: 0, atimeMs: now, mtimeMs: now, ctimeMs: now,
    };
  }
  async close(): Promise<void> {
    // a notification goes with the descriptor that registered it
    if (this.q.notify?.file === this) this.q.notify = null;
  }
}

/** One kernel's POSIX message queues (Kernel.mq) */
export class MessageQueues {
  private names = new Map<string, Queue>();

  constructor(private deliver: (pid: number, sig: number, info: A.SigInfo) => void) {}

  private static access(proc: Process, q: Queue, acc: number): boolean {
    if (proc.uid === 0) return true;
    const shift = proc.uid === q.uid ? 6 : proc.gid === q.gid || (proc.groups ?? []).includes(q.gid) ? 3 : 0;
    const bits = (q.mode >> shift) & 7;
    const need = acc === A.O_RDONLY ? 4 : acc === A.O_WRONLY ? 2 : 6;
    return (bits & need) === need;
  }

  private static checkName(name: string): number {
    if (name.length > 255) return -A.ENAMETOOLONG;
    if (name === '') return -A.ENOENT;
    if (name.includes('/')) return -A.EACCES;
    return 0;
  }

  open(proc: Process, name: string, oflag: number, mode: number, attr: DataView | null): MqFile | number {
    const bad = MessageQueues.checkName(name);
    if (bad) return bad;
    const acc = oflag & A.O_ACCMODE;
    if (acc === A.O_ACCMODE) return -A.EINVAL;
    let q = this.names.get(name);
    if (q) {
      if ((oflag & A.O_CREAT) && (oflag & A.O_EXCL)) return -A.EEXIST;
      if (!MessageQueues.access(proc, q, acc)) return -A.EACCES;
    } else {
      if (!(oflag & A.O_CREAT)) return -A.ENOENT;
      let maxmsg = MQ_MSG_MAX, msgsize = MQ_MSGSIZE_MAX;
      if (attr) {
        const mm = Number(attr.getBigInt64(8, true)), ms = Number(attr.getBigInt64(16, true));
        if (mm <= 0 || ms <= 0) return -A.EINVAL;
        const [lm, ls] = proc.uid === 0 ? [HARD_MSGMAX, HARD_MSGSIZEMAX] : [MQ_MSG_MAX, MQ_MSGSIZE_MAX];
        if (mm > lm || ms > ls) return -A.EINVAL;
        maxmsg = mm, msgsize = ms;
      }
      q = new Queue(maxmsg, msgsize, mode & 0o777 & ~proc.umask, proc.uid, proc.gid);
      this.names.set(name, q);
    }
    return new MqFile(q, acc | (oflag & A.O_NONBLOCK), this, `/dev/mqueue/${name}`);
  }

  unlink(proc: Process, name: string): number {
    const bad = MessageQueues.checkName(name);
    if (bad) return bad;
    const q = this.names.get(name);
    if (!q) return -A.ENOENT;
    if (proc.uid !== 0 && proc.uid !== q.uid) return -A.EACCES;
    // the queue lives on while it is open
    this.names.delete(name);
    return 0;
  }

  /** Wait for a change to `q` until `deadline` (ms since the epoch; Infinity = none): 'wake', 'timeout' or 'intr' */
  private wait(q: Queue, deadline: number, signal?: AbortSignal): Promise<'wake' | 'timeout' | 'intr'> {
    return new Promise((resolve) => {
      if (signal?.aborted) { resolve('intr'); return; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (v: 'wake' | 'timeout' | 'intr') => {
        q.waiters.delete(wake);
        signal?.removeEventListener('abort', onAbort);
        if (timer) clearTimeout(timer);
        resolve(v);
      };
      const wake = () => done('wake');
      const onAbort = () => done('intr');
      q.waiters.add(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
      // (setTimeout runs a delay past 2^31-1 ms at once: a deadline that far off, TIME_T_MAX, is no deadline)
      const ms = deadline - Date.now();
      if (ms <= 0x7fffffff) timer = setTimeout(() => done('timeout'), Math.max(0, ms));
    });
  }

  /** An absolute CLOCK_REALTIME timespec → ms since the epoch, or -EINVAL (Linux checks it up front) */
  private static deadline(ts: DataView | null): number {
    if (!ts) return Infinity;
    const sec = Number(ts.getBigInt64(0, true)), nsec = Number(ts.getBigInt64(8, true));
    if (sec < 0 || nsec < 0 || nsec >= 1e9) return -A.EINVAL;
    return sec * 1000 + nsec / 1e6;
  }

  async send(sender: Process, f: MqFile, msg: Uint8Array, prio: number, ts: DataView | null, signal?: AbortSignal): Promise<number> {
    const q = f.q;
    if ((f.flags & A.O_ACCMODE) === A.O_RDONLY) return -A.EBADF;
    if (prio >>> 0 >= MQ_PRIO_MAX) return -A.EINVAL;
    if (msg.length > q.msgsize) return -A.EMSGSIZE;
    const deadline = MessageQueues.deadline(ts);
    if (deadline < 0) return deadline;
    while (q.msgs.length >= q.maxmsg) {
      if (f.flags & A.O_NONBLOCK) return -A.EAGAIN;
      const w = await this.wait(q, deadline, signal);
      if (w === 'intr') return -A.EINTR;
      if (w === 'timeout' && q.msgs.length >= q.maxmsg) return -A.ETIMEDOUT;
    }
    const wasEmpty = q.msgs.length === 0;
    // highest priority first, FIFO within one
    let i = q.msgs.length;
    while (i > 0 && q.msgs[i - 1].prio < prio) i--;
    q.msgs.splice(i, 0, { prio, data: msg.slice() });
    // a registered process hears of a message to an empty queue nobody waits on, once
    if (wasEmpty && q.notify && q.receiving === 0) {
      const n = q.notify;
      q.notify = null;
      if (n.signo) this.deliver(n.pid, n.signo, { signo: n.signo, code: A.SI_MESGQ, pid: sender.pid, uid: sender.uid, value: n.value });
    }
    q.wake(A.POLLIN);
    return 0;
  }

  async receive(f: MqFile, out: Uint8Array, ts: DataView | null, signal?: AbortSignal): Promise<{ n: number; prio: number } | number> {
    const q = f.q;
    if ((f.flags & A.O_ACCMODE) === A.O_WRONLY) return -A.EBADF;
    if (out.length < q.msgsize) return -A.EMSGSIZE;
    const deadline = MessageQueues.deadline(ts);
    if (deadline < 0) return deadline;
    while (q.msgs.length === 0) {
      if (f.flags & A.O_NONBLOCK) return -A.EAGAIN;
      q.receiving++;
      const w = await this.wait(q, deadline, signal);
      q.receiving--;
      if (w === 'intr') return -A.EINTR;
      if (w === 'timeout' && q.msgs.length === 0) return -A.ETIMEDOUT;
    }
    const m = q.msgs.shift()!;
    out.set(m.data);
    q.wake(A.POLLOUT);
    return { n: m.data.length, prio: m.prio };
  }

  /** mq_notify: `sev` null removes this process's registration */
  notify(proc: Process, f: MqFile, sev: DataView | null): number {
    const q = f.q;
    if (!sev) {
      if (q.notify?.pid === proc.pid) q.notify = null;
      return 0;
    }
    const signo = sev.getInt32(8, true), how = sev.getInt32(12, true);
    if (how !== SIGEV_SIGNAL && how !== SIGEV_NONE && how !== SIGEV_THREAD) return -A.EINVAL;
    if (how === SIGEV_SIGNAL && (signo < 0 || signo > 64)) return -A.EINVAL; // (0 is valid: nothing is sent)
    if (q.notify) return -A.EBUSY; // one registration per queue (the same process again too)
    // (SIGEV_THREAD would need glibc's netlink helper: registered, never sent)
    q.notify = { pid: proc.pid, uid: proc.uid, file: f, signo: how === SIGEV_SIGNAL ? signo : 0, value: sev.getBigInt64(0, true) };
    return 0;
  }

  /** mq_getsetattr: the old attributes into `out`; a new one sets only O_NONBLOCK */
  getsetattr(f: MqFile, next: DataView | null, out: DataView): number {
    const q = f.q;
    out.setBigInt64(0, BigInt(f.flags & A.O_NONBLOCK), true);
    out.setBigInt64(8, BigInt(q.maxmsg), true);
    out.setBigInt64(16, BigInt(q.msgsize), true);
    out.setBigInt64(24, BigInt(q.msgs.length), true);
    if (next) {
      const fl = Number(next.getBigInt64(0, true));
      if (fl & ~A.O_NONBLOCK) return -A.EINVAL;
      f.flags = (f.flags & ~A.O_NONBLOCK) | (fl & A.O_NONBLOCK);
    }
    return 0;
  }
}
