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
  O_ACCMODE, O_RDONLY, O_WRONLY, O_APPEND, O_NONBLOCK, OPEN_MAX,
  POLLIN, POLLOUT, SEEK_SET, SEEK_CUR, SEEK_END,
  S_IFCHR, S_IFREG, S_IFDIR, S_IFIFO, FIONREAD,
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
  if (n > 0) { refs.set(file, n); return; }
  refs.delete(file);
  await file.close();
}

export function refCount(file: OpenFile): number {
  return refs.get(file) ?? 0;
}

// ── FdTable ─────────────────────────────────────────────────────────────────

interface FdEntry { file: OpenFile; cloexec: boolean }

export class FdTable {
  private fds = new Map<number, FdEntry>();

  get(fd: number): OpenFile | undefined {
    return this.fds.get(fd)?.file;
  }

  has(fd: number): boolean {
    return this.fds.has(fd);
  }

  /** Lowest free fd ≥ minFd, or -EMFILE. Takes a reference to `file`. */
  alloc(file: OpenFile, minFd = 0, cloexec = false): number {
    for (let fd = minFd; fd < OPEN_MAX; fd++) {
      if (!this.fds.has(fd)) {
        this.fds.set(fd, { file: retain(file), cloexec });
        return fd;
      }
    }
    return -EMFILE;
  }

  /** Install `file` at exactly `fd`, closing what was there. */
  async set(fd: number, file: OpenFile, cloexec = false): Promise<number> {
    if (fd < 0 || fd >= OPEN_MAX) return -EBADF;
    retain(file);
    const old = this.fds.get(fd);
    this.fds.set(fd, { file, cloexec });
    if (old) await release(old.file);
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
    if (newFd < 0 || newFd >= OPEN_MAX) return -EBADF;
    if (oldFd === newFd) return newFd;
    return this.set(newFd, e.file, cloexec);
  }

  async close(fd: number): Promise<number> {
    const e = this.fds.get(fd);
    if (!e) return -EBADF;
    this.fds.delete(fd);
    await release(e.file);
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
  private cbs = new Set<() => void>();
  add(cb: () => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  fire(): void {
    for (const cb of [...this.cbs]) {
      try { cb(); } catch { /* listener errors must not break I/O */ }
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
  async close(): Promise<void> {}
}

/** /dev/null: reads EOF, swallows writes. */
export class DevNull extends DevFile {
  constructor(flags = 2) { super(flags, '/dev/null', 0x103); }
  async read(): Promise<number> { return 0; }
  async write(buf: Uint8Array): Promise<number> { return buf.length; }
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
 * FileSystem shortly after each write and when the last description closes.
 * Writes made through the FileSystem API directly while a file is open are
 * not seen until every kernel description of it has closed.
 */
class Inode {
  data: Uint8Array;
  size: number;
  opens = 0;
  dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;

  constructor(public fs: FileSystem, public path: string, initial: Uint8Array, public mode: number, public mtimeMs: number, public ctimeMs: number) {
    this.data = initial;
    this.size = initial.length;
  }

  ensure(cap: number) {
    if (cap <= this.data.length) return;
    const next = new Uint8Array(Math.max(cap, this.data.length * 2, 256));
    next.set(this.data.subarray(0, this.size));
    this.data = next;
  }

  touch() {
    this.dirty = true;
    this.mtimeMs = Date.now();
    if (!this.flushTimer) this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flush(); }, 0);
  }

  async flush(): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    while (this.flushing) await this.flushing;
    if (!this.dirty) return;
    this.dirty = false;
    const snapshot = this.data.slice(0, this.size);
    this.flushing = this.fs.writeFile(this.path, snapshot).finally(() => { this.flushing = null; });
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
    ino = table.get(path) ?? new Inode(fs, path, bytes, st.mode, st.mtime.getTime(), st.ctime.getTime());
    table.set(path, ino);
  }
  ino.opens++;
  return ino;
}

async function closeInode(ino: Inode): Promise<void> {
  ino.opens--;
  await ino.flush();
  if (ino.opens === 0) inodeTables.get(ino.fs)?.delete(ino.path);
}

/** Stable small inode numbers for paths (the FileSystem has none). */
const inoNumbers = new Map<string, number>();
export function inodeNumber(path: string): number {
  let n = inoNumbers.get(path);
  if (!n) { n = inoNumbers.size + 2; inoNumbers.set(path, n); }
  return n;
}

export class RegularFile implements OpenFile {
  kind: OpenFileKind = 'file';
  private pos = 0;
  private listeners = new ReadyListeners();
  private closed = false;

  constructor(private ino: Inode, public flags: number) {}

  get path(): string { return this.ino.path; }

  async read(buf: Uint8Array): Promise<number> {
    if (!canRead(this.flags)) return -EBADF;
    const n = Math.max(0, Math.min(buf.length, this.ino.size - this.pos));
    if (n > 0) buf.set(this.ino.data.subarray(this.pos, this.pos + n));
    this.pos += n;
    return n;
  }

  async write(buf: Uint8Array): Promise<number> {
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
      return await this.write(buf);
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

  async truncate(len: number): Promise<number> {
    if (!canWrite(this.flags)) return -EINVAL;
    if (len < 0) return -EINVAL;
    const ino = this.ino;
    ino.ensure(len);
    if (len > ino.size) ino.data.fill(0, ino.size, len);
    ino.size = len;
    ino.touch();
    return 0;
  }

  async sync(): Promise<void> { await this.ino.flush(); }

  poll(events: number): number { return events & (POLLIN | POLLOUT); }
  onReady(cb: () => void): () => void { return this.listeners.add(cb); }

  async ioctl(req: number, arg: Uint8Array): Promise<number> {
    if (req === FIONREAD && arg.length >= 4) {
      new DataView(arg.buffer, arg.byteOffset, 4).setInt32(0, Math.max(0, this.ino.size - this.pos), true);
      return 0;
    }
    return -ENOTTY;
  }

  async stat(): Promise<KStat> {
    const ino = this.ino;
    return {
      dev: 1, ino: inodeNumber(ino.path), mode: S_IFREG | (ino.mode & 0o7777), nlink: 1, uid: 1000, gid: 1000, rdev: 0,
      size: ino.size, blksize: 4096, blocks: Math.ceil(ino.size / 512),
      atimeMs: ino.mtimeMs, mtimeMs: ino.mtimeMs, ctimeMs: ino.ctimeMs,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await closeInode(this.ino);
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
      dev: 1, ino: inodeNumber(this.path), mode: S_IFDIR | (st.mode & 0o7777), nlink: 2, uid: 1000, gid: 1000, rdev: 0,
      size: 4096, blksize: 4096, blocks: 8,
      atimeMs: st.mtime.getTime(), mtimeMs: st.mtime.getTime(), ctimeMs: st.ctime.getTime(),
    };
  }
  async close(): Promise<void> {}
}
