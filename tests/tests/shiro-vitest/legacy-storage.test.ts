/**
 * Data saved under the old `shiro` names survives the rename to tabcomputer
 * (src/legacy-storage.ts): localStorage keys are copied to their new names,
 * and the filesystem database moves from shiro-fs to tabcomputer-fs.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { migrateStorage, renamedKey, fileSystemDbName, FS_DB, LEGACY_FS_DB } from '@shiro/legacy-storage';
import { FileSystem } from '@shiro/filesystem';
import { envVar } from '@shiro/env-alias';

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(seed));
  return {
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
  } as Storage;
}

/** An old-style filesystem database holding `rows`. */
async function seedLegacyDb(idb: IDBFactory, rows: object[]): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = idb.open(LEGACY_FS_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files', { keyPath: 'path' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    for (const r of rows) tx.objectStore('files').put(r);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

const node = (path: string, text: string | null, type: 'file' | 'dir' = 'file') => ({
  path, type, content: text === null ? null : new TextEncoder().encode(text), mode: type === 'dir' ? 0o755 : 0o644,
  mtime: 1, ctime: 1, size: text?.length ?? 0,
});

describe('storage keys', () => {
  it('copies shiro-/shiro_ keys to tabcomputer names, keeps the old ones, never overwrites', () => {
    const s = memoryStorage({
      shiro_github_token: 'gho_old', 'shiro-ui': 'terminal', 'shiro-desktop-theme': 'dark',
      'tabcomputer-desktop-theme': 'light', unrelated: 'x', 'wal:1': 'y',
    });
    expect(migrateStorage(s).sort()).toEqual(['shiro-ui', 'shiro_github_token']);
    expect(s.getItem('tabcomputer_github_token')).toBe('gho_old');
    expect(s.getItem('tabcomputer-ui')).toBe('terminal');
    expect(s.getItem('tabcomputer-desktop-theme')).toBe('light');
    expect(s.getItem('shiro_github_token')).toBe('gho_old');
    expect(migrateStorage(s)).toEqual([]);
    expect(renamedKey('shirotext')).toBe(null);
  });
});

describe('the filesystem database', () => {
  const realIdb = globalThis.indexedDB;
  afterEach(() => { (globalThis as any).indexedDB = realIdb; (FileSystem as any)._dbName = null; });

  it('moves shiro-fs into tabcomputer-fs and FileSystem reads the files', async () => {
    const idb = new IDBFactory();
    await seedLegacyDb(idb, [node('/', null, 'dir'), node('/home', null, 'dir'), node('/home/user', null, 'dir'), node('/home/user/notes.txt', 'my files')]);
    (globalThis as any).indexedDB = idb;
    (FileSystem as any)._dbName = null;
    const fs = new FileSystem();
    await fs.init();
    expect(await fs.readFile('/home/user/notes.txt', 'utf8')).toBe('my files');
    const names = (await idb.databases()).map((d) => d.name);
    expect(names).toContain(FS_DB);
    expect(names).not.toContain(LEGACY_FS_DB);
  });

  it('a new user gets tabcomputer-fs; an already moved one keeps it', async () => {
    const idb = new IDBFactory();
    expect(await fileSystemDbName(idb as any)).toBe(FS_DB);
    await seedLegacyDb(idb, [node('/x', 'stale')]);
    // tabcomputer-fs isn't created by the name check; create it, then both exist
    await new Promise<void>((resolve) => { const r = idb.open(FS_DB, 1); r.onupgradeneeded = () => r.result.createObjectStore('files', { keyPath: 'path' }); r.onsuccess = () => { r.result.close(); resolve(); }; });
    expect(await fileSystemDbName(idb as any)).toBe(FS_DB);
  });

  it('keeps using shiro-fs when the move fails', async () => {
    const idb = new IDBFactory();
    await seedLegacyDb(idb, [node('/a', 'kept')]);
    const broken = Object.create(idb);
    broken.databases = () => idb.databases();
    broken.deleteDatabase = (n: string) => idb.deleteDatabase(n);
    broken.open = (n: string, v?: number) => {
      if (n === FS_DB) { const r: any = {}; queueMicrotask(() => { r.error = new DOMException('quota', 'QuotaExceededError'); r.onerror?.(); }); return r; }
      return idb.open(n, v);
    };
    expect(await fileSystemDbName(broken)).toBe(LEGACY_FS_DB);
    expect((await idb.databases()).map((d) => d.name)).toContain(LEGACY_FS_DB);
  });
});

describe('environment variables', () => {
  it('TABCOMPUTER_ names win, SHIRO_ ones still work', () => {
    expect(envVar({ SHIRO_PKG_MIRROR: 'a' }, 'PKG_MIRROR')).toBe('a');
    expect(envVar({ SHIRO_PKG_MIRROR: 'a', TABCOMPUTER_PKG_MIRROR: 'b' }, 'PKG_MIRROR')).toBe('b');
    expect(envVar({}, 'PKG_MIRROR')).toBe(undefined);
  });
});
