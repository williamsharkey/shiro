/**
 * syscalls.ts — kernel-side service for syscalls made by WASM guests.
 *
 * Both transports end here: the SAB channel (guest in a Worker) and direct
 * calls (JSPI guest on the main thread). Requests use Linux numbers and
 * return -errno; see ./abi.ts for argument conventions. Every call works on
 * the calling Process's fd table, so pipes, terminals and files behave the
 * same for WASM guests, builtins and (later) other runtimes.
 *
 * Argument conventions (int32 args, 64-bit values as lo/hi pairs):
 *   read(fd, len) → out bytes          write(fd) data=bytes
 *   pread64(fd, len, offLo, offHi)      pwrite64(fd, offLo, offHi) data=bytes
 *   openat(dirfd, flags, mode) data=path
 *   fstat(fd) → out filestat           newfstatat(dirfd, flags) data=path → out filestat
 *   lseek(fd, offLo, offHi, whence) → new offset (int32)
 *   getdents64(fd) → out [u8 filetype, u16 namelen, name]...
 *   renameat(olddirfd, newdirfd) data="old\0new"   symlinkat(newdirfd) data="target\0path"
 *   ppoll(nfds, timeoutMs) data=[i32 fd, i16 events, i16 revents]*nfds → out same
 *   pipe2(flags) → out [i32 r, i32 w]  wait4(pid, options) → pid, out [i32 status]
 *   exit_group(code, signal)            spawn data=JSON SpawnRequest → pid
 *   thread_spawn(startArg) → tid
 */

import {
  AT_FDCWD, AT_REMOVEDIR, AT_SYMLINK_NOFOLLOW, EBADF, ECHILD, EEXIST, EINVAL, EISDIR,
  ENOENT, ENOSYS, ENOTDIR, ENOTSUP, ESPIPE, F_GETFD, F_GETFL, F_SETFD, F_SETFL, FT_DIR,
  O_ACCMODE, O_APPEND, O_CLOEXEC, O_CREAT, O_DIRECTORY, O_EXCL, O_NONBLOCK, O_RDONLY, O_TRUNC,
  POLLNVAL, STAT_SIZE, SEEK_END, SpawnRequest, SysReply, SysRequest, encodeStat, exitStatus,
  signalStatus,
  SYS_chdir, SYS_close, SYS_dup, SYS_dup2, SYS_exit_group, SYS_fcntl, SYS_fstat, SYS_fsync,
  SYS_ftruncate, SYS_getcwd, SYS_getdents64, SYS_getpid, SYS_getppid, SYS_kill, SYS_linkat,
  SYS_lseek, SYS_mkdirat, SYS_newfstatat, SYS_openat, SYS_pipe2, SYS_ppoll, SYS_pread64,
  SYS_pwrite64, SYS_read, SYS_readlinkat, SYS_renameat, SYS_spawn, SYS_symlinkat,
  SYS_thread_spawn, SYS_unlinkat, SYS_utimensat, SYS_wait4, SYS_write,
} from './abi';
import {
  DevFile, FdTable, FsDir, FsFile, Kernel, OpenFile, Pipe, Process, fsErrno, statPath,
} from './kernel';
import { normPath } from '../wasi-runtime';

export interface SysContext {
  kernel: Kernel;
  proc: Process;
  /** Largest reply the transport can carry. */
  dataSize: number;
  /** Start a wasi-threads thread; absent when the process can't have threads. */
  threadSpawn?(startArg: number): number | Promise<number>;
  /** Terminate the whole process (exit_group). */
  exit(status: number): Promise<void>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const u64 = (lo: number, hi: number) => (hi >>> 0) * 0x100000000 + (lo >>> 0);
const err = (e: number): SysReply => ({ ret: e < 0 ? e : -e });

export async function dispatch(ctx: SysContext, req: SysRequest): Promise<SysReply> {
  const { proc, kernel } = ctx;
  const a = req.args;
  const data = req.data ?? new Uint8Array(0);
  const fds = proc.fds;
  const file = (fd: number) => fds.get(fd);

  switch (req.nr) {
    case SYS_read: {
      const f = file(a[0]); if (!f) return err(EBADF);
      const buf = new Uint8Array(Math.max(0, Math.min(a[1], ctx.dataSize)));
      const n = await f.read(buf);
      return n > 0 ? { ret: n, out: buf.subarray(0, n) } : { ret: n };
    }
    case SYS_write: {
      const f = file(a[0]); if (!f) return err(EBADF);
      const n = await f.write(data);
      if (n === -32) await kernel.kill(proc.pid, 13); // EPIPE → SIGPIPE
      return { ret: n };
    }
    case SYS_pread64: {
      const f = file(a[0]); if (!f) return err(EBADF);
      if (!f.pread) return err(ESPIPE);
      const buf = new Uint8Array(Math.max(0, Math.min(a[1], ctx.dataSize)));
      const n = await f.pread(buf, u64(a[2], a[3]));
      return n > 0 ? { ret: n, out: buf.subarray(0, n) } : { ret: n };
    }
    case SYS_pwrite64: {
      const f = file(a[0]); if (!f) return err(EBADF);
      if (!f.pwrite) return err(ESPIPE);
      return { ret: await f.pwrite(data, u64(a[1], a[2])) };
    }
    case SYS_openat: {
      const path = resolveAt(proc, a[0], dec.decode(data));
      if (typeof path === 'number') return err(path);
      const f = await openPath(kernel, path, a[1]);
      if (typeof f === 'number') return err(f);
      return { ret: fds.alloc(f, 0, !!(a[1] & O_CLOEXEC)) };
    }
    case SYS_close: return { ret: await fds.close(a[0]) };
    case SYS_fstat: {
      const f = file(a[0]); if (!f) return err(EBADF);
      return { ret: 0, out: encodeStat(await f.stat()) };
    }
    case SYS_newfstatat: {
      const path = resolveAt(proc, a[0], dec.decode(data));
      if (typeof path === 'number') return err(path);
      const open = kernel.inodes.peek(path);
      const st = await statPath(kernel.fs, path, !(a[1] & AT_SYMLINK_NOFOLLOW));
      if (typeof st === 'number') return err(st);
      if (open?.data && st.filetype !== FT_DIR) st.size = open.size;
      return { ret: 0, out: encodeStat(st) };
    }
    case SYS_lseek: {
      const f = file(a[0]); if (!f) return err(EBADF);
      if (!f.seek) return err(ESPIPE);
      if (a[3] === SEEK_END && f instanceof FsFile) await f.inode.load();
      return { ret: f.seek(signed64(a[1], a[2]), a[3]) };
    }
    case SYS_dup: return { ret: fds.dup(a[0]) };
    case SYS_dup2: return { ret: await fds.dup2(a[0], a[1]) };
    case SYS_fcntl: {
      const f = file(a[0]); if (!f) return err(EBADF);
      switch (a[1]) {
        case F_GETFD: return { ret: fds.getCloexec(a[0]) ? 1 : 0 };
        case F_SETFD: fds.setCloexec(a[0], !!(a[2] & 1)); return { ret: 0 };
        case F_GETFL: return { ret: f.flags };
        case F_SETFL: f.flags = (f.flags & ~(O_APPEND | O_NONBLOCK)) | (a[2] & (O_APPEND | O_NONBLOCK)); return { ret: 0 };
        default: return err(EINVAL);
      }
    }
    case SYS_ftruncate: {
      const f = file(a[0]); if (!f) return err(EBADF);
      if (!f.truncate) return err(EINVAL);
      return { ret: await f.truncate(u64(a[1], a[2])) };
    }
    case SYS_fsync: {
      const f = file(a[0]); if (!f) return err(EBADF);
      await f.sync?.();
      return { ret: 0 };
    }
    case SYS_getcwd: { const out = enc.encode(proc.cwd); return { ret: out.length, out }; }
    case SYS_chdir: {
      const path = resolveAt(proc, AT_FDCWD, dec.decode(data));
      if (typeof path === 'number') return err(path);
      const st = await statPath(kernel.fs, path);
      if (typeof st === 'number') return err(st);
      if (st.filetype !== FT_DIR) return err(ENOTDIR);
      proc.cwd = path;
      proc.env.PWD = path;
      return { ret: 0 };
    }
    case SYS_getdents64: {
      const f = file(a[0]); if (!f) return err(EBADF);
      if (!f.readdir) return err(ENOTDIR);
      const list = await f.readdir();
      if (typeof list === 'number') return err(list);
      const parts: number[] = [];
      for (const e of list) {
        const name = enc.encode(e.name);
        if (parts.length + 3 + name.length > ctx.dataSize) break;
        parts.push(e.filetype, name.length & 0xff, name.length >> 8, ...name);
      }
      const out = new Uint8Array(parts);
      return { ret: out.length, out };
    }
    case SYS_mkdirat: {
      const path = resolveAt(proc, a[0], dec.decode(data));
      if (typeof path === 'number') return err(path);
      try { await kernel.fs.mkdir(path); return { ret: 0 }; } catch (e) { return err(fsErrno(e)); }
    }
    case SYS_unlinkat: {
      const path = resolveAt(proc, a[0], dec.decode(data));
      if (typeof path === 'number') return err(path);
      try {
        const st = await kernel.fs.lstat(path);
        if (a[1] & AT_REMOVEDIR) {
          if (st.type !== 'dir') return err(ENOTDIR);
          await kernel.fs.rmdir(path);
        } else {
          if (st.type === 'dir') return err(EISDIR);
          await kernel.inodes.peek(path)?.flush();
          kernel.inodes.detach(path);
          await kernel.fs.unlink(path);
        }
        return { ret: 0 };
      } catch (e) { return err(fsErrno(e)); }
    }
    case SYS_renameat: {
      const [from, to] = dec.decode(data).split('\0');
      const src = resolveAt(proc, a[0], from);
      const dst = resolveAt(proc, a[1], to ?? '');
      if (typeof src === 'number') return err(src);
      if (typeof dst === 'number') return err(dst);
      try {
        await kernel.inodes.rename(src, dst);
        const target = await kernel.fs.lstat(dst).catch(() => null);
        if (target && target.type !== 'dir') await kernel.fs.unlink(dst);
        await kernel.fs.rename(src, dst);
        return { ret: 0 };
      } catch (e) { return err(fsErrno(e)); }
    }
    case SYS_symlinkat: {
      const [target, link] = dec.decode(data).split('\0');
      const path = resolveAt(proc, a[0], link ?? '');
      if (typeof path === 'number') return err(path);
      if (await kernel.fs.exists(path)) return err(EEXIST);
      try { await kernel.fs.symlink(target, path); return { ret: 0 }; } catch (e) { return err(fsErrno(e)); }
    }
    case SYS_readlinkat: {
      const path = resolveAt(proc, a[0], dec.decode(data));
      if (typeof path === 'number') return err(path);
      try { const out = enc.encode(await kernel.fs.readlink(path)); return { ret: out.length, out }; }
      catch (e) { return err(fsErrno(e)); }
    }
    case SYS_linkat: return err(ENOTSUP);
    case SYS_utimensat: return { ret: 0 };
    case SYS_ppoll: return ppoll(proc, a[0], a[1], data);
    case SYS_pipe2: {
      const [r, w] = new Pipe().ends();
      const cloexec = !!(a[0] & O_CLOEXEC);
      if (a[0] & O_NONBLOCK) { r.flags |= O_NONBLOCK; w.flags |= O_NONBLOCK; }
      const rfd = fds.alloc(r, 0, cloexec);
      const wfd = fds.alloc(w, 0, cloexec);
      const out = new Uint8Array(8);
      new DataView(out.buffer).setInt32(0, rfd, true);
      new DataView(out.buffer).setInt32(4, wfd, true);
      return { ret: 0, out };
    }
    case SYS_getpid: return { ret: proc.pid };
    case SYS_getppid: return { ret: proc.ppid };
    case SYS_wait4: {
      const r = await kernel.waitpid(proc.pid, a[0] === 0 ? -1 : a[0], a[1]);
      if (typeof r === 'number') return err(r);
      const out = new Uint8Array(4);
      new DataView(out.buffer).setInt32(0, r.status, true);
      return { ret: r.pid, out };
    }
    case SYS_kill: return { ret: await kernel.kill(a[0], a[1]) };
    case SYS_exit_group: {
      await ctx.exit(a[1] ? signalStatus(a[1]) : exitStatus(a[0]));
      return { ret: 0 };
    }
    case SYS_spawn: return spawn(ctx, JSON.parse(dec.decode(data)) as SpawnRequest);
    case SYS_thread_spawn: {
      if (!ctx.threadSpawn) return err(ENOSYS);
      return { ret: await ctx.threadSpawn(a[0]) };
    }
    default:
      return err(ENOSYS);
  }
}

/** int64 from int32 halves (hi carries the sign). */
function signed64(lo: number, hi: number): number {
  return hi * 0x100000000 + (lo >>> 0);
}

/** Resolve `path` relative to `dirfd` (AT_FDCWD = the process cwd). */
export function resolveAt(proc: Process, dirfd: number, path: string): string | number {
  if (!path) return -ENOENT;
  if (path.startsWith('/')) return normPath(path);
  let base: string;
  if (dirfd === AT_FDCWD) base = proc.cwd;
  else {
    const f = proc.fds.get(dirfd);
    if (!f) return -EBADF;
    if (f.kind !== 'dir' || !f.path) return -ENOTDIR;
    base = f.path;
  }
  return normPath(base + '/' + path);
}

/** open(2) on a resolved absolute path. */
export async function openPath(kernel: Kernel, path: string, flags: number): Promise<OpenFile | number> {
  const dev = /^\/dev\/(null|zero|urandom|random)$/.exec(path);
  if (dev) return new DevFile(path, dev[1] === 'random' ? 'urandom' : dev[1] as any, flags);
  const st = await statPath(kernel.fs, path);
  const wantWrite = (flags & O_ACCMODE) !== O_RDONLY;
  if (typeof st === 'number') {
    if (st !== -ENOENT || !(flags & O_CREAT)) return st;
    if (flags & O_DIRECTORY) return -ENOENT;
    try { await kernel.fs.writeFile(path, new Uint8Array(0)); } catch (e) { return fsErrno(e); }
    const ino = kernel.inodes.get(path);
    ino.data = new Uint8Array(0); ino.size = 0; ino.unlinked = false;
    return new FsFile(kernel.inodes, ino, flags & ~(O_CREAT | O_EXCL | O_TRUNC | O_CLOEXEC));
  }
  if ((flags & O_CREAT) && (flags & O_EXCL)) return -EEXIST;
  if (st.filetype === FT_DIR) {
    if (wantWrite) return -EISDIR;
    return new FsDir(kernel.fs, path, flags);
  }
  if (flags & O_DIRECTORY) return -ENOTDIR;
  const f = new FsFile(kernel.inodes, kernel.inodes.get(path), flags & ~(O_CREAT | O_EXCL | O_TRUNC | O_CLOEXEC));
  if ((flags & O_TRUNC) && wantWrite) await f.truncate(0);
  return f;
}

async function ppoll(proc: Process, nfds: number, timeoutMs: number, data: Uint8Array): Promise<SysReply> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const entries: Array<{ fd: number; events: number; file?: OpenFile }> = [];
  for (let i = 0; i < nfds; i++) {
    const fd = view.getInt32(i * 8, true);
    entries.push({ fd, events: view.getInt16(i * 8 + 4, true), file: fd >= 0 ? proc.fds.get(fd) : undefined });
  }
  const out = new Uint8Array(nfds * 8);
  const ov = new DataView(out.buffer);
  const scan = () => {
    let count = 0;
    entries.forEach((e, i) => {
      const rev = e.fd < 0 ? 0 : e.file ? e.file.poll(e.events) : POLLNVAL;
      ov.setInt32(i * 8, e.fd, true);
      ov.setInt16(i * 8 + 4, e.events, true);
      ov.setInt16(i * 8 + 6, rev, true);
      if (rev) count++;
    });
    return count;
  };
  let count = scan();
  if (count || timeoutMs === 0) return { ret: count, out };
  await new Promise<void>(resolve => {
    const offs: Array<() => void> = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => { offs.forEach(o => o()); if (timer) clearTimeout(timer); resolve(); };
    for (const e of entries) {
      if (e.file) offs.push(e.file.onReady(() => { if (scan()) finish(); }));
    }
    offs.push(() => { proc.killHooks = proc.killHooks.filter(h => h !== onKill); });
    const onKill = () => finish();
    proc.killHooks.push(onKill);
    if (timeoutMs > 0) timer = setTimeout(finish, timeoutMs);
  });
  count = scan();
  return { ret: count, out };
}

async function spawn(ctx: SysContext, req: SpawnRequest): Promise<SysReply> {
  const { kernel, proc } = ctx;
  const fds: FdTable = proc.fds.fork();
  await fds.closeOnExec();
  let cwd = req.cwd ? (resolveAt(proc, AT_FDCWD, req.cwd) as string) : proc.cwd;
  if (typeof cwd === 'number') { await fds.closeAll(); return err(cwd); }
  for (const act of req.fileActions ?? []) {
    let r = 0;
    if (act.op === 'close') r = await fds.close(act.fd);
    else if (act.op === 'dup2') r = await fds.dup2(act.src, act.fd);
    else if (act.op === 'open') {
      const p = resolveAt({ ...proc, cwd } as Process, AT_FDCWD, act.path);
      const f = typeof p === 'number' ? p : await openPath(kernel, p, act.flags);
      if (typeof f === 'number') r = f; else await fds.install(act.fd, f, !!(act.flags & O_CLOEXEC));
    } else if (act.op === 'chdir') {
      const p = resolveAt({ ...proc, cwd } as Process, AT_FDCWD, act.path);
      if (typeof p === 'number') r = p; else cwd = p;
    } else if (act.op === 'fchdir') {
      const f = fds.get(act.src);
      if (!f) r = -EBADF; else if (f.kind !== 'dir' || !f.path) r = -ENOTDIR; else cwd = f.path;
    }
    if (r < 0) { await fds.closeAll(); return err(r); }
  }
  const env = req.env ?? proc.env;
  const search = req.searchPath && !req.name.includes('/');
  const child = await kernel.spawn({
    // Without a PATH search a bare name is a file in the cwd, as for execve
    path: search || req.name.includes('/') ? req.name : './' + req.name,
    argv: req.argv.length ? req.argv : [req.name],
    env: search && req.path ? { ...env, PATH: req.path } : { ...env },
    cwd, fds, ppid: proc.pid,
  });
  if (typeof child === 'number') { await fds.closeAll(); return err(child); }
  if (req.exec) {
    const status = await child.wait();
    await kernel.waitpid(proc.pid, child.pid);
    await ctx.exit(status);
    return { ret: 0 };
  }
  return { ret: child.pid };
}

export { ECHILD };
