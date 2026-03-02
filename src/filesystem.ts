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

export class FileSystem {
  private db: IDBDatabase | null = null;
  private cache: Map<string, FSNode | undefined> = new Map();
  private cacheEnabled = true;
  private _changeListeners: Set<FSChangeListener> = new Set();
  private virtualProviders: VirtualFSProvider[] = [new DevProvider(), new ProcProvider()];

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
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'path' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    // Ensure root directory exists
    const root = await this._get('/');
    if (!root) {
      await this._put(this._makeNode('/', 'dir'));
    }

    // Ensure basic directories exist
    for (const dir of ['/home', '/tmp', '/home/user']) {
      const existing = await this._get(dir);
      if (!existing) {
        await this._put(this._makeNode(dir, 'dir'));
      }
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

  private _store(mode: IDBTransactionMode): IDBObjectStore {
    return this.db!.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
  }

  private async _get(path: string): Promise<FSNode | undefined> {
    if (this.cacheEnabled && this.cache.has(path)) {
      return this.cache.get(path);
    }
    const result = await new Promise<FSNode | undefined>((resolve, reject) => {
      const req = this._store('readonly').get(path);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (this.cacheEnabled) {
      this.cache.set(path, result);
    }
    return result;
  }

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

  private async _put(node: FSNode): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const req = this._store('readwrite').put(node);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    if (this.cacheEnabled) {
      this.cache.set(node.path, node);
      // Invalidate allKeys cache
      this._allKeysCache = null;
    }
  }

  private async _delete(path: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const req = this._store('readwrite').delete(path);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    if (this.cacheEnabled) {
      this.cache.delete(path);
      this._allKeysCache = null;
    }
  }

  private _allKeysCache: string[] | null = null;

  private async _getAllKeys(): Promise<string[]> {
    if (this.cacheEnabled && this._allKeysCache) {
      return this._allKeysCache;
    }
    const result = await new Promise<string[]>((resolve, reject) => {
      const req = this._store('readonly').getAllKeys();
      req.onsuccess = () => resolve(req.result as string[]);
      req.onerror = () => reject(req.error);
    });
    if (this.cacheEnabled) {
      this._allKeysCache = result;
    }
    return result;
  }

  /** Synchronously read file content from the in-memory cache (no IndexedDB round-trip).
   *  Returns the string content if cached, or undefined if not in cache / not a file. */
  readCached(path: string): string | undefined {
    const node = this.cache.get(path);
    if (!node || node.type !== 'file' || !node.content) return undefined;
    return new TextDecoder().decode(node.content);
  }

  /** Synchronously list directory entries from the in-memory cache. */
  readdirCached(path: string): string[] | undefined {
    const node = this.cache.get(path);
    if (!node || node.type !== 'dir') return undefined;
    const prefix = path === '/' ? '/' : path + '/';
    const entries = new Set<string>();
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
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
    this._allKeysCache = null;
  }

  /** Export all filesystem nodes from IndexedDB */
  async exportAll(): Promise<FSNode[]> {
    return new Promise<FSNode[]>((resolve, reject) => {
      const req = this._store('readonly').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /** Import filesystem nodes, replacing all existing data */
  async importAll(nodes: FSNode[]): Promise<void> {
    const tx = this.db!.transaction(STORE_NAME, 'readwrite');
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
    const resolved = await this._resolve(path);
    const node = await this._get(resolved);
    if (!node) throw fsError('ENOENT', `ENOENT: no such file or directory, stat '${path}'`);
    return makeStat(node);
  }

  async lstat(path: string): Promise<StatResult> {
    for (const vp of this.virtualProviders) {
      if (vp.handles(path)) { const s = vp.stat(path); if (s) return s; }
    }
    const node = await this._get(path);
    if (!node) throw fsError('ENOENT', `ENOENT: no such file or directory, lstat '${path}'`);
    return makeStat(node);
  }

  async exists(path: string): Promise<boolean> {
    for (const vp of this.virtualProviders) {
      if (vp.exists(path)) return true;
    }
    const node = await this._get(path);
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
    const resolved = await this._resolve(path);
    const node = await this._get(resolved);
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
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    const parent = await this._get(parentPath);
    if (!parent) throw fsError('ENOENT', `ENOENT: no such file or directory, open '${path}'`);
    if (parent.type !== 'dir') throw fsError('ENOTDIR', `ENOTDIR: not a directory '${parentPath}'`);

    const content = typeof data === 'string' ? new TextEncoder().encode(data) : data;
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
    await this.writeFile(path, combined);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    if (options?.recursive) {
      const parts = path.split('/').filter(Boolean);
      let current = '';
      for (const part of parts) {
        current += '/' + part;
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

    const node = await this._get(path);
    if (!node) throw fsError('ENOENT', `ENOENT: no such file or directory, readdir '${path}'`);
    if (node.type !== 'dir') throw fsError('ENOTDIR', `ENOTDIR: not a directory '${path}'`);

    const allKeys = await this._getAllKeys();
    const prefix = path === '/' ? '/' : path + '/';
    const entries: string[] = [];

    for (const key of allKeys) {
      if (key === path) continue;
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (!rest.includes('/')) {
        entries.push(rest);
      }
    }

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

  async unlink(path: string): Promise<void> {
    const node = await this._get(path);
    if (!node) throw fsError('ENOENT', `ENOENT: no such file or directory, unlink '${path}'`);
    if (node.type === 'dir') throw fsError('EISDIR', `EISDIR: illegal operation on a directory, unlink '${path}'`);
    await this._delete(path);
    this._emitChange('delete', path);
  }

  async rmdir(path: string): Promise<void> {
    const node = await this._get(path);
    if (!node) throw fsError('ENOENT', `ENOENT: no such file or directory, rmdir '${path}'`);
    if (node.type !== 'dir') throw fsError('ENOTDIR', `ENOTDIR: not a directory '${path}'`);

    const entries = await this.readdir(path);
    if (entries.length > 0) throw fsError('ENOTEMPTY', `ENOTEMPTY: directory not empty, rmdir '${path}'`);
    await this._delete(path);
    this._emitChange('delete', path);
  }

  async rm(path: string, options?: { recursive?: boolean }): Promise<void> {
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
    const node = await this._get(path);
    if (!node) throw fsError('ENOENT', `ENOENT: no such file or directory, chmod '${path}'`);
    await this._put({ ...node, mode });
  }

  // isomorphic-git compatibility: symlink support
  async symlink(target: string, path: string): Promise<void> {
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
