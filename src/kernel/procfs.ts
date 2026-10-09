/**
 * /proc as the kernel sees it: per-process directories (`/proc/PID`,
 * `/proc/self`) and the system files that need the process table
 * (`/proc/stat`, `/proc/loadavg`, `/proc/uptime`). Everything else under /proc
 * (cpuinfo, meminfo, version, ...) is the FileSystem's virtual provider.
 *
 * The kernel consults `ProcFs` before the filesystem in open, stat, readlink
 * and getdents. Files are generated when opened (a snapshot, like Linux's
 * seq_file), so `cat /proc/PID/stat` and ps/top/htop read consistent lines.
 *
 * CPU time is an estimate: a process's wall time minus the time it spends
 * inside kernel syscalls (`Process.kernelMs`), for processes that make
 * syscalls through a channel (programs in workers). A busy loop shows as
 * busy, a shell waiting at its prompt as idle. Memory sizes are not known to
 * the kernel and read as 0.
 */
import * as A from './abi';
import { DirFile, ReadyListeners, type OpenFile } from './fd';
import type { FileSystem } from '../filesystem';
import type { Kernel } from './kernel';
import type { Process } from './process';

/** USER_HZ: the clock ticks /proc counts in. */
const HZ = 100;
/** When this page "booted": /proc/uptime, btime and process start times count from here. */
export const bootMs = Date.now();
const PAGE = 4096;

type Node =
  | { type: 'dir'; list: () => string[] }
  | { type: 'file'; text: () => string }
  | { type: 'link'; target: () => string };

/** A directory under /proc; getdents reads its generated entries. */
class ProcDirFile extends DirFile {
  constructor(fs: FileSystem, path: string, flags: number, private names: () => string[]) {
    super(fs, path, flags);
  }
  private list: string[] | null = null;
  override seek(off: number, whence: number): number {
    if (whence === A.SEEK_SET && off === 0) { this.list = null; return 0; }
    return -A.ESPIPE;
  }
  override async readdir(): Promise<string[] | number> {
    this.list ??= ['.', '..', ...this.names()];
    return this.list;
  }
  override consume(n: number): void { this.list?.splice(0, n); }
  override async stat(): Promise<A.KStat> { return dirStat(this.path); }
}

/**
 * A generated /proc file: its text is taken when first read after open or a
 * seek back to the start, so programs that keep it open and rewind it
 * (procps' /proc/stat, top's refresh) see fresh values, as on Linux.
 */
class ProcFile implements OpenFile {
  kind = 'file' as const;
  private data: Uint8Array | null = null;
  private pos = 0;
  private listeners = new ReadyListeners();
  constructor(public path: string, public flags: number, private text: () => string) {}
  private snapshot(): Uint8Array {
    this.data ??= new TextEncoder().encode(this.text());
    return this.data;
  }
  async read(buf: Uint8Array): Promise<number> {
    const d = this.snapshot();
    const n = Math.max(0, Math.min(buf.length, d.length - this.pos));
    buf.set(d.subarray(this.pos, this.pos + n));
    this.pos += n;
    return n;
  }
  async pread(buf: Uint8Array, off: number): Promise<number> {
    const d = off === 0 ? (this.data = new TextEncoder().encode(this.text())) : this.snapshot();
    const n = Math.max(0, Math.min(buf.length, d.length - off));
    buf.set(d.subarray(off, off + n));
    return n;
  }
  async write(): Promise<number> { return -A.EBADF; }
  seek(off: number, whence: number): number {
    const base = whence === A.SEEK_SET ? 0 : whence === A.SEEK_CUR ? this.pos : whence === A.SEEK_END ? this.snapshot().length : -1;
    if (base < 0 || base + off < 0) return -A.EINVAL;
    this.pos = base + off;
    if (this.pos === 0) this.data = null; // regenerate on the next read
    return this.pos;
  }
  poll(events: number): number { return events & (A.POLLIN | A.POLLOUT); }
  onReady(cb: () => void): () => void { return this.listeners.add(cb); }
  async stat(): Promise<A.KStat> {
    const now = Date.now();
    return {
      dev: 4, ino: procIno(this.path), mode: A.S_IFREG | 0o444, nlink: 1, uid: 1000, gid: 1000, rdev: 0,
      size: 0, blksize: 1024, blocks: 0, atimeMs: now, mtimeMs: now, ctimeMs: now,
    };
  }
  async close(): Promise<void> {}
}

function dirStat(path: string): A.KStat {
  return {
    dev: 4, ino: procIno(path), mode: A.S_IFDIR | 0o555, nlink: 2, uid: 1000, gid: 1000, rdev: 0,
    size: 0, blksize: 1024, blocks: 0, atimeMs: bootMs, mtimeMs: bootMs, ctimeMs: bootMs,
  };
}

const procInos = new Map<string, number>();
function procIno(path: string): number {
  let n = procInos.get(path);
  if (!n) { n = 0x40000000 + procInos.size; procInos.set(path, n); }
  return n;
}

/** Linux's new_encode_dev */
function encodeDev(major: number, minor: number): number {
  return (minor & 0xff) | (major << 8) | ((minor & ~0xff) << 12);
}

export class ProcFs {
  constructor(private kernel: Kernel) {}

  /** CPU time of processes gone from the table, and the last value seen per pid (counters only grow). */
  private retiredMs = 0;
  private seenMs = new Map<number, number>();
  /** The last /proc/stat counters handed out: top and vmstat reject counters that go backwards. */
  private lastUser = 0;
  private lastIdle = 0;

  /** Total CPU ms of every process so far, alive or not. */
  private totalCpuMs(now: number): number {
    let live = 0;
    const alive = new Set<number>();
    for (const p of this.live()) {
      const ms = ProcFs.cpuMs(p, now);
      live += ms;
      alive.add(p.pid);
      this.seenMs.set(p.pid, ms);
    }
    for (const [pid, ms] of this.seenMs) {
      if (!alive.has(pid)) { this.retiredMs += ms; this.seenMs.delete(pid); }
    }
    return this.retiredMs + live;
  }

  /** CPU time of `p` in ms (see the file comment). */
  static cpuMs(p: Process, now = Date.now()): number {
    if (!p.syscalls) return 0;
    const end = p.state === 'zombie' && p.exitTime ? p.exitTime : now;
    return Math.max(0, end - p.startTime - p.kernelMs);
  }

  private live(): Process[] {
    return [...this.kernel.procs.values()].filter((p) => p.pid > 0).sort((a, b) => a.pid - b.pid);
  }

  /** The node at `path` (absolute, normalized), undefined when it isn't ours. */
  private node(proc: Process, path: string): Node | undefined {
    if (path === '/proc') {
      return { type: 'dir', list: () => [...new Set([...this.fsNames(), 'self', 'thread-self', ...this.live().map((p) => String(p.pid))])] };
    }
    if (!path.startsWith('/proc/')) return undefined;
    const parts = path.slice(6).split('/');
    const head = parts[0];
    if (head === 'self' || head === 'thread-self') {
      if (parts.length === 1) return { type: 'link', target: () => String(proc.pid) };
      return this.pidNode(proc, proc, parts.slice(1));
    }
    if (/^\d+$/.test(head)) {
      const p = this.kernel.procs.get(Number(head));
      if (!p) return undefined;
      return parts.length === 1 ? { type: 'dir', list: () => PID_ENTRIES } : this.pidNode(proc, p, parts.slice(1));
    }
    if (parts.length !== 1) return undefined;
    switch (head) {
      case 'stat': return { type: 'file', text: () => this.statText() };
      case 'vmstat': return { type: 'file', text: () => VMSTAT_KEYS.map((k) => `${k} 0`).join('\n') + '\n' };
      case 'loadavg': return { type: 'file', text: () => this.loadavgText() };
      case 'uptime': return { type: 'file', text: () => {
        const up = (Date.now() - bootMs) / 1000;
        const idle = Math.max(0, up * this.ncpu() - this.live().reduce((s, p) => s + ProcFs.cpuMs(p) / 1000, 0));
        return `${up.toFixed(2)} ${idle.toFixed(2)}\n`;
      } };
    }
    return undefined;
  }

  private pidNode(caller: Process, p: Process, rest: string[]): Node | undefined {
    const [name, sub] = rest;
    if (rest.length === 2 && name === 'fd') {
      const f = p.fds.get(Number(sub));
      if (!/^\d+$/.test(sub) || !f) return undefined;
      return { type: 'link', target: () => fdTarget(f) };
    }
    if (rest.length === 2 && name === 'task' && sub === String(p.pid)) return { type: 'dir', list: () => PID_ENTRIES.filter((e) => e !== 'task') };
    if (rest.length === 3 && name === 'task' && sub === String(p.pid)) return this.pidNode(caller, p, rest.slice(2));
    if (rest.length !== 1) return undefined;
    switch (name) {
      case 'fd': return { type: 'dir', list: () => p.fds.entries().map(([fd]) => String(fd)) };
      case 'task': return { type: 'dir', list: () => [String(p.pid)] };
      case 'cwd': return { type: 'link', target: () => p.cwd };
      // A runner can name the program the process reports as itself (a WASI package's "self")
      // Linux gives the resolved path: glibc's ld.so expands $ORIGIN from it, and a
      // venv's bin/python is a symlink to an interpreter with RUNPATH $ORIGIN/../lib
      // (readlink also resolves what isn't cached)
      case 'exe': return { type: 'link', target: () => {
        const exe = typeof p.data.exe === 'string' ? p.data.exe : p.path;
        return (exe.startsWith('/') && this.kernel.fs?.realpathCached?.(exe)) || exe;
      } };
      case 'root': return { type: 'link', target: () => '/' };
      case 'cmdline': return { type: 'file', text: () => (p.state === 'zombie' ? '' : p.argv.map((a) => a + '\0').join('')) };
      case 'comm': return { type: 'file', text: () => p.comm.slice(0, 15) + '\n' };
      case 'environ': return { type: 'file', text: () => Object.entries(p.env).map(([k, v]) => `${k}=${v}\0`).join('') };
      case 'stat': return { type: 'file', text: () => this.pidStat(p) };
      case 'statm': return { type: 'file', text: () => '0 0 0 0 0 0 0\n' };
      case 'status': return { type: 'file', text: () => this.pidStatus(p) };
      case 'io': return { type: 'file', text: () => 'rchar: 0\nwchar: 0\nsyscr: 0\nsyscw: 0\nread_bytes: 0\nwrite_bytes: 0\ncancelled_write_bytes: 0\n' };
      case 'mounts': return { type: 'file', text: () => 'shirofs / shirofs rw 0 0\nproc /proc proc rw 0 0\n' };
    }
    return undefined;
  }

  private fsNames(): string[] {
    // The FileSystem's virtual /proc entries (cpuinfo, meminfo, version, ...)
    const fsAny = this.kernel.fs as unknown as { virtualProviders?: { readdir?(p: string): string[] | null }[] } | undefined;
    for (const vp of fsAny?.virtualProviders ?? []) {
      const list = vp.readdir?.('/proc');
      if (list) return list.filter((n) => n !== 'self' && !/^\d+$/.test(n));
    }
    return ['cpuinfo', 'meminfo', 'version', 'filesystems', 'mounts'];
  }

  private ncpu(): number {
    return (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  }

  private stateLetter(p: Process): string {
    if (p.state === 'zombie') return 'Z';
    if (p.state === 'stopped') return 'T';
    return p.sleeping() || !p.syscalls ? 'S' : 'R';
  }

  private ttyOf(p: Process): { nr: number; tpgid: number } {
    const t = p.ctty as (OpenFile & { pty?: { index: number; fgPgrp: number } }) | undefined;
    if (!t?.pty) return { nr: 0, tpgid: -1 };
    return { nr: encodeDev(136, t.pty.index), tpgid: t.pty.fgPgrp || -1 };
  }

  private pidStat(p: Process): string {
    const now = Date.now();
    const ticks = (ms: number) => Math.floor(ms / (1000 / HZ));
    const cpu = ticks(ProcFs.cpuMs(p, now));
    const { nr, tpgid } = this.ttyOf(p);
    const f = [
      p.pid, `(${p.comm.slice(0, 15)})`, this.stateLetter(p), p.ppid, p.pgid, p.sid, nr, tpgid,
      0x400000, 0, 0, 0, 0, cpu, 0, 0, 0, 20, 0, 1 + p.tids.size, 0, ticks(p.startTime - bootMs),
      0, 0, '18446744073709551615', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 17, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ];
    return f.join(' ') + '\n';
  }

  private pidStatus(p: Process): string {
    const st = this.stateLetter(p);
    const names: Record<string, string> = { R: 'R (running)', S: 'S (sleeping)', T: 'T (stopped)', Z: 'Z (zombie)' };
    const pending = [...p.pendingSignals].reduce((m, s) => m | (1n << BigInt(s - 1)), 0n);
    const blocked = [...p.sigmask].reduce((m, s) => m | (1n << BigInt(s - 1)), 0n);
    const ignored = [...p.dispositions].filter(([, d]) => d === 'ignore').reduce((m, [s]) => m | (1n << BigInt(s - 1)), 0n);
    const caught = [...p.dispositions].filter(([, d]) => typeof d === 'number').reduce((m, [s]) => m | (1n << BigInt(s - 1)), 0n);
    const hex = (n: bigint) => n.toString(16).padStart(16, '0');
    return [
      `Name:\t${p.comm.slice(0, 15)}`, `Umask:\t${p.umask.toString(8).padStart(4, '0')}`, `State:\t${names[st]}`,
      `Tgid:\t${p.pid}`, 'Ngid:\t0', `Pid:\t${p.pid}`, `PPid:\t${p.ppid}`, 'TracerPid:\t0',
      'Uid:\t1000\t1000\t1000\t1000', 'Gid:\t1000\t1000\t1000\t1000', `FDSize:\t${Math.max(64, p.fds.size)}`, 'Groups:\t1000',
      'VmPeak:\t       0 kB', 'VmSize:\t       0 kB', 'VmRSS:\t       0 kB', `Threads:\t${1 + p.tids.size}`,
      `SigPnd:\t${hex(0n)}`, `ShdPnd:\t${hex(pending)}`, `SigBlk:\t${hex(blocked)}`, `SigIgn:\t${hex(ignored)}`, `SigCgt:\t${hex(caught)}`,
      `Cpus_allowed_list:\t0-${this.ncpu() - 1}`, 'voluntary_ctxt_switches:\t0', 'nonvoluntary_ctxt_switches:\t0',
    ].join('\n') + '\n';
  }

  private statText(): string {
    const now = Date.now();
    const n = this.ncpu();
    const ticks = (ms: number) => Math.floor(ms / (1000 / HZ));
    const procs = this.live();
    const user = this.lastUser = Math.max(this.lastUser, ticks(this.totalCpuMs(now)));
    const idle = this.lastIdle = Math.max(this.lastIdle, ticks((now - bootMs) * n) - user);
    const line = (name: string, u: number, i: number) => `${name} ${u} 0 0 ${i} 0 0 0 0 0 0`;
    const lines = [line('cpu ', user, idle)];
    for (let c = 0; c < n; c++) lines.push(line(`cpu${c}`, Math.floor(user / n), Math.floor(idle / n)));
    const running = procs.filter((p) => this.stateLetter(p) === 'R').length;
    lines.push('intr 0', 'ctxt 0', `btime ${Math.floor(bootMs / 1000)}`, `processes ${this.kernel.lastPid}`,
      `procs_running ${Math.max(1, running)}`, 'procs_blocked 0');
    return lines.join('\n') + '\n';
  }

  private loadavgText(): string {
    const procs = this.live();
    const running = procs.filter((p) => this.stateLetter(p) === 'R').length;
    const l = running.toFixed(2);
    return `${l} ${l} ${l} ${Math.max(1, running)}/${procs.length} ${this.kernel.lastPid}\n`;
  }

  // ── what the kernel calls ──

  /** readlink(2) of a /proc path: the target, -errno, or undefined when it isn't ours. */
  readlink(proc: Process, path: string): string | number | undefined {
    const n = this.node(proc, path);
    if (!n) return path.startsWith('/proc/') && this.ownsPrefix(path) ? -A.ENOENT : undefined;
    return n.type === 'link' ? n.target() : -A.EINVAL;
  }

  /** stat/lstat of a /proc path; undefined when it isn't ours. */
  stat(proc: Process, path: string, follow: boolean): A.KStat | number | undefined {
    let n = this.node(proc, path);
    if (!n) return path.startsWith('/proc/') && this.ownsPrefix(path) ? -A.ENOENT : undefined;
    if (n.type === 'link' && follow) {
      const target = n.target();
      if (!target.startsWith('/')) n = this.node(proc, `/proc/${target}`); // /proc/self
      else return undefined; // the kernel stats the target itself
      if (!n) return -A.ENOENT;
    }
    if (n.type === 'dir') return dirStat(path);
    const now = Date.now();
    return {
      dev: 4, ino: procIno(path), mode: n.type === 'link' ? A.S_IFLNK | 0o777 : A.S_IFREG | 0o444, nlink: 1,
      uid: 1000, gid: 1000, rdev: 0, size: 0, blksize: 1024, blocks: 0, atimeMs: now, mtimeMs: now, ctimeMs: now,
    };
  }

  /** Where a /proc link points (for open/stat to follow); undefined when `path` isn't a /proc link. */
  linkTarget(proc: Process, path: string): string | undefined {
    const n = this.node(proc, path);
    if (n?.type !== 'link') return undefined;
    const t = n.target();
    return t.startsWith('/') ? t : `/proc/${t}`;
  }

  /** open(2) of a /proc file or directory; undefined when it isn't ours. */
  open(proc: Process, path: string, flags: number): OpenFile | number | undefined {
    const n = this.node(proc, path);
    if (!n) return path.startsWith('/proc/') && this.ownsPrefix(path) ? -A.ENOENT : undefined;
    if (n.type === 'link') return undefined; // the kernel follows it
    if ((flags & A.O_ACCMODE) !== A.O_RDONLY) return -A.EACCES;
    if (n.type === 'dir') return new ProcDirFile(this.kernel.fs!, path, flags, n.list);
    if (flags & A.O_DIRECTORY) return -A.ENOTDIR;
    return new ProcFile(path, flags, n.text);
  }

  /** /proc/PID/... and /proc/self/... are wholly ours (a missing entry is ENOENT, not the FileSystem's). */
  private ownsPrefix(path: string): boolean {
    const head = path.slice(6).split('/')[0];
    return /^\d+$/.test(head) || head === 'self' || head === 'thread-self';
  }
}

/** /proc/vmstat: the counters vmstat(8) reads, all 0 (there is no paging to count). */
const VMSTAT_KEYS = [
  'nr_free_pages', 'nr_inactive_anon', 'nr_active_anon', 'nr_inactive_file', 'nr_active_file', 'nr_dirty', 'nr_writeback',
  'pgpgin', 'pgpgout', 'pswpin', 'pswpout', 'pgfault', 'pgmajfault', 'pgfree', 'pgsteal_kswapd', 'pgsteal_direct',
  'pgscan_kswapd', 'pgscan_direct', 'pgalloc_normal', 'pgactivate', 'pgdeactivate',
];

const PID_ENTRIES = ['cmdline', 'comm', 'cwd', 'environ', 'exe', 'fd', 'io', 'mounts', 'root', 'stat', 'statm', 'status', 'task'];

/** What /proc/PID/fd/N points at. */
function fdTarget(f: OpenFile): string {
  if (f.path) return f.path;
  const ino = (f as { ino?: number }).ino ?? 0;
  switch (f.kind) {
    case 'pipe': return `pipe:[${ino}]`;
    case 'socket': return `socket:[${ino}]`;
    case 'epoll': return 'anon_inode:[eventpoll]';
    default: return 'anon_inode:[shiro]';
  }
}
