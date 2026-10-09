import { describe, it, expect, beforeEach } from 'vitest';
import { FileSystem } from '@shiro/filesystem';
import { createTestShell } from './helpers';
import { syncCmd } from '@shiro/commands/sync';

// Write-behind: mutations hit the in-memory cache at once and are committed to
// IndexedDB in one transaction per flush (see the FileSystem class comment).
describe('FileSystem write-behind', () => {
  let fs: FileSystem;
  let txs: IDBTransactionMode[];

  beforeEach(async () => {
    fs = new FileSystem();
    await fs.init();
    await fs.sync();
    txs = [];
    const db = (fs as any).db as IDBDatabase;
    const orig = db.transaction.bind(db);
    (db as any).transaction = (store: any, mode?: IDBTransactionMode, opts?: any) => {
      txs.push(mode ?? 'readonly');
      return orig(store, mode, opts);
    };
  });

  /** A second instance reading the same database: sees only committed data. */
  async function onDisk(path: string): Promise<string | null> {
    const other = new FileSystem();
    await other.init();
    try { return await other.readFile(path, 'utf8') as string; } catch { return null; }
  }

  it('commits a burst of writes in one transaction', async () => {
    await fs.readdir('/tmp'); // key index loaded: new paths need no IndexedDB read
    await fs.mkdir('/tmp/wb', { recursive: true });
    await Promise.all(Array.from({ length: 200 }, (_, i) => fs.writeFile(`/tmp/wb/f${i}`, `file ${i}`)));
    expect(fs.pendingWrites).toBeGreaterThan(0);
    await fs.sync();
    expect(fs.pendingWrites).toBe(0);
    expect(txs.filter(m => m === 'readwrite').length).toBe(1);
    expect(await onDisk('/tmp/wb/f199')).toBe('file 199');
  });

  it('coalesces sequential appends into one put of the final content', async () => {
    for (let i = 0; i < 100; i++) await fs.appendFile('/tmp/wb-log.txt', `line ${i}\n`);
    expect((await fs.readFile('/tmp/wb-log.txt', 'utf8') as string).split('\n').length).toBe(101);
    await fs.sync();
    expect(txs.filter(m => m === 'readwrite').length).toBeLessThanOrEqual(2);
    expect((await onDisk('/tmp/wb-log.txt'))!.endsWith('line 99\n')).toBe(true);
  });

  it('reads see unflushed writes and deletes, also after clearCache', async () => {
    await fs.writeFile('/tmp/wb-a', 'a');
    await fs.sync();
    await fs.unlink('/tmp/wb-a');
    await fs.writeFile('/tmp/wb-b', 'b');
    fs.clearCache();
    expect(await fs.exists('/tmp/wb-a')).toBe(false);
    expect(await fs.readFile('/tmp/wb-b', 'utf8')).toBe('b');
    const names = await fs.readdir('/tmp');
    expect(names).toContain('wb-b');
    expect(names).not.toContain('wb-a');
    await fs.sync();
    expect(await onDisk('/tmp/wb-a')).toBeNull();
    expect(await onDisk('/tmp/wb-b')).toBe('b');
  });

  it('keeps the directory listing current without re-reading every key', async () => {
    await fs.readdir('/tmp');
    txs.length = 0;
    for (let i = 0; i < 20; i++) {
      await fs.writeFile(`/tmp/wb-l${i}`, 'x');
      expect(await fs.readdir('/tmp')).toContain(`wb-l${i}`);
    }
    expect(txs.filter(m => m === 'readonly').length).toBe(0);
  });

  it('a delete then re-create of the same path ends with the file', async () => {
    await fs.writeFile('/tmp/wb-c', 'one');
    await fs.unlink('/tmp/wb-c');
    await fs.writeFile('/tmp/wb-c', 'two');
    await fs.sync();
    expect(await onDisk('/tmp/wb-c')).toBe('two');
  });

  it('appendFile through a symlink appends to the target', async () => {
    await fs.writeFile('/tmp/wb-target', 'a');
    await fs.symlink('/tmp/wb-target', '/tmp/wb-link');
    await fs.appendFile('/tmp/wb-link', 'b');
    expect(await fs.readFile('/tmp/wb-target', 'utf8')).toBe('ab');
    expect(await fs.readlink('/tmp/wb-link')).toBe('/tmp/wb-target');
  });

  it('sync reports a failed background flush once', async () => {
    const db = (fs as any).db as IDBDatabase;
    const orig = (db as any).transaction;
    (db as any).transaction = (store: any, mode?: IDBTransactionMode, opts?: any) => {
      // (quota errors are handled apart: storage-quota.test.ts)
      if (mode === 'readwrite') throw new DOMException('disk error', 'UnknownError');
      return orig(store, mode, opts);
    };
    const err = console.error;
    console.error = () => {};
    try {
      await fs.writeFile('/tmp/wb-q', 'x');
      await expect(fs.sync()).rejects.toThrow('disk error');
      await expect(fs.sync()).resolves.toBeUndefined();
      // The session keeps what was written
      expect(await fs.readFile('/tmp/wb-q', 'utf8')).toBe('x');
    } finally {
      console.error = err;
      (db as any).transaction = orig;
    }
  });

  it('the sync command flushes', async () => {
    const { fs: sfs, shell } = await createTestShell();
    shell.commands.register(syncCmd);
    await shell.execute('echo durable > /tmp/wb-sync.txt; sync', () => {}, () => {});
    expect(sfs.pendingWrites).toBe(0);
    expect(await onDisk('/tmp/wb-sync.txt')).toBe('durable\n');
  });
});

// apt's big files leave the in-memory cache once stored (FileSystem.contentBudget)
describe('FileSystem content eviction', () => {
  it('drops stored apt content over the budget and reads it back from IndexedDB', async () => {
    const fs = new FileSystem();
    await fs.init();
    fs.contentBudget = 300 << 10;
    await fs.mkdir('/var/cache/apt/archives', { recursive: true });
    const blob = (i: number) => Uint8Array.from({ length: 200 << 10 }, (_, k) => (k * 31 + i) & 0xff);
    for (let i = 0; i < 4; i++) await fs.writeFile(`/var/cache/apt/archives/p${i}.deb`, blob(i));
    // waiting to be stored: kept
    expect(fs.readBytesCached('/var/cache/apt/archives/p0.deb')).toBeDefined();
    await fs.sync();
    const cached = [0, 1, 2, 3].filter((i) => fs.readBytesCached(`/var/cache/apt/archives/p${i}.deb`) !== undefined);
    expect(cached.length).toBe(1); // 200 KiB fits in 300 KiB; the others were dropped
    expect((await fs.stat('/var/cache/apt/archives/p0.deb')).size).toBe(200 << 10);
    expect(await fs.readFile('/var/cache/apt/archives/p0.deb')).toEqual(blob(0));
    // changing an evicted file keeps its content
    await fs.chmod('/var/cache/apt/archives/p1.deb', 0o600);
    await fs.rename('/var/cache/apt/archives/p2.deb', '/var/cache/apt/archives/q2.deb');
    await fs.sync();
    expect(await fs.readFile('/var/cache/apt/archives/p1.deb')).toEqual(blob(1));
    expect(await fs.readFile('/var/cache/apt/archives/q2.deb')).toEqual(blob(2));
    const ino = fs.inoOf('/var/cache/apt/archives/p3.deb');
    expect(ino).toBeGreaterThan(0);
    // files elsewhere are never dropped (node programs read them synchronously)
    await fs.writeFile('/tmp/big.bin', blob(9));
    await fs.sync();
    expect(fs.readBytesCached('/tmp/big.bin')).toEqual(blob(9));
  });
});
