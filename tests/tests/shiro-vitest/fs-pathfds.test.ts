import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileSystem } from '@shiro/filesystem';
import { Kernel } from '@shiro/kernel/kernel';
import type { Process } from '@shiro/kernel/process';
import * as A from '@shiro/kernel/abi';
import { createTestShell } from './helpers';
import { stored, checkStore } from './fs-store-check';

// O_PATH|O_NOFOLLOW fds of symlinks, O_TMPFILE + linkat(AT_EMPTY_PATH), and
// renameat2(RENAME_EXCHANGE / RENAME_NOREPLACE), through the kernel. The
// store is checked after each test (stubs, inode records, blocks; no
// half-made exchange left behind).
describe('path fds, O_TMPFILE, RENAME_EXCHANGE', { timeout: 60_000 }, () => {
  const saved = { min: FileSystem.BLOB_MIN, block: FileSystem.BLOCK };
  beforeEach(() => { FileSystem.BLOB_MIN = 8 << 10; FileSystem.BLOCK = 1 << 10; });
  afterEach(() => { FileSystem.BLOB_MIN = saved.min; FileSystem.BLOCK = saved.block; });

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const pattern = (n: number, seed = 1) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + seed * 7 + (i >> 10)) & 255; return b; };

  async function setup() {
    const { fs, shell } = await createTestShell();
    const kernel = new Kernel({ shell });
    const proc: Process = kernel.spawn({ path: 'p', cwd: '/tmp', fds: {}, run: () => new Promise<number>(() => {}) });
    /** A syscall whose path arguments are laid out one after another in its data */
    const call = (nr: number, args: number[], ...paths: string[]) => {
      const data = new Uint8Array(4096);
      let off = 0;
      for (const p of paths) { const b = enc.encode(p); data.set(b, off); off += b.length; }
      return kernel.syscall(proc, nr, args, data);
    };
    const L = (s: string) => enc.encode(s).length;
    const open = (p: string, flags: number, mode = 0o644) => call(A.SYS_openat, [A.AT_FDCWD, L(p), flags, mode], p);
    const fstat = async (fd: number) => {
      const d = new Uint8Array(256);
      expect(await kernel.syscall(proc, A.SYS_newfstatat, [fd, 0, A.AT_EMPTY_PATH], d)).toBe(0);
      const dv = new DataView(d.buffer);
      return { ino: Number(dv.getBigUint64(8, true)), nlink: Number(dv.getBigUint64(16, true)), mode: dv.getUint32(24, true), size: Number(dv.getBigInt64(48, true)) };
    };
    const write = async (fd: number, bytes: Uint8Array) => {
      for (let off = 0; off < bytes.length;) {
        const chunk = bytes.subarray(off, off + 4096);
        const n = await kernel.syscall(proc, A.SYS_write, [fd, chunk.length], chunk.slice());
        expect(n).toBeGreaterThan(0);
        off += n;
      }
    };
    const close = (fd: number) => kernel.syscall(proc, A.SYS_close, [fd], new Uint8Array(0));
    const linkFd = (fd: number, to: string) => call(A.SYS_linkat, [fd, 0, A.AT_FDCWD, L(to), A.AT_EMPTY_PATH], to);
    const rename2 = (a: string, b: string, flags: number) => call(A.SYS_renameat2, [A.AT_FDCWD, L(a), A.AT_FDCWD, L(b), flags], a, b);
    const done = async () => {
      const recs = await stored(fs);
      checkStore(recs);
      expect([...recs.keys()].filter((k) => k.includes('\u0001exchange-') || k.includes('#tmpfile-'))).toEqual([]);
      kernel.kill(proc.pid, A.SIGKILL);
      kernel.dispose();
    };
    return { fs, kernel, proc, call, L, open, fstat, write, close, linkFd, rename2, done };
  }

  describe('O_PATH|O_NOFOLLOW of a symlink', () => {
    it('names the link: fstat says S_IFLNK, readlinkat(fd, "") reads it, I/O is EBADF, linkat names it again', async () => {
      const k = await setup();
      await k.fs.mkdir('/tmp/op1', { recursive: true });
      await k.fs.writeFile('/tmp/op1/target', 'data');
      await k.fs.symlink('target', '/tmp/op1/ln');
      const fd = await k.open('/tmp/op1/ln', A.O_PATH | A.O_NOFOLLOW);
      expect(fd).toBeGreaterThanOrEqual(0);
      const st = await k.fstat(fd);
      expect(st.mode & A.S_IFMT).toBe(A.S_IFLNK);
      expect(st.size).toBe('target'.length);
      const buf = new Uint8Array(64);
      const n = await k.kernel.syscall(k.proc, A.SYS_readlinkat, [fd, 0, 64], buf);
      expect(dec.decode(buf.subarray(0, n as number))).toBe('target');
      expect(await k.kernel.syscall(k.proc, A.SYS_read, [fd, 4], new Uint8Array(4))).toBe(-A.EBADF);
      expect(await k.kernel.syscall(k.proc, A.SYS_write, [fd, 1], new Uint8Array(1))).toBe(-A.EBADF);
      expect(await k.open('/tmp/op1/ln', A.O_PATH | A.O_NOFOLLOW | A.O_DIRECTORY)).toBe(-A.ENOTDIR);
      // Without O_NOFOLLOW the target is opened
      const tfd = await k.open('/tmp/op1/ln', A.O_PATH);
      expect((await k.fstat(tfd)).mode & A.S_IFMT).toBe(A.S_IFREG);
      expect(await k.kernel.syscall(k.proc, A.SYS_readlinkat, [tfd, 0, 64], new Uint8Array(64))).toBe(-A.ENOENT);
      // linkat(fd, "", AT_EMPTY_PATH): a second name of the symlink itself
      expect(await k.linkFd(fd, '/tmp/op1/ln2')).toBe(0);
      expect(await k.fs.readlink('/tmp/op1/ln2')).toBe('target');
      expect((await k.fs.lstat('/tmp/op1/ln2')).isSymbolicLink()).toBe(true);
      expect(await k.close(fd)).toBe(0);
      expect(await k.close(tfd)).toBe(0);
      await k.done();
    });
  });

  describe('O_TMPFILE', () => {
    it('an unnamed file: nlink 0, not in its directory, named by linkat(fd, "", AT_EMPTY_PATH); writes after reach the name', async () => {
      const k = await setup();
      await k.fs.mkdir('/tmp/tf1', { recursive: true });
      const fd = await k.open('/tmp/tf1', A.O_TMPFILE | A.O_RDWR, 0o640);
      expect(fd).toBeGreaterThanOrEqual(0);
      await k.write(fd, enc.encode('hello'));
      let st = await k.fstat(fd);
      expect([st.nlink, st.mode & A.S_IFMT, st.mode & 0o777, st.size]).toEqual([0, A.S_IFREG, 0o640 & ~k.proc.umask, 5]);
      expect(await k.fs.readdir('/tmp/tf1')).toEqual([]);
      expect(await k.linkFd(fd, '/tmp/tf1/named')).toBe(0);
      expect(await k.linkFd(fd, '/tmp/tf1/named')).toBe(-A.EEXIST);
      st = await k.fstat(fd);
      expect(st.nlink).toBe(1);
      expect(await k.fs.readFile('/tmp/tf1/named', 'utf8')).toBe('hello');
      expect((await k.fs.stat('/tmp/tf1/named')).mode & 0o777).toBe(0o640 & ~k.proc.umask);
      await k.write(fd, enc.encode(' world'));
      expect(await k.close(fd)).toBe(0);
      expect(await k.fs.readFile('/tmp/tf1/named', 'utf8')).toBe('hello world');
      expect(await k.fs.readdir('/tmp/tf1')).toEqual(['named']);
      await k.done();
    });

    it('through /proc/self/fd/N with AT_SYMLINK_FOLLOW; O_EXCL makes it unlinkable; closed unnamed it leaves nothing', async () => {
      const k = await setup();
      await k.fs.mkdir('/tmp/tf2', { recursive: true });
      const fd = await k.open('/tmp/tf2', A.O_TMPFILE | A.O_WRONLY, 0o600);
      await k.write(fd, enc.encode('via proc'));
      const from = `/proc/self/fd/${fd}`, to = '/tmp/tf2/p';
      expect(await k.call(A.SYS_linkat, [A.AT_FDCWD, k.L(from), A.AT_FDCWD, k.L(to), A.AT_SYMLINK_FOLLOW], from, to)).toBe(0);
      expect(await k.fs.readFile(to, 'utf8')).toBe('via proc');
      await k.close(fd);

      const ex = await k.open('/tmp/tf2', A.O_TMPFILE | A.O_RDWR | A.O_EXCL, 0o600);
      expect(ex).toBeGreaterThanOrEqual(0);
      expect(await k.linkFd(ex, '/tmp/tf2/never')).toBe(-A.ENOENT);
      await k.close(ex);

      const gone = await k.open('/tmp/tf2', A.O_TMPFILE | A.O_RDWR, 0o600);
      await k.write(gone, pattern(30000, 2)); // big: blocks, which go at the close
      await k.close(gone);
      expect(await k.fs.readdir('/tmp/tf2')).toEqual(['p']);
      // Errors: read-only, a file, a missing directory
      expect(await k.open('/tmp/tf2', A.O_TMPFILE | A.O_RDONLY)).toBe(-A.EINVAL);
      expect(await k.open('/tmp/tf2/p', A.O_TMPFILE | A.O_RDWR)).toBe(-A.ENOTDIR);
      expect(await k.open('/tmp/tf2/none', A.O_TMPFILE | A.O_RDWR)).toBe(-A.ENOENT);
      const recs = await stored(k.fs);
      expect([...recs.keys()].filter((key) => key.startsWith('\u0001b/'))).toEqual([]);
      await k.done();
    });

    it('a big one, linked and reloaded, keeps every byte (block-stored)', async () => {
      const k = await setup();
      await k.fs.mkdir('/tmp/tf3', { recursive: true });
      const data = pattern(50000, 3);
      const fd = await k.open('/tmp/tf3', A.O_TMPFILE | A.O_RDWR, 0o644);
      await k.write(fd, data);
      expect(await k.linkFd(fd, '/tmp/tf3/big')).toBe(0);
      await k.close(fd);
      const recs = await stored(k.fs);
      expect(recs.get('/tmp/tf3/big')?.blob).toBeTruthy();
      const other = new FileSystem();
      await other.init();
      expect(new Uint8Array(await other.readFile('/tmp/tf3/big') as Uint8Array)).toEqual(data);
      await k.done();
    });
  });

  describe('renameat2', () => {
    it('RENAME_EXCHANGE swaps two files; flags as Linux checks them; RENAME_NOREPLACE', async () => {
      const k = await setup();
      await k.fs.mkdir('/tmp/rx1', { recursive: true });
      await k.fs.writeFile('/tmp/rx1/a', 'A');
      await k.fs.writeFile('/tmp/rx1/b', 'BB');
      const [ia, ib] = [(await k.fs.stat('/tmp/rx1/a')).ino, (await k.fs.stat('/tmp/rx1/b')).ino];
      expect(await k.rename2('/tmp/rx1/a', '/tmp/rx1/b', A.RENAME_EXCHANGE)).toBe(0);
      expect(await k.fs.readFile('/tmp/rx1/a', 'utf8')).toBe('BB');
      expect(await k.fs.readFile('/tmp/rx1/b', 'utf8')).toBe('A');
      expect([(await k.fs.stat('/tmp/rx1/a')).ino, (await k.fs.stat('/tmp/rx1/b')).ino]).toEqual([ib, ia]);
      expect(await k.rename2('/tmp/rx1/a', '/tmp/rx1/b', A.RENAME_EXCHANGE | A.RENAME_NOREPLACE)).toBe(-A.EINVAL);
      expect(await k.rename2('/tmp/rx1/a', '/tmp/rx1/b', A.RENAME_WHITEOUT)).toBe(-A.EINVAL);
      expect(await k.rename2('/tmp/rx1/a', '/tmp/rx1/none', A.RENAME_EXCHANGE)).toBe(-A.ENOENT);
      expect(await k.rename2('/tmp/rx1/none', '/tmp/rx1/a', A.RENAME_EXCHANGE)).toBe(-A.ENOENT);
      expect(await k.rename2('/tmp/rx1/a', '/tmp/rx1/a', A.RENAME_EXCHANGE)).toBe(0);
      expect(await k.rename2('/tmp/rx1/a', '/tmp/rx1/b', A.RENAME_NOREPLACE)).toBe(-A.EEXIST);
      expect(await k.rename2('/tmp/rx1/a', '/tmp/rx1/c', A.RENAME_NOREPLACE)).toBe(0);
      expect((await k.fs.readdir('/tmp/rx1')).sort()).toEqual(['b', 'c']);
      // Across a reload
      const other = new FileSystem();
      await other.init();
      expect([await other.readFile('/tmp/rx1/b', 'utf8'), await other.readFile('/tmp/rx1/c', 'utf8')]).toEqual(['A', 'BB']);
      await k.done();
    });

    it('a file and a directory with children swap; a directory and its descendant can\'t', async () => {
      const k = await setup();
      await k.fs.mkdir('/tmp/rx2/d/sub', { recursive: true });
      await k.fs.writeFile('/tmp/rx2/d/sub/x', 'deep');
      await k.fs.writeFile('/tmp/rx2/d/y', 'y');
      await k.fs.writeFile('/tmp/rx2/f', 'file');
      await k.fs.mkdir('/tmp/rx2/e/inner', { recursive: true });
      await k.fs.writeFile('/tmp/rx2/e/z', 'z');
      expect(await k.rename2('/tmp/rx2/d', '/tmp/rx2/f', A.RENAME_EXCHANGE)).toBe(0);
      expect(await k.fs.readFile('/tmp/rx2/d', 'utf8')).toBe('file');
      expect(await k.fs.readFile('/tmp/rx2/f/sub/x', 'utf8')).toBe('deep');
      expect((await k.fs.readdir('/tmp/rx2/f')).sort()).toEqual(['sub', 'y']);
      // Two directories, each with children
      expect(await k.rename2('/tmp/rx2/f', '/tmp/rx2/e', A.RENAME_EXCHANGE)).toBe(0);
      expect((await k.fs.readdir('/tmp/rx2/f')).sort()).toEqual(['inner', 'z']);
      expect(await k.fs.readFile('/tmp/rx2/e/sub/x', 'utf8')).toBe('deep');
      expect(await k.rename2('/tmp/rx2/e', '/tmp/rx2/e/sub', A.RENAME_EXCHANGE)).toBe(-A.EINVAL);
      expect(await k.rename2('/tmp/rx2/e/sub', '/tmp/rx2/e', A.RENAME_EXCHANGE)).toBe(-A.EINVAL);
      expect(await k.rename2('/tmp/rx2/d/', '/tmp/rx2/e', A.RENAME_EXCHANGE)).toBe(-A.ENOTDIR);
      expect((await k.fs.readdir('/tmp/rx2')).sort()).toEqual(['d', 'e', 'f']);
      const other = new FileSystem();
      await other.init();
      expect(await other.readFile('/tmp/rx2/e/sub/x', 'utf8')).toBe('deep');
      expect(await other.readFile('/tmp/rx2/f/z', 'utf8')).toBe('z');
      expect(await other.readFile('/tmp/rx2/d', 'utf8')).toBe('file');
      await k.done();
    });

    it('hard-linked and block-stored files swap; their other names and blocks follow; open fds follow their file', async () => {
      const k = await setup();
      await k.fs.mkdir('/tmp/rx3/dir', { recursive: true });
      await k.fs.writeFile('/tmp/rx3/a', 'linked');
      await k.fs.link('/tmp/rx3/a', '/tmp/rx3/a2');
      const big = pattern(40000, 9);
      await k.fs.writeFile('/tmp/rx3/dir/big', big);
      await k.fs.link('/tmp/rx3/dir/big', '/tmp/rx3/big2');
      await k.fs.writeFile('/tmp/rx3/dir/plain', 'plain');
      // An fd open on a, written after the exchange: lands in the file now named b... here 'dir/plain' <-> 'a'
      const fd = await k.open('/tmp/rx3/a', A.O_RDWR);
      await k.write(fd, enc.encode('LINK'));
      expect(await k.rename2('/tmp/rx3/a', '/tmp/rx3/dir/plain', A.RENAME_EXCHANGE)).toBe(0);
      await k.write(fd, enc.encode('ED!'));
      expect(await k.close(fd)).toBe(0);
      expect(await k.fs.readFile('/tmp/rx3/a', 'utf8')).toBe('plain');
      expect(await k.fs.readFile('/tmp/rx3/dir/plain', 'utf8')).toBe('LINKED!');
      expect(await k.fs.readFile('/tmp/rx3/a2', 'utf8')).toBe('LINKED!');
      expect(((await k.fs.stat('/tmp/rx3/dir/plain')) as any).nlink).toBe(2);
      expect(((await k.fs.stat('/tmp/rx3/a')) as any).nlink).toBe(1);
      // A directory holding a linked block-stored file swaps with a file
      await k.fs.writeFile('/tmp/rx3/f', 'f');
      expect(await k.rename2('/tmp/rx3/dir', '/tmp/rx3/f', A.RENAME_EXCHANGE)).toBe(0);
      expect(new Uint8Array(await k.fs.readFile('/tmp/rx3/f/big') as Uint8Array)).toEqual(big);
      await k.fs.writeFile('/tmp/rx3/big2', 'now small'); // the other name still is the same file
      expect(await k.fs.readFile('/tmp/rx3/f/big', 'utf8')).toBe('now small');
      const recs = await stored(k.fs);
      expect(recs.get('/tmp/rx3/f/plain')?.link).toBeDefined();
      const other = new FileSystem();
      await other.init();
      expect(await other.readFile('/tmp/rx3/f/plain', 'utf8')).toBe('LINKED!');
      expect(await other.readFile('/tmp/rx3/a2', 'utf8')).toBe('LINKED!');
      expect(await other.readFile('/tmp/rx3/dir', 'utf8')).toBe('f');
      await k.done();
    });

    it('two block-stored files swap with their blocks', async () => {
      const k = await setup();
      await k.fs.mkdir('/tmp/rx4', { recursive: true });
      const [x, y] = [pattern(30000, 1), pattern(45000, 2)];
      await k.fs.writeFile('/tmp/rx4/x', x);
      await k.fs.writeFile('/tmp/rx4/y', y);
      expect(await k.rename2('/tmp/rx4/x', '/tmp/rx4/y', A.RENAME_EXCHANGE)).toBe(0);
      expect(new Uint8Array(await k.fs.readFile('/tmp/rx4/x') as Uint8Array)).toEqual(y);
      expect(new Uint8Array(await k.fs.readFile('/tmp/rx4/y') as Uint8Array)).toEqual(x);
      const other = new FileSystem();
      await other.init();
      other.sweepContent(Date.now() + FileSystem.CONTENT_IDLE_MS + 1);
      expect(new Uint8Array(await other.readFile('/tmp/rx4/x') as Uint8Array)).toEqual(y);
      expect(new Uint8Array(await other.readFile('/tmp/rx4/y') as Uint8Array)).toEqual(x);
      await k.done();
    });
  });
});
