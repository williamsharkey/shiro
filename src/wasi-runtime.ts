/**
 * wasi-runtime.ts — Standalone WASI runtime for Shiro
 *
 * Implements WASI preview1 (wasi_snapshot_preview1) system calls sufficient
 * to run WASM-compiled C/Rust/Go programs against Shiro's virtual filesystem.
 *
 * Design:
 *   - ShiroFS adapter bridges WASI fd operations to Shiro's async FileSystem
 *   - Streaming stdout/stderr callbacks (no buffering unless caller wants it)
 *   - Pre-opened directories (/home/user, /tmp) via preopens
 *   - Synchronous fd table with async pre-loading for files
 */

import type { FileSystem } from './filesystem';

// ── WASI errno constants ─────────────────────────────────────────────

export const WASI_ESUCCESS      = 0;
export const WASI_E2BIG         = 1;
export const WASI_EACCES        = 2;
export const WASI_EADDRINUSE    = 3;
export const WASI_EBADF         = 8;
export const WASI_EEXIST        = 20;
export const WASI_EFAULT        = 21;
export const WASI_EINVAL        = 28;
export const WASI_EIO           = 29;
export const WASI_EISDIR        = 31;
export const WASI_ELOOP         = 32;
export const WASI_ENAMETOOLONG  = 37;
export const WASI_ENOENT        = 44;
export const WASI_ENOSYS        = 52;
export const WASI_ENOTDIR       = 54;
export const WASI_ENOTEMPTY     = 55;
export const WASI_EPERM         = 63;
export const WASI_ENOTCAPABLE   = 76;

// ── WASI filetype constants ──────────────────────────────────────────

export const WASI_FILETYPE_UNKNOWN          = 0;
export const WASI_FILETYPE_BLOCK_DEVICE     = 1;
export const WASI_FILETYPE_CHARACTER_DEVICE = 2;
export const WASI_FILETYPE_DIRECTORY        = 3;
export const WASI_FILETYPE_REGULAR_FILE     = 4;
export const WASI_FILETYPE_SYMBOLIC_LINK    = 7;

// ── WASI fd flags / rights ───────────────────────────────────────────

export const WASI_FDFLAG_APPEND   = 1;
export const WASI_FDFLAG_DSYNC    = 2;
export const WASI_FDFLAG_NONBLOCK = 4;
export const WASI_FDFLAG_SYNC     = 16;

export const WASI_RIGHT_FD_READ             = 1n << 1n;
export const WASI_RIGHT_FD_WRITE            = 1n << 6n;
export const WASI_RIGHT_FD_SEEK             = 1n << 2n;
export const WASI_RIGHT_FD_TELL             = 1n << 5n;
export const WASI_RIGHT_FD_FILESTAT_GET     = 1n << 21n;
export const WASI_RIGHT_PATH_OPEN           = 1n << 8n;
export const WASI_RIGHT_PATH_CREATE_FILE    = 1n << 9n;
export const WASI_RIGHT_PATH_CREATE_DIR     = 1n << 10n;
export const WASI_RIGHT_PATH_READDIR        = 1n << 14n;

// oflags
export const WASI_O_CREAT     = 1;
export const WASI_O_DIRECTORY = 2;
export const WASI_O_EXCL      = 4;
export const WASI_O_TRUNC     = 8;

// whence
export const WASI_WHENCE_SET = 0;
export const WASI_WHENCE_CUR = 1;
export const WASI_WHENCE_END = 2;

// clock IDs
export const WASI_CLOCK_REALTIME  = 0;
export const WASI_CLOCK_MONOTONIC = 1;

// ── WasiExit — thrown to exit a WASM program ─────────────────────────

export class WasiExit extends Error {
  code: number;
  constructor(code: number) {
    super(`WASI exit with code ${code}`);
    this.name = 'WasiExit';
    this.code = code;
  }
}

// ── File descriptor abstraction ──────────────────────────────────────

export class FD {
  /** Absolute path in Shiro's virtual filesystem (null for stdio) */
  path: string | null;
  /** File type */
  filetype: number;
  /** Buffered content for regular files */
  data: Uint8Array;
  /** Current seek position */
  offset: number = 0;
  /** Whether this fd is writable */
  writable: boolean;
  /** Whether this fd is a preopen directory */
  preopen: string | null = null;
  /** Rights bitmask */
  rights: bigint;
  /** Whether this fd has been modified (needs writeback) */
  dirty: boolean = false;

  constructor(opts: {
    path: string | null;
    filetype: number;
    data?: Uint8Array;
    writable?: boolean;
    preopen?: string;
    rights?: bigint;
  }) {
    this.path = opts.path;
    this.filetype = opts.filetype;
    this.data = opts.data || new Uint8Array(0);
    this.writable = opts.writable ?? false;
    this.preopen = opts.preopen ?? null;
    this.rights = opts.rights ?? 0n;
  }

  /** Read up to `len` bytes from current offset */
  read(len: number): Uint8Array {
    const slice = this.data.slice(this.offset, this.offset + len);
    this.offset += slice.length;
    return slice;
  }

  /** Write bytes at current offset, growing buffer if needed */
  write(bytes: Uint8Array): number {
    const needed = this.offset + bytes.length;
    if (needed > this.data.length) {
      const grown = new Uint8Array(needed);
      grown.set(this.data);
      this.data = grown;
    }
    this.data.set(bytes, this.offset);
    this.offset += bytes.length;
    this.dirty = true;
    return bytes.length;
  }

  /** Seek to position */
  seek(offset: bigint, whence: number): bigint {
    let base: number;
    switch (whence) {
      case WASI_WHENCE_SET: base = 0; break;
      case WASI_WHENCE_CUR: base = this.offset; break;
      case WASI_WHENCE_END: base = this.data.length; break;
      default: base = 0;
    }
    this.offset = base + Number(offset);
    if (this.offset < 0) this.offset = 0;
    return BigInt(this.offset);
  }
}

// ── Path normalization ───────────────────────────────────────────────

export function normPath(p: string): string {
  const parts = p.split('/');
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

// ── WasiRT: the WASI runtime ────────────────────────────────────────

export interface WasiConfig {
  /** Shiro filesystem instance */
  fs: FileSystem;
  /** Working directory */
  cwd: string;
  /** Program arguments (argv[0] = program name) */
  args: string[];
  /** Environment variables */
  env: Record<string, string>;
  /** Stdin data */
  stdin?: string;
  /** Callback for stdout writes */
  onStdout?: (data: string) => void;
  /** Callback for stderr writes */
  onStderr?: (data: string) => void;
  /** Pre-opened directories: map of guest path → host path */
  preopens?: Record<string, string>;
}

export class WasiRT {
  private fds: Map<number, FD> = new Map();
  private nextFd: number = 3;
  private config: WasiConfig;
  private stdoutBuf: string = '';
  private stderrBuf: string = '';
  private memory!: WebAssembly.Memory;
  private instance!: WebAssembly.Instance;

  constructor(config: WasiConfig) {
    this.config = config;

    // fd 0 = stdin
    const stdinData = new TextEncoder().encode(config.stdin || '');
    this.fds.set(0, new FD({
      path: null,
      filetype: WASI_FILETYPE_CHARACTER_DEVICE,
      data: stdinData,
      writable: false,
      rights: WASI_RIGHT_FD_READ,
    }));

    // fd 1 = stdout
    this.fds.set(1, new FD({
      path: null,
      filetype: WASI_FILETYPE_CHARACTER_DEVICE,
      writable: true,
      rights: WASI_RIGHT_FD_WRITE,
    }));

    // fd 2 = stderr
    this.fds.set(2, new FD({
      path: null,
      filetype: WASI_FILETYPE_CHARACTER_DEVICE,
      writable: true,
      rights: WASI_RIGHT_FD_WRITE,
    }));

    // Set up preopens (directories the WASM module can access)
    const preopens = config.preopens || { '/': '/', '.': config.cwd };
    for (const [guestPath, hostPath] of Object.entries(preopens)) {
      const fd = this.nextFd++;
      this.fds.set(fd, new FD({
        path: hostPath,
        filetype: WASI_FILETYPE_DIRECTORY,
        writable: true,
        preopen: guestPath,
        rights: WASI_RIGHT_PATH_OPEN | WASI_RIGHT_PATH_CREATE_FILE |
                WASI_RIGHT_PATH_CREATE_DIR | WASI_RIGHT_PATH_READDIR |
                WASI_RIGHT_FD_READ | WASI_RIGHT_FD_WRITE |
                WASI_RIGHT_FD_FILESTAT_GET,
      }));
    }
  }

  /** Get the stdout output collected so far */
  get stdout(): string { return this.stdoutBuf; }

  /** Get the stderr output collected so far */
  get stderr(): string { return this.stderrBuf; }

  /** Build the WASI import object for WebAssembly.instantiate */
  getImports(): WebAssembly.Imports {
    return {
      wasi_snapshot_preview1: {
        args_get: this.args_get.bind(this),
        args_sizes_get: this.args_sizes_get.bind(this),
        environ_get: this.environ_get.bind(this),
        environ_sizes_get: this.environ_sizes_get.bind(this),
        clock_time_get: this.clock_time_get.bind(this),
        clock_res_get: this.clock_res_get.bind(this),
        fd_close: this.fd_close.bind(this),
        fd_fdstat_get: this.fd_fdstat_get.bind(this),
        fd_fdstat_set_flags: this.fd_fdstat_set_flags.bind(this),
        fd_filestat_get: this.fd_filestat_get.bind(this),
        fd_filestat_set_size: this.fd_filestat_set_size.bind(this),
        fd_filestat_set_times: this.fd_filestat_set_times.bind(this),
        fd_pread: this.fd_pread.bind(this),
        fd_prestat_get: this.fd_prestat_get.bind(this),
        fd_prestat_dir_name: this.fd_prestat_dir_name.bind(this),
        fd_pwrite: this.fd_pwrite.bind(this),
        fd_read: this.fd_read.bind(this),
        fd_readdir: this.fd_readdir.bind(this),
        fd_seek: this.fd_seek.bind(this),
        fd_sync: this.fd_sync.bind(this),
        fd_tell: this.fd_tell.bind(this),
        fd_write: this.fd_write.bind(this),
        path_create_directory: this.path_create_directory.bind(this),
        path_filestat_get: this.path_filestat_get.bind(this),
        path_filestat_set_times: this.path_filestat_set_times.bind(this),
        path_link: this.path_link.bind(this),
        path_open: this.path_open.bind(this),
        path_readlink: this.path_readlink.bind(this),
        path_remove_directory: this.path_remove_directory.bind(this),
        path_rename: this.path_rename.bind(this),
        path_symlink: this.path_symlink.bind(this),
        path_unlink_file: this.path_unlink_file.bind(this),
        poll_oneoff: this.poll_oneoff.bind(this),
        proc_exit: this.proc_exit.bind(this),
        proc_raise: this.proc_raise.bind(this),
        random_get: this.random_get.bind(this),
        sched_yield: this.sched_yield.bind(this),
        sock_accept: this.sock_accept.bind(this),
        sock_recv: this.sock_recv.bind(this),
        sock_send: this.sock_send.bind(this),
        sock_shutdown: this.sock_shutdown.bind(this),
      },
    };
  }

  /** Run a compiled WASM module. Returns the exit code. */
  async run(wasmModule: WebAssembly.Module): Promise<number> {
    const imports = this.getImports();
    this.instance = await WebAssembly.instantiate(wasmModule, imports);
    this.memory = this.instance.exports.memory as WebAssembly.Memory;

    try {
      const start = this.instance.exports._start as Function;
      if (!start) {
        throw new Error('WASM module has no _start export');
      }
      start();
      // Flush any dirty file descriptors back to Shiro FS
      await this.flushAll();
      return 0;
    } catch (e: any) {
      // Flush dirty fds even on exit
      await this.flushAll();
      if (e instanceof WasiExit) {
        return e.code;
      }
      throw e;
    }
  }

  // ── Helper: read C-string from WASM memory ────────────────────────

  private getString(ptr: number, len: number): string {
    const buf = new Uint8Array(this.memory.buffer, ptr, len);
    return new TextDecoder().decode(buf);
  }

  private getView(): DataView {
    return new DataView(this.memory.buffer);
  }

  private getU8(): Uint8Array {
    return new Uint8Array(this.memory.buffer);
  }

  // ── Helper: resolve path relative to a directory fd ────────────────

  private resolveFdPath(dirFd: number, pathPtr: number, pathLen: number): string | null {
    const fd = this.fds.get(dirFd);
    if (!fd || fd.filetype !== WASI_FILETYPE_DIRECTORY) return null;

    const relPath = this.getString(pathPtr, pathLen);
    const basePath = fd.path || '/';
    if (relPath.startsWith('/')) {
      return normPath(relPath);
    }
    return normPath(basePath + '/' + relPath);
  }

  // ── Helper: deferred operations queue ──────────────────────────────

  private deferredOps: Array<
    | { type: 'delete'; path: string }
    | { type: 'rmdir'; path: string }
    | { type: 'rename'; oldPath: string; newPath: string }
  > = [];

  // ── Helper: flush dirty fds and deferred ops back to filesystem ────

  private async flushAll(): Promise<void> {
    // Flush dirty file descriptors
    for (const [, fd] of this.fds) {
      if (fd.dirty && fd.path) {
        try {
          await this.config.fs.writeFile(fd.path, fd.data);
        } catch {
          // Best effort
        }
        fd.dirty = false;
      }
    }

    // Execute deferred filesystem operations
    for (const op of this.deferredOps) {
      try {
        switch (op.type) {
          case 'delete':
            await this.config.fs.unlink(op.path);
            break;
          case 'rmdir':
            await this.config.fs.rmdir(op.path);
            break;
          case 'rename':
            // Read the data, write to new path, delete old path
            try {
              const data = await this.config.fs.readFile(op.oldPath);
              await this.config.fs.writeFile(op.newPath, data);
              await this.config.fs.unlink(op.oldPath);
            } catch {
              // Best effort
            }
            break;
        }
      } catch {
        // Best effort
      }
    }
    this.deferredOps = [];
  }

  // ── Helper: synchronous file preload (must be called before run for path_open) ──

  private fileCache: Map<string, { data: Uint8Array; stat: { type: string; size: number; mtime: number } }> = new Map();

  /** Pre-load a file from Shiro FS into memory for synchronous access */
  async preloadFile(path: string): Promise<{ data: Uint8Array; stat: { type: string; size: number; mtime: number } } | null> {
    if (this.fileCache.has(path)) return this.fileCache.get(path)!;
    try {
      const data = await this.config.fs.readFile(path) as Uint8Array;
      const stat = await this.config.fs.stat(path);
      const entry = {
        data,
        stat: {
          type: stat.type,
          size: stat.size,
          mtime: stat.mtime.getTime(),
        },
      };
      this.fileCache.set(path, entry);
      return entry;
    } catch {
      return null;
    }
  }

  /** Cache for preloaded directory listings: path → entry names */
  private dirCache: Map<string, string[]> = new Map();

  /** Pre-load directory listing and cache it for fd_readdir */
  async preloadDir(path: string): Promise<string[] | null> {
    if (this.dirCache.has(path)) return this.dirCache.get(path)!;
    try {
      const entries = await this.config.fs.readdir(path);
      this.dirCache.set(path, entries);
      // Also register the directory in fileCache so path_filestat_get works
      if (!this.fileCache.has(path)) {
        this.fileCache.set(path, {
          data: new Uint8Array(0),
          stat: { type: 'dir', size: 0, mtime: Date.now() },
        });
      }
      return entries;
    } catch {
      return null;
    }
  }

  /**
   * Recursively preload a directory tree for synchronous WASI access.
   * Caps at maxDepth levels and maxFiles total to avoid blowing up memory.
   */
  async preloadTree(rootPath: string, maxDepth: number = 3, maxFiles: number = 100): Promise<void> {
    let fileCount = 0;
    const queue: Array<{ path: string; depth: number }> = [{ path: rootPath, depth: 0 }];

    while (queue.length > 0 && fileCount < maxFiles) {
      const { path: dirPath, depth } = queue.shift()!;
      const entries = await this.preloadDir(dirPath);
      if (!entries) continue;

      for (const name of entries) {
        if (fileCount >= maxFiles) break;
        const fullPath = dirPath === '/' ? `/${name}` : `${dirPath}/${name}`;
        try {
          const stat = await this.config.fs.stat(fullPath);
          if (stat.type === 'dir') {
            this.fileCache.set(fullPath, {
              data: new Uint8Array(0),
              stat: { type: 'dir', size: 0, mtime: stat.mtime.getTime() },
            });
            if (depth < maxDepth) {
              queue.push({ path: fullPath, depth: depth + 1 });
            }
          } else {
            await this.preloadFile(fullPath);
            fileCount++;
          }
        } catch {
          // Skip files we can't stat
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  WASI SYSCALL IMPLEMENTATIONS
  // ══════════════════════════════════════════════════════════════════

  // ── args ─────────────────────────────────────────────────────────

  private args_sizes_get(argcPtr: number, argvBufSizePtr: number): number {
    const view = this.getView();
    const args = this.config.args;
    view.setUint32(argcPtr, args.length, true);
    let totalSize = 0;
    for (const arg of args) {
      totalSize += new TextEncoder().encode(arg).length + 1; // +1 for null terminator
    }
    view.setUint32(argvBufSizePtr, totalSize, true);
    return WASI_ESUCCESS;
  }

  private args_get(argvPtr: number, argvBufPtr: number): number {
    const view = this.getView();
    const mem = this.getU8();
    let bufOffset = argvBufPtr;
    for (let i = 0; i < this.config.args.length; i++) {
      view.setUint32(argvPtr + i * 4, bufOffset, true);
      const encoded = new TextEncoder().encode(this.config.args[i]);
      mem.set(encoded, bufOffset);
      mem[bufOffset + encoded.length] = 0; // null terminator
      bufOffset += encoded.length + 1;
    }
    return WASI_ESUCCESS;
  }

  // ── environ ──────────────────────────────────────────────────────

  private environ_sizes_get(countPtr: number, bufSizePtr: number): number {
    const view = this.getView();
    const entries = Object.entries(this.config.env);
    view.setUint32(countPtr, entries.length, true);
    let totalSize = 0;
    for (const [key, value] of entries) {
      totalSize += new TextEncoder().encode(`${key}=${value}`).length + 1;
    }
    view.setUint32(bufSizePtr, totalSize, true);
    return WASI_ESUCCESS;
  }

  private environ_get(environPtr: number, environBufPtr: number): number {
    const view = this.getView();
    const mem = this.getU8();
    const entries = Object.entries(this.config.env);
    let bufOffset = environBufPtr;
    for (let i = 0; i < entries.length; i++) {
      view.setUint32(environPtr + i * 4, bufOffset, true);
      const encoded = new TextEncoder().encode(`${entries[i][0]}=${entries[i][1]}`);
      mem.set(encoded, bufOffset);
      mem[bufOffset + encoded.length] = 0;
      bufOffset += encoded.length + 1;
    }
    return WASI_ESUCCESS;
  }

  // ── clock ────────────────────────────────────────────────────────

  private clock_time_get(clockId: number, _precision: bigint, timePtr: number): number {
    const view = this.getView();
    let ns: bigint;
    if (clockId === WASI_CLOCK_REALTIME) {
      ns = BigInt(Date.now()) * 1_000_000n;
    } else {
      ns = BigInt(Math.round(performance.now() * 1e6));
    }
    view.setBigUint64(timePtr, ns, true);
    return WASI_ESUCCESS;
  }

  private clock_res_get(clockId: number, resPtr: number): number {
    const view = this.getView();
    // 1ms resolution
    view.setBigUint64(resPtr, 1_000_000n, true);
    return WASI_ESUCCESS;
  }

  // ── fd operations ────────────────────────────────────────────────

  private fd_close(fd: number): number {
    if (!this.fds.has(fd)) return WASI_EBADF;
    this.fds.delete(fd);
    return WASI_ESUCCESS;
  }

  private fd_fdstat_get(fd: number, bufPtr: number): number {
    const f = this.fds.get(fd);
    if (!f) return WASI_EBADF;
    const view = this.getView();
    view.setUint8(bufPtr, f.filetype);        // fs_filetype
    view.setUint16(bufPtr + 2, 0, true);      // fs_flags
    view.setBigUint64(bufPtr + 8, f.rights, true);  // fs_rights_base
    view.setBigUint64(bufPtr + 16, f.rights, true);  // fs_rights_inheriting
    return WASI_ESUCCESS;
  }

  private fd_fdstat_set_flags(_fd: number, _flags: number): number {
    return WASI_ESUCCESS; // no-op
  }

  private fd_filestat_get(fd: number, bufPtr: number): number {
    const f = this.fds.get(fd);
    if (!f) return WASI_EBADF;
    const view = this.getView();
    // filestat structure (64 bytes)
    view.setBigUint64(bufPtr + 0, 0n, true);     // dev
    view.setBigUint64(bufPtr + 8, 0n, true);     // ino
    view.setUint8(bufPtr + 16, f.filetype);       // filetype
    view.setBigUint64(bufPtr + 24, 1n, true);    // nlink
    view.setBigUint64(bufPtr + 32, BigInt(f.data.length), true); // size
    const now = BigInt(Date.now()) * 1_000_000n;
    view.setBigUint64(bufPtr + 40, now, true);    // atim
    view.setBigUint64(bufPtr + 48, now, true);    // mtim
    view.setBigUint64(bufPtr + 56, now, true);    // ctim
    return WASI_ESUCCESS;
  }

  private fd_filestat_set_size(fd: number, size: bigint): number {
    const f = this.fds.get(fd);
    if (!f) return WASI_EBADF;
    const newSize = Number(size);
    if (newSize < f.data.length) {
      f.data = f.data.slice(0, newSize);
    } else if (newSize > f.data.length) {
      const grown = new Uint8Array(newSize);
      grown.set(f.data);
      f.data = grown;
    }
    f.dirty = true;
    return WASI_ESUCCESS;
  }

  private fd_filestat_set_times(_fd: number, _atim: bigint, _mtim: bigint, _flags: number): number {
    return WASI_ESUCCESS; // no-op for now
  }

  private fd_read(fd: number, iovsPtr: number, iovsLen: number, nreadPtr: number): number {
    const f = this.fds.get(fd);
    if (!f) return WASI_EBADF;
    const view = this.getView();
    const mem = this.getU8();
    let totalRead = 0;

    for (let i = 0; i < iovsLen; i++) {
      const bufPtr = view.getUint32(iovsPtr + i * 8, true);
      const bufLen = view.getUint32(iovsPtr + i * 8 + 4, true);
      const chunk = f.read(bufLen);
      mem.set(chunk, bufPtr);
      totalRead += chunk.length;
      if (chunk.length < bufLen) break; // EOF
    }

    view.setUint32(nreadPtr, totalRead, true);
    return WASI_ESUCCESS;
  }

  private fd_pread(fd: number, iovsPtr: number, iovsLen: number, offset: bigint, nreadPtr: number): number {
    const f = this.fds.get(fd);
    if (!f) return WASI_EBADF;
    const savedOffset = f.offset;
    f.offset = Number(offset);
    const result = this.fd_read(fd, iovsPtr, iovsLen, nreadPtr);
    f.offset = savedOffset;
    return result;
  }

  private fd_write(fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number {
    const f = this.fds.get(fd);
    if (!f) return WASI_EBADF;
    const view = this.getView();
    const mem = this.getU8();
    let totalWritten = 0;

    for (let i = 0; i < iovsLen; i++) {
      const bufPtr = view.getUint32(iovsPtr + i * 8, true);
      const bufLen = view.getUint32(iovsPtr + i * 8 + 4, true);
      const chunk = mem.slice(bufPtr, bufPtr + bufLen);

      // Stdio: stream to callbacks
      if (fd === 1 || fd === 2) {
        const text = new TextDecoder().decode(chunk);
        if (fd === 1) {
          this.stdoutBuf += text;
          this.config.onStdout?.(text);
        } else {
          this.stderrBuf += text;
          this.config.onStderr?.(text);
        }
      } else {
        f.write(chunk);
      }
      totalWritten += bufLen;
    }

    view.setUint32(nwrittenPtr, totalWritten, true);
    return WASI_ESUCCESS;
  }

  private fd_pwrite(fd: number, iovsPtr: number, iovsLen: number, offset: bigint, nwrittenPtr: number): number {
    const f = this.fds.get(fd);
    if (!f) return WASI_EBADF;
    const savedOffset = f.offset;
    f.offset = Number(offset);
    const result = this.fd_write(fd, iovsPtr, iovsLen, nwrittenPtr);
    f.offset = savedOffset;
    return result;
  }

  private fd_seek(fd: number, offset: bigint, whence: number, newOffsetPtr: number): number {
    const f = this.fds.get(fd);
    if (!f) return WASI_EBADF;
    // Stdio is not seekable
    if (fd <= 2) return WASI_ESUCCESS;
    const newOffset = f.seek(offset, whence);
    const view = this.getView();
    view.setBigUint64(newOffsetPtr, newOffset, true);
    return WASI_ESUCCESS;
  }

  private fd_tell(fd: number, offsetPtr: number): number {
    const f = this.fds.get(fd);
    if (!f) return WASI_EBADF;
    const view = this.getView();
    view.setBigUint64(offsetPtr, BigInt(f.offset), true);
    return WASI_ESUCCESS;
  }

  private fd_sync(_fd: number): number {
    return WASI_ESUCCESS; // no-op
  }

  // ── fd prestat (for pre-opened directories) ────────────────────────

  private fd_prestat_get(fd: number, bufPtr: number): number {
    const f = this.fds.get(fd);
    if (!f || f.preopen === null) return WASI_EBADF;
    const view = this.getView();
    view.setUint8(bufPtr, 0); // type = dir
    const nameLen = new TextEncoder().encode(f.preopen).length;
    view.setUint32(bufPtr + 4, nameLen, true);
    return WASI_ESUCCESS;
  }

  private fd_prestat_dir_name(fd: number, pathPtr: number, pathLen: number): number {
    const f = this.fds.get(fd);
    if (!f || f.preopen === null) return WASI_EBADF;
    const encoded = new TextEncoder().encode(f.preopen);
    const mem = this.getU8();
    mem.set(encoded.slice(0, pathLen), pathPtr);
    return WASI_ESUCCESS;
  }

  // ── fd_readdir ─────────────────────────────────────────────────────

  /**
   * Serialized dirent buffers per fd, built on first call from preloaded dirCache.
   * dirent layout (WASI preview1):
   *   d_next:   u64  (8 bytes) — cookie of next entry
   *   d_ino:    u64  (8 bytes) — inode (we use 0)
   *   d_namlen: u32  (4 bytes)
   *   d_type:   u8   (1 byte)  — WASI filetype
   *   padding:  3 bytes
   *   name:     d_namlen bytes (NOT null-terminated)
   * Total header = 24 bytes + name
   */
  private dirEntryBuf: Map<number, Uint8Array> = new Map();

  private fd_readdir(fd: number, bufPtr: number, bufLen: number, cookie: bigint, usedPtr: number): number {
    const f = this.fds.get(fd);
    if (!f || f.filetype !== WASI_FILETYPE_DIRECTORY) return WASI_EBADF;

    const dirPath = f.path || '/';

    // Build serialized entry buffer on first use or cookie 0
    if (!this.dirEntryBuf.has(fd)) {
      const entries = this.dirCache.get(dirPath) || [];
      const enc = new TextEncoder();
      // Calculate total size
      let totalSize = 0;
      const encodedNames: Uint8Array[] = [];
      for (const name of entries) {
        const nameBytes = enc.encode(name);
        encodedNames.push(nameBytes);
        totalSize += 24 + nameBytes.length;
      }
      // Serialize
      const buf = new Uint8Array(totalSize);
      const dv = new DataView(buf.buffer);
      let off = 0;
      for (let i = 0; i < entries.length; i++) {
        const nameBytes = encodedNames[i];
        const entryPath = dirPath === '/' ? `/${entries[i]}` : `${dirPath}/${entries[i]}`;
        const cached = this.fileCache.get(entryPath);
        const ftype = cached?.stat.type === 'dir' ? WASI_FILETYPE_DIRECTORY : WASI_FILETYPE_REGULAR_FILE;

        dv.setBigUint64(off, BigInt(i + 1), true);       // d_next
        dv.setBigUint64(off + 8, 0n, true);              // d_ino
        dv.setUint32(off + 16, nameBytes.length, true);  // d_namlen
        buf[off + 20] = ftype;                            // d_type
        // 3 bytes padding (already 0)
        buf.set(nameBytes, off + 24);
        off += 24 + nameBytes.length;
      }
      this.dirEntryBuf.set(fd, buf);
    }

    const serialized = this.dirEntryBuf.get(fd)!;
    const cookieNum = Number(cookie);
    const view = this.getView();
    const mem = this.getU8();

    // Find the byte offset for the given cookie (entry index)
    // We need to skip `cookie` entries to find the start offset
    const enc = new TextEncoder();
    const entries = this.dirCache.get(dirPath) || [];
    let byteOff = 0;
    for (let i = 0; i < cookieNum && i < entries.length; i++) {
      byteOff += 24 + enc.encode(entries[i]).length;
    }

    // Copy as much as fits into the output buffer
    const remaining = serialized.length - byteOff;
    const toCopy = Math.min(remaining, bufLen);
    if (toCopy > 0) {
      mem.set(serialized.subarray(byteOff, byteOff + toCopy), bufPtr);
    }
    view.setUint32(usedPtr, toCopy, true);

    return WASI_ESUCCESS;
  }

  // ── path operations ────────────────────────────────────────────────

  private path_open(
    dirFd: number, _dirFlags: number,
    pathPtr: number, pathLen: number,
    oflags: number, _fsRightsBase: bigint, _fsRightsInheriting: bigint,
    fdFlags: number, fdPtr: number,
  ): number {
    const absPath = this.resolveFdPath(dirFd, pathPtr, pathLen);
    if (!absPath) return WASI_EBADF;

    const creating = (oflags & WASI_O_CREAT) !== 0;
    const truncating = (oflags & WASI_O_TRUNC) !== 0;
    const wantDir = (oflags & WASI_O_DIRECTORY) !== 0;

    // Check preloaded cache
    const cached = this.fileCache.get(absPath);

    if (wantDir) {
      // Open as directory
      const newFd = this.nextFd++;
      this.fds.set(newFd, new FD({
        path: absPath,
        filetype: WASI_FILETYPE_DIRECTORY,
        writable: true,
        rights: WASI_RIGHT_PATH_OPEN | WASI_RIGHT_PATH_READDIR |
                WASI_RIGHT_FD_READ | WASI_RIGHT_FD_FILESTAT_GET,
      }));
      const view = this.getView();
      view.setUint32(fdPtr, newFd, true);
      return WASI_ESUCCESS;
    }

    if (cached) {
      const newFd = this.nextFd++;
      const data = truncating ? new Uint8Array(0) : new Uint8Array(cached.data);
      this.fds.set(newFd, new FD({
        path: absPath,
        filetype: WASI_FILETYPE_REGULAR_FILE,
        data,
        writable: true,
        rights: WASI_RIGHT_FD_READ | WASI_RIGHT_FD_WRITE |
                WASI_RIGHT_FD_SEEK | WASI_RIGHT_FD_TELL |
                WASI_RIGHT_FD_FILESTAT_GET,
      }));
      if (truncating) {
        this.fds.get(newFd)!.dirty = true;
      }
      const view = this.getView();
      view.setUint32(fdPtr, newFd, true);
      return WASI_ESUCCESS;
    }

    if (creating) {
      // Create an empty file
      const newFd = this.nextFd++;
      this.fds.set(newFd, new FD({
        path: absPath,
        filetype: WASI_FILETYPE_REGULAR_FILE,
        data: new Uint8Array(0),
        writable: true,
        rights: WASI_RIGHT_FD_READ | WASI_RIGHT_FD_WRITE |
                WASI_RIGHT_FD_SEEK | WASI_RIGHT_FD_TELL |
                WASI_RIGHT_FD_FILESTAT_GET,
      }));
      this.fds.get(newFd)!.dirty = true;
      const view = this.getView();
      view.setUint32(fdPtr, newFd, true);
      return WASI_ESUCCESS;
    }

    return WASI_ENOENT;
  }

  private path_create_directory(dirFd: number, pathPtr: number, pathLen: number): number {
    // Can't create dirs synchronously — the wasi command wrapper handles this
    return WASI_ESUCCESS;
  }

  private path_filestat_get(dirFd: number, _flags: number, pathPtr: number, pathLen: number, bufPtr: number): number {
    const absPath = this.resolveFdPath(dirFd, pathPtr, pathLen);
    if (!absPath) return WASI_EBADF;

    const cached = this.fileCache.get(absPath);
    const view = this.getView();

    if (cached) {
      const isDir = cached.stat.type === 'dir';
      view.setBigUint64(bufPtr + 0, 0n, true);     // dev
      view.setBigUint64(bufPtr + 8, 0n, true);     // ino
      view.setUint8(bufPtr + 16, isDir ? WASI_FILETYPE_DIRECTORY : WASI_FILETYPE_REGULAR_FILE);
      view.setBigUint64(bufPtr + 24, 1n, true);    // nlink
      view.setBigUint64(bufPtr + 32, BigInt(cached.stat.size), true);
      const mtim = BigInt(cached.stat.mtime) * 1_000_000n;
      view.setBigUint64(bufPtr + 40, mtim, true);
      view.setBigUint64(bufPtr + 48, mtim, true);
      view.setBigUint64(bufPtr + 56, mtim, true);
      return WASI_ESUCCESS;
    }

    return WASI_ENOENT;
  }

  private path_filestat_set_times(
    _dirFd: number, _flags: number,
    _pathPtr: number, _pathLen: number,
    _atim: bigint, _mtim: bigint, _fstFlags: number,
  ): number {
    return WASI_ESUCCESS; // no-op
  }

  private path_link(
    _oldDirFd: number, _oldFlags: number,
    _oldPathPtr: number, _oldPathLen: number,
    _newDirFd: number, _newPathPtr: number, _newPathLen: number,
  ): number {
    return WASI_ENOSYS; // not supported
  }

  private path_readlink(
    _dirFd: number, _pathPtr: number, _pathLen: number,
    _bufPtr: number, _bufLen: number, _usedPtr: number,
  ): number {
    return WASI_ENOSYS;
  }

  private path_remove_directory(dirFd: number, pathPtr: number, pathLen: number): number {
    const absPath = this.resolveFdPath(dirFd, pathPtr, pathLen);
    if (!absPath) return WASI_EBADF;
    this.deferredOps.push({ type: 'rmdir', path: absPath });
    // Remove from caches
    this.fileCache.delete(absPath);
    this.dirCache.delete(absPath);
    return WASI_ESUCCESS;
  }

  private path_rename(
    oldDirFd: number, oldPathPtr: number, oldPathLen: number,
    newDirFd: number, newPathPtr: number, newPathLen: number,
  ): number {
    const oldPath = this.resolveFdPath(oldDirFd, oldPathPtr, oldPathLen);
    const newPath = this.resolveFdPath(newDirFd, newPathPtr, newPathLen);
    if (!oldPath || !newPath) return WASI_EBADF;
    this.deferredOps.push({ type: 'rename', oldPath, newPath });
    // Update caches
    const cached = this.fileCache.get(oldPath);
    if (cached) {
      this.fileCache.set(newPath, cached);
      this.fileCache.delete(oldPath);
    }
    return WASI_ESUCCESS;
  }

  private path_symlink(_oldPathPtr: number, _oldPathLen: number, _dirFd: number, _newPathPtr: number, _newPathLen: number): number {
    return WASI_ENOSYS;
  }

  private path_unlink_file(dirFd: number, pathPtr: number, pathLen: number): number {
    const absPath = this.resolveFdPath(dirFd, pathPtr, pathLen);
    if (!absPath) return WASI_EBADF;
    this.deferredOps.push({ type: 'delete', path: absPath });
    // Remove from cache
    this.fileCache.delete(absPath);
    return WASI_ESUCCESS;
  }

  // ── process ────────────────────────────────────────────────────────

  private proc_exit(code: number): void {
    throw new WasiExit(code);
  }

  private proc_raise(_sig: number): number {
    return WASI_ENOSYS;
  }

  // ── random ─────────────────────────────────────────────────────────

  private random_get(bufPtr: number, bufLen: number): number {
    const buf = new Uint8Array(this.memory.buffer, bufPtr, bufLen);
    crypto.getRandomValues(buf);
    return WASI_ESUCCESS;
  }

  // ── scheduling ─────────────────────────────────────────────────────

  private sched_yield(): number {
    return WASI_ESUCCESS;
  }

  // ── poll ───────────────────────────────────────────────────────────

  private poll_oneoff(inPtr: number, outPtr: number, nsubscriptions: number, neventsPtr: number): number {
    // Minimal poll implementation: just report all subscriptions as ready
    const view = this.getView();
    const mem = this.getU8();

    for (let i = 0; i < nsubscriptions; i++) {
      const subBase = inPtr + i * 48;
      const eventBase = outPtr + i * 32;

      // Copy userdata from subscription to event
      const userdata = view.getBigUint64(subBase, true);
      view.setBigUint64(eventBase, userdata, true);
      // errno = success
      view.setUint16(eventBase + 8, WASI_ESUCCESS, true);
      // type = same as subscription type
      const subType = view.getUint8(subBase + 8);
      view.setUint8(eventBase + 10, subType);
      // For FD events, report available bytes
      if (subType === 1 || subType === 2) {
        view.setBigUint64(eventBase + 16, 65536n, true); // nbytes
        view.setUint16(eventBase + 24, 0, true); // flags
      }
    }

    view.setUint32(neventsPtr, nsubscriptions, true);
    return WASI_ESUCCESS;
  }

  // ── sockets (stubs) ────────────────────────────────────────────────

  private sock_accept(_fd: number, _flags: number, _fdPtr: number): number {
    return WASI_ENOSYS;
  }

  private sock_recv(_fd: number, _iovsPtr: number, _iovsLen: number, _flags: number, _nreadPtr: number, _flagsPtr: number): number {
    return WASI_ENOSYS;
  }

  private sock_send(_fd: number, _iovsPtr: number, _iovsLen: number, _flags: number, _nwrittenPtr: number): number {
    return WASI_ENOSYS;
  }

  private sock_shutdown(_fd: number, _how: number): number {
    return WASI_ENOSYS;
  }
}
