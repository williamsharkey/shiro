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
  O_ACCMODE, O_RDONLY, O_WRONLY, O_RDWR, O_APPEND, O_NONBLOCK, O_DSYNC, O_PATH, OPEN_MAX, NR_OPEN,
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

/**
 * A big file (FileSystem.blobMin or more) is held in pages of the
 * FileSystem's block size, loaded when read and written back a block at a
 * time (FileSystem.writeBlocks), so writing or reading one never needs all
 * of it in memory: at most DIRTY_PAGES written pages (a writer waits for
 * them to be stored past that) and KEEP_PAGES clean ones.
 */
const DIRTY_PAGES = 8;
const KEEP_PAGES = 4;

class Inode {
  /** Small files: the bytes (capacity may exceed size). Empty for a paged file. */
  data: Uint8Array;
  /** Its own array while `data` is a shared object's buffer (attachInodeShared) */
  privateData?: Uint8Array;
  size: number;
  opens = 0;
  dirty = false;
  /** A paged (big) file: its FileSystem blob, and its loaded pages, least recently used first. */
  blob: string | null = null;
  private pages = new Map<number, Uint8Array>();
  private dirtyPages = new Set<number>();
  /** Pages from this byte on are zeros whatever the store holds (a truncate cut them off; a new blob has none). */
  private zeroFrom = Infinity;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  /** The path was unlinked while open: the data lives on for the open fds only. */
  unlinked = false;
  /** Its key in the inode table (inodeKey): the path, or the inode number of a file with hard links. */
  key = '';
  /** Blocks of an unlinked big file this inode still reads (FileSystem.holdBlob), released at the last close. */
  heldBlob: string | null = null;
  /** An O_TMPFILE file without O_EXCL: linkat may give it a name (linkAnonymousInode). */
  tmpfile = false;
  /** Nanoseconds past mtimeMs; atime when set apart from mtime (null: follows it). See FSNode. */
  mtimeNs = 0;
  atimeMs: number | null = null;
  atimeNs = 0;

  constructor(public fs: FileSystem, public path: string, initial: Uint8Array, public mode: number, public mtimeMs: number, public ctimeMs: number,
    times?: { mtimeNs?: number; atime?: number; atimeNs?: number }, blob?: { id: string; size: number }) {
    this.data = initial;
    this.size = initial.length;
    if (blob) { this.blob = blob.id; this.size = blob.size; }
    this.mtimeNs = times?.mtimeNs ?? 0;
    if (times?.atime !== undefined) { this.atimeMs = times.atime; this.atimeNs = times.atimeNs ?? 0; }
  }

  private get B(): number { return this.fs.blockSize; }

  // ── Reading and writing (sync: false/undefined when pages must load first) ──

  /** Copy bytes at `off` into `buf`: the count, or undefined when a page isn't loaded (readAt). */
  readSync(buf: Uint8Array, off: number): number | undefined {
    const n = Math.max(0, Math.min(buf.length, this.size - off));
    if (!this.blob) {
      if (n > 0) buf.set(this.data.subarray(off, off + n));
      return n;
    }
    const B = this.B;
    for (let p = off; p < off + n; p = (Math.floor(p / B) + 1) * B) if (!this.pages.has(Math.floor(p / B))) return undefined;
    for (let done = 0; done < n;) {
      const p = off + done;
      const page = this.page(Math.floor(p / B))!;
      const k = Math.min(n - done, B - (p % B));
      buf.set(page.subarray(p % B, p % B + k), done);
      done += k;
    }
    return n;
  }

  async readAt(buf: Uint8Array, off: number): Promise<number> {
    for (;;) {
      const n = this.readSync(buf, off);
      if (n !== undefined) { this.trimPages(); return n; }
      await this.loadPages(off, Math.min(off + buf.length, this.size));
    }
  }

  /** Write `buf` at `off`: false when pages must load or written pages be stored first (writeAt). */
  writeSync(buf: Uint8Array, off: number): boolean {
    const end = off + buf.length;
    if (!this.blob && !this.shared && end >= (this.fs.blobMin ?? Infinity)) this.toPages();
    if (!this.blob) {
      this.ensure(end);
      if (off > this.size) this.data.fill(0, this.size, off);
      this.data.set(buf, off);
      if (end > this.size) this.size = end;
      this.touch();
      return true;
    }
    if (!this.writable(off, end)) return false;
    this.extendTo(off);
    const B = this.B;
    for (let done = 0; done < buf.length;) {
      const p = off + done;
      const i = Math.floor(p / B);
      const page = this.page(i) ?? this.freshPage(i);
      const k = Math.min(buf.length - done, B - (p % B));
      page.set(buf.subarray(done, done + k), p % B);
      this.dirtyPages.add(i);
      done += k;
    }
    if (end > this.size) this.size = end;
    this.touch();
    this.trimPages();
    return true;
  }

  async writeAt(buf: Uint8Array, off: number): Promise<void> {
    while (!this.writeSync(buf, off)) {
      if (this.dirtyPages.size >= DIRTY_PAGES && !this.unlinked) await this.flush(true);
      else await this.loadPages(off, off + buf.length, true);
    }
  }

  /** Set the size: false when a page must load first (truncate). */
  truncateSync(len: number): boolean {
    if (!this.blob) {
      if (len >= (this.fs.blobMin ?? Infinity) && !this.shared) this.toPages();
      else {
        this.ensure(len);
        if (len > this.size) this.data.fill(0, this.size, len);
        this.size = len;
        this.touch();
        return true;
      }
    }
    if (len === 0) {
      // Empty again: a small file (the blob goes at the next write-back)
      this.blob = null;
      this.pages.clear();
      this.dirtyPages.clear();
      this.zeroFrom = Infinity;
      this.data = new Uint8Array(0);
      this.size = 0;
      this.touch();
      return true;
    }
    const B = this.B;
    if (len > this.size) {
      if (!this.writable(this.size, this.size)) return false;
      this.extendTo(len);
      this.size = len;
      this.touch();
      return true;
    }
    // Shrinking: the page holding the new end keeps zeros after it, later pages go
    const last = Math.floor(len / B);
    if (len % B && !this.pages.has(last) && last * B < this.zeroFrom) return false;
    for (const i of [...this.pages.keys()]) if (i * B >= len) { this.pages.delete(i); this.dirtyPages.delete(i); }
    if (len % B) {
      const page = this.page(last) ?? this.freshPage(last);
      page.fill(0, len % B);
      this.dirtyPages.add(last);
    }
    this.zeroFrom = Math.min(this.zeroFrom, Math.ceil(len / B) * B);
    this.size = len;
    this.touch();
    return true;
  }

  async truncate(len: number): Promise<void> {
    while (!this.truncateSync(len)) {
      if (this.dirtyPages.size >= DIRTY_PAGES && !this.unlinked) await this.flush(true);
      else await this.loadPages(Math.min(len, this.size), Math.min(len, this.size) + 1, true);
    }
  }

  /** `data` is a mapped shared object's buffer (attachInodeShared): never paged meanwhile. */
  get shared(): boolean { return this.data.buffer instanceof SharedArrayBuffer; }

  /**
   * The file's bytes are in `view` from now (a shared object's buffer, seeded
   * from this inode through pread): a paged file becomes a small one over it.
   * Pages not yet written back are in it, so the inode writes it all back.
   */
  usePagesAsBuffer(view: Uint8Array): void {
    const unwritten = this.dirtyPages.size > 0 || this.dirty;
    this.blob = null;
    this.pages.clear();
    this.dirtyPages.clear();
    this.zeroFrom = Infinity;
    this.data = view;
    if (unwritten) this.markDirty();
  }

  /** A big file no longer shared (its last mapping went): back to pages, all to be written back. */
  pageIfBig(): void {
    if (this.blob || this.shared || this.size < (this.fs.blobMin ?? Infinity)) return;
    this.toPages();
    this.markDirty();
  }

  /** To be written back, with the times it has (no new mtime). */
  markDirty(): void {
    if (!this.dirty) this.dirtySince = Date.now();
    this.dirty = true;
    if (!this.flushTimer) this.armFlush(FLUSH_DELAY_MS);
  }

  // ── Pages ──

  /** Switch a small file to pages (it grew past blobMin): every page is new, to be written. */
  private toPages(): void {
    const B = this.B;
    this.blob = this.fs.newBlobId();
    for (let off = 0; off < this.size; off += B) {
      const page = new Uint8Array(B);
      page.set(this.data.subarray(off, Math.min(off + B, this.size)));
      this.pages.set(off / B, page);
      this.dirtyPages.add(off / B);
    }
    this.zeroFrom = 0;
    this.data = new Uint8Array(0);
  }

  /** A loaded page, now the most recently used. */
  private page(i: number): Uint8Array | undefined {
    const page = this.pages.get(i);
    if (page) { this.pages.delete(i); this.pages.set(i, page); }
    return page;
  }

  /** A page that is zeros in the store: no load needed. */
  private freshPage(i: number): Uint8Array {
    const page = new Uint8Array(this.B);
    this.pages.set(i, page);
    return page;
  }

  /** Whether writing [off, end) needs no load: each page touched partially is loaded or zeros in the store. */
  private writable(off: number, end: number): boolean {
    if (this.dirtyPages.size >= DIRTY_PAGES && !this.unlinked) return false;
    const B = this.B;
    const ok = (p: number) => this.pages.has(Math.floor(p / B)) || Math.floor(p / B) * B >= Math.min(this.zeroFrom, this.size);
    // Pages wholly overwritten need nothing; the partial ones at each end, and
    // the one holding the old end when the write leaves a gap (it gets zeros after the end)
    if (off % B && !ok(off)) return false;
    if (end % B && end > off && !ok(end - 1)) return false;
    if (off > this.size && this.size % B && !ok(this.size)) return false;
    return true;
  }

  /** Growing to `to` (≥ size): the bytes between the old end and it read as zeros. */
  private extendTo(to: number): void {
    if (to <= this.size) return;
    const B = this.B;
    const i = Math.floor(this.size / B);
    if (this.size % B && this.pages.has(i)) {
      this.page(i)!.fill(0, this.size % B, Math.min(B, to - i * B));
      this.dirtyPages.add(i);
    }
    // Pages past the old end that the store may still hold (cut off before)
    this.zeroFrom = Math.min(this.zeroFrom, Math.ceil(this.size / B) * B);
  }

  /** Load the pages holding [from, to) (`partial`: only the first and last, for a write). The caller trims after using them. */
  async loadPages(from: number, to: number, partial = false): Promise<void> {
    const B = this.B;
    const blob = this.blob;
    if (!blob) return;
    const want = new Set<number>();
    if (partial) {
      want.add(Math.floor(from / B));
      if (to > from) want.add(Math.floor((to - 1) / B));
      if (from > this.size) want.add(Math.floor(this.size / B));
    } else {
      for (let i = Math.floor(from / B); i * B < to; i++) want.add(i);
    }
    for (const i of want) {
      if (this.pages.has(i)) continue;
      const page = new Uint8Array(B);
      if (i * B < Math.min(this.zeroFrom, this.size)) {
        const stored = await this.fs.readBlock(blob, i);
        if (this.blob !== blob || this.pages.has(i) || i * B >= this.zeroFrom) continue; // changed meanwhile
        page.set(stored.subarray(0, Math.min(stored.length, B, this.size - i * B)));
      }
      this.pages.set(i, page);
    }
  }

  /** Forget clean pages beyond KEEP_PAGES (least recently used first). */
  private trimPages(): void {
    let clean = this.pages.size - this.dirtyPages.size;
    for (const i of this.pages.keys()) {
      if (clean <= KEEP_PAGES) break;
      if (this.dirtyPages.has(i)) continue;
      this.pages.delete(i);
      clean--;
    }
  }

  private ensure(cap: number) {
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
      // Each write-back copies what it writes: a big small file (apt's 56 MB
      // index before pages) waits longer, or the copies grow quadratically.
      // A paged file writes only the pages written since.
      const mb = (this.blob ? this.dirtyPages.size * this.B : this.size) / (1 << 20);
      const pause = Math.max(FLUSH_DELAY_MS, mb * 20);
      const most = Math.max(FLUSH_MAX_DELAY_MS, mb * 500);
      if (this.dirty && quiet < pause && now - this.dirtySince < most) this.armFlush(pause - quiet);
      else void this.flush(true).catch(() => {});
    }, ms);
  }

  /** A write-back is in progress. */
  get busy(): boolean { return !!this.flushing; }

  /**
   * flush() without waiting, when the FileSystem has the node in memory and
   * no backlog: the data goes into its cache now (stored by the next commit).
   * False when that needs flush().
   */
  flushSync(): boolean {
    if (this.flushing) return false;
    if (!this.dirty || this.unlinked) return true;
    if (this.blob) return false;
    if (this.fs.pendingBytes > WRITE_BACKLOG_BYTES) return false;
    const times = { mtime: this.mtimeMs, mtimeNs: this.mtimeNs, ...(this.atimeMs === null ? {} : { atime: this.atimeMs, atimeNs: this.atimeNs }) };
    if (!this.fs.writeCachedSync(this.path, this.data.slice(0, this.size), times)) return false;
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.dirty = false;
    return true;
  }

  /**
   * Write the data back to the FileSystem. `paced` (the write-back timer, a
   * file still being written) also waits for the IndexedDB commit, so a
   * growing file isn't snapshotted again before the last copy is stored.
   * close, rename and the like don't wait for the commit, as close(2) doesn't
   * wait for the disk (dpkg closed ~1700 files per python3 install, ~4 ms each);
   * fsync does (RegularFile.sync).
   */
  async flush(paced = false): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    while (this.flushing) await this.flushing;
    if (!this.dirty || this.unlinked) return;
    this.dirty = false;
    // With the times this inode reports (the last write's, or utimensat's), not the write-back's
    const times = { mtime: this.mtimeMs, mtimeNs: this.mtimeNs, ...(this.atimeMs === null ? {} : { atime: this.atimeMs, atimeNs: this.atimeNs }) };
    let written: Promise<void>;
    if (this.blob) {
      // The pages written since the last write-back, as copies of their bytes
      // in the file (the pages stay, clean); pages cut off then grown back are zeros
      const B = this.B;
      const blocks: [number, Uint8Array | null][] = [];
      const sent = [...this.dirtyPages].sort((a, b) => a - b);
      for (const i of sent) {
        const page = this.pages.get(i);
        if (page && i * B < this.size) blocks.push([i, page.slice(0, Math.min(B, this.size - i * B))]);
      }
      for (let i = Math.ceil(this.zeroFrom / B); i * B < this.size; i++) if (!this.dirtyPages.has(i)) blocks.push([i, null]);
      const zeroFrom = this.zeroFrom;
      this.dirtyPages.clear();
      this.zeroFrom = Infinity;
      this.trimPages();
      written = this.fs.writeBlocks(this.path, this.blob, this.size, blocks, { times }).catch((e) => {
        // Refused (storage full: ENOSPC): written again by a retry (fsync, close).
        // Pages dropped meanwhile come back from the blocks sent
        this.dirty = true;
        for (const [i, b] of blocks) {
          if (!this.pages.has(i)) { const page = new Uint8Array(B); if (b) page.set(b); this.pages.set(i, page); }
          this.dirtyPages.add(i);
        }
        this.zeroFrom = Math.min(this.zeroFrom, zeroFrom);
        throw e;
      });
    } else {
      const snapshot = this.data.slice(0, this.size);
      // Refused (storage full: ENOSPC): the data stays here for a retry by fsync or close
      written = this.fs.writeFile(this.path, snapshot, { times }).catch((e) => { this.dirty = true; throw e; });
    }
    // Paced: writes made meanwhile go into one later snapshot. Past a backlog of
    // uncommitted data a close waits too, or a fast writer (dpkg unpacking)
    // holds it all in memory (python3's install peaked 150 MiB higher)
    const wait = paced || this.fs.pendingBytes > WRITE_BACKLOG_BYTES;
    this.flushing = (wait ? written.then(() => this.fs.flushed()) : written).finally(() => { this.flushing = null; });
    await this.flushing;
  }
}

const inodeTables = new WeakMap<FileSystem, Map<string, Inode>>();

/**
 * The inode table's key for canonical `path`: the path, or for a file with
 * hard links its inode number, so every name's fds share one Inode.
 */
function inodeKey(fs: FileSystem, path: string): string {
  const link = fs.linkOf?.(path);
  return link === undefined ? path : `i:${link}`;
}

function tableOf(fs: FileSystem): Map<string, Inode> {
  let table = inodeTables.get(fs);
  if (!table) {
    table = new Map();
    inodeTables.set(fs, table);
    // A link() or unlink() changes which names share a file: re-key the open ones
    fs.onLinkChange?.(() => rekeyInodes(fs));
  }
  return table;
}

/** The open inode for canonical `path`, if any. */
function findInode(fs: FileSystem, path: string): Inode | undefined {
  const table = inodeTables.get(fs);
  if (!table) return undefined;
  return table.get(inodeKey(fs, path)) ?? [...table.values()].find((i) => i.path === path && !i.unlinked);
}

let anonymousSeq = 0;

/**
 * open(dir, O_TMPFILE): a file with no name in `dir`, kept for its fds only
 * (never written back) until linkAnonymousInode names it. `linkable`: opened
 * without O_EXCL.
 */
export function anonymousInode(fs: FileSystem, dir: string, mode: number, linkable: boolean): Inode {
  const now = Date.now();
  const ino = new Inode(fs, `${dir === '/' ? '' : dir}/#tmpfile-${++anonymousSeq}`, new Uint8Array(0), mode & 0o7777, now, now);
  ino.unlinked = true;
  ino.tmpfile = linkable;
  ino.opens = 1;
  return ino;
}

/**
 * linkat(fd, "", AT_EMPTY_PATH) (or "/proc/self/fd/N" with AT_SYMLINK_FOLLOW)
 * of an O_TMPFILE fd: the file gets the name `to` (canonical, free) and is
 * that file from now on (its bytes written there, its fds writing back there).
 */
export async function linkAnonymousInode(fs: FileSystem, ino: Inode, to: string): Promise<void> {
  if (!ino.tmpfile || !ino.unlinked) throw Object.assign(new Error('ENOENT: not a linkable O_TMPFILE file'), { code: 'ENOENT' });
  ino.tmpfile = false;
  ino.unlinked = false;
  ino.path = to;
  ino.markDirty();
  try {
    await ino.flush();
    await fs.chmod(to, ino.mode & 0o7777);
  } catch (e) {
    ino.unlinked = true;
    ino.tmpfile = true;
    throw e;
  }
  ino.key = inodeKey(fs, to);
  tableOf(fs).set(ino.key, ino);
}

/** Recompute the keys of open inodes (their files gained or lost names). */
export function rekeyInodes(fs: FileSystem): void {
  const table = inodeTables.get(fs);
  if (!table) return;
  for (const ino of [...table.values()]) {
    const k = inodeKey(fs, ino.path);
    if (k === ino.key) continue;
    if (table.get(ino.key) === ino) table.delete(ino.key);
    ino.key = k;
    if (!table.has(k)) table.set(k, ino);
  }
}

/** An open inode whose last name went: its data stays for its fds (a big file's blocks held), never written back. */
function orphanInode(ino: Inode): void {
  ino.unlinked = true;
  const table = inodeTables.get(ino.fs);
  if (table?.get(ino.key) === ino) table.delete(ino.key);
  if (ino.blob && !ino.heldBlob) { ino.heldBlob = ino.blob; ino.fs.holdBlob?.(ino.blob); }
}

function inodeClosed(ino: Inode): void {
  if (ino.opens !== 0) return;
  const table = inodeTables.get(ino.fs);
  if (table?.get(ino.key) === ino) table.delete(ino.key);
  if (ino.heldBlob) { ino.fs.releaseBlob?.(ino.heldBlob); ino.heldBlob = null; }
}

/**
 * /dev/shm files mapped remote (shmobj.ts): while mapped, the object's
 * SharedArrayBuffer holds the file's bytes, so the inode reads and writes
 * there (pread sees the mapping, the mapping sees pwrite), as a memfd does.
 * Kept by inode key (the path, or the inode of a file with hard links) so
 * an inode opened while it is mapped (shm_open after a close, or through
 * another name) uses the buffer too.
 */
const sharedFiles = new WeakMap<FileSystem, Map<string, Uint8Array>>();

/**
 * The buffer holds the file's bytes (seeded from the fd when the object
 * turned remote): the inode uses it in place of its own array, which it
 * keeps for the detach (it may be the FileSystem node's own content).
 */
function useShared(ino: Inode, view: Uint8Array): void {
  if (view.length < ino.size || ino.data.buffer === view.buffer) return; // (grown past the mapping: stays private)
  // A big file's pages: the buffer holds its bytes; the detach copies them out
  if (ino.blob) { ino.privateData = new Uint8Array(0); ino.usePagesAsBuffer(view); return; }
  ino.privateData = ino.data;
  ino.data = view;
}

/** The shared object for the file at `path` turned remote: its fds use `sab`'s first `length` bytes. */
export function attachInodeShared(fs: FileSystem, path: string, sab: SharedArrayBuffer, length: number, file?: OpenFile): void {
  let m = sharedFiles.get(fs);
  if (!m) { m = new Map(); sharedFiles.set(fs, m); }
  const view = new Uint8Array(sab, 0, length);
  m.set(inodeKey(fs, path), view);
  const ino = findInode(fs, path);
  if (ino) useShared(ino, view);
  // the mapped fd's own inode too: once unlinked (shm_open then shm_unlink,
  // Open POSIX mmap_7-4) it's no longer the path's
  const own = file instanceof RegularFile ? file.inode : undefined;
  if (own && own !== ino) useShared(own, view);
}

/** Its last mapping went: the inode keeps a private copy of the bytes it has now. */
function detachInodeShared(fs: FileSystem, path: string): void {
  sharedFiles.get(fs)?.delete(inodeKey(fs, path));
  const ino = findInode(fs, path);
  if (!ino || !(ino.data.buffer instanceof SharedArrayBuffer)) return;
  const own = ino.privateData;
  ino.privateData = undefined;
  if (own && own.length >= ino.size) { own.set(ino.data.subarray(0, ino.size)); ino.data = own; }
  else ino.data = ino.data.slice(0, ino.size);
  ino.pageIfBig();
}

function newInode(fs: FileSystem, path: string, ino: Inode): Inode {
  const shared = sharedFiles.get(fs)?.get(inodeKey(fs, path));
  if (shared) useShared(ino, shared);
  return ino;
}

/** Open (or share) the inode for `path`; `path` must already be resolved and exist or be created by the caller. */
export async function openInode(fs: FileSystem, path: string): Promise<Inode> {
  const table = tableOf(fs);
  let ino = findInode(fs, path);
  if (!ino) {
    const st = await fs.stat(path);
    // A big file is read a page at a time, not loaded here
    let blob = fs.blobOf?.(path);
    let raw = blob ? new Uint8Array(0) : await fs.readFile(path);
    // A lazy file the read just fetched may be stored as blocks now
    if (!blob && (blob = fs.blobOf?.(path))) raw = new Uint8Array(0);
    const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw;
    ino = findInode(fs, path) ?? newInode(fs, path, new Inode(fs, path, bytes, st.mode, st.mtime.getTime(), st.ctime.getTime(),
      { mtimeNs: st.mtimeNs, atime: st.atimeMs === st.mtime.getTime() && st.atimeNs === st.mtimeNs ? undefined : st.atimeMs, atimeNs: st.atimeNs },
      blob ? { id: blob, size: st.size } : undefined));
    if (!ino.key) { ino.key = inodeKey(fs, path); table.set(ino.key, ino); }
  }
  ino.opens++;
  return ino;
}

/** openInode for a file whose node the FileSystem has in memory (FileSystem.lookupCached). */
export function openInodeSync(fs: FileSystem, path: string, node: {
  content: Uint8Array | null; mode: number; mtime: number; ctime: number; mtimeNs?: number; atime?: number; atimeNs?: number;
  size?: number; blob?: string;
}): Inode {
  const table = tableOf(fs);
  let ino = findInode(fs, path);
  if (!ino) {
    // Like readFile: the cached node's bytes, null meaning empty (a big file's are read a page at a time)
    ino = newInode(fs, path, new Inode(fs, path, node.blob ? new Uint8Array(0) : node.content ?? new Uint8Array(0), node.mode, node.mtime, node.ctime, node,
      node.blob ? { id: node.blob, size: node.size ?? 0 } : undefined));
    ino.key = inodeKey(fs, path);
    table.set(ino.key, ino);
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
  if (ino.busy || (ino.dirty && !ino.unlinked && !ino.flushSync())) return false;
  ino.opens--;
  inodeClosed(ino);
  return true;
}

async function closeInode(ino: Inode): Promise<void> {
  ino.opens--;
  try {
    await ino.flush();
  } finally {
    inodeClosed(ino);
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
  // Two names of one file: rename does nothing
  const fromLink = fs.linkOf?.(from);
  if (fromLink !== undefined && fs.linkOf?.(to) === fromLink) return () => {};
  const moved = [...table.values()].filter(ino => !ino.unlinked && (ino.path === from || ino.path.startsWith(from + '/')));
  for (const ino of moved) await ino.flush();
  const old = findInode(fs, to);
  const oldNames = old ? fs.namesOf?.(to) ?? [to] : [];
  return () => {
    if (old && !moved.includes(old)) {
      // The name `to` goes from the file open there: its other names keep it
      const others = oldNames.filter((n) => n !== to);
      if (!others.length) orphanInode(old);
      else if (old.path === to) old.path = others[0];
    }
    for (const ino of moved) ino.path = to + ino.path.slice(from.length);
    rekeyInodes(fs);
  };
}

/**
 * Call before FileSystem.exchange(a, b): writes back what open files under
 * either hold, and afterwards (the returned function) swaps their paths.
 */
export async function exchangeInodes(fs: FileSystem, a: string, b: string): Promise<() => void> {
  const table = inodeTables.get(fs);
  if (!table) return () => {};
  const under = (p: string) => [...table.values()].filter((ino) => !ino.unlinked && (ino.path === p || ino.path.startsWith(p + '/')));
  const ia = under(a), ib = under(b);
  for (const ino of [...ia, ...ib]) await ino.flush();
  return () => {
    for (const ino of ia) ino.path = b + ino.path.slice(a.length);
    for (const ino of ib) ino.path = a + ino.path.slice(b.length);
    rekeyInodes(fs);
  };
}

/**
 * Call before unlinking `path`: open descriptions keep its data but never
 * write it back (this waits out a write-back already under way). A file
 * with other names stays theirs.
 */
export async function unlinkInode(fs: FileSystem, path: string): Promise<void> {
  const ino = findInode(fs, path);
  if (!ino) return;
  const others = (fs.namesOf?.(path) ?? [path]).filter((n) => n !== path);
  if (others.length) {
    if (ino.path === path) { await ino.flush(); ino.path = others[0]; }
    return;
  }
  orphanInode(ino);
  await ino.flush();
}

/** Whether `path` (resolved) is open: unlink must then hand its data to the open fds. */
export function isInodeOpen(fs: FileSystem, path: string): boolean {
  return !!findInode(fs, path);
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
  const ino = findInode(fs, path);
  return ino && (ino.dirty || ino.busy) ? inodeKStat(ino) : undefined;
}

function inodeKStat(ino: Inode): KStat {
  return {
    dev: 1, ino: inodeNumber(ino.fs, ino.path), mode: S_IFREG | (ino.mode & 0o7777), nlink: ino.unlinked ? 0 : linkCount(ino.fs, ino.path), uid: 1000, gid: 1000, rdev: 0,
    size: ino.size, blksize: 4096, blocks: Math.ceil(ino.size / 512),
    atimeMs: ino.atimeMs ?? ino.mtimeMs, mtimeMs: ino.mtimeMs, ctimeMs: ino.ctimeMs,
    atimeNs: ino.atimeMs === null ? ino.mtimeNs : ino.atimeNs, mtimeNs: ino.mtimeNs,
  };
}

/** Write back what an open inode for `path` holds (before reading the path's times from the FileSystem). */
export async function flushInode(fs: FileSystem, path: string): Promise<void> {
  await findInode(fs, path)?.flush();
}

/**
 * A shared object's final bytes (shmobj.ts) go to `path`: into its open
 * inode, if any, which fds read and which writes them back (writing the
 * FileSystem behind it would be overwritten by its next write-back); only
 * the bytes within the file's size. False when no inode is open.
 */
export async function writeInodeBytes(fs: FileSystem, path: string, bytes: Uint8Array): Promise<boolean> {
  detachInodeShared(fs, path);
  const ino = findInode(fs, path);
  if (!ino || ino.unlinked) return false;
  const n = Math.min(bytes.length, ino.size);
  // A big file not switched to the buffer (it had grown past the mapping) is pages
  if (ino.blob) { await ino.writeAt(bytes.subarray(0, n), 0); return true; }
  ino.data.set(bytes.subarray(0, n));
  ino.touch();
  return true;
}

/** chmod of `path`: an open inode reports (inodeStat) the new mode. */
export function setInodeMode(fs: FileSystem, path: string, mode: number): void {
  const ino = findInode(fs, path);
  if (ino) ino.mode = (ino.mode & ~0o7777) | (mode & 0o7777);
}

/**
 * utimensat on `path`: an open inode writes back what it holds first (so a
 * later write-back doesn't stamp the current time over the new times) and
 * then reports the new times. Call before FileSystem.utimes.
 */
export async function setInodeTimes(fs: FileSystem, path: string, t: { atimeMs: number; atimeNs: number; mtimeMs: number; mtimeNs: number }): Promise<void> {
  const ino = findInode(fs, path);
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
 * st_nlink of a regular file: how many names it has (FileSystem.link;
 * shadow's lock, link(group.PID, group.lock), checks that the count went to 2).
 */
export function linkCount(fs: FileSystem | null | undefined, path: string): number {
  return fs?.nlinkOf?.(path) ?? 1;
}

export class RegularFile implements OpenFile {
  kind: OpenFileKind = 'file';
  private pos = 0;
  private listeners = new ReadyListeners();
  private closed = false;

  constructor(private ino: Inode, public flags: number) {}

  get path(): string { return this.ino.path; }
  /** (attachInodeShared) */
  get inode(): Inode { return this.ino; }

  async read(buf: Uint8Array): Promise<number> {
    if (!canRead(this.flags)) return -EBADF;
    const n = await this.ino.readAt(buf, this.pos);
    this.pos += n;
    return n;
  }

  /** undefined: a page of a big file must load first (read). */
  tryRead(buf: Uint8Array): number | undefined {
    if (!canRead(this.flags)) return -EBADF;
    const n = this.ino.readSync(buf, this.pos);
    if (n !== undefined) this.pos += n;
    return n;
  }

  async write(buf: Uint8Array): Promise<number> {
    if (!canWrite(this.flags)) return -EBADF;
    const ino = this.ino;
    const at = this.flags & O_APPEND ? ino.size : this.pos;
    if (!ino.writeSync(buf, at)) await ino.writeAt(buf, at);
    this.pos = at;
    return this.wrote(buf.length);
  }

  /** undefined: a big file must load a page or store written ones first (write). */
  tryWrite(buf: Uint8Array): number | undefined {
    if (!canWrite(this.flags)) return -EBADF;
    const ino = this.ino;
    const pos = this.flags & O_APPEND ? ino.size : this.pos;
    if (!ino.writeSync(buf, pos)) return undefined;
    this.pos = pos;
    return this.wrote(buf.length);
  }

  private wrote(n: number): number {
    this.pos += n;
    // O_SYNC/O_DSYNC: start the write-back now rather than after the usual delay
    if (this.flags & O_DSYNC) void this.ino.flush().catch(() => {});
    return n;
  }

  async pread(buf: Uint8Array, off: number): Promise<number> {
    if (!canRead(this.flags)) return -EBADF;
    if (off < 0) return -EINVAL;
    return this.ino.readAt(buf, off);
  }

  async pwrite(buf: Uint8Array, off: number): Promise<number> {
    if (!canWrite(this.flags)) return -EBADF;
    if (off < 0) return -EINVAL;
    // Linux: pwrite on O_APPEND appends
    const at = this.flags & O_APPEND ? this.ino.size : off;
    if (!this.ino.writeSync(buf, at)) await this.ino.writeAt(buf, at);
    if (this.flags & O_DSYNC) void this.ino.flush().catch(() => {});
    return buf.length;
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

  async truncate(len: number): Promise<number> {
    if (!canWrite(this.flags)) return -EINVAL;
    if (len < 0) return -EINVAL;
    await this.ino.truncate(len);
    return 0;
  }

  /** undefined: a page of a big file must load first (truncate). Truncating to 0 never needs one. */
  truncateSync(len: number): number | undefined {
    if (!canWrite(this.flags)) return -EINVAL;
    if (len < 0) return -EINVAL;
    return this.ino.truncateSync(len) ? 0 : undefined;
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

/**
 * open(symlink, O_PATH|O_NOFOLLOW): a descriptor naming the symlink itself.
 * fstat (and fstatat AT_EMPTY_PATH) is the link's lstat, readlinkat(fd, "")
 * its target, linkat(fd, "", AT_EMPTY_PATH) gives it another name; no I/O.
 */
export class SymlinkPathFile implements OpenFile {
  kind: OpenFileKind = 'file';
  flags = O_PATH;
  constructor(public path: string, private lstat: () => Promise<KStat | number>) {}
  async read(): Promise<number> { return -EBADF; }
  async write(): Promise<number> { return -EBADF; }
  poll(): number { return 0; }
  onReady(): () => void { return () => {}; }
  async stat(): Promise<KStat> {
    const st = await this.lstat();
    if (typeof st === 'number') throw Object.assign(new Error('stat'), { errno: -st });
    return st;
  }
  async close(): Promise<void> {}
  closeSync(): boolean { return true; }
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
