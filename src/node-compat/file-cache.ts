/**
 * File cache + sync operation watchdog for the Node.js compat layer.
 *
 * The file cache provides synchronous access to files that have been pre-loaded
 * from IndexedDB. writeFileSync updates the cache immediately and queues
 * an async IDB write. This gives Node.js-style synchronous semantics in a
 * browser environment.
 */

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

export function createFileCache(readThrough?: (path: string) => string | undefined, isDir?: (path: string) => boolean) {
  const fileCache: Map<string, string> = readThrough ? new ReadThroughMap(readThrough, isDir) : new Map<string, string>();
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
