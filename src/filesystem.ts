import { decodeBytes, encodeText } from './utils/byte-text';
import { activeProfile, unameRelease, UNAME_VERSION } from './profile';
import { memoryInfo } from './utils/sysinfo';

function globPatternToRegex(pattern: string, base: string, caseInsensitive?: boolean): RegExp {
  // Resolve the pattern relative to base
  let fullPattern: string;
  if (pattern.startsWith('/')) {
    fullPattern = pattern;
  } else {
    fullPattern = (base === '/' ? '/' : base + '/') + pattern;
  }

  let regex = '^';
  let i = 0;
  while (i < fullPattern.length) {
    const ch = fullPattern[i];
    if (ch === '*' && fullPattern[i + 1] === '*') {
      if (fullPattern[i + 2] === '/') {
        regex += '(?:.*/)?';
        i += 3;
      } else {
        regex += '.*';
        i += 2;
      }
    } else if (ch === '*') {
      regex += '[^/]*';
      i++;
    } else if (ch === '?') {
      regex += '[^/]';
      i++;
    } else if (ch === '.') {
      regex += '\\.';
      i++;
    } else if (ch === '{') {
      // Handle brace expansion like {ts,tsx}
      const close = fullPattern.indexOf('}', i);
      if (close > i) {
        const options = fullPattern.slice(i + 1, close).split(',');
        regex += '(?:' + options.map(o => o.replace(/\./g, '\\.')).join('|') + ')';
        i = close + 1;
      } else {
        regex += '\\{';
        i++;
      }
    } else {
      regex += ch.replace(/[[\]()\\^$|+]/g, '\\$&');
      i++;
    }
  }
  regex += '$';
  return new RegExp(regex, caseInsensitive ? 'i' : undefined);
}

const DB_NAME = 'tabcomputer-fs';
const DB_VERSION = 1;
const STORE_NAME = 'files';

/**
 * Big files (FSNode.blob): the bytes are stored in BLOCK-sized records next
 * to the nodes, keyed BLOCK_KEY + blob id + '/' + block index (8 hex
 * digits), so a file being written goes to IndexedDB a block at a time and
 * the kernel reads it a block at a time, never holding all of it. Keys
 * starting with \u0001 sort before every path ('/') and are never files.
 * BLOB_MAP_KEY holds which path owns which blob, so deleting or replacing a
 * file (rm -r of its directory included) deletes its blocks.
 */
const BLOCK_KEY = '\u0001b/';
const BLOB_MAP_KEY = '\u0001blobs';
const isInternalKey = (k: string) => k.charCodeAt(0) === 1;
const blockKey = (id: string, i: number) => BLOCK_KEY + id + '/' + i.toString(16).padStart(8, '0');

export interface FSNode {
  path: string;
  type: 'file' | 'dir' | 'symlink';
  content: Uint8Array | null;
  mode: number;
  mtime: number;
  ctime: number;
  size: number;
  symlinkTarget?: string;
  /** Access time when set apart from mtime (utimensat); absent = follows mtime. */
  atime?: number;
  /** Nanoseconds past atime/mtime (0-999999), when set with nanosecond precision. */
  atimeNs?: number;
  mtimeNs?: number;
  /**
   * Content not fetched yet (`content` is null, `size` is the real size):
   * a file of a streamed root filesystem (src/debian/rootfs.ts). The first
   * read fetches it through the registered lazy loader and stores it.
   */
  lazy?: LazyRef;
  /**
   * The bytes are in block records of this id (see BLOCK_KEY), not in
   * `content`. In memory, `content` may still hold all of them (a file just
   * written with writeFile, or read with readFile); in IndexedDB it is null.
   */
  blob?: string;
  /**
   * A special file: 'fifo' is a named pipe (mkfifo). It is stored like an
   * empty regular file; the kernel attaches opens of it to a pipe.
   */
  special?: 'fifo';
  /**
   * Inode number (st_ino), assigned when the node is created and kept by
   * writes, chmod, utimes and rename, so it is stable across reloads. Nodes
   * stored before this field (and streamed root filesystem placeholders) have
   * none: their number is a hash of their path, written into the node when it
   * is renamed. See FileSystem.inoOf.
   */
  ino?: number;
}

/** A 52-bit number from two 32-bit hashes of `path` (inode number of a node without one). */
function pathIno(path: string): number {
  let a = 0x811c9dc5, b = 0x9747b28c;
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995); b ^= b >>> 15;
  }
  return ((a >>> 0) & 0xfffff) * 0x100000000 + (b >>> 0) || 3;
}

/**
 * A pending delete of everything under a directory (rm -r), queued in
 * FileSystem._dirty under this prefix + the directory's path. One IndexedDB
 * range delete instead of one delete per key: 10,000 keys took 3.7 s one by
 * one, 0.3 s as a range (in a large store, 38 s one by one after an npm install).
 */
const RANGE = '\0range:';

/** Bytes a queued record adds to IndexedDB (a blob node's are in its block records). */
function storedBytes(node: FSNode | null | undefined): number {
  return node && !node.blob ? node.content?.byteLength ?? 0 : 0;
}

/** A fresh random 52-bit inode number (unique enough; not a secret, so no crypto: one per created file) */
function newIno(): number {
  return Math.floor(Math.random() * 0x10000000000000) || 3;
}

/** Where a lazy file's bytes are: `len` bytes at `off` in chunk `chunk` of source `src`. */
export interface LazyRef { src: string; chunk: string; off: number }

/** Fetches a lazy file's bytes (FileSystem.setLazyLoader). */
export type LazyLoader = (ref: LazyRef, size: number, path: string) => Promise<Uint8Array>;

export interface StatResult {
  type: 'file' | 'dir' | 'symlink';
  mode: number;
  size: number;
  mtime: Date;
  ctime: Date;
  /** Access time (equal to mtime unless set apart with utimes). */
  atimeMs?: number;
  /** Nanoseconds past mtime/atime (0-999999). */
  mtimeNs?: number;
  atimeNs?: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  /** A named pipe (FSNode.special === 'fifo'). */
  isFIFO(): boolean;
}

export function makeStat(node: FSNode): StatResult {
  const mtime = new Date(node.mtime);
  const ctime = new Date(node.ctime);
  const atime = node.atime === undefined ? mtime : new Date(node.atime);
  return {
    type: node.type,
    mode: node.mode,
    size: node.size,
    mtime,
    ctime,
    atime,
    birthtime: ctime,
    mtimeMs: mtime.getTime(),
    ctimeMs: ctime.getTime(),
    atimeMs: atime.getTime(),
    mtimeNs: node.mtimeNs ?? 0,
    atimeNs: node.atime === undefined ? node.mtimeNs ?? 0 : node.atimeNs ?? 0,
    birthtimeMs: ctime.getTime(),
    // The kernel's st_dev and st_ino (src/kernel/fd.ts inodeNumber), for node programs and ls -i
    dev: 1,
    ino: node.ino ?? pathIno(node.path),
    nlink: 1,
    uid: 1000,
    gid: 1000,
    rdev: 0,
    blksize: 4096,
    blocks: Math.ceil(node.size / 512),
    isFile() { return node.type === 'file'; },
    isDirectory() { return node.type === 'dir'; },
    isSymbolicLink() { return node.type === 'symlink'; },
    isBlockDevice() { return false; },
    isCharacterDevice() { return false; },
    isFIFO() { return node.special === 'fifo'; },
    isSocket() { return false; },
  } as any;
}

/** Create an Error with a .code property for Node.js/isomorphic-git compatibility */
function fsError(code: string, message: string): Error {
  const err = new Error(message) as Error & { code: string; errno: number };
  err.code = code;
  // Add errno for isomorphic-git compatibility
  // Common errno values: ENOENT=-2, EISDIR=-21, ENOTDIR=-20, EEXIST=-17
  const errnos: Record<string, number> = {
    ENOENT: -2,
    EISDIR: -21,
    ENOTDIR: -20,
    EEXIST: -17,
    ENOTEMPTY: -39,
  };
  err.errno = errnos[code] || -1;
  return err;
}

export type FSChangeEvent = 'write' | 'delete' | 'mkdir' | 'rename';
export type FSChangeListener = (event: FSChangeEvent, path: string, newPath?: string) => void;

/**
 * Virtual filesystem provider for synthetic paths like /proc and /dev.
 */
export interface VirtualFSProvider {
  /** Check if this provider handles the given path */
  handles(path: string): boolean;
  /** Read file content (returns null if path is a directory) */
  readFile(path: string, encoding?: 'utf8'): string | Uint8Array | null;
  /** Stat a path (returns null if not found) */
  stat(path: string): StatResult | null;
  /** List directory entries (returns null if not a directory or not found) */
  readdir(path: string): string[] | null;
  /** Check existence */
  exists(path: string): boolean;
  /** Write (returns true if handled, even if silently discarded) */
  writeFile(path: string, data: Uint8Array | string): boolean;
  /** Top-level directory name this provider adds to `ls /` (e.g. 'dom') */
  mountPoint?: string;
  /** A symlink's target (null when `path` isn't one); stat follows it, lstat and readlink see it */
  readlink?(path: string): string | null;
  /** Stat without following a link (defaults to stat) */
  lstat?(path: string): StatResult | null;
}

/** /dev virtual provider */
class DevProvider implements VirtualFSProvider {
  handles(path: string): boolean {
    return path === '/dev/null' || path === '/dev/zero' || path === '/dev/full' || path === '/dev/random' || path === '/dev/urandom' || path === '/dev' || path === '/dev/stdin' || path === '/dev/stdout' || path === '/dev/stderr' || path === '/dev/fd';
  }
  readFile(path: string, encoding?: 'utf8'): string | Uint8Array | null {
    if (path === '/dev/null') return encoding === 'utf8' ? '' : new Uint8Array(0);
    // A page of zeros / random bytes; as text, byte-exact (src/utils/byte-text.ts)
    if (path === '/dev/zero' || path === '/dev/full') return encoding === 'utf8' ? '\0'.repeat(4096) : new Uint8Array(4096);
    if (path === '/dev/random' || path === '/dev/urandom') {
      const buf = new Uint8Array(256);
      crypto.getRandomValues(buf);
      return encoding === 'utf8' ? decodeBytes(buf) : buf;
    }
    if (path === '/dev') return null; // directory
    return encoding === 'utf8' ? '' : new Uint8Array(0);
  }
  stat(path: string): StatResult | null {
    if (path === '/dev') return makeStat({ path, type: 'dir', content: null, mode: 0o755, mtime: 0, ctime: 0, size: 0 });
    if (this.handles(path)) return makeStat({ path, type: 'file', content: new Uint8Array(0), mode: 0o666, mtime: 0, ctime: 0, size: 0 });
    return null;
  }
  readdir(path: string): string[] | null {
    // shm: a real directory (shm_open's files), the rest synthetic
    if (path === '/dev') return ['null', 'zero', 'full', 'random', 'urandom', 'stdin', 'stdout', 'stderr', 'fd', 'shm'];
    return null;
  }
  exists(path: string): boolean { return this.handles(path); }
  writeFile(path: string): boolean {
    if (path === '/dev/null') return true; // silently discard
    // /dev/full: every write fails (`echo hi >/dev/full` exits 1, as on Linux)
    if (path === '/dev/full') throw fsError('ENOSPC', "ENOSPC: no space left on device, write '/dev/full'");
    return this.handles(path); // other dev files: accept but discard
  }
}

/** A process as /proc/PID shows it */
export interface ProcInfo {
  pid: number; ppid: number; pgid: number; sid: number; comm: string;
  /** R running, S sleeping (in a syscall), T stopped, Z zombie */
  state: 'R' | 'S' | 'T' | 'Z';
  cmdline: string[];
  cwd?: string;
  environ?: Record<string, string>;
  /** The program file (/proc/PID/exe) */
  exe?: string;
  /** Open descriptors: fd number → what /proc/PID/fd/N points at */
  fds?: [number, string][];
  /** /proc/PID/stat's starttime and /proc/PID/status's Uid/Gid */
  startMs?: number;
  uid?: number;
  gid?: number;
  /** /proc/PID/syscall and wchan: what a kernel process is blocked in (kernel/procfs.ts's format) */
  syscall?: string;
  wchan?: string;
}
/** Somewhere /proc finds processes: the kernel's table, and in-page shells */
export interface ProcInfoSource {
  get(pid: number): ProcInfo | undefined;
  /** The pids to list in /proc */
  list?(): number[];
  /**
   * The entry at a /proc path when this source generates it itself (the
   * kernel's ProcFs: /proc/PID/syscall, wchan, task/, /proc/stat …), so
   * in-page commands read the same /proc as programs do.
   */
  node?(path: string): ProcPidNode | undefined;
}
const procInfoSources: ProcInfoSource[] = [];
/** Let /proc/PID describe processes from a process table (the kernel registers one, shell.ts another) */
export function addProcInfoSource(src: ProcInfoSource | ((pid: number) => ProcInfo | undefined)): void {
  procInfoSources.push(typeof src === 'function' ? { get: src } : src);
}
function procInfo(pid: number): ProcInfo | undefined {
  for (const s of procInfoSources) { const i = s.get(pid); if (i) return i; }
  return undefined;
}
/** A source's own entry at `path` (see ProcInfoSource.node) */
function sourceNode(path: string): ProcPidNode | undefined {
  for (const s of procInfoSources) { const n = s.node?.(path); if (n) return n; }
  return undefined;
}
function procPids(): number[] {
  const pids = new Set<number>();
  for (const s of procInfoSources) for (const p of s.list?.() ?? []) if (procInfo(p)) pids.add(p);
  return [...pids].sort((a, b) => a - b);
}
let procSelfPid: () => number | undefined = () => undefined;
/**
 * /proc/self for in-page commands: the pid of the shell running them (shell.ts).
 * (A kernel process's /proc/self is the kernel's ProcFs, which open() consults first.)
 */
export function setProcSelf(fn: () => number | undefined): void {
  procSelfPid = fn;
}
const PROC_PID_RE = /^\/proc\/(\d+|self|thread-self)(?:\/(.*))?$/;
const PROC_PID_FILES = ['cmdline', 'comm', 'cwd', 'environ', 'exe', 'fd', 'io', 'limits', 'mounts', 'root', 'stat', 'statm', 'status', 'syscall', 'task', 'wchan'];
type ProcPidNode = { dir: string[] } | { text: string } | { link: string };
/** Top-level /proc files the kernel generates from its process table (ProcInfoSource.node) */
const SYSTEM_NAMES = ['stat', 'loadavg', 'uptime', 'vmstat', 'sysvipc'];

/** /proc virtual provider — dynamic system info from Shiro */
class ProcProvider implements VirtualFSProvider {
  private startTime = Date.now();

  /** /proc/PID/… (and /proc/self/…) from the process sources, or null when there is no such process or entry */
  private pidNode(path: string): ProcPidNode | null {
    const m = PROC_PID_RE.exec(path);
    if (!m) return null;
    const self = m[1] === 'self' || m[1] === 'thread-self';
    const pid = self ? procSelfPid() : Number(m[1]);
    if (pid === undefined) return null;
    if (self && m[2] === undefined) return { link: String(pid) };
    const own = sourceNode(m[2] === undefined ? `/proc/${pid}` : `/proc/${pid}/${m[2]}`);
    if (own) return own;
    const info = procInfo(pid);
    if (!info) return null;
    let rest = m[2] ?? '';
    if (rest === '') return { dir: PROC_PID_FILES };
    // One thread per process here: task/PID is the process itself
    if (rest === 'task') return { dir: [String(pid)] };
    const task = /^task\/(\d+)(?:\/(.*))?$/.exec(rest);
    if (task) {
      if (Number(task[1]) !== pid) return null;
      if (task[2] === undefined) return { dir: PROC_PID_FILES.filter((f) => f !== 'task') };
      rest = task[2];
    }
    const fds = info.fds ?? [[0, '/dev/pts/0'], [1, '/dev/pts/0'], [2, '/dev/pts/0']];
    if (rest === 'fd') return { dir: fds.map(([fd]) => String(fd)) };
    const fdm = /^fd\/(\d+)$/.exec(rest);
    if (fdm) {
      const t = fds.find(([fd]) => fd === Number(fdm[1]));
      return t ? { link: t[1] } : null;
    }
    const uid = info.uid ?? 1000, gid = info.gid ?? 1000;
    switch (rest) {
      case 'cwd': return { link: info.cwd ?? '/' };
      case 'exe': return { link: info.exe ?? '/usr/bin/bash' };
      case 'root': return { link: '/' };
      case 'stat': {
        // pid (comm) state ppid pgrp session tty_nr tpgid flags … (52 fields)
        const rest = Array(45).fill('0');
        rest[0] = '-1'; // tpgid
        rest[12] = '20'; // priority
        rest[14] = '1'; // num_threads
        rest[16] = String(Math.max(0, Math.floor(((info.startMs ?? this.startTime) - this.startTime) / 10))); // starttime
        return { text: `${info.pid} (${info.comm}) ${info.state} ${info.ppid} ${info.pgid} ${info.sid} 0 ${rest.join(' ')}\n` };
      }
      case 'status': {
        const names: Record<string, string> = { R: 'R (running)', S: 'S (sleeping)', T: 'T (stopped)', Z: 'Z (zombie)' };
        return { text: [`Name:\t${info.comm}`, `State:\t${names[info.state]}`, `Tgid:\t${info.pid}`, `Pid:\t${info.pid}`,
          `PPid:\t${info.ppid}`, `Uid:\t${uid}\t${uid}\t${uid}\t${uid}`, `Gid:\t${gid}\t${gid}\t${gid}\t${gid}`,
          `FDSize:\t64`, 'Threads:\t1'].join('\n') + '\n' };
      }
      case 'cmdline': return { text: info.state === 'Z' ? '' : info.cmdline.map((a) => a + '\0').join('') };
      case 'comm': return { text: info.comm.slice(0, 15) + '\n' };
      case 'environ': return { text: Object.entries(info.environ ?? {}).map(([k, v]) => `${k}=${v}\0`).join('') };
      case 'syscall': return { text: info.syscall ?? 'running\n' };
      case 'wchan': return { text: info.wchan ?? '0' };
      case 'statm': return { text: '0 0 0 0 0 0 0\n' };
      case 'io': return { text: 'rchar: 0\nwchar: 0\nsyscr: 0\nsyscw: 0\nread_bytes: 0\nwrite_bytes: 0\ncancelled_write_bytes: 0\n' };
      case 'mounts': return { text: 'rootfs / rootfs rw 0 0\nproc /proc proc rw 0 0\n' };
      case 'limits': return { text: 'Limit                     Soft Limit           Hard Limit           Units     \n' +
        'Max open files            1024                 4096                 files     \n' };
    }
    return null;
  }

  private entries: Record<string, () => string> = {
    '/proc/uptime': () => {
      const secs = ((Date.now() - this.startTime) / 1000).toFixed(2);
      return `${secs} ${secs}\n`;
    },
    // What uname(2) says, as on Linux (`uname -rv`, Node's os.release())
    '/proc/version': () => `Linux version ${unameRelease()} (user@${activeProfile().hostname}) ${UNAME_VERSION} ${new Date(this.startTime).toUTCString()}\n`,
    '/proc/meminfo': () => {
      const { total, free, available } = memoryInfo();
      const toKB = (n: number) => Math.floor(n / 1024);
      return [
        `MemTotal:       ${toKB(total)} kB`,
        `MemFree:        ${toKB(free)} kB`,
        `MemAvailable:   ${toKB(available)} kB`,
        `Buffers:               0 kB`,
        `Cached:                0 kB`,
        `SwapTotal:             0 kB`,
        `SwapFree:              0 kB`,
      ].join('\n') + '\n';
    },
    '/proc/cpuinfo': () => {
      const cores = navigator?.hardwareConcurrency || 4;
      return Array.from({ length: cores }, (_, i) => [
        `processor\t: ${i}`,
        `model name\t: tabcomputer Virtual CPU`,
        `cpu MHz\t\t: 3000.000`,
        `cache size\t: 8192 KB`,
      ].join('\n')).join('\n\n') + '\n';
    },
    '/proc/loadavg': () => '0.00 0.00 0.00 1/1 1\n',
    '/proc/stat': () => 'cpu  0 0 0 0 0 0 0 0 0 0\n',
    '/proc/filesystems': () => 'nodev\trootfs\n',
    '/proc/sys/kernel/pid_max': () => '4194304\n',
    '/proc/sys/fs/pipe-max-size': () => '1048576\n',
    '/proc/sys/fs/pipe-user-pages-soft': () => '16384\n',
    '/proc/sys/fs/pipe-user-pages-hard': () => '0\n',
    '/proc/sys/kernel/tainted': () => '0\n',
    '/proc/sys/kernel/core_pattern': () => 'core\n',
    '/proc/mounts': () => 'rootfs / rootfs rw 0 0\n',
  };

  private dirs = ['/proc', '/proc/sys', '/proc/sys/kernel', '/proc/sys/fs'];

  handles(path: string): boolean {
    return path === '/proc' || path.startsWith('/proc/')
      && (path in this.entries || this.dirs.includes(path) || this.pidNode(path) !== null || this.systemNode(path) !== undefined);
  }

  /** /proc/stat, /proc/uptime, /proc/sysvipc/… as the kernel generates them, when there is one */
  private systemNode(path: string): ProcPidNode | undefined {
    const head = path.slice(6).split('/')[0];
    return path.startsWith('/proc/') && SYSTEM_NAMES.includes(head) ? sourceNode(path) : undefined;
  }

  readFile(path: string, encoding?: 'utf8'): string | Uint8Array | null {
    if (this.dirs.includes(path)) return null;
    let node = this.pidNode(path);
    // a link: read what it points at (/proc/self/environ through self)
    for (let hops = 0; node && 'link' in node && hops < 4; hops++) {
      const t = node.link;
      if (!t.startsWith('/proc/') && /^\d+$/.test(t)) node = this.pidNode(`/proc/${t}`);
      else return null;
    }
    node ??= this.systemNode(path) ?? null;
    if (node && 'dir' in node) return null;
    const gen = this.entries[path];
    if (!gen && !node) return null;
    const content = node && 'text' in node ? node.text : gen!();
    return encoding === 'utf8' ? content : new TextEncoder().encode(content);
  }

  /** /proc/self, /proc/PID/cwd, exe and fd/N are links */
  readlink(path: string): string | null {
    const node = this.pidNode(path);
    return node && 'link' in node ? node.link : null;
  }

  private nodeStat(path: string, node: ProcPidNode, follow: boolean): StatResult | null {
    if ('link' in node) {
      if (!follow) return makeStat({ path, type: 'symlink', content: null, mode: 0o777, mtime: Date.now(), ctime: this.startTime, size: node.link.length, symlinkTarget: node.link } as FSNode);
      if (/^\d+$/.test(node.link)) { const n = this.pidNode(`/proc/${node.link}`); return n ? this.nodeStat(`/proc/${node.link}`, n, true) : null; }
      return null; // the FileSystem follows it to a real path
    }
    if ('dir' in node) return makeStat({ path, type: 'dir', content: null, mode: 0o555, mtime: Date.now(), ctime: this.startTime, size: 0 });
    return makeStat({ path, type: 'file', content: new TextEncoder().encode(node.text), mode: 0o444, mtime: Date.now(), ctime: this.startTime, size: node.text.length });
  }

  stat(path: string, follow = true): StatResult | null {
    const node = this.pidNode(path) ?? this.systemNode(path);
    if (node) return this.nodeStat(path, node, follow);
    if (this.dirs.includes(path)) return makeStat({ path, type: 'dir', content: null, mode: 0o555, mtime: Date.now(), ctime: this.startTime, size: 0 });
    if (path in this.entries) {
      const content = this.entries[path]();
      return makeStat({ path, type: 'file', content: new TextEncoder().encode(content), mode: 0o444, mtime: Date.now(), ctime: this.startTime, size: content.length });
    }
    return null;
  }
  lstat(path: string): StatResult | null { return this.stat(path, false); }

  readdir(path: string): string[] | null {
    if (path === '/proc') {
      const entries: string[] = [];
      for (const key of Object.keys(this.entries)) {
        const rest = key.slice('/proc/'.length);
        if (!rest.includes('/')) entries.push(rest);
      }
      entries.push('self', 'sys');
      // (the kernel's own files: stat, uptime, vmstat, sysvipc …)
      for (const n of SYSTEM_NAMES) if (this.systemNode(`/proc/${n}`)) entries.push(n);
      return [...new Set(entries)].sort().concat(procPids().map(String));
    }
    if (this.dirs.includes(path)) {
      const prefix = path + '/';
      return [...new Set(Object.keys(this.entries).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).split('/')[0]))].sort();
    }
    let node = this.pidNode(path) ?? this.systemNode(path) ?? null;
    if (node && 'link' in node && /^\d+$/.test(node.link)) node = this.pidNode(`/proc/${node.link}`);
    return node && 'dir' in node ? node.dir : null;
  }

  exists(path: string): boolean { return this.handles(path); }
  writeFile(): boolean { return false; }
}

/** /var/log virtual provider — reads from ServiceManager's log buffer */
let _serviceManagerModule: { serviceManager: { getSyslog(): string } } | null = null;

class VarLogProvider implements VirtualFSProvider {
  private getSyslog(): string {
    // Access cached module or read from window global
    if (_serviceManagerModule) return _serviceManagerModule.serviceManager.getSyslog();
    if (typeof window !== 'undefined' && (window as any).__serviceManager?.getSyslog) {
      return (window as any).__serviceManager.getSyslog();
    }
    // Trigger lazy load for next time
    import('./service-manager').then(m => { _serviceManagerModule = m; }).catch(() => {});
    return '';
  }

  // Only syslog: /var/log itself is a real directory (dpkg and apt write
  // their logs there, systemd makes /var/log/journal), which readdir merges
  // this name into.
  handles(path: string): boolean {
    return path === '/var/log/syslog';
  }
  readFile(path: string, encoding?: 'utf8'): string | Uint8Array | null {
    const content = this.getSyslog();
    return encoding === 'utf8' ? content : new TextEncoder().encode(content);
  }
  stat(path: string): StatResult | null {
    if (path === '/var/log/syslog') {
      return makeStat({ path, type: 'file', content: new Uint8Array(0), mode: 0o644, mtime: Date.now(), ctime: 0, size: 0 });
    }
    return null;
  }
  readdir(): string[] | null {
    return null;
  }
  exists(path: string): boolean { return this.handles(path); }
  writeFile(): boolean { return false; }
}

/** Files every Unix system has, created when missing (named after the profile's machine). */
function baseEtcFiles(): Record<string, string> {
  const { hostname, name } = activeProfile();
  return {
    '/etc/passwd': `root:x:0:0:root:/root:/bin/sh\nuser:x:1000:1000:${name} user:/home/user:/bin/sh\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n`,
    '/etc/group': 'root:x:0:\ntty:x:5:user\nuser:x:1000:\nnogroup:x:65534:\n',
    '/etc/hostname': `${hostname}\n`,
    '/etc/hosts': `127.0.0.1\tlocalhost ${hostname}\n::1\tlocalhost ip6-localhost ip6-loopback\n`,
    '/etc/shells': '/bin/sh\n/bin/bash\n',
    '/etc/os-release': `NAME="${name}"\nPRETTY_NAME="${name}"\nID=${hostname}\nID_LIKE=debian\nHOME_URL="https://${activeProfile().brand?.domain ?? 'shiro.computer'}/"\n`,
  };
}

/** Run fn as a macrotask without timer clamping/throttling (MessageChannel),
 *  falling back to setTimeout where there is none. */
const scheduleMacrotask: (fn: () => void) => void = (() => {
  if (typeof MessageChannel === 'undefined') return (fn: () => void) => { setTimeout(fn, 0); };
  const queue: Array<() => void> = [];
  let ch: MessageChannel | null = null;
  return (fn: () => void) => {
    if (!ch) {
      ch = new MessageChannel();
      ch.port1.onmessage = () => { const f = queue.shift(); f?.(); };
      // Node (vitest): don't keep the process alive for an idle port
      (ch.port1 as any).unref?.();
      (ch.port2 as any).unref?.();
    }
    queue.push(fn);
    ch.port2.postMessage(0);
  };
})();

/** The node as IndexedDB should store it: a view into a larger buffer is
 *  copied out, since IndexedDB clones the whole ArrayBuffer behind it. */
function storableNode(node: FSNode): FSNode {
  if (node.blob) return node.content ? { ...node, content: null } : node;
  const c = node.content;
  if (c && (c.byteOffset !== 0 || c.byteLength !== c.buffer.byteLength)) return { ...node, content: c.slice() };
  return node;
}

/**
 * IndexedDB-backed filesystem with an in-memory node cache and write-behind.
 *
 * Mutations update the cache immediately and resolve; the IndexedDB writes are
 * queued (`_dirty`, latest value per path wins) and committed in ONE readwrite
 * transaction per flush. A flush is scheduled as a macrotask after the first
 * dirty write, so a burst of writes (npm install, `echo >> f` in a loop, a
 * shell history update per command) costs one transaction instead of one per
 * write. Only one flush transaction is in flight at a time; writes made while
 * it commits go into the next one.
 *
 * Crash safety: a write is durable once the flush that carries it commits,
 * normally within one event-loop turn. `sync()` (the `sync` command, kernel
 * fsync) waits for that with strict durability. The page flushes on
 * `visibilitychange` → hidden, `pagehide` and `freeze`, and `beforeunload`
 * warns while `pendingWrites > 0`. A tab or browser crash can lose writes
 * from the last moment before the flush (unlike a real disk's page cache, not
 * seconds' worth). Each flush is one transaction, so after a crash either
 * all of its writes are on disk or none are.
 */
export class FileSystem {
  private db: IDBDatabase | null = null;
  private cache: Map<string, FSNode | undefined> = new Map();
  /** Writes not yet handed to IndexedDB: path → node, or null for a delete. */
  private _dirty: Map<string, FSNode | null> = new Map();
  /** The batch being committed by the in-flight flush transaction. */
  private _inflight: Map<string, FSNode | null> | null = null;
  private _flushing: Promise<void> | null = null;
  private _flushScheduled = false;
  /** First error from a failed background flush, reported by the next sync(). */
  private _flushError: unknown = null;
  /**
   * The browser refused a commit for lack of space (QuotaExceededError). The
   * failed batch stays queued (nothing of it reached IndexedDB: one
   * transaction), and writes that need more space fail with ENOSPC until a
   * commit goes through: the user deletes something and the next flush
   * carries the deletes and the queued writes together.
   */
  private _full = false;
  private _fullListeners: Set<(full: boolean) => void> = new Set();
  /** Bytes written this page load, for onBigWrite. */
  private _bytesWritten = 0;
  private _bigWrite: { bytes: number; fn: () => void } | null = null;
  private _changeListeners: Set<FSChangeListener> = new Set();
  private virtualProviders: VirtualFSProvider[] = [new DevProvider(), new ProcProvider(), new VarLogProvider()];

  /** Mount a virtual provider (e.g. /dom, src/dom-fs.ts); consulted after the built-in ones. */
  addVirtualProvider(vp: VirtualFSProvider): void {
    if (!this.virtualProviders.includes(vp)) this.virtualProviders.push(vp);
  }

  /** st_ino of the node at canonical `path` (see FSNode.ino); the node is normally cached (just stat'ed). */
  inoOf(path: string): number {
    return this.cache.get(path)?.ino ?? pathIno(path);
  }

  /** Give the node at canonical `path` inode number `ino` (link(), which copies, makes the copy share its source's). */
  setIno(path: string, ino: number): void {
    const node = this.cache.get(path);
    if (node && node.ino !== ino) this._putNow({ ...node, ino });
  }

  /** Browser storage is full (see _full). */
  get storageFull(): boolean { return this._full; }

  /** Called with true when a commit fails for lack of space, false once one succeeds again. */
  onStorageFull(fn: (full: boolean) => void): () => void {
    this._fullListeners.add(fn);
    return () => { this._fullListeners.delete(fn); };
  }

  /** Call `fn` once, when this page load has written `bytes` (asking for persistent storage). */
  onBigWrite(bytes: number, fn: () => void): void { this._bigWrite = { bytes, fn }; }

  private _setFull(full: boolean): void {
    if (this._full === full) return;
    this._full = full;
    for (const fn of this._fullListeners) { try { fn(full); } catch {} }
  }

  private static _isQuotaError(e: unknown): boolean {
    const name = (e as any)?.name;
    return name === 'QuotaExceededError' || (e as any)?.code === 22 || /quota/i.test(String((e as any)?.message));
  }

  private _enospc(path?: string): Error {
    return fsError('ENOSPC', `ENOSPC: no space left on device (browser storage is full)${path ? `, write '${path}'` : ''}`);
  }

  /** Subscribe to filesystem change events. Returns unsubscribe function. */
  onChange(listener: FSChangeListener): () => void {
    this._changeListeners.add(listener);
    return () => { this._changeListeners.delete(listener); };
  }

  private _emitChange(event: FSChangeEvent, path: string, newPath?: string): void {
    for (const fn of this._changeListeners) {
      try { fn(event, path, newPath); } catch {}
    }
  }

  async init(): Promise<void> {
    this.db = await this._openDb();
    this._installLifecycleFlush();
    await this._loadBlobMap();

    // Ensure root directory exists
    const root = await this._get('/');
    if (!root) {
      await this._put(this._makeNode('/', 'dir'));
    }

    // Ensure basic directories exist
    for (const dir of ['/home', '/tmp', '/home/user', '/etc', '/var', '/var/log', '/dev', '/dev/shm']) {
      const existing = await this._get(dir);
      if (!existing) {
        // /dev/shm is a tmpfs on Linux: anyone may create files there (shm_open), sticky
        await this._put({ ...this._makeNode(dir, 'dir'), ...(dir === '/dev/shm' ? { mode: 0o1777 } : {}) });
      }
    }
    // The account database Unix programs look themselves up in (getpwuid:
    // ssh, git, vim's ~ expansion). The kernel runs everything as uid 1000.
    for (const [path, text] of Object.entries(baseEtcFiles())) {
      if (!(await this._get(path))) await this._put(this._makeNode(path, 'file', new TextEncoder().encode(text)));
    }
  }

  private _lazyLoader: LazyLoader | null = null;
  private _materializing = new Map<string, Promise<FSNode>>();

  /** Register the loader for lazy (not yet fetched) files; see FSNode.lazy. */
  setLazyLoader(loader: LazyLoader | null): void { this._lazyLoader = loader; }

  /**
   * Fetch a lazy file's content and store it as a regular file (the next read
   * is local). Concurrent readers share one fetch. A write that replaced the
   * node meanwhile wins over the fetched bytes.
   */
  private _materialize(node: FSNode): Promise<FSNode> {
    const path = node.path;
    let p = this._materializing.get(path);
    if (!p) {
      const ref = node.lazy!;
      if (!this._lazyLoader) return Promise.reject(fsError('EIO', `EIO: no loader for lazy file '${path}'`));
      p = this._lazyLoader(ref, node.size, path).then((content) => {
        const now = this.cache.get(path);
        if (!now || now.lazy !== ref) return now ?? node; // rewritten, renamed or deleted meanwhile
        if (content.length !== now.size) throw fsError('EIO', `EIO: lazy file '${path}' is ${content.length} bytes, expected ${now.size}`);
        const filled: FSNode = { ...now, content };
        delete filled.lazy;
        // Storage full: read it all the same, fetching again next time.
        // A big one is stored as blocks (the kernel then reads it a page at a time)
        if (!this._full) {
          if (content.length >= FileSystem.BLOB_MIN) {
            filled.blob = this.newBlobId();
            this._queueBlocks(filled.blob, content);
          }
          this._putNow(filled);
        }
        return filled;
      }).finally(() => this._materializing.delete(path));
      this._materializing.set(path, p);
    }
    return p;
  }

  /**
   * Add many nodes at once (a streamed root filesystem's placeholders): one
   * cache update and one IndexedDB flush. Existing nodes are replaced.
   */
  putNodes(nodes: FSNode[]): void {
    for (const node of nodes) this._putNow(node);
    this._canonDirs.clear();
  }

  private _makeNode(path: string, type: 'file' | 'dir', content?: Uint8Array): FSNode {
    const now = Date.now();
    return {
      path,
      type,
      content: content || null,
      mode: type === 'dir' ? 0o755 : 0o644,
      mtime: now,
      ctime: now,
      size: content ? content.length : 0,
    };
  }

  private _opening: Promise<IDBDatabase> | null = null;
  private _lifecycleInstalled = false;

  private _dirtyBytes = 0;
  private _inflightBytes = 0;
  /** Bytes of file content written but not yet committed to IndexedDB (writers slow down past a backlog). */
  get pendingBytes(): number { return this._dirtyBytes + this._inflightBytes; }

  private _writeBackHooks: Set<() => Promise<void> | void> = new Set();

  /** Register data held outside the FileSystem (the kernel's open files) to write back before a flushAll. */
  addWriteBackHook(fn: () => Promise<void> | void): () => void {
    this._writeBackHooks.add(fn);
    return () => { this._writeBackHooks.delete(fn); };
  }

  /**
   * Everything written so far, to IndexedDB: open files' buffers (write-back
   * hooks), then a strict commit. For the page going away (hidden, pagehide,
   * freeze) and before a reload; `timeoutMs` bounds the wait.
   */
  async flushAll(timeoutMs = 5000): Promise<void> {
    const work = (async () => {
      await Promise.all([...this._writeBackHooks].map(async (fn) => { try { await fn(); } catch { /* reported by close/fsync */ } }));
      if (this.pendingWrites > 0) await this.sync();
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); });
    try { await Promise.race([work, limit]); } finally { clearTimeout(timer); }
  }

  /** Writes made but not yet committed to IndexedDB. */
  get pendingWrites(): number { return this._dirty.size + (this._inflight?.size ?? 0); }

  /** Flush when the page may be about to go away: hidden (tab switch, mobile
   *  backgrounding — often the last chance before a kill), pagehide, freeze. */
  private _installLifecycleFlush(): void {
    if (this._lifecycleInstalled || typeof window === 'undefined' || typeof document === 'undefined') return;
    if (typeof window.addEventListener !== 'function' || typeof document.addEventListener !== 'function') return;
    this._lifecycleInstalled = true;
    // Data still in the kernel's open-file buffers first (write-back hooks), then commit
    const flush = () => { void this.flushAll().catch(() => {}); };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
    window.addEventListener('pagehide', flush);
    document.addEventListener('freeze', flush);
  }

  private _openDb(): Promise<IDBDatabase> {
    if (this._opening) return this._opening;
    this._opening = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'path' });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // The browser can close the connection under us (storage pressure,
        // another tab upgrading, devtools "clear storage"). Drop the handle so
        // the next operation reopens instead of failing with "The database
        // connection is closing" forever.
        db.onclose = () => { if (this.db === db) this.db = null; };
        db.onversionchange = () => { db.close(); if (this.db === db) this.db = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => console.warn('[fs] IndexedDB open blocked by another connection');
    }).finally(() => { this._opening = null; });
    return this._opening;
  }

  private async _getDb(): Promise<IDBDatabase> {
    if (!this.db) this.db = await this._openDb();
    return this.db;
  }

  private static _isClosedError(e: unknown): boolean {
    const name = (e as any)?.name;
    return name === 'InvalidStateError' || name === 'TransactionInactiveError'
      || (name === 'AbortError' && /clos/i.test(String((e as any)?.message)));
  }

  /** Run one request against the store, reopening the database once if the
   *  connection was closed. Every request here is idempotent (get/put/delete
   *  by key), so retrying after an abort is safe. */
  private async _request<T>(mode: IDBTransactionMode, make: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const db = this.db ?? await this._getDb();
        return await new Promise<T>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, mode);
          const req = make(tx.objectStore(STORE_NAME));
          // Reads settle on the request; writes wait for the commit so an
          // abort after onsuccess isn't reported as a saved write.
          if (mode === 'readwrite') tx.oncomplete = () => resolve(req.result);
          else req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
          tx.onabort = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'));
        });
      } catch (e) {
        if (attempt > 0 || !FileSystem._isClosedError(e)) throw e;
        console.warn('[fs] IndexedDB connection lost, reopening:', (e as any)?.message);
        if (this.db) { try { this.db.close(); } catch {} }
        this.db = null;
      }
    }
  }

  /** Queue a put (node) or delete (null) for the next flush. */
  private _queue(path: string, node: FSNode | null): void {
    this._dirtyBytes += storedBytes(node) - storedBytes(this._dirty.get(path));
    this._dirty.set(path, node);
    this._scheduleFlush();
  }

  /** Directories whose contents have a pending range delete (RANGE entries in _dirty or _inflight). */
  private _ranges: Set<string> = new Set();

  /** Queue the deletion of everything under directory `dir` (not `dir` itself) as one range delete. */
  private _queueRange(dir: string): void {
    const prefix = dir + '/';
    // Writes queued under it are superseded; later ones go after the range in the batch (Map order)
    for (const [p, n] of this._dirty) {
      if (p.startsWith(prefix) || (p.startsWith(RANGE) && p.slice(RANGE.length).startsWith(prefix))) {
        this._dirtyBytes -= storedBytes(n);
        this._dirty.delete(p);
      }
    }
    const key = RANGE + dir;
    this._dirty.delete(key);
    this._dirty.set(key, null);
    this._ranges.add(dir);
    this._scheduleFlush();
  }

  /** `path` lies under a directory whose contents are being range-deleted (not yet in IndexedDB). */
  private _underRange(path: string): boolean {
    for (const d of this._ranges) if (path.startsWith(d + '/')) return true;
    return false;
  }

  private _scheduleFlush(): void {
    if (this._full) {
      // Retry the failed batch once a burst of deletes has freed something,
      // not after every write (each retry clones the whole batch)
      if (!this._flushScheduled && !this._flushing) {
        this._flushScheduled = true;
        setTimeout(() => { this._flushScheduled = false; void this._flush(); }, 250);
      }
      return;
    }
    if (!this._flushScheduled && !this._flushing) {
      this._flushScheduled = true;
      scheduleMacrotask(() => { this._flushScheduled = false; void this._flush(); });
    }
  }

  /** Commit everything dirty in one transaction; loops while new writes arrive. */
  private _flush(durability: 'default' | 'strict' | 'relaxed' = 'relaxed'): Promise<void> {
    if (this._flushing) return this._flushing;
    if (this._dirty.size === 0) return Promise.resolve();
    const run = async () => {
      while (this._dirty.size > 0) {
        const batch = this._dirty;
        this._dirty = new Map();
        this._inflight = batch;
        this._inflightBytes = this._dirtyBytes;
        this._dirtyBytes = 0;
        try {
          await this._commit(batch, durability);
          this._setFull(false);
          if (this._ranges.size) {
            for (const p of batch.keys()) if (p.startsWith(RANGE) && !this._dirty.has(p)) this._ranges.delete(p.slice(RANGE.length));
          }
        } catch (e) {
          if (FileSystem._isQuotaError(e)) {
            // Requeue it under the writes made meanwhile (newer wins) and
            // stop: the next flush is a retry, after the user frees space
            // (re-inserted, so they stay after any older range delete of theirs)
            for (const [p, n] of this._dirty) { batch.delete(p); batch.set(p, n); }
            this._dirty = batch;
            this._dirtyBytes = 0;
            for (const n of batch.values()) this._dirtyBytes += storedBytes(n);
            if (!this._full) console.error('[fs] browser storage is full; writes fail with ENOSPC until space is freed:', e);
            this._setFull(true);
            break;
          }
          // Keep the cache (the session goes on with what the user wrote) but
          // report it; the next sync() rejects with it.
          console.error('[fs] IndexedDB write failed:', e);
          if (!this._flushError) this._flushError = e;
        } finally {
          this._inflight = null;
          this._inflightBytes = 0;
        }
      }
    };
    this._flushing = run().finally(() => { this._flushing = null; });
    return this._flushing;
  }

  private async _commit(batch: Map<string, FSNode | null>, durability: 'default' | 'strict' | 'relaxed'): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        const db = this.db ?? await this._getDb();
        await new Promise<void>((resolve, reject) => {
          let tx: IDBTransaction;
          try {
            tx = db.transaction(STORE_NAME, 'readwrite', { durability });
          } catch (e) {
            // Engines without the options bag
            if ((e as any)?.name !== 'TypeError') throw e;
            tx = db.transaction(STORE_NAME, 'readwrite');
          }
          const store = tx.objectStore(STORE_NAME);
          for (const [path, node] of batch) {
            if (node) store.put(storableNode(node));
            else if (path.startsWith(RANGE)) {
              // Every key under the directory: from "dir/" up to "dir0" ('0' follows '/')
              const dir = path.slice(RANGE.length);
              store.delete(IDBKeyRange.bound(dir + '/', dir + '0', false, true));
            } else store.delete(path);
          }
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'));
        });
        return;
      } catch (e) {
        if (attempt > 0 || !FileSystem._isClosedError(e)) throw e;
        console.warn('[fs] IndexedDB connection lost, reopening:', (e as any)?.message);
        if (this.db) { try { this.db.close(); } catch {} }
        this.db = null;
      }
    }
  }

  /** Start committing queued writes now; resolves when the queue is empty
   *  (relaxed durability). For writers that pace themselves by the commits. */
  flushed(): Promise<void> {
    return this._flush().then(() => { if (this._full) throw this._enospc(); });
  }

  /**
   * Wait until every write made so far is committed to IndexedDB (strict
   * durability). Rejects with the error of a failed background flush, once,
   * and with ENOSPC while storage is full.
   */
  async sync(): Promise<void> {
    while (this._flushing || this._dirty.size > 0) {
      if (this._flushing) await this._flushing;
      else await this._flush('strict');
      if (this._full && !this._flushing) throw this._enospc();
    }
    if (this._flushError) {
      const e = this._flushError;
      this._flushError = null;
      throw e;
    }
  }

  private async _get(path: string): Promise<FSNode | undefined> {
    if (this.cache.has(path)) {
      const hit = this.cache.get(path);
      if (hit?.content && hit.content.byteLength >= FileSystem.CONTENT_TRACK_MIN) this._touch(path);
      return hit;
    }
    // Under a pending range delete: gone, though IndexedDB still has it
    if (this._ranges.size && this._underRange(path)) { this.cache.set(path, undefined); return undefined; }
    // The key index is complete once loaded: a path not in it doesn't exist
    // (creating a file then needs no IndexedDB read for the "existing" check)
    if (this._allKeys) {
      if (!this._allKeys.has(path)) { this.cache.set(path, undefined); return undefined; }
    } else if (!this._keysLoading && !this._keysWanted) {
      this._keysWanted = true;
      if (!this._keysHeld) void this._getAllKeys().catch(() => {});
    }
    const result = await this._request('readonly', store => store.get(path) as IDBRequest<FSNode | undefined>);
    // A write or delete made while the read was pending is newer than what it returned
    if (this.cache.has(path)) return this.cache.get(path);
    this.cache.set(path, result);
    if (result?.content && result.content.byteLength >= FileSystem.CONTENT_TRACK_MIN) this._touch(path);
    return result;
  }

  /**
   * The canonical path for `path`: symlinks in directory components are
   * always followed (`/usr/share/vim/x` through a `/usr/share/vim` link),
   * the final component only with `followLast`. A missing component ends
   * the walk; the rest is appended unchanged (ENOENT comes later).
   */
  private async _canon(path: string, followLast: boolean, hops = { n: 0 }): Promise<string> {
    // Usually every component is in memory: walk it without an await per component
    if (hops.n === 0) {
      const fast = this._canonCached(path, followLast, { n: 0 });
      if (fast !== undefined) return fast;
    }
    const parts = path.split('/').filter(Boolean);
    let cur = '';
    for (let i = 0; i < parts.length; i++) {
      const next = `${cur}/${parts[i]}`;
      if (parts[i] === '.' || parts[i] === '..') {
        cur = this.resolvePath(next, '/');
        continue;
      }
      if (i === parts.length - 1 && !followLast) return next;
      const node = await this._get(next);
      if (!node) return next + (i < parts.length - 1 ? '/' + parts.slice(i + 1).join('/') : '');
      if (node.type !== 'symlink') { cur = next; continue; }
      if (++hops.n > 40) throw fsError('ELOOP', `ELOOP: too many levels of symbolic links, '${path}'`);
      const target = node.symlinkTarget || new TextDecoder().decode(node.content!);
      cur = await this._canon(target.startsWith('/') ? target : this.resolvePath(target, cur || '/'), true, hops);
      if (cur === '/') cur = '';
    }
    return cur || '/';
  }

  /** _canon from memory alone; undefined when a component needs IndexedDB (or on a loop, which _canon reports). */
  private _canonCached(path: string, followLast: boolean, hops: { n: number }): string | undefined {
    const parts = path.split('/').filter(Boolean);
    let cur = '';
    for (let i = 0; i < parts.length; i++) {
      const next = `${cur}/${parts[i]}`;
      if (parts[i] === '.' || parts[i] === '..') {
        cur = this.resolvePath(next, '/');
        continue;
      }
      if (i === parts.length - 1 && !followLast) return next;
      const node = this._getCached(next);
      if (node === undefined) return undefined;
      if (!node) return next + (i < parts.length - 1 ? '/' + parts.slice(i + 1).join('/') : '');
      if (node.type !== 'symlink') { cur = next; continue; }
      if (++hops.n > 40) return undefined;
      const target = node.symlinkTarget || new TextDecoder().decode(node.content!);
      const c = this._canonCached(target.startsWith('/') ? target : this.resolvePath(target, cur || '/'), true, hops);
      if (c === undefined) return undefined;
      cur = c === '/' ? '' : c;
    }
    return cur || '/';
  }

  /** _get from memory: the node, null when it surely doesn't exist, undefined when only IndexedDB knows. */
  // ── Content cache ──────────────────────────────────────────────────────
  // Every file read or written stays in `cache` with its bytes. Clean files'
  // contents (committed to IndexedDB, no open file holding them) leave memory
  // once unused for CONTENT_IDLE_MS: all of a big file's at once, and the
  // least recently used beyond CONTENT_BUDGET. The whole entry goes, as if
  // never read: sync readers (readBytesCached, lookupCached) then say "needs
  // IndexedDB", as on a fresh boot. After `apt-get update` the cache held
  // 164 MiB, 139 MiB of it three apt files that apt reads only on update.
  // Idle, not merely over budget: evicting what a running apt reads again
  // made each reload allocate anew and raised the install's peak.

  /** Smaller files stay (cheap, and node programs read them synchronously). */
  static CONTENT_TRACK_MIN = 64 << 10;
  static CONTENT_BUDGET = 64 << 20;
  static CONTENT_BIG = 8 << 20;
  static CONTENT_IDLE_MS = 30_000;

  /** Cached files of CONTENT_TRACK_MIN or more, least recently used first → last use. */
  private _contentUse = new Map<string, number>();
  private _contentTimer: ReturnType<typeof setTimeout> | null = null;
  private _contentPins = new Set<(path: string) => boolean>();

  /** Keep a file's content in memory while `pinned(path)` (the kernel's open files). */
  addContentPin(pinned: (path: string) => boolean): () => void {
    this._contentPins.add(pinned);
    return () => { this._contentPins.delete(pinned); };
  }

  private _touch(path: string): void {
    this._contentUse.delete(path);
    this._contentUse.set(path, Date.now());
    if (!this._contentTimer) this._armContentSweep();
  }

  private _armContentSweep(): void {
    const t = setTimeout(() => { this._contentTimer = null; this.sweepContent(); if (this._contentUse.size || this._blockCacheBytes) this._armContentSweep(); },
      FileSystem.CONTENT_IDLE_MS / 2);
    (t as { unref?: () => void }).unref?.();
    this._contentTimer = t;
  }

  /** Bytes of tracked (CONTENT_TRACK_MIN or more) file content in memory. */
  get contentCacheBytes(): number {
    let n = 0;
    for (const p of this._contentUse.keys()) n += this.cache.get(p)?.content?.byteLength ?? 0;
    return n;
  }

  /** Drop idle clean content (see above); `now` for tests. Returns the bytes dropped. */
  sweepContent(now = Date.now()): number {
    let dropped = 0;
    if (this._blockCacheBytes && now - this._blockCacheUsed >= FileSystem.CONTENT_IDLE_MS) {
      dropped += this._blockCacheBytes;
      this._blockCache.clear();
      this._blockCacheBytes = 0;
    }
    let total = 0;
    for (const [p] of this._contentUse) {
      const node = this.cache.get(p);
      if (!node?.content || node.content.byteLength < FileSystem.CONTENT_TRACK_MIN) this._contentUse.delete(p);
      else total += node.content.byteLength;
    }
    for (const [p, at] of this._contentUse) {
      if (now - at < FileSystem.CONTENT_IDLE_MS) break; // the rest were used more recently
      const node = this.cache.get(p)!;
      const size = node.content!.byteLength;
      if (size < FileSystem.CONTENT_BIG && total <= FileSystem.CONTENT_BUDGET) continue;
      if (this._dirty.has(p) || this._inflight?.has(p) || this._materializing.has(p)) continue;
      let pinned = false;
      for (const f of this._contentPins) if (f(p)) { pinned = true; break; }
      if (pinned) continue;
      this.cache.delete(p);
      this._contentUse.delete(p);
      total -= size;
      dropped += size;
    }
    return dropped;
  }

  // ── Big files (FSNode.blob) ────────────────────────────────────────────
  // A file of BLOB_MIN bytes or more is stored as BLOCK-sized records (see
  // BLOCK_KEY), so writing one doesn't need it all in one buffer: the
  // kernel's open file sends the blocks it changed (writeBlocks) and reads
  // the ones it needs (readBlock). A 40 MB write through the kernel peaked
  // at five times its size with whole-file buffers.

  static BLOB_MIN = 4 << 20;
  static BLOCK = 1 << 20;
  /** Recently read blocks kept in memory (a program run again doesn't re-read them from IndexedDB). */
  static BLOCK_CACHE = 16 << 20;

  /** path → blob id, and blob id → the path owning its blocks (stored as BLOB_MAP_KEY). */
  private _blobs = new Map<string, string>();
  private _blobOwner = new Map<string, string>();
  private _blockCache = new Map<string, Uint8Array>();
  private _blockCacheBytes = 0;
  private _blockCacheUsed = 0;
  private _blobSeq = 0;

  /** A new blob id (unique within this store; not a secret). */
  newBlobId(): string {
    return Date.now().toString(36) + (this._blobSeq++).toString(36) + Math.floor(Math.random() * 0x100000000).toString(36);
  }

  private async _loadBlobMap(): Promise<void> {
    const rec = await this._request('readonly', store => store.get(BLOB_MAP_KEY) as IDBRequest<{ blobs?: [string, string][] } | undefined>);
    // Writes made before the load (none in practice: init runs first) win
    for (const [p, id] of rec?.blobs ?? []) {
      if (this._blobs.has(p) || this._blobOwner.has(id)) continue;
      this._blobs.set(p, id);
      this._blobOwner.set(id, p);
    }
  }

  private _saveBlobMap(): void {
    this._queue(BLOB_MAP_KEY, { path: BLOB_MAP_KEY, type: 'file', content: null, mode: 0, mtime: 0, ctime: 0, size: 0, blobs: [...this._blobs] } as FSNode);
  }

  /** Keep the blob map in step with a put (node) or delete (null) at `path`: a replaced or deleted file's blocks go. */
  private _noteBlob(path: string, node: FSNode | null): void {
    const old = this._blobs.get(path);
    const id = node?.blob;
    if (old === id && (!id || this._blobOwner.get(id) === path)) return;
    if (old !== undefined && old !== id) {
      this._blobs.delete(path);
      // A rename put the blob at its new path first: then it isn't this path's to drop
      if (this._blobOwner.get(old) === path) this._dropBlob(old);
    }
    if (id) {
      this._blobs.set(path, id);
      this._blobOwner.set(id, path);
    }
    this._saveBlobMap();
  }

  /** Blobs of files under directory `dir` (its contents being range-deleted). */
  private _dropBlobsUnder(dir: string): void {
    const prefix = dir + '/';
    let changed = false;
    for (const [p, id] of this._blobs) {
      if (!p.startsWith(prefix)) continue;
      this._blobs.delete(p);
      if (this._blobOwner.get(id) === p) this._dropBlob(id);
      changed = true;
    }
    if (changed) this._saveBlobMap();
  }

  private _dropBlob(id: string): void {
    this._blobOwner.delete(id);
    const prefix = BLOCK_KEY + id + '/';
    for (const [k, b] of this._blockCache) {
      if (k.startsWith(prefix)) { this._blockCache.delete(k); this._blockCacheBytes -= b.byteLength; }
    }
    this._queueRange(BLOCK_KEY + id);
  }

  private _queueBlock(key: string, bytes: Uint8Array | null): void {
    const hit = this._blockCache.get(key);
    if (hit) { this._blockCache.delete(key); this._blockCacheBytes -= hit.byteLength; }
    this._queue(key, bytes && { path: key, type: 'file', content: bytes, mode: 0, mtime: 0, ctime: 0, size: bytes.length });
  }

  /** Queue `content` as blob `id`'s blocks (copies: IndexedDB clones a view's whole buffer). */
  private _queueBlocks(id: string, content: Uint8Array): void {
    const B = FileSystem.BLOCK;
    for (let i = 0, off = 0; off < content.length; i++, off += B) this._queueBlock(blockKey(id, i), content.slice(off, off + B));
  }

  /**
   * Block `i` of blob `id`: BLOCK bytes, fewer for the last, empty past the
   * end. Don't modify it (it may be a view of the file's cached content).
   * `keep` = false: don't add it to the block cache (a whole-file read).
   */
  async readBlock(id: string, i: number, keep = true): Promise<Uint8Array> {
    const B = FileSystem.BLOCK;
    const owner = this._blobOwner.get(id);
    const node = owner === undefined ? undefined : this.cache.get(owner);
    if (node?.blob === id && node.content) return node.content.subarray(Math.min(i * B, node.content.length), Math.min((i + 1) * B, node.content.length));
    const key = blockKey(id, i);
    for (const batch of [this._dirty, this._inflight]) {
      if (batch?.has(key)) return batch.get(key)?.content ?? new Uint8Array(0);
    }
    const hit = this._blockCache.get(key);
    if (hit) {
      this._blockCache.delete(key);
      this._blockCache.set(key, hit);
      this._blockCacheUsed = Date.now();
      return hit;
    }
    const rec = await this._request('readonly', store => store.get(key) as IDBRequest<FSNode | undefined>);
    // Written while the read was pending: that is newer
    if (this._dirty.has(key) || this._inflight?.has(key)) return this.readBlock(id, i, keep);
    const bytes = rec?.content ?? new Uint8Array(0);
    if (keep && this._blobOwner.has(id)) {
      this._blockCache.set(key, bytes);
      this._blockCacheBytes += bytes.byteLength;
      this._blockCacheUsed = Date.now();
      for (const [k, b] of this._blockCache) {
        if (this._blockCacheBytes <= FileSystem.BLOCK_CACHE) break;
        this._blockCache.delete(k);
        this._blockCacheBytes -= b.byteLength;
      }
      if (!this._contentTimer) this._armContentSweep();
    }
    return bytes;
  }

  /** A blob node's bytes, read from its blocks (and kept in the cache like any file's content). */
  private async _readBlob(node: FSNode): Promise<FSNode> {
    const B = FileSystem.BLOCK;
    const out = new Uint8Array(node.size);
    for (let i = 0, off = 0; off < node.size; i++, off += B) {
      const b = await this.readBlock(node.blob!, i, false);
      out.set(b.subarray(0, Math.min(b.length, node.size - off)), off);
    }
    const filled = { ...node, content: out };
    if (this.cache.get(node.path) === node) {
      this.cache.set(node.path, filled);
      if (out.byteLength >= FileSystem.CONTENT_TRACK_MIN) this._touch(node.path);
    }
    return filled;
  }

  /**
   * Store the blocks of a big file at `path` that changed (the kernel writing
   * back an open file): `blocks` are [index, bytes] (BLOCK bytes each, fewer
   * for the last; handed over, don't modify them afterwards; null: zeros),
   * `id` the blob they belong to (newBlobId for a file that wasn't one),
   * `size` the file's size. Blocks of `id` not sent keep their stored bytes.
   */
  async writeBlocks(path: string, id: string, size: number, blocks: Iterable<[number, Uint8Array | null]>, options?: {
    times?: { mtime: number; mtimeNs?: number; atime?: number; atimeNs?: number };
  }): Promise<void> {
    path = await this._canon(path, true);
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    const parent = await this._get(parentPath);
    if (!parent) throw fsError('ENOENT', `ENOENT: no such file or directory, open '${path}'`);
    if (parent.type !== 'dir') throw fsError('ENOTDIR', `ENOTDIR: not a directory '${parentPath}'`);
    const existing = await this._get(path);
    if (existing?.type === 'dir') throw fsError('EISDIR', `EISDIR: illegal operation on a directory, write '${path}'`);
    if (this._full) throw this._enospc(path);
    const B = FileSystem.BLOCK;
    for (const [i, b] of blocks) this._queueBlock(blockKey(id, i), b);
    // Blocks past the new end, from a longer version of the same blob
    if (existing?.blob === id) {
      for (let i = Math.ceil(size / B); i < Math.ceil(existing.size / B); i++) this._queueBlock(blockKey(id, i), null);
    }
    const now = Date.now();
    const times = options?.times;
    this._putNow({
      path, type: 'file', content: null, blob: id,
      ...(existing ? { ino: existing.ino } : {}),
      mode: existing?.mode ?? 0o644,
      mtime: times?.mtime ?? now,
      ctime: existing?.ctime ?? now,
      size,
      ...(times ? { mtimeNs: times.mtimeNs || undefined, atime: times.atime, atimeNs: times.atimeNs || undefined } : {}),
    });
    this._emitChange('write', path);
  }

  /** BLOB_MIN and BLOCK, for the kernel's open files. */
  get blobMin(): number { return FileSystem.BLOB_MIN; }
  get blockSize(): number { return FileSystem.BLOCK; }

  /** The blob id of the node cached at `path`, if it is a big file (see FSNode.blob). */
  blobOf(path: string): string | undefined {
    return this.cache.get(path)?.blob;
  }

  private _getCached(path: string): FSNode | null | undefined {
    const hit = this.cache.get(path); // one lookup: misses (cached as undefined) are the rare case
    if (hit) { if (hit.content && hit.content.byteLength >= FileSystem.CONTENT_TRACK_MIN) this._touch(path); return hit; }
    if (this.cache.has(path)) return null;
    if (this._allKeys && !this._allKeys.has(path)) return null;
    return undefined;
  }

  /**
   * stat() answered from memory, for synchronous fast paths (the kernel's
   * syscallSync): `{ path, node }` with symlinks in the final component
   * followed, null when the path doesn't exist, undefined when that needs
   * IndexedDB (or a virtual provider, or a symlink loop: use stat()).
   */
  lookupCached(path: string, follow = true): { path: string; node: FSNode } | null | undefined {
    for (const vp of this.virtualProviders) if (vp.handles(path)) return undefined;
    // Fast path: the parent directory's canonical path is memoized, so only the
    // last component needs a lookup (rg, find and ls stat thousands of names
    // in a few directories)
    const slash = path.lastIndexOf('/');
    const name = path.slice(slash + 1);
    if (slash >= 0 && name && name !== '.' && name !== '..') {
      const dir = slash === 0 ? '/' : path.slice(0, slash);
      let cdir = this._canonDirs.get(dir);
      if (cdir === undefined) {
        const d = this._lookupWalk(dir, true);
        if (d && d.node.type === 'dir') {
          if (this._canonDirs.size > 20000) this._canonDirs.clear();
          this._canonDirs.set(dir, cdir = d.path);
        }
      }
      if (cdir !== undefined) {
        const full = cdir === '/' ? '/' + name : cdir + '/' + name;
        const node = this._getCached(full);
        if (!node) return node;
        if (node.type !== 'symlink' || !follow) return { path: full, node };
      }
    }
    return this._lookupWalk(path, follow);
  }

  /**
   * Canonical paths of directories lookupCached walked (as given → real).
   * Cleared whenever a symlink is written or anything is deleted or renamed,
   * the only changes that can move a directory's canonical path.
   */
  private _canonDirs = new Map<string, string>();

  private _lookupWalk(path: string, follow: boolean): { path: string; node: FSNode } | null | undefined {
    // Symlinks in directory components are followed, as _canon does
    const parts = path.split('/').filter(Boolean);
    let cur = '';
    let hops = 0;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === '.' || parts[i] === '..') { cur = this.resolvePath(`${cur}/${parts[i]}`, '/'); continue; }
      let next = `${cur}/${parts[i]}`;
      const last = i === parts.length - 1;
      for (;;) {
        const node = this._getCached(next);
        if (!node) return node; // missing (null) or unknown here (undefined)
        if (node.type !== 'symlink' || (last && !follow)) {
          if (last) return { path: next, node };
          if (node.type !== 'dir') return undefined; // ENOTDIR: let stat() say so
          break;
        }
        if (++hops > 40) return undefined;
        const target = node.symlinkTarget || new TextDecoder().decode(node.content!);
        next = target.startsWith('/') ? this.resolvePath(target, '/') : this.resolvePath(target, cur || '/');
      }
      cur = next;
    }
    const root = this._getCached('/');
    return root ? { path: '/', node: root } : root;
  }

  /** makeStat for a node from lookupCached. */
  statOf(node: FSNode): StatResult { return makeStat(node); }

  /** Follow symlinks to their final target path (up to 40 hops). */
  private async _resolve(path: string): Promise<string> {
    const seen = new Set<string>();
    let current = path;
    for (let i = 0; i < 40; i++) {
      const node = await this._get(current);
      if (!node || node.type !== 'symlink') return current;
      if (seen.has(current)) {
        throw fsError('ELOOP', `ELOOP: too many levels of symbolic links, '${path}'`);
      }
      seen.add(current);
      const target = node.symlinkTarget || new TextDecoder().decode(node.content!);
      // Resolve relative symlink targets against the symlink's parent directory
      if (target.startsWith('/')) {
        current = target;
      } else {
        const parent = current.substring(0, current.lastIndexOf('/')) || '/';
        current = this.resolvePath(target, parent);
      }
    }
    throw fsError('ELOOP', `ELOOP: too many levels of symbolic links, '${path}'`);
  }

  /** `path` with every symlink followed, in directories and at the end (realpath(3)). */
  async realpath(path: string): Promise<string> {
    return this._canon(path, true);
  }

  private async _put(node: FSNode, move = false): Promise<void> {
    this._putNow(node, move);
  }

  private async _delete(path: string): Promise<void> {
    this._deleteNow(path);
  }

  /** Synchronous part of a put: cache + key index now, IndexedDB on the next flush. */
  private _putNow(node: FSNode, move = false): void {
    const prev = this.cache.get(node.path);
    // A new node gets its inode number (writes and renames carry the old one)
    if (node.ino === undefined && prev === undefined) node.ino = newIno();
    const bytes = (n: FSNode | undefined) => n?.blob ? n.size : n?.content?.byteLength ?? 0;
    const grow = bytes(node) - bytes(prev);
    // A new node or more bytes needs space; a rename (move) moves what is stored
    if (this._full && !move && (prev === undefined || grow > 0)) throw this._enospc(node.path);
    if (grow > 0 && this._bigWrite && (this._bytesWritten += grow) >= this._bigWrite.bytes) {
      const { fn } = this._bigWrite;
      this._bigWrite = null;
      try { fn(); } catch {}
    }
    if (node.type === 'symlink' || this.cache.get(node.path)?.type === 'symlink') this._canonDirs.clear();
    this.cache.set(node.path, node);
    if (node.content && node.content.byteLength >= FileSystem.CONTENT_TRACK_MIN) this._touch(node.path);
    this._noteKey(node.path, true);
    this._queue(node.path, node);
    if (node.blob || this._blobs.has(node.path)) this._noteBlob(node.path, node);
  }

  private _deleteNow(path: string): void {
    this._canonDirs.clear();
    // Remember the miss: IndexedDB still has the node until the flush commits
    this.cache.set(path, undefined);
    this._noteKey(path, false);
    this._queue(path, null);
    if (this._blobs.has(path)) this._noteBlob(path, null);
  }

  /** Every key in the store (plus queued writes), once loaded; kept up to date
   *  by puts/deletes instead of being re-read after each write. */
  private _allKeys: Set<string> | null = null;
  private _allKeysArr: string[] | null = null;
  /** Key changes made while _getAllKeys is reading the store. */
  private _keysJournal: Array<[string, boolean]> | null = null;
  private _keysLoading: Promise<Set<string>> | null = null;
  /** A read asked for the key index to be loaded in the background (see _get). */
  private _keysWanted = false;
  private _keysHeld = false;

  /**
   * Don't load the key index in the background until releaseKeyIndex (or
   * `ms`): with 100k files it takes ~250 ms to read and decode, which delayed
   * the first prompt by as much. readdir still loads it at once if it needs it.
   */
  holdKeyIndex(ms = 5000): void {
    this._keysHeld = true;
    setTimeout(() => this.releaseKeyIndex(), ms);
  }

  releaseKeyIndex(): void {
    if (!this._keysHeld) return;
    this._keysHeld = false;
    if (this._keysWanted && !this._allKeys && !this._keysLoading) void this._getAllKeys().catch(() => {});
  }

  /** Child names by parent directory, built from _allKeys on first readdir and kept up to date with it. */
  private _children: Map<string, Set<string>> | null = null;

  private _indexChild(path: string, present: boolean): void {
    const i = path.lastIndexOf('/');
    if (i < 0 || path === '/') return;
    const parent = i === 0 ? '/' : path.slice(0, i);
    const name = path.slice(i + 1);
    if (!name) return;
    let set = this._children!.get(parent);
    if (present) {
      if (!set) this._children!.set(parent, set = new Set());
      set.add(name);
    } else if (set) {
      set.delete(name);
      if (set.size === 0) this._children!.delete(parent);
    }
  }

  /** Names directly under `dir` (keys only; the caller checks that `dir` is a directory). */
  private async _childNames(dir: string): Promise<Iterable<string>> {
    await this._getAllKeys();
    if (!this._children) {
      this._children = new Map();
      for (const key of this._allKeys!) this._indexChild(key, true);
    }
    return this._children.get(dir) ?? [];
  }

  private _noteKey(path: string, present: boolean): void {
    if (this._allKeys) {
      if (present ? !this._allKeys.has(path) : this._allKeys.has(path)) {
        if (present) this._allKeys.add(path); else this._allKeys.delete(path);
        this._allKeysArr = null;
        if (this._children) this._indexChild(path, present);
      }
    }
    if (this._keysJournal) this._keysJournal.push([path, present]);
  }

  private async _getAllKeys(): Promise<string[]> {
    if (!this._allKeys) {
      if (!this._keysLoading) {
        const journal: Array<[string, boolean]> = [];
        this._keysJournal = journal;
        // Writes queued before the read started and not yet issued: the read
        // won't see them. (An in-flight flush transaction was created before
        // this readonly one, so IndexedDB orders the read after it.)
        const queued = [...this._dirty];
        const ranges = [...this._ranges];
        this._keysLoading = this._request('readonly', store => store.getAllKeys())
          .then((keys) => {
            const set = new Set(keys as string[]);
            for (const k of set) if (isInternalKey(k)) set.delete(k);
            if (ranges.length) for (const k of set) if (ranges.some((d) => k.startsWith(d + '/'))) set.delete(k);
            for (const [p, n] of queued) { if (isInternalKey(p) || p.startsWith(RANGE)) continue; if (n) set.add(p); else set.delete(p); }
            for (const [p, present] of journal) { if (present) set.add(p); else set.delete(p); }
            this._allKeys = set;
            this._allKeysArr = null;
            this._children = null;
            return set;
          })
          .finally(() => { this._keysJournal = null; this._keysLoading = null; });
      }
      await this._keysLoading;
    }
    if (!this._allKeysArr) this._allKeysArr = [...this._allKeys!];
    return this._allKeysArr;
  }

  /** Synchronously read file content from the in-memory cache (no IndexedDB round-trip).
   *  Returns the string content if cached, or undefined if not in cache / not a file. */
  readCached(path: string): string | undefined {
    const node = this.cache.get(path);
    if (!node || node.type !== 'file' || !node.content) return undefined;
    if (node.content.byteLength >= FileSystem.CONTENT_TRACK_MIN) this._touch(path);
    return decodeBytes(node.content);
  }

  /** Synchronously read a file's raw bytes from the in-memory cache. */
  readBytesCached(path: string): Uint8Array | undefined {
    const node = this.cache.get(path);
    if (!node || node.type !== 'file' || !node.content) return undefined;
    if (node.content.byteLength >= FileSystem.CONTENT_TRACK_MIN) this._touch(path);
    return node.content;
  }

  /** Synchronous realpath from the in-memory cache; undefined when that needs IndexedDB. */
  realpathCached(path: string): string | undefined {
    return this._canonCached(path, true, { n: 0 });
  }

  /** Synchronous readlink from the in-memory cache: the target for a cached
   *  symlink, null for any other cached node, undefined if not cached. */
  readlinkCached(path: string): string | null | undefined {
    const node = this.cache.get(path);
    if (!node) return undefined;
    if (node.type !== 'symlink') return null;
    return node.symlinkTarget || new TextDecoder().decode(node.content!);
  }

  /** Whether the in-memory cache holds path as a directory (an empty one
   *  included, which readdirCached can't tell from "not cached"). */
  isDirCached(path: string): boolean {
    return this.cache.get(path)?.type === 'dir';
  }

  /** Synchronously list directory entries from the in-memory cache. */
  readdirCached(path: string): string[] | undefined {
    const node = this.cache.get(path);
    if (!node || node.type !== 'dir') return undefined;
    const prefix = path === '/' ? '/' : path + '/';
    const entries = new Set<string>();
    for (const [key, value] of this.cache) {
      // A cached miss (value undefined) records that a path doesn't exist
      if (value !== undefined && key.startsWith(prefix)) {
        const rest = key.slice(prefix.length);
        const first = rest.split('/')[0];
        if (first) entries.add(first);
      }
    }
    return entries.size > 0 ? [...entries].sort() : undefined;
  }

  /** Clear the in-memory cache (useful after external DB modifications) */
  clearCache(): void {
    this.cache.clear();
    this._canonDirs.clear();
    this._allKeys = null;
    this._allKeysArr = null;
    this._children = null;
    // Writes not yet in IndexedDB live only here: keep them visible
    for (const batch of [this._inflight, this._dirty]) {
      if (!batch) continue;
      for (const [path, node] of batch) if (!isInternalKey(path) && !path.startsWith(RANGE)) this.cache.set(path, node ?? undefined);
    }
  }

  /** Export all filesystem nodes from IndexedDB */
  async exportAll(): Promise<FSNode[]> {
    await this.sync().catch(() => {});
    const all = await this._request('readonly', store => store.getAll() as IDBRequest<FSNode[]>);
    // Big files with their bytes in `content`, as importAll takes them (no block records)
    const blocks = new Map<string, Uint8Array>();
    for (const n of all) if (n.path.startsWith(BLOCK_KEY)) blocks.set(n.path, n.content ?? new Uint8Array(0));
    const out: FSNode[] = [];
    for (const n of all) {
      if (isInternalKey(n.path)) continue;
      if (!n.blob) { out.push(n); continue; }
      const content = new Uint8Array(n.size);
      for (let i = 0, off = 0; off < n.size; i++, off += FileSystem.BLOCK) {
        const b = blocks.get(blockKey(n.blob, i));
        if (b) content.set(b.subarray(0, Math.min(b.length, n.size - off)), off);
      }
      const { blob: _blob, ...plain } = n;
      out.push({ ...plain, content });
    }
    return out;
  }

  /** Import filesystem nodes, replacing all existing data */
  async importAll(nodes: FSNode[]): Promise<void> {
    // Queued writes must not land on top of the imported tree
    await this.sync().catch(() => {});
    const tx = (await this._getDb()).transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    for (const node of nodes) {
      if (isInternalKey(node.path)) continue;
      if (node.blob) { const { blob: _blob, ...plain } = node; store.put(plain); } else store.put(node);
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    this.clearCache();
    this._blobs.clear();
    this._blobOwner.clear();
    this._blockCache.clear();
    this._blockCacheBytes = 0;
  }

  resolvePath(path: string, cwd: string): string {
    let resolved: string;
    if (path.startsWith('/')) {
      resolved = path;
    } else {
      resolved = cwd === '/' ? '/' + path : cwd + '/' + path;
    }
    // Normalize: resolve . and ..
    const parts = resolved.split('/');
    const stack: string[] = [];
    for (const part of parts) {
      if (part === '' || part === '.') continue;
      if (part === '..') {
        stack.pop();
      } else {
        stack.push(part);
      }
    }
    return '/' + stack.join('/');
  }

  async stat(path: string): Promise<StatResult> {
    for (const vp of this.virtualProviders) {
      if (vp.handles(path)) {
        const s = vp.stat(path);
        if (s) return s;
        // a link out of the provider (/proc/self/cwd): stat what it points at
        const t = vp.readlink?.(path);
        if (t && t.startsWith('/') && t !== path) return this.stat(t);
      }
    }
    const c = this._canonCached(path, true, { n: 0 });
    const known = c === undefined ? undefined : this._getCached(c);
    const node = known !== undefined ? known : await this._get(await this._canon(path, true));
    if (!node) throw fsError('ENOENT', `ENOENT: no such file or directory, stat '${path}'`);
    return makeStat(node);
  }

  async lstat(path: string): Promise<StatResult> {
    for (const vp of this.virtualProviders) {
      if (vp.handles(path)) { const s = vp.lstat ? vp.lstat(path) : vp.stat(path); if (s) return s; }
    }
    const c = this._canonCached(path, false, { n: 0 });
    const known = c === undefined ? undefined : this._getCached(c);
    const node = known !== undefined ? known : await this._get(await this._canon(path, false));
    if (!node) throw fsError('ENOENT', `ENOENT: no such file or directory, lstat '${path}'`);
    return makeStat(node);
  }

  async exists(path: string): Promise<boolean> {
    for (const vp of this.virtualProviders) {
      if (vp.exists(path)) return true;
    }
    const node = await this._get(await this._canon(path, false));
    return !!node;
  }

  /**
   * How readFile/writeFile reach a named pipe (set by the shell: the
   * kernel's pipe, with its blocking open and EOF). Without it a FIFO reads
   * as empty.
   */
  fifoIO?: { read(path: string): Promise<Uint8Array>; write(path: string, data: Uint8Array | string): Promise<void> };

  async readFile(path: string, encoding?: 'utf8'): Promise<Uint8Array | string> {
    for (const vp of this.virtualProviders) {
      if (vp.handles(path)) {
        const data = vp.readFile(path, encoding);
        if (data !== null) return data;
        throw fsError('EISDIR', `EISDIR: illegal operation on a directory, read '${path}'`);
      }
    }
    let node = await this._get(await this._canon(path, true));
    if (!node) throw fsError('ENOENT', `ENOENT: no such file or directory, open '${path}'`);
    if (node.type === 'dir') throw fsError('EISDIR', `EISDIR: illegal operation on a directory, read '${path}'`);
    if (node.special === 'fifo' && this.fifoIO) {
      const bytes = await this.fifoIO.read(node.path);
      return encoding === 'utf8' ? decodeBytes(bytes) : bytes;
    }
    if (node.lazy) node = await this._materialize(node);
    if (node.blob && !node.content) node = await this._readBlob(node);
    const data = node.content || new Uint8Array(0);
    // Byte-exact: invalid UTF-8 survives a round trip through the string (src/utils/byte-text.ts)
    if (encoding === 'utf8') return decodeBytes(data);
    return data;
  }

  async writeFile(path: string, data: Uint8Array | string, options?: {
    mode?: number;
    /** Modification (and access) time to record instead of now (the kernel writing back an open file). */
    times?: { mtime: number; mtimeNs?: number; atime?: number; atimeNs?: number };
  }): Promise<void> {
    for (const vp of this.virtualProviders) {
      if (vp.writeFile(path, data)) return;
    }
    path = await this._canon(path, true);
    if (this.fifoIO && !options?.times && (await this._get(path))?.special === 'fifo') return this.fifoIO.write(path, data);
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    const parent = await this._get(parentPath);
    if (!parent) throw fsError('ENOENT', `ENOENT: no such file or directory, open '${path}'`);
    if (parent.type !== 'dir') throw fsError('ENOTDIR', `ENOTDIR: not a directory '${parentPath}'`);

    // A view into a larger buffer is stored compactly: IndexedDB clones the
    // whole ArrayBuffer behind a typed array (a WebC volume file would carry
    // its entire container)
    const content = typeof data === 'string' ? encodeText(data)
      : data.byteOffset !== 0 || data.byteLength !== data.buffer.byteLength ? data.slice() : data;
    const existing = await this._get(path);
    // Prevent overwriting a directory with a file
    if (existing?.type === 'dir') throw fsError('EISDIR', `EISDIR: illegal operation on a directory, write '${path}'`);
    const now = Date.now();
    let blob: string | undefined;
    if (content.length >= FileSystem.BLOB_MIN) {
      if (this._full) throw this._enospc(path);
      blob = this.newBlobId();
      this._queueBlocks(blob, content);
    }

    await this._put({
      path,
      type: 'file',
      content,
      ...(blob ? { blob } : {}),
      ...(existing ? { ino: existing.ino } : {}),
      mode: options?.mode ?? existing?.mode ?? 0o644,
      mtime: options?.times?.mtime ?? now,
      ctime: now, // (a write changes the inode: st_ctime, as Linux; rename and chmod do too)
      size: content.length,
      ...(options?.times ? { mtimeNs: options.times.mtimeNs || undefined, atime: options.times.atime, atimeNs: options.times.atimeNs || undefined } : {}),
    });
    this._emitChange('write', path);
  }

  /**
   * Create an empty file from the cache alone (the kernel's synchronous
   * O_CREAT path): `path` must be canonical, its parent a cached directory
   * and the name known to be free. The node, or undefined: use writeFile.
   */
  createEmptyCachedSync(path: string, mode: number): FSNode | undefined {
    if (this.virtualProviders.some((vp) => vp.handles(path))) return undefined;
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    const parent = this.lookupCached(parentPath);
    if (!parent || parent.path !== parentPath || parent.node.type !== 'dir') return undefined;
    if (this.lookupCached(path, false) !== null) return undefined;
    const now = Date.now();
    const node: FSNode = { path, type: 'file', content: new Uint8Array(0), mode, mtime: now, ctime: now, size: 0 };
    try { this._putNow(node); } catch { return undefined; } // ENOSPC: writeFile reports it
    this._emitChange('write', path);
    return node;
  }

  /**
   * unlink(2) from the cache alone: `path`'s node is cached and not a
   * directory. True when done, undefined when it must go through unlink().
   */
  unlinkCachedSync(path: string): true | undefined {
    if (this.virtualProviders.some((vp) => vp.handles(path))) return undefined;
    const hit = this.lookupCached(path, false);
    if (!hit || hit.path !== path || hit.node.type === 'dir') return undefined;
    this._deleteNow(path);
    this._emitChange('delete', path);
    return true;
  }

  /** Append to a file (created if missing). Appends in one flush window are
   *  committed as a single put of the final content. */
  async appendFile(path: string, data: Uint8Array | string): Promise<void> {
    let existing: Uint8Array;
    try {
      existing = await this.readFile(path) as Uint8Array;
    } catch {
      existing = new Uint8Array(0);
    }
    const append = typeof data === 'string' ? encodeText(data) : data;
    const combined = new Uint8Array(existing.length + append.length);
    combined.set(existing);
    combined.set(append, existing.length);
    // Through a symlink, append to its target rather than replacing the link
    const target = this.virtualProviders.some(vp => vp.handles(path)) ? path : await this._canon(path, true);
    await this.writeFile(target, combined);
  }

  /** Create a named pipe (mkfifo(3)). EEXIST if `path` exists; the parent must exist. */
  async mkfifo(path: string, mode = 0o644): Promise<void> {
    if (await this._get(path)) throw fsError('EEXIST', `EEXIST: file already exists, mkfifo '${path}'`);
    const parent = path.substring(0, path.lastIndexOf('/')) || '/';
    const dir = await this._get(parent);
    if (!dir) throw fsError('ENOENT', `ENOENT: no such file or directory, mkfifo '${path}'`);
    if (dir.type !== 'dir') throw fsError('ENOTDIR', `ENOTDIR: not a directory, mkfifo '${path}'`);
    const node = this._makeNode(path, 'file');
    node.special = 'fifo';
    node.mode = mode & 0o7777;
    await this._put(node);
    this._emitChange('write', path);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    if (options?.recursive) {
      const parts = path.split('/').filter(Boolean);
      let current = '';
      for (const part of parts) {
        current = await this._canon(current + '/' + part, true);
        const existing = await this._get(current);
        if (!existing) {
          await this._put(this._makeNode(current, 'dir'));
          this._emitChange('mkdir', current);
        } else if (existing.type !== 'dir') {
          throw fsError('ENOTDIR', `ENOTDIR: not a directory '${current}'`);
        }
      }
      return;
    }

    path = await this._canon(path, false);
    const existing = await this._get(path);
    if (existing) throw fsError('EEXIST', `EEXIST: file already exists, mkdir '${path}'`);

    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    const parent = await this._get(parentPath);
    if (!parent) throw fsError('ENOENT', `ENOENT: no such file or directory, mkdir '${path}'`);
    if (parent.type !== 'dir') throw fsError('ENOTDIR', `ENOTDIR: not a directory '${parentPath}'`);

    await this._put(this._makeNode(path, 'dir'));
    this._emitChange('mkdir', path);
  }

  /**
   * mkdir() whose effect on the in-memory cache is immediate when every
   * component is in memory, for synchronous callers (node's fs.mkdirSync then
   * writeFileSync: the write's parent check ran before the async mkdir landed,
   * and the file was lost). Falls back to mkdir() otherwise.
   */
  mkdirNow(path: string, options?: { recursive?: boolean }): Promise<void> {
    if (this._full || this.virtualProviders.some((vp) => vp.handles(path))) return this.mkdir(path, options);
    const parts = path.split('/').filter(Boolean);
    const made: string[] = [];
    let current = '';
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      if (!options?.recursive && !last) {
        current = current + '/' + parts[i];
        continue;
      }
      const canon = this._canonCached(current + '/' + parts[i], true, { n: 0 });
      if (canon === undefined) return this.mkdir(path, options);
      const existing = this._getCached(canon);
      if (existing === undefined) return this.mkdir(path, options);
      if (existing) {
        if (existing.type !== 'dir') return Promise.reject(fsError('ENOTDIR', `ENOTDIR: not a directory '${canon}'`));
        if (last && !options?.recursive) return Promise.reject(fsError('EEXIST', `EEXIST: file already exists, mkdir '${canon}'`));
      } else {
        const parentPath = canon.substring(0, canon.lastIndexOf('/')) || '/';
        const parent = this._getCached(parentPath);
        if (parent === undefined && !made.includes(parentPath)) return this.mkdir(path, options);
        if (!parent && !made.includes(parentPath)) return Promise.reject(fsError('ENOENT', `ENOENT: no such file or directory, mkdir '${path}'`));
        this._putNow(this._makeNode(canon, 'dir'));
        made.push(canon);
      }
      current = canon === '/' ? '' : canon;
    }
    for (const d of made) this._emitChange('mkdir', d);
    return Promise.resolve();
  }

  async readdir(path: string): Promise<string[]> {
    // Check virtual providers first
    for (const vp of this.virtualProviders) {
      if (vp.handles(path)) {
        const entries = vp.readdir(path);
        if (entries !== null) return entries;
        throw fsError('ENOTDIR', `ENOTDIR: not a directory '${path}'`);
      }
    }

    const shown = path;
    path = await this._canon(path, true);
    const node = await this._get(path);
    if (!node) throw fsError('ENOENT', `ENOENT: no such file or directory, readdir '${shown}'`);
    if (node.type !== 'dir') throw fsError('ENOTDIR', `ENOTDIR: not a directory '${path}'`);

    const entries: string[] = [...await this._childNames(path)];

    // The virtual log files live in the real /var/log
    if (path === '/var/log' && !entries.includes('syslog')) entries.push('syslog');

    // For root directory, add virtual top-level dirs
    if (path === '/') {
      const vdirs = new Set<string>();
      for (const vp of this.virtualProviders) {
        for (const name of ['dev', 'proc']) {
          if (vp.handles('/' + name)) vdirs.add(name);
        }
        if (vp.mountPoint) vdirs.add(vp.mountPoint);
      }
      for (const vd of vdirs) {
        if (!entries.includes(vd)) entries.push(vd);
      }
    }

    return entries.sort();
  }

  /**
   * writeFile() whose effect on the in-memory cache is immediate, for synchronous
   * callers (node's fs.writeFileSync of binary data) that read the file right back.
   */
  writeNow(path: string, content: Uint8Array): Promise<void> {
    if (this._full) return this.writeFile(path, content);
    const prev = this.cache.get(path);
    const now = Date.now();
    this.cache.set(path, {
      path, type: 'file', content, ino: prev ? prev.ino : newIno(),
      mode: prev?.mode ?? 0o644, mtime: now, ctime: now, size: content.length,
    } as FSNode);
    this._noteKey(path, true);
    return this.writeFile(path, content);
  }

  /**
   * unlink() whose effect on the in-memory cache is immediate, for synchronous
   * callers (node's fs.unlinkSync) that list or stat the directory right after.
   */
  unlinkNow(path: string): Promise<void> {
    // Take the cached node before it is dropped below (unlink() canonicalizes asynchronously)
    const cached = this.cache.get(path);
    const done = cached ? this._unlinkNode(path, cached) : this.unlink(path);
    this.cache.set(path, undefined);
    this._canonDirs.clear();
    this._noteKey(path, false);
    return done;
  }

  async unlink(path: string): Promise<void> {
    path = await this._canon(path, false);
    return this._unlinkNode(path, await this._get(path));
  }

  private async _unlinkNode(path: string, node: FSNode | undefined): Promise<void> {
    if (!node) throw fsError('ENOENT', `ENOENT: no such file or directory, unlink '${path}'`);
    if (node.type === 'dir') throw fsError('EISDIR', `EISDIR: illegal operation on a directory, unlink '${path}'`);
    await this._delete(path);
    this._emitChange('delete', path);
  }

  /**
   * writeFile of a regular file whose node is cached, now (the kernel writing
   * back an open file on close): false when it needs writeFile (uncached,
   * lazy, not a file, or storage full).
   */
  writeCachedSync(path: string, content: Uint8Array, times: { mtime: number; mtimeNs?: number; atime?: number; atimeNs?: number }): boolean {
    const node = this.cache.get(path);
    if (!node || node.type !== 'file' || node.lazy || node.special || this._full || content.length >= FileSystem.BLOB_MIN) return false;
    const { blob: _blob, ...plain } = node;
    this._putNow({
      ...plain, content, size: content.length, mtime: times.mtime,
      mtimeNs: times.mtimeNs || undefined, atime: times.atime, atimeNs: times.atimeNs || undefined,
    });
    this._emitChange('write', path);
    return true;
  }

  /** Create a directory at canonical `path` now (the kernel's syscallSync checked the parent); false when it needs the async path. */
  createDirNow(path: string, mode: number): boolean {
    if (this._full) return false;
    const node = this._makeNode(path, 'dir');
    node.mode = mode & 0o7777;
    this._putNow(node);
    this._emitChange('mkdir', path);
    return true;
  }

  /** Rename the cached non-directory at canonical `from` to canonical `to` now; false when it needs the async path. */
  renameNow(from: string, to: string): boolean {
    const node = this.cache.get(from);
    const dst = this.cache.get(to);
    if (!node || node.type === 'dir' || dst?.type === 'dir') return false;
    this._putNow({ ...node, path: to, ctime: Date.now(), ino: node.ino ?? pathIno(from) }, true);
    this._deleteNow(from);
    this._emitChange('rename', from, to);
    return true;
  }

  /** Remove the directory at canonical `path` when the child index knows it: true, false (not empty), undefined (unknown). */
  rmdirNow(path: string): boolean | undefined {
    if (!this._children || this.cache.get(path)?.type !== 'dir') return undefined;
    if (this._children.get(path)?.size) return false;
    this._deleteNow(path);
    this._emitChange('delete', path);
    return true;
  }

  async rmdir(path: string): Promise<void> {
    path = await this._canon(path, false);
    const node = await this._get(path);
    if (!node) throw fsError('ENOENT', `ENOENT: no such file or directory, rmdir '${path}'`);
    if (node.type !== 'dir') throw fsError('ENOTDIR', `ENOTDIR: not a directory '${path}'`);

    const entries = await this.readdir(path);
    if (entries.length > 0) throw fsError('ENOTEMPTY', `ENOTEMPTY: directory not empty, rmdir '${path}'`);
    await this._delete(path);
    this._emitChange('delete', path);
  }

  async rm(path: string, options?: { recursive?: boolean }): Promise<void> {
    path = await this._canon(path, false);
    const node = await this._get(path);
    if (!node) throw fsError('ENOENT', `ENOENT: no such file or directory, rm '${path}'`);

    if (node.type === 'dir' && options?.recursive && path !== '/') {
      const allKeys = await this._getAllKeys();
      const prefix = path + '/';
      // Gone from memory now; from IndexedDB in one range delete (_queueRange)
      for (const key of allKeys.filter(k => k.startsWith(prefix))) {
        this.cache.set(key, undefined);
        this._noteKey(key, false);
      }
      this._canonDirs.clear();
      this._queueRange(path);
      this._dropBlobsUnder(path);
      this._deleteNow(path);
      this._emitChange('delete', path);
    } else if (node.type === 'dir' && options?.recursive) {
      const allKeys = await this._getAllKeys();
      const toDelete = allKeys.filter(k => k.startsWith('/'));
      toDelete.sort().reverse();
      for (const key of toDelete) await this._delete(key);
      this._emitChange('delete', path);
    } else if (node.type === 'dir') {
      throw fsError('EISDIR', `EISDIR: is a directory, rm '${path}'`);
    } else {
      await this._delete(path);
      this._emitChange('delete', path);
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    oldPath = await this._canon(oldPath, false);
    newPath = await this._canon(newPath, false);
    const node = await this._get(oldPath);
    if (!node) throw fsError('ENOENT', `ENOENT: no such file or directory, rename '${oldPath}'`);

    if (node.type === 'dir') {
      // Move directory and all children
      const allKeys = await this._getAllKeys();
      const prefix = oldPath === '/' ? '/' : oldPath + '/';
      for (const key of allKeys) {
        if (key === oldPath || key.startsWith(prefix)) {
          const child = await this._get(key);
          if (child) {
            const newChildPath = newPath + key.slice(oldPath.length);
            await this._put({ ...child, path: newChildPath, ino: child.ino ?? pathIno(key) }, true);
            await this._delete(key);
          }
        }
      }
    } else {
      // Prevent renaming a file over a directory
      const existing = await this._get(newPath);
      if (existing?.type === 'dir') throw fsError('EISDIR', `EISDIR: illegal operation on a directory, rename '${newPath}'`);
      await this._put({ ...node, path: newPath, ctime: Date.now(), ino: node.ino ?? pathIno(oldPath) }, true); // rename keeps mtime (rsync -a, make)
      await this._delete(oldPath);
    }
    this._emitChange('rename', oldPath, newPath);
  }

  async chmod(path: string, mode: number): Promise<void> {
    path = await this._canon(path, true);
    const node = await this._get(path);
    if (!node) throw fsError('ENOENT', `ENOENT: no such file or directory, chmod '${path}'`);
    await this._put({ ...node, mode, ctime: Date.now() });
  }

  /**
   * Set access and modification times (utimensat) of `path` itself (a
   * symlink is not followed). `ns`: nanoseconds past each millisecond time.
   * An atime equal to the mtime isn't stored: atime then follows mtime.
   */
  async utimes(path: string, atimeMs: number, mtimeMs: number, ns?: { atime?: number; mtime?: number }): Promise<void> {
    path = await this._canon(path, false);
    const node = await this._get(path);
    if (!node) throw fsError('ENOENT', `ENOENT: no such file or directory, utime '${path}'`);
    const mtimeNs = ns?.mtime || undefined;
    const atimeNs = ns?.atime || undefined;
    const sameA = atimeMs === mtimeMs && atimeNs === mtimeNs;
    await this._put({ ...node, mtime: mtimeMs, mtimeNs, atime: sameA ? undefined : atimeMs, atimeNs: sameA ? undefined : atimeNs });
  }

  // isomorphic-git compatibility: symlink support
  /**
   * symlink() whose effect on the in-memory cache is immediate when the
   * parent is in memory, for synchronous callers (node's fs.symlinkSync then
   * lstatSync/readlinkSync/realpathSync). Falls back to symlink() otherwise.
   */
  symlinkNow(target: string, path: string): Promise<void> {
    const canon = this._canonCached(path, false, { n: 0 });
    if (canon === undefined) return this.symlink(target, path);
    const existing = this._getCached(canon);
    if (existing === undefined) return this.symlink(target, path);
    if (existing) return Promise.reject(fsError('EEXIST', `EEXIST: file already exists, symlink '${target}' -> '${path}'`));
    const parentPath = canon.substring(0, canon.lastIndexOf('/')) || '/';
    const parent = this._getCached(parentPath);
    if (parent === undefined) return this.symlink(target, path);
    if (!parent || parent.type !== 'dir') return Promise.reject(fsError('ENOENT', `ENOENT: no such file or directory, symlink '${target}' -> '${path}'`));
    const now = Date.now();
    this._putNow({ path: canon, type: 'symlink', content: new TextEncoder().encode(target), mode: 0o120000, mtime: now, ctime: now, size: target.length, symlinkTarget: target } as FSNode);
    this._emitChange('write', canon);
    return Promise.resolve();
  }

  async symlink(target: string, path: string): Promise<void> {
    path = await this._canon(path, false);
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    const parent = await this._get(parentPath);
    if (!parent) throw fsError('ENOENT', `ENOENT: no such file or directory '${parentPath}'`);

    const now = Date.now();
    await this._put({
      path,
      type: 'symlink',
      content: new TextEncoder().encode(target),
      mode: 0o120000,
      mtime: now,
      ctime: now,
      size: target.length,
      symlinkTarget: target,
    });
    this._emitChange('write', path);
  }

  async readlink(path: string): Promise<string> {
    for (const vp of this.virtualProviders) {
      if (vp.handles(path)) {
        const t = vp.readlink?.(path);
        if (t) return t;
        throw fsError('EINVAL', `EINVAL: not a symlink '${path}'`);
      }
    }
    path = await this._canon(path, false);
    const node = await this._get(path);
    if (!node) throw fsError('ENOENT', `ENOENT: no such file or directory, readlink '${path}'`);
    if (node.type !== 'symlink') throw fsError('EINVAL', `EINVAL: not a symlink '${path}'`);
    return node.symlinkTarget || new TextDecoder().decode(node.content!);
  }

  async glob(pattern: string, base?: string, options?: { caseInsensitive?: boolean; dotglob?: boolean }): Promise<string[]> {
    const root = base || '/';
    const allKeys = await this._getAllKeys();
    const regex = globPatternToRegex(pattern, root, options?.caseInsensitive);
    const dotglob = options?.dotglob ?? false;
    // Check if the pattern basename starts with '.' (explicit dotfile match)
    const patBase = pattern.includes('/') ? pattern.slice(pattern.lastIndexOf('/') + 1) : pattern;
    const patternStartsDot = patBase.startsWith('.');
    const results: string[] = [];
    for (const key of allKeys) {
      const node = await this._get(key);
      if (node && node.type === 'file' && regex.test(key)) {
        // Filter dotfiles unless dotglob is on or pattern explicitly starts with '.'
        if (!dotglob && !patternStartsDot) {
          const basename = key.slice(key.lastIndexOf('/') + 1);
          if (basename.startsWith('.')) continue;
        }
        // Return relative to base
        if (base && key.startsWith(base)) {
          const rel = key.slice(base.length);
          results.push(rel.startsWith('/') ? rel.slice(1) : rel);
        } else {
          results.push(key);
        }
      }
    }
    return results.sort();
  }

  // Build an fs-like API object for isomorphic-git
  toIsomorphicGitFS() {
    const self = this;
    // Normalize paths that contain '.' or '..' segments (isomorphic-git passes e.g. '/dir/.')
    const norm = (p: string): string => {
      if (p.includes('/.') || p.endsWith('.')) return self.resolvePath(p, '/');
      return p;
    };
    return {
      promises: {
        readFile: (p: string, opts?: any) => {
          if (opts?.encoding === 'utf8' || opts === 'utf8') return self.readFile(p, 'utf8');
          return self.readFile(p);
        },
        writeFile: (p: string, data: any, opts?: any) => self.writeFile(p, data, typeof opts === 'object' ? opts : undefined),
        unlink: (p: string) => self.unlink(p),
        readdir: (p: string) => self.readdir(norm(p)),
        mkdir: (p: string, opts?: any) => self.mkdir(p, typeof opts === 'number' ? undefined : opts),
        rmdir: (p: string) => self.rmdir(p),
        stat: async (p: string) => {
          try {
            return await self.stat(norm(p));
          } catch (err: any) {
            if (err.code === 'ENOENT') throw err;
            throw fsError('ENOENT', `ENOENT: no such file or directory, stat '${p}'`);
          }
        },
        lstat: async (p: string) => {
          try {
            return await self.lstat(norm(p));
          } catch (err: any) {
            if (err.code === 'ENOENT') throw err;
            throw fsError('ENOENT', `ENOENT: no such file or directory, lstat '${p}'`);
          }
        },
        rename: (o: string, n: string) => self.rename(o, n),
        symlink: (t: string, p: string) => self.symlink(t, p),
        readlink: (p: string) => self.readlink(p),
        chmod: (p: string, m: number) => self.chmod(p, m),
      },
    };
  }
}
