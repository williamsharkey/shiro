import type { CommandContext } from '../../commands/index';
import { decodeUtf8Strict } from '../preload';

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

/**
 * A path's mtime as stat reports it. Paths the shim hasn't seen written
 * (directories, files from shell commands) get the time of their first stat,
 * kept, so stat agrees with itself: proper-lockfile (Gemini CLI) compares a
 * lock directory's mtime across stats and took a changing one as a
 * compromised lock.
 */
export function stableMtime(fileMtimes: Map<string, number>, path: string): number {
  let t = fileMtimes.get(path);
  if (!t) { t = Date.now(); fileMtimes.set(path, t); }
  return t;
}

/** fs time arguments (seconds, Date, numeric string) as milliseconds. */
function timeMs(t: any): number {
  if (t instanceof Date) return t.getTime();
  if (typeof t === 'string' && t.trim() !== '' && !isNaN(Number(t))) return Number(t) * 1000;
  if (typeof t === 'number' || typeof t === 'bigint') return Number(t) * 1000;
  return Date.now();
}

/**
 * Per-process write bookkeeping, shared by fs and fs/promises (keyed by the
 * process's pendingPromises array): per-path write chains, and every write
 * still in flight. The drain loop empties pendingPromises as it awaits it, so
 * that array alone can't tell a rename what hasn't landed yet.
 */
interface WriteState { chains: Map<string, Promise<void>>; inflight: Set<Promise<any>>; push: (p: Promise<any>) => number; gone: Set<string> }
const writeStates = new WeakMap<Promise<any>[], WriteState>();
function writeStateFor(pending: Promise<any>[]): WriteState {
  let st = writeStates.get(pending);
  if (!st) {
    const inflight = new Set<Promise<any>>();
    st = {
      chains: new Map(),
      gone: new Set(),
      inflight,
      push: (p: Promise<any>) => {
        inflight.add(p);
        p.then(() => inflight.delete(p), () => inflight.delete(p));
        return pending.push(p);
      },
    };
    writeStates.set(pending, st);
  }
  return st;
}

/**
 * Rename once the writes in flight have landed (write-file-atomic writes
 * through an fd, then renames at once; pnpm fills a staging directory, then
 * renames it into place). Renaming first moved a half-written or missing tree
 * and left the temp file behind.
 */
async function renameAfterWrites(deps: FsDeps, oldRes: string, newRes: string): Promise<void> {
  const st = writeStateFor(deps.pendingPromises);
  await Promise.allSettled([...st.inflight]);
  const { fileCache, fileMtimes, ctx } = deps;
  moveCachedTree(fileCache, fileMtimes, oldRes, newRes);
  const op = ctx.fs.rename(oldRes, newRes);
  const done = op.then(() => {}, () => {});
  st.chains.set(newRes, done);
  st.chains.set(oldRes, done);
  st.push(done);
  await op;
}

/**
 * Whether the filesystem's own cache holds a directory there, for the shims'
 * fallbacks. A directory renameSync moved away is gone already, though the
 * stored rename waits for the writes into it.
 */
function dirCachedChecker(deps: FsDeps): (p: string) => boolean {
  const { gone } = writeStateFor(deps.pendingPromises);
  return (p: string) => {
    for (const g of gone) if (p === g || p.startsWith(g + '/')) return false;
    return !!(deps.ctx.fs.isDirCached?.(p) || deps.ctx.fs.readdirCached(p) !== undefined);
  };
}

/** Move a path and everything under it in the text cache. */
function moveCachedTree(fileCache: Map<string, string>, fileMtimes: Map<string, number>, oldRes: string, newRes: string): boolean {
  const prefix = oldRes + '/';
  let moved = false;
  for (const k of [...fileCache.keys()]) {
    if (k !== oldRes && !k.startsWith(prefix)) continue;
    const nk = newRes + k.slice(oldRes.length);
    fileCache.set(nk, fileCache.get(k)!);
    fileCache.delete(k);
    const m = fileMtimes.get(k);
    fileMtimes.delete(k);
    fileMtimes.set(nk, k === oldRes ? Date.now() : m ?? Date.now());
    moved = true;
  }
  return moved;
}

/**
 * A readdir withFileTypes entry. Symlinks are reported as such (lstat
 * semantics, as in node): pnpm's node_modules/x links read as plain files, so
 * it skipped them when linking node_modules/.bin.
 */
function makeDirent(ctx: CommandContext, parent: string, name: string, isDir: boolean): any {
  const link = typeof ctx.fs.readlinkCached === 'function' ? ctx.fs.readlinkCached(parent + '/' + name) : undefined;
  const isLink = typeof link === 'string';
  return {
    name, parentPath: parent, path: parent,
    isFile: () => !isLink && !isDir,
    isDirectory: () => !isLink && isDir,
    isSymbolicLink: () => isLink,
    isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false,
  };
}

/**
 * realpath: symlinks followed, ENOENT for a missing path (it answered every
 * path as itself). Files this script wrote whose writes are still in flight
 * count as there.
 */
async function realpathAsync(deps: FsDeps, p: string): Promise<string> {
  const { ctx, fileCache } = deps;
  const resolved = ctx.fs.resolvePath(String(p), ctx.cwd);
  try {
    const real = await ctx.fs.realpath(resolved);
    if (await ctx.fs.exists(real)) return real;
  } catch { /* below */ }
  {
    if (fileCache.has(resolved) || fileCache.has(resolved + '/.') || [...fileCache.keys()].some((k) => k.startsWith(resolved + '/'))) {
      return ctx.fs.realpathCached?.(resolved) ?? resolved;
    }
    throw fsError('ENOENT', `ENOENT: no such file or directory, realpath '${p}'`, 'realpath', String(p));
  }
}

/** chmod once the writes in flight have landed (the file may not be stored yet). */
async function chmodAfterWrites(deps: FsDeps, resolved: string, mode: any): Promise<void> {
  await Promise.allSettled([...writeStateFor(deps.pendingPromises).inflight]);
  try {
    await deps.ctx.fs.chmod(resolved, parseMode(mode));
  } catch (e) {
    if (!deps.fileCache.has(resolved)) throw e;
  }
}

/** A mode as a number ('755' and 0o755 alike). */
function parseMode(mode: any): number {
  return typeof mode === 'string' ? parseInt(mode, 8) : Number(mode) & 0o7777;
}

function createRemovalHelpers(
  ctx: CommandContext,
  fileCache: Map<string, string>,
  fileMtimes: Map<string, number>,
) {
  const isProtectedRecentTaskOutput = (path: string, now = Date.now()) => {
    const mtime = fileMtimes.get(path);
    return !!(
      mtime &&
      (now - mtime) < 30000 &&
      path.includes('/tasks/') &&
      path.includes('.output')
    );
  };

  const removePathFromCaches = (resolved: string, recursive = false) => {
    const now = Date.now();
    if (recursive) {
      const prefix = resolved.endsWith('/') ? resolved : resolved + '/';
      for (const key of [...fileCache.keys()]) {
        if (key !== resolved && !key.startsWith(prefix)) continue;
        if (isProtectedRecentTaskOutput(key, now)) continue;
        fileCache.delete(key);
        fileMtimes.delete(key);
        ctx.fs.unlinkNow(key).catch(() => {});
      }
      return;
    }
    if (isProtectedRecentTaskOutput(resolved, now)) return;
    fileCache.delete(resolved);
    fileMtimes.delete(resolved);
    ctx.fs.unlinkNow(resolved).catch(() => {});
  };

  // ── Binary data ────────────────────────────────────────────────────
  // fileCache holds text. Bytes that aren't valid UTF-8 (FLAC, PNG, wasm) would
  // come back as U+FFFD, so they skip it and live in the filesystem's own byte
  // cache, which writeNow updates synchronously for immediate readback.
  const toBytes = (data: any): Uint8Array | null => {
    if (typeof data === 'string') return null;
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
  };
  /** Current bytes of a file as synchronous code sees them (text cache first, then byte cache). */
  const currentBytes = (resolved: string): Uint8Array | undefined => {
    const text = fileCache.get(resolved);
    if (text !== undefined) return new TextEncoder().encode(text);
    return ctx.fs.readBytesCached(resolved);
  };
  /**
   * Store data written by a script. Text (or bytes that are valid UTF-8) goes to
   * the text cache and returns the string for the caller's usual path; binary
   * is written through the byte cache and returns null.
   */
  const storeData = (resolved: string, data: any, pending?: { push: (p: Promise<any>) => unknown }): string | null => {
    const bytes = toBytes(data);
    if (!bytes) return typeof data === 'string' ? data : String(data);
    const text = decodeUtf8Strict(bytes);
    if (text !== null) return text;
    fileCache.delete(resolved);
    fileMtimes.set(resolved, Date.now());
    const p = ctx.fs.writeNow(resolved, bytes).catch(() => {});
    pending?.push(p);
    return null;
  };
  const concatBytes = (a: Uint8Array | undefined, b: Uint8Array): Uint8Array => {
    if (!a || !a.length) return b;
    const out = new Uint8Array(a.length + b.length);
    out.set(a); out.set(b, a.length);
    return out;
  };

  return { isProtectedRecentTaskOutput, removePathFromCaches, toBytes, currentBytes, storeData, concatBytes };
}

export function createFsModule(deps: FsDeps): any {
  const { ctx, fileCache, fileMtimes, pendingPromises, tickSyncOps, FakeBuffer, getBuiltinModule, homeDir } = deps;
  const { removePathFromCaches, toBytes, currentBytes, storeData, concatBytes } = createRemovalHelpers(ctx, fileCache, fileMtimes);

  // Writes to one path through fds land in order (openSync's truncate used to
  // finish after the first writeSync and empty the file: tsc's output)
  const writeState = writeStateFor(pendingPromises);
  const fsDirCached = dirCachedChecker(deps);
  const writeChains = writeState.chains;
  const inflight = { push: writeState.push };
  const queueWrite = (path: string, op: () => Promise<unknown>): Promise<void> => {
    const next = (writeChains.get(path) ?? Promise.resolve()).then(op).then(() => {}, () => {});
    writeChains.set(path, next);
    inflight.push(next);
    return next;
  };
  const materializeOpenFile = (resolved: string) => {
    const content = fileCache.get(resolved) || '';
    const parentDir = resolved.substring(0, resolved.lastIndexOf('/')) || '/';
    queueWrite(resolved, async () => {
      await ctx.fs.mkdir(parentDir, { recursive: true }).catch(() => {});
      await ctx.fs.writeFile(resolved, content);
    });
  };

  // Synchronous shims that use cached data or throw
  const fsShim: any = {
    readFileSync: (p: string, opts?: any) => {
      tickSyncOps();
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      let cached = fileCache.get(resolved) ?? fileCache.get(resolved + '.js');
      // Fallback: check Shiro's FS in-memory cache for files created by
      // shell commands (git clone, echo, sed) that bypass nodeCmd's fileCache
      const encoding = typeof opts === 'string' ? opts : opts?.encoding;
      if (cached === undefined) {
        const bytes = ctx.fs.readBytesCached(resolved);
        if (bytes !== undefined) {
          const text = decodeUtf8Strict(bytes);
          if (text === null) {
            // Binary: hand back the real bytes and keep it out of the text cache
            if (!encoding) return FakeBuffer.from(bytes);
            return new TextDecoder().decode(bytes);
          }
          cached = text;
          fileCache.set(resolved, cached); // promote to fileCache
        } else {
          cached = ctx.fs.readCached(resolved + '.js');
          if (cached !== undefined) fileCache.set(resolved, cached);
        }
      }
      if (cached === undefined) {
          throw fsError('ENOENT', `ENOENT: no such file or directory, open '${p}'`, 'open', p);
      }
      if (encoding === 'utf8' || encoding === 'utf-8' || encoding === 'utf8') return cached;
      if (!encoding) return FakeBuffer.from(cached);
      return cached;
    },
    writeFileSync: (p: string | number, data: string | Uint8Array) => {
      tickSyncOps();
      if (typeof p === 'number') { fsShim.writeSync(p, data); return; }
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      const strData = storeData(resolved, data, inflight);
      if (strData === null) return; // binary: written through the byte cache
      fileCache.set(resolved, strData);
      fileMtimes.set(resolved, Date.now());
      // Skip IDB write for .tmp files — they're transient atomic-write intermediaries.
      // The data reaches IDB via renameSync which writes to the final path.
      if (!resolved.includes('.tmp.')) {
        inflight.push(ctx.fs.writeFile(resolved, strData).catch(() => {}));
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
      if (fsDirCached(resolved)) return true;
      return false;
    },
    statSync: (p: string, opts?: any) => {
      tickSyncOps();
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      let isFile = fileCache.has(resolved);
      // Fallback: check Shiro FS cache for files created by shell commands
      const cachedBytes = isFile ? undefined : ctx.fs.readBytesCached(resolved);
      if (cachedBytes !== undefined) {
        isFile = true;
        const text = decodeUtf8Strict(cachedBytes);
        if (text !== null) fileCache.set(resolved, text); // promote text only; binary stays as bytes
      }
      let isDir = fileCache.has(resolved + '/.') || [...fileCache.keys()].some(k => k.startsWith(resolved + '/'));
      // Fallback: check Shiro FS cache for directories
      if (!isDir && fsDirCached(resolved)) {
        isDir = true;
      }
      if (!isFile && !isDir) {
        if (opts?.throwIfNoEntry === false) return undefined;
        throw fsError('ENOENT', `ENOENT: no such file or directory, stat '${p}'`, 'stat', p);
      }
      const mtime = new Date(stableMtime(fileMtimes, resolved));
      const size = isFile ? (currentBytes(resolved)?.length ?? 0) : 0; // bytes, not UTF-16 units
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
          if (first && first !== '.') {
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
            if (fsDirCached(childPath)) {
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
        return sorted.map(name => makeDirent(ctx, resolved, name, dirSet.has(name)));
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
      // The directory exists for the filesystem now when its parent is in memory
      // (a write right after it found no parent and was dropped)
      inflight.push((ctx.fs.mkdirNow ? ctx.fs.mkdirNow(resolved, opts) : ctx.fs.mkdir(resolved, opts)).catch(() => {}));
    },
    unlinkSync: (p: string) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      fileCache.delete(resolved);
      fileMtimes.delete(resolved);
      // readdirSync/existsSync also consult the filesystem's cache; drop it there now,
      // not when the async delete lands, or the file keeps being listed
      inflight.push(ctx.fs.unlinkNow(resolved).catch(() => {}));
    },
    // No hard links in Shiro's filesystem: link() copies, which is what callers
    // (atomic-write helpers, lockfiles) need from it
    linkSync: (src: string, dst: string) => {
      const resolvedDst = ctx.fs.resolvePath(dst, ctx.cwd);
      if (fileCache.has(resolvedDst) || ctx.fs.readBytesCached(resolvedDst) !== undefined) {
        const err: any = new Error(`EEXIST: file already exists, link '${src}' -> '${dst}'`);
        err.code = 'EEXIST'; err.errno = -17; err.syscall = 'link';
        throw err;
      }
      fsShim.copyFileSync(src, dst);
    },
    copyFileSync: (src: string, dst: string) => {
      const srcRes = ctx.fs.resolvePath(src, ctx.cwd);
      const dstRes = ctx.fs.resolvePath(dst, ctx.cwd);
      const cached = fileCache.get(srcRes);
      if (cached !== undefined) {
        fileCache.set(dstRes, cached);
        fileMtimes.set(dstRes, Date.now());
        queueWrite(dstRes, () => ctx.fs.writeFile(dstRes, cached));
        return;
      }
      const bytes = ctx.fs.readBytesCached(srcRes);
      if (bytes) {
        if (storeData(dstRes, bytes, inflight) === null) return; // binary: written through the byte cache
        const text = decodeUtf8Strict(bytes)!;
        fileCache.set(dstRes, text);
        fileMtimes.set(dstRes, Date.now());
        queueWrite(dstRes, () => ctx.fs.writeFile(dstRes, text));
        return;
      }
      // Not in memory: copy the bytes once the writes in flight (the source's
      // among them) have landed
      const waitFor = [...writeState.inflight];
      queueWrite(dstRes, () => Promise.allSettled(waitFor).then(() => ctx.fs.readFile(srcRes)).then((data: any) => ctx.fs.writeFile(dstRes, data)));
    },
    renameSync: (oldP: string, newP: string) => {
      const oldRes = ctx.fs.resolvePath(oldP, ctx.cwd);
      const newRes = ctx.fs.resolvePath(newP, ctx.cwd);
      // A directory (pnpm stages a package in name_tmp_PID, then renames it):
      // move the cached tree now, and the stored one once the writes into it
      // have landed (renaming first moved a half-written or missing tree)
      if (fsDirCached(oldRes) || [...fileCache.keys()].some((k) => k.startsWith(oldRes + '/'))) {
        moveCachedTree(fileCache, fileMtimes, oldRes, newRes); // sync readers see the move now
        writeState.gone.add(oldRes);
        inflight.push(renameAfterWrites(deps, oldRes, newRes).catch(() => {}).finally(() => writeState.gone.delete(oldRes)));
        return;
      }
      // Update fileCache: move content from old path to new path
      const content = fileCache.get(oldRes);
      if (content !== undefined) {
        fileCache.set(newRes, content);
        fileCache.delete(oldRes);
        fileMtimes.set(newRes, Date.now());
        fileMtimes.delete(oldRes);
        // Write directly to new path — avoids race where IDB write for
        // the source hasn't completed yet (atomic write pattern: write .tmp → rename)
        inflight.push(
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
        const cachedBytes = ctx.fs.readBytesCached(oldRes);
        if (cachedBytes && decodeUtf8Strict(cachedBytes) === null) {
          // Binary: move the bytes as they are
          fileMtimes.set(newRes, Date.now());
          inflight.push(ctx.fs.writeNow(newRes, cachedBytes).catch(() => {}));
          inflight.push(ctx.fs.unlinkNow(oldRes).catch(() => {})); // gone for sync readers now
          return;
        }
        const fsCached = ctx.fs.readCached(oldRes);
        if (fsCached !== undefined) {
          fileCache.set(newRes, fsCached);
          fileMtimes.set(newRes, Date.now());
        }
        inflight.push(ctx.fs.rename(oldRes, newRes).catch(() => {}));
      }
    },
    realpathSync: (p: string) => {
      tickSyncOps();
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      // Verify path exists (file or directory)
      const isFile = fileCache.has(resolved);
      const isDir = [...fileCache.keys()].some(k => k.startsWith(resolved + '/'));
      // Symlinks resolve (pnpm's node_modules/x -> .pnpm/x@1/node_modules/x)
      const real = ctx.fs.realpathCached?.(resolved);
      if (!isFile && !isDir) {
        if (real && real !== resolved && (fileCache.has(real) || ctx.fs.isDirCached?.(real) || ctx.fs.readBytesCached(real) !== undefined)) return real;
        throw fsError('ENOENT', `ENOENT: no such file or directory, realpath '${p}'`, 'realpath', p);
      }
      return real ?? resolved;
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
      const mtime = new Date(stableMtime(fileMtimes, resolved));
      const size = isFile ? (currentBytes(resolved)?.length ?? 0) : 0; // bytes, not UTF-16 units
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
    // Modes are kept (pnpm and cmd-shim make their bin shims executable)
    chmodSync: (p: string, mode: any) => {
      const resolved = ctx.fs.resolvePath(String(p), ctx.cwd);
      inflight.push(chmodAfterWrites(deps, resolved, mode).catch(() => {}));
    },
    chownSync: () => {},
    fstatSync: (fd: number) => {
      if (fd === 0 || fd === 1 || fd === 2) {
        // stdio is the terminal: a character device, like a TTY
        const now = new Date();
        return { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false,
          isCharacterDevice: () => true, isBlockDevice: () => false, isFIFO: () => false, isSocket: () => false,
          size: 0, mode: 0o20620, mtime: now, ctime: now, atime: now, birthtime: now,
          mtimeMs: now.getTime(), ctimeMs: now.getTime(), atimeMs: now.getTime(), birthtimeMs: now.getTime(),
          dev: 0, ino: 0, nlink: 1, uid: 1000, gid: 1000, rdev: 0, blksize: 4096, blocks: 0 };
      }
      const entry = (globalThis as any).__shiroFds?.[fd];
      if (!entry) {
        const err: any = new Error(`EBADF: bad file descriptor, fstat`);
        err.code = 'EBADF'; err.errno = -9; err.syscall = 'fstat';
        throw err;
      }
      return fsShim.statSync(entry.path);
    },
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
      // Create/truncate file for write modes, create empty for append
      if (f.includes('w') || f.includes('a')) {
        if (f.includes('w') || !fileCache.has(resolved)) {
          fileCache.set(resolved, ''); // truncate for 'w', create for 'a' if missing
        }
        fileMtimes.set(resolved, Date.now());
        // Ensure parent dirs exist in fileCache
        const parentDir = resolved.substring(0, resolved.lastIndexOf('/'));
        if (parentDir && !fileCache.has(parentDir + '/.')) {
          fileCache.set(parentDir + '/.', '');
          inflight.push(ctx.fs.mkdir(parentDir, { recursive: true }).catch(() => {}));
        }
        materializeOpenFile(resolved);
      }
      return fd;
    },
    writeSync: (fd: number, data: string | Uint8Array) => {
      const fdInfo = (globalThis as any).__shiroFds?.[fd];
      if (fdInfo) {
        const bytes = toBytes(data);
        const prior = currentBytes(fdInfo.path);
        if ((bytes && decodeUtf8Strict(bytes) === null) || (prior && !fileCache.has(fdInfo.path) && decodeUtf8Strict(prior) === null)) {
          storeData(fdInfo.path, concatBytes(prior, bytes ?? new TextEncoder().encode(String(data))), inflight);
          return bytes ? bytes.length : String(data).length;
        }
        const existing = fileCache.get(fdInfo.path) || '';
        const str = typeof data === 'string' ? data : new TextDecoder().decode(data);
        const newContent = existing + str;
        fileCache.set(fdInfo.path, newContent);
        fileMtimes.set(fdInfo.path, Date.now());
        queueWrite(fdInfo.path, () => ctx.fs.writeFile(fdInfo.path, newContent));
      }
      return typeof data === 'string' ? data.length : data.length;
    },
    readSync: (fd: number, buf: Uint8Array, offset?: number, length?: number, position?: number) => {
      const fdInfo = (globalThis as any).__shiroFds?.[fd];
      if (!fdInfo) return 0;
      const bytes = currentBytes(fdInfo.path) ?? new Uint8Array(0);
      const pos = position ?? fdInfo.offset;
      const len = Math.min(length ?? buf.length, Math.max(0, bytes.length - pos));
      for (let i = 0; i < len; i++) buf[(offset ?? 0) + i] = bytes[pos + i];
      fdInfo.offset = pos + len;
      return len;
    },
    closeSync: (fd: number) => {
      const fdInfo = (globalThis as any).__shiroFds?.[fd];
      if (fdInfo) delete (globalThis as any).__shiroFds[fd];
    },
    fsyncSync: () => {},
    fdatasyncSync: () => {},
    utimesSync: (p: string, atime: any, mtime: any) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      fileMtimes.set(resolved, timeMs(mtime));
      pendingPromises.push(ctx.fs.utimes(resolved, timeMs(atime), timeMs(mtime)).catch(() => {}));
    },
    rmSync: (p: string, opts?: any) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      removePathFromCaches(resolved, !!opts?.recursive);
    },
    rmdirSync: (p: string) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      ctx.fs.rmdir(resolved).catch(() => {});
    },
    appendFileSync: (p: string | number, data: string | Uint8Array) => {
      // Node accepts an fd from openSync here (Claude's session log does this)
      if (typeof p === 'number') { fsShim.writeSync(p, data); return; }
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      const bytes = toBytes(data);
      const prior = fileCache.has(resolved) ? undefined : ctx.fs.readBytesCached(resolved);
      if ((bytes && decodeUtf8Strict(bytes) === null) || (prior && decodeUtf8Strict(prior) === null)) {
        storeData(resolved, concatBytes(currentBytes(resolved), bytes ?? new TextEncoder().encode(String(data))), inflight);
        return;
      }
      const existing = fileCache.get(resolved) ?? ctx.fs.readCached(resolved) ?? '';
      const str = typeof data === 'string' ? data : new TextDecoder().decode(bytes!);
      fileCache.set(resolved, existing + str);
      inflight.push(ctx.fs.writeFile(resolved, existing + str).catch(() => {}));
    },
    symlinkSync: (target: string, path: string) => {
      const resolved = ctx.fs.resolvePath(path, ctx.cwd);
      const dir = resolved.substring(0, resolved.lastIndexOf('/')) || '/';
      const targetResolved = ctx.fs.resolvePath(target, dir);
      // A real link (target as given), plus the target's text for sync readers
      const content = fileCache.get(targetResolved);
      if (content !== undefined) fileCache.set(resolved, content);
      queueWrite(resolved, () => ctx.fs.symlink(String(target), resolved));
    },
    // Real streams over the file's bytes (yarn pipes downloaded tarballs into
    // createWriteStream; chunks used to be decoded as text)
    createReadStream: (p: string, opts?: any) => {
      const s = getBuiltinModule('stream');
      const o = typeof opts === 'string' ? { encoding: opts } : (opts || {});
      const resolved = ctx.fs.resolvePath(String(p), ctx.cwd);
      const hwm = o.highWaterMark ?? 65536;
      let data: Uint8Array | null = null;
      let pos = 0;
      let wanted = false;
      const pushSome = () => {
        const end = Math.min(data!.length, o.end !== undefined ? o.end + 1 : data!.length);
        if (pos >= end) { rs.push(null); return; }
        const next = Math.min(end, pos + hwm);
        const chunk = FakeBuffer.from(data!.subarray(pos, next));
        rs.bytesRead += next - pos;
        pos = next;
        rs.push(chunk);
      };
      const rs = new s.Readable({
        highWaterMark: hwm,
        encoding: o.encoding,
        read() { if (data) pushSome(); else wanted = true; },
      });
      // Opened right away, as in Node: a missing file is an 'error' even
      // before anything reads
      const cached = currentBytes(resolved);
      const got = cached ? Promise.resolve(cached) : ctx.fs.readFile(resolved).then((d: any) => typeof d === 'string' ? new TextEncoder().encode(d) : new Uint8Array(d));
      got.then((bytes: Uint8Array) => {
        data = bytes;
        pos = o.start ?? 0;
        rs.pending = false;
        rs.emit('open', 100);
        rs.emit('ready');
        if (wanted) pushSome();
      }, () => {
        rs.destroy(fsError('ENOENT', `ENOENT: no such file or directory, open '${p}'`, 'open', String(p)));
      });
      rs.path = p;
      rs.bytesRead = 0;
      rs.pending = true;
      rs.close = (cb?: Function) => { rs.destroy(); if (cb) rs.once('close', cb); };
      return rs;
    },
    createWriteStream: (p: string, opts?: any) => {
      const s = getBuiltinModule('stream');
      const o = typeof opts === 'string' ? { encoding: opts } : (opts || {});
      const resolved = ctx.fs.resolvePath(String(p), ctx.cwd);
      const append = String(o.flags || 'w').includes('a');
      const parts: Uint8Array[] = [];
      if (append) { const prior = currentBytes(resolved); if (prior) parts.push(prior); }
      const flush = () => {
        const total = parts.reduce((n, c) => n + c.length, 0);
        const bytes = new Uint8Array(total);
        let off = 0;
        for (const c of parts) { bytes.set(c, off); off += c.length; }
        const text = decodeUtf8Strict(bytes);
        fileMtimes.set(resolved, Date.now());
        if (text === null) {
          fileCache.delete(resolved);
          return queueWrite(resolved, () => ctx.fs.writeNow(resolved, bytes));
        }
        fileCache.set(resolved, text);
        return queueWrite(resolved, () => ctx.fs.writeFile(resolved, text));
      };
      const ws = new s.Writable({
        highWaterMark: o.highWaterMark,
        decodeStrings: false,
        write(chunk: any, enc: string, cb: Function) {
          const bytes = typeof chunk === 'string' ? FakeBuffer.from(chunk, enc === 'buffer' ? 'utf8' : enc) : toBytes(chunk) ?? new TextEncoder().encode(String(chunk));
          parts.push(new Uint8Array(bytes));
          ws.bytesWritten += bytes.length;
          cb();
        },
        final(cb: Function) { flush().then(() => cb(), (e: any) => cb(e)); },
      });
      ws.path = p;
      ws.bytesWritten = 0;
      ws.pending = false;
      ws.close = (cb?: Function) => { ws.end(); if (cb) ws.once('close', cb); };
      // created (or truncated) when opened, as in Node
      if (!append) { fileCache.set(resolved, ''); fileMtimes.set(resolved, Date.now()); materializeOpenFile(resolved); }
      queueMicrotask(() => { ws.emit('open', 100); ws.emit('ready'); });
      return ws;
    },
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_TRUNC: 512, O_APPEND: 1024, O_NONBLOCK: 2048, S_IFMT: 61440, S_IFREG: 32768, S_IFDIR: 16384, S_IFLNK: 40960 },
    // Callback-style async fs methods (used by graceful-fs, fs-extra)
    readFile: (p: string, optsOrCb?: any, cb?: any) => {
      const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
      const opts2 = typeof optsOrCb === 'function' ? undefined : optsOrCb;
      const resolved = typeof p === 'number'
        ? ((globalThis as any).__shiroFds?.[p]?.path || '')
        : ctx.fs.resolvePath(String(p), ctx.cwd);
      // Check fileCache first — sync writes may have updated it
      const cached = fileCache.get(resolved);
      if (cached !== undefined) {
        const encoding = typeof opts2 === 'string' ? opts2 : opts2?.encoding;
        const result = encoding ? cached : FakeBuffer.from(cached);
        queueMicrotask(() => callback?.(null, result));
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
      inflight.push(ctx.fs.writeFile(resolved, strData).catch(() => {}));
      queueMicrotask(() => callback?.(null));
    },
    stat: (p: string, optsOrCb?: any, cb?: any) => {
      const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      // Check fileCache first (matches statSync behavior) — avoids IDB round-trip
      const isFile = fileCache.has(resolved) || ctx.fs.readCached(resolved) !== undefined;
      const isDir = fileCache.has(resolved + '/.') || [...fileCache.keys()].some(k => k.startsWith(resolved + '/')) || fsDirCached(resolved);
      if (isFile || isDir) {
        const mtime = new Date(stableMtime(fileMtimes, resolved));
        const size = isFile ? (currentBytes(resolved)?.length ?? 0) : 0; // bytes, not UTF-16 units
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
      const isDir = fileCache.has(resolved + '/.') || [...fileCache.keys()].some(k => k.startsWith(resolved + '/')) || fsDirCached(resolved);
      if (isFile || isDir) {
        const mtime = new Date(stableMtime(fileMtimes, resolved));
        const size = isFile ? (currentBytes(resolved)?.length ?? 0) : 0; // bytes, not UTF-16 units
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
            const childIsDir = cacheDirSet.has(name) || fileCache.has(childPath + '/.') || fsDirCached(childPath);
            return makeDirent(ctx, resolved, name, childIsDir);
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
                const st = await ctx.fs.lstat(resolved + '/' + name);
                dirents.push({ name, parentPath: resolved, path: resolved, isFile: () => st.isFile(), isDirectory: () => st.isDirectory(), isSymbolicLink: () => st.isSymbolicLink?.() || false, isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false });
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
    rmdir: (p: string, optsOrCb?: any, cb?: any) => {
      // rmdir removes directories (unlink only removes files; proper-lockfile
      // releases its lock with fs.rmdir and got EISDIR, so locks never released)
      const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      fileCache.delete(resolved + '/.');
      ctx.fs.rmdir(resolved)
        .then(() => callback?.(null))
        .catch((e: any) => callback?.(e));
    },
    rename: (oldP: string, newP: string, cb?: any) => {
      const oldRes = ctx.fs.resolvePath(oldP, ctx.cwd);
      const newRes = ctx.fs.resolvePath(newP, ctx.cwd);
      // Writes still in flight for the source land first (write-file-atomic:
      // write through an fd, then rename at once)
      renameAfterWrites(deps, oldRes, newRes).then(() => cb?.(null), (e: any) => cb?.(e));
    },
    access: (p: string, modeOrCb?: any, cb?: any) => {
      const callback = typeof modeOrCb === 'function' ? modeOrCb : cb;
      ctx.fs.exists(ctx.fs.resolvePath(p, ctx.cwd))
        .then((exists: boolean) => exists ? callback?.(null) : callback?.(fsError('ENOENT', `ENOENT: no such file or directory, access '${p}'`, 'access', p)))
        .catch((e: any) => callback?.(e));
    },
    chmod: (p: string, mode: any, cb?: any) => {
      const resolved = ctx.fs.resolvePath(String(p), ctx.cwd);
      chmodAfterWrites(deps, resolved, mode).then(() => cb?.(null), (e: any) => cb?.(e));
    },
    chown: (_p: string, _u: any, _g: any, cb?: any) => { cb?.(null); },
    symlink: (target: string, path: string, typeOrCb?: any, cb?: any) => {
      const callback = typeof typeOrCb === 'function' ? typeOrCb : cb;
      // the target is stored as given: a relative one resolves against the link's directory
      ctx.fs.symlink(String(target), ctx.fs.resolvePath(path, ctx.cwd))
        .then(() => callback?.(null))
        .catch((e: any) => callback?.(e));
    },
    readlink: (p: string, optsOrCb?: any, cb?: any) => {
      const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
      ctx.fs.readlink(ctx.fs.resolvePath(p, ctx.cwd))
        .then((target: string) => callback?.(null, target))
        .catch((e: any) => callback?.(e));
    },
    // Claude Code writes config "through" a symlink when readlinkSync succeeds, so it
    // must throw EINVAL for regular files (a missing readlinkSync used to return '',
    // which resolved to the parent directory and aimed every config save at ~).
    readlinkSync: (p: string) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      const target = ctx.fs.readlinkCached(resolved);
      if (typeof target === 'string') return target;
      const exists = target === null || fileCache.has(resolved);
      const err: any = new Error(exists
        ? `EINVAL: invalid argument, readlink '${p}'`
        : `ENOENT: no such file or directory, readlink '${p}'`);
      err.code = exists ? 'EINVAL' : 'ENOENT';
      err.errno = exists ? -22 : -2;
      err.syscall = 'readlink';
      err.path = p;
      throw err;
    },
    close: (_fd: number, cb?: any) => { cb?.(null); },
    open: (p: string, flags: any, modeOrCb?: any, cb?: any) => {
      const callback = typeof modeOrCb === 'function' ? modeOrCb : cb;
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      const fd = 100 + Math.floor(Math.random() * 9900);
      (globalThis as any).__shiroFds = (globalThis as any).__shiroFds || {};
      let f: string;
      if (typeof flags === 'number') {
        const isWrite = (flags & 1) || (flags & 2);
        const isAppend = flags & 1024;
        f = isAppend ? 'a' : isWrite ? 'w' : 'r';
      } else {
        f = flags || 'r';
      }
      // Opening a missing file to read is ENOENT (it opened anything: yarn
      // took a tarball cache it never wrote for a hit and fetched nothing)
      const readOnly = !(f.includes('w') || f.includes('a') || f.includes('+')) && !(typeof flags === 'number' && (flags & 64));
      const known = fileCache.has(resolved) || ctx.fs.readBytesCached(resolved) !== undefined || fileCache.has(resolved + '/.') || fsDirCached(resolved);
      (known || !readOnly ? Promise.resolve(true) : ctx.fs.exists(resolved)).then((exists: boolean) => {
        if (!exists) {
          callback?.(fsError('ENOENT', `ENOENT: no such file or directory, open '${p}'`, 'open', String(p)));
          return;
        }
        (globalThis as any).__shiroFds[fd] = { path: resolved, flags: f, offset: 0 };
        if (f.includes('w') || f.includes('a')) {
          if (f.includes('w') || !fileCache.has(resolved)) {
            fileCache.set(resolved, '');
          }
          fileMtimes.set(resolved, Date.now());
          materializeOpenFile(resolved);
        }
        callback?.(null, fd);
      }, (e: any) => callback?.(e));
    },
    read: (fd: number, buf: any, off: number, len: number, pos: any, cb?: any) => {
      const fdInfo = (globalThis as any).__shiroFds?.[fd];
      if (!fdInfo) {
        cb?.(null, 0, buf);
        return;
      }
      const bytes = currentBytes(fdInfo.path) ?? new Uint8Array(0);
      const p2 = pos ?? fdInfo.offset;
      const n = Math.min(len, Math.max(0, bytes.length - p2));
      for (let i = 0; i < n; i++) buf[(off ?? 0) + i] = bytes[p2 + i];
      fdInfo.offset = p2 + n;
      cb?.(null, n, buf);
    },
    // write(fd, buffer[, offset[, length[, position]]], cb), write(fd, buffer, options, cb)
    // and write(fd, string[, position[, encoding]], cb): the callback is the last
    // function (the string form used to drop it: write-file-atomic never finished)
    write: (fd: number, buf: any, ...rest: any[]) => {
      const cbIdx = rest.findIndex((a) => typeof a === 'function');
      const cb = cbIdx >= 0 ? rest[cbIdx] : undefined;
      const args = cbIdx >= 0 ? rest.slice(0, cbIdx) : rest;
      let data: any;
      if (typeof buf === 'string') {
        const enc = typeof args[1] === 'string' ? args[1] : undefined;
        data = enc && enc !== 'utf8' && enc !== 'utf-8' ? FakeBuffer.from(buf, enc) : buf;
      } else {
        const bytes = toBytes(buf) ?? new Uint8Array(0);
        const o = args[0] && typeof args[0] === 'object' ? args[0] : { offset: args[0], length: args[1] };
        const off = o.offset ?? 0;
        data = bytes.subarray(off, off + (o.length ?? bytes.length - off));
      }
      let n: number;
      try { fsShim.writeSync(fd, data); n = typeof data === 'string' ? new TextEncoder().encode(data).length : data.length; }
      catch (e) { cb?.(e); return; }
      cb?.(null, n, buf);
    },
    link: (src: string, dst: string, cb?: any) => {
      try { fsShim.linkSync(src, dst); cb?.(null); } catch (e) { cb?.(e); }
    },
    // Through copyFileSync, which copies what this script sees (the cache
    // ahead of storage) as bytes: reading storage copied files whose writes
    // were still in flight as empty (yarn's copy out of its cache)
    copyFile: (src: string, dst: string, flagsOrCb?: any, cb?: any) => {
      const callback = typeof flagsOrCb === 'function' ? flagsOrCb : cb;
      const srcRes = ctx.fs.resolvePath(String(src), ctx.cwd);
      const dstRes = ctx.fs.resolvePath(String(dst), ctx.cwd);
      const known = fileCache.has(srcRes) || ctx.fs.readBytesCached(srcRes) !== undefined;
      (known ? Promise.resolve(true) : Promise.allSettled([...writeState.inflight]).then(() => ctx.fs.exists(srcRes))).then((exists: boolean) => {
        if (!exists) { callback?.(fsError('ENOENT', `ENOENT: no such file or directory, copyfile '${src}' -> '${dst}'`, 'copyfile', String(src))); return; }
        fsShim.copyFileSync(src, dst);
        Promise.allSettled([writeChains.get(dstRes)]).then(() => callback?.(null));
      }, (e: any) => callback?.(e));
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
    utimes: (p: string, atime: any, mtime: any, cb?: any) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      fileMtimes.set(resolved, timeMs(mtime));
      ctx.fs.utimes(resolved, timeMs(atime), timeMs(mtime)).then(() => cb?.(null), (e: any) => cb?.(e));
    },
    futimes: (_fd: number, _a: any, _m: any, cb?: any) => { cb?.(null); },
    fstat: (fd: number, optsOrCb?: any, cb?: any) => {
      const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
      let st: any;
      try { st = fsShim.fstatSync(fd); } catch (e) { callback?.(e); return; }
      callback?.(null, st);
    },
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
        inflight.push(ctx.fs.writeFile(fdInfo.path, truncated).catch(() => {}));
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
      const opts = typeof optsOrCb === 'object' ? optsOrCb : undefined;
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      removePathFromCaches(resolved, !!opts?.recursive);
      queueMicrotask(() => callback?.(null));
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
      link: async (src: string, dst: string) => { fsShim.linkSync(src, dst); },
      readFile: async (p: string | number, opts?: any) => {
        const resolved = typeof p === 'number'
          ? ((globalThis as any).__shiroFds?.[p]?.path || ctx.fs.resolvePath(String(p), ctx.cwd))
          : ctx.fs.resolvePath(String(p), ctx.cwd);
        const encoding = typeof opts === 'string' ? opts : opts?.encoding;
        // Check fileCache first (may have data from writeFileSync not yet flushed)
        const cached = fileCache.get(resolved);
        if (cached !== undefined) {
          if (encoding === 'utf8' || encoding === 'utf-8') return cached;
          return FakeBuffer.from(cached);
        }
        // Like node: a Buffer unless an encoding is given (binary files stay intact)
        const data = await ctx.fs.readFile(resolved);
        if (encoding) return typeof data === 'string' ? data : new TextDecoder().decode(data);
        return FakeBuffer.from(data);
      },
      writeFile: async (p: string, data: any) => {
        const resolved = ctx.fs.resolvePath(p, ctx.cwd);
        const pending: Promise<any>[] = [];
        const content = storeData(resolved, data, pending);
        if (content === null) { await Promise.all(pending); return; }
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
            const childIsDir = cacheDirSet.has(name) || fileCache.has(childPath + '/.') || [...fileCache.keys()].some(k => k.startsWith(childPath + '/')) || fsDirCached(childPath);
            return makeDirent(ctx, resolved, name, childIsDir);
          });
        }
        return entries;
      },
      stat: async (p: string) => {
        const resolved = ctx.fs.resolvePath(p, ctx.cwd);
        const isFile = fileCache.has(resolved) || ctx.fs.readCached(resolved) !== undefined;
        const isDir = fileCache.has(resolved + '/.') || [...fileCache.keys()].some(k => k.startsWith(resolved + '/')) || fsDirCached(resolved);
        if (isFile || isDir) {
          const mtime = new Date(stableMtime(fileMtimes, resolved));
          const size = isFile ? (currentBytes(resolved)?.length ?? 0) : 0; // bytes, not UTF-16 units
          return { isFile: () => isFile && !isDir, isDirectory: () => isDir, isSymbolicLink: () => false, isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false, size, mtime, ctime: mtime, atime: mtime, birthtime: mtime, mtimeMs: mtime.getTime(), ctimeMs: mtime.getTime(), atimeMs: mtime.getTime(), birthtimeMs: mtime.getTime(), dev: 0, ino: 0, nlink: 1, uid: 1000, gid: 1000, rdev: 0, blksize: 4096, blocks: Math.ceil(size / 512), mode: isDir ? 0o40755 : 0o100644 };
        }
        return ctx.fs.stat(resolved);
      },
      mkdir: async (p: string, opts?: any) => ctx.fs.mkdir(ctx.fs.resolvePath(p, ctx.cwd), opts),
      unlink: async (p: string) => { const r = ctx.fs.resolvePath(p, ctx.cwd); fileCache.delete(r); fileMtimes.delete(r); return ctx.fs.unlink(r); },
      rm: async (p: string, opts?: any) => {
        const resolved = ctx.fs.resolvePath(p, ctx.cwd);
        removePathFromCaches(resolved, !!opts?.recursive);
      },
      access: async (p: string) => {
        const resolved = ctx.fs.resolvePath(p, ctx.cwd);
        if (fileCache.has(resolved) || fileCache.has(resolved + '/.') || [...fileCache.keys()].some(k => k.startsWith(resolved + '/')) || ctx.fs.readCached(resolved) !== undefined || fsDirCached(resolved)) return;
        const exists = await ctx.fs.exists(resolved);
        if (!exists) throw fsError('ENOENT', `ENOENT: no such file or directory, access '${p}'`, 'access', p);
      },
    },
  };
  // realpath and realpath.native need special handling (function with properties)
  const realpathFn: any = (p: string, optsOrCb?: any, cb?: any) => {
    const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
    realpathAsync(deps, p).then((r) => callback?.(null, r), (e) => callback?.(e));
  };
  realpathFn.native = realpathFn;
  fsShim.realpath = realpathFn;
  // Also add realpathSync.native
  const origRealpathSync = fsShim.realpathSync;
  origRealpathSync.native = origRealpathSync;
  // fs.promises is fs/promises: the calls above, plus the rest of that
  // module (lstat, realpath, opendir... which prettier's file walk needs)
  fsShim.promises = { ...createFsPromisesModule(deps), ...fsShim.promises };
  // Callbacks always run later, as in Node: code that registers its listener
  // after starting the call (touch: fs.open in a constructor, .on('done')
  // after it) missed callbacks the shim made synchronously
  for (const k of Object.keys(fsShim)) {
    const f = fsShim[k];
    if (typeof f !== 'function' || k.endsWith('Sync') || /^[A-Z]/.test(k) || NOT_CALLBACK_API.has(k)) continue;
    const wrapped: any = function (this: any, ...args: any[]) {
      const last = args.length - 1;
      if (last >= 0 && typeof args[last] === 'function') {
        const cb = args[last];
        args[last] = (...r: any[]) => queueMicrotask(() => cb(...r));
      }
      return f.apply(this, args);
    };
    Object.assign(wrapped, f);
    fsShim[k] = wrapped;
  }
  return fsShim;
}

const NOT_CALLBACK_API = new Set(['createReadStream', 'createWriteStream', 'watch', 'watchFile', 'unwatchFile', 'openAsBlob']);

export function createFsPromisesModule(deps: FsDeps): any {
  const { ctx, fileCache, fileMtimes, FakeBuffer, homeDir, getBuiltinModule } = deps;
  const fsDirCached = dirCachedChecker(deps);
  const { removePathFromCaches, toBytes, currentBytes, storeData, concatBytes } = createRemovalHelpers(ctx, fileCache, fileMtimes);

  // Async fs promises API
  return {
    readFile: async (p: string | number, opts?: any) => {
      const resolved = typeof p === 'number'
        ? ((globalThis as any).__shiroFds?.[p]?.path || ctx.fs.resolvePath(String(p), ctx.cwd))
        : ctx.fs.resolvePath(String(p), ctx.cwd);
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
      const pending: Promise<any>[] = [];
      const content = storeData(resolved, data, pending);
      if (content === null) { await Promise.all(pending); return; }
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
          const childIsDir = cacheDirSet.has(name) || fileCache.has(childPath + '/.') || [...fileCache.keys()].some(k => k.startsWith(childPath + '/')) || fsDirCached(childPath);
          return makeDirent(ctx, resolved, name, childIsDir);
        });
        return dirents;
      }
      return entries;
    },
    stat: async (p: string) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      // Check fileCache first (matches statSync behavior)
      const isFile = fileCache.has(resolved) || ctx.fs.readCached(resolved) !== undefined;
      const isDir = fileCache.has(resolved + '/.') || [...fileCache.keys()].some(k => k.startsWith(resolved + '/')) || fsDirCached(resolved);
      if (isFile || isDir) {
        const mtime = new Date(stableMtime(fileMtimes, resolved));
        const size = isFile ? (currentBytes(resolved)?.length ?? 0) : 0; // bytes, not UTF-16 units
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
      removePathFromCaches(resolved, !!opts?.recursive);
    },
    access: async (p: string) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      // Check fileCache/dirs before going to IDB
      if (fileCache.has(resolved) || fileCache.has(resolved + '/.') || [...fileCache.keys()].some(k => k.startsWith(resolved + '/')) || ctx.fs.readCached(resolved) !== undefined || fsDirCached(resolved)) return;
      const exists = await ctx.fs.exists(resolved);
      if (!exists) throw fsError('ENOENT', `ENOENT: no such file or directory, access '${p}'`, 'access', p);
    },
    lstat: async (p: string) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      // Check fileCache first (same as stat)
      const isFile = fileCache.has(resolved) || ctx.fs.readCached(resolved) !== undefined;
      const isDir = fileCache.has(resolved + '/.') || [...fileCache.keys()].some(k => k.startsWith(resolved + '/')) || fsDirCached(resolved);
      if (isFile || isDir) {
        const mtime = new Date(stableMtime(fileMtimes, resolved));
        const size = isFile ? (currentBytes(resolved)?.length ?? 0) : 0; // bytes, not UTF-16 units
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
    chmod: async (p: string, mode: any) => {
      const resolved = ctx.fs.resolvePath(String(p), ctx.cwd);
      await chmodAfterWrites(deps, resolved, mode);
    },
    rename: async (oldP: string, newP: string) => {
      const oldRes = ctx.fs.resolvePath(oldP, ctx.cwd);
      const newRes = ctx.fs.resolvePath(newP, ctx.cwd);
      await renameAfterWrites(deps, oldRes, newRes); // writes in flight land first
    },
    link: async (src: string, dst: string) => {
      const exists = await ctx.fs.exists(ctx.fs.resolvePath(dst, ctx.cwd));
      if (exists) {
        const err: any = new Error(`EEXIST: file already exists, link '${src}' -> '${dst}'`);
        err.code = 'EEXIST'; err.errno = -17; err.syscall = 'link';
        throw err;
      }
      const data = await ctx.fs.readFile(ctx.fs.resolvePath(src, ctx.cwd));
      await ctx.fs.writeFile(ctx.fs.resolvePath(dst, ctx.cwd), data);
    },
    // fs.copyFile's (bytes, not text decoded: binary files came out mangled)
    copyFile: (src: string, dst: string) => new Promise<void>((resolve, reject) => {
      getBuiltinModule('fs').copyFile(src, dst, (e: any) => e ? reject(e) : resolve());
    }),
    appendFile: async (p: string, data: any) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      let existing: Uint8Array = new Uint8Array(0);
      const cachedText = fileCache.get(resolved);
      if (cachedText !== undefined) existing = new TextEncoder().encode(cachedText);
      else { try { const d = await ctx.fs.readFile(resolved); existing = typeof d === 'string' ? new TextEncoder().encode(d) : d; } catch {} }
      const add = toBytes(data) ?? new TextEncoder().encode(String(data));
      const pending: Promise<any>[] = [];
      const text = storeData(resolved, concatBytes(existing, add), pending);
      if (text === null) { await Promise.all(pending); return; }
      fileCache.set(resolved, text);
      await ctx.fs.writeFile(resolved, text);
    },
    symlink: async (target: string, path: string) => {
      await ctx.fs.symlink(String(target), ctx.fs.resolvePath(path, ctx.cwd));
    },
    readlink: async (p: string) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      return await ctx.fs.readlink(resolved);
    },
    realpath: async (p: string) => realpathAsync(deps, p),
    rmdir: async (p: string) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      fileCache.delete(resolved + '/.');
      await ctx.fs.rmdir(resolved);
    },
    utimes: async (p: string, atime: any, mtime: any) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      fileMtimes.set(resolved, timeMs(mtime));
      await ctx.fs.utimes(resolved, timeMs(atime), timeMs(mtime));
    },
    mkdtemp: async (prefix: string) => {
      const dir = `${prefix}${Math.random().toString(36).slice(2)}`;
      await ctx.fs.mkdir(dir, { recursive: true });
      return dir;
    },
    open: async (p: string, flags?: any) => {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      // Register a real fd: Claude's Bash tool opens its output file here and
      // passes handle.fd as spawn stdio. With the old fd 0, spawn couldn't map
      // it to the file, so every command's output was dropped.
      const syncFs = getBuiltinModule('fs');
      const fd: number = syncFs.openSync(p, flags ?? 'r');
      // Current bytes: the in-memory copy is ahead of IndexedDB while a
      // spawned command is still writing its output file.
      const currentBytes = async (): Promise<Uint8Array> => {
        const cached = fileCache.get(resolved);
        if (cached !== undefined) return new TextEncoder().encode(cached);
        const data = await ctx.fs.readFile(resolved);
        return typeof data === 'string' ? new TextEncoder().encode(data) : data;
      };
      const close = async () => { syncFs.closeSync(fd); };
      const handle: any = {
        fd,
        // Claude Code reads task output with handle.read(buf, off, len, pos)
        read: async (bufOrOpts?: any, offset?: number, length?: number, position?: number | null) => {
          let buffer = bufOrOpts;
          if (bufOrOpts && !(bufOrOpts instanceof Uint8Array)) {
            ({ buffer, offset, length, position } = bufOrOpts);
          }
          buffer ??= FakeBuffer.alloc(16384);
          offset ??= 0;
          length ??= buffer.length - offset;
          const bytes = await currentBytes();
          const start = position ?? 0;
          const n = Math.max(0, Math.min(length!, bytes.length - start));
          buffer.set(bytes.subarray(start, start + n), offset);
          return { bytesRead: n, buffer };
        },
        write: async (data: any) => ({ bytesWritten: syncFs.writeSync(fd, data), buffer: data }),
        appendFile: async (data: any) => { syncFs.writeSync(fd, data); },
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
          const pending: Promise<any>[] = [];
          const content = storeData(resolved, data, pending);
          if (content === null) { await Promise.all(pending); return; }
          fileCache.set(resolved, content); // Keep fileCache in sync for readFileSync/renameSync
          await ctx.fs.writeFile(resolved, content);
        },
        close,
        stat: async () => {
          let st: any;
          try {
            st = await ctx.fs.stat(resolved);
          } catch (e) {
            if (!fileCache.has(resolved)) throw e;
            // Written to memory but not flushed to IndexedDB yet
            const now = new Date();
            st = { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
              mode: 0o100644, mtime: now, ctime: now, atime: now, birthtime: now, mtimeMs: now.getTime() };
          }
          if (fileCache.has(resolved)) st.size = (await currentBytes()).length;
          return st;
        },
        chmod: async () => {},
        sync: async () => {},
        datasync: async () => {},
      };
      // `await using` (Claude Code's bundled helper) requires a disposable handle
      handle[(Symbol as any).asyncDispose ?? Symbol.for('Symbol.asyncDispose')] = close;
      return handle;
    },
    watch: async function*(_p: string, _opts?: any) { /* no-op async generator */ },
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_TRUNC: 512, O_APPEND: 1024, O_NONBLOCK: 2048, S_IFMT: 61440, S_IFREG: 32768, S_IFDIR: 16384, S_IFLNK: 40960 },
  };
}
