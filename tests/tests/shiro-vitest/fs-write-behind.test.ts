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

// rm -r deletes a directory's contents from IndexedDB as one key range
describe('FileSystem rm -r (range delete)', () => {
  async function onDisk(path: string): Promise<string | null> {
    const other = new FileSystem();
    await other.init();
    try { return await other.readFile(path, 'utf8') as string; } catch { return null; }
  }

  it('removes the tree at once, keeps what is created in it afterwards, and spares lookalike siblings', async () => {
    const fs = new FileSystem();
    await fs.init();
    await fs.mkdir('/tmp/rr/nm/a/b', { recursive: true });
    for (let i = 0; i < 50; i++) await fs.writeFile(`/tmp/rr/nm/a/b/f${i}`, `x${i}`);
    await fs.mkdir('/tmp/rr/nm2', { recursive: true });
    await fs.writeFile('/tmp/rr/nm2/keep', 'sibling');
    await fs.writeFile('/tmp/rr/nm-x', 'lookalike');
    await fs.sync();
    await fs.writeFile('/tmp/rr/nm/a/pending', 'not yet stored'); // queued, superseded by the rm
    await fs.rm('/tmp/rr/nm', { recursive: true });
    expect(await fs.exists('/tmp/rr/nm')).toBe(false);
    expect(await fs.exists('/tmp/rr/nm/a/b/f1')).toBe(false);
    expect(await fs.readdir('/tmp/rr')).toEqual(expect.arrayContaining(['nm2', 'nm-x']));
    expect(await fs.readdir('/tmp/rr')).not.toContain('nm');
    // re-created before the range delete is committed: kept
    await fs.mkdir('/tmp/rr/nm/a', { recursive: true });
    await fs.writeFile('/tmp/rr/nm/a/new', 'new');
    // a reload of the cache before the commit doesn't bring the old tree back
    fs.clearCache();
    expect(await fs.exists('/tmp/rr/nm/a/b/f1')).toBe(false);
    expect(await fs.readFile('/tmp/rr/nm/a/new', 'utf8')).toBe('new');
    await fs.sync();
    expect(await onDisk('/tmp/rr/nm/a/b/f1')).toBeNull();
    expect(await onDisk('/tmp/rr/nm/a/pending')).toBeNull();
    expect(await onDisk('/tmp/rr/nm/a/new')).toBe('new');
    expect(await onDisk('/tmp/rr/nm2/keep')).toBe('sibling');
    expect(await onDisk('/tmp/rr/nm-x')).toBe('lookalike');
    const other = new FileSystem();
    await other.init();
    expect((await other.readdir('/tmp/rr/nm/a')).sort()).toEqual(['new']);
  });
});

describe('FileSystem key index at boot', () => {
  it('a held key index loads after release, or at once for a readdir', async () => {
    const seed = new FileSystem();
    await seed.init();
    await seed.writeFile('/home/user/held.txt', 'x');
    await seed.sync();
    const count = () => { let n = 0; const P = IDBObjectStore.prototype as any; const orig = P.getAllKeys; P.getAllKeys = function (...a: any[]) { n++; return orig.apply(this, a); }; return { get n() { return n; }, restore: () => { P.getAllKeys = orig; } }; };

    const c = count();
    try {
      const fs = new FileSystem();
      fs.holdKeyIndex(60_000);
      await fs.init(); // reads a few paths: these would start the key index
      expect(await fs.exists('/home/user/held.txt')).toBe(true);
      expect(c.n).toBe(0);
      fs.releaseKeyIndex();
      expect(c.n).toBe(1);

      const fs2 = new FileSystem();
      fs2.holdKeyIndex(60_000);
      await fs2.init();
      expect(await fs2.readdir('/home/user')).toContain('held.txt');
      expect(c.n).toBe(2);
      fs2.releaseKeyIndex(); // already loaded: nothing more
      expect(c.n).toBe(2);
    } finally {
      c.restore();
    }
  });
});
