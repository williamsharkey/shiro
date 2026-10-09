/**
 * The kernel: process table, program loaders, path-based file opening and
 * the syscall dispatcher every transport (SAB channel, JSPI, in-page) uses.
 *
 * Processes get pids from the same counter as src/process-table.ts, and the
 * kernel registers itself as a source there, so `ps`, `kill`, `pgrep` and
 * `top` see kernel processes.
 */

import { addProcInfoSource, type FileSystem } from '../filesystem';
import type { Shell } from '../shell';
import type { Command, CommandContext } from '../commands/index';
import { ProcFs, bootMs } from './procfs';
import { processTable, type ShiroProcess } from '../process-table';
import { packageShadows, packageArgsForPath, PKG_BIN_DIR } from '../pkg-manager';
import * as A from './abi';
import {
  type OpenFile, FdTable, BufferFile, DevNull, DevZero, DevRandom, DevFull,
  RegularFile, DirFile, openInode, openInodeSync, inodeNumber, canWrite, refCount, renameInodes, unlinkInode, flushInode, openInodeInfo, shareInodeNumber, forgetInodeNumber,
} from './fd';
import { createPipe } from './pipe';
import { Process } from './process';
import { EpollFile, waitReady } from './epoll';
import { EventFile } from './fd';

/** Runs a process to completion; resolves with its exit code (or nothing if it exited through the kernel). */
export type Runner = (proc: Process, kernel: Kernel) => Promise<number | void>;

/** Finds the Runner for a program path, or null if this loader doesn't handle it. */
export type Loader = (path: string, proc: Process, kernel: Kernel) => Runner | null | Promise<Runner | null>;

/** Opens a device node; registered with `kernel.registerDevice` (e.g. /dev/ptmx from pty.ts). */
export type DeviceOpener = (proc: Process, flags: number, path: string) => OpenFile | number | Promise<OpenFile | number>;

/**
 * A syscall handler registered with `kernel.registerSyscalls`. Same
 * arguments as Kernel.syscall; return undefined to pass the call on (to an
 * earlier registration, then the kernel's own handler).
 */
export type SyscallHandler = ((
  proc: Process, nr: number, args: ArrayLike<number>, data: Uint8Array, kernel: Kernel,
) => number | undefined | Promise<number | undefined>) & {
  /**
   * Optional: true when the handler would pass this call on (return
   * undefined) without doing anything. Lets kernel.syscallSync answer it;
   * without it, every call to the handler's numbers takes the async path.
   */
  passSync?: (proc: Process, nr: number, args: ArrayLike<number>, data: Uint8Array, kernel: Kernel) => boolean;
};

export interface SpawnOptions {
  /** Program to run: a command name, or a path. */
  path: string;
  argv?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /**
   * Explicit fd map for the child. Without it the child inherits every
   * parent fd not marked close-on-exec (posix_spawn), and gets /dev/null for
   * any of 0-2 the parent lacks.
   */
  fds?: Record<number, OpenFile>;
  /** With `fds`: also inherit the parent's non-cloexec fds, with `fds` installed on top. */
  inheritFds?: boolean;
  /**
   * Inherit the parent's ignored signals and signal mask, as exec does
   * (SYS_spawn sets this). Off by default for host spawns: the page and the
   * pty leader stand in for a shell, whose own ignores children shouldn't get.
   */
  inheritSignals?: boolean;
  /** Signals reset to SIG_DFL in the child (posix_spawnattr_setsigdefault). */
  sigdefault?: number[];
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

/** Shell builtins that Unix systems also have as programs in /bin and /usr/bin. */
const SHELL_PROGRAMS = new Set(['echo', 'printf', 'test', '[', 'true', 'false', 'pwd', 'kill']);

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
  /** Paths of AF_UNIX socket files (net.ts bind); they stat as sockets. */
  socketPaths?: Set<string>;
  /** The page's shell: builtins run in forks of it. */
  shell?: Shell;
  /** uname(2) nodename (the prompt's \h). */
  hostname = 'shiro';
  readonly procs = new Map<number, Process>();
  readonly init: Process;
  private loaders: Loader[] = [];
  private devices = new Map<string, DeviceOpener>();
  private stateWaiters = new Set<() => void>();
  private spawnHooks = new Set<(proc: Process) => void>();
  private syscallTable = new Map<number, SyscallHandler[]>();
  private allocPid: () => number;
  /** The last pid handed out (/proc/stat, /proc/loadavg). */
  lastPid = 0;
  readonly procfs = new ProcFs(this);
  private detachTable?: () => void;
  /** How long an unreaped child of init stays a zombie before it is reaped automatically. */
  initReapDelayMs = 30_000;

  constructor(opts: { fs?: FileSystem; shell?: Shell; allocPid?: () => number; registerWithProcessTable?: boolean } = {}) {
    this.fs = opts.fs ?? opts.shell?.fs;
    this.shell = opts.shell;
    const alloc = opts.allocPid ?? (() => processTable.allocatePid());
    this.allocPid = () => (this.lastPid = alloc());
    this.init = new Process({
      pid: 1, ppid: 0, pgid: 1, sid: 1, path: '/sbin/init', argv: ['init'],
      env: { ...(opts.shell?.env ?? { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/user' }) },
      cwd: opts.shell?.cwd ?? '/',
    });
    this.procs.set(1, this.init);
    // /proc/PID/stat and status for kernel processes
    addProcInfoSource((pid) => {
      const p = this.procs.get(pid);
      if (!p || pid === 1) return undefined;
      const state = p.state === 'zombie' ? 'Z' : p.state === 'stopped' ? 'T' : p.inSyscall > 0 ? 'S' : 'R';
      return { pid, ppid: p.ppid, pgid: p.pgid, sid: p.sid, comm: p.comm, state, cmdline: p.argv };
    });
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

  /** Remove a device node (a closed pty's /dev/pts/N), so its opener can be collected. */
  unregisterDevice(path: string): void {
    this.devices.delete(path);
  }

  /**
   * Handle syscall numbers outside kernel.ts (net.ts sockets, pty.ts or
   * signals.ts overrides, runtime-specific calls). Later registrations run
   * first; a handler returning undefined passes the call on. `nrs` is a list
   * of numbers or an inclusive [lo, hi] range object. Returns an unregister function.
   */
  registerSyscalls(nrs: number[] | { lo: number; hi: number }, handler: SyscallHandler): () => void {
    const list = Array.isArray(nrs) ? nrs : Array.from({ length: nrs.hi - nrs.lo + 1 }, (_, i) => nrs.lo + i);
    for (const nr of list) {
      const hs = this.syscallTable.get(nr) ?? [];
      hs.unshift(handler);
      this.syscallTable.set(nr, hs);
    }
    return () => {
      for (const nr of list) {
        const hs = this.syscallTable.get(nr)?.filter(h => h !== handler) ?? [];
        if (hs.length) this.syscallTable.set(nr, hs);
        else this.syscallTable.delete(nr);
      }
    };
  }

  /**
   * Called synchronously for every new process, after it is in the table and
   * before its program starts (signals.ts adopts processes here). Returns an
   * unsubscribe function.
   */
  onSpawn(cb: (proc: Process) => void): () => void {
    this.spawnHooks.add(cb);
    return () => this.spawnHooks.delete(cb);
  }

  /** The Runner for `path`, or null when nothing can run it. */
  async findProgram(path: string, proc: Process): Promise<Runner | null> {
    for (const l of this.loaders) {
      const r = await l(path, proc, this);
      if (r) return this.withPackageArgs(path, r);
    }
    return null;
  }

  /** An installed command's own arguments (`egrep` runs `grep -E`) go in after argv[0]. */
  private async withPackageArgs(path: string, run: Runner): Promise<Runner> {
    if (!this.fs || !path.startsWith(PKG_BIN_DIR + '/')) return run;
    const args = await packageArgsForPath(this.fs, path);
    if (!args) return run;
    return (p, k) => {
      p.argv = [p.argv[0] ?? path, ...args, ...p.argv.slice(1)];
      return run(p, k);
    };
  }

  private async builtinLoader(path: string, _proc: Process): Promise<Runner | null> {
    const shell = this.shell;
    if (!shell) return null;
    const base = path.slice(path.lastIndexOf('/') + 1);
    const inBin = !path.includes('/') || /^\/(usr\/)?(local\/)?s?bin\//.test(path);
    const cmd = inBin ? shell.commands.get(base) : undefined;
    if (cmd && (base === 'sh' || base === 'bash')) return proc => this.runShellProcess(proc);
    // An installed package's command replaces the builtin, as at the prompt
    // (a bin-dir path can name a builtin's PATH shim, or nothing on disk)
    const pkgBin = `${PKG_BIN_DIR}/${base}`;
    if (cmd && this.fs && path !== pkgBin && packageShadows(this.fs).has(base)) return this.findProgram(pkgBin, _proc);
    if (cmd && SHELL_NAMES.has(base)) {
      const direct = await this.shellCommandDirect(_proc);
      if (direct) return direct;
    }
    if (cmd) return proc => this.runBuiltin(proc, cmd);
    // Shell builtins that are also programs (/bin/echo, /usr/bin/test, ...)
    if (inBin && SHELL_PROGRAMS.has(base)) return proc => this.runViaShell(proc, base);
    // Scripts and other executables the shell knows how to start
    const found = path.includes('/') ? ((await this.fs?.exists(path)) ? path : null) : await shell.findExecutableInPath(path);
    if (found) return proc => this.runViaShell(proc);
    return null;
  }

  /**
   * `sh -c 'prog args'` naming a program (not a builtin), with nothing for
   * the shell to do but start it: run the program in this process, as a
   * real shell execs its last command. Builtins see stdin only at EOF and
   * write their output when they return, so a program talking to its parent
   * over pipes (git clone and git-upload-pack) can't go through one.
   */
  private async shellCommandDirect(probe: Process): Promise<Runner | null> {
    const a = probe.argv;
    if (a.length < 3 || a[1] !== '-c') return null;
    const words = simpleCommandWords(a[2]);
    if (!words || !words.length || words[0].includes('=')) return null;
    const name = words[0];
    let path: string | null = null;
    if (name.includes('/')) {
      const p = this.resolvePath(probe, name);
      if (typeof p === 'string' && (await this.fs?.exists(p))) path = p;
    } else if (this.fs && this.shell?.commands.get(name) && packageShadows(this.fs).has(name)) {
      path = `${PKG_BIN_DIR}/${name}`; // an installed package replaces the builtin
    } else if (!this.shell?.commands.get(name)) {
      for (const dir of (probe.env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(':')) {
        if (!dir) continue;
        const p = `${dir.replace(/\/$/, '')}/${name}`;
        if (await this.fs?.exists(p)) { path = p; break; }
      }
    }
    if (!path) return null;
    const next = new Process({ pid: -1, ppid: probe.ppid, path, argv: words, env: probe.env, cwd: probe.cwd });
    const runner = await this.findProgram(path, next);
    if (!runner) return null;
    return (proc, k) => {
      proc.path = path!;
      proc.argv = words;
      return runner(proc, k);
    };
  }

  // ── Process lifecycle ─────────────────────────────────────────────────────

  spawn(opts: SpawnOptions): Process {
    const parent = opts.parent ?? this.init;
    const pid = this.allocPid();
    let fds: FdTable;
    if (opts.fds && !opts.inheritFds) {
      fds = new FdTable();
      for (const [fd, file] of Object.entries(opts.fds)) fds.alloc(file, Number(fd));
    } else {
      fds = parent.fds.inherit(opts.fds ?? {});
      if (!opts.fds) for (const fd of [0, 1, 2]) if (!fds.has(fd)) fds.alloc(new DevNull(), fd);
    }
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
    if (opts.inheritSignals) {
      // Across exec caught signals reset to default; ignored stay ignored; the mask carries over
      for (const [sig, d] of parent.dispositions) if (d === 'ignore') proc.dispositions.set(sig, 'ignore');
      for (const sig of parent.sigmask) proc.sigmask.add(sig);
    }
    for (const sig of opts.sigdefault ?? []) proc.dispositions.delete(sig);
    this.procs.set(pid, proc);
    for (const h of [...this.spawnHooks]) {
      try { h(proc); } catch (e) { console.warn('[kernel] onSpawn hook failed', e); }
    }
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
        // execve that swapped programs (SYS_shiro_execve): run the next one in this process
        while (!proc.exiting && proc.data.execRunner) {
          const next = proc.data.execRunner as Runner;
          delete proc.data.execRunner;
          code = await next(proc, this);
        }
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

  /** Wake waitpid() callers: call after changing a process's state outside the kernel (job-control stops). */
  notify(): void {
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
          if (!(options & A.WNOWAIT)) {
            this.procs.delete(k.pid);
            this.notify();
          }
          return { pid: k.pid, status: k.exitStatus! };
        }
      }
      for (const k of kids) {
        const r = k.pendingStopReport;
        if (r === undefined) continue;
        if ((r === 0xffff && options & A.WCONTINUED) || (r !== 0xffff && options & A.WUNTRACED)) {
          if (!(options & A.WNOWAIT)) k.pendingStopReport = undefined;
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
    if (disp === 'default' && A.defaultSignalAction(sig) === 'ignore') return;
    if (proc.sigmask.has(sig)) { proc.deferredSignals.add(sig); return; }
    if (typeof disp === 'number') {
      // A guest handler: flag it for the guest and interrupt blocking syscalls (EINTR)
      proc.pendingSignals.add(sig);
      proc.interruptSyscalls();
      (proc.data.onSignal as ((s: number) => void) | undefined)?.(sig);
      return;
    }
    switch (A.defaultSignalAction(sig)) {
      case 'term': void this.exit(proc, A.W_TERMSIG(sig)); break;
      case 'stop': proc.markStopped(sig); this.notify(); break;
      default: break;
    }
  }

  /**
   * Take the next signal for a guest handler (channels call this to fill
   * their signal word): the lowest pending, unblocked one. Blocks the
   * handler's sa_mask (and the signal itself, without SA_NODEFER) until the
   * guest's rt_sigreturn. Returns 0 when none.
   */
  takeSignal(proc: Process): number {
    const sig = [...proc.pendingSignals].filter(s => !proc.sigmask.has(s)).sort((a, b) => a - b)[0];
    if (sig === undefined) return 0;
    proc.pendingSignals.delete(sig);
    const act = proc.sigactions.get(sig);
    proc.signalFrames.push(new Set(proc.sigmask));
    for (const s of act?.mask ?? []) if (s !== A.SIGKILL && s !== A.SIGSTOP) proc.sigmask.add(s);
    if (!(act && act.flags & A.SA_NODEFER)) proc.sigmask.add(sig);
    if (act && act.flags & A.SA_RESETHAND) { proc.dispositions.delete(sig); proc.sigactions.delete(sig); }
    return sig;
  }

  /** The process a thread id belongs to (a process's main thread has tid = pid). */
  processOfTid(tid: number): Process | undefined {
    const p = this.procs.get(tid);
    if (p) return p;
    for (const q of this.procs.values()) if (q.tids.has(tid)) return q;
    return undefined;
  }

  /** A new thread id for an extra thread of `proc` (worker-host attachThread). */
  allocTid(proc: Process): number {
    const tid = this.allocPid();
    proc.tids.add(tid);
    return tid;
  }

  /** Install a new signal mask and deliver whatever it unblocked. */
  setSigmask(proc: Process, mask: Set<number>): void {
    mask.delete(A.SIGKILL);
    mask.delete(A.SIGSTOP);
    proc.sigmask = mask;
    for (const s of [...proc.deferredSignals]) {
      if (!mask.has(s)) { proc.deferredSignals.delete(s); this.deliver(proc, s); }
    }
    if ([...proc.pendingSignals].some(s => !mask.has(s))) (proc.data.onSignal as ((s: number) => void) | undefined)?.(0);
  }

  /** A ShiroProcess view of `p` for src/process-table.ts (ps, kill, top). */
  private view(p: Process): ShiroProcess {
    const st = p.exitStatus;
    return {
      pid: p.pid,
      command: p.argv.join(' '),
      status: p.state === 'zombie' ? (st !== undefined && A.WIFSIGNALED(st) ? 'killed' : 'exited') : p.state === 'stopped' ? 'stopped' : 'running',
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
    if (p === '/proc' || p.startsWith('/proc/')) {
      const link = this.procfs.linkTarget(proc, p);
      if (link) return link === p ? -A.ELOOP : this.open(proc, link, flags, mode);
      const pf = this.procfs.open(proc, p, flags);
      if (pf !== undefined) return pf;
    }
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

  /** A registered device node, or a directory that holds one (/dev, /dev/pts). */
  isDevicePath(p: string): boolean {
    if (this.devices.has(p)) return true;
    for (const d of this.devices.keys()) if (d.startsWith(p + '/')) return true;
    return false;
  }

  /**
   * open() of a file or directory the FileSystem has in memory, without
   * creating or truncating: the description, -errno, or undefined when it
   * needs `open` (devices, O_CREAT/O_TRUNC, anything not cached).
   */
  openSync(proc: Process, path: string, flags: number, dirfd = A.AT_FDCWD): OpenFile | number | undefined {
    const fs = this.fs;
    if (!fs || flags & (A.O_CREAT | A.O_TRUNC)) return undefined;
    const p = this.resolvePath(proc, path, dirfd);
    if (typeof p === 'number') return p;
    if (this.devices.has(p) || /^\/(?:dev|proc)\//.test(p)) return undefined;
    const hit = fs.lookupCached(p);
    if (hit === undefined) return undefined;
    if (hit === null) return -A.ENOENT;
    const statusFlags = flags & ~(A.O_CREAT | A.O_EXCL | A.O_TRUNC | A.O_CLOEXEC | A.O_NOCTTY | A.O_DIRECTORY | A.O_NOFOLLOW);
    if (hit.node.type === 'dir') return canWrite(flags) ? -A.EISDIR : new DirFile(fs, p, statusFlags);
    if (flags & A.O_DIRECTORY) return -A.ENOTDIR;
    if (hit.node.type !== 'file') return undefined;
    return new RegularFile(openInodeSync(fs, hit.path, hit.node), statusFlags);
  }

  /** statPath from memory, encoded into `data`: 0, -errno, or undefined (use statPath). */
  private statPathSyncInto(proc: Process, path: string, follow: boolean, dirfd: number, data: Uint8Array): number | undefined {
    const fs = this.fs;
    if (!fs) return undefined;
    const p = this.resolvePath(proc, path, dirfd);
    if (typeof p === 'number') return p;
    if (this.devices.has(p) || p === '/proc' || p.startsWith('/proc/') || this.socketPaths?.has(p)) return undefined;
    const hit = fs.lookupCached(p, follow);
    if (hit === undefined) return undefined;
    if (hit === null) return -A.ENOENT;
    const n = hit.node;
    const type = n.type === 'dir' ? A.S_IFDIR : n.type === 'symlink' ? A.S_IFLNK : A.S_IFREG;
    A.encodeStat({
      dev: 1, ino: inodeNumber(p), mode: type | (n.mode & 0o7777), nlink: n.type === 'dir' ? 2 : 1,
      uid: 1000, gid: 1000, rdev: 0, size: n.size, blksize: 4096, blocks: Math.ceil(n.size / 512),
      atimeMs: n.mtime, mtimeMs: n.mtime, ctimeMs: n.ctime,
    }, data);
    return 0;
  }

  async statPath(proc: Process, path: string, follow = true, dirfd = A.AT_FDCWD): Promise<A.KStat | number> {
    const p = this.resolvePath(proc, path, dirfd);
    if (typeof p === 'number') return p;
    const dev = this.devices.get(p);
    if (dev) {
      // A description just for the stat: O_NOCTTY (stat must not make a pty the
      // caller's controlling tty), closed after (a slave left open hides hangups)
      const f = await dev(proc, A.O_RDONLY | A.O_NOCTTY, p);
      if (typeof f === 'number') return f;
      try { return await f.stat(); } finally { if (f !== proc.ctty) await f.close(); }
    }
    if (p === '/proc' || p.startsWith('/proc/')) {
      const pst = this.procfs.stat(proc, p, follow);
      if (pst !== undefined) return pst;
      const link = follow ? this.procfs.linkTarget(proc, p) : undefined;
      if (link) return this.statPath(proc, link, true);
    }
    const fs = this.fs;
    if (!fs) return -A.ENOSYS;
    try {
      const st = follow ? await fs.stat(p) : await fs.lstat(p);
      let type = st.isDirectory() ? A.S_IFDIR : st.isSymbolicLink() ? A.S_IFLNK : A.S_IFREG;
      // The same file through a symlink is the same inode; an open file may have unflushed writes
      const real = follow && type !== A.S_IFDIR ? await fs.realpath(p).catch(() => p) : p;
      if (type === A.S_IFREG && this.socketPaths?.has(real)) type = A.S_IFSOCK;
      const open = type === A.S_IFREG ? openInodeInfo(fs, real) : undefined;
      const size = open?.size ?? st.size;
      const mtimeMs = open?.mtimeMs ?? st.mtime.getTime();
      return {
        dev: 1, ino: inodeNumber(real), mode: type | (st.mode & 0o7777), nlink: st.isDirectory() ? 2 : 1,
        uid: 1000, gid: 1000, rdev: 0, size, blksize: 4096, blocks: Math.ceil(size / 512),
        atimeMs: mtimeMs, mtimeMs, ctimeMs: st.ctime.getTime(),
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
  /**
   * `sh`/`bash` as a kernel process (a program's system(), popen(), `sh -c
   * CMD`, `#!/bin/sh` scripts): the forked shell is the process
   * (`shell.kernelHost`), so programs it runs get its real fds and the tty.
   * Builtins write to fd 1/2 as they go. Stdin is read up front only for a
   * script on stdin or one that starts with a builtin (which takes its
   * input as a string); a program at the start reads fd 0 itself.
   */
  private async runShellProcess(proc: Process): Promise<number> {
    const shell = this.forkShell(proc);
    shell.kernelHost = { kernel: this, proc };
    const args = proc.argv.slice(1);
    let i = 0;
    while (i < args.length && /^-[a-zA-Z]+$/.test(args[i]) && args[i] !== '-c') i++; // -e, -x, -l ...
    let script: string;
    let positional: string[] = [];
    // No script and a terminal (or -i): an interactive shell (a tmux pane, screen window, `sh` from a program)
    if (args[i] !== '-c' && (args.slice(0, i).includes('-i') || (i >= args.length && proc.fds.get(0)?.kind === 'pty'))) {
      return this.interactiveShell(proc, shell);
    }
    if (args[i] === '-c') {
      script = args[i + 1] ?? '';
      positional = args.slice(i + 2);
    } else if (i < args.length) {
      try {
        const p = this.resolvePath(proc, args[i]);
        if (typeof p === 'number') throw new Error('bad path');
        const raw = await this.fs!.readFile(p);
        script = typeof raw === 'string' ? raw : A.decodeText(raw);
      } catch {
        await this.writeAll(proc, 2, enc.encode(`sh: ${args[i]}: No such file or directory\n`));
        return 127;
      }
      positional = args.slice(i);
    } else {
      script = await this.stdinText(proc);
    }
    if (script.startsWith('#!')) script = script.slice(script.indexOf('\n') + 1);
    const first = script.trim().split(/[\s;|&]/)[0] ?? '';
    const { packageShadows } = await import('../pkg-manager');
    const builtinFirst = (!!shell.commands.get(first) && !packageShadows(shell.fs).has(first)) || SHELL_PROGRAMS.has(first) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(first) ||
      ['cd', 'read', 'while', 'if', 'for', 'case', 'until', 'exec', 'set', 'export', 'eval', '.', 'source', '{', '('].includes(first);
    const stdin = args[i] === '-c' && builtinFirst ? await this.stdinText(proc) : '';
    let chain = Promise.resolve();
    const out = (fd: number) => (s: string) => {
      chain = chain.then(async () => { if (!proc.exiting) await this.writeAll(proc, fd, enc.encode(s.replace(/\r\n/g, '\n'))); });
    };
    if (positional.length) shell.env['0'] = positional[0];
    let code: number;
    if (script.includes('\n')) {
      // Multi-line: compound statements accumulate across lines
      code = await shell.executeShellScript(script, positional.slice(1), { stdin } as CommandContext, out(1), out(2));
    } else {
      positional.slice(1).forEach((v, k) => { shell.env[String(k + 1)] = v; });
      shell.env['#'] = String(Math.max(0, positional.length - 1));
      shell.env['@'] = positional.slice(1).join(' ');
      code = await shell.executeWithStdin(script, stdin, out(1), out(2));
    }
    await chain;
    return code;
  }

  /**
   * Read-eval loop on fd 0 for `sh` run as a kernel process on a terminal: the
   * pty's line discipline edits the line; PS1 (default `\u@\h:\w\$ `) goes to
   * fd 2. Like bash, it survives Ctrl-C/Ctrl-\/Ctrl-Z (its foreground
   * children, in the same process group, get them) and ends at `exit` or EOF.
   */
  private async interactiveShell(proc: Process, shell: Shell): Promise<number> {
    const jobSignals = new Set([A.SIGINT, A.SIGQUIT, A.SIGTSTP, A.SIGTTIN, A.SIGTTOU]);
    const outer = proc.signalHook; // job control's
    proc.signalHook = (p, sig) => {
      if (!jobSignals.has(sig)) return outer?.(p, sig) ?? false;
      if (sig === A.SIGINT) p.interruptSyscalls(); // a fresh prompt
      return true;
    };
    shell.env.PS1 ??= '\\u@\\h:\\w\\$ ';
    let chain = Promise.resolve();
    const out = (fd: number) => (s: string) => {
      chain = chain.then(async () => { if (!proc.exiting) await this.writeAll(proc, fd, enc.encode(s.replace(/\r\n/g, '\n'))); });
    };
    const prompt = () => {
      const home = shell.env.HOME || '/home/user';
      const cwd = shell.cwd === home ? '~' : shell.cwd.startsWith(home + '/') ? '~' + shell.cwd.slice(home.length) : shell.cwd;
      return (shell.env.PS1 ?? '').replace(/\\([uhHwW$n\\])/g, (_, c: string) => ({
        u: shell.env.USER || 'user', h: 'shiro', H: 'shiro', w: cwd, W: cwd === '~' ? '~' : cwd.slice(cwd.lastIndexOf('/') + 1) || '/',
        $: '$', n: '\n', '\\': '\\',
      } as Record<string, string>)[c]);
    };
    const buf = new Uint8Array(4096);
    let pending = '';
    let code = 0;
    for (;;) {
      await chain;
      await this.writeAll(proc, 2, enc.encode(prompt()));
      // one line from the terminal (canonical mode hands over whole lines)
      let line: string | null = null;
      while (line === null) {
        const nl = pending.indexOf('\n');
        if (nl >= 0) { line = pending.slice(0, nl); pending = pending.slice(nl + 1); break; }
        const f = proc.fds.get(0);
        const n = f ? await f.read(buf, proc.syscallSignal) : 0;
        if (proc.exiting) return code;
        if (n === -A.EINTR) { pending = ''; await this.writeAll(proc, 2, enc.encode('\n' + prompt())); continue; }
        if (n <= 0) { if (pending) { line = pending; pending = ''; break; } await this.writeAll(proc, 2, enc.encode('exit\n')); return code; }
        pending += A.decodeText(buf.subarray(0, n));
      }
      if (!line.trim()) continue;
      code = await shell.execute(line, out(1), out(2));
      await chain;
      if (shell.exited) return code;
    }
  }

  private async runViaShell(proc: Process, name = proc.path): Promise<number> {
    const shell = this.forkShell(proc);
    const line = proc.argv.length ? [name, ...proc.argv.slice(1)].map(shellQuote).join(' ') : shellQuote(name);
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
      return typeof r === 'number' ? '' : A.decodeText(r);
    }
    return '';
  }

  // ── Syscalls ──────────────────────────────────────────────────────────────

  /**
   * Dispatch one syscall for `proc`. `args` are the channel's int32 argument
   * slots; `data` is the data area (in/out). Returns the result or -errno; a
   * result above 2^31 (lseek) is returned as a plain number and the channel
   * splits it.
   *
   * `data` may be a view of a SharedArrayBuffer (the channel's data area).
   * Never TextDecoder.decode it directly (browsers throw on shared memory);
   * decode copies (`decodeText`).
   */
  /**
   * The synchronous subset of `syscall`: the result when the call can finish
   * right now without waiting or I/O (ids, fstat, pipe/file I/O that needs
   * no wait), else undefined (use `syscall`). Channels try it first: the
   * reply then goes out without a trip through the microtask queue.
   * Registered handlers (registerSyscalls) always take the async path.
   */
  syscallSync(proc: Process, nr: number, args: ArrayLike<number>, data: Uint8Array): number | undefined {
    if (proc.state !== 'running' || proc.exiting) return undefined;
    proc.syscalls++; // (/proc CPU estimate: these take no time)
    const hs = this.syscallTable.get(nr);
    if (hs) for (const h of hs) if (!h.passSync?.(proc, nr, args, data, this)) return undefined;
    switch (nr) {
      case A.SYS_close: return proc.fds.closeSync(args[0]);
      case A.SYS_open:
      case A.SYS_openat: {
        const [dirfd, len, flags] = nr === A.SYS_open ? [A.AT_FDCWD, args[0], args[1]] : [args[0], args[1], args[2]];
        if (len < 0 || len > data.length) return undefined;
        const f = this.openSync(proc, A.decodeText(data.subarray(0, len)), flags, dirfd);
        if (f === undefined || typeof f === 'number') return f;
        const fd = proc.fds.alloc(f, 0, !!(flags & A.O_CLOEXEC));
        if (fd < 0 && refCount(f) === 0) f.closeSync?.();
        return fd;
      }
      case A.SYS_stat:
      case A.SYS_lstat: {
        if (args[0] < 0 || args[0] > data.length) return undefined;
        return this.statPathSyncInto(proc, A.decodeText(data.subarray(0, args[0])), nr === A.SYS_stat, A.AT_FDCWD, data);
      }
      case A.SYS_read: {
        const f = proc.fds.get(args[0]);
        return f?.tryRead?.(data.subarray(0, Math.min(args[1] >>> 0, data.length)));
      }
      case A.SYS_write: {
        const f = proc.fds.get(args[0]);
        return f?.tryWrite?.(data.subarray(0, Math.min(args[1] >>> 0, data.length)));
      }
      case A.SYS_fstat:
      case A.SYS_newfstatat: {
        if (nr === A.SYS_newfstatat && !(args[1] === 0 && args[2] & A.AT_EMPTY_PATH)) {
          if (args[1] <= 0 || args[1] > data.length) return undefined;
          return this.statPathSyncInto(proc, A.decodeText(data.subarray(0, args[1])), !(args[2] & A.AT_SYMLINK_NOFOLLOW), args[0], data);
        }
        const st = proc.fds.get(args[0])?.statSync?.();
        if (!st) return undefined;
        A.encodeStat(st, data);
        return 0;
      }
      case A.SYS_lseek: {
        const f = proc.fds.get(args[0]);
        if (!f) return undefined;
        if (!f.seek) return -A.ESPIPE;
        return f.seek((args[2] | 0) * 0x100000000 + (args[1] >>> 0), args[3]);
      }
      case A.SYS_fcntl: {
        const cmd = args[1];
        if (cmd !== A.F_GETFL && cmd !== A.F_GETFD && cmd !== A.F_SETFD) return undefined;
        const r = this.fcntl(proc, args[0], cmd, args[2]);
        return typeof r === 'number' ? r : undefined;
      }
      case A.SYS_getpid: return proc.pid;
      case A.SYS_getppid: return proc.ppid;
      case A.SYS_getuid: return proc.uid;
      case A.SYS_getgid: return proc.gid;
      case A.SYS_getpgrp: return proc.pgid;
      default: return undefined;
    }
  }

  /**
   * For a read or write that syscallSync couldn't finish: the description
   * to wait on with onReady before trying syscallSync again (pipes and
   * other files with tryRead/tryWrite), or undefined to use `syscall`.
   * Writes over PIPE_BUF can complete partially, so they take `syscall`.
   */
  readinessFile(proc: Process, nr: number, args: ArrayLike<number>): OpenFile | undefined {
    if ((nr !== A.SYS_read && nr !== A.SYS_write) || proc.state !== 'running' || proc.exiting || this.syscallTable.has(nr)) return undefined;
    const f = proc.fds.get(args[0]);
    if (!f || f.flags & A.O_NONBLOCK) return undefined;
    if (nr === A.SYS_read) return f.tryRead ? f : undefined;
    return f.tryWrite && (args[1] >>> 0) <= A.PIPE_BUF ? f : undefined;
  }

  async syscall(proc: Process, nr: number, args: ArrayLike<number>, data: Uint8Array): Promise<number> {
    // Time inside syscalls is time the process isn't computing (/proc CPU estimate)
    const t0 = Date.now();
    proc.syscalls++;
    // While in a syscall the process counts as sleeping (S in /proc/PID/stat)
    proc.inSyscall++;
    try {
      return await this.syscallImpl(proc, nr, args, data);
    } finally {
      proc.inSyscall--;
      proc.kernelMs += Date.now() - t0;
    }
  }

  private async syscallImpl(proc: Process, nr: number, args: ArrayLike<number>, data: Uint8Array): Promise<number> {
    if (proc.state === 'stopped') await proc.waitWhileStopped();
    if (proc.exiting) return -A.EINTR;
    const sig = proc.syscallSignal;
    const fds = proc.fds;
    const str = (off: number, len: number) => {
      if (len < 0 || off < 0 || off + len > data.length) throw Object.assign(new Error('EFAULT'), { errno: A.EFAULT });
      return A.decodeText(data.subarray(off, off + len));
    };
    const i64 = (lo: number, hi: number) => (hi | 0) * 0x100000000 + (lo >>> 0);
    const file = (fd: number) => fds.get(fd);
    const at = (dirfd: number, off: number, len: number) => this.resolvePath(proc, str(off, len), dirfd);
    const fs = () => {
      if (!this.fs) throw Object.assign(new Error('ENOSYS'), { errno: A.ENOSYS });
      return this.fs;
    };

    try {
      const handlers = this.syscallTable.get(nr);
      if (handlers) {
        for (const h of handlers) {
          const r = await h(proc, nr, args, data, this);
          if (r !== undefined) return r;
        }
      }
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
        case A.SYS_pread64:
        case A.SYS_pwrite64: {
          const f = file(args[0]);
          if (!f) return -A.EBADF;
          const off = i64(args[2], args[3]);
          if (off < 0) return -A.EINVAL;
          const buf = data.subarray(0, Math.min(args[1] >>> 0, data.length));
          const fn = nr === A.SYS_pread64 ? f.pread : f.pwrite;
          if (!fn) return -A.ESPIPE;
          return await fn.call(f, buf, off);
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
        case A.SYS_fstat:
        case A.SYS_newfstatat: {
          let st: A.KStat | number;
          if (nr === A.SYS_fstat || (nr === A.SYS_newfstatat && args[1] === 0 && args[2] & A.AT_EMPTY_PATH)) {
            const f = file(args[0]);
            if (!f) return -A.EBADF;
            st = await f.stat();
          } else if (nr === A.SYS_newfstatat) {
            st = await this.statPath(proc, str(0, args[1]), !(args[2] & A.AT_SYMLINK_NOFOLLOW), args[0]);
          } else {
            st = await this.statPath(proc, str(0, args[0]), nr === A.SYS_stat);
          }
          if (typeof st === 'number') return st;
          A.encodeStat(st, data);
          return 0;
        }
        case A.SYS_access:
        case A.SYS_faccessat: {
          const [dirfd, len, mode] = nr === A.SYS_access ? [A.AT_FDCWD, args[0], args[1]] : [args[0], args[1], args[2]];
          const st = await this.statPath(proc, str(0, len), true, dirfd);
          if (typeof st === 'number') return st;
          if ((mode & A.X_OK) && (st.mode & A.S_IFMT) === A.S_IFREG && !(st.mode & 0o111)) return -A.EACCES;
          return 0;
        }
        case A.SYS_poll:
          return await this.poll(proc, data, args[0], args[1]);
        case A.SYS_select:
        case A.SYS_pselect6:
          return await this.select(proc, nr, args, data);
        case A.SYS_epoll_create:
        case A.SYS_epoll_create1: {
          if (nr === A.SYS_epoll_create && args[0] <= 0) return -A.EINVAL;
          const flags = nr === A.SYS_epoll_create1 ? args[0] : 0;
          if (flags & ~A.EPOLL_CLOEXEC) return -A.EINVAL;
          return fds.alloc(new EpollFile(), 0, !!(flags & A.EPOLL_CLOEXEC));
        }
        case A.SYS_epoll_ctl: {
          const ep = file(args[0]);
          const f = file(args[2]);
          if (!ep || !f) return -A.EBADF;
          if (!(ep instanceof EpollFile)) return -A.EINVAL;
          return ep.ctl(args[1], args[2], f, args[3] | 0, args[4] | 0, args[5] | 0);
        }
        case A.SYS_epoll_wait:
        case A.SYS_epoll_pwait: {
          const ep = file(args[0]);
          if (!ep) return -A.EBADF;
          if (!(ep instanceof EpollFile)) return -A.EINVAL;
          return await this.withMask(proc, nr === A.SYS_epoll_pwait && args[3] ? A.sigsetFromWords(args[4], args[5]) : null,
            () => ep.wait(data, args[1], args[2], proc.syscallSignal));
        }
        case A.SYS_lseek: {
          const f = file(args[0]);
          if (!f) return -A.EBADF;
          if (!f.seek) return -A.ESPIPE;
          return f.seek(i64(args[1], args[2]), args[3]);
        }
        case A.SYS_ioctl: {
          const f = file(args[0]);
          if (!f) return -A.EBADF;
          const req = args[1] >>> 0;
          const arg = data.subarray(0, Math.min(args[2] >>> 0, data.length));
          if (req === A.FIOCLEX || req === A.FIONCLEX) return fds.setCloexec(args[0], req === A.FIOCLEX);
          if (req === A.FIONBIO && arg.length >= 4) {
            // O_NONBLOCK is the open file's flag, so this works on any fd. A
            // file's own ioctl may also look at it (sockets), but one that
            // doesn't know it (/dev/null, pipes, files) mustn't fail it:
            // libuv sets every fd non-blocking this way (cmake's spawns).
            const on = new DataView(arg.buffer, arg.byteOffset, 4).getInt32(0, true) !== 0;
            f.flags = on ? f.flags | A.O_NONBLOCK : f.flags & ~A.O_NONBLOCK;
            if (!f.ioctl) return 0;
            const r = await f.ioctl(req, arg, sig);
            return r === -A.ENOTTY ? 0 : r;
          }
          if (!f.ioctl) return -A.ENOTTY;
          return await f.ioctl(req, arg, sig);
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
        case A.SYS_sched_yield:
          await new Promise(r => setTimeout(r, 0));
          return 0;
        case A.SYS_getrandom: {
          const n = Math.min(args[0] >>> 0, data.length);
          return await new DevRandom().read(data.subarray(0, n));
        }
        case A.SYS_geteuid: return proc.uid;
        case A.SYS_getegid: return proc.gid;
        case A.SYS_eventfd:
        case A.SYS_eventfd2: {
          const flags = nr === A.SYS_eventfd2 ? args[1] : 0;
          if (flags & ~(A.O_NONBLOCK | A.O_CLOEXEC | A.EFD_SEMAPHORE)) return -A.EINVAL;
          return fds.alloc(new EventFile(args[0], A.O_RDWR | (flags & A.O_NONBLOCK), !!(flags & A.EFD_SEMAPHORE)), 0, !!(flags & A.O_CLOEXEC));
        }
        case A.SYS_close_range: {
          const first = args[0] >>> 0;
          const last = Math.min(args[1] >>> 0, A.OPEN_MAX - 1);
          if (first > (args[1] >>> 0)) return -A.EINVAL;
          for (const [fd] of fds.entries()) {
            if (fd < first || fd > last) continue;
            if (args[2] & 4 /* CLOSE_RANGE_CLOEXEC */) fds.setCloexec(fd, true);
            else await fds.close(fd);
          }
          return 0;
        }
        case A.SYS_shiro_vfork:
          return this.vfork(proc).pid;
        case A.SYS_shiro_execve:
          return await this.sysExecve(proc, JSON.parse(str(0, args[0])), data);
        case A.SYS_getpid: return proc.pid;
        case A.SYS_gettid: return proc.pid;
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
        case A.SYS_tkill:
        case A.SYS_tgkill: {
          // Threads share their process's pid as tgid; a signal to any tid of ours goes to the process
          const [tgid, tid, s] = nr === A.SYS_tkill ? [args[0], args[0], args[1]] : [args[0], args[1], args[2]];
          const target = this.processOfTid(tid);
          if (!target || (nr === A.SYS_tgkill && target.pid !== tgid)) return -A.ESRCH;
          return this.kill(target.pid, s, proc);
        }
        case A.SYS_rt_sigaction:
          return this.sigaction(proc, args[0], args[1] !== 0, args[2] !== 0, data);
        case A.SYS_rt_sigprocmask: {
          const old = A.sigsetToWords(proc.sigmask);
          if (args[1]) {
            const dv = new DataView(data.buffer, data.byteOffset, 8);
            const set = A.sigsetFromWords(dv.getUint32(0, true), dv.getUint32(4, true));
            const next = new Set(proc.sigmask);
            if (args[0] === A.SIG_BLOCK) set.forEach(s => next.add(s));
            else if (args[0] === A.SIG_UNBLOCK) set.forEach(s => next.delete(s));
            else if (args[0] === A.SIG_SETMASK) { next.clear(); set.forEach(s => next.add(s)); }
            else return -A.EINVAL;
            this.setSigmask(proc, next);
          }
          if (args[2]) {
            const dv = new DataView(data.buffer, data.byteOffset + 8, 8);
            dv.setUint32(0, old[0], true);
            dv.setUint32(4, old[1], true);
          }
          return 0;
        }
        case A.SYS_rt_sigreturn: {
          const saved = proc.signalFrames.pop();
          if (saved) this.setSigmask(proc, saved);
          return 0;
        }
        case A.SYS_rt_sigpending: {
          const [lo, hi] = A.sigsetToWords([...proc.deferredSignals, ...proc.pendingSignals]);
          const dv = new DataView(data.buffer, data.byteOffset, 8);
          dv.setUint32(0, lo, true);
          dv.setUint32(4, hi, true);
          return 0;
        }
        case A.SYS_rt_sigsuspend: {
          const dv = new DataView(data.buffer, data.byteOffset, 8);
          const tmp = A.sigsetFromWords(dv.getUint32(0, true), dv.getUint32(4, true));
          const saved = new Set(proc.sigmask);
          // The handler's frame restores the caller's mask, as on Linux
          const wake = new Promise<void>(resolve => {
            if (sig.aborted) resolve();
            else sig.addEventListener('abort', () => resolve(), { once: true });
          });
          this.setSigmask(proc, tmp);
          await wake;
          if (proc.signalFrames.length) proc.signalFrames[proc.signalFrames.length - 1] = saved;
          else this.setSigmask(proc, saved);
          return -A.EINTR;
        }
        case A.SYS_sigaltstack: {
          const dv = new DataView(data.buffer, data.byteOffset, A.STACK_T_SIZE * 2);
          const old = { ...proc.altStack };
          if (args[0]) {
            const flags = dv.getInt32(8, true);
            if (flags & ~A.SS_DISABLE) return -A.EINVAL;
            proc.altStack = { sp: i64(dv.getUint32(0, true), dv.getUint32(4, true)), flags, size: i64(dv.getUint32(16, true), dv.getUint32(20, true)) };
          }
          if (args[1]) {
            const o = A.STACK_T_SIZE;
            dv.setUint32(o, old.sp >>> 0, true);
            dv.setUint32(o + 4, Math.floor(old.sp / 0x100000000), true);
            dv.setInt32(o + 8, old.flags, true);
            dv.setInt32(o + 12, 0, true);
            dv.setUint32(o + 16, old.size >>> 0, true);
            dv.setUint32(o + 20, Math.floor(old.size / 0x100000000), true);
          }
          return 0;
        }
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
        case A.SYS_truncate: {
          const f = await this.open(proc, str(0, args[0]), A.O_WRONLY);
          if (typeof f === 'number') return f;
          try { return f.truncate ? await f.truncate(i64(args[1], args[2])) : -A.EINVAL; }
          finally { await f.close(); }
        }
        case A.SYS_getcwd: {
          const b = enc.encode(proc.cwd + '\0');
          const cap = Math.min(args[0] >>> 0 || data.length, data.length);
          if (b.length > cap) return -A.ERANGE;
          data.set(b);
          return b.length;
        }
        case A.SYS_chdir:
        case A.SYS_fchdir: {
          let p: string | number;
          if (nr === A.SYS_fchdir) {
            const f = file(args[0]);
            if (!f) return -A.EBADF;
            if (f.kind !== 'dir' || !f.path) return -A.ENOTDIR;
            p = f.path;
          } else {
            p = this.resolvePath(proc, str(0, args[0]));
          }
          if (typeof p === 'number') return p;
          const st = await this.statPath(proc, p);
          if (typeof st === 'number') return st;
          if ((st.mode & A.S_IFMT) !== A.S_IFDIR) return -A.ENOTDIR;
          proc.cwd = p;
          proc.env.PWD = p;
          return 0;
        }
        case A.SYS_rename:
        case A.SYS_renameat:
        case A.SYS_renameat2: {
          const [od, ol, nd, nl, flags] = nr === A.SYS_rename
            ? [A.AT_FDCWD, args[0], A.AT_FDCWD, args[1], 0]
            : [args[0], args[1], args[2], args[3], nr === A.SYS_renameat2 ? args[4] : 0];
          const from = at(od, 0, ol);
          const to = at(nd, ol, nl);
          if (typeof from === 'number') return from;
          if (typeof to === 'number') return to;
          if (flags & ~A.RENAME_NOREPLACE) return -A.EINVAL;
          if ((flags & A.RENAME_NOREPLACE) && (await fs().exists(to))) return -A.EEXIST;
          if (!(await fs().exists(from))) return -A.ENOENT;
          // Open files follow the rename (their buffered data must not land at the old path)
          const moved = await renameInodes(fs(), from, to);
          await fs().rename(from, to);
          moved();
          shareInodeNumber(from, to);
          forgetInodeNumber(from);
          if (this.socketPaths?.delete(from)) this.socketPaths.add(to);
          return 0;
        }
        case A.SYS_mkdir:
        case A.SYS_mkdirat: {
          const [dirfd, len, mode] = nr === A.SYS_mkdir ? [A.AT_FDCWD, args[0], args[1]] : [args[0], args[1], args[2]];
          const p = at(dirfd, 0, len);
          if (typeof p === 'number') return p;
          if (await fs().exists(p)) return -A.EEXIST;
          await fs().mkdir(p);
          await fs().chmod(p, mode & ~proc.umask & 0o7777).catch(() => {});
          return 0;
        }
        case A.SYS_rmdir:
        case A.SYS_unlink:
        case A.SYS_unlinkat: {
          const [dirfd, len, rmdir] = nr === A.SYS_unlinkat
            ? [args[0], args[1], !!(args[2] & A.AT_REMOVEDIR)]
            : [A.AT_FDCWD, args[0], nr === A.SYS_rmdir];
          const p = at(dirfd, 0, len);
          if (typeof p === 'number') return p;
          const st = await this.statPath(proc, p, false);
          if (typeof st === 'number') return st;
          const isDir = (st.mode & A.S_IFMT) === A.S_IFDIR;
          if (!rmdir && isDir) return -A.EISDIR;
          if (rmdir && !isDir) return -A.ENOTDIR;
          if (isDir) await fs().rmdir(p);
          else { await unlinkInode(fs(), p); await fs().unlink(p); forgetInodeNumber(p); this.socketPaths?.delete(p); }
          return 0;
        }
        case A.SYS_symlink:
        case A.SYS_symlinkat: {
          const [tl, dirfd, ll] = nr === A.SYS_symlink ? [args[0], A.AT_FDCWD, args[1]] : [args[0], args[1], args[2]];
          const target = str(0, tl);
          const p = at(dirfd, tl, ll);
          if (typeof p === 'number') return p;
          if (await fs().exists(p)) return -A.EEXIST;
          await fs().symlink(target, p);
          return 0;
        }
        case A.SYS_link:
        case A.SYS_linkat: {
          // The filesystem has no hard links (no inodes shared between names).
          // EPERM, as Linux filesystems without them answer: programs fall back
          // to copying (git clone of a local repo, cp -l), whereas a copy that
          // claimed to be a link broke git's "same inode" check.
          const [od, ol, nd, nl] = nr === A.SYS_link ? [A.AT_FDCWD, args[0], A.AT_FDCWD, args[1]] : [args[0], args[1], args[2], args[3]];
          const from = at(od, 0, ol);
          const to = at(nd, ol, nl);
          if (typeof from === 'number') return from;
          if (typeof to === 'number') return to;
          const st = await this.statPath(proc, from, false);
          if (typeof st === 'number') return st;
          if (await fs().exists(to)) return -A.EEXIST;
          return -A.EPERM;
        }
        case A.SYS_readlink:
        case A.SYS_readlinkat: {
          const [dirfd, len, bufsiz] = nr === A.SYS_readlink ? [A.AT_FDCWD, args[0], args[1]] : [args[0], args[1], args[2]];
          const p = at(dirfd, 0, len);
          if (typeof p === 'number') return p;
          let target: string;
          const proct = p.startsWith('/proc/') ? this.procfs.readlink(proc, p) : undefined;
          if (typeof proct === 'number') return proct;
          if (proct !== undefined) target = proct;
          else if (this.isDevicePath(p)) return -A.EINVAL; // a device node or /dev, /dev/pts: not links
          else try { target = await fs().readlink(p); } catch (e) { return A.errnoFromError(e, A.EINVAL); }
          const b = enc.encode(target);
          const n = Math.min(b.length, bufsiz >>> 0 || data.length, data.length);
          data.set(b.subarray(0, n));
          return n;
        }
        case A.SYS_chmod:
        case A.SYS_fchmod:
        case A.SYS_fchmodat: {
          let p: string | number;
          let mode: number;
          if (nr === A.SYS_fchmod) {
            const f = file(args[0]);
            if (!f) return -A.EBADF;
            if (!f.path || (f.kind !== 'file' && f.kind !== 'dir')) return -A.EINVAL;
            p = f.path;
            mode = args[1];
          } else if (nr === A.SYS_chmod) { p = at(A.AT_FDCWD, 0, args[0]); mode = args[1]; }
          else { p = at(args[0], 0, args[1]); mode = args[2]; }
          if (typeof p === 'number') return p;
          const real = await fs().realpath(p);
          await flushInode(fs(), real);
          await fs().chmod(real, mode & 0o7777);
          return 0;
        }
        case A.SYS_utimensat: {
          // args: dirfd, pathLen (0 with AT_EMPTY_PATH = the fd), flags, hasTimes; data: path, then 2 timespecs (32 bytes) at offset pathLen
          let p: string | number;
          if (args[1] === 0) {
            const f = file(args[0]);
            if (!f) return -A.EBADF;
            if (!f.path) return -A.EINVAL;
            p = f.path;
          } else p = at(args[0], 0, args[1]);
          if (typeof p === 'number') return p;
          const st = await this.statPath(proc, p, !(args[2] & A.AT_SYMLINK_NOFOLLOW));
          if (typeof st === 'number') return st;
          const now = Date.now();
          let atime = now, mtime = now;
          if (args[3]) {
            const dv = new DataView(data.buffer, data.byteOffset + args[1], 32);
            const ts = (o: number, cur: number) => {
              const nsec = dv.getUint32(o + 8, true);
              if (nsec === A.UTIME_NOW) return now;
              if (nsec === A.UTIME_OMIT) return cur;
              return i64(dv.getUint32(o, true), dv.getUint32(o + 4, true)) * 1000 + Math.floor(nsec / 1e6);
            };
            atime = ts(0, st.atimeMs);
            mtime = ts(16, st.mtimeMs);
          }
          const real = await fs().realpath(p);
          await flushInode(fs(), real);
          await fs().utimes(real, atime, mtime);
          return 0;
        }
        case A.SYS_umask: {
          const old = proc.umask;
          proc.umask = args[0] & 0o777;
          return old;
        }
        case A.SYS_clock_gettime: { // clockid → struct timespec; the clocks that count from boot
          const id = args[0];
          let ms: number;
          if (id === 0 || id === 5) ms = Date.now(); // REALTIME(_COARSE)
          else if (id === 1 || id === 4 || id === 6 || id === 7) ms = Date.now() - bootMs; // MONOTONIC*, BOOTTIME
          else return -A.EINVAL;
          const dv = new DataView(data.buffer, data.byteOffset, 16);
          dv.setBigInt64(0, BigInt(Math.floor(ms / 1000)), true);
          dv.setBigInt64(8, BigInt(Math.floor((ms % 1000) * 1e6)), true);
          return 0;
        }
        case A.SYS_uname: { // → struct utsname (engines that report their own machine take the names from here)
          if (data.length < A.UTSNAME_FIELD * 6) return -A.EFAULT;
          const fields = ['Linux', this.hostname, '6.1.0-shiro', '#1 Shiro', 'wasm32', '(none)'];
          data.fill(0, 0, A.UTSNAME_FIELD * 6);
          fields.forEach((f, i) => data.set(enc.encode(f).subarray(0, A.UTSNAME_FIELD - 1), i * A.UTSNAME_FIELD));
          return 0;
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

  /** rt_sigaction: new action (struct kernel_sigaction, 32 bytes) at data[0], old one written to data[32]. */
  private sigaction(proc: Process, signum: number, hasNew: boolean, hasOld: boolean, data: Uint8Array): number {
    if (signum < 1 || signum >= A.NSIG) return -A.EINVAL;
    const dv = new DataView(data.buffer, data.byteOffset, A.SIGACTION_SIZE * 2);
    const d = proc.dispositions.get(signum) ?? 'default';
    const extra = proc.sigactions.get(signum);
    const oldHandler = d === 'default' ? A.SIG_DFL : d === 'ignore' ? A.SIG_IGN : d;
    const oldMask = A.sigsetToWords(extra?.mask ?? []);
    if (hasNew) {
      if (signum === A.SIGKILL || signum === A.SIGSTOP) return -A.EINVAL;
      const handler = dv.getUint32(0, true) + dv.getUint32(4, true) * 0x100000000;
      const flags = dv.getUint32(8, true);
      const restorer = dv.getUint32(16, true) + dv.getUint32(20, true) * 0x100000000;
      const mask = A.sigsetFromWords(dv.getUint32(24, true), dv.getUint32(28, true));
      if (handler === A.SIG_DFL) proc.dispositions.delete(signum);
      else proc.dispositions.set(signum, handler === A.SIG_IGN ? 'ignore' : handler);
      if (flags || mask.size || restorer) proc.sigactions.set(signum, { flags, mask, restorer });
      else proc.sigactions.delete(signum);
      // Ignoring a signal discards it if pending
      const now = proc.dispositions.get(signum);
      if (now === 'ignore' || (now === undefined && A.defaultSignalAction(signum) === 'ignore')) {
        proc.deferredSignals.delete(signum);
        proc.pendingSignals.delete(signum);
      }
    }
    if (hasOld) {
      const o = A.SIGACTION_SIZE;
      dv.setUint32(o, oldHandler >>> 0, true);
      dv.setUint32(o + 4, Math.floor(oldHandler / 0x100000000), true);
      dv.setUint32(o + 8, (extra?.flags ?? 0) >>> 0, true);
      dv.setUint32(o + 12, 0, true);
      dv.setUint32(o + 16, (extra?.restorer ?? 0) >>> 0, true);
      dv.setUint32(o + 20, Math.floor((extra?.restorer ?? 0) / 0x100000000), true);
      dv.setUint32(o + 24, oldMask[0], true);
      dv.setUint32(o + 28, oldMask[1], true);
    }
    return 0;
  }

  /** Run `fn` with `mask` as the signal mask (pselect/epoll_pwait/ppoll), restoring the old mask after. */
  private async withMask<T>(proc: Process, mask: Set<number> | null, fn: () => Promise<T>): Promise<T> {
    if (!mask) return fn();
    const saved = new Set(proc.sigmask);
    this.setSigmask(proc, mask);
    try { return await fn(); }
    finally {
      if (proc.signalFrames.length) proc.signalFrames[proc.signalFrames.length - 1] = saved;
      else this.setSigmask(proc, saved);
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
    const files: OpenFile[] = [];
    for (let i = 0; i < nfds; i++) {
      const f = proc.fds.get(dv.getInt32(i * 8, true));
      if (f) files.push(f);
    }
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
    return waitReady(files, scan, timeoutMs, proc.syscallSignal);
  }

  /**
   * select / pselect6. args: nfds, which sets are present (1 read, 2 write,
   * 4 except), then the timeout: select tvSec, tvUsec; pselect6 tvSec,
   * tvNsec (tvSec -1 = no timeout); pselect6 also args[4..5] sigmask lo/hi
   * and args[6] = 1 if a mask is given. Data: the three fd_set bitmaps back
   * to back, each ceil(nfds/64)*8 bytes (laid out even when absent).
   */
  private async select(proc: Process, nr: number, args: ArrayLike<number>, data: Uint8Array): Promise<number> {
    const nfds = args[0];
    if (nfds < 0 || nfds > A.OPEN_MAX) return -A.EINVAL;
    const setBytes = Math.ceil(nfds / 64) * 8;
    if (setBytes * 3 > data.length) return -A.EINVAL;
    const present = args[1];
    const tvSec = args[2];
    const timeoutMs = tvSec < 0 ? -1 : tvSec * 1000 + Math.floor(nr === A.SYS_pselect6 ? args[3] / 1e6 : args[3] / 1000);
    const bit = (set: number, fd: number) => (data[set * setBytes + (fd >> 3)] >> (fd & 7)) & 1;
    const want: { fd: number; r: boolean; w: boolean; x: boolean; file: OpenFile }[] = [];
    for (let fd = 0; fd < nfds; fd++) {
      const r = !!(present & 1) && !!bit(0, fd);
      const w = !!(present & 2) && !!bit(1, fd);
      const x = !!(present & 4) && !!bit(2, fd);
      if (!r && !w && !x) continue;
      const file = proc.fds.get(fd);
      if (!file) return -A.EBADF;
      want.push({ fd, r, w, x, file });
    }
    const results = new Uint8Array(setBytes * 3);
    const scan = () => {
      results.fill(0);
      let n = 0;
      for (const q of want) {
        const rev = q.file.poll(A.POLLIN | A.POLLOUT | A.POLLPRI);
        const mark = (set: number) => { results[set * setBytes + (q.fd >> 3)] |= 1 << (q.fd & 7); n++; };
        if (q.r && rev & (A.POLLIN | A.POLLHUP | A.POLLERR)) mark(0);
        if (q.w && rev & (A.POLLOUT | A.POLLERR)) mark(1);
        if (q.x && rev & A.POLLPRI) mark(2);
      }
      return n;
    };
    const mask = nr === A.SYS_pselect6 && args[6] ? A.sigsetFromWords(args[4], args[5]) : null;
    const n = await this.withMask(proc, mask, () => waitReady(want.map(q => q.file), scan, timeoutMs, proc.syscallSignal));
    if (n < 0) return n;
    for (let set = 0; set < 3; set++) if (present & (1 << set)) data.set(results.subarray(set * setBytes, (set + 1) * setBytes), set * setBytes);
    return n;
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
      // The entry's node is usually in memory (the directory was just listed): no await per entry
      const hit = this.devices.has(full) ? undefined : this.fs?.lookupCached(full, false);
      if (hit) {
        type = hit.node.type === 'dir' ? A.DT_DIR : hit.node.type === 'symlink' ? A.DT_LNK : A.DT_REG;
      } else if (hit === undefined) {
        const st = await this.statPath(proc, full, false);
        if (typeof st !== 'number') {
          const t = st.mode & A.S_IFMT;
          type = t === A.S_IFDIR ? A.DT_DIR : t === A.S_IFLNK ? A.DT_LNK : t === A.S_IFREG ? A.DT_REG : t === A.S_IFCHR ? A.DT_CHR : A.DT_UNKNOWN;
        }
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

  /**
   * The child of SYS_shiro_vfork: a copy of `parent` (fd table, cwd, env,
   * signal dispositions and mask) with nothing running in it yet. Its
   * program starts at SYS_shiro_execve; until then the parent's engine makes
   * syscalls on its behalf.
   */
  vfork(parent: Process): Process {
    const pid = this.allocPid();
    const child = new Process({
      pid, ppid: parent.pid, pgid: parent.pgid, sid: parent.sid,
      path: parent.path, argv: [...parent.argv], env: { ...parent.env }, cwd: parent.cwd,
      fds: parent.fds.fork(), umask: parent.umask,
    });
    child.ctty = parent.ctty;
    child.uid = parent.uid;
    child.gid = parent.gid;
    child.data.embryo = true;
    this.procs.set(pid, child);
    for (const h of [...this.spawnHooks]) {
      try { h(child); } catch (e) { console.warn('[kernel] onSpawn hook failed', e); }
    }
    for (const [sig, d] of parent.dispositions) child.dispositions.set(sig, d);
    for (const [sig, a] of parent.sigactions) child.sigactions.set(sig, { ...a, mask: new Set(a.mask) });
    for (const sig of parent.sigmask) child.sigmask.add(sig);
    this.notify();
    return child;
  }

  /**
   * Starts `run` in a child made by vfork() that has nothing running yet:
   * a real fork, whose engine copied the parent's memory into the child
   * (Blink patch 0014).
   */
  startEmbryo(proc: Process, run: Runner): void {
    if (!proc.data.embryo || proc.exiting) return;
    delete proc.data.embryo;
    void this.start(proc, run);
  }

  /** SYS_shiro_execve (see abi.ts). */
  private async sysExecve(proc: Process, req: { path: string; argv?: string[]; env?: string[]; inproc?: boolean }, data: Uint8Array): Promise<number> {
    if (!req || typeof req.path !== 'string' || !req.path) return -A.ENOENT;
    const path = this.resolvePath(proc, req.path);
    if (typeof path === 'number') return path;
    const st = await this.statPath(proc, path);
    // A Shiro command under /bin, /usr/bin, ... (sh, env, ls) has no file but runs
    // A Shiro command with no file anywhere runs as /bin/NAME and /usr/bin/NAME.
    // (Not /usr/local/bin/NAME: execvp tries that first and must move on to
    // a real /usr/bin/NAME a package installed.)
    const base = path.slice(path.lastIndexOf('/') + 1);
    const builtin = st === -A.ENOENT && /^\/(usr\/)?s?bin\/[^/]+$/.test(path) &&
      (!!this.shell?.commands.get(base) || SHELL_PROGRAMS.has(base)) &&
      typeof (await this.statPath(proc, `/bin/${base}`)) === 'number' &&
      typeof (await this.statPath(proc, `/usr/bin/${base}`)) === 'number';
    if (typeof st === 'number' && !builtin) return st;
    if (typeof st !== 'number' && (st.mode & A.S_IFMT) !== A.S_IFREG) return -A.EACCES;
    const argv = Array.isArray(req.argv) ? req.argv.map(String) : [req.path];
    const env: Record<string, string> = {};
    for (const kv of Array.isArray(req.env) ? req.env : []) {
      const i = String(kv).indexOf('=');
      if (i > 0) env[String(kv).slice(0, i)] = String(kv).slice(i + 1);
    }
    let head: Uint8Array = new Uint8Array(0);
    if (!builtin) try {
      const raw = await this.fs!.readFile(path);
      head = typeof raw === 'string' ? enc.encode(raw.slice(0, 4)) : raw.subarray(0, 4);
    } catch { /* unreadable: let the loaders decide */ }
    const isElf = head.length === 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;
    const probe = new Process({ pid: -1, ppid: proc.pid, path, argv, env, cwd: proc.cwd });
    const embryo = !!proc.data.embryo;
    // A package command with its own arguments (zcat = gzip -dc) can't be
    // reloaded in place with the caller's argv: start it like any program
    const inproc = isElf && !!req.inproc && !(this.fs && (await packageArgsForPath(this.fs, path)));
    const runner = embryo || !inproc ? await this.findProgram(path, probe) : null;
    if ((embryo || !inproc) && !runner) return -A.ENOEXEC;
    // The point of no return: exec bookkeeping, as Linux does it
    await proc.fds.closeOnExec();
    proc.path = path;
    proc.argv = argv;
    proc.env = env;
    for (const [sig, d] of [...proc.dispositions]) {
      if (typeof d === 'number') { proc.dispositions.delete(sig); proc.sigactions.delete(sig); }
    }
    proc.pendingSignals.clear();
    proc.signalFrames = [];
    this.notify();
    if (embryo) {
      this.startEmbryo(proc, runner!);
      return 0;
    }
    if (inproc) {
      const b = enc.encode(path);
      if (b.length > data.length) return -A.ENAMETOOLONG;
      data.set(b);
      return b.length;
    }
    proc.data.execRunner = runner;
    proc.stopRunner();
    // The caller's image is gone: never reply. (A reply raced the engine's
    // termination, and Blink then tried to load "" and returned ENOEXEC, so
    // perl's exec of a #! script fell back to /bin/sh and failed the same way.)
    return new Promise<number>(() => {});
  }

  /**
   * SYS_spawn: posix_spawn from a guest. Without `fds` the child inherits
   * every non-cloexec fd; with `fds` ([child, parent] pairs) only those,
   * unless `inherit: true`, which installs them on top of the inherited set.
   */
  private async sysSpawn(proc: Process, req: {
    path: string; argv?: string[]; env?: Record<string, string>; cwd?: string;
    fds?: [number, number][]; inherit?: boolean; pgid?: number; setsid?: boolean; sigdefault?: number[];
  }): Promise<number> {
    if (!req || typeof req.path !== 'string') return -A.EINVAL;
    let map: Record<number, OpenFile> | undefined;
    if (req.fds) {
      map = {};
      for (const [child, parent] of req.fds) {
        const f = proc.fds.get(parent);
        if (!f) return -A.EBADF;
        map[child] = f;
      }
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
      path: req.path, argv: req.argv, env: req.env ?? proc.env, cwd, fds: map, inheritFds: req.inherit,
      parent: proc, pgid: req.pgid, setsid: req.setsid, run: runner,
      inheritSignals: true, sigdefault: Array.isArray(req.sigdefault) ? req.sigdefault : undefined,
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

const SHELL_NAMES = new Set(['sh', 'bash', 'dash']);

/** The words of a shell command that needs no shell: plain words and quoted
 *  strings without expansions, redirections or operators (`exec` dropped). */
export function simpleCommandWords(script: string): string[] | null {
  const words: string[] = [];
  let i = 0;
  const s = script.trim();
  if (/[\n;&|<>()$`\\*?[\]{}~#!]/.test(s)) return null;
  while (i < s.length) {
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (i >= s.length) break;
    let w = '';
    while (i < s.length && s[i] !== ' ' && s[i] !== '\t') {
      const c = s[i];
      if (c === "'" || c === '"') {
        const end = s.indexOf(c, i + 1);
        if (end < 0) return null;
        w += s.slice(i + 1, end);
        i = end + 1;
      } else { w += c; i++; }
    }
    words.push(w);
  }
  if (words[0] === 'exec') words.shift();
  return words;
}

