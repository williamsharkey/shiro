/**
 * The FileSystem methods node-compat uses, over blocking syscalls: what
 * `ctx.fs` is when node runs as a kernel guest in a Worker
 * (TABCOMPUTER_NODE_WORKER=1). Every call goes to the kernel through the
 * guest's channel and returns its answer at once, so the *Cached methods
 * (node's readFileSync, existsSync, readdirSync) are never "not cached".
 * The async ones are the same calls behind a resolved promise.
 *
 * Two caches keep repeated calls to one syscall or none:
 * - file bytes, keyed by path and checked with one stat (dev, ino, size,
 *   mtime, ctime) before each use, so a read of an unchanged file is a stat;
 * - directories known to be directories (not symlinks), so realpath lstats
 *   only the components it hasn't seen. Our own unlink/rmdir/rename/symlink
 *   drop what they touch, and `invalidate()` (after a child process ran)
 *   drops them all; a directory another process swaps for a symlink while
 *   this one runs isn't noticed until then.
 */
import * as A from '../kernel/abi';
import type { GuestSys } from '../kernel/channel';

const enc = new TextEncoder();

const MESSAGES: Record<number, string> = {
  [A.ENOENT]: 'no such file or directory', [A.EEXIST]: 'file already exists', [A.ENOTDIR]: 'not a directory',
  [A.EISDIR]: 'illegal operation on a directory', [A.ENOTEMPTY]: 'directory not empty', [A.EACCES]: 'permission denied',
  [A.EPERM]: 'operation not permitted', [A.EINVAL]: 'invalid argument', [A.ELOOP]: 'too many symbolic links encountered',
  [A.EBADF]: 'bad file descriptor', [A.EXDEV]: 'cross-device link not permitted', [A.ENAMETOOLONG]: 'name too long',
  [A.ENOSPC]: 'no space left on device', [A.EROFS]: 'read-only file system', [A.EBUSY]: 'resource busy or locked',
  [A.EIO]: 'i/o error',
};
// errno names (not EPOLL* and the other E-names that share their numbers)
const CODES: Record<number, string> = Object.fromEntries(Object.entries(A)
  .filter(([k, v]) => /^E[A-Z0-9]+$/.test(k) && !k.startsWith('EPOLL') && typeof v === 'number' && v > 0 && v < 200)
  .reverse() // the first name wins (EAGAIN over EWOULDBLOCK)
  .map(([k, v]) => [v as number, k]));

/** An Error like FileSystem's (and node's): code, errno, syscall, path */
export function sysError(errno: number, op: string, path?: string): Error {
  const code = CODES[errno] ?? `E${errno}`;
  const err: any = new Error(`${code}: ${MESSAGES[errno] ?? 'error'}, ${op}${path !== undefined ? ` '${path}'` : ''}`);
  err.code = code;
  err.errno = -errno;
  err.syscall = op;
  if (path !== undefined) err.path = path;
  return err;
}

type NodeType = 'file' | 'dir' | 'symlink';

/** A StatResult (filesystem.ts makeStat's shape) from the kernel's stat */
function statResult(s: A.KStat): any {
  const t = s.mode & A.S_IFMT;
  const type: NodeType = t === A.S_IFDIR ? 'dir' : t === A.S_IFLNK ? 'symlink' : 'file';
  const mtime = new Date(s.mtimeMs), ctime = new Date(s.ctimeMs), atime = new Date(s.atimeMs);
  return {
    type, mode: s.mode, size: s.size, mtime, ctime, atime, birthtime: ctime,
    mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, atimeMs: s.atimeMs, birthtimeMs: s.ctimeMs,
    mtimeNs: s.mtimeNs ?? 0, atimeNs: s.atimeNs ?? 0,
    dev: s.dev, ino: s.ino, nlink: s.nlink, uid: s.uid, gid: s.gid, rdev: s.rdev, blksize: s.blksize, blocks: s.blocks,
    isFile: () => t === A.S_IFREG,
    isDirectory: () => t === A.S_IFDIR,
    isSymbolicLink: () => t === A.S_IFLNK,
    isBlockDevice: () => t === 0o060000,
    isCharacterDevice: () => t === A.S_IFCHR,
    isFIFO: () => t === A.S_IFIFO,
    isSocket: () => t === A.S_IFSOCK,
  };
}

/** Files above this aren't kept; the whole cache is dropped past MAX_CACHED */
const MAX_FILE = 1 << 20;
const MAX_CACHED = 64 << 20;

interface CachedFile { dev: number; ino: number; size: number; mtimeMs: number; mtimeNs: number; ctimeMs: number; bytes: Uint8Array }

const sameFile = (c: CachedFile, s: A.KStat) =>
  c.ino === s.ino && c.dev === s.dev && c.size === s.size && c.mtimeMs === s.mtimeMs && c.mtimeNs === (s.mtimeNs ?? 0) && c.ctimeMs === s.ctimeMs;

const isDir = (s: A.KStat) => (s.mode & A.S_IFMT) === A.S_IFDIR;

export class SyscallFs {
  private files = new Map<string, CachedFile>();
  private cachedBytes = 0;
  /** Canonical paths that were directories (not symlinks) when last seen */
  private dirs = new Set<string>();

  /** Syscalls this guest has made (any: a change could come from one) */
  private calls = 0;
  /**
   * realpath's lstat of the last component, for the lookup that follows it in
   * the same fs call (node-compat resolves a path, then asks about it): used
   * once, and only while no other syscall came in between, within a ms.
   */
  private last: { path: string; s: A.KStat | number; calls: number; at: number } | null = null;

  constructor(private sys: GuestSys) {
    const call = sys.ch.call.bind(sys.ch);
    sys.ch.call = (nr: number, ...args: number[]) => { this.calls++; return call(nr, ...args); };
  }

  /** Forget directories (something else may have changed the tree: a child process ran) */
  invalidate(): void { this.dirs.clear(); this.last = null; }

  /** Forget `path` and everything under it (we removed, renamed or replaced it) */
  private forget(path: string): void {
    const c = this.files.get(path);
    if (c) { this.files.delete(path); this.cachedBytes -= c.size; }
    // a directory's descendants are only known if it was (realpath walks down from the root)
    if (!this.dirs.delete(path)) return;
    const under = path === '/' ? '/' : path + '/';
    for (const d of this.dirs) if (d.startsWith(under)) this.dirs.delete(d);
    for (const [f, fc] of this.files) if (f.startsWith(under)) { this.files.delete(f); this.cachedBytes -= fc.size; }
  }

  private remember(path: string, s: A.KStat, bytes: Uint8Array): void {
    const old = this.files.get(path);
    if (old) { this.files.delete(path); this.cachedBytes -= old.size; }
    if (bytes.length > MAX_FILE || bytes.length !== s.size) return;
    if (this.cachedBytes + bytes.length > MAX_CACHED) { this.files.clear(); this.cachedBytes = 0; }
    this.files.set(path, { dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, mtimeNs: s.mtimeNs ?? 0, ctimeMs: s.ctimeMs, bytes });
    this.cachedBytes += bytes.length;
  }

  // ── synchronous core ──

  /** stat (following symlinks unless `follow` is false), or -errno */
  statRaw(path: string, follow = true): A.KStat | number {
    return follow ? this.sys.stat(path) : this.sys.fstatat(A.AT_FDCWD, path, A.AT_SYMLINK_NOFOLLOW);
  }

  statSync(path: string, follow = true): any {
    const s = this.statRaw(path, follow);
    if (typeof s === 'number') throw sysError(-s, follow ? 'stat' : 'lstat', path);
    return statResult(s);
  }

  /** A file's bytes (a copy: callers may change it), or -errno */
  readRaw(path: string): Uint8Array | number {
    const s = this.sys.stat(path);
    if (typeof s === 'number') return s;
    if (isDir(s)) return -A.EISDIR;
    const c = this.files.get(path);
    if (c && sameFile(c, s)) return c.bytes.slice();
    const fd = this.sys.open(path, A.O_RDONLY);
    if (fd < 0) return fd;
    try {
      const r = this.sys.readAll(fd);
      // keyed by the stat before the read: a change since then fails the next check. A file
      // written this very millisecond could change again without its stat changing: not kept
      if (typeof r !== 'number' && (s.mode & A.S_IFMT) === A.S_IFREG && Date.now() - s.mtimeMs > 1) this.remember(path, s, r.slice());
      return r;
    } finally {
      this.sys.close(fd);
    }
  }

  readSync(path: string): Uint8Array {
    const r = this.readRaw(path);
    if (typeof r === 'number') throw sysError(-r, 'open', path);
    return r;
  }

  writeSync(path: string, data: Uint8Array | string, mode = 0o666): void {
    this.forget(path);
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    const fd = this.sys.open(path, A.O_WRONLY | A.O_CREAT | A.O_TRUNC, mode);
    if (fd < 0) throw sysError(-fd, 'open', path);
    try {
      const n = this.sys.write(fd, bytes);
      if (n < 0) throw sysError(-n, 'write', path);
    } finally {
      this.sys.close(fd);
    }
  }

  /** Entry names (no . and ..), or -errno */
  readdirRaw(path: string): string[] | number {
    const fd = this.sys.open(path, A.O_RDONLY | A.O_DIRECTORY);
    if (fd < 0) return fd;
    const names: string[] = [];
    try {
      const ch = this.sys.ch;
      for (;;) {
        const n = ch.call(A.SYS_getdents64, fd, ch.data.length);
        if (n < 0) return n;
        if (n === 0) break;
        // linux_dirent64: ino(8) off(8) reclen(2) type(1) name\0 — copied out of the shared buffer first
        const buf = ch.data.slice(0, n);
        const dv = new DataView(buf.buffer);
        for (let off = 0; off < n;) {
          const reclen = dv.getUint16(off + 16, true);
          let end = off + 19;
          while (end < off + reclen && buf[end] !== 0) end++;
          const name = A.decodeText(buf.subarray(off + 19, end));
          if (name !== '.' && name !== '..') names.push(name);
          off += reclen;
        }
      }
    } finally {
      this.sys.close(fd);
    }
    return names;
  }

  readdirSync(path: string): string[] {
    const r = this.readdirRaw(path);
    if (typeof r === 'number') throw sysError(-r, 'scandir', path);
    return r;
  }

  mkdirSync(path: string, recursive = false, mode = 0o777): void {
    if (!recursive) {
      const r = this.sys.mkdir(path, mode);
      if (r < 0) throw sysError(-r, 'mkdir', path);
      return;
    }
    let cur = '';
    for (const part of path.split('/').filter(Boolean)) {
      cur += '/' + part;
      const r = this.sys.mkdir(cur, mode);
      if (r < 0 && r !== -A.EEXIST) throw sysError(-r, 'mkdir', cur);
      if (r === -A.EEXIST && !this.dirs.has(cur)) {
        const s = this.statRaw(cur);
        if (typeof s === 'number' || !isDir(s)) throw sysError(A.ENOTDIR, 'mkdir', cur);
      }
    }
  }

  readlinkSync(path: string): string {
    const r = this.sys.readlink(path);
    if (typeof r === 'number') throw sysError(-r, 'readlink', path);
    return r;
  }

  /** The path with every symlink resolved, or -errno */
  realpathRaw(path: string): string | number {
    let parts = path.split('/').filter(Boolean);
    let out: string[] = [];
    for (let links = 0, i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p === '.') continue;
      if (p === '..') { out.pop(); continue; }
      const cand = '/' + [...out, p].join('/');
      if (this.dirs.has(cand)) { out.push(p); continue; }
      const s = this.statRaw(cand, false);
      if (i === parts.length - 1 && (typeof s === 'number' || !isDir(s))) this.last = { path: cand, s, calls: this.calls, at: performance.now() };
      if (typeof s === 'number') return s;
      if (isDir(s)) this.dirs.add(cand);
      if ((s.mode & A.S_IFMT) === A.S_IFLNK) {
        if (++links > 40) return -A.ELOOP;
        const target = this.sys.readlink(cand);
        if (typeof target === 'number') return target;
        const rest = parts.slice(i + 1);
        if (target.startsWith('/')) out = [];
        parts = [...target.split('/').filter(Boolean), ...rest];
        i = -1;
        continue;
      }
      out.push(p);
    }
    return '/' + out.join('/');
  }

  // ── FileSystem's synchronous surface (node-compat calls these "Cached") ──

  resolvePath(path: string, cwd: string): string {
    const resolved = path.startsWith('/') ? path : (cwd === '/' ? '/' : cwd + '/') + path;
    const stack: string[] = [];
    for (const part of resolved.split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') stack.pop(); else stack.push(part);
    }
    return '/' + stack.join('/');
  }

  readBytesCached(path: string): Uint8Array | undefined {
    const r = this.readRaw(path);
    return typeof r === 'number' ? undefined : r;
  }

  readCached(path: string): string | undefined {
    const b = this.readBytesCached(path);
    return b === undefined ? undefined : new TextDecoder().decode(b);
  }

  readdirCached(path: string): string[] | undefined {
    const r = this.readdirRaw(path);
    return typeof r === 'number' ? undefined : r;
  }

  isDirCached(path: string): boolean {
    const s = this.statRaw(path);
    return typeof s !== 'number' && (s.mode & A.S_IFMT) === A.S_IFDIR;
  }

  readlinkCached(path: string): string | null | undefined {
    const s = this.statRaw(path, false);
    if (typeof s === 'number') return undefined;
    if ((s.mode & A.S_IFMT) !== A.S_IFLNK) return null;
    const r = this.sys.readlink(path);
    return typeof r === 'number' ? undefined : r;
  }

  realpathCached(path: string): string | undefined {
    const r = this.realpathRaw(path);
    return typeof r === 'number' ? undefined : r;
  }

  /** { path, node } like FileSystem's (canonical path, the node's type and times); null if missing */
  lookupCached(path: string, follow = true): { path: string; node: any } | null | undefined {
    // lstat first: unless it's a symlink that's the answer, and only the parent needs resolving
    const last = this.last;
    this.last = null;
    let s = last && last.path === path && last.calls === this.calls && performance.now() - last.at < 1 ? last.s : this.statRaw(path, false);
    let real = path;
    if (typeof s !== 'number' && follow) {
      if ((s.mode & A.S_IFMT) === A.S_IFLNK) {
        s = this.statRaw(path, true);
        if (typeof s !== 'number') real = this.realpathCached(path) ?? path;
      } else {
        const slash = path.lastIndexOf('/');
        const dir = slash <= 0 ? '/' : this.realpathCached(path.slice(0, slash)) ?? path.slice(0, slash);
        real = path === '/' ? '/' : (dir === '/' ? '' : dir) + path.slice(slash);
        if (isDir(s)) this.dirs.add(real);
      }
    }
    if (typeof s === 'number') return s === -A.ENOENT || s === -A.ENOTDIR ? null : undefined;
    const st = statResult(s);
    return { path: real, node: { path: real, type: st.type, mode: s.mode, size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs, ino: s.ino, special: st.isFIFO() ? 'fifo' : undefined } };
  }

  private listeners = new Set<(event: string, path: string, newPath?: string) => void>();
  /** Set by the guest: ask the page for its filesystem's change feed (once) */
  requestChanges: (() => void) | null = null;

  /** The page's filesystem changes (any process's writes), for fs.watch and chokidar */
  onChange(listener: (event: string, path: string, newPath?: string) => void): () => void {
    this.listeners.add(listener);
    if (this.requestChanges) { this.requestChanges(); this.requestChanges = null; }
    return () => { this.listeners.delete(listener); };
  }

  /** Hear changes while something else has the feed on (a watcher), without asking for it */
  onChangePassive(listener: (event: string, path: string, newPath?: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** A change the page reported: what we cached about those paths goes, then the listeners hear it */
  changed(event: string, path: string, newPath?: string): void {
    this.forget(path);
    if (newPath) this.forget(newPath);
    this.last = null;
    for (const fn of this.listeners) { try { fn(event, path, newPath); } catch { /* a listener's problem */ } }
  }

  // ── FileSystem's async surface: the same calls ──

  async readFile(path: string, encoding?: 'utf8'): Promise<Uint8Array | string> {
    const b = this.readSync(path);
    return encoding === 'utf8' ? new TextDecoder().decode(b) : b;
  }
  async writeFile(path: string, data: Uint8Array | string, options?: { mode?: number }): Promise<void> { this.writeSync(path, data, options?.mode); }
  writeNow(path: string, content: Uint8Array): Promise<void> { this.writeSync(path, content); return Promise.resolve(); }
  async stat(path: string): Promise<any> { return this.statSync(path, true); }
  async lstat(path: string): Promise<any> { return this.statSync(path, false); }
  async exists(path: string): Promise<boolean> { return typeof this.statRaw(path) !== 'number'; }
  async readdir(path: string): Promise<string[]> { return this.readdirSync(path); }
  async mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void> { this.mkdirSync(path, !!options?.recursive, options?.mode); }
  mkdirNow(path: string, options?: { recursive?: boolean }): Promise<void> { this.mkdirSync(path, !!options?.recursive); return Promise.resolve(); }
  async unlink(path: string): Promise<void> { this.forget(path); const r = this.sys.unlink(path); if (r < 0) throw sysError(-r, 'unlink', path); }
  unlinkNow(path: string): Promise<void> { return this.unlink(path); }
  async rmdir(path: string): Promise<void> { this.forget(path); const r = this.sys.rmdir(path); if (r < 0) throw sysError(-r, 'rmdir', path); }
  renameSync(from: string, to: string): void { this.forget(from); this.forget(to); const r = this.sys.rename(from, to); if (r < 0) throw sysError(-r, 'rename', from); }
  async rename(from: string, to: string): Promise<void> { this.renameSync(from, to); }
  async symlink(target: string, path: string): Promise<void> { this.forget(path); const r = this.sys.symlink(target, path); if (r < 0) throw sysError(-r, 'symlink', path); }
  symlinkNow(target: string, path: string): Promise<void> { return this.symlink(target, path); }
  async readlink(path: string): Promise<string> { return this.readlinkSync(path); }
  async realpath(path: string): Promise<string> {
    const r = this.realpathRaw(path);
    if (typeof r === 'number') throw sysError(-r, 'realpath', path);
    return r;
  }
  chmodSync(path: string, mode: number): void {
    const b = enc.encode(path);
    this.sys.ch.data.set(b);
    const r = this.sys.ch.call(A.SYS_fchmodat, A.AT_FDCWD, b.length, mode);
    if (r < 0) throw sysError(-r, 'chmod', path);
  }
  async chmod(path: string, mode: number): Promise<void> { this.chmodSync(path, mode); }
  async utimes(path: string, atimeMs: number, mtimeMs: number): Promise<void> {
    const r = this.sys.utimensat(A.AT_FDCWD, path, atimeMs, mtimeMs);
    if (r < 0) throw sysError(-r, 'utime', path);
  }
}
