/**
 * File cache + sync operation watchdog for the Node.js compat layer.
 *
 * The file cache provides synchronous access to files that have been pre-loaded
 * from IndexedDB. writeFileSync updates the cache immediately and queues
 * an async IDB write. This gives Node.js-style synchronous semantics in a
 * browser environment.
 */

/** UTF-8 text, or null for bytes that aren't valid UTF-8 (binary files). */
export function decodeUtf8Strict(bytes: Uint8Array): string | null {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
}

/** Sync FS operation watchdog limit */
const SYNC_OP_LIMIT = 50_000;

/** Mutable state for the sync watchdog */
interface SyncWatchdog {
  count: number;
  resetScheduled: boolean;
}

/**
 * Create the file cache, mtime tracker, module cache, and sync watchdog
 * for a single `node` command invocation.
 */
/**
 * A file cache that reads through on a miss (node as a kernel guest: files
 * come from blocking syscalls, so nothing needs preloading). A miss isn't
 * remembered (another process, a rename or a binary write can make the file
 * at any time; asking again is one stat). Directory markers ("dir/.") are
 * answered by the directory being there. Binary files stay out, as in the page.
 */
class ReadThroughMap extends Map<string, string> {
  constructor(private read: (path: string) => string | undefined, private isDir?: (path: string) => boolean) { super(); }
  get(key: string): string | undefined {
    if (super.has(key)) return super.get(key);
    if (key.endsWith('/.')) return this.isDir?.(key.slice(0, -2) || '/') ? '' : undefined;
    const v = this.read(key);
    if (v !== undefined) super.set(key, v);
    return v;
  }
  has(key: string): boolean { return super.has(key) || this.get(key) !== undefined; }
  /** Files changed elsewhere (a child process ran): read them again */
  clear(): void { super.clear(); }
}

/** What LazyTextMap needs of the FileSystem. */
interface LazySource {
  readBytesCached(path: string): Uint8Array | undefined;
  lookupCached?(path: string, follow?: boolean): unknown;
  addContentPin?(pinned: (path: string) => boolean): () => void;
}

/**
 * The text cache of node in the page. Files the preload walks (preloadDir:
 * the whole of ./node_modules) are added with setLazy and decoded only when
 * first read: most never are, and holding each as a string too doubled the
 * memory (vite's dev server kept two copies of a 50 MB tree). Their bytes
 * stay in the FileSystem's cache, pinned while this map is alive (a process
 * that went idle with servers up still reads through it). A lazy file read
 * when the FileSystem no longer has it is gone from the map, as deleted.
 */
export class LazyTextMap extends Map<string, string> {
  private lazy = new Set<string>();

  constructor(private source: LazySource) {
    super();
    // The pin holds the set weakly, and goes with it
    const ref = new WeakRef(this.lazy);
    let unpin: (() => void) | undefined;
    unpin = source.addContentPin?.((path) => {
      const lazy = ref.deref();
      if (!lazy) { unpin?.(); return false; }
      return lazy.has(path);
    });
  }

  /** Add `path` (UTF-8 text in the FileSystem's cache now), decoded when read. */
  setLazy(path: string): void {
    super.set(path, '');
    this.lazy.add(path);
  }

  /** Not decoded yet: its text is the FileSystem's, so never stale. */
  isLazy(path: string): boolean { return this.lazy.has(path); }

  get(key: string): string | undefined {
    if (!this.lazy.has(key)) return super.get(key);
    this.lazy.delete(key);
    const bytes = this.source.readBytesCached(key);
    const text = bytes && decodeUtf8Strict(bytes);
    if (text == null) { super.delete(key); return undefined; }
    super.set(key, text);
    return text;
  }

  has(key: string): boolean {
    if (this.lazy.has(key) && this.source.lookupCached?.(key) === null) { this.delete(key); return false; }
    return super.has(key);
  }

  set(key: string, value: string): this { this.lazy.delete(key); return super.set(key, value); }
  delete(key: string): boolean { this.lazy.delete(key); return super.delete(key); }
  clear(): void { this.lazy.clear(); super.clear(); }

  *entries(): MapIterator<[string, string]> {
    for (const k of [...super.keys()]) { const v = this.get(k); if (v !== undefined) yield [k, v]; }
  }
  *values(): MapIterator<string> { for (const [, v] of this.entries()) yield v; }
  [Symbol.iterator](): MapIterator<[string, string]> { return this.entries(); }
  forEach(fn: (value: string, key: string, map: Map<string, string>) => void, thisArg?: unknown): void {
    for (const [k, v] of this.entries()) fn.call(thisArg, v, k, this);
  }
}

export function createFileCache(readThrough?: (path: string) => string | undefined, isDir?: (path: string) => boolean, lazySource?: LazySource) {
  const fileCache: Map<string, string> = readThrough ? new ReadThroughMap(readThrough, isDir)
    : lazySource ? new LazyTextMap(lazySource) : new Map<string, string>();
  const fileMtimes = new Map<string, number>();
  const moduleCache = new Map<string, { exports: any }>();
  const watchdog: SyncWatchdog = { count: 0, resetScheduled: false };

  function tickSyncOps() {
    if (++watchdog.count > SYNC_OP_LIMIT) {
      watchdog.count = 0;
      throw new Error(
        `ENOMEM: too many synchronous filesystem operations without yielding (${SYNC_OP_LIMIT}). ` +
        `Use async fs methods (fs.promises.readdir, etc.) for recursive directory traversal.`
      );
    }
    if (!watchdog.resetScheduled) {
      watchdog.resetScheduled = true;
      Promise.resolve().then(() => { watchdog.count = 0; watchdog.resetScheduled = false; });
    }
  }

  function getCacheStats() {
    let totalSize = 0;
    for (const content of fileCache.values()) totalSize += content.length;
    return { fileCount: fileCache.size, moduleCount: moduleCache.size, totalSizeBytes: totalSize };
  }

  return { fileCache, fileMtimes, moduleCache, tickSyncOps, getCacheStats };
}
