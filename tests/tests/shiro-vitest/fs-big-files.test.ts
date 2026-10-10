import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileSystem } from '@shiro/filesystem';
import { openInode, RegularFile } from '@shiro/kernel/fd';
import * as A from '@shiro/kernel/abi';
import { Kernel } from '@shiro/kernel/kernel';
import { createTestShell } from './helpers';

// Big files (FSNode.blob): stored as block records, written and read by the
// kernel's open files a page at a time. Small BLOB_MIN/BLOCK keep it quick.
describe('FileSystem big files', () => {
  const saved = { min: FileSystem.BLOB_MIN, block: FileSystem.BLOCK };
  beforeEach(() => { FileSystem.BLOB_MIN = 8 << 10; FileSystem.BLOCK = 1 << 10; });
  afterEach(() => { FileSystem.BLOB_MIN = saved.min; FileSystem.BLOCK = saved.block; });

  const pattern = (n: number, seed = 1) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + seed * 7 + (i >> 10)) & 255; return b; };
  /** What IndexedDB holds: records by key. */
  async function stored(fs: FileSystem): Promise<Map<string, any>> {
    await fs.sync();
    const db = (fs as any).db as IDBDatabase;
    const all = await new Promise<any[]>((r, j) => { const q = db.transaction('files').objectStore('files').getAll(); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
    return new Map(all.map((n) => [n.path, n]));
  }
  const blocksOf = (recs: Map<string, any>, id: string) => [...recs.keys()].filter((k) => k.startsWith(`\u0001b/${id}/`));
  async function fresh(): Promise<FileSystem> { const fs = new FileSystem(); await fs.init(); return fs; }

  it('writeFile stores a big file as blocks, read back by a new instance', async () => {
    const fs = await fresh();
    await fs.mkdir('/tmp/bf1', { recursive: true });
    const data = pattern(20000);
    await fs.writeFile('/tmp/bf1/a.bin', data);
    const recs = await stored(fs);
    const node = recs.get('/tmp/bf1/a.bin');
    expect(node.content).toBeNull();
    expect(node.blob).toBeTruthy();
    expect(blocksOf(recs, node.blob)).toHaveLength(20);
    const other = await fresh();
    expect(await other.readdir('/tmp/bf1')).toEqual(['a.bin']);
    expect(await other.readFile('/tmp/bf1/a.bin')).toEqual(data);
    expect((await other.stat('/tmp/bf1/a.bin')).size).toBe(20000);
  });

  it('deletes a big file\'s blocks when it is replaced, unlinked or under rm -r, and keeps them across a rename', async () => {
    const fs = await fresh();
    await fs.mkdir('/tmp/bf2/sub', { recursive: true });
    for (const n of ['r', 'u', 'm', 'sub/x']) await fs.writeFile(`/tmp/bf2/${n}`, pattern(10000, n.length));
    let recs = await stored(fs);
    const id = (p: string) => recs.get(p).blob as string;
    const ids = { r: id('/tmp/bf2/r'), u: id('/tmp/bf2/u'), m: id('/tmp/bf2/m'), x: id('/tmp/bf2/sub/x') };
    await fs.writeFile('/tmp/bf2/r', 'small now');
    await fs.unlink('/tmp/bf2/u');
    await fs.rename('/tmp/bf2/m', '/tmp/bf2/moved');
    recs = await stored(fs);
    expect(blocksOf(recs, ids.r)).toHaveLength(0);
    expect(blocksOf(recs, ids.u)).toHaveLength(0);
    expect(blocksOf(recs, ids.m)).toHaveLength(10);
    expect(await (await fresh()).readFile('/tmp/bf2/moved')).toEqual(pattern(10000, 1));
    // Renamed over: the target's blocks go, the source's stay
    await fs.writeFile('/tmp/bf2/other', pattern(9000, 5));
    const otherId = (await stored(fs)).get('/tmp/bf2/other').blob;
    await fs.rename('/tmp/bf2/moved', '/tmp/bf2/other');
    recs = await stored(fs);
    expect(blocksOf(recs, otherId)).toHaveLength(0);
    expect(blocksOf(recs, ids.m)).toHaveLength(10);
    await fs.rm('/tmp/bf2', { recursive: true });
    recs = await stored(fs);
    expect(blocksOf(recs, ids.x)).toHaveLength(0);
    expect(blocksOf(recs, ids.m)).toHaveLength(0);
    // A new instance agrees (the blob map is stored too)
    const other = await fresh();
    await other.mkdir('/tmp/bf2b', { recursive: true });
    await other.writeFile('/tmp/bf2b/y', pattern(9000));
    const y = (await stored(other)).get('/tmp/bf2b/y').blob;
    const third = await fresh();
    await third.unlink('/tmp/bf2b/y');
    expect(blocksOf(await stored(third), y)).toHaveLength(0);
  });

  it('exportAll gives big files with their bytes and no block records; importAll takes them back', async () => {
    const fs = await fresh();
    await fs.writeFile('/tmp/bf3.bin', pattern(12345));
    const nodes = await fs.exportAll();
    expect(nodes.some((n) => n.path.startsWith('\u0001'))).toBe(false);
    const n = nodes.find((x) => x.path === '/tmp/bf3.bin')!;
    expect(n.blob).toBeUndefined();
    expect(n.content).toEqual(pattern(12345));
    await fs.importAll(nodes);
    expect(await fs.readFile('/tmp/bf3.bin')).toEqual(pattern(12345));
  });

  async function open(fs: FileSystem, path: string, flags = A.O_RDWR) {
    return new RegularFile(await openInode(fs, path), flags);
  }

  it('a file written through the kernel goes to blocks without holding it all, and reads back a page at a time', async () => {
    const fs = await fresh();
    await fs.writeFile('/tmp/bf4.bin', new Uint8Array(0));
    const f = await open(fs, '/tmp/bf4.bin');
    const data = pattern(200 << 10);
    let maxPages = 0;
    for (let off = 0; off < data.length; off += 3000) {
      expect(await f.write(data.subarray(off, off + 3000))).toBe(Math.min(3000, data.length - off));
      maxPages = Math.max(maxPages, ((f as any).ino.pages as Map<number, Uint8Array>).size);
    }
    // 200 pages written, never more than the dirty limit plus a few clean ones held
    expect(maxPages).toBeLessThanOrEqual(8 + 4 + 2);
    await f.close();
    const recs = await stored(fs);
    expect(recs.get('/tmp/bf4.bin').blob).toBeTruthy();
    expect(recs.get('/tmp/bf4.bin').size).toBe(data.length);
    const other = await fresh();
    expect(await other.readFile('/tmp/bf4.bin')).toEqual(data);
    const r = await open(other, '/tmp/bf4.bin', A.O_RDONLY);
    const buf = new Uint8Array(5000);
    const got = new Uint8Array(data.length);
    for (let off = 0; ;) { const n = await r.read(buf); if (!n) break; got.set(buf.subarray(0, n), off); off += n; }
    expect(got).toEqual(data);
    expect(((r as any).ino.pages as Map<number, Uint8Array>).size).toBeLessThanOrEqual(4 + 5);
    await r.close();
  });

  it.each([12345, 777, 4242])('matches a byte array under random writes, truncates and reopens (seed %i)', async (start) => {
    const fs = await fresh();
    let seed = start;
    const rnd = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n; };
    let model = new Uint8Array(0);
    const path = `/tmp/bf5-${start}.bin`;
    await fs.writeFile(path, model);
    let f = await open(fs, path);
    const check = async () => {
      expect((await f.stat()).size).toBe(model.length);
      const got = new Uint8Array(model.length);
      expect(await f.pread(got, 0)).toBe(model.length);
      expect(got).toEqual(model);
    };
    for (let step = 0; step < 400; step++) {
      const op = rnd(10);
      if (op < 6) {
        const off = rnd(Math.max(1, model.length + 4000));
        const len = 1 + rnd(op < 2 ? 6000 : 700);
        const bytes = new Uint8Array(len).map(() => rnd(256));
        if (op % 2) {
          f.seek(off, A.SEEK_SET);
          if (f.tryWrite(bytes) === undefined) await f.write(bytes);
        } else await f.pwrite(bytes, off);
        if (off + len > model.length) { const m = new Uint8Array(off + len); m.set(model); model = m; }
        model.set(bytes, off);
      } else if (op < 8) {
        const len = rnd(model.length + 12000);
        await f.truncate(len);
        const m = new Uint8Array(len); m.set(model.subarray(0, Math.min(len, model.length))); model = m;
      } else if (op === 8) {
        await f.close();
        if (rnd(2)) { await fs.sync(); }
        f = await open(fs, path);
      } else await check();
    }
    await check();
    await f.close();
    expect(await (await fresh()).readFile(path)).toEqual(model);
  });

  it('O_TRUNC of a big file (truncate to 0) makes it small again and drops its blocks', async () => {
    const fs = await fresh();
    await fs.writeFile('/tmp/bf6.bin', pattern(30000));
    const id = (await stored(fs)).get('/tmp/bf6.bin').blob;
    const f = await open(fs, '/tmp/bf6.bin');
    await f.truncate(0);
    await f.write(new TextEncoder().encode('hello'));
    await f.close();
    const recs = await stored(fs);
    expect(recs.get('/tmp/bf6.bin').blob).toBeUndefined();
    expect(blocksOf(recs, id)).toHaveLength(0);
    expect(await fs.readFile('/tmp/bf6.bin', 'utf8')).toBe('hello');
  });

  it('a read the kernel can\'t finish at once (a page to load) takes the async path, not a readiness wait', async () => {
    const { fs, shell } = await createTestShell();
    await fs.writeFile('/tmp/bf7.bin', pattern(50000));
    await fs.sync();
    fs.sweepContent(Date.now() + FileSystem.CONTENT_IDLE_MS + 1); // the content leaves memory: pages load from blocks
    const kernel = new Kernel({ shell });
    try {
      const proc = kernel.spawn({ path: 'reader', cwd: '/tmp', fds: {}, run: () => new Promise<number>(() => {}) });
      const data = new Uint8Array(4096);
      const path = new TextEncoder().encode('/tmp/bf7.bin');
      data.set(path);
      const fd = await kernel.syscall(proc, A.SYS_open, [path.length, A.O_RDONLY, 0], data);
      expect(fd).toBeGreaterThanOrEqual(0);
      expect(kernel.syscallSync(proc, A.SYS_read, [fd, 4096], data)).toBeUndefined();
      expect(kernel.readinessFile(proc, A.SYS_read, [fd, 4096])).toBeUndefined();
      expect(await kernel.syscall(proc, A.SYS_read, [fd, 1000], data)).toBe(1000);
      expect(data.subarray(0, 1000)).toEqual(pattern(50000).subarray(0, 1000));
      expect(kernel.syscallSync(proc, A.SYS_read, [fd, 24], data)).toBe(24); // the rest of that page is loaded now
      expect(data.subarray(0, 24)).toEqual(pattern(50000).subarray(1000, 1024));
      kernel.kill(proc.pid, A.SIGKILL);
    } finally { kernel.dispose(); }
  });
});
