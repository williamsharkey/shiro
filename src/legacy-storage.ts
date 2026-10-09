/**
 * Moving users' data from the names it had before tabcomputer was its own
 * product (docs/PROFILES.md, "Renamed identifiers"). tabcomputer.com users
 * have files and settings under `shiro-…` names; nothing may be lost.
 *
 * - localStorage/sessionStorage: every `shiro-…`/`shiro_…` key is copied to
 *   `tabcomputer-…`/`tabcomputer_…` when the new key doesn't exist yet, on
 *   every boot (old keys stay, so a tab still running the old build keeps
 *   working, and a key it writes later is picked up by the next boot).
 * - The filesystem's IndexedDB `shiro-fs` is copied once into `tabcomputer-fs`
 *   (src/filesystem.ts calls `fileSystemDbName`). The old database is deleted
 *   only after the copy's record count matches; if the copy fails (quota), the
 *   page keeps using `shiro-fs`.
 */

export const LEGACY_PREFIX = /^shiro([-_])/;
export const NEW_PREFIX = 'tabcomputer';

/** The new name for a legacy storage key, or null if it isn't one. */
export function renamedKey(key: string): string | null {
  return LEGACY_PREFIX.test(key) ? key.replace(LEGACY_PREFIX, `${NEW_PREFIX}$1`) : null;
}

/** Copy legacy keys to their new names (never overwriting); returns the keys copied. */
export function migrateStorage(store: Storage | undefined = typeof localStorage !== 'undefined' ? localStorage : undefined): string[] {
  const copied: string[] = [];
  if (!store) return copied;
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) { const k = store.key(i); if (k) keys.push(k); }
    for (const k of keys) {
      const to = renamedKey(k);
      if (!to || store.getItem(to) !== null) continue;
      const v = store.getItem(k);
      if (v === null) continue;
      store.setItem(to, v);
      copied.push(k);
    }
  } catch { /* storage unavailable or full: the old keys stay readable by the old build */ }
  return copied;
}

export const FS_DB = 'tabcomputer-fs';
export const LEGACY_FS_DB = 'shiro-fs';
const STORE = 'files';

async function databaseNames(idb: IDBFactory): Promise<Set<string> | null> {
  try {
    if (typeof idb.databases !== 'function') return null;
    return new Set((await idb.databases()).map((d) => d.name ?? ''));
  } catch { return null; }
}

function open(idb: IDBFactory, name: string, create: boolean): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb.open(name, 1);
    req.onupgradeneeded = () => {
      if (!create) { req.transaction?.abort(); return; }
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'path' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function count(db: IDBDatabase): Promise<number> {
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE, 'readonly').objectStore(STORE).count();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Records after `after` (exclusive), at most `n` of them. */
function batch(db: IDBDatabase, after: string | null, n: number): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const out: any[] = [];
    const range = after === null ? undefined : IDBKeyRange.lowerBound(after, true);
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor(range);
    req.onsuccess = () => {
      const c = req.result;
      if (!c || out.length >= n) { resolve(out); return; }
      out.push(c.value);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

function putAll(db: IDBDatabase, rows: any[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const s = tx.objectStore(STORE);
    for (const r of rows) s.put(r);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('aborted'));
  });
}

/** Copy the legacy filesystem database into the new one; true when it's all there. */
export async function copyFileSystemDb(idb: IDBFactory, from = LEGACY_FS_DB, to = FS_DB): Promise<boolean> {
  const src = await open(idb, from, false);
  const dst = await open(idb, to, true);
  try {
    let after: string | null = null;
    for (;;) {
      const rows = await batch(src, after, 256);
      if (!rows.length) break;
      await putAll(dst, rows);
      after = rows[rows.length - 1].path;
    }
    return (await count(dst)) >= (await count(src));
  } finally {
    src.close();
    dst.close();
  }
}

async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis as any).navigator?.locks;
  return locks?.request ? locks.request(name, fn) : fn();
}

/**
 * The filesystem database to open: `tabcomputer-fs`, after moving `shiro-fs`
 * into it the first time. Falls back to `shiro-fs` when the move fails.
 */
export async function fileSystemDbName(idb: IDBFactory | undefined = typeof indexedDB !== 'undefined' ? indexedDB : undefined): Promise<string> {
  if (!idb) return FS_DB;
  return withLock('tabcomputer-fs-migration', async () => {
    const names = await databaseNames(idb);
    if (!names || names.has(FS_DB) || !names.has(LEGACY_FS_DB)) return FS_DB;
    try {
      if (!(await copyFileSystemDb(idb))) throw new Error('record counts differ');
      await new Promise<void>((resolve) => {
        const del = idb.deleteDatabase(LEGACY_FS_DB);
        del.onsuccess = del.onerror = del.onblocked = () => resolve();
      });
      console.log('[fs] moved your files from shiro-fs to tabcomputer-fs');
      return FS_DB;
    } catch (e) {
      console.warn('[fs] could not move shiro-fs to tabcomputer-fs; using it as it is:', (e as any)?.message ?? e);
      await new Promise<void>((resolve) => {
        const del = idb.deleteDatabase(FS_DB); // a partial copy must not be picked next time
        del.onsuccess = del.onerror = del.onblocked = () => resolve();
      });
      return LEGACY_FS_DB;
    }
  });
}
