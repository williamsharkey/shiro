function globPatternToRegex(pattern: string, base: string, caseInsensitive?: boolean): RegExp {
  // Resolve the pattern relative to base
  let fullPattern: string;
  if (pattern.startsWith('/')) {
    fullPattern = pattern;
  } else {
    fullPattern = (base === '/' ? '/' : base + '/') + pattern;
  }

  let regex = '^';
  let i = 0;
  while (i < fullPattern.length) {
    const ch = fullPattern[i];
    if (ch === '*' && fullPattern[i + 1] === '*') {
      if (fullPattern[i + 2] === '/') {
        regex += '(?:.*/)?';
        i += 3;
      } else {
        regex += '.*';
        i += 2;
      }
    } else if (ch === '*') {
      regex += '[^/]*';
      i++;
    } else if (ch === '?') {
      regex += '[^/]';
      i++;
    } else if (ch === '.') {
      regex += '\\.';
      i++;
    } else if (ch === '{') {
      // Handle brace expansion like {ts,tsx}
      const close = fullPattern.indexOf('}', i);
      if (close > i) {
        const options = fullPattern.slice(i + 1, close).split(',');
        regex += '(?:' + options.map(o => o.replace(/\./g, '\\.')).join('|') + ')';
        i = close + 1;
      } else {
        regex += '\\{';
        i++;
      }
    } else {
      regex += ch.replace(/[[\]()\\^$|+]/g, '\\$&');
      i++;
    }
  }
  regex += '$';
  return new RegExp(regex, caseInsensitive ? 'i' : undefined);
}

const DB_NAME = 'shiro-fs';
const DB_VERSION = 1;
const STORE_NAME = 'files';

export interface FSNode {
  path: string;
  type: 'file' | 'dir' | 'symlink';
  content: Uint8Array | null;
  mode: number;
  mtime: number;
  ctime: number;
  size: number;
  symlinkTarget?: string;
}

export interface StatResult {
  type: 'file' | 'dir' | 'symlink';
  mode: number;
  size: number;
  mtime: Date;
  ctime: Date;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

function makeStat(node: FSNode): StatResult {
  const mtime = new Date(node.mtime);
  const ctime = new Date(node.ctime);
  return {
    type: node.type,
    mode: node.mode,
    size: node.size,
    mtime,
    ctime,
    atime: mtime,
    birthtime: ctime,
    mtimeMs: mtime.getTime(),
    ctimeMs: ctime.getTime(),
    atimeMs: mtime.getTime(),
    birthtimeMs: ctime.getTime(),
    dev: 0,
    ino: 0,
    nlink: 1,
    uid: 1000,
    gid: 1000,
    rdev: 0,
    blksize: 4096,
    blocks: Math.ceil(node.size / 512),
    isFile() { return node.type === 'file'; },
    isDirectory() { return node.type === 'dir'; },
    isSymbolicLink() { return node.type === 'symlink'; },
    isBlockDevice() { return false; },
    isCharacterDevice() { return false; },
    isFIFO() { return false; },
    isSocket() { return false; },
  } as any;
}

/** Create an Error with a .code property for Node.js/isomorphic-git compatibility */
function fsError(code: string, message: string): Error {
  const err = new Error(message) as Error & { code: string; errno: number };
  err.code = code;
  // Add errno for isomorphic-git compatibility
  // Common errno values: ENOENT=-2, EISDIR=-21, ENOTDIR=-20, EEXIST=-17
  const errnos: Record<string, number> = {
    ENOENT: -2,
    EISDIR: -21,
    ENOTDIR: -20,
    EEXIST: -17,
    ENOTEMPTY: -39,
  };
  err.errno = errnos[code] || -1;
  return err;
}

export type FSChangeEvent = 'write' | 'delete' | 'mkdir' | 'rename';
export type FSChangeListener = (event: FSChangeEvent, path: string, newPath?: string) => void;

/**
 * Virtual filesystem provider for synthetic paths like /proc and /dev.
 */
export interface VirtualFSProvider {
  /** Check if this provider handles the given path */
  handles(path: string): boolean;
  /** Read file content (returns null if path is a directory) */
  readFile(path: string, encoding?: 'utf8'): string | Uint8Array | null;
  /** Stat a path (returns null if not found) */
  stat(path: string): StatResult | null;
  /** List directory entries (returns null if not a directory or not found) */
  readdir(path: string): string[] | null;
  /** Check existence */
  exists(path: string): boolean;
  /** Write (returns true if handled, even if silently discarded) */
  writeFile(path: string, data: Uint8Array | string): boolean;
}

/** /dev virtual provider */
class DevProvider implements VirtualFSProvider {
  handles(path: string): boolean {
    return path === '/dev/null' || path === '/dev/zero' || path === '/dev/random' || path === '/dev/urandom' || path === '/dev' || path === '/dev/stdin' || path === '/dev/stdout' || path === '/dev/stderr' || path === '/dev/fd';
  }
  readFile(path: string, encoding?: 'utf8'): string | Uint8Array | null {
    if (path === '/dev/null') return encoding === 'utf8' ? '' : new Uint8Array(0);
    if (path === '/dev/zero') return new Uint8Array(4096); // return a page of zeros
    if (path === '/dev/random' || path === '/dev/urandom') {
      const buf = new Uint8Array(256);
      crypto.getRandomValues(buf);
      return buf;
    }
    if (path === '/dev') return null; // directory
    return encoding === 'utf8' ? '' : new Uint8Array(0);
  }
  stat(path: string): StatResult | null {
    if (path === '/dev') return makeStat({ path, type: 'dir', content: null, mode: 0o755, mtime: 0, ctime: 0, size: 0 });
    if (this.handles(path)) return makeStat({ path, type: 'file', content: new Uint8Array(0), mode: 0o666, mtime: 0, ctime: 0, size: 0 });
    return null;
  }
  readdir(path: string): string[] | null {
    if (path === '/dev') return ['null', 'zero', 'random', 'urandom', 'stdin', 'stdout', 'stderr', 'fd'];
    return null;
  }
  exists(path: string): boolean { return this.handles(path); }
  writeFile(path: string): boolean {
    if (path === '/dev/null') return true; // silently discard
    return this.handles(path); // other dev files: accept but discard
  }
}

/** /proc virtual provider — dynamic system info from Shiro */
class ProcProvider implements VirtualFSProvider {
  private startTime = Date.now();

  private entries: Record<string, () => string> = {
    '/proc/uptime': () => {
      const secs = ((Date.now() - this.startTime) / 1000).toFixed(2);
      return `${secs} ${secs}\n`;
    },
    '/proc/version': () => `Linux version 6.1.0-shiro (shiro@browser) (TypeScript) #1 SMP ${new Date().toUTCString()}\n`,
    '/proc/meminfo': () => {
      const total = (typeof performance !== 'undefined' && (performance as any).memory?.jsHeapSizeLimit) || 256 * 1024 * 1024;
      const used = (typeof performance !== 'undefined' && (performance as any).memory?.usedJSHeapSize) || 64 * 1024 * 1024;
      const free = total - used;
      const toKB = (n: number) => Math.floor(n / 1024);
      return [
        `MemTotal:       ${toKB(total)} kB`,
        `MemFree:        ${toKB(free)} kB`,
        `MemAvailable:   ${toKB(free)} kB`,
        `Buffers:               0 kB`,
        `Cached:                0 kB`,
        `SwapTotal:             0 kB`,
        `SwapFree:              0 kB`,
      ].join('\n') + '\n';
    },
    '/proc/cpuinfo': () => {
      const cores = navigator?.hardwareConcurrency || 4;
      return Array.from({ length: cores }, (_, i) => [
        `processor\t: ${i}`,
        `model name\t: Shiro Virtual CPU`,
        `cpu MHz\t\t: 3000.000`,
        `cache size\t: 8192 KB`,
      ].join('\n')).join('\n\n') + '\n';
    },
    '/proc/loadavg': () => '0.00 0.00 0.00 1/1 1\n',
    '/proc/stat': () => 'cpu  0 0 0 0 0 0 0 0 0 0\n',
    '/proc/filesystems': () => 'nodev\tshirofs\n',
    '/proc/mounts': () => 'shirofs / shirofs rw 0 0\n',
    '/proc/self/status': () => [
      'Name:\tshiro',
      'State:\tR (running)',
      'Pid:\t1',
      'PPid:\t0',
      'Uid:\t1000\t1000\t1000\t1000',
      'Gid:\t1000\t1000\t1000\t1000',
    ].join('\n') + '\n',
    '/proc/self/cmdline': () => 'shiro\0',
    '/proc/self/cwd': () => '/home/user',
    '/proc/self/exe': () => '/usr/bin/shiro',
  };

  private dirs = ['/proc', '/proc/self'];

  handles(path: string): boolean {
    return path === '/proc' || path === '/proc/self' || path.startsWith('/proc/') && (path in this.entries || this.dirs.includes(path));
  }

  readFile(path: string, encoding?: 'utf8'): string | Uint8Array | null {
    if (this.dirs.includes(path)) return null;
    const gen = this.entries[path];
    if (!gen) return null;
    const content = gen();
    return encoding === 'utf8' ? content : new TextEncoder().encode(content);
  }

  stat(path: string): StatResult | null {
    if (this.dirs.includes(path)) return makeStat({ path, type: 'dir', content: null, mode: 0o555, mtime: Date.now(), ctime: this.startTime, size: 0 });
    if (path in this.entries) {
      const content = this.entries[path]();
      return makeStat({ path, type: 'file', content: new TextEncoder().encode(content), mode: 0o444, mtime: Date.now(), ctime: this.startTime, size: content.length });
    }
    return null;
  }

  readdir(path: string): string[] | null {
    if (path === '/proc') {
      const entries: string[] = [];
      for (const key of Object.keys(this.entries)) {
        const rest = key.slice('/proc/'.length);
        if (!rest.includes('/')) entries.push(rest);
      }
      entries.push('self');
      return [...new Set(entries)].sort();
    }
    if (path === '/proc/self') {
      const entries: string[] = [];
      for (const key of Object.keys(this.entries)) {
        if (key.startsWith('/proc/self/')) {
          entries.push(key.slice('/proc/self/'.length));
        }
      }
      return entries.sort();
    }
    return null;
  }

  exists(path: string): boolean { return this.handles(path); }
  writeFile(): boolean { return false; }
}

/** /var/log virtual provider — reads from ServiceManager's log buffer */
let _serviceManagerModule: { serviceManager: { getSyslog(): string } } | null = null;

class VarLogProvider implements VirtualFSProvider {
  private getSyslog(): string {
    // Access cached module or read from window global
    if (_serviceManagerModule) return _serviceManagerModule.serviceManager.getSyslog();
    if (typeof window !== 'undefined' && (window as any).__serviceManager?.getSyslog) {
      return (window as any).__serviceManager.getSyslog();
    }
    // Trigger lazy load for next time
    import('./service-manager').then(m => { _serviceManagerModule = m; }).catch(() => {});
    return '';
  }

  handles(path: string): boolean {
    return path === '/var/log' || path === '/var/log/syslog' || path === '/var/log/journal';
  }
  readFile(path: string, encoding?: 'utf8'): string | Uint8Array | null {
    if (path === '/var/log') return null; // directory
    const content = this.getSyslog();
    return encoding === 'utf8' ? content : new TextEncoder().encode(content);
  }
  stat(path: string): StatResult | null {
    if (path === '/var/log') return makeStat({ path, type: 'dir', content: null, mode: 0o755, mtime: Date.now(), ctime: 0, size: 0 });
    if (path === '/var/log/syslog' || path === '/var/log/journal') {
      return makeStat({ path, type: 'file', content: new Uint8Array(0), mode: 0o644, mtime: Date.now(), ctime: 0, size: 0 });
    }
    return null;
  }
  readdir(path: string): string[] | null {
    if (path === '/var/log') return ['syslog', 'journal'];
    return null;
  }
  exists(path: string): boolean { return this.handles(path); }
  writeFile(): boolean { return false; }
}

/** Files every Unix system has, created when missing. */
const BASE_ETC_FILES: Record<string, string> = {
  '/etc/passwd': 'root:x:0:0:root:/root:/bin/sh\nuser:x:1000:1000:Shiro User:/home/user:/bin/sh\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n',
  '/etc/group': 'root:x:0:\ntty:x:5:user\nuser:x:1000:\nnogroup:x:65534:\n',
  '/etc/hostname': 'shiro\n',
  '/etc/hosts': '127.0.0.1\tlocalhost shiro\n::1\tlocalhost ip6-localhost ip6-loopback\n',
  '/etc/shells': '/bin/sh\n/bin/bash\n',
};

/** Run fn as a macrotask without timer clamping/throttling (MessageChannel),
 *  falling back to setTimeout where there is none. */
const scheduleMacrotask: (fn: () => void) => void = (() => {
  if (typeof MessageChannel === 'undefined') return (fn: () => void) => { setTimeout(fn, 0); };
  const queue: Array<() => void> = [];
  let ch: MessageChannel | null = null;
  return (fn: () => void) => {
    if (!ch) {
      ch = new MessageChannel();
      ch.port1.onmessage = () => { const f = queue.shift(); f?.(); };
      // Node (vitest): don't keep the process alive for an idle port
      (ch.port1 as any).unref?.();
      (ch.port2 as any).unref?.();
    }
    queue.push(fn);
    ch.port2.postMessage(0);
  };
})();

/** The node as IndexedDB should store it: a view into a larger buffer is
 *  copied out, since IndexedDB clones the whole ArrayBuffer behind it. */
function storableNode(node: FSNode): FSNode {
  const c = node.content;
  if (c && (c.byteOffset !== 0 || c.byteLength !== c.buffer.byteLength)) return { ...node, content: c.slice() };
  return node;
}

/**
 * IndexedDB-backed filesystem with an in-memory node cache and write-behind.
 *
 * Mutations update the cache immediately and resolve; the IndexedDB writes are
 * queued (`_dirty`, latest value per path wins) and committed in ONE readwrite
 * transaction per flush. A flush is scheduled as a macrotask after the first
 * dirty write, so a burst of writes (npm install, `echo >> f` in a loop, a
 * shell history update per command) costs one transaction instead of one per
 * write. Only one flush transaction is in flight at a time; writes made while
 * it commits go into the next one.
 *
 * Crash safety: a write is durable once the flush that carries it commits,
 * normally within one event-loop turn. `sync()` (the `sync` command, kernel
 * fsync) waits for that with strict durability. The page flushes on
 * `visibilitychange` → hidden, `pagehide` and `freeze`, and `beforeunload`
 * warns while `pendingWrites > 0`. A tab or browser crash can lose writes
 * from the last moment before the flush (unlike a real disk's page cache, not
 * seconds' worth). Each flush is one transaction, so after a crash either
 * all of its writes are on disk or none are.
 */
export class FileSystem {
  private db: IDBDatabase | null = null;
  private cache: Map<string, FSNode | undefined> = new Map();
  /** Writes not yet handed to IndexedDB: path → node, or null for a delete. */
  private _dirty: Map<string, FSNode | null> = new Map();
  /** The batch being committed by the in-flight flush transaction. */
  private _inflight: Map<string, FSNode | null> | null = null;
  private _flushing: Promise<void> | null = null;
  private _flushScheduled = false;
  /** First error from a failed background flush, reported by the next sync(). */
  private _flushError: unknown = null;
  private _changeListeners: Set<FSChangeListener> = new Set();
  private virtualProviders: VirtualFSProvider[] = [new DevProvider(), new ProcProvider(), new VarLogProvider()];

  /** Subscribe to filesystem change events. Returns unsubscribe function. */
  onChange(listener: FSChangeListener): () => void {
    this._changeListeners.add(listener);
    return () => { this._changeListeners.delete(listener); };
  }

  private _emitChange(event: FSChangeEvent, path: string, newPath?: string): void {
    for (const fn of this._changeListeners) {
      try { fn(event, path, newPath); } catch {}
    }
  }

  async init(): Promise<void> {
    this.db = await this._openDb();
    this._installLifecycleFlush();

    // Ensure root directory exists
    const root = await this._get('/');
    if (!root) {
      await this._put(this._makeNode('/', 'dir'));
    }

    // Ensure basic directories exist
    for (const dir of ['/home', '/tmp', '/home/user', '/etc']) {
      const existing = await this._get(dir);
      if (!existing) {
        await this._put(this._makeNode(dir, 'dir'));
      }
    }
    // The account database Unix programs look themselves up in (getpwuid:
    // ssh, git, vim's ~ expansion). The kernel runs everything as uid 1000.
    for (const [path, text] of Object.entries(BASE_ETC_FILES)) {
      if (!(await this._get(path))) await this._put(this._makeNode(path, 'file', new TextEncoder().encode(text)));
    }
  }

  private _makeNode(path: string, type: 'file' | 'dir', content?: Uint8Array): FSNode {
    const now = Date.now();
    return {
      path,
      type,
      content: content || null,
      mode: type === 'dir' ? 0o755 : 0o644,
      mtime: now,
      ctime: now,
      size: content ? content.length : 0,
    };
  }

  private _opening: Promise<IDBDatabase> | null = null;
  private _lifecycleInstalled = false;

  /** Writes made but not yet committed to IndexedDB. */
  get pendingWrites(): number { return this._dirty.size + (this._inflight?.size ?? 0); }

  /** Flush when the page may be about to go away: hidden (tab switch, mobile
   *  backgrounding — often the last chance before a kill), pagehide, freeze. */
  private _installLifecycleFlush(): void {
    if (this._lifecycleInstalled || typeof window === 'undefined' || typeof document === 'undefined') return;
    if (typeof window.addEventListener !== 'function' || typeof document.addEventListener !== 'function') return;
    this._lifecycleInstalled = true;
    const flush = () => { if (this.pendingWrites > 0) void this.sync().catch(() => {}); };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
    window.addEventListener('pagehide', flush);
    document.addEventListener('freeze', flush);
  }

  private _openDb(): Promise<IDBDatabase> {
    if (this._opening) return this._opening;
    this._opening = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'path' });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // The browser can close the connection under us (storage pressure,
        // another tab upgrading, devtools "clear storage"). Drop the handle so
        // the next operation reopens instead of failing with "The database
        // connection is closing" forever.
        db.onclose = () => { if (this.db === db) this.db = null; };
        db.onversionchange = () => { db.close(); if (this.db === db) this.db = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => console.warn('[fs] IndexedDB open blocked by another connection');
    }).finally(() => { this._opening = null; });
    return this._opening;
  }

  private async _getDb(): Promise<IDBDatabase> {
    if (!this.db) this.db = await this._openDb();
    return this.db;
  }

  private static _isClosedError(e: unknown): boolean {
    const name = (e as any)?.name;
    return name === 'InvalidStateError' || name === 'TransactionInactiveError'
      || (name === 'AbortError' && /clos/i.test(String((e as any)?.message)));
  }

  /** Run one request against the store, reopening the database once if the
   *  connection was closed. Every request here is idempotent (get/put/delete
   *  by key), so retrying after an abort is safe. */
  private async _request<T>(mode: IDBTransactionMode, make: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const db = this.db ?? await this._getDb();
        return await new Promise<T>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, mode);
          const req = make(tx.objectStore(STORE_NAME));
          // Reads settle on the request; writes wait for the commit so an
          // abort after onsuccess isn't reported as a saved write.
          if (mode === 'readwrite') tx.oncomplete = () => resolve(req.result);
          else req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
          tx.onabort = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'));
        });
      } catch (e) {
        if (attempt > 0 || !FileSystem._isClosedError(e)) throw e;
        console.warn('[fs] IndexedDB connection lost, reopening:', (e as any)?.message);
        if (this.db) { try { this.db.close(); } catch {} }
        this.db = null;
      }
    }
  }

  /** Queue a put (node) or delete (null) for the next flush. */
  private _queue(path: string, node: FSNode | null): void {
    this._dirty.set(path, node);
    if (!this._flushScheduled && !this._flushing) {
      this._flushScheduled = true;
      scheduleMacrotask(() => { this._flushScheduled = false; void this._flush(); });
    }
  }

  /** Commit everything dirty in one transaction; loops while new writes arrive. */
  private _flush(durability: 'default' | 'strict' | 'relaxed' = 'relaxed'): Promise<void> {
    if (this._flushing) return this._flushing;
    if (this._dirty.size === 0) return Promise.resolve();
    const run = async () => {
      while (this._dirty.size > 0) {
        const batch = this._dirty;
        this._dirty = new Map();
        this._inflight = batch;
        try {
          await this._commit(batch, durability);
        } catch (e) {
          // Keep the cache (the session goes on with what the user wrote) but
          // report it; the next sync() rejects with it.
          console.error('[fs] IndexedDB write failed:', e);
          if (!this._flushError) this._flushError = e;
        } finally {
          this._inflight = null;
        }
      }
    };
    this._flushing = run().finally(() => { this._flushing = null; });
    return this._flushing;
  }

  private async _commit(batch: Map<string, FSNode | null>, durability: 'default' | 'strict' | 'relaxed'): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        const db = this.db ?? await this._getDb();
        await new Promise<void>((resolve, reject) => {
          let tx: IDBTransaction;
          try {
            tx = db.transaction(STORE_NAME, 'readwrite', { durability });
          } catch (e) {
            // Engines without the options bag
            if ((e as any)?.name !== 'TypeError') throw e;
            tx = db.transaction(STORE_NAME, 'readwrite');
          }
          const store = tx.objectStore(STORE_NAME);
          for (const [path, node] of batch) {
            if (node) store.put(storableNode(node));
            else store.delete(path);
          }
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'));
        });
        return;
      } catch (e) {
        if (attempt > 0 || !FileSystem._isClosedError(e)) throw e;
        console.warn('[fs] IndexedDB connection lost, reopening:', (e as any)?.message);
        if (this.db) { try { this.db.close(); } catch {} }
        this.db = null;
      }
    }
  }

  /** Start committing queued writes now; resolves when the queue is empty
   *  (relaxed durability). For writers that pace themselves by the commits. */
  flushed(): Promise<void> {
    return this._flush();
  }

  /**
   * Wait until every write made so far is committed to IndexedDB (strict
   * durability). Rejects with the error of a failed background flush, once.
   */
  async sync(): Promise<void> {
    while (this._flushing || this._dirty.size > 0) {
      if (this._flushing) await this._flushing;
      else await this._flush('strict');
    }
    if (this._flushError) {
      const e = this._flushError;
      this._flushError = null;
      throw e;
    }
  }

  private async _get(path: string): Promise<FSNode | undefined> {
    if (this.cache.has(path)) {
      return this.cache.get(path);
    }
    // The key index is complete once loaded: a path not in it doesn't exist
    // (creating a file then needs no IndexedDB read for the "existing" check)
    if (this._allKeys) {
      if (!this._allKeys.has(path)) { this.cache.set(path, undefined); return undefined; }
    } else if (!this._keysLoading) {
      void this._getAllKeys().catch(() => {});
    }
    const result = await this._request('readonly', store => store.get(path) as IDBRequest<FSNode | undefined>);
    // A write or delete made while the read was pending is newer than what it returned
    if (this.cache.has(path)) return this.cache.get(path);
    this.cache.set(path, result);
    return result;
  }

  /**
   * The canonical path for `path`: symlinks in directory components are
   * always followed (`/usr/share/vim/x` through a `/usr/share/vim` link),
   * the final component only with `followLast`. A missing component ends
   * the walk; the rest is appended unchanged (ENOENT comes later).
   */
  private async _canon(path: string, followLast: boolean, hops = { n: 0 }): Promise<string> {
    const parts = path.split('/').filter(Boolean);
    let cur = '';
    for (let i = 0; i < parts.length; i++) {
      const next = `${cur}/${parts[i]}`;
      if (parts[i] === '.' || parts[i] === '..') {
        cur = this.resolvePath(next, '/');
        continue;
      }
      if (i === parts.length - 1 && !followLast) return next;
      const node = await this._get(next);
      if (!node) return next + (i < parts.length - 1 ? '/' + parts.slice(i + 1).join('/') : '');
      if (node.type !== 'symlink') { cur = next; continue; }
      if (++hops.n > 40) throw fsError('ELOOP', `ELOOP: too many levels of symbolic links, '${path}'`);
      const target = node.symlinkTarget || new TextDecoder().decode(node.content!);
      cur = await this._canon(target.startsWith('/') ? target : this.resolvePath(target, cur || '/'), true, hops);
      if (cur === '/') cur = '';
    }
    return cur || '/';
  }

  /** _get from memory: the node, null when it surely doesn't exist, undefined when only IndexedDB knows. */
  private _getCached(path: string): FSNode | null | undefined {
    if (this.cache.has(path)) return this.cache.get(path) ?? null;
    if (this._allKeys && !this._allKeys.has(path)) return null;
    return undefined;
  }

  /**
   * stat() answered from memory, for synchronous fast paths (the kernel's
   * syscallSync): `{ path, node }` with symlinks in the final component
   * followed, null when the path doesn't exist, undefined when that needs
   * IndexedDB (or a virtual provider, or a symlink loop: use stat()).
   */
  lookupCached(path: string, follow = true): { path: string; node: FSNode } | null | undefined {
    for (const vp of this.virtualProviders) if (vp.handles(path)) return undefined;
    // Symlinks in directory components are followed, as _canon does
    const parts = path.split('/').filter(Boolean);
    let cur = '';
    let hops = 0;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === '.' || parts[i] === '..') { cur = this.resolvePath(`${cur}/${parts[i]}`, '/'); continue; }
      let next = `${cur}/${parts[i]}`;
      const last = i === parts.length - 1;
      for (;;) {
        const node = this._getCached(next);
        if (!node) return node; // missing (null) or unknown here (undefined)
        if (node.type !== 'symlink' || (last && !follow)) {
          if (last) return { path: next, node };
          if (node.type !== 'dir') return undefined; // ENOTDIR: let stat() say so
          break;
        }
        if (++hops > 40) return undefined;
        const target = node.symlinkTarget || new TextDecoder().decode(node.content!);
        next = target.startsWith('/') ? this.resolvePath(target, '/') : this.resolvePath(target, cur || '/');
      }
      cur = next;
    }
    const root = this._getCached('/');
    return root ? { path: '/', node: root } : root;
  }

  /** makeStat for a node from lookupCached. */
  statOf(node: FSNode): StatResult { return makeStat(node); }

  /** Follow symlinks to their final target path (up to 40 hops). */
  private async _resolve(path: string): Promise<string> {
    const seen = new Set<string>();
    let current = path;
    for (let i = 0; i < 40; i++) {
      const node = await this._get(current);
      if (!node || node.type !== 'symlink') return current;
      if (seen.has(current)) {
        throw fsError('ELOOP', `ELOOP: too many levels of symbolic links, '${path}'`);
      }
      seen.add(current);
      const target = node.symlinkTarget || new TextDecoder().decode(node.content!);
      // Resolve relative symlink targets against the symlink's parent directory
      if (target.startsWith('/')) {
        current = target;
      } else {
        const parent = current.substring(0, current.lastIndexOf('/')) || '/';
        current = this.resolvePath(target, parent);
      }
    }
    throw fsError('ELOOP', `ELOOP: too many levels of symbolic links, '${path}'`);
  }

  /** `path` with every symlink followed, in directories and at the end (realpath(3)). */
  async realpath(path: string): Promise<string> {
    return this._canon(path, true);
  }

  private async _put(node: FSNode): Promise<void> {
    this._putNow(node);
  }

  private async _delete(path: string): Promise<void> {
    this._deleteNow(path);
  }

  /** Synchronous part of a put: cache + key index now, IndexedDB on the next flush. */
  private _putNow(node: FSNode): void {
    this.cache.set(node.path, node);
    this._noteKey(node.path, true);
    this._queue(node.path, node);
  }

  private _deleteNow(path: string): void {
    // Remember the miss: IndexedDB still has the node until the flush commits
    this.cache.set(path, undefined);
    this._noteKey(path, false);
    this._queue(path, null);
  }

  /** Every key in the store (plus queued writes), once loaded; kept up to date
   *  by puts/deletes instead of being re-read after each write. */
  private _allKeys: Set<string> | null = null;
  private _allKeysArr: string[] | null = null;
  /** Key changes made while _getAllKeys is reading the store. */
  private _keysJournal: Array<[string, boolean]> | null = null;
  private _keysLoading: Promise<Set<string>> | null = null;

  /** Child names by parent directory, built from _allKeys on first readdir and kept up to date with it. */
  private _children: Map<string, Set<string>> | null = null;

  private _indexChild(path: string, present: boolean): void {
    const i = path.lastIndexOf('/');
    if (i < 0 || path === '/') return;
    const parent = i === 0 ? '/' : path.slice(0, i);
    const name = path.slice(i + 1);
    if (!name) return;
    let set = this._children!.get(parent);
    if (present) {
      if (!set) this._children!.set(parent, set = new Set());
      set.add(name);
    } else if (set) {
      set.delete(name);
      if (set.size === 0) this._children!.delete(parent);
    }
  }

  /** Names directly under `dir` (keys only; the caller checks that `dir` is a directory). */
  private async _childNames(dir: string): Promise<Iterable<string>> {
    await this._getAllKeys();
    if (!this._children) {
      this._children = new Map();
      for (const key of this._allKeys!) this._indexChild(key, true);
    }
    return this._children.get(dir) ?? [];
  }

  private _noteKey(path: string, present: boolean): void {
    if (this._allKeys) {
      if (present ? !this._allKeys.has(path) : this._allKeys.has(path)) {
        if (present) this._allKeys.add(path); else this._allKeys.delete(path);
        this._allKeysArr = null;
        if (this._children) this._indexChild(path, present);
      }
    }
    if (this._keysJournal) this._keysJournal.push([path, present]);
  }

  private async _getAllKeys(): Promise<string[]> {
    if (!this._allKeys) {
      if (!this._keysLoading) {
        const journal: Array<[string, boolean]> = [];
        this._keysJournal = journal;
        // Writes queued before the read started and not yet issued: the read
        // won't see them. (An in-flight flush transaction was created before
        // this readonly one, so IndexedDB orders the read after it.)
        const queued = [...this._dirty];
        this._keysLoading = this._request('readonly', store => store.getAllKeys())
          .then((keys) => {
            const set = new Set(keys as string[]);
            for (const [p, n] of queued) { if (n) set.add(p); else set.delete(p); }
            for (const [p, present] of journal) { if (present) set.add(p); else set.delete(p); }
            this._allKeys = set;
            this._allKeysArr = null;
            this._children = null;
            return set;
          })
          .finally(() => { this._keysJournal = null; this._keysLoading = null; });
      }
      await this._keysLoading;
    }
    if (!this._allKeysArr) this._allKeysArr = [...this._allKeys!];
    return this._allKeysArr;
  }

  /** Synchronously read file content from the in-memory cache (no IndexedDB round-trip).
   *  Returns the string content if cached, or undefined if not in cache / not a file. */
  readCached(path: string): string | undefined {
    const node = this.cache.get(path);
    if (!node || node.type !== 'file' || !node.content) return undefined;
    return new TextDecoder().decode(node.content);
  }

  /** Synchronously read a file's raw bytes from the in-memory cache. */
  readBytesCached(path: string): Uint8Array | undefined {
    const node = this.cache.get(path);
    if (!node || node.type !== 'file' || !node.content) return undefined;
    return node.content;
  }

  /** Synchronous readlink from the in-memory cache: the target for a cached
   *  symlink, null for any other cached node, undefined if not cached. */
  readlinkCached(path: string): string | null | undefined {
    const node = this.cache.get(path);
    if (!node) return undefined;
    if (node.type !== 'symlink') return null;
    return node.symlinkTarget || new TextDecoder().decode(node.content!);
  }

  /** Whether the in-memory cache holds path as a directory (an empty one
   *  included, which readdirCached can't tell from "not cached"). */
  isDirCached(path: string): boolean {
    return this.cache.get(path)?.type === 'dir';
  }

  /** Synchronously list directory entries from the in-memory cache. */
  readdirCached(path: string): string[] | undefined {
    const node = this.cache.get(path);
    if (!node || node.type !== 'dir') return undefined;
    const prefix = path === '/' ? '/' : path + '/';
    const entries = new Set<string>();
    for (const [key, value] of this.cache) {
      // A cached miss (value undefined) records that a path doesn't exist
      if (value !== undefined && key.startsWith(prefix)) {
        const rest = key.slice(prefix.length);
        const first = rest.split('/')[0];
        if (first) entries.add(first);
      }
    }
    return entries.size > 0 ? [...entries].sort() : undefined;
  }

  /** Clear the in-memory cache (useful after external DB modifications) */
  clearCache(): void {
    this.cache.clear();
    this._allKeys = null;
    this._allKeysArr = null;
    this._children = null;
    // Writes not yet in IndexedDB live only here: keep them visible
    for (const batch of [this._inflight, this._dirty]) {
      if (!batch) continue;
      for (const [path, node] of batch) this.cache.set(path, node ?? undefined);
    }
  }

  /** Export all filesystem nodes from IndexedDB */
  async exportAll(): Promise<FSNode[]> {
    await this.sync().catch(() => {});
    return this._request('readonly', store => store.getAll() as IDBRequest<FSNode[]>);
  }

  /** Import filesystem nodes, replacing all existing data */
  async importAll(nodes: FSNode[]): Promise<void> {
    // Queued writes must not land on top of the imported tree
    await this.sync().catch(() => {});
    const tx = (await this._getDb()).transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    for (const node of nodes) {
      store.put(node);
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    this.clearCache();
  }

  resolvePath(path: string, cwd: string): string {
    let resolved: string;
    if (path.startsWith('/')) {
      resolved = path;
    } else {
      resolved = cwd === '/' ? '/' + path : cwd + '/' + path;
    }
    // Normalize: resolve . and ..
    const parts = resolved.split('/');
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

  async stat(path: string): Promise<StatResult> {
    for (const vp of this.virtualProviders) {
      if (vp.handles(path)) { const s = vp.stat(path); if (s) return s; }
    }
    const node = await this._get(await this._canon(path, true));
    if (!node) throw fsError('ENOENT', `ENOENT: no such file or directory, stat '${path}'`);
    return makeStat(node);
  }

  async lstat(path: string): Promise<StatResult> {
    for (const vp of this.virtualProviders) {
      if (vp.handles(path)) { const s = vp.stat(path); if (s) return s; }
    }
    const node = await this._get(await this._canon(path, false));
    if (!node) throw fsError('ENOENT', `ENOENT: no such file or directory, lstat '${path}'`);
    return makeStat(node);
  }

  async exists(path: string): Promise<boolean> {
    for (const vp of this.virtualProviders) {
      if (vp.exists(path)) return true;
    }
    const node = await this._get(await this._canon(path, false));
    return !!node;
  }

  async readFile(path: string, encoding?: 'utf8'): Promise<Uint8Array | string> {
    for (const vp of this.virtualProviders) {
      if (vp.handles(path)) {
        const data = vp.readFile(path, encoding);
        if (data !== null) return data;
        throw fsError('EISDIR', `EISDIR: illegal operation on a directory, read '${path}'`);
      }
    }
    const node = await this._get(await this._canon(path, true));
    if (!node) throw fsError('ENOENT', `ENOENT: no such file or directory, open '${path}'`);
    if (node.type === 'dir') throw fsError('EISDIR', `EISDIR: illegal operation on a directory, read '${path}'`);
    const data = node.content || new Uint8Array(0);
    if (encoding === 'utf8') {
      return new TextDecoder().decode(data);
    }
    return data;
  }

  async writeFile(path: string, data: Uint8Array | string, options?: { mode?: number }): Promise<void> {
    for (const vp of this.virtualProviders) {
      if (vp.writeFile(path, data)) return;
    }
    path = await this._canon(path, true);
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    const parent = await this._get(parentPath);
    if (!parent) throw fsError('ENOENT', `ENOENT: no such file or directory, open '${path}'`);
    if (parent.type !== 'dir') throw fsError('ENOTDIR', `ENOTDIR: not a directory '${parentPath}'`);

    // A view into a larger buffer is stored compactly: IndexedDB clones the
    // whole ArrayBuffer behind a typed array (a WebC volume file would carry
    // its entire container)
    const content = typeof data === 'string' ? new TextEncoder().encode(data)
      : data.byteOffset !== 0 || data.byteLength !== data.buffer.byteLength ? data.slice() : data;
    const existing = await this._get(path);
    // Prevent overwriting a directory with a file
    if (existing?.type === 'dir') throw fsError('EISDIR', `EISDIR: illegal operation on a directory, write '${path}'`);
    const now = Date.now();

    await this._put({
      path,
      type: 'file',
      content,
      mode: options?.mode ?? existing?.mode ?? 0o644,
      mtime: now,
      ctime: existing?.ctime ?? now,
      size: content.length,
    });
    this._emitChange('write', path);
  }

  /** Append to a file (created if missing). Appends in one flush window are
   *  committed as a single put of the final content. */
  async appendFile(path: string, data: Uint8Array | string): Promise<void> {
    let existing: Uint8Array;
    try {
      existing = await this.readFile(path) as Uint8Array;
    } catch {
      existing = new Uint8Array(0);
    }
    const append = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const combined = new Uint8Array(existing.length + append.length);
    combined.set(existing);
    combined.set(append, existing.length);
    // Through a symlink, append to its target rather than replacing the link
    const target = this.virtualProviders.some(vp => vp.handles(path)) ? path : await this._canon(path, true);
    await this.writeFile(target, combined);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    if (options?.recursive) {
      const parts = path.split('/').filter(Boolean);
      let current = '';
      for (const part of parts) {
        current = await this._canon(current + '/' + part, true);
        const existing = await this._get(current);
        if (!existing) {
          await this._put(this._makeNode(current, 'dir'));
          this._emitChange('mkdir', current);
        } else if (existing.type !== 'dir') {
          throw fsError('ENOTDIR', `ENOTDIR: not a directory '${current}'`);
        }
      }
      return;
    }

    path = await this._canon(path, false);
    const existing = await this._get(path);
    if (existing) throw fsError('EEXIST', `EEXIST: file already exists, mkdir '${path}'`);

    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    const parent = await this._get(parentPath);
    if (!parent) throw fsError('ENOENT', `ENOENT: no such file or directory, mkdir '${path}'`);
    if (parent.type !== 'dir') throw fsError('ENOTDIR', `ENOTDIR: not a directory '${parentPath}'`);

    await this._put(this._makeNode(path, 'dir'));
    this._emitChange('mkdir', path);
  }

  async readdir(path: string): Promise<string[]> {
    // Check virtual providers first
    for (const vp of this.virtualProviders) {
      if (vp.handles(path)) {
        const entries = vp.readdir(path);
        if (entries !== null) return entries;
        throw fsError('ENOTDIR', `ENOTDIR: not a directory '${path}'`);
      }
    }

    const shown = path;
    path = await this._canon(path, true);
    const node = await this._get(path);
    if (!node) throw fsError('ENOENT', `ENOENT: no such file or directory, readdir '${shown}'`);
    if (node.type !== 'dir') throw fsError('ENOTDIR', `ENOTDIR: not a directory '${path}'`);

    const entries: string[] = [...await this._childNames(path)];

    // For root directory, add virtual top-level dirs
    if (path === '/') {
      const vdirs = new Set<string>();
      for (const vp of this.virtualProviders) {
        for (const name of ['dev', 'proc']) {
          if (vp.handles('/' + name)) vdirs.add(name);
        }
      }
      for (const vd of vdirs) {
        if (!entries.includes(vd)) entries.push(vd);
      }
    }

    return entries.sort();
  }

  /**
   * writeFile() whose effect on the in-memory cache is immediate, for synchronous
   * callers (node's fs.writeFileSync of binary data) that read the file right back.
   */
  writeNow(path: string, content: Uint8Array): Promise<void> {
    const prev = this.cache.get(path);
    const now = Date.now();
    this.cache.set(path, {
      path, type: 'file', content,
      mode: prev?.mode ?? 0o644, mtime: now, ctime: prev?.ctime ?? now, size: content.length,
    } as FSNode);
    this._noteKey(path, true);
    return this.writeFile(path, content);
  }

  /**
   * unlink() whose effect on the in-memory cache is immediate, for synchronous
   * callers (node's fs.unlinkSync) that list or stat the directory right after.
   */
  unlinkNow(path: string): Promise<void> {
    // Take the cached node before it is dropped below (unlink() canonicalizes asynchronously)
    const cached = this.cache.get(path);
    const done = cached ? this._unlinkNode(path, cached) : this.unlink(path);
    this.cache.set(path, undefined);
    this._noteKey(path, false);
    return done;
  }

  async unlink(path: string): Promise<void> {
    path = await this._canon(path, false);
    return this._unlinkNode(path, await this._get(path));
  }

  private async _unlinkNode(path: string, node: FSNode | undefined): Promise<void> {
    if (!node) throw fsError('ENOENT', `ENOENT: no such file or directory, unlink '${path}'`);
    if (node.type === 'dir') throw fsError('EISDIR', `EISDIR: illegal operation on a directory, unlink '${path}'`);
    await this._delete(path);
    this._emitChange('delete', path);
  }

  async rmdir(path: string): Promise<void> {
    path = await this._canon(path, false);
    const node = await this._get(path);
    if (!node) throw fsError('ENOENT', `ENOENT: no such file or directory, rmdir '${path}'`);
    if (node.type !== 'dir') throw fsError('ENOTDIR', `ENOTDIR: not a directory '${path}'`);

    const entries = await this.readdir(path);
    if (entries.length > 0) throw fsError('ENOTEMPTY', `ENOTEMPTY: directory not empty, rmdir '${path}'`);
    await this._delete(path);
    this._emitChange('delete', path);
  }

  async rm(path: string, options?: { recursive?: boolean }): Promise<void> {
    path = await this._canon(path, false);
    const node = await this._get(path);
    if (!node) throw fsError('ENOENT', `ENOENT: no such file or directory, rm '${path}'`);

    if (node.type === 'dir' && options?.recursive) {
      const allKeys = await this._getAllKeys();
      const prefix = path === '/' ? '/' : path + '/';
      const toDelete = allKeys.filter(k => k === path || k.startsWith(prefix));
      // Delete in reverse order (deepest first)
      toDelete.sort().reverse();
      for (const key of toDelete) {
        await this._delete(key);
      }
      this._emitChange('delete', path);
    } else if (node.type === 'dir') {
      throw fsError('EISDIR', `EISDIR: is a directory, rm '${path}'`);
    } else {
      await this._delete(path);
      this._emitChange('delete', path);
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    oldPath = await this._canon(oldPath, false);
    newPath = await this._canon(newPath, false);
    const node = await this._get(oldPath);
    if (!node) throw fsError('ENOENT', `ENOENT: no such file or directory, rename '${oldPath}'`);

    if (node.type === 'dir') {
      // Move directory and all children
      const allKeys = await this._getAllKeys();
      const prefix = oldPath === '/' ? '/' : oldPath + '/';
      for (const key of allKeys) {
        if (key === oldPath || key.startsWith(prefix)) {
          const child = await this._get(key);
          if (child) {
            const newChildPath = newPath + key.slice(oldPath.length);
            await this._put({ ...child, path: newChildPath });
            await this._delete(key);
          }
        }
      }
    } else {
      // Prevent renaming a file over a directory
      const existing = await this._get(newPath);
      if (existing?.type === 'dir') throw fsError('EISDIR', `EISDIR: illegal operation on a directory, rename '${newPath}'`);
      await this._put({ ...node, path: newPath, mtime: Date.now() });
      await this._delete(oldPath);
    }
    this._emitChange('rename', oldPath, newPath);
  }

  async chmod(path: string, mode: number): Promise<void> {
    path = await this._canon(path, true);
    const node = await this._get(path);
    if (!node) throw fsError('ENOENT', `ENOENT: no such file or directory, chmod '${path}'`);
    await this._put({ ...node, mode });
  }

  /** Set modification time (utimensat). There is no separate atime; it follows mtime. */
  async utimes(path: string, _atimeMs: number, mtimeMs: number): Promise<void> {
    path = await this._canon(path, true);
    const node = await this._get(path);
    if (!node) throw fsError('ENOENT', `ENOENT: no such file or directory, utime '${path}'`);
    await this._put({ ...node, mtime: mtimeMs });
  }

  // isomorphic-git compatibility: symlink support
  async symlink(target: string, path: string): Promise<void> {
    path = await this._canon(path, false);
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    const parent = await this._get(parentPath);
    if (!parent) throw fsError('ENOENT', `ENOENT: no such file or directory '${parentPath}'`);

    const now = Date.now();
    await this._put({
      path,
      type: 'symlink',
      content: new TextEncoder().encode(target),
      mode: 0o120000,
      mtime: now,
      ctime: now,
      size: target.length,
      symlinkTarget: target,
    });
  }

  async readlink(path: string): Promise<string> {
    path = await this._canon(path, false);
    const node = await this._get(path);
    if (!node) throw fsError('ENOENT', `ENOENT: no such file or directory, readlink '${path}'`);
    if (node.type !== 'symlink') throw fsError('EINVAL', `EINVAL: not a symlink '${path}'`);
    return node.symlinkTarget || new TextDecoder().decode(node.content!);
  }

  async glob(pattern: string, base?: string, options?: { caseInsensitive?: boolean; dotglob?: boolean }): Promise<string[]> {
    const root = base || '/';
    const allKeys = await this._getAllKeys();
    const regex = globPatternToRegex(pattern, root, options?.caseInsensitive);
    const dotglob = options?.dotglob ?? false;
    // Check if the pattern basename starts with '.' (explicit dotfile match)
    const patBase = pattern.includes('/') ? pattern.slice(pattern.lastIndexOf('/') + 1) : pattern;
    const patternStartsDot = patBase.startsWith('.');
    const results: string[] = [];
    for (const key of allKeys) {
      const node = await this._get(key);
      if (node && node.type === 'file' && regex.test(key)) {
        // Filter dotfiles unless dotglob is on or pattern explicitly starts with '.'
        if (!dotglob && !patternStartsDot) {
          const basename = key.slice(key.lastIndexOf('/') + 1);
          if (basename.startsWith('.')) continue;
        }
        // Return relative to base
        if (base && key.startsWith(base)) {
          const rel = key.slice(base.length);
          results.push(rel.startsWith('/') ? rel.slice(1) : rel);
        } else {
          results.push(key);
        }
      }
    }
    return results.sort();
  }

  // Build an fs-like API object for isomorphic-git
  toIsomorphicGitFS() {
    const self = this;
    // Normalize paths that contain '.' or '..' segments (isomorphic-git passes e.g. '/dir/.')
    const norm = (p: string): string => {
      if (p.includes('/.') || p.endsWith('.')) return self.resolvePath(p, '/');
      return p;
    };
    return {
      promises: {
        readFile: (p: string, opts?: any) => {
          if (opts?.encoding === 'utf8' || opts === 'utf8') return self.readFile(p, 'utf8');
          return self.readFile(p);
        },
        writeFile: (p: string, data: any, opts?: any) => self.writeFile(p, data, typeof opts === 'object' ? opts : undefined),
        unlink: (p: string) => self.unlink(p),
        readdir: (p: string) => self.readdir(norm(p)),
        mkdir: (p: string, opts?: any) => self.mkdir(p, typeof opts === 'number' ? undefined : opts),
        rmdir: (p: string) => self.rmdir(p),
        stat: async (p: string) => {
          try {
            return await self.stat(norm(p));
          } catch (err: any) {
            if (err.code === 'ENOENT') throw err;
            throw fsError('ENOENT', `ENOENT: no such file or directory, stat '${p}'`);
          }
        },
        lstat: async (p: string) => {
          try {
            return await self.lstat(norm(p));
          } catch (err: any) {
            if (err.code === 'ENOENT') throw err;
            throw fsError('ENOENT', `ENOENT: no such file or directory, lstat '${p}'`);
          }
        },
        rename: (o: string, n: string) => self.rename(o, n),
        symlink: (t: string, p: string) => self.symlink(t, p),
        readlink: (p: string) => self.readlink(p),
        chmod: (p: string, m: number) => self.chmod(p, m),
      },
    };
  }
}
