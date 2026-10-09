/**
 * fs.watch, fs.watchFile/unwatchFile and fs.promises.watch on the
 * filesystem's change hook (FileSystem.onChange), so writes from any process
 * reach them: this script, the shell, other node scripts, and kernel programs
 * (their files flush through FileSystem.writeFile). They were inert stubs, so
 * nodemon, vite's HMR, jest --watch and chokidar never saw a change.
 *
 * Events follow Linux inotify as node reports it: a file that appears is
 * 'rename' (then 'change' for its contents), a write to a known file is
 * 'change', and a removal, mkdir or either side of a rename is 'rename'.
 * filename is relative to a watched directory (a path under it when
 * recursive), or the file's own name. A persistent watcher keeps the script
 * alive until close() or unref(), as in node.
 */
import type { CommandContext } from '../../commands/index';

export interface WatchDeps {
  ctx: CommandContext;
  fileCache: Map<string, string>;
  getBuiltinModule: (name: string) => any;
  /** Counts a promise as the script's activity (a ref'd watcher keeps the script alive) */
  trackAsync?: <T>(p: Promise<T>) => Promise<T>;
  /** Registers cleanup for when the script ends */
  atExit?: (fn: () => void) => void;
}

type Change = { eventType: 'rename' | 'change'; filename: string };

const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

export function createWatchApi(deps: WatchDeps) {
  const { ctx, fileCache, getBuiltinModule } = deps;
  const fsMod = () => getBuiltinModule('fs');

  const enoent = (syscall: string, p: string) =>
    Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${p}'`), { code: 'ENOENT', errno: -2, syscall, path: p, filename: p });

  const isDir = (p: string) => !!(ctx.fs.isDirCached?.(p) || fileCache.has(p + '/.') ||
    [...fileCache.keys()].some((k) => k.startsWith(p + '/')));

  /** Paths that exist under (or at) `root` now, so a later write can tell a new file from a changed one. */
  const knownUnder = (root: string, recursive: boolean): Set<string> => {
    const known = new Set<string>([root]);
    const prefix = root === '/' ? '/' : root + '/';
    for (const k of fileCache.keys()) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length).replace(/\/\.$/, '');
      if (!rest || (!recursive && rest.includes('/'))) continue;
      known.add(prefix + rest);
    }
    const walk = (dir: string, depth: number) => {
      const names = ctx.fs.readdirCached?.(dir);
      if (!names) return;
      for (const n of names) {
        const p = (dir === '/' ? '' : dir) + '/' + n;
        if (known.size > 20000) return;
        known.add(p);
        if (recursive && depth < 32 && ctx.fs.isDirCached?.(p)) walk(p, depth + 1);
      }
    };
    walk(root, 0);
    return known;
  };

  /**
   * Subscribe to changes at `target` (a file, or a directory's entries).
   * `emit` gets each change, later (a microtask after the filesystem's).
   */
  const subscribe = (target: string, recursive: boolean, emit: (c: Change) => void): (() => void) => {
    const dirWatch = isDir(target);
    const known = knownUnder(target, dirWatch && recursive);
    const prefix = target === '/' ? '/' : target + '/';
    /** The filename to report for `p`, or null when it isn't watched */
    const nameFor = (p: string): string | null => {
      if (p === target) return baseOf(target);
      if (!dirWatch || !p.startsWith(prefix)) return null;
      const rel = p.slice(prefix.length);
      if (!recursive && rel.includes('/')) return null;
      return rel;
    };
    const queue = (eventType: Change['eventType'], filename: string) => queueMicrotask(() => emit({ eventType, filename }));
    return ctx.fs.onChange((event, path, newPath) => {
      for (const [p, gone] of [[path, event === 'delete' || event === 'rename'], [newPath, false]] as [string | undefined, boolean][]) {
        if (!p) continue;
        const name = nameFor(p);
        if (name === null) continue;
        if (event === 'write' && known.has(p)) { queue('change', name); continue; }
        if (event === 'write') { known.add(p); queue('rename', name); queue('change', name); continue; }
        if (gone) known.delete(p); else known.add(p);
        queue('rename', name);
      }
    });
  };

  /** A promise the script counts as activity until `release` runs (close or unref). */
  const keepAlive = () => {
    let release = () => {};
    deps.trackAsync?.(new Promise<void>((r) => { release = r; }));
    return () => release();
  };

  // ── fs.watch ──
  const watch = (filename: any, options?: any, listener?: Function) => {
    if (typeof options === 'function') { listener = options; options = {}; }
    if (typeof options === 'string') options = { encoding: options };
    options ??= {};
    const p = String(filename instanceof URL ? decodeURIComponent(filename.pathname) : filename);
    const resolved = ctx.fs.resolvePath(p, ctx.cwd);
    if (!fsMod().existsSync(resolved)) throw enoent('watch', p);
    const { EventEmitter } = getBuiltinModule('events');
    const w: any = new EventEmitter();
    if (listener) w.on('change', listener);
    const B = getBuiltinModule('buffer').Buffer;
    let closed = false;
    const unsubscribe = subscribe(resolved, !!options.recursive, ({ eventType, filename: name }) => {
      if (closed) return;
      w.emit('change', eventType, options.encoding === 'buffer' ? B.from(name) : name);
    });
    let release = options.persistent === false ? () => {} : keepAlive();
    w.close = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      release();
      queueMicrotask(() => w.emit('close'));
    };
    w.ref = () => { if (!closed && options.persistent !== false) { release(); release = keepAlive(); } return w; };
    w.unref = () => { release(); release = () => {}; return w; };
    deps.atExit?.(() => { if (!closed) { closed = true; unsubscribe(); } });
    return w;
  };

  // ── fs.watchFile / unwatchFile (stat comparison, driven by the same hook) ──
  const zeroStat = () => {
    const d = new Date(0);
    return { dev: 0, ino: 0, mode: 0, nlink: 0, uid: 0, gid: 0, rdev: 0, size: 0, blksize: 0, blocks: 0,
      atimeMs: 0, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0, atime: d, mtime: d, ctime: d, birthtime: d,
      isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false };
  };
  const statOf = async (p: string) => {
    try { return await fsMod().promises.stat(p); } catch { return zeroStat(); }
  };
  const fileWatchers = new Map<string, { listeners: Set<Function>; stop: () => void }>();
  const watchFile = (filename: any, options?: any, listener?: Function) => {
    if (typeof options === 'function') { listener = options; options = {}; }
    options ??= {};
    if (typeof listener !== 'function') throw Object.assign(new TypeError('The "listener" argument must be of type function'), { code: 'ERR_INVALID_ARG_TYPE' });
    const resolved = ctx.fs.resolvePath(String(filename), ctx.cwd);
    let entry = fileWatchers.get(resolved);
    if (!entry) {
      const listeners = new Set<Function>();
      let prev: any = null;
      let busy = Promise.resolve();
      void statOf(resolved).then((s) => { prev ??= s; });
      const unsubscribe = subscribe(resolved, false, () => {
        busy = busy.then(async () => {
          const curr = await statOf(resolved);
          const before = prev ?? zeroStat();
          prev = curr;
          if (curr.mtimeMs === before.mtimeMs && curr.size === before.size && curr.ino === before.ino && curr.mode === before.mode) return;
          for (const fn of [...listeners]) fn(curr, before);
        });
      });
      const release = options.persistent === false ? () => {} : keepAlive();
      entry = { listeners, stop: () => { unsubscribe(); release(); } };
      fileWatchers.set(resolved, entry);
      deps.atExit?.(() => entry!.stop());
    }
    entry.listeners.add(listener);
    const { EventEmitter } = getBuiltinModule('events');
    const sw: any = new EventEmitter();
    sw.ref = () => sw; sw.unref = () => sw;
    return sw;
  };
  const unwatchFile = (filename: any, listener?: Function) => {
    const resolved = ctx.fs.resolvePath(String(filename), ctx.cwd);
    const entry = fileWatchers.get(resolved);
    if (!entry) return;
    if (listener) entry.listeners.delete(listener); else entry.listeners.clear();
    if (!entry.listeners.size) { entry.stop(); fileWatchers.delete(resolved); }
  };

  // ── fs.promises.watch: an async iterator of { eventType, filename } ──
  const promisesWatch = (filename: any, options: any = {}) => {
    if (typeof options === 'string') options = { encoding: options };
    const resolved = ctx.fs.resolvePath(String(filename), ctx.cwd);
    if (!fsMod().existsSync(resolved)) throw enoent('watch', String(filename));
    const pending: Change[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    let unsubscribe = () => {};
    let release = () => {};
    const finish = () => { if (done) return; done = true; unsubscribe(); release(); wake?.(); };
    const start = () => {
      unsubscribe = subscribe(resolved, !!options.recursive, (c) => { pending.push(c); wake?.(); });
      if (options.persistent !== false) release = keepAlive();
      const signal: AbortSignal | undefined = options.signal;
      signal?.addEventListener('abort', finish, { once: true });
      deps.atExit?.(finish);
    };
    let started = false;
    const it: any = {
      async next(): Promise<IteratorResult<Change>> {
        if (!started) { started = true; start(); }
        for (;;) {
          if (options.signal?.aborted) {
            finish();
            throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
          }
          if (pending.length) return { value: pending.shift()!, done: false };
          if (done) return { value: undefined, done: true };
          await new Promise<void>((r) => { wake = r; });
          wake = null;
        }
      },
      async return(): Promise<IteratorResult<Change>> { finish(); return { value: undefined, done: true }; },
      [Symbol.asyncIterator]() { return it; },
    };
    return it;
  };

  return { watch, watchFile, unwatchFile, promisesWatch };
}
