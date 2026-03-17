import type { CommandContext } from '../../commands/index';

export interface FsDeps {
  ctx: CommandContext;
  fileCache: Map<string, string>;
  fileMtimes: Map<string, number>;
  pendingPromises: Promise<any>[];
  tickSyncOps: () => void;
  FakeBuffer: any;
  getBuiltinModule: (name: string) => any;
  homeDir: string;
}

/** Create a Node.js-style fs error with code, errno, syscall properties */
function fsError(code: string, message: string, syscall?: string, path?: string): Error {
  const err: any = new Error(message);
  err.code = code;
  err.errno = code === 'ENOENT' ? -2 : code === 'EEXIST' ? -17 : code === 'EISDIR' ? -21 : code === 'ENOTDIR' ? -20 : code === 'EACCES' ? -13 : -1;
  if (syscall) err.syscall = syscall;
  if (path) err.path = path;
  return err;
}

export function createFsModule(deps: FsDeps): any {
  const { ctx, fileCache, fileMtimes, pendingPromises, tickSyncOps, FakeBuffer, getBuiltinModule, homeDir } = deps;

  // Synchronous shims that use cached data or throw
  const fsShim: any = {
    readFileSync: (p: string, opts?: any) => {
      tickSyncOps();
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      let cached = fileCache.get(resolved) ?? fileCache.get(resolved + '.js');
      // Fallback: check Shiro's FS in-memory cache for files created by
      // shell commands (git clone, echo, sed) that bypass nodeCmd's fileCache
      if (cached === undefined) {
        cached = ctx.fs.readCached(resolved) ?? ctx.fs.readCached(resolved + '.js');
        if (cached !== undefined) fileCache.set(resolved, cached); // promote to fileCache
      }
      if (cached === undefined) {
          if (resolved.includes('/tasks/') || resolved.includes('/tmp/claude')) {
            console.warn(`[fs-debug] readFileSync ENOENT: ${resolved} (fileCache size: ${fileCache.size}, has task dirs: ${[...fileCache.keys()].filter(k => k.includes('/tasks/')).length})`);
          }
          throw fsError('ENOENT', `ENOENT: no such file or directory, open '${p}'`, 'open', p);
      }
      const encoding = typeof opts === 'string' ? opts : opts?.encoding;
      if (encoding === 'utf8' || encoding === 'utf-8' || encoding === 'utf8') return cached;
      if (!encoding) return FakeBuffer.from(cached);
      return cached;
    },
    writeFileSync: (p: string, data: string | Uint8Array) => {
      tickSyncOps();
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      const strData = typeof data === 'string' ? data : new TextDecoder().decode(data);
      if (resolved.includes('/tasks/') || resolved.includes('/tmp/claude')) {
        console.warn(`[fs-debug] writeFileSync: ${resolved} (${strData.length} bytes)`);
      }
      fileCache.set(resolved, strData);
      fileMtimes.set(resolved, Date.now());
      // Skip IDB write for .tmp files — they're transient atomic-write intermediaries.
      // The data reaches IDB via renameSync which writes to the final path.
      if (!resolved.includes('.tmp.')) {
        pendingPromises.push(ctx.fs.writeFile(resolved, strData).catch(() => {}));
      }
      // localStorage WAL for critical config files (survives page close before IndexedDB flushes)
      // Skip .tmp files — they'll be WAL'd when renamed to their final name
      if ((resolved.startsWith(homeDir + '/.claude') || resolved === homeDir + '/.claude.json') && !resolved.includes('.tmp.')) {
        try { localStorage.setItem('wal:' + resolved, strData); } catch {}
      }
    },
    existsSync: (p: string) => {
      tickSyncOps();
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      if (fileCache.has(resolved) || fileCache.has(resolved + '.js') || fileCache.has(resolved + '/index.js')) return true;
      // Check for directory sentinel (from mkdirSync)
      if (fileCache.has(resolved + '/.')) return true;
      // Check if path is a directory (has files under it)
      if ([...fileCache.keys()].some(k => k.startsWith(resolved + '/'))) return true;
      // Fallback: check Shiro FS cache for files created by shell commands
      if (ctx.fs.readCached(resolved) !== undefined) return true;
      // Fallback: check Shiro FS cache for directories
      if (ctx.fs.readdirCached(resolved) !== undefined) return true;
      return false;
    },
    statSync: (p: string, opts?: any) => {
      tickSyncOps();
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      let isFile = fileCache.has(resolved);
      // Fallback: check Shiro FS cache for files created by shell commands
      if (!isFile && ctx.fs.readCached(resolved) !== undefined) {
        isFile = true;
        fileCache.set(resolved, ctx.fs.readCached(resolved)!); // promote
      }
      let isDir = fileCache.has(resolved + '/.') || [...fileCache.keys()].some(k => k.startsWith(resolved + '/'));
      // Fallback: check Shiro FS cache for directories
      if (!isDir && ctx.fs.readdirCached(resolved) !== undefined) {
        isDir = true;
      }
      if (!isFile && !isDir) {
        if (opts?.throwIfNoEntry === false) return undefined;
        throw fsError('ENOENT', `ENOENT: no such file or directory, stat '${p}'`, 'stat', p);
      }
      const mtime = new Date(fileMtimes.get(resolved) || Date.now());
      const size = isFile ? (fileCache.get(resolved) || '').length : 0;
      return {
        isFile: () => isFile,
        isDirectory: () => isDir && !isFile,
        isSymbolicLink: () => false,
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isFIFO: () => false,
        isSocket: () => false,
        size,
        mtime, ctime: mtime, atime: mtime, birthtime: mtime,
        mtimeMs: mtime.getTime(), ctimeMs: mtime.getTime(), atimeMs: mtime.getTime(), birthtimeMs: mtime.getTime(),
        dev: 0, ino: 0, nlink: 1, uid: 1000, gid: 1000, rdev: 0,
        blksize: 4096, blocks: Math.ceil(size / 512),
        mode: isFile ? 0o100644 : 0o40755,
      };
    },
    readdirSync: (p: string, opts?: any) => {
      tickSyncOps();
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      const prefix = resolved === '/' ? '/' : resolved + '/';
      const entries = new Set<string>();
      const dirSet = new Set<string>();
      for (const key of fileCache.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const first = rest.split('/')[0];
          if (first) {
            entries.add(first);
            if (rest.includes('/')) dirSet.add(first);
          }
        }
      }
      // Fallback: merge entries from Shiro FS cache (files from shell commands)
      const fsCached = ctx.fs.readdirCached(resolved);
      if (fsCached) {
        for (const name of fsCached) {
          entries.add(name);
          // Detect directories from Shiro FS cache (readdirCached returns entries for dirs)
          if (!dirSet.has(name)) {
            const childPath = resolved === '/' ? '/' + name : resolved + '/' + name;
            // If it has sub-entries in FS cache, it's a directory
            if (ctx.fs.readdirCached(childPath) !== undefined) {
              dirSet.add(name);
            }
            // Also check fileCache for directory sentinel
            if (fileCache.has(childPath + '/.')) {
              dirSet.add(name);
            }
          }
        }
      }
      // Handle recursive option
      if (opts?.recursive) {
        const allEntries: string[] = [];
        const collectRecursive = (dir: string, rel: string) => {
          const dirPrefix = dir === '/' ? '/' : dir + '/';
          const immediateEntries = new Set<string>();
          const immediateDirs = new Set<string>();
          for (const key of fileCache.keys()) {
            if (key.startsWith(dirPrefix)) {
              const rest = key.slice(dirPrefix.length);
              const first = rest.split('/')[0];
              if (first && first !== '.') {
                immediateEntries.add(first);
                if (rest.includes('/')) immediateDirs.add(first);
              }
            }
          }
          const fsCachedR = ctx.fs.readdirCached(dir);
          if (fsCachedR) for (const e of fsCachedR) immediateEntries.add(e);
          for (const name of [...immediateEntries].sort()) {
            const entryRel = rel ? rel + '/' + name : name;
            allEntries.push(entryRel);
            if (immediateDirs.has(name)) {
              collectRecursive(dir + '/' + name, entryRel);
            }
          }
        };
        collectRecursive(resolved, '');
        return allEntries;
      }
      const sorted = [...entries].sort();
      if (opts?.withFileTypes) {
        return sorted.map(name => ({
          name,
          isFile: () => !dirSet.has(name),
          isDirectory: () => dirSet.has(name),
          isSymbolicLink: () => false,
          isBlockDevice: () => false,
          isCharacterDevice: () => false,
          isFIFO: () => false,
          isSocket: () => false,
        }));
      }
      return sorted;
    },
    mkdirSync: (p: string, opts?: any) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      // Mark directory in fileCache so existsSync/statSync can find it
      // Use a sentinel value to distinguish from files
      if (opts?.recursive) {
        // Create all intermediate directories in cache
        const parts = resolved.split('/').filter(Boolean);
        let cur = '';
        for (const part of parts) {
          cur += '/' + part;
          if (!fileCache.has(cur + '/.')) fileCache.set(cur + '/.', '');
        }
      } else {
        fileCache.set(resolved + '/.', '');
      }
      pendingPromises.push(ctx.fs.mkdir(resolved, opts).catch(() => {}));
    },
    unlinkSync: (p: string) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      fileCache.delete(resolved);
      fileMtimes.delete(resolved);
      pendingPromises.push(ctx.fs.unlink(resolved).catch(() => {}));
    },
    copyFileSync: (src: string, dst: string) => {
      const srcRes = ctx.fs.resolvePath(src, ctx.cwd);
      const dstRes = ctx.fs.resolvePath(dst, ctx.cwd);
      const cached = fileCache.get(srcRes);
      if (cached !== undefined) {
        fileCache.set(dstRes, cached);
        pendingPromises.push(ctx.fs.writeFile(dstRes, cached).catch(() => {}));
      } else {
        pendingPromises.push(ctx.fs.readFile(srcRes, 'utf8').then((data: any) => ctx.fs.writeFile(dstRes, data)).catch(() => {}));
      }
    },
    renameSync: (oldP: string, newP: string) => {
      const oldRes = ctx.fs.resolvePath(oldP, ctx.cwd);
      const newRes = ctx.fs.resolvePath(newP, ctx.cwd);
      // Update fileCache: move content from old path to new path
      const content = fileCache.get(oldRes);
      if (content !== undefined) {
        fileCache.set(newRes, content);
        fileCache.delete(oldRes);
        fileMtimes.set(newRes, Date.now());
        fileMtimes.delete(oldRes);
        // Write directly to new path — avoids race where IDB write for
        // the source hasn't completed yet (atomic write pattern: write .tmp → rename)
        pendingPromises.push(
          ctx.fs.writeFile(newRes, content)
            .then(() => ctx.fs.unlink(oldRes).catch(() => {}))
            .catch(() => {})
        );
        // Update WAL: remove .tmp entry, add final file
        if (newRes.startsWith(homeDir + '/.claude') || newRes === homeDir + '/.claude.json') {
          try {
            localStorage.removeItem('wal:' + oldRes);
            localStorage.setItem('wal:' + newRes, content);
          } catch {}
        }
      } else {
        // Content not in fileCache — read from Shiro FS cache or IDB will handle it
        const fsCached = ctx.fs.readCached(oldRes);
        if (fsCached !== undefined) {
          fileCache.set(newRes, fsCached);
          fileMtimes.set(newRes, Date.now());
        }
        pendingPromises.push(ctx.fs.rename(oldRes, newRes).catch(() => {}));
      }
    },
    realpathSync: (p: string) => {
      tickSyncOps();
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      // Verify path exists (file or directory)
      const isFile = fileCache.has(resolved);
      const isDir = [...fileCache.keys()].some(k => k.startsWith(resolved + '/'));
      if (!isFile && !isDir) throw fsError('ENOENT', `ENOENT: no such file or directory, realpath '${p}'`, 'realpath', p);
      return resolved;
    },
    accessSync: (p: string) => {
      tickSyncOps();
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      const isFile = fileCache.has(resolved);
      const isDir = [...fileCache.keys()].some(k => k.startsWith(resolved + '/'));
      if (!isFile && !isDir) throw fsError('ENOENT', `ENOENT: no such file or directory, access '${p}'`, 'access', p);
    },
    lstatSync: (p: string, opts?: any) => {
      tickSyncOps();
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      const isFile = fileCache.has(resolved);
      const isDir = [...fileCache.keys()].some(k => k.startsWith(resolved + '/'));
      if (!isFile && !isDir) {
        if (opts?.throwIfNoEntry === false) return undefined;
        throw fsError('ENOENT', `ENOENT: no such file or directory, lstat '${p}'`, 'lstat', p);
      }
      const mtime = new Date(fileMtimes.get(resolved) || Date.now());
      const size = isFile ? (fileCache.get(resolved) || '').length : 0;
      return {
        isFile: () => isFile,
        isDirectory: () => isDir && !isFile,
        isSymbolicLink: () => false,
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isFIFO: () => false,
        isSocket: () => false,
        size,
        mtime, ctime: mtime, atime: mtime, birthtime: mtime,
        mtimeMs: mtime.getTime(), ctimeMs: mtime.getTime(), atimeMs: mtime.getTime(), birthtimeMs: mtime.getTime(),
        dev: 0, ino: 0, nlink: 1, uid: 1000, gid: 1000, rdev: 0,
        blksize: 4096, blocks: Math.ceil(size / 512),
        mode: isFile ? 0o100644 : 0o40755,
      };
    },
    chmodSync: () => {},
    chownSync: () => {},
    // File descriptor based sync operations (minimal stubs for CLI compatibility)
    openSync: (p: string, flags?: string | number) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      const fd = 100 + Math.floor(Math.random() * 9900);
      // Store mapping for writeSync/readSync/closeSync
      (globalThis as any).__shiroFds = (globalThis as any).__shiroFds || {};
      // Normalize flags: numeric (O_WRONLY=1, O_RDWR=2, O_CREAT=64, O_TRUNC=512, O_APPEND=1024)
      // to string 'r'/'w'/'a' for compatibility
      let f: string;
      if (typeof flags === 'number') {
        const isWrite = (flags & 1) || (flags & 2); // O_WRONLY | O_RDWR
        const isAppend = flags & 1024; // O_APPEND
        const isTrunc = flags & 512; // O_TRUNC
        f = isAppend ? 'a' : isWrite ? 'w' : 'r';
      } else {
        f = flags || 'r';
      }
      (globalThis as any).__shiroFds[fd] = { path: resolved, flags: f, offset: 0 };
      if (resolved.includes('/tasks/') || resolved.includes('/tmp/claude')) {
        console.warn(`[fs-debug] openSync: ${resolved} flags=${flags}→${f} → fd=${fd}`);
      }
      // 'w' / 'w+' / 'wx' flags truncate the file on open (POSIX behavior)
      if (f.includes('w')) {
        fileCache.set(resolved, '');
        fileMtimes.set(resolved, Date.now());
        // Ensure parent dirs exist in fileCache
        const parentDir = resolved.substring(0, resolved.lastIndexOf('/'));
        if (parentDir && !fileCache.has(parentDir + '/.')) {
          fileCache.set(parentDir + '/.', '');
        }
      }
      return fd;
    },
    writeSync: (fd: number, data: string | Uint8Array) => {
      const fdInfo = (globalThis as any).__shiroFds?.[fd];
      if (fdInfo) {
        const existing = fileCache.get(fdInfo.path) || '';
        const str = typeof data === 'string' ? data : new TextDecoder().decode(data);
        const newContent = existing + str;
        fileCache.set(fdInfo.path, newContent);
        fileMtimes.set(fdInfo.path, Date.now());
        pendingPromises.push(ctx.fs.writeFile(fdInfo.path, newContent).catch(() => {}));
      }
      return typeof data === 'string' ? data.length : data.length;
    },
    readSync: (fd: number, buf: Uint8Array, offset?: number, length?: number, position?: number) => {
      const fdInfo = (globalThis as any).__shiroFds?.[fd];
      if (!fdInfo) return 0;
      const content = fileCache.get(fdInfo.path) || '';
      const bytes = new TextEncoder().encode(content);
      const pos = position ?? fdInfo.offset;
      const len = Math.min(length ?? buf.length, bytes.length - pos);
      for (let i = 0; i < len; i++) buf[(offset ?? 0) + i] = bytes[pos + i];
      fdInfo.offset = pos + len;
      return len;
    },
    closeSync: (fd: number) => {
      if ((globalThis as any).__shiroFds?.[fd]) delete (globalThis as any).__shiroFds[fd];
    },
    fsyncSync: () => {},
    fdatasyncSync: () => {},
    utimesSync: () => {},
    rmSync: (p: string, opts?: any) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      if (resolved.includes('/tmp/claude')) {
        console.warn(`[fs-debug] rmSync: ${resolved} (recursive: ${!!opts?.recursive})`);
      }
      if (opts?.recursive) {
        // Remove directory and all contents from fileCache + IDB
        const prefix = resolved + '/';
        const now = Date.now();
        for (const key of [...fileCache.keys()]) {
          if (key === resolved || key.startsWith(prefix)) {
            // Protect recently-written task output files from startup cleanup race.
            // Claude Code's startup purges other sessions' /tmp/claude-* dirs, but
            // the current session may have just written output files there.
            const mtime = fileMtimes.get(key);
            if (mtime && (now - mtime) < 30000 && key.includes('/tasks/')) {
              continue; // skip files written in the last 30 seconds under tasks/
            }
            fileCache.delete(key);
            fileMtimes.delete(key);
            ctx.fs.unlink(key).catch(() => {});
          }
        }
      } else {
        fileCache.delete(resolved);
        fileMtimes.delete(resolved);
        ctx.fs.unlink(resolved).catch(() => {});
      }
    },
    rmdirSync: (p: string) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      ctx.fs.rmdir(resolved).catch(() => {});
    },
    appendFileSync: (p: string, data: string | Uint8Array) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      const existing = fileCache.get(resolved) || '';
      const str = typeof data === 'string' ? data : new TextDecoder().decode(data);
      fileCache.set(resolved, existing + str);
      pendingPromises.push(ctx.fs.writeFile(resolved, existing + str).catch(() => {}));
    },
    symlinkSync: (target: string, path: string) => {
      const resolved = ctx.fs.resolvePath(path, ctx.cwd);
      const targetResolved = ctx.fs.resolvePath(target, ctx.cwd);
      // Symlinks in VFS: just copy the target reference
      const content = fileCache.get(targetResolved);
      if (content !== undefined) fileCache.set(resolved, content);
    },
    createReadStream: (p: string, opts?: any) => {
      const s = getBuiltinModule('stream');
      const rs = new s.Readable();
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      const encoding = opts?.encoding || (typeof opts === 'string' ? opts : null);
      ctx.fs.readFile(resolved, encoding || 'utf8').then((data: any) => {
        if (typeof data === 'string') {
          rs.emit('data', encoding ? data : FakeBuffer.from(data));
        } else {
          rs.emit('data', data);
        }
        rs.emit('end');
        rs.emit('close');
      }).catch((e: any) => {
        rs.emit('error', e);
      });
      return rs;
    },
    createWriteStream: (p: string, _opts?: any) => {
      const s = getBuiltinModule('stream');
      const chunks: string[] = [];
      const ws = new s.Writable();
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      ws.write = function(chunk: any, enc?: any, cb?: any) {
        const callback = typeof enc === 'function' ? enc : cb;
        chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
        if (callback) callback();
        return true;
      };
      ws.end = function(chunk?: any, enc?: any, cb?: any) {
        const callback = typeof chunk === 'function' ? chunk : typeof enc === 'function' ? enc : cb;
        if (chunk && typeof chunk !== 'function') {
          chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
        }
        const content = chunks.join('');
        fileCache.set(resolved, content);
        fileMtimes.set(resolved, Date.now());
        pendingPromises.push(ctx.fs.writeFile(resolved, content).then(() => {
          ws.emit('finish');
          ws.emit('close');
          if (callback) callback();
        }).catch((e: any) => ws.emit('error', e)));
      };
      return ws;
    },
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_TRUNC: 512, O_APPEND: 1024, O_NONBLOCK: 2048, S_IFMT: 61440, S_IFREG: 32768, S_IFDIR: 16384, S_IFLNK: 40960 },
    // Callback-style async fs methods (used by graceful-fs, fs-extra)
    readFile: (p: string, optsOrCb?: any, cb?: any) => {
      const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      // Check fileCache first — sync writes may have updated it
      const cached = fileCache.get(resolved);
      if (cached !== undefined) {
        // Use queueMicrotask for consistent async behavior
        queueMicrotask(() => callback?.(null, cached));
        return;
      }
      ctx.fs.readFile(resolved, 'utf8')
        .then((data: any) => callback?.(null, data))
        .catch((e: any) => callback?.(e));
    },
    writeFile: (p: string, data: any, optsOrCb?: any, cb?: any) => {
      const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      const strData = typeof data === 'string' ? data : new TextDecoder().decode(data);
      // Update fileCache so subsequent sync reads see the new data
      fileCache.set(resolved, strData);
      fileMtimes.set(resolved, Date.now());
      pendingPromises.push(ctx.fs.writeFile(resolved, strData).catch(() => {}));
      queueMicrotask(() => callback?.(null));
    },
    stat: (p: string, optsOrCb?: any, cb?: any) => {
      const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      // Check fileCache first (matches statSync behavior) — avoids IDB round-trip
      const isFile = fileCache.has(resolved) || ctx.fs.readCached(resolved) !== undefined;
      const isDir = fileCache.has(resolved + '/.') || [...fileCache.keys()].some(k => k.startsWith(resolved + '/')) || ctx.fs.readdirCached(resolved) !== undefined;
      if (isFile || isDir) {
        const mtime = new Date(fileMtimes.get(resolved) || Date.now());
        const size = isFile ? (fileCache.get(resolved) || '').length : 0;
        queueMicrotask(() => callback?.(null, {
          isFile: () => isFile && !isDir, isDirectory: () => isDir,
          isSymbolicLink: () => false, isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false,
          size, mtime, ctime: mtime, atime: mtime, birthtime: mtime,
          mtimeMs: mtime.getTime(), ctimeMs: mtime.getTime(), atimeMs: mtime.getTime(), birthtimeMs: mtime.getTime(),
          dev: 0, ino: 0, nlink: 1, uid: 1000, gid: 1000, rdev: 0, blksize: 4096, blocks: Math.ceil(size / 512),
          mode: (isDir) ? 0o40755 : 0o100644,
        }));
        return;
      }
      ctx.fs.stat(resolved)
        .then((s: any) => callback?.(null, s))
        .catch((e: any) => callback?.(e));
    },
    lstat: (p: string, optsOrCb?: any, cb?: any) => {
      const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      // Check fileCache first (same as stat — no real symlinks in Shiro)
      const isFile = fileCache.has(resolved) || ctx.fs.readCached(resolved) !== undefined;
      const isDir = fileCache.has(resolved + '/.') || [...fileCache.keys()].some(k => k.startsWith(resolved + '/')) || ctx.fs.readdirCached(resolved) !== undefined;
      if (isFile || isDir) {
        const mtime = new Date(fileMtimes.get(resolved) || Date.now());
        const size = isFile ? (fileCache.get(resolved) || '').length : 0;
        queueMicrotask(() => callback?.(null, {
          isFile: () => isFile && !isDir, isDirectory: () => isDir,
          isSymbolicLink: () => false, isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false,
          size, mtime, ctime: mtime, atime: mtime, birthtime: mtime,
          mtimeMs: mtime.getTime(), ctimeMs: mtime.getTime(), atimeMs: mtime.getTime(), birthtimeMs: mtime.getTime(),
          dev: 0, ino: 0, nlink: 1, uid: 1000, gid: 1000, rdev: 0, blksize: 4096, blocks: Math.ceil(size / 512),
          mode: (isDir) ? 0o40755 : 0o100644,
        }));
        return;
      }
      ctx.fs.stat(resolved)
        .then((s: any) => callback?.(null, s))
        .catch((e: any) => callback?.(e));
    },
    readdir: (p: string, optsOrCb?: any, cb?: any) => {
      const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
      const opts = typeof optsOrCb === 'object' ? optsOrCb : {};
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      // Check fileCache first (matches readdirSync behavior)
      const prefix = resolved === '/' ? '/' : resolved + '/';
      const cacheEntries = new Set<string>();
      const cacheDirSet = new Set<string>();
      for (const key of fileCache.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const first = rest.split('/')[0];
          if (first && first !== '.') {
            cacheEntries.add(first);
            if (rest.includes('/')) cacheDirSet.add(first);
          }
        }
      }
      // Also check Shiro FS cache
      const fsCachedEntries = ctx.fs.readdirCached(resolved);
      if (fsCachedEntries) {
        for (const e of fsCachedEntries) cacheEntries.add(e);
      }
      // Handle recursive option
      if (opts?.recursive) {
        const allEntries: string[] = [];
        const collectRecursive = (dir: string, rel: string) => {
          const dirPrefix = dir === '/' ? '/' : dir + '/';
          const immediateEntries = new Set<string>();
          const immediateDirs = new Set<string>();
          for (const key of fileCache.keys()) {
            if (key.startsWith(dirPrefix)) {
              const rest = key.slice(dirPrefix.length);
              const first = rest.split('/')[0];
              if (first && first !== '.') {
                immediateEntries.add(first);
                if (rest.includes('/')) immediateDirs.add(first);
              }
            }
          }
          const fsCachedR = ctx.fs.readdirCached(dir);
          if (fsCachedR) for (const e of fsCachedR) immediateEntries.add(e);
          for (const name of [...immediateEntries].sort()) {
            const entryRel = rel ? rel + '/' + name : name;
            allEntries.push(entryRel);
            if (immediateDirs.has(name)) {
              collectRecursive(dir + '/' + name, entryRel);
            }
          }
        };
        collectRecursive(resolved, '');
        queueMicrotask(() => callback?.(null, allEntries));
        return;
      }
      if (cacheEntries.size > 0) {
        const entries = [...cacheEntries].sort();
        if (opts?.withFileTypes) {
          const dirents = entries.map(name => {
            const childPath = resolved + '/' + name;
            const childIsDir = cacheDirSet.has(name) || fileCache.has(childPath + '/.') || ctx.fs.readdirCached(childPath) !== undefined;
            return { name, isFile: () => !childIsDir, isDirectory: () => childIsDir, isSymbolicLink: () => false, isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false };
          });
          queueMicrotask(() => callback?.(null, dirents));
        } else {
          queueMicrotask(() => callback?.(null, entries));
        }
        return;
      }
      ctx.fs.readdir(resolved)
        .then(async (entries: any) => {
          if (opts?.withFileTypes) {
            const dirents = [];
            for (const name of entries) {
              try {
                const st = await ctx.fs.stat(resolved + '/' + name);
                dirents.push({ name, isFile: () => st.isFile(), isDirectory: () => st.isDirectory(), isSymbolicLink: () => st.isSymbolicLink?.() || false, isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false });
              } catch { dirents.push({ name, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false }); }
            }
            callback?.(null, dirents);
          } else { callback?.(null, entries); }
        })
        .catch((e: any) => callback?.(e));
    },
    mkdir: (p: string, optsOrCb?: any, cb?: any) => {
      const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
      ctx.fs.mkdir(ctx.fs.resolvePath(p, ctx.cwd), typeof optsOrCb === 'object' ? optsOrCb : undefined)
        .then(() => callback?.(null))
        .catch((e: any) => callback?.(e));
    },
    unlink: (p: string, cb?: any) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      fileCache.delete(resolved);
      fileMtimes.delete(resolved);
      ctx.fs.unlink(resolved)
        .then(() => cb?.(null))
        .catch((e: any) => cb?.(e));
    },
    rmdir: (p: string, cb?: any) => {
      ctx.fs.unlink(ctx.fs.resolvePath(p, ctx.cwd))
        .then(() => cb?.(null))
        .catch((e: any) => cb?.(e));
    },
    rename: (oldP: string, newP: string, cb?: any) => {
      ctx.fs.rename(ctx.fs.resolvePath(oldP, ctx.cwd), ctx.fs.resolvePath(newP, ctx.cwd))
        .then(() => cb?.(null))
        .catch((e: any) => cb?.(e));
    },
    access: (p: string, modeOrCb?: any, cb?: any) => {
      const callback = typeof modeOrCb === 'function' ? modeOrCb : cb;
      ctx.fs.exists(ctx.fs.resolvePath(p, ctx.cwd))
        .then((exists: boolean) => exists ? callback?.(null) : callback?.(fsError('ENOENT', `ENOENT: no such file or directory, access '${p}'`, 'access', p)))
        .catch((e: any) => callback?.(e));
    },
    chmod: (_p: string, _m: any, cb?: any) => { cb?.(null); },
    chown: (_p: string, _u: any, _g: any, cb?: any) => { cb?.(null); },
    link: (src: string, dst: string, cb?: any) => {
      ctx.fs.symlink(ctx.fs.resolvePath(src, ctx.cwd), ctx.fs.resolvePath(dst, ctx.cwd))
        .then(() => cb?.(null))
        .catch((e: any) => cb?.(e));
    },
    symlink: (target: string, path: string, typeOrCb?: any, cb?: any) => {
      const callback = typeof typeOrCb === 'function' ? typeOrCb : cb;
      ctx.fs.symlink(ctx.fs.resolvePath(target, ctx.cwd), ctx.fs.resolvePath(path, ctx.cwd))
        .then(() => callback?.(null))
        .catch((e: any) => callback?.(e));
    },
    readlink: (p: string, optsOrCb?: any, cb?: any) => {
      const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
      callback?.(null, ctx.fs.resolvePath(p, ctx.cwd));
    },
    close: (_fd: number, cb?: any) => { cb?.(null); },
    open: (p: string, flags: any, modeOrCb?: any, cb?: any) => {
      const callback = typeof modeOrCb === 'function' ? modeOrCb : cb;
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      const fd = 100 + Math.floor(Math.random() * 9900);
      (globalThis as any).__shiroFds = (globalThis as any).__shiroFds || {};
      const f = typeof flags === 'string' ? flags : 'r';
      (globalThis as any).__shiroFds[fd] = { path: resolved, flags: f, offset: 0 };
      if (f.includes('w')) {
        fileCache.set(resolved, '');
        fileMtimes.set(resolved, Date.now());
      }
      callback?.(null, fd);
    },
    read: (fd: number, buf: any, off: number, len: number, pos: any, cb?: any) => {
      const fdInfo = (globalThis as any).__shiroFds?.[fd];
      if (!fdInfo) { cb?.(null, 0, buf); return; }
      const content = fileCache.get(fdInfo.path) || '';
      const bytes = new TextEncoder().encode(content);
      const p2 = pos ?? fdInfo.offset;
      const n = Math.min(len, bytes.length - p2);
      for (let i = 0; i < n; i++) buf[(off ?? 0) + i] = bytes[p2 + i];
      fdInfo.offset = p2 + n;
      cb?.(null, n, buf);
    },
    write: (fd: number, buf: any, off: number, len: number, pos: any, cb?: any) => {
      const fdInfo = (globalThis as any).__shiroFds?.[fd];
      if (fdInfo) {
        const existing = fileCache.get(fdInfo.path) || '';
        const str = typeof buf === 'string' ? buf : new TextDecoder().decode(buf instanceof Uint8Array ? buf.slice(off, off + len) : buf);
        const newContent = existing + str;
        fileCache.set(fdInfo.path, newContent);
        fileMtimes.set(fdInfo.path, Date.now());
        pendingPromises.push(ctx.fs.writeFile(fdInfo.path, newContent).catch(() => {}));
      }
      cb?.(null, len, buf);
    },
    copyFile: (src: string, dst: string, flagsOrCb?: any, cb?: any) => {
      const callback = typeof flagsOrCb === 'function' ? flagsOrCb : cb;
      ctx.fs.readFile(ctx.fs.resolvePath(src, ctx.cwd), 'utf8')
        .then((data: any) => ctx.fs.writeFile(ctx.fs.resolvePath(dst, ctx.cwd), data))
        .then(() => callback?.(null))
        .catch((e: any) => callback?.(e));
    },
    appendFile: (p: string, data: any, optsOrCb?: any, cb?: any) => {
      const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      ctx.fs.readFile(resolved, 'utf8').catch(() => '')
        .then((existing: any) => ctx.fs.writeFile(resolved, (existing || '') + data))
        .then(() => callback?.(null))
        .catch((e: any) => callback?.(e));
    },
    truncate: (p: string, lenOrCb?: any, cb?: any) => {
      const callback = typeof lenOrCb === 'function' ? lenOrCb : cb;
      ctx.fs.writeFile(ctx.fs.resolvePath(p, ctx.cwd), '')
        .then(() => callback?.(null))
        .catch((e: any) => callback?.(e));
    },
    utimes: (_p: string, _a: any, _m: any, cb?: any) => { cb?.(null); },
    futimes: (_fd: number, _a: any, _m: any, cb?: any) => { cb?.(null); },
    fstat: (_fd: number, cb?: any) => { cb?.(null, { isFile: () => true, isDirectory: () => false, size: 0, mtime: new Date() }); },
    fsync: (_fd: number, cb?: any) => { cb?.(null); },
    fdatasync: (_fd: number, cb?: any) => { cb?.(null); },
    fchmod: (_fd: number, _m: any, cb?: any) => { cb?.(null); },
    fchown: (_fd: number, _u: any, _g: any, cb?: any) => { cb?.(null); },
    ftruncate: (fd: number, lenOrCb?: any, cb?: any) => {
      const callback = typeof lenOrCb === 'function' ? lenOrCb : cb;
      const fdInfo = (globalThis as any).__shiroFds?.[fd];
      if (fdInfo) {
        const len = typeof lenOrCb === 'number' ? lenOrCb : 0;
        const existing = fileCache.get(fdInfo.path) || '';
        const truncated = existing.slice(0, len);
        fileCache.set(fdInfo.path, truncated);
        pendingPromises.push(ctx.fs.writeFile(fdInfo.path, truncated).catch(() => {}));
      }
      callback?.(null);
    },
    lchmod: (_p: string, _m: any, cb?: any) => { cb?.(null); },
    lchown: (_p: string, _u: any, _g: any, cb?: any) => { cb?.(null); },
    mkdtemp: (prefix: string, optsOrCb?: any, cb?: any) => {
      const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
      const dir = `${prefix}${Math.random().toString(36).slice(2)}`;
      ctx.fs.mkdir(dir, { recursive: true }).then(() => callback?.(null, dir)).catch((e: any) => callback?.(e));
    },
    rm: (p: string, optsOrCb?: any, cb?: any) => {
      const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
      ctx.fs.unlink(ctx.fs.resolvePath(p, ctx.cwd))
        .then(() => callback?.(null))
        .catch((e: any) => callback?.(e));
    },
    opendir: (p: string, optsOrCb?: any, cb?: any) => {
      const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
      callback?.(null, { read: (readCb: any) => { readCb(null, null); }, close: (closeCb: any) => { closeCb?.(null); } });
    },
    exists: (p: string, cb?: any) => {
      ctx.fs.exists(ctx.fs.resolvePath(p, ctx.cwd))
        .then((exists: boolean) => cb?.(exists))
        .catch(() => cb?.(false));
    },
    watch: (filename: string, options?: any, listener?: Function) => {
      // Return a stub FSWatcher
      const watcher: any = {
        close() {},
        on(_event: string, _fn: Function) { return watcher; },
        once(_event: string, _fn: Function) { return watcher; },
        off(_event: string, _fn: Function) { return watcher; },
        ref() { return watcher; },
        unref() { return watcher; },
      };
      return watcher;
    },
    watchFile: (filename: string, options?: any, listener?: Function) => {
      // No-op — real watching is not supported in browser environment
      if (typeof options === 'function') listener = options;
    },
    unwatchFile: (filename: string, listener?: Function) => {
      // No-op
    },
    // Async promises API
    promises: {
      readFile: async (p: string, opts?: any) => {
        const resolved = ctx.fs.resolvePath(p, ctx.cwd);
        const encoding = typeof opts === 'string' ? opts : opts?.encoding;
        // Check fileCache first (may have data from writeFileSync not yet flushed)
        const cached = fileCache.get(resolved);
        if (cached !== undefined) {
          if (encoding === 'utf8' || encoding === 'utf-8') return cached;
          return FakeBuffer.from(cached);
        }
        return await ctx.fs.readFile(resolved, encoding || 'utf8');
      },
      writeFile: async (p: string, data: any) => {
        const resolved = ctx.fs.resolvePath(p, ctx.cwd);
        const content = typeof data === 'string' ? data : new TextDecoder().decode(data);
        fileCache.set(resolved, content); // Keep fileCache in sync for readFileSync/renameSync
        fileMtimes.set(resolved, Date.now());
        await ctx.fs.writeFile(resolved, content);
      },
      readdir: async (p: string, opts?: any) => {
        const resolved = ctx.fs.resolvePath(p, ctx.cwd);
        // Merge fileCache + Shiro FS cache + IDB entries
        const prefix = resolved === '/' ? '/' : resolved + '/';
        const cacheEntries = new Set<string>();
        const cacheDirSet = new Set<string>();
        for (const key of fileCache.keys()) {
          if (key.startsWith(prefix)) {
            const rest = key.slice(prefix.length);
            const first = rest.split('/')[0];
            if (first && first !== '.') { cacheEntries.add(first); if (rest.includes('/')) cacheDirSet.add(first); }
          }
        }
        const fsCached = ctx.fs.readdirCached(resolved);
        if (fsCached) for (const e of fsCached) cacheEntries.add(e);
        try { const idb = await ctx.fs.readdir(resolved); for (const e of idb) cacheEntries.add(e); } catch {}
        // Handle recursive option
        if (opts?.recursive) {
          const allEntries: string[] = [];
          const collectRecursive = (dir: string, rel: string) => {
            const dirPrefix = dir === '/' ? '/' : dir + '/';
            const immediateEntries = new Set<string>();
            const immediateDirs = new Set<string>();
            for (const key of fileCache.keys()) {
              if (key.startsWith(dirPrefix)) {
                const rest = key.slice(dirPrefix.length);
                const first = rest.split('/')[0];
                if (first && first !== '.') {
                  immediateEntries.add(first);
                  if (rest.includes('/')) immediateDirs.add(first);
                }
              }
            }
            const fsCachedR = ctx.fs.readdirCached(dir);
            if (fsCachedR) for (const e of fsCachedR) immediateEntries.add(e);
            for (const name of [...immediateEntries].sort()) {
              const entryRel = rel ? rel + '/' + name : name;
              allEntries.push(entryRel);
              if (immediateDirs.has(name)) {
                collectRecursive(dir + '/' + name, entryRel);
              }
            }
          };
          collectRecursive(resolved, '');
          return allEntries;
        }
        const entries = [...cacheEntries].sort();
        if (opts?.withFileTypes) {
          return entries.map(name => {
            const childPath = resolved + '/' + name;
            const childIsDir = cacheDirSet.has(name) || fileCache.has(childPath + '/.') || [...fileCache.keys()].some(k => k.startsWith(childPath + '/')) || ctx.fs.readdirCached(childPath) !== undefined;
            return { name, isFile: () => !childIsDir, isDirectory: () => childIsDir, isSymbolicLink: () => false, isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false };
          });
        }
        return entries;
      },
      stat: async (p: string) => {
        const resolved = ctx.fs.resolvePath(p, ctx.cwd);
        const isFile = fileCache.has(resolved) || ctx.fs.readCached(resolved) !== undefined;
        const isDir = fileCache.has(resolved + '/.') || [...fileCache.keys()].some(k => k.startsWith(resolved + '/')) || ctx.fs.readdirCached(resolved) !== undefined;
        if (isFile || isDir) {
          const mtime = new Date(fileMtimes.get(resolved) || Date.now());
          const size = isFile ? (fileCache.get(resolved) || '').length : 0;
          return { isFile: () => isFile && !isDir, isDirectory: () => isDir, isSymbolicLink: () => false, isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false, size, mtime, ctime: mtime, atime: mtime, birthtime: mtime, mtimeMs: mtime.getTime(), ctimeMs: mtime.getTime(), atimeMs: mtime.getTime(), birthtimeMs: mtime.getTime(), dev: 0, ino: 0, nlink: 1, uid: 1000, gid: 1000, rdev: 0, blksize: 4096, blocks: Math.ceil(size / 512), mode: isDir ? 0o40755 : 0o100644 };
        }
        return ctx.fs.stat(resolved);
      },
      mkdir: async (p: string, opts?: any) => ctx.fs.mkdir(ctx.fs.resolvePath(p, ctx.cwd), opts),
      unlink: async (p: string) => { const r = ctx.fs.resolvePath(p, ctx.cwd); fileCache.delete(r); fileMtimes.delete(r); return ctx.fs.unlink(r); },
      access: async (p: string) => {
        const resolved = ctx.fs.resolvePath(p, ctx.cwd);
        if (fileCache.has(resolved) || fileCache.has(resolved + '/.') || [...fileCache.keys()].some(k => k.startsWith(resolved + '/')) || ctx.fs.readCached(resolved) !== undefined || ctx.fs.readdirCached(resolved) !== undefined) return;
        const exists = await ctx.fs.exists(resolved);
        if (!exists) throw fsError('ENOENT', `ENOENT: no such file or directory, access '${p}'`, 'access', p);
      },
    },
  };
  // realpath and realpath.native need special handling (function with properties)
  const realpathFn: any = (p: string, optsOrCb?: any, cb?: any) => {
    const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
    const resolved = ctx.fs.resolvePath(p, ctx.cwd);
    callback?.(null, resolved);
  };
  realpathFn.native = (p: string, optsOrCb?: any, cb?: any) => {
    const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
    const resolved = ctx.fs.resolvePath(p, ctx.cwd);
    callback?.(null, resolved);
  };
  fsShim.realpath = realpathFn;
  // Also add realpathSync.native
  const origRealpathSync = fsShim.realpathSync;
  origRealpathSync.native = origRealpathSync;
  return fsShim;
}

export function createFsPromisesModule(deps: FsDeps): any {
  const { ctx, fileCache, fileMtimes, FakeBuffer, homeDir } = deps;

  // Async fs promises API
  return {
    readFile: async (p: string, opts?: any) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      // Check fileCache first (may have data from writeFileSync not yet flushed)
      const cached = fileCache.get(resolved);
      const encoding = typeof opts === 'string' ? opts : opts?.encoding;
      if (cached !== undefined) {
        if (encoding === 'utf8' || encoding === 'utf-8') return cached;
        return FakeBuffer.from(cached);
      }
      const data = await ctx.fs.readFile(resolved);
      if (encoding === 'utf8' || encoding === 'utf-8') {
        return typeof data === 'string' ? data : new TextDecoder().decode(data);
      }
      return typeof data === 'string' ? FakeBuffer.from(data) : FakeBuffer.from(data);
    },
    writeFile: async (p: string, data: any) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      const content = typeof data === 'string' ? data : new TextDecoder().decode(data);
      fileCache.set(resolved, content); // Keep fileCache in sync for readFileSync
      await ctx.fs.writeFile(resolved, content);
      // localStorage WAL for critical config files
      if (resolved.startsWith(homeDir + '/.claude') || resolved === homeDir + '/.claude.json') {
        try { localStorage.setItem('wal:' + resolved, content); } catch {}
      }
    },
    readdir: async (p: string, opts?: any) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      // Check fileCache first (matches readdirSync)
      const prefix = resolved === '/' ? '/' : resolved + '/';
      const cacheEntries = new Set<string>();
      const cacheDirSet = new Set<string>();
      for (const key of fileCache.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const first = rest.split('/')[0];
          if (first && first !== '.') {
            cacheEntries.add(first);
            if (rest.includes('/')) cacheDirSet.add(first);
          }
        }
      }
      const fsCachedEntries = ctx.fs.readdirCached(resolved);
      if (fsCachedEntries) for (const e of fsCachedEntries) cacheEntries.add(e);
      // Also merge IDB entries
      try {
        const idbEntries = await ctx.fs.readdir(resolved);
        for (const e of idbEntries) cacheEntries.add(e);
      } catch {}
      // Handle recursive option
      if (opts?.recursive) {
        const allEntries: string[] = [];
        const collectRecursive = (dir: string, rel: string) => {
          const dirPrefix = dir === '/' ? '/' : dir + '/';
          const immediateEntries = new Set<string>();
          const immediateDirs = new Set<string>();
          for (const key of fileCache.keys()) {
            if (key.startsWith(dirPrefix)) {
              const rest = key.slice(dirPrefix.length);
              const first = rest.split('/')[0];
              if (first && first !== '.') {
                immediateEntries.add(first);
                if (rest.includes('/')) immediateDirs.add(first);
              }
            }
          }
          const fsCachedR = ctx.fs.readdirCached(dir);
          if (fsCachedR) for (const e of fsCachedR) immediateEntries.add(e);
          for (const name of [...immediateEntries].sort()) {
            const entryRel = rel ? rel + '/' + name : name;
            allEntries.push(entryRel);
            if (immediateDirs.has(name)) {
              collectRecursive(dir + '/' + name, entryRel);
            }
          }
        };
        collectRecursive(resolved, '');
        return allEntries;
      }
      const entries = [...cacheEntries].sort();
      if (opts?.withFileTypes) {
        const dirents = entries.map(name => {
          const childPath = resolved + '/' + name;
          const childIsDir = cacheDirSet.has(name) || fileCache.has(childPath + '/.') || [...fileCache.keys()].some(k => k.startsWith(childPath + '/')) || ctx.fs.readdirCached(childPath) !== undefined;
          return { name, isFile: () => !childIsDir, isDirectory: () => childIsDir, isSymbolicLink: () => false, isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false, parentPath: resolved, path: resolved };
        });
        return dirents;
      }
      return entries;
    },
    stat: async (p: string) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      // Check fileCache first (matches statSync behavior)
      const isFile = fileCache.has(resolved) || ctx.fs.readCached(resolved) !== undefined;
      const isDir = fileCache.has(resolved + '/.') || [...fileCache.keys()].some(k => k.startsWith(resolved + '/')) || ctx.fs.readdirCached(resolved) !== undefined;
      if (isFile || isDir) {
        const mtime = new Date(fileMtimes.get(resolved) || Date.now());
        const size = isFile ? (fileCache.get(resolved) || '').length : 0;
        return {
          isFile: () => isFile && !isDir, isDirectory: () => isDir,
          isSymbolicLink: () => false, isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false,
          size, mtime, ctime: mtime, atime: mtime, birthtime: mtime,
          mtimeMs: mtime.getTime(), ctimeMs: mtime.getTime(), atimeMs: mtime.getTime(), birthtimeMs: mtime.getTime(),
          dev: 0, ino: 0, nlink: 1, uid: 1000, gid: 1000, rdev: 0, blksize: 4096, blocks: Math.ceil(size / 512),
          mode: isDir ? 0o40755 : 0o100644,
        };
      }
      return await ctx.fs.stat(resolved);
    },
    mkdir: async (p: string, opts?: any) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      await ctx.fs.mkdir(resolved, opts);
    },
    unlink: async (p: string) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      fileCache.delete(resolved);
      fileMtimes.delete(resolved);
      await ctx.fs.unlink(resolved);
    },
    rm: async (p: string, opts?: any) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      fileCache.delete(resolved);
      fileMtimes.delete(resolved);
      await ctx.fs.unlink(resolved);
    },
    access: async (p: string) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      // Check fileCache/dirs before going to IDB
      if (fileCache.has(resolved) || fileCache.has(resolved + '/.') || [...fileCache.keys()].some(k => k.startsWith(resolved + '/')) || ctx.fs.readCached(resolved) !== undefined || ctx.fs.readdirCached(resolved) !== undefined) return;
      const exists = await ctx.fs.exists(resolved);
      if (!exists) throw fsError('ENOENT', `ENOENT: no such file or directory, access '${p}'`, 'access', p);
    },
    lstat: async (p: string) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      // Check fileCache first (same as stat)
      const isFile = fileCache.has(resolved) || ctx.fs.readCached(resolved) !== undefined;
      const isDir = fileCache.has(resolved + '/.') || [...fileCache.keys()].some(k => k.startsWith(resolved + '/')) || ctx.fs.readdirCached(resolved) !== undefined;
      if (isFile || isDir) {
        const mtime = new Date(fileMtimes.get(resolved) || Date.now());
        const size = isFile ? (fileCache.get(resolved) || '').length : 0;
        return {
          isFile: () => isFile && !isDir, isDirectory: () => isDir,
          isSymbolicLink: () => false, isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false,
          size, mtime, ctime: mtime, atime: mtime, birthtime: mtime,
          mtimeMs: mtime.getTime(), ctimeMs: mtime.getTime(), atimeMs: mtime.getTime(), birthtimeMs: mtime.getTime(),
          dev: 0, ino: 0, nlink: 1, uid: 1000, gid: 1000, rdev: 0, blksize: 4096, blocks: Math.ceil(size / 512),
          mode: isDir ? 0o40755 : 0o100644,
        };
      }
      return await ctx.fs.stat(resolved);
    },
    chmod: async () => {},
    rename: async (oldP: string, newP: string) => {
      const oldRes = ctx.fs.resolvePath(oldP, ctx.cwd);
      const newRes = ctx.fs.resolvePath(newP, ctx.cwd);
      // Update fileCache so subsequent sync reads see the moved content
      const content = fileCache.get(oldRes);
      if (content !== undefined) {
        fileCache.set(newRes, content);
        fileCache.delete(oldRes);
        fileMtimes.set(newRes, Date.now());
        fileMtimes.delete(oldRes);
      }
      await ctx.fs.rename(oldRes, newRes);
    },
    copyFile: async (src: string, dst: string) => {
      const data = await ctx.fs.readFile(ctx.fs.resolvePath(src, ctx.cwd));
      const content = typeof data === 'string' ? data : new TextDecoder().decode(data);
      await ctx.fs.writeFile(ctx.fs.resolvePath(dst, ctx.cwd), content);
    },
    appendFile: async (p: string, data: any) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      let existing = '';
      try { const d = await ctx.fs.readFile(resolved); existing = typeof d === 'string' ? d : new TextDecoder().decode(d); } catch {}
      const append = typeof data === 'string' ? data : new TextDecoder().decode(data);
      await ctx.fs.writeFile(resolved, existing + append);
    },
    symlink: async (target: string, path: string) => {
      await ctx.fs.symlink(ctx.fs.resolvePath(target, ctx.cwd), ctx.fs.resolvePath(path, ctx.cwd));
    },
    readlink: async (p: string) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      return await ctx.fs.readlink(resolved);
    },
    realpath: async (p: string) => {
      return ctx.fs.resolvePath(p, ctx.cwd);
    },
    rmdir: async (p: string) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      await ctx.fs.unlink(resolved);
    },
    utimes: async () => {},
    mkdtemp: async (prefix: string) => {
      const dir = `${prefix}${Math.random().toString(36).slice(2)}`;
      await ctx.fs.mkdir(dir, { recursive: true });
      return dir;
    },
    open: async (p: string, _flags?: any) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      return {
        fd: 0,
        readFile: async (opts?: any) => {
          const encoding = typeof opts === 'string' ? opts : opts?.encoding;
          // Check fileCache first (consistent with readFileSync)
          const cached = fileCache.get(resolved);
          if (cached !== undefined) {
            if (!encoding || encoding === 'utf8' || encoding === 'utf-8') return cached;
            return FakeBuffer.from(cached);
          }
          return ctx.fs.readFile(resolved, encoding || 'utf8');
        },
        writeFile: async (data: any) => {
          const content = typeof data === 'string' ? data : new TextDecoder().decode(data);
          fileCache.set(resolved, content); // Keep fileCache in sync for readFileSync/renameSync
          await ctx.fs.writeFile(resolved, content);
        },
        close: async () => {},
        stat: async () => ctx.fs.stat(resolved),
        chmod: async () => {},
      };
    },
    watch: async function*(_p: string, _opts?: any) { /* no-op async generator */ },
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_TRUNC: 512, O_APPEND: 1024, O_NONBLOCK: 2048, S_IFMT: 61440, S_IFREG: 32768, S_IFDIR: 16384, S_IFLNK: 40960 },
  };
}
