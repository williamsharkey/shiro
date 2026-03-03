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
export function createFileCache() {
  const fileCache = new Map<string, string>();
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

  return { fileCache, fileMtimes, moduleCache, tickSyncOps };
}
