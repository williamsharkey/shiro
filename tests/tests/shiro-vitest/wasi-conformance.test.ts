/**
 * Regressions from the WebAssembly/wasi-testsuite conformance run
 * (tests/conformance/syscalls-wasi.conf.ts): the WASI preview1 behaviours it
 * checks, through a freestanding test program (fixtures/wasi/wasiconf.c, run
 * as a kernel process in a Worker), and the Linux semantics underneath them
 * in the kernel's path syscalls (shared with x86-64 guests).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Worker } from 'node:worker_threads';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { createTestShell } from './helpers';
import type { FileSystem } from '@shiro/filesystem';
import { Kernel } from '@shiro/kernel/kernel';
import { BufferFile } from '@shiro/kernel/fd';
import type { Process } from '@shiro/kernel/process';
import * as A from '@shiro/kernel/abi';
import { setGuestWorkerFactory, forceWasmProcessMode, wasmRunner } from '@shiro/wasi/host';
import { SinkFile } from '@shiro/wasi/stdio';

const here = __dirname;
const srcWasi = path.resolve(here, '../../../src/wasi');
const image = new Uint8Array(readFileSync(path.join(here, 'fixtures', 'wasi', 'wasiconf.wasm')));
let tmp: string;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'shiro-wasiconf-'));
  writeFileSync(path.join(tmp, 'entry.ts'), `
    import { parentPort } from 'node:worker_threads';
    import { guestMain } from ${JSON.stringify(path.join(srcWasi, 'guest-worker.ts'))};
    const port: any = { postMessage: (m: unknown) => parentPort!.postMessage(m), onmessage: null };
    parentPort!.on('message', (data) => port.onmessage && port.onmessage({ data }));
    guestMain(port);
  `);
  await build({ entryPoints: [path.join(tmp, 'entry.ts')], bundle: true, platform: 'node', format: 'esm', outfile: path.join(tmp, 'guest.mjs'), logLevel: 'error' });
  setGuestWorkerFactory(() => {
    const w = new Worker(path.join(tmp, 'guest.mjs'));
    return {
      postMessage: (m) => w.postMessage(m),
      terminate: () => w.terminate(),
      onMessage: (cb) => { w.on('message', cb); },
      onError: (cb) => { w.on('error', cb); },
    };
  });
  forceWasmProcessMode('sab');
}, 120_000);

afterAll(() => {
  setGuestWorkerFactory(null);
  forceWasmProcessMode(null);
  rmSync(tmp, { recursive: true, force: true });
});

async function runConf(kernel: Kernel, opts: { cwd: string; env: Record<string, string>; mounts?: Record<string, string>; bare?: boolean }) {
  let out = '', err = '';
  const module = await WebAssembly.compile(image);
  const proc = kernel.spawn({
    path: 'wasiconf', argv: ['wasiconf'], env: opts.env, cwd: opts.cwd,
    fds: { 0: new BufferFile('', A.O_RDONLY), 1: new SinkFile((t) => { out += t; }), 2: new SinkFile((t) => { err += t; }) },
    run: wasmRunner(module, image, [], opts.mounts, undefined, opts.bare),
  });
  const status = await proc.wait();
  return { status, out, err, results: Object.fromEntries(out.trim().split('\n').map(l => l.split(' ')).map(([k, v]) => [k, Number(v)])) };
}

// WASI errnos
const E = { BADF: 8, EXIST: 20, INVAL: 28, ISDIR: 31, LOOP: 32, NAMETOOLONG: 37, NOENT: 44, NOTDIR: 54, NOTEMPTY: 55, NOTSOCK: 57, NOTSUP: 58, NOTCAPABLE: 76 };

/** What every run reports, whatever "/" is. */
const COMMON = {
  prestat_short: E.NAMETOOLONG,
  open_dir: 0, dir_seek_right: 0, dir_set_size_right: 0, dir_readdir_right: 1,
  set_rights: E.NOTSUP, seek_dir: E.ISDIR,
  create: 0, create_excl: E.EXIST, allocate: 0, size: 100,
  set_mtim: 0, mtim_exact: 1, mtim_and_now: E.INVAL,
  dir_rw: E.ISDIR, file_slash: E.NOTDIR, ro_write_right: 0,
  symlink: 0, open_nofollow: E.LOOP, open_follow: 0,
  rename_nonempty: E.NOTEMPTY, rename_file_on_dir: E.ISDIR, unlink_dir: E.ISDIR, unlink_file_slash: E.NOTDIR, rmdir_file: E.NOTDIR,
  renumber_closed: E.BADF, write_badfd_empty: E.BADF, shutdown_stdout: E.NOTSOCK,
};

describe('WASI preview1 as the wasi-testsuite (Wasmtime) expects', () => {
  it('a directory mounted as "/" is a capability sandbox: no absolute paths, no ".." out of a dirfd, no absolute symlinks', async () => {
    const { fs, shell } = await createTestShell();
    await fs.mkdir('/tmp/conf-root', { recursive: true });
    const kernel = new Kernel({ fs, shell, registerWithProcessTable: false });
    // Only the mount is preopened, and the env is exactly what was given (no $PWD: the cwd is its "/")
    const r = await runConf(kernel, { cwd: '/tmp/conf-root', env: {}, mounts: { '/': '/tmp/conf-root' }, bare: true });
    expect(r.err).toBe('');
    expect(r.results).toEqual({
      ...COMMON, environ: 0, symlink_abs: E.NOTCAPABLE, open_abs: E.NOTCAPABLE, open_dotdot: E.NOTCAPABLE,
    });
    expect(A.WEXITSTATUS(r.status)).toBe(0);
    expect(await fs.exists('/tmp/conf-root/t/f')).toBe(true);
  }, 60_000);

  it('with Shiro\'s root as "/", paths through a dirfd keep POSIX meaning (absolute, "..", absolute symlinks)', async () => {
    const { fs, shell } = await createTestShell();
    const kernel = new Kernel({ fs, shell, registerWithProcessTable: false });
    const r = await runConf(kernel, { cwd: '/home/user', env: { HOME: '/home/user' } });
    expect(r.err).toBe('');
    expect(r.results).toEqual({ ...COMMON, environ: 2 /* HOME, PWD */, symlink_abs: 0, open_abs: 0, open_dotdot: 0 });
  }, 60_000);
});

describe('kernel path syscalls (Linux semantics)', () => {
  let fs: FileSystem;
  let kernel: Kernel;
  let proc: Process;
  const enc = new TextEncoder();
  /** A syscall whose paths go at the start of the data area, back to back. */
  const call = (nr: number, args: number[], ...paths: string[]) => {
    const data = new Uint8Array(4096);
    let off = 0;
    for (const p of paths) { const b = enc.encode(p); data.set(b, off); off += b.length; }
    return kernel.syscall(proc, nr, args, data);
  };
  const L = (s: string) => enc.encode(s).length;
  const open = (p: string, flags: number) => call(A.SYS_openat, [A.AT_FDCWD, L(p), flags, 0o644], p);

  beforeAll(async () => {
    ({ fs } = await createTestShell());
    kernel = new Kernel({ fs, registerWithProcessTable: false });
    await fs.mkdir('/tmp/kp/dir/sub', { recursive: true });
    await fs.mkdir('/tmp/kp/empty', { recursive: true });
    await fs.writeFile('/tmp/kp/file', 'data');
    await fs.symlink('file', '/tmp/kp/link');
    await fs.symlink('loop', '/tmp/kp/loop');
    await fs.symlink('missing', '/tmp/kp/dangling');
    proc = kernel.spawn({ path: 'holder', cwd: '/tmp/kp', fds: {}, run: () => new Promise<number>(() => {}) });
  });
  afterAll(() => { kernel.kill(proc.pid, A.SIGKILL); });

  it('open: O_NOFOLLOW, symlink loops, trailing slashes, O_CREAT through a dangling symlink', async () => {
    expect(await open('link', A.O_RDONLY | A.O_NOFOLLOW)).toBe(-A.ELOOP);
    expect(await open('loop', A.O_RDONLY)).toBe(-A.ELOOP);
    expect(await open('file/', A.O_RDONLY)).toBe(-A.ENOTDIR);
    expect(await open('new/', A.O_CREAT | A.O_WRONLY)).toBe(-A.EISDIR);
    expect(await open('dir/', A.O_RDONLY)).toBeGreaterThanOrEqual(0);
    expect(await open('dir', A.O_RDWR | A.O_DIRECTORY)).toBe(-A.EISDIR);
    expect(await open('dangling', A.O_CREAT | A.O_EXCL | A.O_WRONLY)).toBe(-A.EEXIST);
    expect(await open('dangling', A.O_CREAT | A.O_WRONLY)).toBeGreaterThanOrEqual(0);
    expect((await fs.lstat('/tmp/kp/dangling')).isSymbolicLink()).toBe(true);
    expect(await fs.exists('/tmp/kp/missing')).toBe(true);
    // stat("file/") and pread on a directory
    expect(await call(A.SYS_newfstatat, [A.AT_FDCWD, L('file/'), 0], 'file/')).toBe(-A.ENOTDIR);
    const dfd = await open('dir', A.O_RDONLY | A.O_DIRECTORY);
    expect(await call(A.SYS_pread64, [dfd, 16, 0, 0])).toBe(-A.EISDIR);
  });

  it('unlink, rmdir, symlink, link and rename refuse what Linux refuses', async () => {
    expect(await call(A.SYS_unlinkat, [A.AT_FDCWD, L('dir/'), 0], 'dir/')).toBe(-A.EISDIR);
    expect(await call(A.SYS_unlinkat, [A.AT_FDCWD, L('file/'), 0], 'file/')).toBe(-A.ENOTDIR);
    expect(await call(A.SYS_unlinkat, [A.AT_FDCWD, L('dir'), A.AT_REMOVEDIR], 'dir')).toBe(-A.ENOTEMPTY);
    expect(await call(A.SYS_symlinkat, [L('x'), A.AT_FDCWD, L('nodir/')], 'x', 'nodir/')).toBe(-A.ENOENT);
    expect(await call(A.SYS_symlinkat, [L('x'), A.AT_FDCWD, L('dangling')], 'x', 'dangling')).toBe(-A.EEXIST);
    expect(await call(A.SYS_linkat, [A.AT_FDCWD, L('file'), A.AT_FDCWD, L('hl/'), 0], 'file', 'hl/')).toBe(-A.ENOENT);
    expect(await call(A.SYS_linkat, [A.AT_FDCWD, L('dir'), A.AT_FDCWD, L('hl'), 0], 'dir', 'hl')).toBe(-A.EPERM);
    // No hard links: a valid link is EPERM (programs fall back to copying)
    expect(await call(A.SYS_linkat, [A.AT_FDCWD, L('file'), A.AT_FDCWD, L('hl'), 0], 'file', 'hl')).toBe(-A.EPERM);
    expect(await call(A.SYS_linkat, [A.AT_FDCWD, L('file'), A.AT_FDCWD, L('hl'), 0x10000], 'file', 'hl')).toBe(-A.EINVAL);
    // rename: a directory replaces only an empty directory, never a file, and vice versa
    expect(await call(A.SYS_renameat, [A.AT_FDCWD, L('empty'), A.AT_FDCWD, L('dir')], 'empty', 'dir')).toBe(-A.ENOTEMPTY);
    expect(await call(A.SYS_renameat, [A.AT_FDCWD, L('dir'), A.AT_FDCWD, L('file')], 'dir', 'file')).toBe(-A.ENOTDIR);
    expect(await call(A.SYS_renameat, [A.AT_FDCWD, L('file'), A.AT_FDCWD, L('empty')], 'file', 'empty')).toBe(-A.EISDIR);
    expect(await call(A.SYS_renameat, [A.AT_FDCWD, L('file/'), A.AT_FDCWD, L('f2')], 'file/', 'f2')).toBe(-A.ENOTDIR);
    expect(await call(A.SYS_renameat, [A.AT_FDCWD, L('dir'), A.AT_FDCWD, L('dir/sub/x')], 'dir', 'dir/sub/x')).toBe(-A.EINVAL);
    expect(await call(A.SYS_renameat, [A.AT_FDCWD, L('dir/sub'), A.AT_FDCWD, L('empty')], 'dir/sub', 'empty')).toBe(0);
    expect((await fs.readdir('/tmp/kp/dir'))).toEqual([]);
    expect((await fs.stat('/tmp/kp/empty')).isDirectory()).toBe(true);
  });

  it('utimensat keeps nanoseconds and atime apart, and changes a symlink itself with AT_SYMLINK_NOFOLLOW', async () => {
    const times = (p: string, flags: number, a: [number, number], m: [number, number]) => {
      const data = new Uint8Array(4096);
      const b = enc.encode(p);
      data.set(b);
      const dv = new DataView(data.buffer, b.length, 32);
      dv.setUint32(0, a[0], true); dv.setUint32(8, a[1], true);
      dv.setUint32(16, m[0], true); dv.setUint32(24, m[1], true);
      return kernel.syscall(proc, A.SYS_utimensat, [A.AT_FDCWD, b.length, flags, 1], data);
    };
    const stat = async (p: string, flags: number) => {
      const data = new Uint8Array(4096);
      data.set(enc.encode(p));
      expect(await kernel.syscall(proc, A.SYS_newfstatat, [A.AT_FDCWD, L(p), flags], data)).toBe(0);
      const dv = new DataView(data.buffer);
      return { atime: [dv.getUint32(72, true), dv.getUint32(80, true)], mtime: [dv.getUint32(88, true), dv.getUint32(96, true)] };
    };
    await fs.writeFile('/tmp/kp/t', 'x');
    await fs.symlink('t', '/tmp/kp/tl');
    expect(await times('t', 0, [1000, 123456789], [2000, 999999999])).toBe(0);
    expect(await stat('t', 0)).toEqual({ atime: [1000, 123456789], mtime: [2000, 999999999] });
    expect(await times('tl', A.AT_SYMLINK_NOFOLLOW, [A.UTIME_OMIT, A.UTIME_OMIT], [3000, 5])).toBe(0);
    expect((await stat('tl', A.AT_SYMLINK_NOFOLLOW)).mtime).toEqual([3000, 5]);
    expect((await stat('t', 0)).mtime).toEqual([2000, 999999999]);
    expect(await times('t', 0, [0, 1_000_000_000], [0, 0])).toBe(-A.EINVAL);
    // An open file with unwritten data reports (and later stores) the times set while it was open
    const fd = await open('t', A.O_WRONLY);
    const data = new Uint8Array(4096);
    data.set(enc.encode('yy'));
    expect(await kernel.syscall(proc, A.SYS_write, [fd, 2], data)).toBe(2);
    expect(await times('t', 0, [A.UTIME_OMIT, A.UTIME_OMIT], [4000, 7])).toBe(0);
    expect(await kernel.syscall(proc, A.SYS_fstat, [fd], data)).toBe(0);
    expect(A.decodeStat(data)).toMatchObject({ mtimeMs: 4_000_000, mtimeNs: 7 });
    expect(await kernel.syscall(proc, A.SYS_close, [fd], data)).toBe(0);
    expect((await stat('t', 0)).mtime).toEqual([4000, 7]);
    expect(await fs.readFile('/tmp/kp/t', 'utf8')).toBe('yy');
  });
});
