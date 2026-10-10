import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileSystem } from '@shiro/filesystem';
import { openInode, RegularFile } from '@shiro/kernel/fd';
import { Kernel } from '@shiro/kernel/kernel';
import * as A from '@shiro/kernel/abi';
import { createTestShell, run } from './helpers';

// Hard links (FileSystem.link): one file, several names. Data in an inode
// record ("\u0001i/<ino>"), names as stubs, the name map at "\u0001links".
describe('hard links', () => {
  const saved = { min: FileSystem.BLOB_MIN, block: FileSystem.BLOCK };
  beforeEach(() => { FileSystem.BLOB_MIN = 8 << 10; FileSystem.BLOCK = 1 << 10; });
  afterEach(() => { FileSystem.BLOB_MIN = saved.min; FileSystem.BLOCK = saved.block; });

  const enc = (s: string) => new TextEncoder().encode(s);
  const text = async (fs: FileSystem, p: string) => fs.readFile(p, 'utf8');
  const pattern = (n: number, seed = 1) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + seed * 7 + (i >> 10)) & 255; return b; };
  async function fresh(): Promise<FileSystem> { const fs = new FileSystem(); await fs.init(); return fs; }
  async function stored(fs: FileSystem): Promise<Map<string, any>> {
    await fs.sync();
    const db = (fs as any).db as IDBDatabase;
    const all = await new Promise<any[]>((r, j) => { const q = db.transaction('files').objectStore('files').getAll(); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
    return new Map(all.map((n) => [n.path, n]));
  }
  /** Stubs, inode records and the link map agree; blocks belong to live owners. */
  function checkStore(recs: Map<string, any>): void {
    const map = new Map<string, number>(recs.get('\u0001links')?.links ?? []);
    for (const [p, n] of recs) {
      if (p.startsWith('\u0001i/')) {
        expect(n.names.length, `${p} has fewer than 2 names`).toBeGreaterThanOrEqual(2);
        for (const name of n.names) {
          expect(recs.get(name)?.link, `${name} of ${p} is not its stub`).toBe(n.ino);
          expect(map.get(name), `${name} missing from the link map`).toBe(n.ino);
        }
      } else if (!p.startsWith('\u0001') && n.link !== undefined) {
        expect(recs.get(`\u0001i/${n.link}`)?.names, `stub ${p} without its inode`).toContain(p);
      }
    }
    for (const [name, ino] of map) expect(recs.get(name)?.link, `link map entry ${name}`).toBe(ino);
    const blobs = new Map<string, string>(recs.get('\u0001blobs')?.blobs ?? []);
    const owners = new Map([...blobs].map(([p, id]) => [id, p]));
    for (const k of recs.keys()) {
      if (!k.startsWith('\u0001b/')) continue;
      const id = k.slice(3, k.lastIndexOf('/'));
      const owner = owners.get(id);
      expect(owner, `orphaned block ${k}`).toBeDefined();
      expect(recs.get(owner!)?.blob, `block ${k} of a blob its owner doesn't use`).toBe(id);
    }
  }

  it('two names share data, mode, times, st_ino and st_nlink, across a reload', async () => {
    const fs = await fresh();
    await fs.mkdir('/tmp/hl1', { recursive: true });
    await fs.writeFile('/tmp/hl1/a', 'one');
    const ino = (await fs.stat('/tmp/hl1/a')).ino;
    await fs.link('/tmp/hl1/a', '/tmp/hl1/b');
    for (const p of ['a', 'b']) {
      const st = await fs.stat(`/tmp/hl1/${p}`) as any;
      expect([st.nlink, st.ino]).toEqual([2, ino]);
    }
    await fs.writeFile('/tmp/hl1/b', 'two');
    expect(await text(fs, '/tmp/hl1/a')).toBe('two');
    await fs.chmod('/tmp/hl1/a', 0o600);
    expect((await fs.stat('/tmp/hl1/b')).mode & 0o777).toBe(0o600);
    await fs.utimes('/tmp/hl1/b', 1000, 2000);
    expect((await fs.stat('/tmp/hl1/a')).mtime.getTime()).toBe(2000);
    const recs = await stored(fs);
    checkStore(recs);
    expect(recs.get('/tmp/hl1/a').link).toBe(ino);
    expect(recs.get('/tmp/hl1/a').content).toBeNull();
    const other = await fresh();
    expect(await text(other, '/tmp/hl1/b')).toBe('two');
    expect(((await other.stat('/tmp/hl1/a')) as any).nlink).toBe(2);
    expect((await other.stat('/tmp/hl1/b')).ino).toBe(ino);
    expect((await other.readdir('/tmp/hl1')).sort()).toEqual(['a', 'b']);
    await other.writeFile('/tmp/hl1/a', 'three'); // a write after a reload reaches both names
    expect(await text(other, '/tmp/hl1/b')).toBe('three');
  });

  it('unlink drops a name; one name left is a plain file again; none left frees it', async () => {
    const fs = await fresh();
    await fs.mkdir('/tmp/hl2', { recursive: true });
    await fs.writeFile('/tmp/hl2/a', 'data');
    await fs.link('/tmp/hl2/a', '/tmp/hl2/b');
    await fs.link('/tmp/hl2/b', '/tmp/hl2/c');
    expect(((await fs.stat('/tmp/hl2/a')) as any).nlink).toBe(3);
    await fs.unlink('/tmp/hl2/b');
    expect(((await fs.stat('/tmp/hl2/c')) as any).nlink).toBe(2);
    await fs.unlink('/tmp/hl2/a');
    let recs = await stored(fs);
    checkStore(recs);
    expect(recs.get('/tmp/hl2/c').link).toBeUndefined();
    expect(recs.get('/tmp/hl2/c').content).toBeTruthy(); // a plain record
    expect([...recs.keys()].filter((k) => k.startsWith('\u0001i/') && recs.get(k).names.some((n: string) => n.startsWith('/tmp/hl2/')))).toEqual([]);
    expect(await text(await fresh(), '/tmp/hl2/c')).toBe('data');
    expect(((await fs.stat('/tmp/hl2/c')) as any).nlink).toBe(1);
    await fs.link('/tmp/hl2/c', '/tmp/hl2/d');
    await fs.unlink('/tmp/hl2/c');
    await fs.unlink('/tmp/hl2/d');
    recs = await stored(fs);
    checkStore(recs);
    expect([...recs.keys()].filter((k) => k.startsWith('/tmp/hl2/'))).toEqual([]);
  });

  it('rename of a name, onto a name, between two names of one file, and of a directory holding names', async () => {
    const fs = await fresh();
    await fs.mkdir('/tmp/hl3/d', { recursive: true });
    await fs.writeFile('/tmp/hl3/a', 'A');
    await fs.link('/tmp/hl3/a', '/tmp/hl3/d/b');
    await fs.rename('/tmp/hl3/a', '/tmp/hl3/a2'); // a linked name moves
    expect(((await fs.stat('/tmp/hl3/a2')) as any).nlink).toBe(2);
    await fs.rename('/tmp/hl3/a2', '/tmp/hl3/d/b'); // two names of one file: nothing happens
    expect(await fs.exists('/tmp/hl3/a2')).toBe(true);
    await fs.rename('/tmp/hl3/d', '/tmp/hl3/e'); // a directory holding a name
    expect(await text(fs, '/tmp/hl3/e/b')).toBe('A');
    await fs.writeFile('/tmp/hl3/e/b', 'B');
    expect(await text(fs, '/tmp/hl3/a2')).toBe('B');
    await fs.writeFile('/tmp/hl3/x', 'X');
    await fs.rename('/tmp/hl3/x', '/tmp/hl3/a2'); // onto a name: that name goes, the other stays
    expect(await text(fs, '/tmp/hl3/a2')).toBe('X');
    expect(await text(fs, '/tmp/hl3/e/b')).toBe('B');
    expect(((await fs.stat('/tmp/hl3/e/b')) as any).nlink).toBe(1);
    const recs = await stored(fs);
    checkStore(recs);
    const other = await fresh();
    expect([await text(other, '/tmp/hl3/a2'), await text(other, '/tmp/hl3/e/b')]).toEqual(['X', 'B']);
  });

  it('rm -r of a directory holding some or all names of files', async () => {
    const fs = await fresh();
    await fs.mkdir('/tmp/hl4/in/deep', { recursive: true });
    await fs.writeFile('/tmp/hl4/out', 'kept');
    await fs.link('/tmp/hl4/out', '/tmp/hl4/in/deep/n1');
    await fs.writeFile('/tmp/hl4/in/both', 'gone');
    await fs.link('/tmp/hl4/in/both', '/tmp/hl4/in/deep/both2');
    await fs.writeFile('/tmp/hl4/in/big', pattern(20000, 3));
    await fs.link('/tmp/hl4/in/big', '/tmp/hl4/bigout');
    await fs.sync();
    await fs.rm('/tmp/hl4/in', { recursive: true });
    expect(await text(fs, '/tmp/hl4/out')).toBe('kept');
    expect(((await fs.stat('/tmp/hl4/out')) as any).nlink).toBe(1);
    expect(await fs.readFile('/tmp/hl4/bigout')).toEqual(pattern(20000, 3));
    const recs = await stored(fs);
    checkStore(recs);
    expect([...recs.keys()].filter((k) => k.startsWith('/tmp/hl4/')).sort()).toEqual(['/tmp/hl4/bigout', '/tmp/hl4/out']);
    expect([...recs.values()].filter((n) => n.path.startsWith('\u0001i/') && n.names.some((x: string) => x.startsWith('/tmp/hl4/')))).toEqual([]);
    expect(await (await fresh()).readFile('/tmp/hl4/bigout')).toEqual(pattern(20000, 3));
  });

  it('a big (block-stored) file keeps its blocks while any name has it, written through the kernel by either name', async () => {
    const fs = await fresh();
    await fs.mkdir('/tmp/hl5', { recursive: true });
    await fs.writeFile('/tmp/hl5/a', pattern(30000, 1));
    await fs.link('/tmp/hl5/a', '/tmp/hl5/b');
    const f = new RegularFile(await openInode(fs, '/tmp/hl5/b'), A.O_RDWR);
    await f.pwrite(new Uint8Array(500).fill(9), 25000);
    await f.close();
    const want = pattern(30000, 1); want.fill(9, 25000, 25500);
    expect(await fs.readFile('/tmp/hl5/a')).toEqual(want);
    let recs = await stored(fs);
    checkStore(recs);
    const id = recs.get(`\u0001i/${recs.get('/tmp/hl5/a').link}`).blob;
    expect(id).toBeTruthy();
    await fs.unlink('/tmp/hl5/a');
    recs = await stored(fs);
    checkStore(recs);
    expect(recs.get('/tmp/hl5/b').blob).toBe(id); // the last name has the blocks
    expect(await (await fresh()).readFile('/tmp/hl5/b')).toEqual(want);
    await fs.unlink('/tmp/hl5/b');
    recs = await stored(fs);
    checkStore(recs);
    expect([...recs.keys()].filter((k) => k.startsWith(`\u0001b/${id}/`))).toEqual([]);
  });

  it('a symlink gets a second name of itself; with follow, its target does; errors as Linux', async () => {
    const fs = await fresh();
    await fs.mkdir('/tmp/hl6/dir', { recursive: true });
    await fs.writeFile('/tmp/hl6/t', 'target');
    await fs.symlink('t', '/tmp/hl6/s');
    await fs.link('/tmp/hl6/s', '/tmp/hl6/s2');
    expect(await fs.readlink('/tmp/hl6/s2')).toBe('t');
    expect(((await fs.lstat('/tmp/hl6/s2')) as any).nlink).toBe(2);
    expect(await text(fs, '/tmp/hl6/s2')).toBe('target');
    await fs.link('/tmp/hl6/s', '/tmp/hl6/t2', { follow: true });
    expect(((await fs.stat('/tmp/hl6/t')) as any).nlink).toBe(2);
    await expect(fs.link('/tmp/hl6/t', '/tmp/hl6/s')).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(fs.link('/tmp/hl6/dir', '/tmp/hl6/d2')).rejects.toMatchObject({ code: 'EPERM' });
    await expect(fs.link('/tmp/hl6/none', '/tmp/hl6/n2')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.link('/tmp/hl6/t', '/tmp/hl6/nodir/x')).rejects.toMatchObject({ code: 'ENOENT' });
    checkStore(await stored(fs));
    expect(await (await fresh()).readlink('/tmp/hl6/s2')).toBe('t');
  });

  it('linkNow links from the cache at once; exportAll gives each name as a file', async () => {
    const fs = await fresh();
    await fs.mkdir('/tmp/hl7', { recursive: true });
    await fs.writeFile('/tmp/hl7/a', 'now');
    expect(fs.linkNow('/tmp/hl7/a', '/tmp/hl7/b')).toBe(true);
    expect(fs.linkNow('/tmp/hl7/a', '/tmp/hl7/b')).toBe(false); // exists: link() reports it
    expect(fs.nlinkOf('/tmp/hl7/a')).toBe(2);
    const nodes = await fs.exportAll();
    expect(nodes.some((n) => n.path.startsWith('\u0001'))).toBe(false);
    expect(new TextDecoder().decode(nodes.find((n) => n.path === '/tmp/hl7/b')!.content!)).toBe('now');
    expect(nodes.find((n) => n.path === '/tmp/hl7/b')!.link).toBeUndefined();
  });

  it('files an older build gave one inode number (copy-links) stay separate files when linked', async () => {
    const fs = await fresh();
    await fs.mkdir('/tmp/hl8', { recursive: true });
    await fs.writeFile('/tmp/hl8/x', 'X');
    await fs.writeFile('/tmp/hl8/y', 'Y');
    fs.setIno('/tmp/hl8/y', (await fs.stat('/tmp/hl8/x')).ino); // as shareInodeNumber did
    await fs.link('/tmp/hl8/x', '/tmp/hl8/x2');
    await fs.link('/tmp/hl8/y', '/tmp/hl8/y2');
    expect([await text(fs, '/tmp/hl8/x2'), await text(fs, '/tmp/hl8/y2')]).toEqual(['X', 'Y']);
    await fs.writeFile('/tmp/hl8/y2', 'Y!');
    expect(await text(fs, '/tmp/hl8/x')).toBe('X');
    checkStore(await stored(fs));
  });

  it('a corrupt link map doesn\'t stop the boot; names still resolve', async () => {
    const fs = await fresh();
    await fs.mkdir('/tmp/hl9', { recursive: true });
    await fs.writeFile('/tmp/hl9/a', 'ok');
    await fs.link('/tmp/hl9/a', '/tmp/hl9/b');
    await fs.sync();
    const db = (fs as any).db as IDBDatabase;
    await new Promise<void>((r) => { const tx = db.transaction('files', 'readwrite'); tx.objectStore('files').put({ path: '\u0001links', links: 'garbage', type: 'file' }); tx.oncomplete = () => r(); });
    const t0 = Date.now();
    const other = await fresh();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(await text(other, '/tmp/hl9/b')).toBe('ok');
    expect(((await other.stat('/tmp/hl9/a')) as any).nlink).toBe(2);
    // Rebuilt from the inode records in the background, and stored again
    await new Promise((r) => setTimeout(r, 50));
    const recs = await stored(other);
    expect(Array.isArray(recs.get('\u0001links').links)).toBe(true);
    checkStore(recs);
  });

  describe('through the kernel', () => {
    it('fds opened through two names share one file; fstat agrees; unlink of the name an fd was opened with keeps it the other\'s', async () => {
      const fs = await fresh();
      await fs.mkdir('/tmp/hlk1', { recursive: true });
      await fs.writeFile('/tmp/hlk1/a', 'start');
      await fs.link('/tmp/hlk1/a', '/tmp/hlk1/b');
      const fa = new RegularFile(await openInode(fs, '/tmp/hlk1/a'), A.O_RDWR);
      const fb = new RegularFile(await openInode(fs, '/tmp/hlk1/b'), A.O_RDWR);
      expect((fa as any).ino).toBe((fb as any).ino);
      await fa.pwrite(enc('S'), 0);
      const buf = new Uint8Array(5);
      await fb.pread(buf, 0);
      expect(new TextDecoder().decode(buf)).toBe('Start');
      const [sa, sb] = [await fa.stat(), await fb.stat()];
      expect([sa.nlink, sb.nlink, sa.ino]).toEqual([2, 2, sb.ino]);
      await fs.flushAll();
      const { unlinkInode } = await import('@shiro/kernel/fd');
      await unlinkInode(fs, '/tmp/hlk1/a');
      await fs.unlink('/tmp/hlk1/a');
      await fa.pwrite(enc('!'), 5); // still the file, now named b only
      await fa.close(); await fb.close();
      expect(await text(fs, '/tmp/hlk1/b')).toBe('Start!');
      expect(await fs.exists('/tmp/hlk1/a')).toBe(false);
      checkStore(await stored(fs));
    });

    it('link(2) and linkat(2): EEXIST, EPERM for a directory, st_nlink through stat', async () => {
      const { fs, shell } = await createTestShell();
      const kernel = new Kernel({ shell });
      try {
        const proc = kernel.spawn({ path: 'p', cwd: '/tmp', fds: {}, run: () => new Promise<number>(() => {}) });
        await fs.mkdir('/tmp/hlk2/d', { recursive: true });
        await fs.writeFile('/tmp/hlk2/a', 'x');
        const two = (a: string, b: string) => { const d = new Uint8Array(512); const e1 = enc(a), e2 = enc(b); d.set(e1); d.set(e2, e1.length); return { d, l1: e1.length, l2: e2.length }; };
        let t = two('/tmp/hlk2/a', '/tmp/hlk2/b');
        expect(await kernel.syscall(proc, A.SYS_link, [t.l1, t.l2], t.d)).toBe(0);
        expect(await kernel.syscall(proc, A.SYS_link, [t.l1, t.l2], t.d)).toBe(-A.EEXIST);
        t = two('/tmp/hlk2/d', '/tmp/hlk2/d2');
        expect(await kernel.syscall(proc, A.SYS_linkat, [A.AT_FDCWD, t.l1, A.AT_FDCWD, t.l2, 0], t.d)).toBe(-A.EPERM);
        expect(((await fs.stat('/tmp/hlk2/b')) as any).nlink).toBe(2);
        const d = new Uint8Array(256); const e = enc('/tmp/hlk2/a'); d.set(e);
        expect(await kernel.syscall(proc, A.SYS_stat, [e.length], d)).toBe(0);
        const dv = new DataView(d.buffer);
        expect(Number(dv.getBigUint64(16, true))).toBe(2); // st_nlink
        kernel.kill(proc.pid, A.SIGKILL);
      } finally { kernel.dispose(); }
    });

    it('a big file unlinked while open: its fd reads every byte (the blocks are held), and they go at the close', async () => {
      const fs = await fresh();
      await fs.mkdir('/tmp/hlk3', { recursive: true });
      const data = pattern(40000, 5);
      await fs.writeFile('/tmp/hlk3/big', data);
      await fs.sync();
      fs.sweepContent(Date.now() + FileSystem.CONTENT_IDLE_MS + 1); // nothing of it in memory
      const f = new RegularFile(await openInode(fs, '/tmp/hlk3/big'), A.O_RDONLY);
      const id = (f as any).ino.blob;
      expect(id).toBeTruthy();
      const { unlinkInode } = await import('@shiro/kernel/fd');
      await unlinkInode(fs, '/tmp/hlk3/big');
      await fs.unlink('/tmp/hlk3/big');
      await fs.sync();
      let recs = await stored(fs);
      expect([...recs.keys()].filter((k) => k.startsWith(`\u0001b/${id}/`)).length).toBe(40); // still there
      const back = new Uint8Array(data.length);
      expect(await f.pread(back, 0)).toBe(data.length);
      expect(back).toEqual(data);
      // A reload now (the page went away with the fd open) would drop them
      const reloaded = await fresh();
      recs = await stored(reloaded);
      expect([...recs.keys()].filter((k) => k.startsWith(`\u0001b/${id}/`))).toEqual([]);
      checkStore(recs);
    });

    it('a big file unlinked while open loses its blocks at the last close', async () => {
      const fs = await fresh();
      await fs.mkdir('/tmp/hlk4', { recursive: true });
      await fs.writeFile('/tmp/hlk4/big', pattern(20000, 6));
      const f = new RegularFile(await openInode(fs, '/tmp/hlk4/big'), A.O_RDWR);
      const id = (f as any).ino.blob;
      const { unlinkInode } = await import('@shiro/kernel/fd');
      await unlinkInode(fs, '/tmp/hlk4/big');
      await fs.unlink('/tmp/hlk4/big');
      for (let i = 0; i < 20; i++) await f.pwrite(new Uint8Array(1024).fill(i), i * 1024); // writes to an unlinked file don't hang
      await f.close();
      const recs = await stored(fs);
      checkStore(recs);
      expect([...recs.keys()].filter((k) => k.startsWith(`\u0001b/${id}/`))).toEqual([]);
      expect([...(recs.get('\u0001blobs')?.blobs ?? [])].filter(([p]: [string]) => p.includes(id))).toEqual([]);
    });
  });

  it('node: fs.linkSync and fs.promises.link make real links', async () => {
    const { fs, shell } = await createTestShell();
    await fs.mkdir('/tmp/hln', { recursive: true });
    await fs.writeFile('/tmp/hln/a', 'from node');
    const { output, exitCode } = await run(shell, `node -e "
      const fs = require('fs');
      fs.linkSync('/tmp/hln/a', '/tmp/hln/b');
      fs.promises.link('/tmp/hln/a', '/tmp/hln/c').then(() => {
        try { fs.linkSync('/tmp/hln/a', '/tmp/hln/b'); } catch (e) { console.log(e.code); }
        console.log(fs.readFileSync('/tmp/hln/b', 'utf8'));
      });
    "`);
    expect(exitCode).toBe(0);
    expect(output).toContain('EEXIST');
    expect(output).toContain('from node');
    await fs.sync();
    expect(((await fs.stat('/tmp/hln/c')) as any).nlink).toBe(3);
    await fs.writeFile('/tmp/hln/c', 'changed');
    expect(await fs.readFile('/tmp/hln/a', 'utf8')).toBe('changed');
  });
});
