import { describe, it, expect, beforeEach } from 'vitest';
import { FileSystem } from '@shiro/filesystem';
import { createTestShell } from './helpers';
import { Kernel } from '@shiro/kernel/kernel';
import * as A from '@shiro/kernel/abi';

// Browser storage quota: IndexedDB aborts a commit with QuotaExceededError.
// The FileSystem must not diverge silently: nothing of the failed batch is on
// disk, writes that need space fail with ENOSPC, and freeing space lets the
// queued writes through.
describe('FileSystem when browser storage is full', () => {
  let fs: FileSystem;
  /** Bytes one transaction may add before the "browser" refuses it. */
  let room: number;

  beforeEach(async () => {
    fs = new FileSystem();
    await fs.init();
    await fs.sync();
    room = Infinity;
    const db = (fs as any).db as IDBDatabase;
    const orig = db.transaction.bind(db);
    (db as any).transaction = (store: any, mode?: IDBTransactionMode, opts?: any) => {
      const tx = orig(store, mode, opts);
      if (mode !== 'readwrite') return tx;
      let bytes = 0;
      const real = tx.objectStore.bind(tx);
      (tx as any).objectStore = (name: string) => {
        const os = real(name);
        const put = os.put.bind(os);
        (os as any).put = (v: any) => {
          bytes += v?.content?.byteLength ?? 0;
          if (bytes > room && !(tx as any).__quota) {
            (tx as any).__quota = true;
            Object.defineProperty(tx, 'error', { get: () => new DOMException('The quota has been exceeded.', 'QuotaExceededError') });
            queueMicrotask(() => tx.abort());
          }
          return put(v);
        };
        return os;
      };
      return tx;
    };
  });

  async function onDisk(path: string): Promise<string | null> {
    const other = new FileSystem();
    await other.init();
    try { return await other.readFile(path, 'utf8') as string; } catch { return null; }
  }

  it('fails with ENOSPC, keeps the disk at the last good commit, and recovers after a delete', async () => {
    await fs.writeFile('/tmp/q-keep', 'committed');
    await fs.sync();
    const events: boolean[] = [];
    fs.onStorageFull(f => events.push(f));

    room = 64 * 1024;
    await fs.writeFile('/tmp/q-small', 'small'); // in the same batch as the big one
    await fs.writeFile('/tmp/q-big', new Uint8Array(200 * 1024));
    await expect(fs.sync()).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(fs.storageFull).toBe(true);
    expect(events).toEqual([true]);
    // the session still sees what it wrote; the disk has none of the failed batch
    expect(await fs.readFile('/tmp/q-small', 'utf8')).toBe('small');
    expect(await onDisk('/tmp/q-small')).toBeNull();
    expect(await onDisk('/tmp/q-big')).toBeNull();
    expect(await onDisk('/tmp/q-keep')).toBe('committed');

    // writes that need space fail at once; ones that don't go through
    await expect(fs.writeFile('/tmp/q-new', 'x')).rejects.toMatchObject({ code: 'ENOSPC' });
    await expect(fs.mkdir('/tmp/q-dir')).rejects.toMatchObject({ code: 'ENOSPC' });
    await expect(fs.appendFile('/tmp/q-keep', 'more')).rejects.toMatchObject({ code: 'ENOSPC' });
    await expect(fs.writeFile('/tmp/q-keep', 'short')).resolves.toBeUndefined();
    await expect(fs.chmod('/tmp/q-keep', 0o600)).resolves.toBeUndefined();
    await expect(fs.rename('/tmp/q-small', '/tmp/q-small2')).resolves.toBeUndefined();
    await expect(fs.flushed()).rejects.toMatchObject({ code: 'ENOSPC' });

    // freeing space: the deletes and the queued writes commit together
    await fs.unlink('/tmp/q-big');
    await fs.sync();
    expect(fs.storageFull).toBe(false);
    expect(events).toEqual([true, false]);
    expect(await onDisk('/tmp/q-small2')).toBe('small');
    expect(await onDisk('/tmp/q-keep')).toBe('short');
    expect(await onDisk('/tmp/q-big')).toBeNull();
    await fs.writeFile('/tmp/q-new', 'x');
    await fs.sync();
    expect(await onDisk('/tmp/q-new')).toBe('x');
  });

  it('close(2) and fsync(2) report ENOSPC instead of losing the data silently', async () => {
    const { shell } = await createTestShell();
    const kernel = new Kernel({ shell, fs });
    const proc = kernel.spawn({ path: 'q', cwd: '/tmp', fds: {}, run: () => new Promise<number>(() => {}) });
    const data = new Uint8Array(300 * 1024);
    const path = (s: string) => { const b = new TextEncoder().encode(s); data.set(b); return b.length; };

    await fs.writeFile('/tmp/q-out', '');
    await fs.sync();
    room = 64 * 1024;
    const fd = await kernel.syscall(proc, A.SYS_openat, [A.AT_FDCWD, path('/tmp/q-out'), A.O_WRONLY, 0o644], data);
    expect(fd).toBeGreaterThanOrEqual(0);
    data.fill(0x61);
    expect(await kernel.syscall(proc, A.SYS_write, [fd, 200 * 1024], data)).toBe(200 * 1024);
    expect(await kernel.syscall(proc, A.SYS_fsync, [fd], data)).toBe(-A.ENOSPC);
    expect(fs.storageFull).toBe(true);
    // storage is known to be full now: more data is refused at write-back
    expect(await kernel.syscall(proc, A.SYS_write, [fd, 1024], data)).toBe(1024);
    expect(await kernel.syscall(proc, A.SYS_close, [fd], data)).toBe(-A.ENOSPC);
    expect(await onDisk('/tmp/q-out')).toBe('');
    // the fd is gone all the same, and no inode is left behind
    expect(await kernel.syscall(proc, A.SYS_close, [fd], data)).toBe(-A.EBADF);
    kernel.kill(proc.pid, A.SIGKILL);
  });
});

describe('FileSystem.flushAll (the page going away, Restart)', () => {
  it("commits an open file's buffered writes and everything pending", async () => {
    const { shell, fs } = await createTestShell();
    const kernel = new Kernel({ shell, fs });
    const proc = kernel.spawn({ path: 'w', cwd: '/tmp', fds: {}, run: () => new Promise<number>(() => {}) });
    const data = new Uint8Array(4096);
    const n = new TextEncoder().encodeInto('/tmp/open-file', data).written!;
    const fd = await kernel.syscall(proc, A.SYS_openat, [A.AT_FDCWD, n, A.O_WRONLY | A.O_CREAT, 0o644], data);
    data.set(new TextEncoder().encode('unsaved'));
    expect(await kernel.syscall(proc, A.SYS_write, [fd, 7], data)).toBe(7);
    await fs.writeFile('/tmp/closed-file', 'closed');
    await fs.flushAll();
    expect(fs.pendingWrites).toBe(0);
    const other = new FileSystem();
    await other.init();
    expect(await other.readFile('/tmp/open-file', 'utf8')).toBe('unsaved');
    expect(await other.readFile('/tmp/closed-file', 'utf8')).toBe('closed');
    kernel.kill(proc.pid, A.SIGKILL);
  });
});
