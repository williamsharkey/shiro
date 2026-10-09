/**
 * The kernel log (printk's ring buffer): what `dmesg` shows.
 *
 * - A bounded ring of records (64 KiB of text or 1000 records, whichever
 *   fills first; the oldest go). Each record has a sequence number, a
 *   timestamp in microseconds since boot (procfs `bootMs`, the same clock as
 *   /proc/uptime), a syslog facility and level, and one line of text.
 * - /dev/kmsg (KmsgFile): each read returns one record as
 *   `prio,seq,usec,-;text\n` (prio = facility * 8 + level), blocks for the
 *   next one unless O_NONBLOCK (EAGAIN), and fails once with EPIPE when
 *   records it hadn't read were overwritten. Writes log a line; a `<N>`
 *   prefix sets the priority (LOG_USER, level 4 when absent, as Linux).
 *   lseek SEEK_SET/SEEK_DATA/SEEK_END go to the first
 *   record, the one after the last clear, or the end.
 * - syslog(2) (`syslogAction`): READ_ALL, READ_CLEAR, CLEAR, SIZE_UNREAD,
 *   SIZE_BUFFER and the console actions, in Linux's `<prio>[ secs.usecs] text`
 *   form, so util-linux dmesg works either way.
 * - `printk(level, text)` / `printkRatelimited`: identical lines logged by a
 *   retry loop collapse (burst 5 per 5 s per text, then a "suppressed" note).
 *
 * Messages are prefixed by subsystem the way Linux's are: `net: ...`,
 * `traps: prog[pid] ...`, `Out of memory: Killed process ...`.
 */

import * as A from './abi';
import { type OpenFile, type OpenFileKind, ReadyListeners, abortableWait, charDevStat } from './fd';
import { bootMs } from './procfs';

export const LOG_EMERG = 0;
export const LOG_ALERT = 1;
export const LOG_CRIT = 2;
export const LOG_ERR = 3;
export const LOG_WARNING = 4;
export const LOG_NOTICE = 5;
export const LOG_INFO = 6;
export const LOG_DEBUG = 7;
export const LOG_KERN = 0;
export const LOG_USER = 1;
export const LEVEL_NAMES = ['emerg', 'alert', 'crit', 'err', 'warn', 'notice', 'info', 'debug'];
export const FACILITY_NAMES = ['kern', 'user', 'mail', 'daemon', 'auth', 'syslog', 'lpr', 'news'];

/** syslog(2) actions */
export const SYSLOG_ACTION_CLOSE = 0;
export const SYSLOG_ACTION_OPEN = 1;
export const SYSLOG_ACTION_READ = 2;
export const SYSLOG_ACTION_READ_ALL = 3;
export const SYSLOG_ACTION_READ_CLEAR = 4;
export const SYSLOG_ACTION_CLEAR = 5;
export const SYSLOG_ACTION_CONSOLE_OFF = 6;
export const SYSLOG_ACTION_CONSOLE_ON = 7;
export const SYSLOG_ACTION_CONSOLE_LEVEL = 8;
export const SYSLOG_ACTION_SIZE_UNREAD = 9;
export const SYSLOG_ACTION_SIZE_BUFFER = 10;

export interface KlogRecord {
  seq: number;
  /** Microseconds since boot. */
  usec: number;
  facility: number;
  level: number;
  text: string;
}

const enc = new TextEncoder();

/** Microseconds since boot (bootMs), with sub-millisecond precision where performance.now has it. */
function nowUsec(): number {
  const perf = typeof performance !== 'undefined' ? performance : undefined;
  if (perf && typeof perf.timeOrigin === 'number') return Math.max(0, Math.round((perf.timeOrigin + perf.now() - bootMs) * 1000));
  return (Date.now() - bootMs) * 1000;
}

/** `[    1.234567]`, Linux's printk time prefix. */
export function formatTimestamp(usec: number): string {
  const s = Math.floor(usec / 1e6);
  const us = Math.floor(usec % 1e6);
  return `[${String(s).padStart(5)}.${String(us).padStart(6, '0')}]`;
}

/** /dev/kmsg's record format: `prio,seq,usec,-;text\n` (newlines in text escaped as \x0a, as Linux does). */
export function formatKmsg(r: KlogRecord): string {
  const text = r.text.replace(/[\x00-\x08\x0a-\x1f\x7f\\]/g, c => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
  return `${r.facility * 8 + r.level},${r.seq},${r.usec},-;${text}\n`;
}

export class KernelLog {
  private records: KlogRecord[] = [];
  private head = 0;           // index of the oldest record in `records`
  private textBytes = 0;
  private nextSeq = 0;
  /** First sequence number after the last clear (SEEK_DATA, dmesg -c). */
  private clearSeq = 0;
  /** syslog(2) READ's destructive cursor. */
  private readSeq = 0;
  private listeners = new ReadyListeners();
  private waiters = new Set<() => void>();
  private rates = new Map<string, { start: number; count: number; suppressed: number }>();
  /** Also print records at or above this level to the page console (console_loglevel); -1 = off. */
  consoleLevel = -1;
  /** Time source in µs since boot (tests replace it). */
  clock: () => number = nowUsec;

  constructor(readonly maxBytes = 64 * 1024, readonly maxRecords = 1000) {}

  get firstSeq(): number { return this.nextSeq - this.size; }
  get lastSeq(): number { return this.nextSeq; }
  get size(): number { return this.records.length - this.head; }

  /** Append a record; returns its sequence number. */
  log(level: number, text: string, facility = LOG_KERN): number {
    level = Math.max(0, Math.min(7, level | 0));
    // One record per line, like printk with embedded newlines
    const lines = String(text).replace(/\n+$/, '').split('\n');
    let seq = -1;
    for (const line of lines) seq = this.append({ seq: this.nextSeq, usec: this.clock(), facility, level, text: line });
    return seq;
  }

  private append(r: KlogRecord): number {
    this.nextSeq++;
    this.records.push(r);
    this.textBytes += r.text.length + 32;
    while (this.size > 1 && (this.size > this.maxRecords || this.textBytes > this.maxBytes)) {
      const old = this.records[this.head++];
      this.textBytes -= old.text.length + 32;
    }
    // Compact the backing array now and then
    if (this.head > 512 && this.head * 2 > this.records.length) {
      this.records = this.records.slice(this.head);
      this.head = 0;
    }
    if (this.consoleLevel >= 0 && r.level <= this.consoleLevel) {
      (r.level <= LOG_ERR ? console.error : r.level <= LOG_WARNING ? console.warn : console.log)(`[kernel] ${r.text}`);
    }
    for (const w of [...this.waiters]) w();
    this.listeners.fire();
    return r.seq;
  }

  /**
   * Log `text` unless the same text was logged `burst` times in the last
   * `intervalMs`; the first line after a quiet spell notes how many were dropped.
   */
  logRatelimited(level: number, text: string, opts: { burst?: number; intervalMs?: number; facility?: number } = {}): number {
    const burst = opts.burst ?? 5;
    const interval = (opts.intervalMs ?? 5000) * 1000;
    const now = this.clock();
    let st = this.rates.get(text);
    if (!st || now - st.start >= interval) {
      const dropped = st?.suppressed ?? 0;
      st = { start: now, count: 0, suppressed: 0 };
      this.rates.set(text, st);
      if (this.rates.size > 256) this.rates.delete(this.rates.keys().next().value!);
      if (dropped) this.log(LOG_WARNING, `${text.split(':')[0]}: ${dropped} similar messages suppressed`, opts.facility);
    }
    if (st.count >= burst) { st.suppressed++; return -1; }
    st.count++;
    return this.log(level, text, opts.facility);
  }

  /** The record with sequence number `seq`, or undefined if it is gone or not written yet. */
  get(seq: number): KlogRecord | undefined {
    if (seq < this.firstSeq || seq >= this.nextSeq) return undefined;
    return this.records[this.head + (seq - this.firstSeq)];
  }

  /** Records from `fromSeq` on (clamped to what is still held). */
  since(fromSeq = this.firstSeq): KlogRecord[] {
    const start = Math.max(fromSeq, this.firstSeq);
    return this.records.slice(this.head + (start - this.firstSeq));
  }

  /** Records after the last clear. */
  all(): KlogRecord[] { return this.since(this.clearSeq); }

  clear(): void { this.clearSeq = this.nextSeq; }
  get clearPoint(): number { return Math.max(this.clearSeq, this.firstSeq); }

  /** `[    1.234567] text` lines (dmesg's default output). */
  text(records = this.all()): string {
    return records.map(r => `${formatTimestamp(r.usec)} ${r.text}\n`).join('');
  }

  /** Called on every new record; returns an unsubscribe function. */
  onRecord(cb: () => void): () => void { return this.listeners.add(cb); }

  /** Wait for a record after `seq` (or `signal`). */
  waitFor(seq: number, signal?: AbortSignal): Promise<boolean> {
    if (this.nextSeq > seq) return Promise.resolve(true);
    return abortableWait(this.waiters, signal);
  }

  /**
   * syslog(2): the action's result, with text written to `out` for the read
   * actions (`<prio>[ secs.usecs] text\n` records, the newest that fit).
   */
  async syslogAction(type: number, out: Uint8Array, len: number, signal?: AbortSignal): Promise<number> {
    switch (type) {
      case SYSLOG_ACTION_CLOSE:
      case SYSLOG_ACTION_OPEN:
      case SYSLOG_ACTION_CONSOLE_OFF:
      case SYSLOG_ACTION_CONSOLE_ON:
        return 0;
      case SYSLOG_ACTION_CONSOLE_LEVEL:
        if (len < 1 || len > 8) return -A.EINVAL;
        this.consoleLevel = len - 1;
        return 0;
      case SYSLOG_ACTION_CLEAR:
        this.clear();
        return 0;
      case SYSLOG_ACTION_SIZE_BUFFER:
        return this.maxBytes;
      case SYSLOG_ACTION_SIZE_UNREAD:
        return this.syslogBytes(this.since(Math.max(this.readSeq, this.firstSeq))).length;
      case SYSLOG_ACTION_READ: {
        if (len < 0) return -A.EINVAL;
        if (len === 0) return 0;
        while (Math.max(this.readSeq, this.firstSeq) >= this.nextSeq) {
          if (!(await this.waitFor(this.readSeq, signal))) return -A.EINTR;
        }
        this.readSeq = Math.max(this.readSeq, this.firstSeq);
        // Whole records, oldest first, as many as fit
        let n = 0;
        while (this.readSeq < this.nextSeq) {
          const b = this.syslogBytes([this.get(this.readSeq)!]);
          if (n + b.length > Math.min(len, out.length)) break;
          out.set(b, n);
          n += b.length;
          this.readSeq++;
        }
        return n;
      }
      case SYSLOG_ACTION_READ_ALL:
      case SYSLOG_ACTION_READ_CLEAR: {
        if (len < 0) return -A.EINVAL;
        const cap = Math.min(len, out.length);
        // The newest whole records that fit
        const recs = this.all();
        const parts: Uint8Array[] = [];
        let n = 0;
        for (let i = recs.length - 1; i >= 0; i--) {
          const b = this.syslogBytes([recs[i]]);
          if (n + b.length > cap) break;
          parts.unshift(b);
          n += b.length;
        }
        let off = 0;
        for (const p of parts) { out.set(p, off); off += p.length; }
        if (type === SYSLOG_ACTION_READ_CLEAR) this.clear();
        return off;
      }
      default:
        return -A.EINVAL;
    }
  }

  private syslogBytes(records: KlogRecord[]): Uint8Array {
    return enc.encode(records.map(r => `<${r.facility * 8 + r.level}>${formatTimestamp(r.usec)} ${r.text}\n`).join(''));
  }
}

/** /dev/kmsg: one open's view of the log, with its own read position. */
export class KmsgFile implements OpenFile {
  kind: OpenFileKind = 'dev';
  path = '/dev/kmsg';
  private seq: number;

  constructor(private log: KernelLog, public flags: number) {
    this.seq = log.firstSeq;
  }

  async read(buf: Uint8Array, signal?: AbortSignal): Promise<number> {
    if ((this.flags & A.O_ACCMODE) === A.O_WRONLY) return -A.EBADF;
    for (;;) {
      if (this.seq < this.log.firstSeq) {
        // Overwritten before we read them: report it once, then go on from the oldest left
        this.seq = this.log.firstSeq;
        return -A.EPIPE;
      }
      const r = this.log.get(this.seq);
      if (r) {
        const b = enc.encode(formatKmsg(r));
        if (b.length > buf.length) return -A.EINVAL;
        buf.set(b);
        this.seq++;
        return b.length;
      }
      if (this.flags & A.O_NONBLOCK) return -A.EAGAIN;
      if (!(await this.log.waitFor(this.seq, signal))) return -A.EINTR;
    }
  }

  async write(buf: Uint8Array): Promise<number> {
    let text = A.decodeText(buf).replace(/\n+$/, '');
    let prio = LOG_USER * 8 + LOG_WARNING;
    const m = /^<(\d+)>/.exec(text);
    if (m) {
      const p = Number(m[1]);
      // Userspace can't log as the kernel facility (Linux turns LOG_KERN into LOG_USER)
      prio = p < 8 ? LOG_USER * 8 + p : p;
      text = text.slice(m[0].length);
    }
    this.log.log(prio & 7, text, prio >> 3);
    return buf.length;
  }

  seek(off: number, whence: number): number {
    if (off !== 0) return -A.ESPIPE;
    if (whence === A.SEEK_SET) this.seq = this.log.firstSeq;
    else if (whence === A.SEEK_END) this.seq = this.log.lastSeq;
    else if (whence === 3 /* SEEK_DATA */) this.seq = this.log.clearPoint;
    else return -A.EINVAL;
    return 0;
  }

  poll(events: number): number {
    let r = A.POLLOUT;
    if (this.log.get(this.seq) || this.seq < this.log.firstSeq) r |= A.POLLIN;
    return r & (events | A.POLLERR);
  }

  onReady(cb: () => void): () => void { return this.log.onRecord(cb); }
  async stat(): Promise<A.KStat> { return { ...charDevStat(0x10b), mode: A.S_IFCHR | 0o644 }; }
  async close(): Promise<void> {}
}

const g = globalThis as { __tabcomputerKlog?: KernelLog };

/** The page's kernel log (one per page, shared by every Kernel instance, like Linux's). */
export const klog: KernelLog = g.__tabcomputerKlog ?? (g.__tabcomputerKlog = new KernelLog());

/** Log to the kernel log. */
export function printk(level: number, text: string): void {
  klog.log(level, text);
}

/** printk with identical lines rate-limited (retry loops). */
export function printkRatelimited(level: number, text: string): void {
  klog.logRatelimited(level, text);
}
