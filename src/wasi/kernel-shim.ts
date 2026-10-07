/**
 * kernel-shim.ts — the slice of the Shiro kernel that WASM processes need.
 *
 * TEMPORARY SHIM. docs/KERNEL_ABI.md assigns these types to src/kernel/*
 * (unix/kernel branch: fd.ts, pipe.ts, process.ts, kernel.ts). That branch
 * had not landed when this was written, so this file implements the same
 * names against the spec, kept in one place so that switching over is a
 * matter of replacing the imports in ./kernel.ts.
 *
 * What is here: OpenFile kinds (Shiro FS files and directories, pipes, a
 * terminal tty with a cooked line discipline, string sources, callback
 * sinks, /dev/null|zero|urandom), FdTable with shared open-file refcounts,
 * Process, and Kernel (spawn with binfmt loaders, waitpid, kill, runBuiltin).
 */

import type { FileSystem } from '../filesystem';
import type { Shell } from '../shell';
import {
  EBADF, EEXIST, EINVAL, EIO, EISDIR, ENOENT, ENOTDIR, ENOTEMPTY, EPIPE, ESPIPE,
  EAGAIN, ECHILD, ESRCH, EACCES, ENOTSUP, EXDEV,
  FT_CHAR, FT_DIR, FT_REG, FT_SYMLINK, FT_UNKNOWN, KStat,
  O_ACCMODE, O_APPEND, O_NONBLOCK, O_RDONLY, O_WRONLY, O_RDWR,
  POLLERR, POLLHUP, POLLIN, POLLOUT, SEEK_CUR, SEEK_END, SEEK_SET,
  SIGINT, SIGKILL, SIGPIPE, WNOHANG, exitStatus, signalStatus,
} from './abi';

// ── OpenFile ─────────────────────────────────────────────────────────

export interface DirEntry { name: string; filetype: number }

export interface OpenFile {
  kind: 'file' | 'dir' | 'pipe' | 'pty' | 'socket' | 'dev';
  flags: number;
  read(buf: Uint8Array): Promise<number>;
  write(buf: Uint8Array): Promise<number>;
  poll(events: number): number;
  onReady(cb: () => void): () => void;
  ioctl?(req: number, arg: Uint8Array): Promise<number>;
  seek?(off: number, whence: number): number;
  stat(): Promise<KStat>;
  close(): Promise<void>;
  // Shim extensions (expected to exist on the real kernel's file/dir objects too)
  /** Absolute path for files and directories. */
  path?: string;
  /** True when this is a terminal (isatty). */
  isTTY?: boolean;
  pread?(buf: Uint8Array, off: number): Promise<number>;
  pwrite?(buf: Uint8Array, off: number): Promise<number>;
  truncate?(len: number): Promise<number>;
  sync?(): Promise<void>;
  readdir?(): Promise<DirEntry[] | number>;
}

let inoCounter = 1000;
const nextIno = () => ++inoCounter;

function fsErrno(e: any): number {
  const code = e?.code || (typeof e?.message === 'string' ? e.message.split(':')[0] : '');
  switch (code) {
    case 'ENOENT': return -ENOENT;
    case 'EEXIST': return -EEXIST;
    case 'EISDIR': return -EISDIR;
    case 'ENOTDIR': return -ENOTDIR;
    case 'ENOTEMPTY': return -ENOTEMPTY;
    case 'EINVAL': return -EINVAL;
    case 'EACCES': return -EACCES;
    case 'EXDEV': return -EXDEV;
    default: return -EIO;
  }
}
export { fsErrno };

/** Readiness listeners shared by the stream-like files. */
class Waiters {
  private cbs = new Set<() => void>();
  add(cb: () => void): () => void { this.cbs.add(cb); return () => this.cbs.delete(cb); }
  wake(): void { for (const cb of Array.from(this.cbs)) { try { cb(); } catch { /* listener errors are its own */ } } }
  /** Promise that resolves on the next wake. */
  next(): Promise<void> { return new Promise(r => { const off = this.add(() => { off(); r(); }); }); }
}

// ── Inodes: one shared buffer per open path, flushed to the Shiro FS ──

export class Inode {
  data: Uint8Array | null = null;
  size = 0;
  dirty = false;
  unlinked = false;
  refs = 0;
  ino = nextIno();
  private loading: Promise<void> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private registry: InodeTable, public path: string) {}

  async load(): Promise<void> {
    if (this.data) return;
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const d = await this.registry.fs.readFile(this.path);
          const bytes = typeof d === 'string' ? new TextEncoder().encode(d) : d;
          if (!this.data) { this.data = new Uint8Array(bytes); this.size = this.data.length; }
        } catch {
          if (!this.data) { this.data = new Uint8Array(0); this.size = 0; }
        }
      })();
    }
    await this.loading;
  }

  ensureCapacity(n: number): void {
    if (!this.data) this.data = new Uint8Array(0);
    if (n <= this.data.length) return;
    const grown = new Uint8Array(Math.max(n, this.data.length * 2, 4096));
    grown.set(this.data.subarray(0, this.size));
    this.data = grown;
  }

  markDirty(): void {
    this.dirty = true;
    if (!this.flushTimer) this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flush(); }, 50);
  }

  async flush(): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (!this.dirty || this.unlinked || !this.data) return;
    this.dirty = false;
    await this.registry.fs.writeFile(this.path, this.data.slice(0, this.size));
  }
}

export class InodeTable {
  private map = new Map<string, Inode>();
  constructor(readonly fs: FileSystem) {}

  get(path: string): Inode {
    let ino = this.map.get(path);
    if (!ino) { ino = new Inode(this, path); this.map.set(path, ino); }
    return ino;
  }
  peek(path: string): Inode | undefined { return this.map.get(path); }
  release(ino: Inode): void {
    if (ino.refs <= 0 && !ino.dirty && this.map.get(ino.path) === ino) this.map.delete(ino.path);
  }
  /** Forget a path (unlink/rename): open descriptions keep their data but stop writing back. */
  detach(path: string): void {
    const ino = this.map.get(path);
    if (ino) { ino.unlinked = true; this.map.delete(path); }
  }
  async rename(from: string, to: string): Promise<void> {
    const ino = this.map.get(from);
    if (ino) await ino.flush();
    this.detach(to);
    if (ino) { this.map.delete(from); ino.path = to; this.map.set(to, ino); }
  }
  async flushAll(): Promise<void> {
    await Promise.all(Array.from(this.map.values()).map(i => i.flush()));
  }
}

async function statPath(fs: FileSystem, path: string, follow = true): Promise<KStat | number> {
  try {
    const st = follow ? await fs.stat(path) : await fs.lstat(path);
    const filetype = st.type === 'dir' ? FT_DIR : st.type === 'symlink' ? FT_SYMLINK : FT_REG;
    return {
      dev: 1, ino: hashIno(path), filetype, nlink: 1, size: st.size,
      atimeMs: st.mtime.getTime(), mtimeMs: st.mtime.getTime(), ctimeMs: st.ctime.getTime(), mode: st.mode,
    };
  } catch (e) {
    return fsErrno(e);
  }
}
export { statPath };

function hashIno(path: string): number {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) { h ^= path.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export class FsFile implements OpenFile {
  kind = 'file' as const;
  pos = 0;
  private waiters = new Waiters();

  constructor(private inodes: InodeTable, readonly inode: Inode, public flags: number) {
    inode.refs++;
  }
  get path(): string { return this.inode.path; }
  private get readable() { return (this.flags & O_ACCMODE) !== O_WRONLY; }
  private get writable() { return (this.flags & O_ACCMODE) !== O_RDONLY; }

  async read(buf: Uint8Array): Promise<number> {
    const n = await this.pread(buf, this.pos);
    if (n > 0) this.pos += n;
    return n;
  }
  async pread(buf: Uint8Array, off: number): Promise<number> {
    if (!this.readable) return -EBADF;
    await this.inode.load();
    const { data, size } = this.inode;
    if (!data || off >= size) return 0;
    const n = Math.min(buf.length, size - off);
    buf.set(data.subarray(off, off + n));
    return n;
  }
  async write(buf: Uint8Array): Promise<number> {
    if (this.flags & O_APPEND) { await this.inode.load(); this.pos = this.inode.size; }
    const n = await this.pwrite(buf, this.pos);
    if (n > 0) this.pos += n;
    return n;
  }
  async pwrite(buf: Uint8Array, off: number): Promise<number> {
    if (!this.writable) return -EBADF;
    await this.inode.load();
    const ino = this.inode;
    ino.ensureCapacity(off + buf.length);
    ino.data!.set(buf, off);
    if (off > ino.size) ino.data!.fill(0, ino.size, off);
    ino.size = Math.max(ino.size, off + buf.length);
    ino.markDirty();
    return buf.length;
  }
  async truncate(len: number): Promise<number> {
    if (!this.writable) return -EINVAL;
    await this.inode.load();
    const ino = this.inode;
    ino.ensureCapacity(len);
    if (len > ino.size) ino.data!.fill(0, ino.size, len);
    ino.size = len;
    ino.markDirty();
    return 0;
  }
  seek(off: number, whence: number): number {
    let base: number;
    if (whence === SEEK_SET) base = 0;
    else if (whence === SEEK_CUR) base = this.pos;
    else if (whence === SEEK_END) base = this.inode.data ? this.inode.size : -1;
    else return -EINVAL;
    if (base < 0) return -EIO; // SEEK_END before load: callers load first (see syscalls.ts)
    const p = base + off;
    if (p < 0) return -EINVAL;
    this.pos = p;
    return p;
  }
  poll(events: number): number { return events & (POLLIN | POLLOUT); }
  onReady(cb: () => void) { return this.waiters.add(cb); }
  async stat(): Promise<KStat> {
    const st = await statPath(this.inodes.fs, this.inode.path);
    const base: KStat = typeof st === 'number'
      ? { dev: 1, ino: this.inode.ino, filetype: FT_REG, nlink: 0, size: 0, atimeMs: 0, mtimeMs: 0, ctimeMs: 0 }
      : st;
    if (this.inode.data) base.size = this.inode.size;
    return base;
  }
  async sync(): Promise<void> { await this.inode.flush(); }
  async close(): Promise<void> {
    this.inode.refs--;
    await this.inode.flush();
    this.inodes.release(this.inode);
  }
}

export class FsDir implements OpenFile {
  kind = 'dir' as const;
  private waiters = new Waiters();
  constructor(private fs: FileSystem, readonly path: string, public flags: number) {}
  async read(): Promise<number> { return -EISDIR; }
  async write(): Promise<number> { return -EISDIR; }
  poll(events: number): number { return events & (POLLIN | POLLOUT); }
  onReady(cb: () => void) { return this.waiters.add(cb); }
  async stat(): Promise<KStat> {
    const st = await statPath(this.fs, this.path);
    return typeof st === 'number'
      ? { dev: 1, ino: hashIno(this.path), filetype: FT_DIR, nlink: 1, size: 0, atimeMs: 0, mtimeMs: 0, ctimeMs: 0 }
      : st;
  }
  async readdir(): Promise<DirEntry[] | number> {
    try {
      const names = await this.fs.readdir(this.path);
      const out: DirEntry[] = [];
      for (const name of names) {
        const p = this.path === '/' ? '/' + name : this.path + '/' + name;
        const st = await statPath(this.fs, p, false);
        out.push({ name, filetype: typeof st === 'number' ? FT_UNKNOWN : st.filetype });
      }
      return out;
    } catch (e) {
      return fsErrno(e);
    }
  }
  async close(): Promise<void> {}
}

// ── Pipes ────────────────────────────────────────────────────────────

export const PIPE_CAPACITY = 64 * 1024;

export class Pipe {
  private chunks: Uint8Array[] = [];
  size = 0;
  readers = 0;
  writers = 0;
  readonly waiters = new Waiters();

  ends(): [PipeEnd, PipeEnd] {
    return [new PipeEnd(this, 'r', O_RDONLY), new PipeEnd(this, 'w', O_WRONLY)];
  }

  take(buf: Uint8Array): number {
    let n = 0;
    while (n < buf.length && this.chunks.length) {
      const head = this.chunks[0];
      const k = Math.min(head.length, buf.length - n);
      buf.set(head.subarray(0, k), n);
      n += k;
      if (k === head.length) this.chunks.shift(); else this.chunks[0] = head.subarray(k);
    }
    this.size -= n;
    if (n) this.waiters.wake();
    return n;
  }

  put(bytes: Uint8Array): void {
    if (!bytes.length) return;
    this.chunks.push(bytes.slice());
    this.size += bytes.length;
    this.waiters.wake();
  }
}

export class PipeEnd implements OpenFile {
  kind = 'pipe' as const;
  private closed = false;
  constructor(readonly pipe: Pipe, readonly side: 'r' | 'w', public flags: number) {
    if (side === 'r') pipe.readers++; else pipe.writers++;
  }
  async read(buf: Uint8Array): Promise<number> {
    if (this.side !== 'r') return -EBADF;
    const p = this.pipe;
    for (;;) {
      if (p.size > 0) return p.take(buf);
      if (p.writers === 0 || buf.length === 0) return 0;
      if (this.flags & O_NONBLOCK) return -EAGAIN;
      await p.waiters.next();
    }
  }
  async write(buf: Uint8Array): Promise<number> {
    if (this.side !== 'w') return -EBADF;
    const p = this.pipe;
    let done = 0;
    while (done < buf.length) {
      if (p.readers === 0) return done || -EPIPE;
      const room = PIPE_CAPACITY - p.size;
      if (room <= 0) {
        if (this.flags & O_NONBLOCK) return done || -EAGAIN;
        await p.waiters.next();
        continue;
      }
      const k = Math.min(room, buf.length - done);
      p.put(buf.subarray(done, done + k));
      done += k;
    }
    return done;
  }
  poll(events: number): number {
    const p = this.pipe;
    let r = 0;
    if (this.side === 'r') {
      if ((events & POLLIN) && p.size > 0) r |= POLLIN;
      if (p.writers === 0) r |= POLLHUP | (events & POLLIN);
    } else {
      if (p.readers === 0) r |= POLLERR;
      else if ((events & POLLOUT) && p.size < PIPE_CAPACITY) r |= POLLOUT;
    }
    return r;
  }
  onReady(cb: () => void) { return this.pipe.waiters.add(cb); }
  seek(): number { return -ESPIPE; }
  async stat(): Promise<KStat> {
    return { dev: 2, ino: 0, filetype: FT_UNKNOWN, nlink: 1, size: 0, atimeMs: 0, mtimeMs: 0, ctimeMs: 0 };
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.side === 'r') this.pipe.readers--; else this.pipe.writers--;
    this.pipe.waiters.wake();
  }
}

// ── Terminal tty (cooked line discipline over Shiro's xterm) ─────────

export interface TtyHost {
  /** Bytes for the screen (already post-processed: \n → \r\n in cooked mode). */
  output(text: string): void;
  /** Ctrl-C / Ctrl-\ from the keyboard. */
  signal(sig: number): void;
  size?(): { rows: number; cols: number };
}

/**
 * A terminal as an OpenFile. Cooked by default (echo, backspace, ^U, ^D EOF,
 * ^C → SIGINT); `raw = true` passes keystrokes through. Stands in for the
 * unix/pty line discipline until that lands.
 */
export class TtyFile implements OpenFile {
  kind = 'dev' as const;
  isTTY = true;
  flags = O_RDWR;
  raw = false;
  private queue: Uint8Array[] = [];
  private queued = 0;
  private eofPending = false;
  private line = '';
  private escape = false;
  private waiters = new Waiters();
  private enc = new TextEncoder();
  private dec = new TextDecoder();

  constructor(private host: TtyHost) {}

  /** Feed keyboard data. */
  input(data: string): void {
    if (this.raw) { this.push(this.enc.encode(data)); return; }
    for (const ch of data) {
      if (this.escape) {
        if ((ch >= '@' && ch <= '~' && ch !== '[' && ch !== 'O')) this.escape = false;
        continue;
      }
      switch (ch) {
        case '\x1b': this.escape = true; break;
        case '\r': case '\n':
          this.host.output('\r\n');
          this.push(this.enc.encode(this.line + '\n'));
          this.line = '';
          break;
        case '\x7f': case '\b':
          if (this.line) { this.line = Array.from(this.line).slice(0, -1).join(''); this.host.output('\b \b'); }
          break;
        case '\x15':
          this.host.output('\b \b'.repeat(Array.from(this.line).length));
          this.line = '';
          break;
        case '\x04':
          if (this.line) { this.push(this.enc.encode(this.line)); this.line = ''; }
          else { this.eofPending = true; this.waiters.wake(); }
          break;
        case '\x03':
          this.host.output('^C\r\n');
          this.line = '';
          this.host.signal(SIGINT);
          return;
        default:
          if (ch >= ' ' || ch === '\t') { this.line += ch; this.host.output(ch); }
      }
    }
  }

  /** End of input for good (the terminal went away). */
  hangup(): void { this.eofPending = true; this.hung = true; this.waiters.wake(); }
  private hung = false;

  private push(bytes: Uint8Array): void {
    if (!bytes.length) return;
    this.queue.push(bytes);
    this.queued += bytes.length;
    this.waiters.wake();
  }

  async read(buf: Uint8Array): Promise<number> {
    for (;;) {
      if (this.queued > 0) {
        let n = 0;
        while (n < buf.length && this.queue.length) {
          const head = this.queue[0];
          const k = Math.min(head.length, buf.length - n);
          buf.set(head.subarray(0, k), n);
          n += k;
          if (k === head.length) this.queue.shift(); else this.queue[0] = head.subarray(k);
        }
        this.queued -= n;
        return n;
      }
      if (this.eofPending) { if (!this.hung) this.eofPending = false; return 0; }
      if (this.flags & O_NONBLOCK) return -EAGAIN;
      await this.waiters.next();
    }
  }
  async write(buf: Uint8Array): Promise<number> {
    const text = this.dec.decode(buf, { stream: true });
    this.host.output(this.raw ? text : text.replace(/\r?\n/g, '\r\n'));
    return buf.length;
  }
  poll(events: number): number {
    let r = events & POLLOUT;
    if ((events & POLLIN) && (this.queued > 0 || this.eofPending)) r |= POLLIN;
    return r;
  }
  onReady(cb: () => void) { return this.waiters.add(cb); }
  seek(): number { return -ESPIPE; }
  async stat(): Promise<KStat> {
    return { dev: 3, ino: 0, filetype: FT_CHAR, nlink: 1, size: 0, atimeMs: 0, mtimeMs: 0, ctimeMs: 0 };
  }
  async close(): Promise<void> {}
}

// ── Simple sources and sinks ─────────────────────────────────────────

/** Fixed input, then EOF (a command's collected stdin string). */
export class BufferSource implements OpenFile {
  kind = 'pipe' as const;
  flags = O_RDONLY;
  private off = 0;
  private waiters = new Waiters();
  constructor(private data: Uint8Array) {}
  async read(buf: Uint8Array): Promise<number> {
    const n = Math.min(buf.length, this.data.length - this.off);
    buf.set(this.data.subarray(this.off, this.off + n));
    this.off += n;
    return n;
  }
  async write(): Promise<number> { return -EBADF; }
  poll(events: number): number { return events & POLLIN; }
  onReady(cb: () => void) { return this.waiters.add(cb); }
  seek(): number { return -ESPIPE; }
  async stat(): Promise<KStat> {
    return { dev: 2, ino: 0, filetype: FT_UNKNOWN, nlink: 1, size: 0, atimeMs: 0, mtimeMs: 0, ctimeMs: 0 };
  }
  async close(): Promise<void> {}
}

/** Output delivered to a callback (ctx.stdout, the terminal, a test). */
export class CallbackSink implements OpenFile {
  kind: 'pipe' | 'dev';
  flags = O_WRONLY;
  isTTY: boolean;
  private waiters = new Waiters();
  private dec = new TextDecoder();
  constructor(private cb: (text: string, bytes: Uint8Array) => void, opts: { tty?: boolean } = {}) {
    this.isTTY = !!opts.tty;
    this.kind = this.isTTY ? 'dev' : 'pipe';
  }
  async read(): Promise<number> { return -EBADF; }
  async write(buf: Uint8Array): Promise<number> {
    this.cb(this.dec.decode(buf, { stream: true }), buf);
    return buf.length;
  }
  poll(events: number): number { return events & POLLOUT; }
  onReady(cb: () => void) { return this.waiters.add(cb); }
  seek(): number { return -ESPIPE; }
  async stat(): Promise<KStat> {
    return { dev: 2, ino: 0, filetype: this.isTTY ? FT_CHAR : FT_UNKNOWN, nlink: 1, size: 0, atimeMs: 0, mtimeMs: 0, ctimeMs: 0 };
  }
  async close(): Promise<void> {}
}

export class DevFile implements OpenFile {
  kind = 'dev' as const;
  private waiters = new Waiters();
  constructor(readonly path: string, readonly which: 'null' | 'zero' | 'urandom', public flags: number) {}
  async read(buf: Uint8Array): Promise<number> {
    if (this.which === 'null') return 0;
    if (this.which === 'zero') { buf.fill(0); return buf.length; }
    for (let i = 0; i < buf.length; i += 65536) crypto.getRandomValues(buf.subarray(i, Math.min(buf.length, i + 65536)));
    return buf.length;
  }
  async write(buf: Uint8Array): Promise<number> { return buf.length; }
  poll(events: number): number { return events & (POLLIN | POLLOUT); }
  onReady(cb: () => void) { return this.waiters.add(cb); }
  seek(): number { return 0; }
  async stat(): Promise<KStat> {
    return { dev: 3, ino: 0, filetype: FT_CHAR, nlink: 1, size: 0, atimeMs: 0, mtimeMs: 0, ctimeMs: 0 };
  }
  async close(): Promise<void> {}
}

// ── FdTable ──────────────────────────────────────────────────────────

const refcounts = new WeakMap<OpenFile, number>();
function ref(f: OpenFile): void { refcounts.set(f, (refcounts.get(f) ?? 0) + 1); }
async function unref(f: OpenFile): Promise<void> {
  const n = (refcounts.get(f) ?? 1) - 1;
  refcounts.set(f, n);
  if (n <= 0) await f.close();
}

export const MAX_FDS = 1024;

export class FdTable {
  private slots = new Map<number, { file: OpenFile; cloexec: boolean }>();

  get(fd: number): OpenFile | undefined { return this.slots.get(fd)?.file; }
  has(fd: number): boolean { return this.slots.has(fd); }
  entries(): Array<[number, OpenFile]> { return Array.from(this.slots, ([fd, s]) => [fd, s.file]); }
  getCloexec(fd: number): boolean { return !!this.slots.get(fd)?.cloexec; }
  setCloexec(fd: number, v: boolean): void { const s = this.slots.get(fd); if (s) s.cloexec = v; }

  alloc(file: OpenFile, minFd = 0, cloexec = false): number {
    let fd = minFd;
    while (this.slots.has(fd)) fd++;
    if (fd >= MAX_FDS) return -24; // EMFILE
    ref(file);
    this.slots.set(fd, { file, cloexec });
    return fd;
  }
  /** Put `file` at exactly `fd`, closing what was there. */
  async install(fd: number, file: OpenFile, cloexec = false): Promise<void> {
    ref(file);
    const old = this.slots.get(fd);
    this.slots.set(fd, { file, cloexec });
    if (old) await unref(old.file);
  }
  dup(fd: number, minFd = 0): number {
    const s = this.slots.get(fd);
    if (!s) return -EBADF;
    return this.alloc(s.file, minFd, false);
  }
  async dup2(from: number, to: number): Promise<number> {
    const s = this.slots.get(from);
    if (!s) return -EBADF;
    if (from === to) return to;
    await this.install(to, s.file, false);
    return to;
  }
  async close(fd: number): Promise<number> {
    const s = this.slots.get(fd);
    if (!s) return -EBADF;
    this.slots.delete(fd);
    await unref(s.file);
    return 0;
  }
  /** Move fd `from` to `to` (WASI fd_renumber). */
  async renumber(from: number, to: number): Promise<number> {
    const s = this.slots.get(from);
    if (!s) return -EBADF;
    if (from === to) return 0;
    const old = this.slots.get(to);
    this.slots.set(to, s);
    this.slots.delete(from);
    if (old) await unref(old.file);
    return 0;
  }
  fork(): FdTable {
    const t = new FdTable();
    for (const [fd, s] of this.slots) { ref(s.file); t.slots.set(fd, { ...s }); }
    return t;
  }
  async closeOnExec(): Promise<void> {
    for (const [fd, s] of Array.from(this.slots)) if (s.cloexec) await this.close(fd);
  }
  async closeAll(): Promise<void> {
    for (const fd of Array.from(this.slots.keys())) await this.close(fd);
  }
}

// ── Process ──────────────────────────────────────────────────────────

export class Process {
  pgid: number;
  sid: number;
  umask = 0o022;
  exitStatus?: number;
  children = new Set<Process>();
  /** Called on kill (terminate workers, abort a builtin). */
  killHooks: Array<(sig: number) => void> = [];
  private exitWaiters: Array<(status: number) => void> = [];

  constructor(
    readonly kernel: Kernel,
    readonly pid: number,
    readonly ppid: number,
    public cwd: string,
    public env: Record<string, string>,
    public argv: string[],
    public fds: FdTable,
  ) {
    this.pgid = pid;
    this.sid = pid;
  }

  get exited(): boolean { return this.exitStatus !== undefined; }

  /** Resolves with the wait status once the process has exited. */
  wait(): Promise<number> {
    if (this.exitStatus !== undefined) return Promise.resolve(this.exitStatus);
    return new Promise(r => this.exitWaiters.push(r));
  }

  /** Terminate with a wait status; closes every fd. Idempotent. */
  async exit(status: number): Promise<void> {
    if (this.exitStatus !== undefined) return;
    this.exitStatus = status;
    await this.fds.closeAll();
    const ws = this.exitWaiters;
    this.exitWaiters = [];
    for (const w of ws) w(status);
    this.kernel.childExited(this);
  }
}

// ── Kernel ───────────────────────────────────────────────────────────

export interface SpawnOptions {
  path: string;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  fds: Record<number, OpenFile> | FdTable;
  ppid?: number;
}

/** A loader for an executable format, chosen by its leading bytes. */
export interface Binfmt {
  name: string;
  test(head: Uint8Array): boolean;
  load(kernel: Kernel, proc: Process, image: Uint8Array, path: string): void | Promise<void>;
}

export class Kernel {
  readonly inodes: InodeTable;
  readonly procs = new Map<number, Process>();
  private nextPid = 100;
  private binfmts: Binfmt[] = [];
  private childWaiters = new Map<number, Array<() => void>>();
  /** Shell used by runBuiltin (forked per process). */
  shell: Shell | null = null;

  constructor(readonly fs: FileSystem) {
    this.inodes = new InodeTable(fs);
  }

  registerBinfmt(fmt: Binfmt): void {
    this.binfmts = this.binfmts.filter(b => b.name !== fmt.name);
    this.binfmts.push(fmt);
  }

  createProcess(opts: Omit<SpawnOptions, 'path'>): Process {
    const pid = this.nextPid++;
    let fds: FdTable;
    if (opts.fds instanceof FdTable) fds = opts.fds;
    else {
      fds = new FdTable();
      for (const [k, f] of Object.entries(opts.fds)) {
        // install() is async only to close a replaced file; the table is empty here
        void fds.install(Number(k), f);
      }
    }
    const ppid = opts.ppid ?? 1;
    const proc = new Process(this, pid, ppid, opts.cwd, { ...opts.env }, [...opts.argv], fds);
    const parent = this.procs.get(ppid);
    if (parent) { parent.children.add(proc); proc.pgid = parent.pgid; proc.sid = parent.sid; }
    this.procs.set(pid, proc);
    return proc;
  }

  /**
   * Start a program. `path` is a command name (searched on PATH) or a path.
   * Executables whose leading bytes match a registered binfmt run through
   * it; anything else runs as a Shiro builtin/script via runBuiltin.
   * Returns -ENOENT when there is no such program.
   */
  async spawn(opts: SpawnOptions): Promise<Process | number> {
    const resolved = await this.resolveProgram(opts.path, opts.cwd, opts.env.PATH);
    if (typeof resolved === 'number') return resolved;
    const proc = this.createProcess(opts);
    if (resolved.image) {
      const fmt = this.binfmts.find(b => b.test(resolved.image!.subarray(0, 16)))!;
      try {
        await fmt.load(this, proc, resolved.image, resolved.path!);
      } catch (e: any) {
        await this.writeStderr(proc, `${opts.argv[0] ?? opts.path}: ${e?.message ?? e}\n`);
        await proc.exit(exitStatus(126));
      }
    } else {
      void this.runBuiltin(proc, resolved.path ?? opts.path);
    }
    return proc;
  }

  /** Find a program: a file with a known binfmt, or a name the shell can run. */
  async resolveProgram(name: string, cwd: string, PATH?: string): Promise<{ path?: string; image?: Uint8Array } | number> {
    const candidates: string[] = [];
    if (name.includes('/')) candidates.push(this.fs.resolvePath(name, cwd));
    else {
      // Shiro keeps WASM binaries as NAME.wasm, so a PATH search tries that too
      for (const dir of (PATH ?? '/usr/local/bin:/usr/bin:/bin').split(':')) {
        if (dir) candidates.push(this.fs.resolvePath(dir + '/' + name, cwd), this.fs.resolvePath(dir + '/' + name + '.wasm', cwd));
      }
    }
    for (const p of candidates) {
      let st;
      try { st = await this.fs.stat(p); } catch { continue; }
      if (st.type === 'dir') { if (name.includes('/')) return -EACCES; continue; }
      await this.inodes.peek(p)?.flush();
      let image: Uint8Array;
      try {
        const d = await this.fs.readFile(p);
        image = typeof d === 'string' ? new TextEncoder().encode(d) : d;
      } catch { continue; }
      if (this.binfmts.some(b => b.test(image.subarray(0, 16)))) return { path: p, image };
      return { path: p };
    }
    if (name.includes('/')) return -ENOENT;
    const shell = this.shell;
    if (shell && (shell.commands.get(name) || (shell as any).functions?.[name] || (shell as any).aliases?.has?.(name))) return { path: name };
    if (shell && await shell.findExecutableInPath(name)) return { path: name };
    return -ENOENT;
  }

  /**
   * Run a Shiro builtin, script or shell command line as process `proc`:
   * fd 0 is read to EOF first unless it is a terminal (builtins take stdin
   * as a string), and output streams to fds 1/2 as the builtin writes it.
   */
  async runBuiltin(proc: Process, program: string): Promise<void> {
    const shell = this.shell;
    if (!shell) {
      await this.writeStderr(proc, `${program}: no shell available to run builtins\n`);
      await proc.exit(exitStatus(127));
      return;
    }
    await this.inodes.flushAll();
    const stdin = await this.drainStdin(proc);
    const child = shell.fork();
    const out = proc.fds.get(1);
    child.stdoutIsPipe = !out?.isTTY;
    child.cwd = proc.cwd;
    child.env = { ...proc.env, PWD: proc.cwd };
    let chain: Promise<unknown> = Promise.resolve();
    const enc = new TextEncoder();
    const emit = (fd: number) => (s: string) => {
      if (!s) return;
      // Shell writers use terminal line endings; a kernel fd gets plain \n
      // (a tty adds the \r back on output)
      const bytes = enc.encode(s.replace(/\r\n/g, '\n'));
      chain = chain.then(() => { const f = proc.fds.get(fd); return f ? writeAll(f, bytes) : 0; });
    };
    let aborted = false;
    proc.killHooks.push(() => { aborted = true; (child as any).abortController?.abort?.(); });
    const line = [program, ...proc.argv.slice(1)].map(shellQuote).join(' ');
    let code: number;
    try {
      code = await child.executeWithStdin(line, stdin, emit(1), emit(2));
    } catch (e: any) {
      emit(2)(`${program}: ${e?.message ?? e}\n`);
      code = 1;
    }
    await chain;
    if (!aborted) await proc.exit(exitStatus(code));
  }

  private async drainStdin(proc: Process): Promise<string> {
    const f = proc.fds.get(0);
    if (!f || f.isTTY || f.kind === 'dev') return '';
    const parts: Uint8Array[] = [];
    const buf = new Uint8Array(65536);
    for (;;) {
      const n = await f.read(buf);
      if (n <= 0) break;
      parts.push(buf.slice(0, n));
    }
    const dec = new TextDecoder();
    return parts.map(p => dec.decode(p, { stream: true })).join('') + dec.decode();
  }

  private async writeStderr(proc: Process, text: string): Promise<void> {
    const f = proc.fds.get(2);
    if (f) await writeAll(f, new TextEncoder().encode(text));
  }

  /** Called by Process.exit: wake waitpid callers of the parent. */
  childExited(proc: Process): void {
    const ws = this.childWaiters.get(proc.ppid);
    if (ws) { this.childWaiters.delete(proc.ppid); for (const w of ws) w(); }
    if (!this.procs.has(proc.ppid)) {
      // Orphan: nobody will reap it. Keep it briefly for Process.wait() users.
      setTimeout(() => this.procs.delete(proc.pid), 0);
    }
  }

  /**
   * Wait for a child of `parentPid` (`pid` -1 = any). Returns the reaped pid
   * and status, {pid: 0} with WNOHANG when none has exited, or -ECHILD.
   */
  async waitpid(parentPid: number, pid: number, options = 0): Promise<{ pid: number; status: number } | number> {
    for (;;) {
      const kids = Array.from(this.procs.values()).filter(p => p.ppid === parentPid && (pid === -1 || p.pid === pid));
      if (!kids.length) return -ECHILD;
      const done = kids.find(p => p.exited);
      if (done) {
        this.procs.delete(done.pid);
        this.procs.get(parentPid)?.children.delete(done);
        return { pid: done.pid, status: done.exitStatus! };
      }
      if (options & WNOHANG) return { pid: 0, status: 0 };
      await new Promise<void>(r => {
        const list = this.childWaiters.get(parentPid) ?? [];
        list.push(r);
        this.childWaiters.set(parentPid, list);
      });
    }
  }

  /** Deliver a signal. WASM guests have no handlers, so every signal but 0 terminates. */
  async kill(pid: number, sig: number): Promise<number> {
    const targets = pid < 0
      ? Array.from(this.procs.values()).filter(p => p.pgid === -pid)
      : [this.procs.get(pid)].filter(Boolean) as Process[];
    if (!targets.length) return -ESRCH;
    if (sig === 0) return 0;
    {
      for (const p of targets) {
        if (p.exited) continue;
        for (const h of p.killHooks) { try { h(sig); } catch { /* keep killing */ } }
        await p.exit(signalStatus(sig));
      }
    }
    return 0;
  }

  /** Release a top-level process after its creator collected the status. */
  reap(proc: Process): void {
    if (proc.exited) this.procs.delete(proc.pid);
  }
}

export async function writeAll(f: OpenFile, bytes: Uint8Array): Promise<number> {
  let off = 0;
  while (off < bytes.length) {
    const n = await f.write(bytes.subarray(off));
    if (n < 0) return off || n;
    if (n === 0) break;
    off += n;
  }
  return off;
}

export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

// ── Per-filesystem kernel instance ───────────────────────────────────

const kernels = new WeakMap<FileSystem, Kernel>();

/** The kernel for a filesystem (one per Shiro instance; tests make several). */
export function kernelFor(fs: FileSystem): Kernel {
  let k = kernels.get(fs);
  if (!k) { k = new Kernel(fs); kernels.set(fs, k); }
  return k;
}

export { ENOTSUP };
