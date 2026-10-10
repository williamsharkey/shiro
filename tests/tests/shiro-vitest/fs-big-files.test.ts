import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileSystem } from '@shiro/filesystem';
import { openInode, RegularFile } from '@shiro/kernel/fd';
import * as A from '@shiro/kernel/abi';
import { Kernel } from '@shiro/kernel/kernel';
import { createTestShell } from './helpers';

// Big files (FSNode.blob): stored as block records, written and read by the
// kernel's open files a page at a time. Small BLOB_MIN/BLOCK keep it quick.
// Generous timeouts: these run many IndexedDB transactions and kernel writes,
// slow under a full parallel suite run (5 s, the default, was hit once)
describe('FileSystem big files', { timeout: 60_000 }, () => {
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
  /** Every block record belongs to a blob the stored map gives to a stored node of that blob, and every such node's blocks are there. */
  function checkStore(recs: Map<string, any>): void {
    const map = new Map<string, string>(recs.get('\u0001blobs')?.blobs ?? []);
    const owners = new Map([...map].map(([p, id]) => [id, p]));
    for (const k of recs.keys()) {
      if (!k.startsWith('\u0001b/')) continue;
      const id = k.slice(3, k.lastIndexOf('/'));
      const owner = owners.get(id);
      expect(owner, `orphaned block ${k}`).toBeDefined();
      expect(recs.get(owner!)?.blob, `block ${k} of a blob its owner ${owner} doesn't use`).toBe(id);
    }
    for (const [p, n] of recs) {
      if (!n.blob) continue;
      expect(map.get(p), `node ${p} missing from the blob map`).toBe(n.blob);
      // None past the end (a missing one inside reads as zeros: cut off by a truncate, then grown back)
      for (const k of blocksOf(recs, n.blob)) expect(parseInt(k.slice(k.lastIndexOf('/') + 1), 16) * FileSystem.BLOCK, `${k} past the end of ${p}`).toBeLessThan(n.size);
    }
  }

  it('reads, writes and deletes a big file an earlier build stored as one record', async () => {
    const fs = await fresh();
    await fs.mkdir('/tmp/old', { recursive: true });
    await fs.sync();
    // As builds before blocks stored it: content inline, no blob
    const db = (fs as any).db as IDBDatabase;
    const put = (node: any) => new Promise<void>((r, j) => { const tx = db.transaction('files', 'readwrite'); tx.objectStore('files').put(node); tx.oncomplete = () => r(); tx.onerror = () => j(tx.error); });
    const now = Date.now();
    for (const n of ['a', 'b', 'c', 'd']) await put({ path: `/tmp/old/${n}`, type: 'file', content: pattern(20000, n.charCodeAt(0)), mode: 0o644, mtime: now, ctime: now, size: 20000 });
    const up = await fresh();
    // Read as it is
    expect(await up.readFile('/tmp/old/a')).toEqual(pattern(20000, 97));
    // Rewritten by writeFile: now blocks
    await up.writeFile('/tmp/old/b', pattern(15000, 3));
    // Written through the kernel in place, and grown: blocks once it grows
    const f = await open(up, '/tmp/old/c');
    await f.pwrite(new Uint8Array(100).fill(9), 500);
    await f.pwrite(new Uint8Array(3000).fill(8), 20000);
    await f.close();
    // Deleted
    await up.unlink('/tmp/old/d');
    const recs = await stored(up);
    checkStore(recs);
    expect(recs.get('/tmp/old/a').blob).toBeUndefined(); // left as it was until rewritten
    expect(recs.get('/tmp/old/b').blob).toBeTruthy();
    expect(recs.has('/tmp/old/d')).toBe(false);
    const c = pattern(23000, 99); c.set(pattern(20000, 99).subarray(0, 20000)); c.fill(9, 500, 600); c.fill(8, 20000, 23000);
    const again = await fresh();
    expect(await again.readFile('/tmp/old/a')).toEqual(pattern(20000, 97));
    expect(await again.readFile('/tmp/old/b')).toEqual(pattern(15000, 3));
    expect(await again.readFile('/tmp/old/c')).toEqual(c);
    expect(await again.exists('/tmp/old/d')).toBe(false);
  });

  it('a reload at any moment of a kernel write finds a whole earlier state of the file (one transaction per write-back)', async () => {
    const fs = await fresh();
    await fs.writeFile('/tmp/crash.bin', new Uint8Array(0));
    await fs.sync();
    const f = await open(fs, '/tmp/crash.bin');
    const data = pattern(120 << 10, 4);
    let checks = 0;
    for (let off = 0; off < data.length; off += 1500) {
      await f.write(data.subarray(off, off + 1500));
      if ((off / 1500) % 7 === 3) {
        await new Promise((r) => setTimeout(r, (off / 1500) % 30)); // write-backs and commits happen in between
        // What another tab (or this one after a reload) would find: only committed transactions
        const other = await fresh();
        const got = await other.readFile('/tmp/crash.bin') as Uint8Array;
        // A prefix: never a hole or a torn block (the first differing byte, if any, says where)
        const bad = got.findIndex((x, i) => x !== data[i]);
        expect(bad, `byte ${bad} of a ${got.length}-byte snapshot`).toBe(-1);
        checkStore(await stored(other).catch(() => new Map()) as Map<string, any>);
        checks++;
      }
    }
    await f.close();
    expect(checks).toBeGreaterThan(5);
    const recs = await stored(fs);
    checkStore(recs);
    expect(await (await fresh()).readFile('/tmp/crash.bin')).toEqual(data);
  });

  it('a write-back whose transaction aborts leaves the last committed file and blob map', async () => {
    const fs = await fresh();
    await fs.writeFile('/tmp/abort.bin', pattern(30000, 6));
    await fs.sync();
    const db = (fs as any).db as IDBDatabase;
    const orig = db.transaction.bind(db);
    (db as any).transaction = (store: any, mode?: IDBTransactionMode, opts?: any) => {
      const tx = orig(store, mode, opts);
      if (mode === 'readwrite') queueMicrotask(() => tx.abort());
      return tx;
    };
    const f = await open(fs, '/tmp/abort.bin');
    await f.pwrite(new Uint8Array(5000).fill(1), 2000);
    await f.pwrite(new Uint8Array(4000).fill(2), 30000); // grows it
    await f.close().catch(() => {});
    await fs.sync().catch(() => {});
    await fs.writeFile('/tmp/abort.bin', pattern(9000, 7)).catch(() => {}); // a new blob, its old one dropped: also aborted
    await fs.sync().catch(() => {});
    (db as any).transaction = orig;
    const other = await fresh();
    expect(await other.readFile('/tmp/abort.bin')).toEqual(pattern(30000, 6));
    // stored() reads through `other`; its queue is empty
    checkStore(await stored(other));
  });

  it('rm -rf of a tree of big files, by range or file by file, leaves no blocks behind', async () => {
    const fs = await fresh();
    const files: string[] = [];
    for (const d of ['/tmp/tree1/a/b', '/tmp/tree1/c', '/tmp/tree2/x/y']) {
      await fs.mkdir(d, { recursive: true });
      for (let i = 0; i < 3; i++) { const p = `${d}/f${i}.bin`; files.push(p); await fs.writeFile(p, pattern(9000 + i * 5000, i)); }
    }
    // One written through the kernel too
    await fs.writeFile('/tmp/tree1/c/k.bin', new Uint8Array(0));
    const k = await open(fs, '/tmp/tree1/c/k.bin');
    await k.write(pattern(40000, 9));
    await k.close();
    let recs = await stored(fs);
    checkStore(recs);
    const ids = [...recs].filter(([p, n]) => p.startsWith('/tmp/tree') && n.blob).map(([, n]) => n.blob as string);
    expect(ids).toHaveLength(10);
    expect(ids.flatMap((id) => blocksOf(recs, id)).length).toBeGreaterThan(100);
    await fs.rm('/tmp/tree1', { recursive: true }); // one range delete
    for (const p of files.filter((x) => x.startsWith('/tmp/tree2/'))) await fs.unlink(p); // as rm -r in Blink does: unlink each
    recs = await stored(fs);
    checkStore(recs);
    expect(ids.flatMap((id) => blocksOf(recs, id))).toEqual([]);
    expect(recs.get('\u0001blobs').blobs.filter(([p]: [string]) => p.startsWith('/tmp/tree'))).toEqual([]);
  });
  it('a big lazy file (streamed root filesystem) is stored as blocks once fetched, and opened by the kernel as pages', async () => {
    const fs = await fresh();
    await fs.mkdir('/tmp/lazy', { recursive: true });
    const now = Date.now();
    const bytes = { big: pattern(30000, 11), small: pattern(3000, 12) };
    fs.setLazyLoader(async (ref) => bytes[ref.chunk as 'big' | 'small']);
    fs.putNodes([
      { path: '/tmp/lazy/big.so', type: 'file', content: null, mode: 0o755, mtime: now, ctime: now, size: 30000, lazy: { src: 't', chunk: 'big', off: 0 } },
      { path: '/tmp/lazy/small', type: 'file', content: null, mode: 0o644, mtime: now, ctime: now, size: 3000, lazy: { src: 't', chunk: 'small', off: 0 } },
    ]);
    const f = await open(fs, '/tmp/lazy/big.so', A.O_RDONLY);
    expect((f as any).ino.blob).toBeTruthy(); // pages, not the whole file
    const buf = new Uint8Array(30000);
    expect(await f.pread(buf, 0)).toBe(30000);
    expect(buf).toEqual(bytes.big);
    await f.close();
    expect(await fs.readFile('/tmp/lazy/small')).toEqual(bytes.small);
    const recs = await stored(fs);
    checkStore(recs);
    expect(recs.get('/tmp/lazy/big.so').blob).toBeTruthy();
    expect(recs.get('/tmp/lazy/big.so').lazy).toBeUndefined();
    expect(recs.get('/tmp/lazy/small').blob).toBeUndefined();
    const other = await fresh(); // no loader: it is local now
    expect(await other.readFile('/tmp/lazy/big.so')).toEqual(bytes.big);
  });
  it('createWriter: a big file goes to blocks as written and appears at close; small ones are plain; abort leaves nothing', async () => {
    const fs = await fresh();
    await fs.mkdir('/tmp/w', { recursive: true });
    await fs.writeFile('/tmp/w/big', pattern(20000, 1)); // replaced below
    const oldId = (await stored(fs)).get('/tmp/w/big').blob;
    const data = pattern(50000, 2);
    const w = await fs.createWriter('/tmp/w/big');
    for (let i = 0; i < data.length; i += 3333) await w.write(data.slice(i, i + 3333));
    expect(await fs.readFile('/tmp/w/big')).toEqual(pattern(20000, 1)); // not yet
    await w.close();
    expect(await fs.readFile('/tmp/w/big')).toEqual(data);
    const s = await fs.createWriter('/tmp/w/small');
    await s.write(new TextEncoder().encode('hello '));
    await s.write(new TextEncoder().encode('world'));
    await s.close();
    const a = await fs.createWriter('/tmp/w/aborted');
    for (let i = 0; i < 30; i++) await a.write(pattern(1000, i));
    a.abort();
    const recs = await stored(fs);
    checkStore(recs);
    expect(blocksOf(recs, oldId)).toHaveLength(0);
    expect(recs.get('/tmp/w/big').blob).toBeTruthy();
    expect(recs.get('/tmp/w/small').blob).toBeUndefined();
    expect(recs.has('/tmp/w/aborted')).toBe(false);
    expect([...recs.keys()].some((k) => k.startsWith('\u0001w/'))).toBe(false);
    expect(await (await fresh()).readFile('/tmp/w/small', 'utf8')).toBe('hello world');
    expect(await (await fresh()).readFile('/tmp/w/big')).toEqual(data);
  });

  it('createWriter: blocks of a file never closed (the page went away) are dropped by the next start', async () => {
    const fs = await fresh();
    await fs.mkdir('/tmp/w2', { recursive: true });
    const w = await fs.createWriter('/tmp/w2/f');
    for (let i = 0; i < 40; i++) await w.write(pattern(1000, i));
    await fs.sync(); // its blocks are in IndexedDB; no node yet
    let recs = await stored(fs);
    const writing = [...recs.get('\u0001blobs').blobs].filter(([p]: [string]) => p.startsWith('\u0001w/'));
    expect(writing).toHaveLength(1);
    expect(blocksOf(recs, writing[0][1]).length).toBeGreaterThan(30);
    const next = await fresh(); // a reload
    recs = await stored(next);
    checkStore(recs);
    expect(blocksOf(recs, writing[0][1])).toHaveLength(0);
    expect(await next.exists('/tmp/w2/f')).toBe(false);
  });
});
