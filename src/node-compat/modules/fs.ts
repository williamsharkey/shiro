import { nodeGuestOf } from '../../node-worker/hooks';
import type { CommandContext } from '../../commands/index';
import { ProcessExitError } from '../../commands/jseval/utils';
import { decodeUtf8Strict } from '../preload';
import { PAGE_SET_TIMEOUT } from '../page-globals';
import { createWatchApi } from './fs-watch';

export interface FsDeps {
  ctx: CommandContext;
  fileCache: Map<string, string>;
  fileMtimes: Map<string, number>;
  pendingPromises: Promise<any>[];
  tickSyncOps: () => void;
  FakeBuffer: any;
  getBuiltinModule: (name: string) => any;
  homeDir: string;
  /** Counts a promise as the script's async activity (an fs callback still to come) */
  trackAsync?: <T>(p: Promise<T>) => Promise<T>;
  /** Registers cleanup for when the script ends (watchers) */
  atExit?: (fn: () => void) => void;
  /** The script's process: fds 0-2 are its stdin, stdout and stderr */
  getProcess?: () => any;
}

/**
 * A path argument as node takes one: a string, a file: URL object
 * (`new URL('./x', import.meta.url)`: Astro reads its templates so) or a Buffer
 */
function pathArg(p: any): string {
  if (typeof p === 'string') return p;
  if (p && typeof p === 'object' && typeof p.href === 'string' && p.protocol === 'file:') return decodeURIComponent(p.pathname);
  if (ArrayBuffer.isView(p)) return new TextDecoder().decode(p as Uint8Array);
  return String(p);
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

/** open(2) flags, from node's string form or the O_* bits. */
export interface OpenFlags { read: boolean; write: boolean; create: boolean; excl: boolean; trunc: boolean; append: boolean }
export function parseOpenFlags(flags: any): OpenFlags {
  if (typeof flags === 'number') {
    const acc = flags & 3; // O_RDONLY 0, O_WRONLY 1, O_RDWR 2
    return { read: acc !== 1, write: acc !== 0, create: !!(flags & 64), excl: !!(flags & 128), trunc: !!(flags & 512), append: !!(flags & 1024) };
  }
  const f = String(flags ?? 'r').replace(/s/g, '');
  const plus = f.includes('+');
  switch (f[0]) {
    case 'w': return { read: plus, write: true, create: true, excl: f.includes('x'), trunc: true, append: false };
    case 'a': return { read: plus, write: true, create: true, excl: f.includes('x'), trunc: false, append: true };
    default: return { read: true, write: plus, create: false, excl: false, trunc: false, append: false };
  }
}

/** A stable inode number for a canonical path (the same file through a link is the same inode). */
export function inodeOf(path: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) { h ^= path.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0) || 1;
}

/** A node fs.Stats-like object. */
export function makeStats(o: { type: 'file' | 'dir' | 'symlink'; size: number; mtimeMs: number; mode: number; ino: number }): any {
  const t = new Date(o.mtimeMs);
  const fmt = o.type === 'dir' ? 0o40000 : o.type === 'symlink' ? 0o120000 : 0o100000;
  return {
    isFile: () => o.type === 'file', isDirectory: () => o.type === 'dir', isSymbolicLink: () => o.type === 'symlink',
    isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false,
    dev: 1, ino: o.ino, mode: fmt | (o.mode & 0o7777), nlink: o.type === 'dir' ? 2 : 1, uid: 1000, gid: 1000, rdev: 0,
    size: o.size, blksize: 4096, blocks: Math.ceil(o.size / 512),
    atime: t, mtime: t, ctime: t, birthtime: t,
    atimeMs: o.mtimeMs, mtimeMs: o.mtimeMs, ctimeMs: o.mtimeMs, birthtimeMs: o.mtimeMs,
  };
}

/** writeFile/appendFile options: a string is the encoding. */
export function writeOptions(opts: any, defFlag: string): { encoding?: string; flag: string; mode?: number } {
  if (typeof opts === 'string') return { encoding: opts, flag: defFlag };
  return { encoding: opts?.encoding ?? undefined, flag: opts?.flag ?? defFlag, mode: opts?.mode === undefined ? undefined : (typeof opts.mode === 'string' ? parseInt(opts.mode, 8) : opts.mode) };
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
interface WriteState {
  chains: Map<string, Promise<void>>; inflight: Set<Promise<any>>; push: (p: Promise<any>) => number; gone: Set<string>;
  /** Modes set at creation that the filesystem hasn't stored yet */
  modes: Map<string, number>;
}
const writeStates = new WeakMap<Promise<any>[], WriteState>();
function writeStateFor(pending: Promise<any>[]): WriteState {
  let st = writeStates.get(pending);
  if (!st) {
    const inflight = new Set<Promise<any>>();
    st = {
      chains: new Map(),
      gone: new Set(),
      modes: new Map(),
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
  const guest = !!nodeGuestOf(deps.ctx);
  return (p: string) => {
    for (const g of gone) if (p === g || p.startsWith(g + '/')) return false;
    if (guest) return !!deps.ctx.fs.isDirCached?.(p); // a stat says it all
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
  const resolved = ctx.fs.resolvePath(pathArg(p), ctx.cwd);
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
  // Files other processes change: the text cache follows them (it was filled
  // at start, so a watcher's re-read of a changed file got the old text).
  // Not while this script's own writes are in flight: the cache is ahead then.
  if (deps.atExit && nodeGuestOf(ctx)) {
    // A guest's cache reads through: a changed path is just dropped (read again when asked),
    // while a watcher has the page's change feed on
    const drop = (p?: string) => { if (p) Map.prototype.delete.call(fileCache, p); };
    deps.atExit((ctx.fs as any).onChangePassive((_event: string, path: string, newPath?: string) => { drop(path); drop(newPath); }));
  } else if (deps.atExit) {
    const off = ctx.fs.onChange((event, path, newPath) => {
      queueMicrotask(() => {
        if (writeState.inflight.size) return;
        for (const p of [path, newPath]) {
          if (!p || !fileCache.has(p)) continue;
          const now = ctx.fs.readCached(p);
          if (now === undefined) { if (event === 'delete' || (event === 'rename' && p === path)) { fileCache.delete(p); fileMtimes.delete(p); } continue; }
          if (now !== fileCache.get(p)) { fileCache.set(p, now); fileMtimes.set(p, Date.now()); }
        }
      });
    });
    deps.atExit(off);
  }
  let watchers: ReturnType<typeof createWatchApi> | undefined;
  const watchApi = () => watchers ??= createWatchApi({ ctx, fileCache, getBuiltinModule, trackAsync: deps.trackAsync, atExit: deps.atExit });
  const fsDirCached = dirCachedChecker(deps);
  /** `p` with every symlink followed: the file a read, write or stat reaches */
  const real = (p: any): string => {
    const r = ctx.fs.resolvePath(String(p instanceof URL ? decodeURIComponent(p.pathname) : p), ctx.cwd);
    return ctx.fs.realpathCached?.(r) ?? r;
  };
  /** `p` with its directories' symlinks followed but not its last component (lstat, readlink, symlink) */
  const realParent = (p: any): string => {
    const r = ctx.fs.resolvePath(String(p instanceof URL ? decodeURIComponent(p.pathname) : p), ctx.cwd);
    const slash = r.lastIndexOf('/');
    if (slash <= 0) return r;
    const dir = ctx.fs.realpathCached?.(r.slice(0, slash)) ?? r.slice(0, slash);
    return (dir === '/' ? '' : dir) + r.slice(slash);
  };
  // A kernel guest writes through at once, so storage is the truth: one lstat
  // answers what the page asks its caches several ways (`r` is canonical)
  const guestLookup = nodeGuestOf(ctx) ? (r: string) => ctx.fs.lookupCached!(r) : undefined;
  /** Whether `r` (canonical) exists as this script sees it: undefined when only storage knows */
  const existsNow = (r: string): boolean | undefined => {
    if (guestLookup) {
      const hit = guestLookup(r);
      return hit === null ? false : hit ? true : undefined;
    }
    if (fileCache.has(r) || fileCache.has(r + '/.') || ctx.fs.readBytesCached(r) !== undefined || fsDirCached(r)) return true;
    if ([...fileCache.keys()].some((k) => k.startsWith(r + '/'))) return true;
    const hit = ctx.fs.lookupCached?.(r);
    if (hit === null) return false;
    return hit ? true : undefined;
  };
  const pendingModes = writeState.modes;
  /** Stats of canonical `r` from memory: null when it doesn't exist, undefined when only storage knows */
  const statNow = (r: string): any => {
    if (guestLookup) {
      const hit = guestLookup(r);
      if (!hit) return hit;
      if (hit.node.type !== 'file' && hit.node.type !== 'dir') return undefined;
      return makeStats({ type: hit.node.type, size: hit.node.size ?? 0, mtimeMs: hit.node.mtime, mode: pendingModes.get(r) ?? hit.node.mode ?? 0o644, ino: inodeOf(hit.path) });
    }
    const isFile = fileCache.has(r) || ctx.fs.readBytesCached(r) !== undefined;
    const isDir = !isFile && (fileCache.has(r + '/.') || fsDirCached(r) || [...fileCache.keys()].some((k) => k.startsWith(r + '/')));
    if (!isFile && !isDir) {
      const hit = ctx.fs.lookupCached?.(r);
      if (hit === null) return null;
      if (hit === undefined) return undefined;
      if (hit.node.type !== 'file' && hit.node.type !== 'dir') return undefined;
      return makeStats({ type: hit.node.type, size: hit.node.size ?? 0, mtimeMs: hit.node.mtime, mode: hit.node.mode ?? 0o644, ino: inodeOf(hit.path) });
    }
    const node = ctx.fs.lookupCached?.(r)?.node;
    const mode = pendingModes.get(r) ?? node?.mode ?? (isDir ? 0o755 : 0o644);
    return makeStats({ type: isDir ? 'dir' : 'file', size: isFile ? (currentBytes(r)?.length ?? 0) : 0, mtimeMs: stableMtime(fileMtimes, r), mode, ino: inodeOf(r) });
  };
  /** lstat from memory (a symlink itself, else the file): null / undefined as statNow */
  const lstatNow = (p: any): any => {
    const r = realParent(p);
    const link = ctx.fs.readlinkCached?.(r);
    if (typeof link === 'string') {
      const node = ctx.fs.lookupCached?.(r, false)?.node;
      return makeStats({ type: 'symlink', size: new TextEncoder().encode(link).length, mtimeMs: node?.mtime ?? Date.now(), mode: 0o777, ino: inodeOf(r) });
    }
    return statNow(r);
  };
  /** A node Stats from the filesystem's own stat (what memory couldn't answer) */
  const fromFsStat = (st: any, r: string, link = false): any => makeStats({
    type: link && st.isSymbolicLink?.() ? 'symlink' : st.isDirectory?.() ? 'dir' : 'file',
    size: st.size ?? 0, mtimeMs: st.mtimeMs ?? st.mtime?.getTime?.() ?? Date.now(), mode: st.mode ?? 0o644, ino: inodeOf(r),
  });
  const statAsync = async (p: any, link: boolean): Promise<any> => {
    const r = link ? realParent(p) : real(p);
    const now = link ? lstatNow(p) : statNow(r);
    if (now) return now;
    if (now === null) throw fsError('ENOENT', `ENOENT: no such file or directory, ${link ? 'lstat' : 'stat'} '${p}'`, link ? 'lstat' : 'stat', String(p));
    try {
      const st = link ? await ctx.fs.lstat(r) : await ctx.fs.stat(r);
      return fromFsStat(st, link ? r : (await ctx.fs.realpath(r).catch(() => r)), link);
    } catch {
      throw fsError('ENOENT', `ENOENT: no such file or directory, ${link ? 'lstat' : 'stat'} '${p}'`, link ? 'lstat' : 'stat', String(p));
    }
  };
  /** Data for writeFile/appendFile: a string in a non-UTF-8 encoding becomes its bytes */
  const encodeData = (data: any, encoding?: string): any => {
    if (typeof data === 'string' && encoding && !/^utf-?8$/i.test(encoding)) return FakeBuffer.from(data, encoding);
    if (data !== null && typeof data === 'object' && !ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer) && typeof data.toString === 'function' && data.toString !== Object.prototype.toString) return String(data);
    return data;
  };
  /** A mode given at creation: kept for stat now, stored once the writes land */
  const applyMode = (r: string, mode: number | undefined) => {
    if (mode === undefined) return;
    const m = mode & 0o7777 & ~0o022; // the process umask
    pendingModes.set(r, m);
    // A microtask on, so the write the caller queues next lands before the chmod
    queueMicrotask(() => inflight.push(chmodAfterWrites(deps, r, m).catch(() => {}).finally(() => { if (pendingModes.get(r) === m) pendingModes.delete(r); })));
  };
  const writeChains = writeState.chains;
  const inflight = { push: writeState.push };
  // A kernel guest's filesystem calls are blocking syscalls: do the write now, so a
  // child process started right after (a really blocking execSync) sees it
  const writeNowToo = !!nodeGuestOf(ctx);
  const queueWrite = (path: string, op: () => Promise<unknown>): Promise<void> => {
    if (writeNowToo) {
      let r: Promise<unknown>;
      try { r = op(); } catch (e) { r = Promise.reject(e); }
      // the mode writeFileSync(p, d, { mode }) asked for, now too (a child may exec the file next)
      const m = pendingModes.get(path);
      if (m !== undefined) { try { (ctx.fs as any).chmodSync(path, m); } catch { /* not there */ } }
      const done = Promise.resolve(r).then(() => {}, () => {});
      inflight.push(done);
      return done;
    }
    const next = (writeChains.get(path) ?? Promise.resolve()).then(op).then(() => {}, () => {});
    writeChains.set(path, next);
    inflight.push(next);
    return next;
  };
  const materializeOpenFile = (resolved: string) => {
    const content = fileCache.get(resolved) || '';
    const parentDir = resolved.substring(0, resolved.lastIndexOf('/')) || '/';
    if (writeNowToo) {
      // a guest: both syscalls now, in order (an await between them landed the write later)
      try { (ctx.fs as any).mkdirSync(parentDir, true); } catch { /* there, or the write says why */ }
      queueWrite(resolved, () => ctx.fs.writeFile(resolved, content));
      return;
    }
    queueWrite(resolved, async () => {
      await ctx.fs.mkdir(parentDir, { recursive: true }).catch(() => {});
      await ctx.fs.writeFile(resolved, content);
    });
  };

  /** mkdir's `mode` for each directory the call creates (the filesystem's mkdir takes none) */
  const mkdirModes = (resolved: string, opts: any): (() => void) => {
    const m = typeof opts === 'object' ? opts?.mode : opts; // mkdir(p, mode) or mkdir(p, { mode })
    const mode = m === undefined || m === null ? undefined : typeof m === 'string' ? parseInt(m, 8) : Number(m);
    if (mode === undefined) return () => {};
    const made: string[] = [];
    if (opts?.recursive) {
      for (let cur = resolved; cur && cur !== '/' && !existsNow(cur); cur = cur.slice(0, cur.lastIndexOf('/'))) made.push(cur);
    } else if (!existsNow(resolved)) made.push(resolved);
    return () => { for (const d of made) applyMode(d, mode); };
  };
  /**
   * Before an async open or write of `p` with `flags`: what only storage knows
   * about it, settled (EEXIST for an exclusive create, ENOENT for a missing
   * file without O_CREAT, and its text loaded when it is kept), so the sync
   * shim's checks and caching hold.
   */
  const settleExisting = async (p: any, flags: any, syscall = 'open') => {
    const r = real(p);
    if (existsNow(r) !== undefined) return;
    const fl = parseOpenFlags(flags);
    const there = await ctx.fs.exists(r);
    if (!there && !fl.create) throw fsError('ENOENT', `ENOENT: no such file or directory, ${syscall} '${p}'`, syscall, String(p));
    if (there && fl.create && fl.excl) throw fsError('EEXIST', `EEXIST: file already exists, ${syscall} '${p}'`, syscall, String(p));
    if (there && !fl.trunc && !fileCache.has(r)) {
      const d = await ctx.fs.readFile(r).catch(() => undefined);
      const text = d === undefined ? null : typeof d === 'string' ? d : decodeUtf8Strict(d);
      if (text !== null && !fileCache.has(r)) fileCache.set(r, text);
    }
  };
  /** writeFile/appendFile for the callback and promise APIs: the sync shim, then the write landing */
  const writeFileAsync = async (p: any, data: any, opts: any, append: boolean) => {
    if (p && typeof p === 'object' && typeof p.fd === 'number') p = p.fd; // a FileHandle
    if (typeof p !== 'number') await settleExisting(p, writeOptions(opts, append ? 'a' : 'w').flag);
    if (append) fsShim.appendFileSync(p, data, opts); else fsShim.writeFileSync(p, data, opts);
    const path = typeof p === 'number' ? (globalThis as any).__shiroFds?.[p]?.path : real(p);
    if (path) await Promise.allSettled([writeChains.get(path)]);
  };
  const openAsync = async (p: any, flags: any, mode?: any): Promise<number> => {
    await settleExisting(p, flags ?? 'r');
    return fsShim.openSync(p, flags ?? 'r', mode);
  };
  const mkdirAsync = async (p: any, opts: any) => {
    const resolved = ctx.fs.resolvePath(pathArg(p), ctx.cwd);
    const setModes = mkdirModes(resolved, opts);
    await ctx.fs.mkdir(resolved, typeof opts === 'object' ? opts : undefined);
    setModes();
  };
  const symlinkAsync = async (target: any, path: any) => {
    const r = realParent(path);
    if (existsNow(r) === undefined && typeof ctx.fs.readlinkCached?.(r) !== 'string' && await ctx.fs.lstat(r).then(() => true, () => false)) {
      throw fsError('EEXIST', `EEXIST: file already exists, symlink '${target}' -> '${path}'`, 'symlink', String(path));
    }
    fsShim.symlinkSync(target, path);
    await Promise.allSettled([...writeState.inflight]);
  };

  // Synchronous shims that use cached data or throw
  const fsShim: any = {
    readFileSync: (p: string, opts?: any) => {
      tickSyncOps();
      // stdin (fd 0, /dev/stdin): what has arrived; a script that reads it so gets it loaded first (execution.ts)
      const fd0 = ((p as unknown) === 0 && !(globalThis as any).__shiroFds?.[0]) || p === '/dev/stdin' ? deps.getProcess?.()?.stdin?.__fd0 : null;
      if (fd0) {
        const bytes = deps.FakeBuffer.from(fd0.takeAll());
        const enc = typeof opts === 'string' ? opts : opts?.encoding;
        return enc ? bytes.toString(enc) : bytes;
      }
      if (typeof p === 'number') {
        const fdPath = (globalThis as any).__shiroFds?.[p]?.path;
        if (!fdPath) throw fsError('EBADF', 'EBADF: bad file descriptor, read', 'read');
        return fsShim.readFileSync(fdPath, opts);
      }
      const resolved = real(p);
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
    writeFileSync: (p: string | number, data: string | Uint8Array, opts?: any) => {
      tickSyncOps();
      const o = writeOptions(opts, 'w');
      data = encodeData(data, o.encoding);
      if (typeof p === 'number') { fsShim.writeSync(p, data); return; }
      const f = parseOpenFlags(o.flag);
      if (f.append) { fsShim.appendFileSync(p, data, { mode: o.mode, flag: o.flag }); return; }
      const resolved = real(p);
      const existed = existsNow(resolved);
      if (f.excl && existed) throw fsError('EEXIST', `EEXIST: file already exists, open '${p}'`, 'open', String(p));
      if (!existed) applyMode(resolved, o.mode);
      const strData = storeData(resolved, data, { push: (w) => queueWrite(resolved, () => w) });
      if (strData === null) return; // binary: written through the byte cache
      fileCache.set(resolved, strData);
      fileMtimes.set(resolved, Date.now());
      // Skip IDB write for .tmp files — they're transient atomic-write intermediaries.
      // The data reaches IDB via renameSync which writes to the final path.
      // (A kernel guest's rename is rename(2): the file has to be there.)
      if (writeNowToo || !resolved.includes('.tmp.')) {
        queueWrite(resolved, () => ctx.fs.writeFile(resolved, strData));
      }
      // localStorage WAL for critical config files (survives page close before IndexedDB flushes)
      // Skip .tmp files — they'll be WAL'd when renamed to their final name
      if ((resolved.startsWith(homeDir + '/.claude') || resolved === homeDir + '/.claude.json') && !resolved.includes('.tmp.')) {
        try { localStorage.setItem('wal:' + resolved, strData); } catch {}
      }
    },
    existsSync: (p: string) => {
      tickSyncOps();
      if (typeof p !== 'string' && !(p as any instanceof URL) && !ArrayBuffer.isView(p)) return false;
      const resolved = real(p);
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
      const resolved = real(p);
      // Text of a file other processes wrote: promoted to the cache (binary stays bytes)
      if (!fileCache.has(resolved)) {
        const bytes = ctx.fs.readBytesCached(resolved);
        const text = bytes === undefined ? null : decodeUtf8Strict(bytes);
        if (text !== null) fileCache.set(resolved, text);
      }
      const st = statNow(resolved);
      if (!st) {
        if (opts?.throwIfNoEntry === false) return undefined;
        throw fsError('ENOENT', `ENOENT: no such file or directory, stat '${p}'`, 'stat', String(p));
      }
      return st;
    },
    readdirSync: (p: string, opts?: any) => {
      tickSyncOps();
      const resolved = ctx.fs.resolvePath(pathArg(p), ctx.cwd);
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
          // Detect directories from Shiro FS cache (readdirCached returns entries for dirs);
          // only withFileTypes asks
          if (opts?.withFileTypes && !dirSet.has(name)) {
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
      const resolved = ctx.fs.resolvePath(pathArg(p), ctx.cwd);
      const setModes = mkdirModes(resolved, opts);
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
      setModes();
    },
    unlinkSync: (p: string) => {
      const resolved = ctx.fs.resolvePath(pathArg(p), ctx.cwd);
      fileCache.delete(resolved);
      fileMtimes.delete(resolved);
      // readdirSync/existsSync also consult the filesystem's cache; drop it there now,
      // not when the async delete lands, or the file keeps being listed
      inflight.push(ctx.fs.unlinkNow(resolved).catch(() => {}));
    },
    // No hard links in Shiro's filesystem: link() copies, which is what callers
    // (atomic-write helpers, lockfiles) need from it
    linkSync: (src: string, dst: string) => {
      const resolvedDst = ctx.fs.resolvePath(pathArg(dst), ctx.cwd);
      if (fileCache.has(resolvedDst) || ctx.fs.readBytesCached(resolvedDst) !== undefined) {
        const err: any = new Error(`EEXIST: file already exists, link '${src}' -> '${dst}'`);
        err.code = 'EEXIST'; err.errno = -17; err.syscall = 'link';
        throw err;
      }
      fsShim.copyFileSync(src, dst);
    },
    copyFileSync: (src: string, dst: string) => {
      const srcRes = ctx.fs.resolvePath(pathArg(src), ctx.cwd);
      const dstRes = ctx.fs.resolvePath(pathArg(dst), ctx.cwd);
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
      // among them) have landed (a guest's have: copy now)
      if (writeNowToo) {
        const data = (ctx.fs as any).readSync(srcRes);
        (ctx.fs as any).writeSync(dstRes, data);
        return;
      }
      const waitFor = [...writeState.inflight];
      queueWrite(dstRes, () => Promise.allSettled(waitFor).then(() => ctx.fs.readFile(srcRes)).then((data: any) => ctx.fs.writeFile(dstRes, data)));
    },
    renameSync: (oldP: string, newP: string) => {
      const oldRes = ctx.fs.resolvePath(pathArg(oldP), ctx.cwd);
      const newRes = ctx.fs.resolvePath(pathArg(newP), ctx.cwd);
      if (writeNowToo) {
        // A kernel guest: one rename(2), at once; the cache reads both paths again
        (ctx.fs as any).renameSync(oldRes, newRes);
        for (const k of [...fileCache.keys()]) if (k === oldRes || k === newRes || k.startsWith(oldRes + '/') || k.startsWith(newRes + '/')) fileCache.delete(k);
        return;
      }
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
      const r = real(p);
      if (existsNow(r) === false || (existsNow(r) === undefined && ctx.fs.realpathCached?.(r) === undefined)) {
        throw fsError('ENOENT', `ENOENT: no such file or directory, realpath '${p}'`, 'realpath', String(p));
      }
      return r;
    },
    accessSync: (p: string) => {
      tickSyncOps();
      if (existsNow(real(p)) === false) throw fsError('ENOENT', `ENOENT: no such file or directory, access '${p}'`, 'access', String(p));
    },
    lstatSync: (p: string, opts?: any) => {
      tickSyncOps();
      const st = lstatNow(p);
      if (!st) {
        if (opts?.throwIfNoEntry === false) return undefined;
        throw fsError('ENOENT', `ENOENT: no such file or directory, lstat '${p}'`, 'lstat', String(p));
      }
      return st;
    },
    // Modes are kept (pnpm and cmd-shim make their bin shims executable)
    chmodSync: (p: string, mode: any) => {
      const resolved = ctx.fs.resolvePath(pathArg(p), ctx.cwd);
      if (writeNowToo) { (ctx.fs as any).chmodSync(resolved, parseMode(mode)); return; } // a guest: chmod(2) now
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
    openSync: (p: string, flags?: string | number, mode?: any) => {
      const resolved = real(p);
      const fl = parseOpenFlags(flags);
      const exists = existsNow(resolved);
      // O_CREAT|O_EXCL ('wx') on an existing file, or a missing file without O_CREAT, fail
      if (fl.create && fl.excl && exists) throw fsError('EEXIST', `EEXIST: file already exists, open '${p}'`, 'open', String(p));
      if (!fl.create && exists === false) throw fsError('ENOENT', `ENOENT: no such file or directory, open '${p}'`, 'open', String(p));
      const fd = 100 + Math.floor(Math.random() * 9900);
      // Store mapping for writeSync/readSync/closeSync ('w' truncated, 'a' appends, 'r' reads)
      (globalThis as any).__shiroFds = (globalThis as any).__shiroFds || {};
      const f = fl.append ? 'a' : fl.write ? (fl.trunc ? 'w' : 'r+') : 'r';
      (globalThis as any).__shiroFds[fd] = { path: resolved, flags: f, offset: 0 };
      if (fl.trunc || (fl.create && !exists)) {
        if (fl.trunc || !fileCache.has(resolved)) {
          fileCache.set(resolved, ''); // truncate, or create a missing file
        }
        fileMtimes.set(resolved, Date.now());
        // Ensure parent dirs exist in fileCache
        const parentDir = resolved.substring(0, resolved.lastIndexOf('/'));
        if (parentDir && !fileCache.has(parentDir + '/.')) {
          fileCache.set(parentDir + '/.', '');
          inflight.push(ctx.fs.mkdir(parentDir, { recursive: true }).catch(() => {}));
        }
        if (!exists) applyMode(resolved, typeof mode === 'string' ? parseInt(mode, 8) : mode);
        materializeOpenFile(resolved);
      }
      return fd;
    },
    writeSync: (fd: number, data: string | Uint8Array) => {
      const fdInfo = (globalThis as any).__shiroFds?.[fd];
      // fds 1 and 2: the process's stdout and stderr (Go's runtime writes them so: esbuild)
      if (!fdInfo && (fd === 1 || fd === 2)) {
        const proc = deps.getProcess?.();
        const bytes = typeof data === 'string' ? data : toBytes(data) ?? new Uint8Array(0);
        (fd === 1 ? proc?.stdout : proc?.stderr)?.write(bytes);
        return typeof bytes === 'string' ? new TextEncoder().encode(bytes).length : bytes.length;
      }
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
      if (!fdInfo && fd === 0) {
        // stdin: what has arrived; a pipe with nothing yet is EAGAIN, as a nonblocking one
        const fd0 = deps.getProcess?.()?.stdin?.__fd0;
        if (!fd0) return 0;
        const off = typeof offset === 'object' && offset ? (offset as any).offset ?? 0 : offset ?? 0;
        const len = typeof offset === 'object' && offset ? (offset as any).length ?? buf.length - off : length ?? buf.length - off;
        const n = fd0.tryRead(buf, off, len);
        if (n === null) throw fsError('EAGAIN', 'EAGAIN: resource temporarily unavailable, read', 'read');
        return n;
      }
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
      const resolved = ctx.fs.resolvePath(pathArg(p), ctx.cwd);
      fileMtimes.set(resolved, timeMs(mtime));
      pendingPromises.push(ctx.fs.utimes(resolved, timeMs(atime), timeMs(mtime)).catch(() => {}));
    },
    rmSync: (p: string, opts?: any) => {
      const resolved = ctx.fs.resolvePath(pathArg(p), ctx.cwd);
      removePathFromCaches(resolved, !!opts?.recursive);
    },
    rmdirSync: (p: string) => {
      const resolved = ctx.fs.resolvePath(pathArg(p), ctx.cwd);
      ctx.fs.rmdir(resolved).catch(() => {});
    },
    appendFileSync: (p: string | number, data: string | Uint8Array, opts?: any) => {
      const o = writeOptions(opts, 'a');
      data = encodeData(data, o.encoding);
      // Node accepts an fd from openSync here (Claude's session log does this)
      if (typeof p === 'number') { fsShim.writeSync(p, data); return; }
      const resolved = real(p);
      const existed = existsNow(resolved);
      if (parseOpenFlags(o.flag).excl && existed) throw fsError('EEXIST', `EEXIST: file already exists, open '${p}'`, 'open', String(p));
      if (!existed) applyMode(resolved, o.mode);
      const bytes = toBytes(data);
      const prior = fileCache.has(resolved) ? undefined : ctx.fs.readBytesCached(resolved);
      if ((bytes && decodeUtf8Strict(bytes) === null) || (prior && decodeUtf8Strict(prior) === null)) {
        storeData(resolved, concatBytes(currentBytes(resolved), bytes ?? new TextEncoder().encode(String(data))), inflight);
        return;
      }
      const existing = fileCache.get(resolved) ?? ctx.fs.readCached(resolved) ?? '';
      const str = typeof data === 'string' ? data : new TextDecoder().decode(bytes!);
      const next = existing + str;
      fileCache.set(resolved, next);
      fileMtimes.set(resolved, Date.now());
      queueWrite(resolved, () => ctx.fs.writeFile(resolved, next));
    },
    // A real link, in the filesystem's cache at once (lstatSync, readlinkSync
    // and realpathSync see it); reads through it follow it
    symlinkSync: (target: string, path: string) => {
      const r = realParent(path);
      if (existsNow(r) || typeof ctx.fs.readlinkCached?.(r) === 'string') {
        throw fsError('EEXIST', `EEXIST: file already exists, symlink '${target}' -> '${path}'`, 'symlink', String(path));
      }
      const op = ctx.fs.symlinkNow ? ctx.fs.symlinkNow(String(target), r) : ctx.fs.symlink(String(target), r);
      inflight.push(op.catch(() => {}));
    },
    // Real streams over the file's bytes (yarn pipes downloaded tarballs into
    // createWriteStream; chunks used to be decoded as text)
    createReadStream: (p: string, opts?: any) => {
      const s = getBuiltinModule('stream');
      const o = typeof opts === 'string' ? { encoding: opts } : (opts || {});
      const resolved = ctx.fs.resolvePath(pathArg(p), ctx.cwd);
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
      const resolved = ctx.fs.resolvePath(pathArg(p), ctx.cwd);
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
        : ctx.fs.resolvePath(pathArg(p), ctx.cwd);
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
    writeFile: (p: any, data: any, optsOrCb?: any, cb?: any) => {
      const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
      writeFileAsync(p, data, typeof optsOrCb === 'function' ? undefined : optsOrCb, false).then(() => callback?.(null), (e) => callback?.(e));
    },
    stat: (p: any, optsOrCb?: any, cb?: any) => {
      const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
      statAsync(p, false).then((s) => callback?.(null, s), (e) => callback?.(e));
    },
    lstat: (p: any, optsOrCb?: any, cb?: any) => {
      const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
      statAsync(p, true).then((s) => callback?.(null, s), (e) => callback?.(e));
    },
    readdir: (p: string, optsOrCb?: any, cb?: any) => {
      const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
      const opts = typeof optsOrCb === 'object' ? optsOrCb : {};
      const resolved = ctx.fs.resolvePath(pathArg(p), ctx.cwd);
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
      mkdirAsync(p, typeof optsOrCb === 'function' ? undefined : optsOrCb).then(() => callback?.(null), (e: any) => callback?.(e));
    },
    unlink: (p: string, cb?: any) => {
      const resolved = ctx.fs.resolvePath(pathArg(p), ctx.cwd);
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
      const resolved = ctx.fs.resolvePath(pathArg(p), ctx.cwd);
      fileCache.delete(resolved + '/.');
      ctx.fs.rmdir(resolved)
        .then(() => callback?.(null))
        .catch((e: any) => callback?.(e));
    },
    rename: (oldP: string, newP: string, cb?: any) => {
      const oldRes = ctx.fs.resolvePath(pathArg(oldP), ctx.cwd);
      const newRes = ctx.fs.resolvePath(pathArg(newP), ctx.cwd);
      // Writes still in flight for the source land first (write-file-atomic:
      // write through an fd, then rename at once)
      renameAfterWrites(deps, oldRes, newRes).then(() => cb?.(null), (e: any) => cb?.(e));
    },
    access: (p: string, modeOrCb?: any, cb?: any) => {
      const callback = typeof modeOrCb === 'function' ? modeOrCb : cb;
      ctx.fs.exists(ctx.fs.resolvePath(pathArg(p), ctx.cwd))
        .then((exists: boolean) => exists ? callback?.(null) : callback?.(fsError('ENOENT', `ENOENT: no such file or directory, access '${p}'`, 'access', p)))
        .catch((e: any) => callback?.(e));
    },
    chmod: (p: string, mode: any, cb?: any) => {
      const resolved = ctx.fs.resolvePath(pathArg(p), ctx.cwd);
      chmodAfterWrites(deps, resolved, mode).then(() => cb?.(null), (e: any) => cb?.(e));
    },
    chown: (_p: string, _u: any, _g: any, cb?: any) => { cb?.(null); },
    symlink: (target: string, path: string, typeOrCb?: any, cb?: any) => {
      const callback = typeof typeOrCb === 'function' ? typeOrCb : cb;
      // the target is stored as given: a relative one resolves against the link's directory
      symlinkAsync(target, path).then(() => callback?.(null), (e: any) => callback?.(e));
    },
    readlink: (p: string, optsOrCb?: any, cb?: any) => {
      const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
      ctx.fs.readlink(ctx.fs.resolvePath(pathArg(p), ctx.cwd))
        .then((target: string) => callback?.(null, target))
        .catch((e: any) => callback?.(e));
    },
    // Claude Code writes config "through" a symlink when readlinkSync succeeds, so it
    // must throw EINVAL for regular files (a missing readlinkSync used to return '',
    // which resolved to the parent directory and aimed every config save at ~).
    readlinkSync: (p: string) => {
      const resolved = ctx.fs.resolvePath(pathArg(p), ctx.cwd);
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
    open: (p: any, flags: any, modeOrCb?: any, cb?: any) => {
      const callback = [flags, modeOrCb, cb].find((f) => typeof f === 'function');
      if (typeof flags === 'function') flags = 'r';
      openAsync(p, flags, typeof modeOrCb === 'function' ? undefined : modeOrCb).then((fd) => callback?.(null, fd), (e: any) => callback?.(e));
    },
    read: (fd: number, buf: any, off: number, len: number, pos: any, cb?: any) => {
      const fdInfo = (globalThis as any).__shiroFds?.[fd];
      const fd0 = !fdInfo && fd === 0 ? deps.getProcess?.()?.stdin?.__fd0 : null;
      if (fd0) {
        // stdin as it arrives (a child's pipe: esbuild's service reads its requests so)
        if (typeof off === 'function') { cb = off; off = 0; len = buf.length - 0; }
        // (a callback that calls process.exit, as Go's runtime does at the end, ends the script, not the page)
        const call = (...a: any[]) => { try { cb?.(...a); } catch (e) { if (!(e instanceof ProcessExitError)) throw e; } };
        fd0.read(buf, off ?? 0, len ?? buf.length - (off ?? 0)).then((n: number) => call(null, n, buf), (e: any) => call(e));
        return;
      }
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
      const srcRes = ctx.fs.resolvePath(pathArg(src), ctx.cwd);
      const dstRes = ctx.fs.resolvePath(pathArg(dst), ctx.cwd);
      const known = fileCache.has(srcRes) || ctx.fs.readBytesCached(srcRes) !== undefined;
      (known ? Promise.resolve(true) : Promise.allSettled([...writeState.inflight]).then(() => ctx.fs.exists(srcRes))).then((exists: boolean) => {
        if (!exists) { callback?.(fsError('ENOENT', `ENOENT: no such file or directory, copyfile '${src}' -> '${dst}'`, 'copyfile', String(src))); return; }
        fsShim.copyFileSync(src, dst);
        Promise.allSettled([writeChains.get(dstRes)]).then(() => callback?.(null));
      }, (e: any) => callback?.(e));
    },
    appendFile: (p: any, data: any, optsOrCb?: any, cb?: any) => {
      const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
      writeFileAsync(p, data, typeof optsOrCb === 'function' ? undefined : optsOrCb, true).then(() => callback?.(null), (e) => callback?.(e));
    },
    truncate: (p: string, lenOrCb?: any, cb?: any) => {
      const callback = typeof lenOrCb === 'function' ? lenOrCb : cb;
      ctx.fs.writeFile(ctx.fs.resolvePath(pathArg(p), ctx.cwd), '')
        .then(() => callback?.(null))
        .catch((e: any) => callback?.(e));
    },
    utimes: (p: string, atime: any, mtime: any, cb?: any) => {
      const resolved = ctx.fs.resolvePath(pathArg(p), ctx.cwd);
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
      const resolved = ctx.fs.resolvePath(pathArg(p), ctx.cwd);
      removePathFromCaches(resolved, !!opts?.recursive);
      queueMicrotask(() => callback?.(null));
    },
    opendir: (p: string, optsOrCb?: any, cb?: any) => {
      const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
      callback?.(null, { read: (readCb: any) => { readCb(null, null); }, close: (closeCb: any) => { closeCb?.(null); } });
    },
    exists: (p: string, cb?: any) => {
      ctx.fs.exists(ctx.fs.resolvePath(pathArg(p), ctx.cwd))
        .then((exists: boolean) => cb?.(exists))
        .catch(() => cb?.(false));
    },
    watch: (filename: any, options?: any, listener?: Function) => watchApi().watch(filename, options, listener),
    watchFile: (filename: any, options?: any, listener?: Function) => watchApi().watchFile(filename, options, listener),
    unwatchFile: (filename: any, listener?: Function) => watchApi().unwatchFile(filename, listener),
    // Async promises API
    promises: {
      link: async (src: string, dst: string) => { fsShim.linkSync(src, dst); },
      readFile: async (p: string | number, opts?: any) => {
        const resolved = typeof p === 'number'
          ? ((globalThis as any).__shiroFds?.[p]?.path || ctx.fs.resolvePath(pathArg(p), ctx.cwd))
          : ctx.fs.resolvePath(pathArg(p), ctx.cwd);
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
      readdir: async (p: string, opts?: any) => {
        const resolved = ctx.fs.resolvePath(pathArg(p), ctx.cwd);
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
      unlink: async (p: string) => { const r = ctx.fs.resolvePath(pathArg(p), ctx.cwd); fileCache.delete(r); fileMtimes.delete(r); return ctx.fs.unlink(r); },
      rm: async (p: string, opts?: any) => {
        const resolved = ctx.fs.resolvePath(pathArg(p), ctx.cwd);
        removePathFromCaches(resolved, !!opts?.recursive);
      },
      access: async (p: string) => {
        const resolved = ctx.fs.resolvePath(pathArg(p), ctx.cwd);
        if (fileCache.has(resolved) || fileCache.has(resolved + '/.') || [...fileCache.keys()].some(k => k.startsWith(resolved + '/')) || ctx.fs.readCached(resolved) !== undefined || fsDirCached(resolved)) return;
        const exists = await ctx.fs.exists(resolved);
        if (!exists) throw fsError('ENOENT', `ENOENT: no such file or directory, access '${p}'`, 'access', p);
      },
    },
  };
  Object.defineProperty(fsShim, ASYNC, { value: { writeFile: writeFileAsync, stat: statAsync, open: openAsync, symlink: symlinkAsync, mkdir: mkdirAsync } });
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
        // A callback still to come is activity (as fs.promises calls are): a
        // busy page could stretch the gap between two calls past idle-exit.
        // Bounded, so a call that never answers can't hold the script open.
        let settle!: () => void;
        deps.trackAsync?.(new Promise<void>((r) => { settle = r; PAGE_SET_TIMEOUT(r, 30_000); }));
        args[last] = (...r: any[]) => queueMicrotask(() => { settle(); cb(...r); });
      }
      return f.apply(this, args);
    };
    Object.assign(wrapped, f);
    fsShim[k] = wrapped;
  }
  return fsShim;
}

/** The fs module's async internals, which fs/promises shares (one write and mode state per script) */
const ASYNC = Symbol('shiro.fs.async');

const NOT_CALLBACK_API = new Set(['createReadStream', 'createWriteStream', 'watch', 'watchFile', 'unwatchFile', 'openAsBlob']);

export function createFsPromisesModule(deps: FsDeps): any {
  const { ctx, fileCache, fileMtimes, FakeBuffer, homeDir, getBuiltinModule } = deps;
  const fsDirCached = dirCachedChecker(deps);
  const { removePathFromCaches, toBytes, currentBytes, storeData, concatBytes } = createRemovalHelpers(ctx, fileCache, fileMtimes);

  /** The fs module's async internals: its write chains, pending modes and flag checks */
  const shared = () => getBuiltinModule('fs')[ASYNC];
  // Async fs promises API
  return {
    readFile: async (p: string | number, opts?: any) => {
      const resolved = typeof p === 'number'
        ? ((globalThis as any).__shiroFds?.[p]?.path || ctx.fs.resolvePath(pathArg(p), ctx.cwd))
        : ctx.fs.resolvePath(pathArg(p), ctx.cwd);
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
    writeFile: (p: any, data: any, opts?: any) => shared().writeFile(p, data, opts, false),
    readdir: async (p: string, opts?: any) => {
      const resolved = ctx.fs.resolvePath(pathArg(p), ctx.cwd);
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
    stat: (p: any) => shared().stat(p, false),
    mkdir: (p: any, opts?: any) => shared().mkdir(p, opts),
    unlink: async (p: string) => {
      const resolved = ctx.fs.resolvePath(pathArg(p), ctx.cwd);
      fileCache.delete(resolved);
      fileMtimes.delete(resolved);
      await ctx.fs.unlink(resolved);
    },
    rm: async (p: string, opts?: any) => {
      const resolved = ctx.fs.resolvePath(pathArg(p), ctx.cwd);
      removePathFromCaches(resolved, !!opts?.recursive);
    },
    access: async (p: string) => {
      const resolved = ctx.fs.resolvePath(pathArg(p), ctx.cwd);
      // Check fileCache/dirs before going to IDB
      if (fileCache.has(resolved) || fileCache.has(resolved + '/.') || [...fileCache.keys()].some(k => k.startsWith(resolved + '/')) || ctx.fs.readCached(resolved) !== undefined || fsDirCached(resolved)) return;
      const exists = await ctx.fs.exists(resolved);
      if (!exists) throw fsError('ENOENT', `ENOENT: no such file or directory, access '${p}'`, 'access', p);
    },
    lstat: (p: any) => shared().stat(p, true),
    chmod: async (p: string, mode: any) => {
      const resolved = ctx.fs.resolvePath(pathArg(p), ctx.cwd);
      await chmodAfterWrites(deps, resolved, mode);
    },
    rename: async (oldP: string, newP: string) => {
      const oldRes = ctx.fs.resolvePath(pathArg(oldP), ctx.cwd);
      const newRes = ctx.fs.resolvePath(pathArg(newP), ctx.cwd);
      await renameAfterWrites(deps, oldRes, newRes); // writes in flight land first
    },
    link: async (src: string, dst: string) => {
      const exists = await ctx.fs.exists(ctx.fs.resolvePath(pathArg(dst), ctx.cwd));
      if (exists) {
        const err: any = new Error(`EEXIST: file already exists, link '${src}' -> '${dst}'`);
        err.code = 'EEXIST'; err.errno = -17; err.syscall = 'link';
        throw err;
      }
      const data = await ctx.fs.readFile(ctx.fs.resolvePath(pathArg(src), ctx.cwd));
      await ctx.fs.writeFile(ctx.fs.resolvePath(pathArg(dst), ctx.cwd), data);
    },
    // fs.copyFile's (bytes, not text decoded: binary files came out mangled)
    copyFile: (src: string, dst: string) => new Promise<void>((resolve, reject) => {
      getBuiltinModule('fs').copyFile(src, dst, (e: any) => e ? reject(e) : resolve());
    }),
    appendFile: (p: any, data: any, opts?: any) => shared().writeFile(p, data, opts, true),
    symlink: (target: any, path: any) => shared().symlink(target, path),
    readlink: async (p: string) => {
      const resolved = ctx.fs.resolvePath(pathArg(p), ctx.cwd);
      return await ctx.fs.readlink(resolved);
    },
    realpath: async (p: string) => realpathAsync(deps, p),
    rmdir: async (p: string) => {
      const resolved = ctx.fs.resolvePath(pathArg(p), ctx.cwd);
      fileCache.delete(resolved + '/.');
      await ctx.fs.rmdir(resolved);
    },
    utimes: async (p: string, atime: any, mtime: any) => {
      const resolved = ctx.fs.resolvePath(pathArg(p), ctx.cwd);
      fileMtimes.set(resolved, timeMs(mtime));
      await ctx.fs.utimes(resolved, timeMs(atime), timeMs(mtime));
    },
    mkdtemp: async (prefix: string) => {
      const dir = `${prefix}${Math.random().toString(36).slice(2)}`;
      await ctx.fs.mkdir(dir, { recursive: true });
      return dir;
    },
    open: async (p: string, flags?: any, mode?: any) => {
      const resolved = ctx.fs.resolvePath(pathArg(p), ctx.cwd);
      // Register a real fd: Claude's Bash tool opens its output file here and
      // passes handle.fd as spawn stdio. With the old fd 0, spawn couldn't map
      // it to the file, so every command's output was dropped.
      const syncFs = getBuiltinModule('fs');
      const fd: number = await shared().open(p, flags ?? 'r', mode);
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
        writeFile: (data: any, opts?: any) => shared().writeFile(p, data, opts, false),
        close,
        stat: () => shared().stat(p, false),
        chmod: async () => {},
        sync: async () => {},
        datasync: async () => {},
      };
      // `await using` (Claude Code's bundled helper) requires a disposable handle
      handle[(Symbol as any).asyncDispose ?? Symbol.for('Symbol.asyncDispose')] = close;
      return handle;
    },
    watch: (p: any, opts?: any) => createWatchApi({ ctx, fileCache, getBuiltinModule, trackAsync: deps.trackAsync, atExit: deps.atExit }).promisesWatch(p, opts),
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_TRUNC: 512, O_APPEND: 1024, O_NONBLOCK: 2048, S_IFMT: 61440, S_IFREG: 32768, S_IFDIR: 16384, S_IFLNK: 40960 },
  };
}
