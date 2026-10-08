/**
 * The kernel: process table, program loaders, path-based file opening and
 * the syscall dispatcher every transport (SAB channel, JSPI, in-page) uses.
 *
 * Processes get pids from the same counter as src/process-table.ts, and the
 * kernel registers itself as a source there, so `ps`, `kill`, `pgrep` and
 * `top` see kernel processes.
 */

import type { FileSystem } from '../filesystem';
import type { Shell } from '../shell';
import type { Command, CommandContext } from '../commands/index';
import { processTable, type ShiroProcess } from '../process-table';
import * as A from './abi';
import {
  type OpenFile, FdTable, BufferFile, DevNull, DevZero, DevRandom, DevFull,
  RegularFile, DirFile, openInode, inodeNumber, canWrite, refCount,
} from './fd';
import { createPipe } from './pipe';
import { Process } from './process';

/** Runs a process to completion; resolves with its exit code (or nothing if it exited through the kernel). */
export type Runner = (proc: Process, kernel: Kernel) => Promise<number | void>;

/** Finds the Runner for a program path, or null if this loader doesn't handle it. */
export type Loader = (path: string, proc: Process, kernel: Kernel) => Runner | null | Promise<Runner | null>;

/** Opens a device node; registered with `kernel.registerDevice` (e.g. /dev/ptmx from pty.ts). */
export type DeviceOpener = (proc: Process, flags: number, path: string) => OpenFile | number | Promise<OpenFile | number>;

export interface SpawnOptions {
  /** Program to run: a command name, or a path. */
  path: string;
  argv?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Explicit fd map for the child. Without it the child inherits the parent's fds 0-2 (or gets /dev/null). */
  fds?: Record<number, OpenFile>;
  /** Parent process (default: init, pid 1). */
  parent?: Process;
  /** Process group to join (0 = a new group led by the child). Default: the parent's group. */
  pgid?: number;
  /** Start a new session (setsid) in the child. */
  setsid?: boolean;
  /** Run this instead of resolving `path` through the loaders. */
  run?: Runner;
}

export interface WaitResult {
  /** Pid of the reported child, 0 for WNOHANG with nothing to report, or -errno. */
  pid: number;
  /** Linux wait status. */
  status: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function normalize(path: string): string {
  const stack: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return '/' + stack.join('/');
}

/** Single-quote a word for the shell. */
function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export class Kernel {
  fs?: FileSystem;
  /** The page's shell: builtins run in forks of it. */
  shell?: Shell;
  readonly procs = new Map<number, Process>();
  readonly init: Process;
  private loaders: Loader[] = [];
  private devices = new Map<string, DeviceOpener>();
  private stateWaiters = new Set<() => void>();
  private allocPid: () => number;
  private detachTable?: () => void;
  /** How long an unreaped child of init stays a zombie before it is reaped automatically. */
  initReapDelayMs = 30_000;

  constructor(opts: { fs?: FileSystem; shell?: Shell; allocPid?: () => number; registerWithProcessTable?: boolean } = {}) {
    this.fs = opts.fs ?? opts.shell?.fs;
    this.shell = opts.shell;
    this.allocPid = opts.allocPid ?? (() => processTable.allocatePid());
    this.init = new Process({
      pid: 1, ppid: 0, pgid: 1, sid: 1, path: '/sbin/init', argv: ['init'],
      env: { ...(opts.shell?.env ?? { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/user' }) },
      cwd: opts.shell?.cwd ?? '/',
    });
    this.procs.set(1, this.init);
    this.registerDevice('/dev/null', (_p, f) => new DevNull(f));
    this.registerDevice('/dev/zero', (_p, f) => new DevZero(f));
    this.registerDevice('/dev/full', (_p, f) => new DevFull(f));
    this.registerDevice('/dev/urandom', (_p, f) => new DevRandom(f, '/dev/urandom'));
    this.registerDevice('/dev/random', (_p, f) => new DevRandom(f, '/dev/random'));
    this.registerDevice('/dev/tty', p => p.ctty ?? -A.ENXIO);
    this.addLoader((path, proc, k) => k.builtinLoader(path, proc));
    if (opts.registerWithProcessTable !== false) {
      this.detachTable = processTable.attachSource({
        list: () => [...this.procs.values()].filter(p => p.pid !== 1).map(p => this.view(p)),
        get: pid => { const p = this.procs.get(pid); return p && p.pid !== 1 ? this.view(p) : undefined; },
        kill: pid => this.procs.has(pid) && pid !== 1 && this.kill(pid, A.SIGTERM) === 0,
      });
    }
  }

  /** Bind the page's filesystem and shell (main.ts does this at boot). */
  attach(fs: FileSystem, shell?: Shell): void {
    this.fs = fs;
    if (shell) {
      this.shell = shell;
      this.init.env = { ...shell.env };
      this.init.cwd = shell.cwd;
    }
  }

  /** Stop listing this kernel's processes in the page process table (tests). */
  dispose(): void {
    this.detachTable?.();
    this.detachTable = undefined;
  }

  // ── Programs ──────────────────────────────────────────────────────────────

  /** Loaders run newest first, before the builtin loader. */
  addLoader(loader: Loader): void {
    this.loaders.unshift(loader);
  }

  registerDevice(path: string, opener: DeviceOpener): void {
    this.devices.set(path, opener);
  }

  /** The Runner for `path`, or null when nothing can run it. */
  async findProgram(path: string, proc: Process): Promise<Runner | null> {
    for (const l of this.loaders) {
      const r = await l(path, proc, this);
      if (r) return r;
    }
    return null;
  }

  private async builtinLoader(path: string, _proc: Process): Promise<Runner | null> {
    const shell = this.shell;
    if (!shell) return null;
    const base = path.slice(path.lastIndexOf('/') + 1);
    const inBin = !path.includes('/') || /^\/(usr\/)?(local\/)?s?bin\//.test(path);
    const cmd = inBin ? shell.commands.get(base) : undefined;
    if (cmd) return proc => this.runBuiltin(proc, cmd);
    // Scripts and other executables the shell knows how to start
    const found = path.includes('/') ? ((await this.fs?.exists(path)) ? path : null) : await shell.findExecutableInPath(path);
    if (found) return proc => this.runViaShell(proc);
    return null;
  }

  // ── Process lifecycle ─────────────────────────────────────────────────────

  spawn(opts: SpawnOptions): Process {
    const parent = opts.parent ?? this.init;
    const pid = this.allocPid();
    const fds = new FdTable();
    const proc = new Process({
      pid,
      ppid: parent.pid,
      pgid: opts.pgid === 0 ? pid : (opts.pgid ?? parent.pgid),
      sid: parent.sid,
      path: opts.path,
      argv: opts.argv ?? [opts.path],
      env: { ...(opts.env ?? parent.env) },
      cwd: opts.cwd ?? parent.cwd,
      fds,
      umask: parent.umask,
    });
    if (opts.setsid) { proc.sid = pid; proc.pgid = pid; }
    proc.ctty = opts.setsid ? undefined : parent.ctty;
    if (opts.fds) {
      for (const [fd, file] of Object.entries(opts.fds)) fds.alloc(file, Number(fd));
    } else {
      for (const fd of [0, 1, 2]) {
        const f = parent.fds.get(fd);
        fds.alloc(f ?? new DevNull(), fd);
      }
    }
    this.procs.set(pid, proc);
    this.notify();
    void this.start(proc, opts.run);
    return proc;
  }

  private async start(proc: Process, run?: Runner): Promise<void> {
    // Let the caller see the Process (and wire it up) before the program starts
    await Promise.resolve();
    let code: number | void;
    try {
      const runner = run ?? (await this.findProgram(proc.path, proc));
      if (!runner) {
        await this.writeAll(proc, 2, enc.encode(`${proc.argv[0] ?? proc.path}: command not found\n`));
        code = 127;
      } else {
        code = await runner(proc, this);
      }
    } catch (e: any) {
      await this.writeAll(proc, 2, enc.encode(`${proc.comm}: ${e?.message ?? e}\n`)).catch(() => {});
      code = 1;
    }
    if (!proc.exiting) await this.exit(proc, A.W_EXITCODE(typeof code === 'number' ? code : 0));
  }

  /** Terminate `proc` with a wait status: close its fds, reparent its children, notify its parent. */
  async exit(proc: Process, status: number): Promise<void> {
    if (proc.pid === 1 || !proc.beginExit()) return;
    await proc.fds.closeAll();
    for (const child of this.procs.values()) {
      if (child.ppid === proc.pid) {
        child.ppid = 1;
        if (child.state === 'zombie') this.scheduleInitReap(child);
      }
    }
    proc.markExited(status);
    const parent = this.procs.get(proc.ppid);
    if (parent && parent.pid !== 1) this.deliver(parent, A.SIGCHLD);
    if (proc.ppid === 1) this.scheduleInitReap(proc);
    this.notify();
  }

  private scheduleInitReap(proc: Process): void {
    const t = setTimeout(() => {
      if (proc.ppid === 1 && this.procs.get(proc.pid) === proc && proc.state === 'zombie') {
        this.procs.delete(proc.pid);
        this.notify();
      }
    }, this.initReapDelayMs);
    (t as any)?.unref?.();
  }

  private notify(): void {
    for (const w of [...this.stateWaiters]) w();
  }

  private children(caller: Process, pid: number): Process[] {
    const out: Process[] = [];
    for (const p of this.procs.values()) {
      if (p.ppid !== caller.pid || p.pid === caller.pid) continue;
      if (pid > 0 ? p.pid === pid : pid === -1 ? true : pid === 0 ? p.pgid === caller.pgid : p.pgid === -pid) out.push(p);
    }
    return out;
  }

  /**
   * waitpid(2). `pid` > 0: that child; -1: any child; 0: any child in the
   * caller's group; < -1: any child in group -pid. Reaps what it reports.
   */
  async waitpid(pid: number, options = 0, caller: Process = this.init, signal?: AbortSignal): Promise<WaitResult> {
    for (;;) {
      const kids = this.children(caller, pid);
      if (kids.length === 0) return { pid: -A.ECHILD, status: 0 };
      for (const k of kids) {
        if (k.state === 'zombie') {
          this.procs.delete(k.pid);
          this.notify();
          return { pid: k.pid, status: k.exitStatus! };
        }
      }
      for (const k of kids) {
        const r = k.pendingStopReport;
        if (r === undefined) continue;
        if ((r === 0xffff && options & A.WCONTINUED) || (r !== 0xffff && options & A.WUNTRACED)) {
          k.pendingStopReport = undefined;
          return { pid: k.pid, status: r };
        }
      }
      if (options & A.WNOHANG) return { pid: 0, status: 0 };
      const woke = await new Promise<boolean>(resolve => {
        const done = (v: boolean) => { this.stateWaiters.delete(onState); signal?.removeEventListener('abort', onAbort); resolve(v); };
        const onState = () => done(true);
        const onAbort = () => done(false);
        if (signal?.aborted) { resolve(false); return; }
        this.stateWaiters.add(onState);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      if (!woke) return { pid: -A.EINTR, status: 0 };
    }
  }

  /** kill(2): pid > 0, 0 (caller's group), -1 (everything but init), < -1 (group -pid). sig 0 probes. */
  kill(pid: number, sig: number, sender: Process = this.init): number {
    if (sig < 0 || sig >= A.NSIG) return -A.EINVAL;
    let targets: Process[];
    if (pid > 0) targets = this.procs.has(pid) ? [this.procs.get(pid)!] : [];
    else if (pid === 0) targets = [...this.procs.values()].filter(p => p.pgid === sender.pgid && p.pid !== 1);
    else if (pid === -1) targets = [...this.procs.values()].filter(p => p.pid !== 1 && p.pid !== sender.pid);
    else targets = [...this.procs.values()].filter(p => p.pgid === -pid);
    targets = targets.filter(p => p.state !== 'zombie' || pid > 0);
    if (targets.length === 0) return -A.ESRCH;
    if (sig === 0) return 0;
    for (const p of targets) this.deliver(p, sig);
    return 0;
  }

  /** Deliver one signal: the signal hook (signals.ts) first, then the disposition, then the default action. */
  deliver(proc: Process, sig: number): void {
    if (proc.state === 'zombie' || proc.exiting || proc.pid === 1) return;
    if (sig === A.SIGKILL) { void this.exit(proc, A.W_TERMSIG(A.SIGKILL)); return; }
    if (sig === A.SIGSTOP) { proc.markStopped(sig); this.notify(); return; }
    if (sig === A.SIGCONT) { proc.markContinued(); this.notify(); }
    if (proc.signalHook?.(proc, sig)) return;
    const disp = proc.dispositions.get(sig) ?? 'default';
    if (disp === 'ignore') return;
    if (typeof disp === 'number') {
      // A guest handler: flag it for the guest and interrupt blocking syscalls (EINTR)
      proc.pendingSignals.add(sig);
      proc.interruptSyscalls();
      proc.data.onSignal && (proc.data.onSignal as (s: number) => void)(sig);
      return;
    }
    switch (A.defaultSignalAction(sig)) {
      case 'term': void this.exit(proc, A.W_TERMSIG(sig)); break;
      case 'stop': proc.markStopped(sig); this.notify(); break;
      default: break;
    }
  }

  /** A ShiroProcess view of `p` for src/process-table.ts (ps, kill, top). */
  private view(p: Process): ShiroProcess {
    const st = p.exitStatus;
    return {
      pid: p.pid,
      command: p.argv.join(' '),
      status: p.state === 'zombie' ? (st !== undefined && A.WIFSIGNALED(st) ? 'killed' : 'exited') : 'running',
      exitCode: st === undefined ? 0 : A.shellExitCode(st),
      startTime: p.startTime,
      windowTerminal: null,
      serverWindow: null,
      promise: p.wait().then(A.shellExitCode),
      kill: () => { this.kill(p.pid, A.SIGKILL); },
      abortController: null,
    };
  }

  // ── Files ─────────────────────────────────────────────────────────────────

  /** Absolute path for `path` relative to `dirfd` (AT_FDCWD = cwd), or -errno. */
  resolvePath(proc: Process, path: string, dirfd = A.AT_FDCWD): string | number {
    if (path === '') return -A.ENOENT;
    if (path.startsWith('/')) return normalize(path);
    let base = proc.cwd;
    if (dirfd !== A.AT_FDCWD) {
      const d = proc.fds.get(dirfd);
      if (!d) return -A.EBADF;
      if (d.kind !== 'dir' || !d.path) return -A.ENOTDIR;
      base = d.path;
    }
    return normalize(base + '/' + path);
  }

  /** open(2) without the fd: returns the new OpenFile or -errno. */
  async open(proc: Process, path: string, flags: number, mode = 0o666, dirfd = A.AT_FDCWD): Promise<OpenFile | number> {
    const p = this.resolvePath(proc, path, dirfd);
    if (typeof p === 'number') return p;
    const fdm = /^\/(?:dev\/fd|proc\/self\/fd)\/(\d+)$/.exec(p) ?? (/^\/dev\/(stdin|stdout|stderr)$/.exec(p));
    if (fdm) {
      const n = fdm[1] === 'stdin' ? 0 : fdm[1] === 'stdout' ? 1 : fdm[1] === 'stderr' ? 2 : Number(fdm[1]);
      return proc.fds.get(n) ?? -A.EBADF;
    }
    const dev = this.devices.get(p);
    if (dev) return dev(proc, flags, p);
    const fs = this.fs;
    if (!fs) return -A.ENOSYS;
    const statusFlags = flags & ~(A.O_CREAT | A.O_EXCL | A.O_TRUNC | A.O_CLOEXEC | A.O_NOCTTY | A.O_DIRECTORY | A.O_NOFOLLOW);
    try {
      let st: Awaited<ReturnType<FileSystem['stat']>> | null = null;
      try { st = await fs.stat(p); } catch { st = null; }
      if (!st) {
        if (!(flags & A.O_CREAT)) return -A.ENOENT;
        if (flags & A.O_DIRECTORY) return -A.EINVAL;
        await fs.writeFile(p, new Uint8Array(0), { mode: mode & ~proc.umask & 0o7777 });
      } else {
        if ((flags & A.O_CREAT) && (flags & A.O_EXCL)) return -A.EEXIST;
        if (st.isDirectory()) {
          if (canWrite(flags)) return -A.EISDIR;
          return new DirFile(fs, p, statusFlags);
        }
        if (flags & A.O_DIRECTORY) return -A.ENOTDIR;
      }
      const real = await fs.realpath(p);
      const file = new RegularFile(await openInode(fs, real), statusFlags);
      if ((flags & A.O_TRUNC) && canWrite(flags)) await file.truncate(0);
      return file;
    } catch (e) {
      return A.errnoFromError(e);
    }
  }

  async statPath(proc: Process, path: string, follow = true, dirfd = A.AT_FDCWD): Promise<A.KStat | number> {
    const p = this.resolvePath(proc, path, dirfd);
    if (typeof p === 'number') return p;
    const dev = this.devices.get(p);
    if (dev) {
      const f = await dev(proc, A.O_RDONLY, p);
      return typeof f === 'number' ? f : f.stat();
    }
    const fs = this.fs;
    if (!fs) return -A.ENOSYS;
    try {
      const st = follow ? await fs.stat(p) : await fs.lstat(p);
      const type = st.isDirectory() ? A.S_IFDIR : st.isSymbolicLink() ? A.S_IFLNK : A.S_IFREG;
      return {
        dev: 1, ino: inodeNumber(p), mode: type | (st.mode & 0o7777), nlink: st.isDirectory() ? 2 : 1,
        uid: 1000, gid: 1000, rdev: 0, size: st.size, blksize: 4096, blocks: Math.ceil(st.size / 512),
        atimeMs: st.mtime.getTime(), mtimeMs: st.mtime.getTime(), ctimeMs: st.ctime.getTime(),
      };
    } catch (e) {
      return A.errnoFromError(e);
    }
  }

  /** Write all of `data` to `fd`, delivering SIGPIPE on EPIPE. Returns bytes written or -errno. */
  async writeAll(proc: Process, fd: number, data: Uint8Array): Promise<number> {
    const f = proc.fds.get(fd);
    if (!f) return -A.EBADF;
    let off = 0;
    while (off < data.length) {
      const n = await f.write(data.subarray(off), proc.syscallSignal);
      if (n === -A.EPIPE) this.deliver(proc, A.SIGPIPE);
      if (n < 0) return off > 0 ? off : n;
      if (n === 0) break;
      off += n;
    }
    return off;
  }

  /** Read `fd` to EOF. */
  async readAll(proc: Process, fd: number): Promise<Uint8Array | number> {
    const f = proc.fds.get(fd);
    if (!f) return -A.EBADF;
    const chunks: Uint8Array[] = [];
    let total = 0;
    const buf = new Uint8Array(65536);
    for (;;) {
      const n = await f.read(buf, proc.syscallSignal);
      if (n < 0) return total > 0 ? concat(chunks, total) : n;
      if (n === 0) break;
      chunks.push(buf.slice(0, n));
      total += n;
    }
    return concat(chunks, total);
  }

  // ── Builtins ──────────────────────────────────────────────────────────────

  /**
   * Run a Shiro builtin as this process: fd 0 (when it is a pipe, file or
   * in-memory stream) becomes `ctx.stdin`, and `ctx.stdout`/`ctx.stderr`
   * go to fds 1 and 2 when the command returns.
   */
  async runBuiltin(proc: Process, cmd: Command): Promise<number> {
    const shell = this.forkShell(proc);
    const ctx: CommandContext = {
      args: proc.argv.slice(1),
      fs: this.fs ?? shell.fs,
      cwd: proc.cwd,
      env: shell.env,
      stdin: await this.stdinText(proc),
      stdout: '',
      stderr: '',
      shell,
      stdoutIsTTY: proc.fds.get(1)?.kind === 'pty',
    };
    let code: number;
    try {
      code = await cmd.exec(ctx);
    } catch (e: any) {
      ctx.stderr += (e?.message ?? String(e)) + '\n';
      code = 1;
    }
    if (proc.exiting) return code;
    if (ctx.stdout) await this.writeAll(proc, 1, enc.encode(ctx.stdout));
    if (ctx.stderr && !proc.exiting) await this.writeAll(proc, 2, enc.encode(ctx.stderr));
    if (shell.cwd !== proc.cwd) proc.cwd = shell.cwd;
    return code;
  }

  /** Run argv through a forked shell (scripts, node programs, anything in PATH that is not a registered command). */
  private async runViaShell(proc: Process): Promise<number> {
    const shell = this.forkShell(proc);
    const line = proc.argv.length ? [proc.path, ...proc.argv.slice(1)].map(shellQuote).join(' ') : shellQuote(proc.path);
    const stdin = await this.stdinText(proc);
    let chain = Promise.resolve();
    const out = (fd: number) => (s: string) => {
      chain = chain.then(async () => { if (!proc.exiting) await this.writeAll(proc, fd, enc.encode(s.replace(/\r\n/g, '\n'))); });
    };
    const code = await shell.executeWithStdin(line, stdin, out(1), out(2));
    await chain;
    return code;
  }

  private forkShell(proc: Process): Shell {
    const base = this.shell;
    if (!base) throw new Error('kernel has no shell attached');
    const shell = base.fork();
    shell.cwd = proc.cwd;
    shell.env = { ...proc.env, PWD: proc.cwd };
    proc.onTerminate(() => shell.abortController?.abort());
    return shell;
  }

  private async stdinText(proc: Process): Promise<string> {
    const f = proc.fds.get(0);
    if (!f) return '';
    if (f.kind === 'pipe' || f.kind === 'file' || f.kind === 'socket' || f instanceof BufferFile) {
      const r = await this.readAll(proc, 0);
      return typeof r === 'number' ? '' : dec.decode(r);
    }
    return '';
  }

  // ── Syscalls ──────────────────────────────────────────────────────────────

  /**
   * Dispatch one syscall for `proc`. `args` are the channel's int32 argument
   * slots; `data` is the data area (in/out). Returns the result or -errno; a
   * result above 2^31 (lseek) is returned as a plain number and the channel
   * splits it.
   */
  async syscall(proc: Process, nr: number, args: ArrayLike<number>, data: Uint8Array): Promise<number> {
    if (proc.state === 'stopped') await proc.waitWhileStopped();
    if (proc.exiting) return -A.EINTR;
    const sig = proc.syscallSignal;
    const fds = proc.fds;
    const str = (off: number, len: number) => {
      if (len < 0 || off + len > data.length) throw Object.assign(new Error('EFAULT'), { errno: A.EFAULT });
      // slice(): browsers refuse to decode views of a SharedArrayBuffer
      return dec.decode(data.slice(off, off + len));
    };
    const i64 = (lo: number, hi: number) => (hi | 0) * 0x100000000 + (lo >>> 0);
    const file = (fd: number) => fds.get(fd);

    try {
      switch (nr) {
        case A.SYS_read: {
          const f = file(args[0]);
          if (!f) return -A.EBADF;
          return await f.read(data.subarray(0, Math.min(args[1] >>> 0, data.length)), sig);
        }
        case A.SYS_write: {
          const f = file(args[0]);
          if (!f) return -A.EBADF;
          const n = await f.write(data.subarray(0, Math.min(args[1] >>> 0, data.length)), sig);
          if (n === -A.EPIPE) this.deliver(proc, A.SIGPIPE);
          return n;
        }
        case A.SYS_open:
        case A.SYS_openat: {
          const [dirfd, len, flags, mode] = nr === A.SYS_open ? [A.AT_FDCWD, args[0], args[1], args[2]] : [args[0], args[1], args[2], args[3]];
          const f = await this.open(proc, str(0, len), flags, mode, dirfd);
          if (typeof f === 'number') return f;
          const fd = fds.alloc(f, 0, !!(flags & A.O_CLOEXEC));
          if (fd < 0 && refCount(f) === 0) await f.close();
          return fd;
        }
        case A.SYS_close:
          return await fds.close(args[0]);
        case A.SYS_stat:
        case A.SYS_lstat:
        case A.SYS_fstat: {
          let st: A.KStat | number;
          if (nr === A.SYS_fstat) {
            const f = file(args[0]);
            if (!f) return -A.EBADF;
            st = await f.stat();
          } else {
            st = await this.statPath(proc, str(0, args[0]), nr === A.SYS_stat);
          }
          if (typeof st === 'number') return st;
          A.encodeStat(st, data);
          return 0;
        }
        case A.SYS_poll:
          return await this.poll(proc, data, args[0], args[1]);
        case A.SYS_lseek: {
          const f = file(args[0]);
          if (!f) return -A.EBADF;
          if (!f.seek) return -A.ESPIPE;
          return f.seek(i64(args[1], args[2]), args[3]);
        }
        case A.SYS_ioctl: {
          const f = file(args[0]);
          if (!f) return -A.EBADF;
          if (!f.ioctl) return -A.ENOTTY;
          return await f.ioctl(args[1] >>> 0, data.subarray(0, Math.min(args[2] >>> 0, data.length)));
        }
        case A.SYS_pipe:
        case A.SYS_pipe2: {
          const flags = nr === A.SYS_pipe2 ? args[0] : 0;
          const [r, w] = createPipe(flags);
          const rfd = fds.alloc(r, 0, !!(flags & A.O_CLOEXEC));
          if (rfd < 0) return rfd;
          const wfd = fds.alloc(w, 0, !!(flags & A.O_CLOEXEC));
          if (wfd < 0) { await fds.close(rfd); return wfd; }
          const dv = new DataView(data.buffer, data.byteOffset, 8);
          dv.setInt32(0, rfd, true);
          dv.setInt32(4, wfd, true);
          return 0;
        }
        case A.SYS_dup:
          return fds.dup(args[0]);
        case A.SYS_dup2:
          if (!fds.has(args[0])) return -A.EBADF;
          return await fds.dup2(args[0], args[1]);
        case A.SYS_dup3:
          if (args[0] === args[1]) return -A.EINVAL;
          return await fds.dup2(args[0], args[1], !!(args[2] & A.O_CLOEXEC));
        case A.SYS_nanosleep: {
          const ms = args[0] * 1000 + Math.floor(args[1] / 1e6);
          return await new Promise<number>(resolve => {
            const t = setTimeout(() => { sig.removeEventListener('abort', onAbort); resolve(0); }, ms);
            const onAbort = () => { clearTimeout(t); resolve(-A.EINTR); };
            sig.addEventListener('abort', onAbort, { once: true });
          });
        }
        case A.SYS_getpid: return proc.pid;
        case A.SYS_getppid: return proc.ppid;
        case A.SYS_getuid: return proc.uid;
        case A.SYS_getgid: return proc.gid;
        case A.SYS_getpgrp: return proc.pgid;
        case A.SYS_getpgid:
        case A.SYS_getsid: {
          const p = args[0] === 0 ? proc : this.procs.get(args[0]);
          if (!p) return -A.ESRCH;
          return nr === A.SYS_getpgid ? p.pgid : p.sid;
        }
        case A.SYS_setpgid: {
          const p = args[0] === 0 ? proc : this.procs.get(args[0]);
          if (!p || (p !== proc && p.ppid !== proc.pid)) return -A.ESRCH;
          if (p.sid !== proc.sid) return -A.EPERM;
          if (p.pid === p.sid) return -A.EPERM;
          const pgid = args[1] === 0 ? p.pid : args[1];
          if (pgid < 0) return -A.EINVAL;
          if (pgid !== p.pid && ![...this.procs.values()].some(q => q.pgid === pgid && q.sid === proc.sid)) return -A.EPERM;
          p.pgid = pgid;
          return 0;
        }
        case A.SYS_setsid: {
          if ([...this.procs.values()].some(q => q.pgid === proc.pid && q !== proc) || proc.pgid === proc.pid) return -A.EPERM;
          proc.sid = proc.pid;
          proc.pgid = proc.pid;
          proc.ctty = undefined;
          return proc.sid;
        }
        case A.SYS_exit:
        case A.SYS_exit_group:
          await this.exit(proc, A.W_EXITCODE(args[0]));
          return 0;
        case A.SYS_wait4: {
          const r = await this.waitpid(args[0], args[1], proc, sig);
          if (r.pid > 0) new DataView(data.buffer, data.byteOffset, 4).setInt32(0, r.status, true);
          return r.pid;
        }
        case A.SYS_kill:
          return this.kill(args[0], args[1], proc);
        case A.SYS_fcntl:
          return this.fcntl(proc, args[0], args[1], args[2]);
        case A.SYS_fsync: {
          const f = file(args[0]);
          if (!f) return -A.EBADF;
          await f.sync?.();
          return 0;
        }
        case A.SYS_ftruncate: {
          const f = file(args[0]);
          if (!f) return -A.EBADF;
          if (!f.truncate) return -A.EINVAL;
          return await f.truncate(i64(args[1], args[2]));
        }
        case A.SYS_getcwd: {
          const b = enc.encode(proc.cwd + '\0');
          const cap = Math.min(args[0] >>> 0 || data.length, data.length);
          if (b.length > cap) return -A.ERANGE;
          data.set(b);
          return b.length;
        }
        case A.SYS_chdir: {
          const p = this.resolvePath(proc, str(0, args[0]));
          if (typeof p === 'number') return p;
          const st = await this.statPath(proc, p);
          if (typeof st === 'number') return st;
          if ((st.mode & A.S_IFMT) !== A.S_IFDIR) return -A.ENOTDIR;
          proc.cwd = p;
          proc.env.PWD = p;
          return 0;
        }
        case A.SYS_rename: {
          const from = this.resolvePath(proc, str(0, args[0]));
          const to = this.resolvePath(proc, str(args[0], args[1]));
          if (typeof from === 'number') return from;
          if (typeof to === 'number') return to;
          await this.fs!.rename(from, to);
          return 0;
        }
        case A.SYS_mkdir: {
          const p = this.resolvePath(proc, str(0, args[0]));
          if (typeof p === 'number') return p;
          if (await this.fs!.exists(p)) return -A.EEXIST;
          await this.fs!.mkdir(p);
          await this.fs!.chmod(p, args[1] & ~proc.umask & 0o7777).catch(() => {});
          return 0;
        }
        case A.SYS_rmdir:
        case A.SYS_unlink: {
          const p = this.resolvePath(proc, str(0, args[0]));
          if (typeof p === 'number') return p;
          const st = await this.statPath(proc, p, false);
          if (typeof st === 'number') return st;
          const isDir = (st.mode & A.S_IFMT) === A.S_IFDIR;
          if (nr === A.SYS_unlink && isDir) return -A.EISDIR;
          if (nr === A.SYS_rmdir && !isDir) return -A.ENOTDIR;
          if (isDir) await this.fs!.rmdir(p);
          else await this.fs!.unlink(p);
          return 0;
        }
        case A.SYS_readlink: {
          const p = this.resolvePath(proc, str(0, args[0]));
          if (typeof p === 'number') return p;
          let target: string;
          try { target = await this.fs!.readlink(p); } catch (e) { return A.errnoFromError(e, A.EINVAL); }
          const b = enc.encode(target);
          const n = Math.min(b.length, args[1] >>> 0 || data.length, data.length);
          data.set(b.subarray(0, n));
          return n;
        }
        case A.SYS_umask: {
          const old = proc.umask;
          proc.umask = args[0] & 0o777;
          return old;
        }
        case A.SYS_getdents64:
          return await this.getdents(proc, args[0], data.subarray(0, Math.min(args[1] >>> 0, data.length)));
        case A.SYS_spawn:
          return await this.sysSpawn(proc, JSON.parse(str(0, args[0])));
        case A.SYS_getenv: {
          const b = enc.encode(JSON.stringify({ argv: proc.argv, env: proc.env, cwd: proc.cwd, pid: proc.pid }));
          if (b.length > data.length) return -A.E2BIG;
          data.set(b);
          return b.length;
        }
        default:
          return -A.ENOSYS;
      }
    } catch (e: any) {
      if (typeof e?.errno === 'number' && e.errno > 0) return -e.errno;
      return A.errnoFromError(e);
    }
  }

  private fcntl(proc: Process, fd: number, cmd: number, arg: number): number | Promise<number> {
    const fds = proc.fds;
    const f = fds.get(fd);
    if (!f) return -A.EBADF;
    switch (cmd) {
      case A.F_DUPFD: return fds.dup(fd, arg);
      case A.F_DUPFD_CLOEXEC: return fds.dup(fd, arg, true);
      case A.F_GETFD: return fds.getCloexec(fd) ? A.FD_CLOEXEC : 0;
      case A.F_SETFD: return fds.setCloexec(fd, !!(arg & A.FD_CLOEXEC));
      case A.F_GETFL: return f.flags;
      case A.F_SETFL: {
        const mask = A.O_NONBLOCK | A.O_APPEND;
        f.flags = (f.flags & ~mask) | (arg & mask);
        return 0;
      }
      default: return -A.EINVAL;
    }
  }

  /** poll(2) over `nfds` struct pollfd entries at the start of `data`. timeout < 0 waits forever. */
  async poll(proc: Process, data: Uint8Array, nfds: number, timeoutMs: number): Promise<number> {
    if (nfds < 0 || nfds * A.POLLFD_SIZE > data.length) return -A.EINVAL;
    const dv = new DataView(data.buffer, data.byteOffset, nfds * A.POLLFD_SIZE);
    const scan = () => {
      let ready = 0;
      for (let i = 0; i < nfds; i++) {
        const fd = dv.getInt32(i * 8, true);
        const events = dv.getInt16(i * 8 + 4, true);
        let rev = 0;
        if (fd >= 0) {
          const f = proc.fds.get(fd);
          rev = f ? f.poll(events) : A.POLLNVAL;
        }
        dv.setInt16(i * 8 + 6, rev, true);
        if (rev) ready++;
      }
      return ready;
    };
    let n = scan();
    if (n > 0 || timeoutMs === 0) return n;
    const sig = proc.syscallSignal;
    const files = new Set<OpenFile>();
    for (let i = 0; i < nfds; i++) {
      const f = proc.fds.get(dv.getInt32(i * 8, true));
      if (f) files.add(f);
    }
    return await new Promise<number>(resolve => {
      const offs: (() => void)[] = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (v: number) => {
        offs.forEach(o => o());
        if (timer) clearTimeout(timer);
        sig.removeEventListener('abort', onAbort);
        resolve(v);
      };
      const onAbort = () => finish(-A.EINTR);
      for (const f of files) offs.push(f.onReady(() => { const r = scan(); if (r > 0) finish(r); }));
      if (timeoutMs > 0) timer = setTimeout(() => finish(scan()), timeoutMs);
      sig.addEventListener('abort', onAbort, { once: true });
      // Readiness may have changed while subscribing
      n = scan();
      if (n > 0) finish(n);
    });
  }

  private async getdents(proc: Process, fd: number, out: Uint8Array): Promise<number> {
    const f = proc.fds.get(fd);
    if (!f) return -A.EBADF;
    if (!(f instanceof DirFile)) return -A.ENOTDIR;
    const entries = await f.readdir();
    if (typeof entries === 'number') return entries;
    const dv = new DataView(out.buffer, out.byteOffset, out.length);
    let off = 0;
    let used = 0;
    for (const name of entries) {
      const nb = enc.encode(name);
      const reclen = (19 + nb.length + 1 + 7) & ~7;
      if (off + reclen > out.length) break;
      const full = name === '.' ? f.path! : name === '..' ? normalize(f.path! + '/..') : normalize(f.path! + '/' + name);
      let type = A.DT_UNKNOWN;
      const st = await this.statPath(proc, full, false);
      if (typeof st !== 'number') {
        const t = st.mode & A.S_IFMT;
        type = t === A.S_IFDIR ? A.DT_DIR : t === A.S_IFLNK ? A.DT_LNK : t === A.S_IFREG ? A.DT_REG : t === A.S_IFCHR ? A.DT_CHR : A.DT_UNKNOWN;
      }
      dv.setUint32(off, inodeNumber(full), true);
      dv.setUint32(off + 4, 0, true);
      dv.setUint32(off + 8, used + 1, true);
      dv.setUint32(off + 12, 0, true);
      dv.setUint16(off + 16, reclen, true);
      dv.setUint8(off + 18, type);
      out.set(nb, off + 19);
      out.fill(0, off + 19 + nb.length, off + reclen);
      off += reclen;
      used++;
    }
    if (used === 0 && entries.length > 0) return -A.EINVAL;
    f.consume(used);
    return off;
  }

  /** SYS_spawn: posix_spawn from a guest. */
  private async sysSpawn(proc: Process, req: {
    path: string; argv?: string[]; env?: Record<string, string>; cwd?: string;
    fds?: [number, number][]; pgid?: number; setsid?: boolean;
  }): Promise<number> {
    if (!req || typeof req.path !== 'string') return -A.EINVAL;
    const map: Record<number, OpenFile> = {};
    const pairs = req.fds ?? [[0, 0], [1, 1], [2, 2]];
    for (const [child, parent] of pairs) {
      const f = proc.fds.get(parent);
      if (!f) return -A.EBADF;
      map[child] = f;
    }
    let cwd = proc.cwd;
    if (req.cwd) {
      const c = this.resolvePath(proc, req.cwd);
      if (typeof c === 'number') return c;
      cwd = c;
    }
    const probe = new Process({ pid: -1, ppid: proc.pid, path: req.path, argv: req.argv ?? [req.path], env: req.env ?? proc.env, cwd });
    const runner = await this.findProgram(req.path, probe);
    if (!runner) return -A.ENOENT;
    const child = this.spawn({
      path: req.path, argv: req.argv, env: req.env ?? proc.env, cwd, fds: map,
      parent: proc, pgid: req.pgid, setsid: req.setsid, run: runner,
    });
    return child.pid;
  }
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

let singleton: Kernel | undefined;

/** The page's kernel (created on first use; main.ts attaches the filesystem and shell). */
export function getKernel(): Kernel {
  const w = typeof window !== 'undefined' ? (window as any) : undefined;
  if (w?.__shiroKernel) return w.__shiroKernel;
  if (!singleton) singleton = new Kernel();
  if (w) w.__shiroKernel = singleton;
  return singleton;
}
