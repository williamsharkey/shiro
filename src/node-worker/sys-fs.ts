/**
 * The FileSystem methods node-compat uses, over blocking syscalls: what
 * `ctx.fs` is when node runs as a kernel guest in a Worker
 * (TABCOMPUTER_NODE_WORKER=1). Every call goes to the kernel through the
 * guest's channel and returns its answer at once, so the *Cached methods
 * (node's readFileSync, existsSync, readdirSync) are never stale and never
 * "not cached": there is no cache here. The async ones are the same calls
 * behind a resolved promise.
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
const CODES: Record<number, string> = Object.fromEntries(Object.entries(A)
  .filter(([k, v]) => /^E[A-Z0-9]+$/.test(k) && typeof v === 'number')
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

export class SyscallFs {
  constructor(private sys: GuestSys) {}

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

  /** A file's bytes, or -errno */
  readRaw(path: string): Uint8Array | number {
    const fd = this.sys.open(path, A.O_RDONLY);
    if (fd < 0) return fd;
    try {
      const st = this.sys.fstat(fd);
      if (typeof st !== 'number' && (st.mode & A.S_IFMT) === A.S_IFDIR) return -A.EISDIR;
      const r = this.sys.readAll(fd);
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
    const fd = this.sys.open(path, A.O_WRONLY | A.O_CREAT | A.O_TRUNC, mode);
    if (fd < 0) throw sysError(-fd, 'open', path);
    try {
      const bytes = typeof data === 'string' ? enc.encode(data) : data;
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
      if (r === -A.EEXIST) {
        const s = this.statRaw(cur);
        if (typeof s === 'number' || (s.mode & A.S_IFMT) !== A.S_IFDIR) throw sysError(A.ENOTDIR, 'mkdir', cur);
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
      const s = this.statRaw(cand, false);
      if (typeof s === 'number') return s;
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
    const s = this.statRaw(path, follow);
    if (typeof s === 'number') return s === -A.ENOENT || s === -A.ENOTDIR ? null : undefined;
    const real = follow ? this.realpathCached(path) ?? path : path;
    const st = statResult(s);
    return { path: real, node: { path: real, type: st.type, mode: s.mode, size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs, ino: s.ino, special: st.isFIFO() ? 'fifo' : undefined } };
  }

  /** node-compat watches for writes from elsewhere; a guest has no such feed (yet) */
  onChange(_listener: (...a: any[]) => void): () => void { return () => {}; }

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
  async unlink(path: string): Promise<void> { const r = this.sys.unlink(path); if (r < 0) throw sysError(-r, 'unlink', path); }
  unlinkNow(path: string): Promise<void> { return this.unlink(path); }
  async rmdir(path: string): Promise<void> { const r = this.sys.rmdir(path); if (r < 0) throw sysError(-r, 'rmdir', path); }
  renameSync(from: string, to: string): void { const r = this.sys.rename(from, to); if (r < 0) throw sysError(-r, 'rename', from); }
  async rename(from: string, to: string): Promise<void> { this.renameSync(from, to); }
  async symlink(target: string, path: string): Promise<void> { const r = this.sys.symlink(target, path); if (r < 0) throw sysError(-r, 'symlink', path); }
  symlinkNow(target: string, path: string): Promise<void> { return this.symlink(target, path); }
  async readlink(path: string): Promise<string> { return this.readlinkSync(path); }
  async realpath(path: string): Promise<string> {
    const r = this.realpathRaw(path);
    if (typeof r === 'number') throw sysError(-r, 'realpath', path);
    return r;
  }
  async chmod(path: string, mode: number): Promise<void> {
    const b = enc.encode(path);
    this.sys.ch.data.set(b);
    const r = this.sys.ch.call(A.SYS_fchmodat, A.AT_FDCWD, b.length, mode);
    if (r < 0) throw sysError(-r, 'chmod', path);
  }
  async utimes(path: string, atimeMs: number, mtimeMs: number): Promise<void> {
    const r = this.sys.utimensat(A.AT_FDCWD, path, atimeMs, mtimeMs);
    if (r < 0) throw sysError(-r, 'utime', path);
  }
}
