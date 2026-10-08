import { describe, it, expect, beforeEach } from 'vitest';
import { FileSystem } from '@shiro/filesystem';

// Issue #24: after the browser closes the IndexedDB connection, every
// operation failed with "The database connection is closing" and the
// filesystem looked empty until reload.
describe('FileSystem IndexedDB reconnect', () => {
  let fs: FileSystem;

  beforeEach(async () => {
    fs = new FileSystem();
    await fs.init();
  });

  it('reopens the database after the connection is closed', async () => {
    await fs.writeFile('/home/user/keep.txt', 'still here');
    fs.clearCache();
    (fs as any).db.close();

    expect(await fs.readFile('/home/user/keep.txt', 'utf8')).toBe('still here');
    await fs.writeFile('/home/user/after.txt', 'written after reconnect');
    fs.clearCache();
    expect(await fs.readdir('/home/user')).toEqual(expect.arrayContaining(['keep.txt', 'after.txt']));
  });

  it('reopens when the browser drops the connection (onclose)', async () => {
    const db = (fs as any).db as IDBDatabase;
    db.close();
    db.onclose?.(new Event('close'));
    expect((fs as any).db).toBeNull();
    fs.clearCache();
    expect((await fs.stat('/home/user')).isDirectory()).toBe(true);
  });

  it('tracks pending writes until they commit', async () => {
    const now = Date.now();
    await (fs as any)._put({ path: '/home/user/pending.txt', type: 'file', content: new Uint8Array([120]), mode: 0o644, mtime: now, ctime: now, size: 1 });
    expect(fs.pendingWrites).toBe(1);
    await fs.sync();
    expect(fs.pendingWrites).toBe(0);
  });
});
