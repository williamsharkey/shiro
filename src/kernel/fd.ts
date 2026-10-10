/**
 * Open file descriptions and per-process fd tables.
 *
 * An OpenFile is one open file description: dup'd and inherited fds share it,
 * including its offset and status flags. FdTable maps small integers to
 * OpenFiles, reference-counted so `close()` on the OpenFile runs when the last
 * fd referring to it (in any process) closes.
 */

import type { FileSystem } from '../filesystem';
import {
  type KStat, EBADF, EMFILE, EINVAL, EISDIR, ESPIPE, ENOTTY, EAGAIN, EINTR,
  O_ACCMODE, O_RDONLY, O_WRONLY, O_RDWR, O_APPEND, O_NONBLOCK, O_DSYNC, OPEN_MAX, NR_OPEN,
  POLLIN, POLLOUT, SEEK_SET, SEEK_CUR, SEEK_END,
  S_IFCHR, S_IFREG, S_IFDIR, S_IFIFO, FIONREAD, errnoFromError,
  EPERM, F_SEAL_SEAL, F_SEAL_SHRINK, F_SEAL_GROW, F_SEAL_WRITE, F_SEAL_FUTURE_WRITE,
} from './abi';

export type OpenFileKind = 'file' | 'dir' | 'pipe' | 'pty' | 'socket' | 'dev' | 'epoll';

/**
 * Buffers passed to read/write/ioctl may be views of a SharedArrayBuffer
 * (the syscall channel's data area) and are only valid during the call.
 * Copy what you keep (`buf.slice()`), and never `TextDecoder.decode` a view
 * directly: browsers reject shared memory there (Node doesn't, so tests
 * won't catch it). Use `decodeText` from abi.ts.
 */
export interface OpenFile {
  kind: OpenFileKind;
  /** O_* status flags (access mode, O_NONBLOCK, O_APPEND, ...). F_SETFL may change O_NONBLOCK/O_APPEND. */
  flags: number;
  /**
   * Bytes read, 0 = EOF, or -errno. Blocks until data is available unless
   * O_NONBLOCK (-EAGAIN). An aborted `signal` ends a blocked read with -EINTR
   * (a read that already transferred data still returns it).
   */
  read(buf: Uint8Array, signal?: AbortSignal): Promise<number>;
  /** Bytes written or -errno. Same blocking and `signal` rules as read. */
  write(buf: Uint8Array, signal?: AbortSignal): Promise<number>;
  /** POLLIN/POLLOUT/POLLHUP/POLLERR currently ready, masked by `events` (POLLHUP/POLLERR always reported). */
  poll(events: number): number;
  /** Called whenever readiness may have changed; returns an unsubscribe function. */
  onReady(cb: () => void): () => void;
  /** `caller` is the calling process's syscall AbortSignal, as for read/write (Process.fromSyscallSignal maps it back). */
  ioctl?(req: number, arg: Uint8Array, caller?: AbortSignal): Promise<number>;
  /** Positional read/write (pread64/pwrite64): don't move the offset. Seekable files only. */
  pread?(buf: Uint8Array, off: number): Promise<number>;
  pwrite?(buf: Uint8Array, off: number): Promise<number>;
  /** New offset or -errno. */
  seek?(off: number, whence: number): number;
  stat(): Promise<KStat>;
  /** Called once, when the last fd referencing this description closes. */
  close(): Promise<void>;
  /** Directory streams: remaining entry names (getdents). */
  readdir?(): Promise<string[] | number>;
  /** Shrink or extend a regular file. */
  truncate?(len: number): Promise<number>;
  /** Push buffered writes to the backing store. */
  sync?(): Promise<void>;
  /** Path the description was opened with, when it has one (diagnostics, /proc). */
  path?: string;
  /**
   * Fast paths (Kernel.syscallSync): finish the call now when that needs no
   * waiting and no I/O (pipe data buffered, room in the pipe, file contents
   * in memory). `undefined` means "use the async method"; anything else is
   * the result the async method would have returned.
   */
  tryRead?(buf: Uint8Array): number | undefined;
  tryWrite?(buf: Uint8Array): number | undefined;
  statSync?(): KStat | undefined;
  /** Close now if that needs no I/O (true); false = call close(). Called instead of close(), at most once. */
  closeSync?(): boolean;
}

// ── Reference counting ──────────────────────────────────────────────────────

const refs = new WeakMap<OpenFile, number>();

/** Take a reference to an OpenFile (FdTable does this for every fd). */
export function retain(file: OpenFile): OpenFile {
  refs.set(file, (refs.get(file) ?? 0) + 1);
  return file;
}

/** Drop a reference; closes the description when the count reaches zero. */
export async function release(file: OpenFile): Promise<void> {
  const n = (refs.get(file) ?? 1) - 1;
  if (n > 0) {
    refs.set(file, n);
    // what a process wrote is in the FileSystem once it has closed it (or
    // exited), even when a forked child still holds the description
    if (file instanceof RegularFile) await file.writeBack();
    return;
  }
  refs.delete(file);
  await file.close();
}

/** release() when it needs no I/O (another reference remains, or the description closes synchronously); false = use release(). */
export function releaseSync(file: OpenFile): boolean {
  const n = (refs.get(file) ?? 1) - 1;
  if (n > 0 && file instanceof RegularFile && file.dirty) return false;
  if (n > 0) { refs.set(file, n); return true; }
  if (!file.closeSync?.()) return false;
  refs.delete(file);
  return true;
}

export function refCount(file: OpenFile): number {
  return refs.get(file) ?? 0;
}

// ── FdTable ─────────────────────────────────────────────────────────────────

interface FdEntry { file: OpenFile; cloexec: boolean }

export class FdTable {
  private fds = new Map<number, FdEntry>();
  /** RLIMIT_NOFILE: fds are below `limit` (the soft limit); `hardLimit` caps raising it (prlimit64) */
  limit = OPEN_MAX;
  hardLimit = NR_OPEN;

  get(fd: number): OpenFile | undefined {
    return this.fds.get(fd)?.file;
  }

  has(fd: number): boolean {
    return this.fds.has(fd);
  }

  /** Lowest free fd ≥ minFd, or -EMFILE. Takes a reference to `file`. */
  alloc(file: OpenFile, minFd = 0, cloexec = false): number {
    if (minFd >= this.limit) return -EINVAL; // F_DUPFD past RLIMIT_NOFILE
    for (let fd = minFd; fd < this.limit; fd++) {
      if (!this.fds.has(fd)) {
        this.fds.set(fd, { file: retain(file), cloexec });
        return fd;
      }
    }
    return -EMFILE;
  }

  /** Install `file` at exactly `fd`, closing what was there. */
  async set(fd: number, file: OpenFile, cloexec = false): Promise<number> {
    if (fd < 0 || fd >= this.limit) return -EBADF;
    retain(file);
    const old = this.fds.get(fd);
    this.fds.set(fd, { file, cloexec });
    if (old) await release(old.file).catch(() => {}); // dup2 drops close errors, as Linux does
    return fd;
  }

  dup(fd: number, minFd = 0, cloexec = false): number {
    const e = this.fds.get(fd);
    if (!e) return -EBADF;
    return this.alloc(e.file, minFd, cloexec);
  }

  /** dup2/dup3: `newFd` refers to the same description as `oldFd`. */
  async dup2(oldFd: number, newFd: number, cloexec = false): Promise<number> {
    const e = this.fds.get(oldFd);
    if (!e) return -EBADF;
    if (newFd < 0 || newFd >= this.limit) return -EBADF;
    if (oldFd === newFd) return newFd;
    return this.set(newFd, e.file, cloexec);
  }

  async close(fd: number): Promise<number> {
    const e = this.fds.get(fd);
    if (!e) return -EBADF;
    this.fds.delete(fd);
    // The fd is gone either way; a failed write-back is reported (ENOSPC)
    try { await release(e.file); } catch (err) { return errnoFromError(err); }
    return 0;
  }

  /** close() when it needs no I/O, else undefined (nothing changed: use close()). */
  closeSync(fd: number): number | undefined {
    const e = this.fds.get(fd);
    if (!e) return -EBADF;
    if (!releaseSync(e.file)) return undefined;
    this.fds.delete(fd);
    return 0;
  }

  getCloexec(fd: number): boolean | undefined {
    return this.fds.get(fd)?.cloexec;
  }

  setCloexec(fd: number, on: boolean): number {
    const e = this.fds.get(fd);
    if (!e) return -EBADF;
    e.cloexec = on;
    return 0;
  }

  /** A copy sharing every open file description (fork). */
  fork(): FdTable {
    const t = new FdTable();
    t.limit = this.limit; t.hardLimit = this.hardLimit;
    for (const [fd, e] of this.fds) t.fds.set(fd, { file: retain(e.file), cloexec: e.cloexec });
    return t;
  }

  /**
   * The table a spawned child gets (posix_spawn): every fd not marked
   * close-on-exec, with `overrides` (child fd → description) installed on
   * top. Synchronous; nothing is closed in this table.
   */
  inherit(overrides: Record<number, OpenFile> = {}): FdTable {
    const t = new FdTable();
    t.limit = this.limit; t.hardLimit = this.hardLimit;
    for (const [fd, e] of this.fds) {
      if (!e.cloexec && !(fd in overrides)) t.fds.set(fd, { file: retain(e.file), cloexec: false });
    }
    for (const [fd, file] of Object.entries(overrides)) t.fds.set(Number(fd), { file: retain(file), cloexec: false });
    return t;
  }

  /** Close every fd marked close-on-exec. */
  async closeOnExec(): Promise<void> {
    for (const [fd, e] of [...this.fds]) if (e.cloexec) await this.close(fd);
  }

  async closeAll(): Promise<void> {
    for (const fd of [...this.fds.keys()]) await this.close(fd);
  }

  entries(): [number, OpenFile][] {
    return [...this.fds].sort((a, b) => a[0] - b[0]).map(([fd, e]) => [fd, e.file]);
  }

  get size(): number {
    return this.fds.size;
  }
}

// ── Helpers for OpenFile implementations ────────────────────────────────────

/** A set of readiness listeners. */
export class ReadyListeners {
  private cbs = new Set<(mask?: number) => void>();
  add(cb: (mask?: number) => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  /**
   * `mask`: the events this change concerns (POLLIN when data arrived,
   * POLLOUT when room was made), as Linux's wake-up keys; epoll arms only
   * the edge-triggered entries watching them. 0 = anything may have changed.
   */
  fire(mask = 0): void {
    for (const cb of [...this.cbs]) {
      try { cb(mask); } catch { /* listener errors must not break I/O */ }
    }
  }
}

export function canRead(flags: number): boolean {
  return (flags & O_ACCMODE) !== O_WRONLY;
}
export function canWrite(flags: number): boolean {
  return (flags & O_ACCMODE) !== O_RDONLY;
}

export function charDevStat(rdev: number): KStat {
  const now = Date.now();
  return {
    dev: 5, ino: rdev, mode: S_IFCHR | 0o666, nlink: 1, uid: 0, gid: 0, rdev,
    size: 0, blksize: 4096, blocks: 0, atimeMs: now, mtimeMs: now, ctimeMs: now,
  };
}

/** Waits for a wake-up from `waiters` (true), or for `signal` to abort (false). */
export function abortableWait(waiters: Set<() => void>, signal?: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(false); return; }
    const wake = () => { cleanup(); resolve(true); };
    const onAbort = () => { cleanup(); resolve(false); };
    const cleanup = () => {
      waiters.delete(wake);
      signal?.removeEventListener('abort', onAbort);
    };
    waiters.add(wake);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ── Devices ────────────────────────────────────────────────────────────────

abstract class DevFile implements OpenFile {
  kind: OpenFileKind = 'dev';
  private listeners = new ReadyListeners();
  constructor(public flags: number, public path: string, private rdev: number) {}
  abstract read(buf: Uint8Array): Promise<number>;
  abstract write(buf: Uint8Array): Promise<number>;
  poll(events: number): number { return events & (POLLIN | POLLOUT); }
  onReady(cb: () => void): () => void { return this.listeners.add(cb); }
  seek(): number { return 0; }
  async stat(): Promise<KStat> { return charDevStat(this.rdev); }
  statSync(): KStat { return charDevStat(this.rdev); }
  closeSync(): boolean { return true; }
  async close(): Promise<void> {}
}

/** /dev/null: reads EOF, swallows writes. */
export class DevNull extends DevFile {
  constructor(flags = 2) { super(flags, '/dev/null', 0x103); }
  async read(): Promise<number> { return 0; }
  async write(buf: Uint8Array): Promise<number> { return buf.length; }
  tryRead(): number { return 0; }
  tryWrite(buf: Uint8Array): number { return buf.length; }
}

/** /dev/zero: endless zero bytes. */
export class DevZero extends DevFile {
  constructor(flags = 2) { super(flags, '/dev/zero', 0x105); }
  async read(buf: Uint8Array): Promise<number> { buf.fill(0); return buf.length; }
  async write(buf: Uint8Array): Promise<number> { return buf.length; }
}

/** /dev/urandom and /dev/random. */
export class DevRandom extends DevFile {
  constructor(flags = 2, path = '/dev/urandom') { super(flags, path, path === '/dev/random' ? 0x108 : 0x109); }
  async read(buf: Uint8Array): Promise<number> {
    // getRandomValues refuses SharedArrayBuffer views and > 64 KiB at once
    const chunk = new Uint8Array(Math.min(buf.length, 65536));
    for (let off = 0; off < buf.length; off += chunk.length) {
      const n = Math.min(chunk.length, buf.length - off);
      const view = chunk.subarray(0, n);
      crypto.getRandomValues(view);
      buf.set(view, off);
    }
    return buf.length;
  }
  async write(buf: Uint8Array): Promise<number> { return buf.length; }
}

/** /dev/full: reads zeros, writes fail with ENOSPC. */
export class DevFull extends DevZero {
  async write(): Promise<number> { return -28; }
}

// ── In-memory streams (host integration) ─────────────────────────────────────

/**
 * A byte source/sink held in memory. Reads drain the bytes given to the
 * constructor (or appended with `push`) and return EOF after `end()`;
 * writes accumulate and can be read back with `text()`/`bytes()`.
 * `onData` sees every write as it happens (streaming to a terminal).
 */
export class BufferFile implements OpenFile {
  kind: OpenFileKind = 'dev';
  private input: Uint8Array;
  private inputPos = 0;
  private ended: boolean;
  private chunks: Uint8Array[] = [];
  private waiters = new Set<() => void>();
  private listeners = new ReadyListeners();
  onData?: (data: Uint8Array) => void;

  /** Reports itself as a FIFO, so isatty() is false (piped stdin) */
  private fifo: boolean;

  constructor(input: Uint8Array | string | null = null, public flags = 2, opts: { open?: boolean; fifo?: boolean } = {}) {
    this.input = typeof input === 'string' ? new TextEncoder().encode(input) : (input ?? new Uint8Array(0));
    this.ended = !opts.open;
    this.fifo = !!opts.fifo;
  }

  /** Append more input (only for a BufferFile created with `{ open: true }`). */
  push(data: Uint8Array | string): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const rest = this.input.subarray(this.inputPos);
    const next = new Uint8Array(rest.length + bytes.length);
    next.set(rest);
    next.set(bytes, rest.length);
    this.input = next;
    this.inputPos = 0;
    this.wake();
  }

  end(): void {
    this.ended = true;
    this.wake();
  }

  private wake() {
    for (const w of [...this.waiters]) w();
    this.listeners.fire();
  }

  async read(buf: Uint8Array, signal?: AbortSignal): Promise<number> {
    for (;;) {
      const avail = this.input.length - this.inputPos;
      if (avail > 0) {
        const n = Math.min(avail, buf.length);
        buf.set(this.input.subarray(this.inputPos, this.inputPos + n));
        this.inputPos += n;
        return n;
      }
      if (this.ended) return 0;
      if (this.flags & O_NONBLOCK) return -EAGAIN;
      if (!(await abortableWait(this.waiters, signal))) return -EINTR;
    }
  }

  async write(buf: Uint8Array): Promise<number> {
    const copy = buf.slice();
    this.chunks.push(copy);
    this.onData?.(copy);
    return buf.length;
  }

  bytes(): Uint8Array {
    const len = this.chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(len);
    let off = 0;
    for (const c of this.chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  text(): string {
    return new TextDecoder().decode(this.bytes());
  }

  poll(events: number): number {
    let r = POLLOUT;
    if (this.input.length > this.inputPos || this.ended) r |= POLLIN;
    return r & events;
  }
  onReady(cb: () => void): () => void { return this.listeners.add(cb); }
  async ioctl(req: number, arg: Uint8Array): Promise<number> {
    if (req === FIONREAD && arg.length >= 4) {
      new DataView(arg.buffer, arg.byteOffset, 4).setInt32(0, this.input.length - this.inputPos, true);
      return 0;
    }
    return -ENOTTY;
  }
  async stat(): Promise<KStat> {
    const st = charDevStat(0);
    return this.fifo ? { ...st, mode: S_IFIFO | 0o600 } : st;
  }
  async close(): Promise<void> { this.end(); }
}

// ── Regular files backed by src/filesystem.ts ───────────────────────────────

/**
 * File contents shared by every description open on the same path, so two
 * fds see each other's writes. Loaded on first open, written back to the
 * FileSystem FLUSH_DELAY_MS after a write and when a description closes.
 * Writes made through the FileSystem API directly while a file is open are
 * not seen until every kernel description of it has closed.
 */
/**
 * Written data goes to the FileSystem once writes pause for FLUSH_DELAY_MS,
 * and at least every FLUSH_MAX_DELAY_MS while they continue (close and fsync
 * flush at once).
 */
const FLUSH_DELAY_MS = 25;
const FLUSH_MAX_DELAY_MS = 1000;
/** Uncommitted bytes in the FileSystem beyond which a close waits for the commit (Inode.flush). */
const WRITE_BACKLOG_BYTES = 16 << 20;

class Inode {
  data: Uint8Array;
  size: number;
  opens = 0;
  dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  /** The path was unlinked while open: the data lives on for the open fds only. */
  unlinked = false;
  /** Nanoseconds past mtimeMs; atime when set apart from mtime (null: follows it). See FSNode. */
  mtimeNs = 0;
  atimeMs: number | null = null;
  atimeNs = 0;

  constructor(public fs: FileSystem, public path: string, initial: Uint8Array, public mode: number, public mtimeMs: number, public ctimeMs: number,
    times?: { mtimeNs?: number; atime?: number; atimeNs?: number }) {
    this.data = initial;
    this.size = initial.length;
    this.mtimeNs = times?.mtimeNs ?? 0;
    if (times?.atime !== undefined) { this.atimeMs = times.atime; this.atimeNs = times.atimeNs ?? 0; }
  }

  ensure(cap: number) {
    if (cap <= this.data.length) return;
    const next = new Uint8Array(Math.max(cap, this.data.length * 2, 256));
    next.set(this.data.subarray(0, this.size));
    this.data = next;
  }

  touch() {
    const now = Date.now();
    if (!this.dirty) this.dirtySince = now;
    this.dirty = true;
    this.mtimeMs = this.lastWrite = now;
    this.ctimeMs = now; // (a write changes st_ctime too: Open POSIX mmap_14-1's msync)
    this.mtimeNs = 0;
    // Each flush writes the whole file: wait for a burst of writes to pause (a
    // program writing 64 KiB at a time used to store the file after every write)
    if (!this.flushTimer) this.armFlush(FLUSH_DELAY_MS);
  }

  private dirtySince = 0;
  private lastWrite = 0;

  private armFlush(ms: number) {
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const now = Date.now();
      const quiet = now - this.lastWrite;
      // Each write-back copies the whole file: a big file being written (apt
      // unpacking a 56 MB index) waits longer, or the copies grow quadratically
      const mb = this.size / (1 << 20);
      const pause = Math.max(FLUSH_DELAY_MS, mb * 20);
      const most = Math.max(FLUSH_MAX_DELAY_MS, mb * 500);
      if (this.dirty && quiet < pause && now - this.dirtySince < most) this.armFlush(pause - quiet);
      else void this.flush(true);
    }, ms);
  }

  /** A write-back is in progress. */
  get busy(): boolean { return !!this.flushing; }

  /**
   * Write the data back to the FileSystem. `paced` (the write-back timer, a
   * file still being written) also waits for the IndexedDB commit, so a
   * growing file isn't snapshotted again before the last copy is stored.
   * close, rename and the like don't wait for the commit, as close(2) doesn't
   * wait for the disk (dpkg closed ~1700 files per python3 install, ~4 ms each);
   * fsync does (RegularFile.sync).
   */
  /**
   * flush() without waiting, when the FileSystem has the node in memory and
   * no backlog: the data goes into its cache now (stored by the next commit).
   * False when that needs flush().
   */
  flushSync(): boolean {
    if (this.flushing) return false;
    if (!this.dirty || this.unlinked) return true;
    if (this.fs.pendingBytes > WRITE_BACKLOG_BYTES) return false;
    const times = { mtime: this.mtimeMs, mtimeNs: this.mtimeNs, ...(this.atimeMs === null ? {} : { atime: this.atimeMs, atimeNs: this.atimeNs }) };
    if (!this.fs.writeCachedSync(this.path, this.data.slice(0, this.size), times)) return false;
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.dirty = false;
    return true;
  }

  async flush(paced = false): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    while (this.flushing) await this.flushing;
    if (!this.dirty || this.unlinked) return;
    this.dirty = false;
    const snapshot = this.data.slice(0, this.size);
    // With the times this inode reports (the last write's, or utimensat's), not the write-back's
    const times = { mtime: this.mtimeMs, mtimeNs: this.mtimeNs, ...(this.atimeMs === null ? {} : { atime: this.atimeMs, atimeNs: this.atimeNs }) };
    // Refused (storage full: ENOSPC): the data stays here for a retry by fsync or close
    const written = this.fs.writeFile(this.path, snapshot, { times }).catch((e) => { this.dirty = true; throw e; });
    // Paced: writes made meanwhile go into one later snapshot. Past a backlog of
    // uncommitted data a close waits too, or a fast writer (dpkg unpacking)
    // holds it all in memory (python3's install peaked 150 MiB higher)
    const wait = paced || this.fs.pendingBytes > WRITE_BACKLOG_BYTES;
    this.flushing = (wait ? written.then(() => this.fs.flushed()) : written).finally(() => { this.flushing = null; });
    await this.flushing;
  }
}

const inodeTables = new WeakMap<FileSystem, Map<string, Inode>>();

/** Open (or share) the inode for `path`; `path` must already be resolved and exist or be created by the caller. */
export async function openInode(fs: FileSystem, path: string): Promise<Inode> {
  let table = inodeTables.get(fs);
  if (!table) { table = new Map(); inodeTables.set(fs, table); }
  let ino = table.get(path);
  if (!ino) {
    const st = await fs.stat(path);
    const raw = await fs.readFile(path);
    const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw;
    ino = table.get(path) ?? new Inode(fs, path, bytes, st.mode, st.mtime.getTime(), st.ctime.getTime(),
      { mtimeNs: st.mtimeNs, atime: st.atimeMs === st.mtime.getTime() && st.atimeNs === st.mtimeNs ? undefined : st.atimeMs, atimeNs: st.atimeNs });
    table.set(path, ino);
    const shared = sharedInodes.get(fs)?.get(path);
    if (shared) adoptShared(ino, shared);
  }
  ino.opens++;
  return ino;
}

/** openInode for a file whose node the FileSystem has in memory (FileSystem.lookupCached). */
export function openInodeSync(fs: FileSystem, path: string, node: {
  content: Uint8Array | null; mode: number; mtime: number; ctime: number; mtimeNs?: number; atime?: number; atimeNs?: number;
}): Inode {
  let table = inodeTables.get(fs);
  if (!table) { table = new Map(); inodeTables.set(fs, table); }
  let ino = table.get(path);
  if (!ino) {
    // Like readFile: the cached node's bytes, null meaning empty
    ino = new Inode(fs, path, node.content ?? new Uint8Array(0), node.mode, node.mtime, node.ctime, node);
    table.set(path, ino);
    const shared = sharedInodes.get(fs)?.get(path);
    if (shared) adoptShared(ino, shared);
  }
  ino.opens++;
  return ino;
}

/** Write back every open file of `fs` holding data not yet in it (the page going away: FileSystem.flushAll). */
export async function writeBackAll(fs: FileSystem): Promise<void> {
  const table = inodeTables.get(fs);
  if (table) await Promise.all([...table.values()].filter((ino) => ino.dirty).map((ino) => ino.flush()));
}

/** closeInode when nothing needs to be written back; false = use closeInode. */
function closeInodeSync(ino: Inode): boolean {
  // Written data goes back now when the FileSystem can take it synchronously (node in a Worker closes after each write)
  if (ino.busy || (ino.dirty && !ino.flushSync())) return false;
  ino.opens--;
  const table = inodeTables.get(ino.fs);
  if (ino.opens === 0 && table?.get(ino.path) === ino) table.delete(ino.path);
  return true;
}

async function closeInode(ino: Inode): Promise<void> {
  ino.opens--;
  try {
    await ino.flush();
  } finally {
    const table = inodeTables.get(ino.fs);
    if (ino.opens === 0 && table?.get(ino.path) === ino) table.delete(ino.path);
  }
}

/**
 * Call before renaming `from` to `to` in the FileSystem: writes back what
 * open descriptions hold for `from` (and anything under it), and afterwards
 * (the returned function) moves those inodes to their new paths, so a later
 * flush doesn't recreate `from` (compilers write a temp file and rename it
 * while it is still open). An inode open at `to` is replaced, as by unlink.
 */
export async function renameInodes(fs: FileSystem, from: string, to: string): Promise<() => void> {
  const table = inodeTables.get(fs);
  if (!table) return () => {};
  const moved = [...table.values()].filter(ino => ino.path === from || ino.path.startsWith(from + '/'));
  for (const ino of moved) await ino.flush();
  return () => {
    const old = table.get(to);
    if (old && !moved.includes(old)) { old.unlinked = true; table.delete(to); }
    for (const ino of moved) {
      table.delete(ino.path);
      ino.path = to + ino.path.slice(from.length);
      table.set(ino.path, ino);
    }
  };
}

/**
 * Call before unlinking `path`: open descriptions keep its data but never
 * write it back (this waits out a write-back already under way).
 */
export async function unlinkInode(fs: FileSystem, path: string): Promise<void> {
  const table = inodeTables.get(fs);
  const ino = table?.get(path);
  if (!ino || !table) return;
  ino.unlinked = true;
  table.delete(path);
  await ino.flush();
}

/** Whether `path` (resolved) is open: unlink must then hand its data to the open fds. */
export function isInodeOpen(fs: FileSystem, path: string): boolean {
  return !!inodeTables.get(fs)?.has(path);
}

/** Whether any file of `fs` is open (inodeStat can only answer then). */
export function hasOpenInodes(fs: FileSystem): boolean {
  return !!inodeTables.get(fs)?.size;
}

/**
 * stat of an open inode for `path` (resolved) holding writes not yet in the
 * FileSystem: its size and times are the newer ones until written back.
 */
export function inodeStat(fs: FileSystem, path: string): KStat | undefined {
  const ino = inodeTables.get(fs)?.get(path);
  return ino && (ino.dirty || ino.busy) ? inodeKStat(ino) : undefined;
}

function inodeKStat(ino: Inode): KStat {
  return {
    dev: 1, ino: inodeNumber(ino.fs, ino.path), mode: S_IFREG | (ino.mode & 0o7777), nlink: linkCount(ino.fs, ino.path), uid: 1000, gid: 1000, rdev: 0,
    size: ino.size, blksize: 4096, blocks: Math.ceil(ino.size / 512),
    atimeMs: ino.atimeMs ?? ino.mtimeMs, mtimeMs: ino.mtimeMs, ctimeMs: ino.ctimeMs,
    atimeNs: ino.atimeMs === null ? ino.mtimeNs : ino.atimeNs, mtimeNs: ino.mtimeNs,
  };
}

/** Write back what an open inode for `path` holds (before reading the path's times from the FileSystem). */
export async function flushInode(fs: FileSystem, path: string): Promise<void> {
  await inodeTables.get(fs)?.get(path)?.flush();
}

/**
 * Files whose bytes live in a shared object's buffer (shmobj.ts: a /dev/shm
 * file mapped by Blink as remote pages): an inode open on one reads and
 * writes the buffer, so read/write and the mappings see each other, and
 * one opened later takes the buffer rather than the FileSystem's older copy.
 */
const sharedInodes = new WeakMap<FileSystem, Map<string, Uint8Array>>();

function adoptShared(ino: Inode, view: Uint8Array): void {
  if (ino.size <= view.length && ino.data.buffer !== view.buffer) ino.data = view;
}

/** `path`'s bytes are the first `length` bytes of `sab` while it's remote. */
export function attachInodeShared(fs: FileSystem, path: string, sab: SharedArrayBuffer, length: number): void {
  let m = sharedInodes.get(fs);
  if (!m) { m = new Map(); sharedInodes.set(fs, m); }
  const view = new Uint8Array(sab, 0, length);
  m.set(path, view);
  const ino = inodeTables.get(fs)?.get(path);
  if (ino && !ino.unlinked) adoptShared(ino, view);
}

/**
 * The shared object's last mapping went: its final bytes go to `path`, into
 * its open inode, if any (back in private memory), which fds read and which
 * writes them back now; only the bytes within the file's size. False when
 * no inode is open.
 */
export async function writeInodeBytes(fs: FileSystem, path: string, bytes: Uint8Array): Promise<boolean> {
  sharedInodes.get(fs)?.delete(path);
  const ino = inodeTables.get(fs)?.get(path);
  if (!ino || ino.unlinked) return false;
  const n = Math.min(bytes.length, ino.size);
  if (ino.data.buffer instanceof SharedArrayBuffer) {
    const own = new Uint8Array(Math.max(ino.size, 256));
    own.set(ino.data.subarray(0, ino.size));
    ino.data = own;
  }
  ino.data.set(bytes.subarray(0, n));
  ino.touch();
  await ino.flush();  // (the FileSystem has it when the last unmap returns)
  return true;
}

/** chmod of `path`: an open inode reports (inodeStat) the new mode. */
export function setInodeMode(fs: FileSystem, path: string, mode: number): void {
  const ino = inodeTables.get(fs)?.get(path);
  if (ino) ino.mode = (ino.mode & ~0o7777) | (mode & 0o7777);
}

/**
 * utimensat on `path`: an open inode writes back what it holds first (so a
 * later write-back doesn't stamp the current time over the new times) and
 * then reports the new times. Call before FileSystem.utimes.
 */
export async function setInodeTimes(fs: FileSystem, path: string, t: { atimeMs: number; atimeNs: number; mtimeMs: number; mtimeNs: number }): Promise<void> {
  const ino = inodeTables.get(fs)?.get(path);
  if (!ino) return;
  await ino.flush();
  ino.mtimeMs = t.mtimeMs;
  ino.mtimeNs = t.mtimeNs;
  const same = t.atimeMs === t.mtimeMs && t.atimeNs === t.mtimeNs;
  ino.atimeMs = same ? null : t.atimeMs;
  ino.atimeNs = same ? 0 : t.atimeNs;
}

/**
 * st_ino of canonical `path`: the FileSystem's persistent per-node number
 * (FSNode.ino), so it agrees across stat, fstat, getdents and reloads and
 * follows renames. Without a FileSystem, a per-path counter.
 */
const inoNumbers = new Map<string, number>();
let nextIno = 2;
export function inodeNumber(fs: FileSystem | null | undefined, path: string): number {
  if (fs) return fs.inoOf(path);
  let n = inoNumbers.get(path);
  if (!n) { n = nextIno++; inoNumbers.set(path, n); }
  return n;
}

/**
 * link() copies (no hard links), but the copy gets its source's inode number,
 * as a hard link would (git's local clone checks that), and both names count
 * in st_nlink.
 */
export function shareInodeNumber(fs: FileSystem, from: string, to: string): void {
  const n = inodeNumber(fs, from);
  forgetInodeNumber(fs, to);
  fs.setIno(to, n);
  let names = linkNames.get(n);
  if (!names) { names = new Set([from]); linkNames.set(n, names); }
  names.add(to);
}

/** `path` is unlinked (or renamed away): it no longer counts as a link. */
export function forgetInodeNumber(fs: FileSystem, path: string): void {
  for (const [n, names] of linkNames) {
    if (names.delete(path)) { if (names.size < 2) linkNames.delete(n); break; }
  }
}

/** A rename moves a link name (the number moves with the node). */
export function renameLinkName(from: string, to: string): void {
  for (const names of linkNames.values()) if (names.delete(from)) { names.add(to); break; }
}

/** The names link() gave one inode number (only numbers with two or more). */
const linkNames = new Map<number, Set<string>>();

/**
 * st_nlink of a regular file: how many names link() gave it (shadow's
 * lock, link(group.PID, group.lock), checks that the count went to 2).
 */
export function linkCount(fs: FileSystem | null | undefined, path: string): number {
  return linkNames.get(inodeNumber(fs, path))?.size ?? 1;
}

export class RegularFile implements OpenFile {
  kind: OpenFileKind = 'file';
  private pos = 0;
  private listeners = new ReadyListeners();
  private closed = false;

  constructor(private ino: Inode, public flags: number) {}

  get path(): string { return this.ino.path; }

  async read(buf: Uint8Array): Promise<number> { return this.tryRead(buf); }

  tryRead(buf: Uint8Array): number {
    if (!canRead(this.flags)) return -EBADF;
    const n = Math.max(0, Math.min(buf.length, this.ino.size - this.pos));
    if (n > 0) buf.set(this.ino.data.subarray(this.pos, this.pos + n));
    this.pos += n;
    return n;
  }

  async write(buf: Uint8Array): Promise<number> { return this.tryWrite(buf); }

  tryWrite(buf: Uint8Array): number {
    if (!canWrite(this.flags)) return -EBADF;
    const ino = this.ino;
    if (this.flags & O_APPEND) this.pos = ino.size;
    const end = this.pos + buf.length;
    ino.ensure(end);
    if (this.pos > ino.size) ino.data.fill(0, ino.size, this.pos);
    ino.data.set(buf, this.pos);
    if (end > ino.size) ino.size = end;
    this.pos = end;
    ino.touch();
    // O_SYNC/O_DSYNC: start the write-back now rather than after the usual delay
    if (this.flags & O_DSYNC) void ino.flush();
    return buf.length;
  }

  async pread(buf: Uint8Array, off: number): Promise<number> {
    if (!canRead(this.flags)) return -EBADF;
    if (off < 0) return -EINVAL;
    const n = Math.max(0, Math.min(buf.length, this.ino.size - off));
    if (n > 0) buf.set(this.ino.data.subarray(off, off + n));
    return n;
  }

  async pwrite(buf: Uint8Array, off: number): Promise<number> {
    if (!canWrite(this.flags)) return -EBADF;
    if (off < 0) return -EINVAL;
    const save = this.pos;
    const append = this.flags & O_APPEND; // Linux: pwrite on O_APPEND appends
    this.pos = off;
    if (append) this.flags &= ~O_APPEND;
    try {
      if (append) this.pos = this.ino.size;
      return this.tryWrite(buf);
    } finally {
      if (append) this.flags |= O_APPEND;
      this.pos = save;
    }
  }

  seek(off: number, whence: number): number {
    let base: number;
    if (whence === SEEK_SET) base = 0;
    else if (whence === SEEK_CUR) base = this.pos;
    else if (whence === SEEK_END) base = this.ino.size;
    else return -EINVAL;
    const next = base + off;
    if (next < 0) return -EINVAL;
    this.pos = next;
    return next;
  }

  async truncate(len: number): Promise<number> { return this.truncateSync(len); }

  truncateSync(len: number): number {
    if (!canWrite(this.flags)) return -EINVAL;
    if (len < 0) return -EINVAL;
    const ino = this.ino;
    ino.ensure(len);
    if (len > ino.size) ino.data.fill(0, ino.size, len);
    ino.size = len;
    ino.touch();
    return 0;
  }

  /** Unwritten data, or a write-back under way. */
  get dirty(): boolean { return this.ino.dirty || this.ino.busy; }

  /** Write pending data back to the FileSystem (not to IndexedDB, as sync does). */
  async writeBack(): Promise<void> { if (this.ino.dirty) await this.ino.flush(); }

  // fsync: the inode's snapshot into the fs, then the fs's write-behind queue to IndexedDB
  async sync(): Promise<void> { await this.ino.flush(); await this.ino.fs.sync(); }

  poll(events: number): number { return events & (POLLIN | POLLOUT); }
  onReady(cb: () => void): () => void { return this.listeners.add(cb); }

  async ioctl(req: number, arg: Uint8Array): Promise<number> {
    if (req === FIONREAD && arg.length >= 4) {
      new DataView(arg.buffer, arg.byteOffset, 4).setInt32(0, Math.max(0, this.ino.size - this.pos), true);
      return 0;
    }
    return -ENOTTY;
  }

  async stat(): Promise<KStat> { return this.statSync(); }

  statSync(): KStat { return inodeKStat(this.ino); }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await closeInode(this.ino);
  }

  closeSync(): boolean {
    if (this.closed) return true;
    if (!closeInodeSync(this.ino)) return false;
    this.closed = true;
    return true;
  }
}

/** A directory stream (open(dir, O_RDONLY|O_DIRECTORY)); getdents reads it. */
export class DirFile implements OpenFile {
  kind: OpenFileKind = 'dir';
  private entries: string[] | null = null;
  private listeners = new ReadyListeners();
  constructor(private fs: FileSystem, public path: string, public flags: number) {}
  async read(): Promise<number> { return -EISDIR; }
  async write(): Promise<number> { return -EBADF; }
  seek(off: number, whence: number): number {
    if (whence === SEEK_SET && off === 0) { this.entries = null; return 0; }
    return -ESPIPE;
  }
  /** Entries not yet consumed. The caller removes the ones it returned via `consume`. */
  async readdir(): Promise<string[] | number> {
    if (!this.entries) {
      try { this.entries = ['.', '..', ...(await this.fs.readdir(this.path))]; }
      catch { return -EBADF; }
    }
    return this.entries;
  }
  consume(n: number): void { this.entries?.splice(0, n); }
  poll(events: number): number { return events & POLLIN; }
  onReady(cb: () => void): () => void { return this.listeners.add(cb); }
  async stat(): Promise<KStat> {
    const st = await this.fs.stat(this.path);
    return {
      dev: 1, ino: inodeNumber(this.fs, this.path), mode: S_IFDIR | (st.mode & 0o7777), nlink: 2, uid: 1000, gid: 1000, rdev: 0,
      size: 4096, blksize: 4096, blocks: 8,
      atimeMs: st.atimeMs ?? st.mtime.getTime(), mtimeMs: st.mtime.getTime(), ctimeMs: st.ctime.getTime(),
      atimeNs: st.atimeNs, mtimeNs: st.mtimeNs,
    };
  }
  statSync(): KStat | undefined {
    const hit = this.fs.lookupCached(this.path);
    if (!hit || hit.node.type !== 'dir') return undefined;
    return {
      dev: 1, ino: inodeNumber(this.fs, this.path), mode: S_IFDIR | (hit.node.mode & 0o7777), nlink: 2, uid: 1000, gid: 1000, rdev: 0,
      size: 4096, blksize: 4096, blocks: 8, atimeMs: hit.node.atime ?? hit.node.mtime, mtimeMs: hit.node.mtime, ctimeMs: hit.node.ctime,
      atimeNs: hit.node.atime === undefined ? hit.node.mtimeNs : hit.node.atimeNs, mtimeNs: hit.node.mtimeNs,
    };
  }
  async close(): Promise<void> {}
  closeSync(): boolean { return true; }
}

// ── timerfd ──────────────────────────────────────────────────────────────────

/**
 * timerfd(2): readable once the timer expires; a read returns how many times
 * it expired since the last read (an interval timer keeps counting). Times
 * are kept on the kernel's own clock (performance.now() ms); the syscall
 * converts what the guest asked for.
 */
export class TimerFile implements OpenFile {
  kind: OpenFileKind = 'dev';
  private deadline = 0;  // 0: disarmed
  private interval = 0;
  private expired = 0n;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new ReadyListeners();
  private waiters = new Set<() => void>();
  constructor(public readonly clockid: number, public flags: number) {}
  private static now(): number { return performance.now(); }
  /** Moves expirations up to now into `expired`, re-arms or disarms. */
  private advance(now = TimerFile.now()): void {
    if (!this.deadline || now < this.deadline) return;
    if (this.interval > 0) {
      const n = Math.floor((now - this.deadline) / this.interval) + 1;
      this.expired += BigInt(n);
      this.deadline += n * this.interval;
    } else {
      this.expired += 1n;
      this.deadline = 0;
    }
  }
  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.deadline) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.advance();
      if (this.expired > 0n) {
        for (const w of [...this.waiters]) w();
        this.listeners.fire();
      }
      this.schedule();
    }, Math.max(0, this.deadline - TimerFile.now()));
  }
  /** Arms (value > 0, ms from now) or disarms (value 0); returns the old [value, interval]. */
  set(value: number, interval: number): [number, number] {
    const old = this.get();
    this.expired = 0n;
    this.interval = value > 0 ? Math.max(0, interval) : 0;
    this.deadline = value > 0 ? TimerFile.now() + value : 0;
    this.schedule();
    return old;
  }
  /** Time to the next expiration (0: disarmed) and the interval, in ms. */
  get(): [number, number] {
    this.advance();
    return [this.deadline ? Math.max(this.deadline - TimerFile.now(), 1e-6) : 0, this.interval];
  }
  async read(buf: Uint8Array, signal?: AbortSignal): Promise<number> {
    if (buf.length < 8) return -EINVAL;
    for (;;) {
      this.advance();
      if (this.expired > 0n) break;
      if (this.flags & O_NONBLOCK) return -EAGAIN;
      if (!(await abortableWait(this.waiters, signal))) return -EINTR;
    }
    new DataView(buf.buffer, buf.byteOffset, 8).setBigUint64(0, this.expired, true);
    this.expired = 0n;
    return 8;
  }
  async write(): Promise<number> { return -EINVAL; }
  poll(events: number): number {
    this.advance();
    return (this.expired > 0n ? POLLIN : 0) & events;
  }
  onReady(cb: () => void): () => void { return this.listeners.add(cb); }
  async stat(): Promise<KStat> { return charDevStat(0); }
  async close(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    for (const w of [...this.waiters]) w();
  }
}

// ── eventfd ──────────────────────────────────────────────────────────────────

/** eventfd(2): a 64-bit counter. Reads return and clear it (or take 1 with EFD_SEMAPHORE); writes add. */
export class EventFile implements OpenFile {
  kind: OpenFileKind = 'dev';
  private count: bigint;
  private listeners = new ReadyListeners();
  private waiters = new Set<() => void>();
  constructor(initval: number, public flags: number, private semaphore = false) {
    this.count = BigInt(initval >>> 0);
  }
  private wake(): void {
    for (const w of [...this.waiters]) w();
    this.listeners.fire();
  }
  async read(buf: Uint8Array, signal?: AbortSignal): Promise<number> {
    if (buf.length < 8) return -EINVAL;
    while (this.count === 0n) {
      if (this.flags & O_NONBLOCK) return -EAGAIN;
      if (!(await abortableWait(this.waiters, signal))) return -EINTR;
    }
    const v = this.semaphore ? 1n : this.count;
    this.count -= v;
    new DataView(buf.buffer, buf.byteOffset, 8).setBigUint64(0, v, true);
    this.wake();
    return 8;
  }
  async write(buf: Uint8Array): Promise<number> {
    if (buf.length < 8) return -EINVAL;
    const v = new DataView(buf.buffer, buf.byteOffset, 8).getBigUint64(0, true);
    if (v === 0xffffffffffffffffn) return -EINVAL;
    this.count += v;
    if (this.count > 0xfffffffffffffffen) this.count = 0xfffffffffffffffen;
    this.wake();
    return 8;
  }
  poll(events: number): number {
    return ((this.count > 0n ? POLLIN : 0) | POLLOUT) & events;
  }
  onReady(cb: () => void): () => void { return this.listeners.add(cb); }
  async stat(): Promise<KStat> { return charDevStat(0); }
  async close(): Promise<void> { this.wake(); }
}

let nextMemIno = 1;

/**
 * An anonymous regular file in memory (memfd_create): it reads, writes,
 * seeks and truncates like a file on disk, and polls always ready (epoll
 * refuses it, as it does regular files). Blink backs the /proc files it
 * generates (/proc/self/maps) with one, so they seek and poll as Linux's do.
 */
export class MemFile implements OpenFile {
  kind: OpenFileKind = 'file';
  private data: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private len = 0;
  private pos = 0;
  private ino = nextMemIno++;
  private mtimeMs = Date.now();
  private listeners = new ReadyListeners();
  /**
   * fcntl F_ADD_SEALS/F_GET_SEALS bits (F_SEAL_*). Without MFD_ALLOW_SEALING
   * a memfd starts sealed against more seals, as Linux's does.
   */
  seals = F_SEAL_SEAL;

  constructor(public path: string, public flags = O_RDWR) {}

  /** Shared-object key (shmobj.ts): unique per memfd */
  get shareKey(): string { return `memfd:${this.ino}`; }

  /** A copy of the contents */
  bytes(): Uint8Array { return this.data.slice(0, this.len); }

  /**
   * The memfd turned remote (mapped by two Blink instances): its bytes live
   * in `sab` from now on, so read/write and the mappings stay coherent.
   * Growing past the buffer (ftruncate while mapped) leaves it, as the
   * mappings can't grow either.
   */
  attachShared(sab: SharedArrayBuffer, length = sab.byteLength): void {
    if (length < this.len) return;
    const view = new Uint8Array(sab, 0, length);
    view.set(this.data.subarray(0, this.len));
    this.data = view;
  }

  /** The last mapping went: back to private memory with the final bytes */
  detachShared(bytes: Uint8Array): void {
    if (!(this.data.buffer instanceof SharedArrayBuffer)) return;
    this.data = bytes.slice(0, Math.max(this.len, 0));
    if (this.data.length < this.len) this.grow(this.len);
  }

  private grow(n: number): void {
    if (n <= this.data.length) return;
    const next = new Uint8Array(Math.max(n, this.data.length * 2, 4096));
    next.set(this.data.subarray(0, this.len));
    this.data = next;
  }

  async pread(buf: Uint8Array, off: number): Promise<number> {
    if ((this.flags & O_ACCMODE) === O_WRONLY) return -EBADF;
    if (off >= this.len) return 0;
    const n = Math.min(buf.length, this.len - off);
    buf.set(this.data.subarray(off, off + n));
    return n;
  }

  async pwrite(buf: Uint8Array, off: number): Promise<number> {
    if ((this.flags & O_ACCMODE) === O_RDONLY) return -EBADF;
    if (this.seals & (F_SEAL_WRITE | F_SEAL_FUTURE_WRITE)) return -EPERM;
    if (off + buf.length > this.len && this.seals & F_SEAL_GROW) return -EPERM;
    this.grow(off + buf.length);
    this.data.set(buf, off);
    this.len = Math.max(this.len, off + buf.length);
    this.mtimeMs = Date.now();
    return buf.length;
  }

  async read(buf: Uint8Array): Promise<number> {
    const n = await this.pread(buf, this.pos);
    if (n > 0) this.pos += n;
    return n;
  }

  async write(buf: Uint8Array): Promise<number> {
    if (this.flags & O_APPEND) this.pos = this.len;
    const n = await this.pwrite(buf, this.pos);
    if (n > 0) this.pos += n;
    return n;
  }

  seek(off: number, whence: number): number {
    const base = whence === SEEK_SET ? 0 : whence === SEEK_CUR ? this.pos : whence === SEEK_END ? this.len : NaN;
    if (Number.isNaN(base) || base + off < 0) return -EINVAL;
    return (this.pos = base + off);
  }

  async truncate(len: number): Promise<number> {
    if (len < 0) return -EINVAL;
    if ((len < this.len && this.seals & F_SEAL_SHRINK) || (len > this.len && this.seals & F_SEAL_GROW)) return -EPERM;
    this.grow(len);
    if (len > this.len) this.data.fill(0, this.len, len);
    this.len = len;
    this.mtimeMs = Date.now();
    return 0;
  }

  poll(events: number): number { return events & (POLLIN | POLLOUT); }
  onReady(cb: () => void): () => void { return this.listeners.add(cb); }

  statSync(): KStat {
    return {
      dev: 6, ino: this.ino, mode: S_IFREG | 0o777, nlink: 1, uid: 1000, gid: 1000, rdev: 0,
      size: this.len, blksize: 4096, blocks: Math.ceil(this.len / 512), atimeMs: this.mtimeMs, mtimeMs: this.mtimeMs, ctimeMs: this.mtimeMs,
    };
  }
  async stat(): Promise<KStat> { return this.statSync(); }
  async close(): Promise<void> { this.data = new Uint8Array(0); this.len = 0; }
}
