/**
 * The kernel: process table, program loaders, path-based file opening and
 * the syscall dispatcher every transport (SAB channel, JSPI, in-page) uses.
 *
 * Processes get pids from the same counter as src/process-table.ts, and the
 * kernel registers itself as a source there, so `ps`, `kill`, `pgrep` and
 * `top` see kernel processes.
 */

import { decodeBytes, encodeText } from '../utils/byte-text';
import { addProcInfoSource, type FileSystem } from '../filesystem';
import type { Shell } from '../shell';
import type { Command, CommandContext } from '../commands/index';
import { KernelStdio, execLazyStdin } from '../shell-stdio';
import { parseShellArgs } from '../shell-args';
import { ProcFs, bootMs, fdTarget, syscallText, wchanText } from './procfs';
import { klog, KmsgFile, LOG_ERR, LOG_INFO, SYSLOG_ACTION_READ_ALL, SYSLOG_ACTION_SIZE_BUFFER, SYSLOG_ACTION_SIZE_UNREAD } from './klog';
import { processTable, type ShiroProcess } from '../process-table';
import { packageShadows, pkgOwnShadows, packageArgsForPath, PKG_BIN_DIR } from '../pkg-manager';
import * as A from './abi';
import { elfInterpreter } from '../elf-interp';
import {
  type OpenFile, FdTable, BufferFile, DevNull, DevZero, DevRandom, DevFull,
  RegularFile, DirFile, abortableWait, openInode, openInodeSync, isInodeOpen, inodeNumber, canWrite, refCount, renameInodes, unlinkInode, setInodeTimes, setInodeMode, flushInode, inodeStat, hasOpenInodes,
  shareInodeNumber, forgetInodeNumber, renameLinkName, linkCount, writeBackAll, attachInodeShared, detachOpenFileShared, unlinkedFileKey, sharedBufferOf,
} from './fd';
import { createPipe, Pipe, PipeEnd, FifoRdWr } from './pipe';
import type { PtyFile } from './pty';
import { LockTable, F_RDLCK, F_WRLCK, F_UNLCK } from './locks';
import { Process } from './process';
import { SysvShm } from './sysvshm';
import { SysvSem } from './sysvsem';
import { SysvMsg } from './sysvmsg';
import { MessageQueues, MqFile } from './mqueue';
import { PosixTimers } from './posixtimers';
import { CONTROL_BYTES, SharedObjects, isShareablePath, type ShmObjMessage } from './shmobj';
import { EpollFile, waitReady } from './epoll';
import { SignalFile, notifySignalPending, pendingSignalListeners } from './signalfd';
import { EventFile, MemFile, TimerFile, writeInodeBytes } from './fd';
import { activeProfile, unameRelease, UNAME_VERSION } from '../profile';
import { memoryInfo } from '../utils/sysinfo';

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
  /** User id of the child (`sudo`: 0). Default: the parent's. */
  uid?: number;
}

export interface WaitResult {
  /** Pid of the reported child, 0 for WNOHANG with nothing to report, or -errno. */
  pid: number;
  /** Linux wait status. */
  status: number;
  /** CPU ms of a reaped child and of the children it reaped (its rusage) */
  cpuMs?: number;
}

const enc = new TextEncoder();

/** Shell builtins that Unix systems also have as programs in /bin and /usr/bin. */
const SHELL_PROGRAMS = new Set(['echo', 'printf', 'test', '[', 'true', 'false', 'pwd', 'kill']);

function normalize(path: string): string {
  // Already normal (absolute, no empty, . or .. segments, no trailing slash): most paths
  if (path.charCodeAt(0) === 47 && !/\/\/|\/\.\.?(?:\/|$)|.\/$/.test(path)) return path;
  const stack: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return '/' + stack.join('/');
}

/** A path whose last component is followed by '/': it must name a directory (path_resolution(7)). */
function trailingSlash(path: string): boolean {
  return path.length > 1 && path.endsWith('/') && !/^\/+$/.test(path);
}

const fileKeys = new WeakMap<object, number>();
let nextFileKey = 1;
/** A stable id for an open file description without a path (record locks on pipes, sockets) */
function fileKey(f: object): number {
  let k = fileKeys.get(f);
  if (!k) { k = nextFileKey++; fileKeys.set(f, k); }
  return k;
}

/** Syscalls an O_PATH fd fails with EBADF, by the argument holding the fd */
const OPATH_FD_ARG: Record<number, number> = {
  0: 0, 1: 0, 16: 0, 17: 0, 18: 0, 19: 0, 20: 0, 74: 0, 75: 0, 77: 0, 91: 0, 93: 0, // read write ioctl pread pwrite readv writev fsync fdatasync ftruncate fchmod fchown
  190: 0, 193: 0, 196: 0, 199: 0, 217: 0, 285: 0, 233: 2, // f*xattr getdents64 fallocate epoll_ctl
  42: 0, 43: 0, 44: 0, 45: 0, 46: 0, 47: 0, 48: 0, 49: 0, 50: 0, 51: 0, 52: 0, 54: 0, 55: 0, 288: 0, // the socket calls
};

/** An O_PATH description over `f`: same file and stat, no I/O */
function pathOnlyFile(f: OpenFile): OpenFile {
  const ebadf = () => -A.EBADF;
  return new Proxy(f, {
    get(t, k) {
      if (k === 'flags') return (t.flags & ~3) | A.O_PATH;
      if (k === 'read' || k === 'write' || k === 'pread' || k === 'pwrite' || k === 'ioctl') return async () => -A.EBADF;
      if (k === 'tryRead' || k === 'tryWrite') return ebadf;
      const v = Reflect.get(t, k, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
    set(t, k, v) { return Reflect.set(t, k, v, t); },
  });
}

/** Single-quote a word for the shell. */
function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * A stat as `proc` sees it. Files keep no owner (chown isn't stored), so one
 * reported as the default user's is the caller's: root's git and ssh find
 * their own files theirs.
 */
/** Where a process keeps each interval timer (ITIMER_REAL, ITIMER_VIRTUAL, ITIMER_PROF) */
const ITIMER_KEYS = ['realTimer', 'virtualTimer', 'profTimer'];

function statFor(proc: Process, st: A.KStat): A.KStat {
  return st.uid === 1000 && proc.uid !== 1000 ? { ...st, uid: proc.uid, gid: proc.gid } : st;
}

/**
 * open(2)'s permission check on an existing file, which is the caller's own
 * (see statFor): its owner bits must allow the access mode, unless the
 * caller is root (Open POSIX shm_open_32-1, 34-1: a 0 or 0400 file reopened
 * O_RDWR is EACCES).
 */
function ownerDenies(proc: Process, mode: number | undefined, flags: number): boolean {
  if (proc.uid === 0 || mode === undefined) return false;
  const acc = flags & A.O_ACCMODE;
  const need = (acc === A.O_WRONLY ? 0 : 4) | (acc === A.O_RDONLY && !(flags & A.O_TRUNC) ? 0 : 2);
  return ((mode >> 6) & need) !== need;
}

export class Kernel {
  fs?: FileSystem;
  /** Paths of AF_UNIX socket files (net.ts bind); they stat as sockets. */
  socketPaths?: Set<string>;
  /** The page's shell: builtins run in forks of it. */
  shell?: Shell;
  /** uname(2) nodename (the prompt's \h). */
  hostname = activeProfile().hostname;
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
  /** System V shared memory segments (the engine maps them). */
  readonly shm = new SysvShm();
  /** SysV semaphore sets (semget, semop, semctl) */
  readonly sem = new SysvSem();
  /** SysV message queues (msgget, msgsnd, msgrcv, msgctl) */
  readonly msg = new SysvMsg();
  /** POSIX message queues (mq_open, mq_timedsend, ...) */
  readonly mq = new MessageQueues((pid, sig, info) => { const p = this.procs.get(pid); if (p) this.deliver(p, sig, info); });
  /** POSIX timers (timer_create, timer_settime, ...) */
  readonly timers = new PosixTimers((proc, sig, info) => this.deliver(proc, sig, info), bootMs);
  /** Engine instances (a Blink worker each) and how to post to them: shared objects' messages */
  private engineInstances = new Map<number, (msg: ShmObjMessage) => void>();
  private nextEngineInstance = 1;
  /** Shared objects across engine instances (/dev/shm files, SysV shm mapped by unrelated processes) */
  readonly shmobj = new SharedObjects((instance, msg) => this.engineInstances.get(instance)?.(msg));

  /** An engine instance (a Blink worker) that maps shared objects: its id; set it as proc.data.engineInstance. */
  registerEngineInstance(post: (msg: ShmObjMessage) => void): number {
    const id = this.nextEngineInstance++;
    this.engineInstances.set(id, post);
    return id;
  }

  /** The instance ended: its mappings go (and a last one writes a file object back). */
  async engineInstanceGone(id: number): Promise<void> {
    this.engineInstances.delete(id);
    await this.shmobj.instanceGone(id);
  }
  /** fcntl record locks (F_SETLK, F_OFD_SETLK) */
  readonly locks = new LockTable();
  private detachTable?: () => void;
  /** How long an unreaped child of init stays a zombie before it is reaped automatically. */
  initReapDelayMs = 30_000;
  private detachWriteBack?: () => void;
  private detachContentPin?: () => void;

  constructor(opts: { fs?: FileSystem; shell?: Shell; allocPid?: () => number; registerWithProcessTable?: boolean } = {}) {
    this.fs = opts.fs ?? opts.shell?.fs;
    this.shell = opts.shell;
    // Open files' buffered writes reach storage when the page goes away
    const wfs = this.fs;
    if (wfs?.addWriteBackHook) this.detachWriteBack = wfs.addWriteBackHook(() => writeBackAll(wfs));
    // Open files' content stays in the FileSystem's cache
    if (wfs?.addContentPin) this.detachContentPin = wfs.addContentPin((p) => isInodeOpen(wfs, p));
    const alloc = opts.allocPid ?? (() => processTable.allocatePid());
    this.allocPid = () => (this.lastPid = alloc());
    this.init = new Process({
      pid: 1, ppid: 0, pgid: 1, sid: 1, path: '/sbin/init', argv: ['init'],
      env: { ...(opts.shell?.env ?? { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/user' }) },
      cwd: opts.shell?.cwd ?? '/',
    });
    this.procs.set(1, this.init);
    // /proc/PID/stat and status for kernel processes
    addProcInfoSource({
      get: (pid) => {
        const p = this.procs.get(pid);
        if (!p) return undefined;
        const state = p.state === 'zombie' ? 'Z' : p.state === 'stopped' ? 'T' : p.sleeping() ? 'S' : 'R';
        return {
          pid, ppid: p.ppid, pgid: p.pgid, sid: p.sid, comm: p.comm, state, cmdline: p.argv,
          cwd: p.cwd, environ: p.env, exe: typeof p.data.exe === 'string' ? p.data.exe : p.path,
          fds: p.fds.entries().map(([fd, f]) => [fd, fdTarget(f)] as [number, string]),
          startMs: p.startTime, uid: p.uid, gid: p.gid,
          syscall: syscallText(p), wchan: wchanText(p),
        };
      },
      list: () => [...this.procs.keys()],
      // the rest of /proc/PID (syscall, wchan, task/ …) and /proc/stat as programs see them
      node: (path) => this.procfs.fsNode(path),
    });
    this.registerDevice('/dev/null', (_p, f) => new DevNull(f));
    this.registerDevice('/dev/zero', (_p, f) => new DevZero(f));
    this.registerDevice('/dev/full', (_p, f) => new DevFull(f));
    this.registerDevice('/dev/urandom', (_p, f) => new DevRandom(f, '/dev/urandom'));
    this.registerDevice('/dev/random', (_p, f) => new DevRandom(f, '/dev/random'));
    this.registerDevice('/dev/tty', p => p.ctty ?? -A.ENXIO);
    this.registerDevice('/dev/kmsg', (_p, f) => new KmsgFile(klog, f));
    this.addLoader((path, proc, k) => k.builtinLoader(path, proc));
    this.addLoader((path, proc, k) => k.shebangLoader(path, proc));
    if (opts.registerWithProcessTable !== false) {
      this.detachTable = processTable.attachSource({
        list: () => [...this.procs.values()].filter(p => p.pid !== 1).map(p => this.view(p)),
        get: pid => { const p = this.procs.get(pid); return p && p.pid !== 1 ? this.view(p) : undefined; },
        kill: (pid, sig) => this.procs.has(pid) && pid !== 1 && this.kill(pid, sig ?? A.SIGTERM) === 0,
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
    this.procfs.dispose();
    this.detachWriteBack?.();
    this.detachWriteBack = undefined;
    this.detachContentPin?.();
    this.detachContentPin = undefined;
    this.detachTable = undefined;
  }

  // ── Programs ──────────────────────────────────────────────────────────────

  /** Loaders run newest first, before the builtin loader. */
  addLoader(loader: Loader): void {
    this.loaders.unshift(loader);
  }

  /**
   * Builtins that `sh -c 'NAME args'` should exec in place (findProgram)
   * rather than run in the forked shell, when `claim(NAME, process)` says so.
   */
  readonly execDirect: ((name: string, proc: Process) => boolean)[] = [];

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

  /**
   * `#!INTERP [ARG]` scripts whose interpreter is a real program (an ELF,
   * like Debian's /bin/sh → dash) or a Shiro kernel program (Command.program),
   * as Linux runs them: argv becomes [INTERP, ARG?, script, args...]. Other
   * interpreters (Shiro's own sh, node, python builtins) are left to the
   * builtin loader, which runs the script through the shell.
   */
  private async shebangLoader(path: string, proc: Process): Promise<Runner | null> {
    const fs = this.fs;
    if (!fs || !path.includes('/')) return null;
    const abs = path.startsWith('/') ? path : fs.resolvePath(path, proc.cwd);
    let head: string;
    try {
      const st = await fs.stat(abs);
      if (st.type !== 'file') return null;
      const raw = await fs.readFile(abs);
      const bytes = typeof raw === 'string' ? enc.encode(raw.slice(0, 256)) : raw.subarray(0, 256);
      if (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) return null;
      // No #! line (an empty file too): ENOEXEC, on which execvp, posix_spawnp,
      // perl and the shells run the file with /bin/sh. debconf runs a
      // package's empty config this way, with its stdin a pipe left open.
      head = bytes[0] === 0x23 && bytes[1] === 0x21 ? A.decodeText(bytes) : '#!/bin/sh';
    } catch {
      return null;
    }
    const line = head.slice(2).split('\n')[0].replace(/\r$/, '').trim();
    const m = /^(\S+)(?:\s+(.*))?$/.exec(line);
    if (!m || m[1] === abs || m[1] === path) return null;
    const interp = m[1];
    const arg = m[2]?.trim();
    let native = false;
    const ist = await this.statPath(proc, interp);
    if (typeof ist !== 'number') {
      if ((ist.mode & A.S_IFMT) !== A.S_IFREG) return null;
      try {
        const raw = await fs.readFile(await fs.realpath(interp));
        native = typeof raw !== 'string' && raw.length >= 4 && raw[0] === 0x7f && raw[1] === 0x45 && raw[2] === 0x4c && raw[3] === 0x46;
      } catch { return null; }
    } else if (ist === -A.ENOENT && /^\/(usr\/)?(local\/)?s?bin\/[^/]+$/.test(interp)) {
      native = !!this.shell?.commands.get(interp.slice(interp.lastIndexOf('/') + 1))?.program;
    }
    if (!native) return null;
    return async (p, k) => {
      const depth = (p.data.shebangDepth as number | undefined) ?? 0;
      if (depth > 4) return 126;
      p.data.shebangDepth = depth + 1;
      p.argv = [interp, ...(arg ? [arg] : []), path, ...p.argv.slice(1)];
      p.path = interp;
      const run = await k.findProgram(interp, p);
      if (!run) return 127;
      return run(p, k);
    };
  }

  private async builtinLoader(path: string, _proc: Process): Promise<Runner | null> {
    const shell = this.shell;
    if (!shell) return null;
    const base = path.slice(path.lastIndexOf('/') + 1);
    const inBin = !path.includes('/') || /^\/(usr\/)?(local\/)?s?bin\//.test(path);
    const cmd = inBin ? shell.commands.get(base) : undefined;
    if (cmd && (base === 'sh' || base === 'bash')) {
      // `sh -c 'prog args'`: exec prog in this process; anything else is a script
      const direct = await this.shellCommandDirect(_proc);
      return direct ?? (proc => this.runShellProcess(proc));
    }
    // An installed package's command replaces the builtin, as at the prompt
    // (a bin-dir path can name a builtin's PATH shim, or nothing on disk)
    const pkgBin = `${PKG_BIN_DIR}/${base}`;
    if (cmd && this.fs && path !== pkgBin && packageShadows(this.fs).has(base)) {
      // pkg's programs are /usr/bin links; Debian's can be anywhere on PATH (/usr/sbin)
      const real = pkgOwnShadows(this.fs).has(base) ? pkgBin : await shell.findExecutableInPath(base);
      if (real && real !== path) return this.findProgram(real, _proc);
    }
    if (cmd && SHELL_NAMES.has(base)) {
      const direct = await this.shellCommandDirect(_proc);
      if (direct) return direct;
    }
    if (cmd?.program) return cmd.program;
    if (cmd) return proc => this.runBuiltin(proc, cmd);
    // Shell builtins that are also programs (/bin/echo, /usr/bin/test, ...)
    if (inBin && SHELL_PROGRAMS.has(base)) return proc => this.runViaShell(proc, base);
    // Scripts and other executables the shell knows how to start
    const found = path.includes('/') ? ((await this.fs?.exists(this.fs.resolvePath(path, _proc.cwd))) ? path : null) : await shell.findExecutableInPath(path);
    if (found) return proc => this.runViaShell(proc);
    return null;
  }

  /**
   * `sh -c 'prog args'` naming a program (not a builtin), with nothing for
   * the shell to do but start it: run the program in this process, as a
   * real shell execs its last command (one process instead of two). Other
   * scripts run in a shell that uses this process's fds (src/shell-stdio.ts).
   */
  private async shellCommandDirect(probe: Process): Promise<Runner | null> {
    // Only a plain -c (login and the like don't matter to one simple command; -e, -x, -o ... do)
    const opts = parseShellArgs(probe.argv.slice(1));
    if (!opts.command || opts.error || opts.on.length || opts.off.length || opts.shopts.length || opts.interactive || !opts.rest.length) return null;
    const words = simpleCommandWords(opts.rest[0]);
    if (!words || !words.length || words[0].includes('=')) return null;
    const name = words[0];
    let path: string | null = null;
    if (name.includes('/')) {
      const p = this.resolvePath(probe, name);
      if (typeof p === 'string' && (await this.fs?.exists(p))) path = p;
    } else if (this.fs && this.shell?.commands.get(name) && packageShadows(this.fs).has(name)) {
      path = `${PKG_BIN_DIR}/${name}`; // an installed package replaces the builtin
    } else if (this.shell?.commands.get(name) && this.execDirect.some(f => f(name, probe))) {
      path = name; // a loader runs this builtin as the process itself (node as a guest)
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
    proc.uid = opts.uid ?? parent.uid;
    // sudo's root gets root's group too; dropping back to the user gets the user's
    proc.gid = opts.uid === undefined ? parent.gid : opts.uid === 0 ? 0 : 1000;
    if (opts.uid === undefined) copyCredentials(parent, proc);
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

  /**
   * An interval timer of `proc` (which: ITIMER_REAL 0, ITIMER_VIRTUAL 1,
   * ITIMER_PROF 2): milliseconds left and the reload interval.
   */
  realTimer(proc: Process, which = 0): { value: number; interval: number } {
    const t = proc.data[ITIMER_KEYS[which]] as { deadline: number; interval: number } | undefined;
    if (!t) return { value: 0, interval: 0 };
    return { value: Math.max(0, t.deadline - Date.now()), interval: t.interval };
  }

  /**
   * setitimer/alarm: the timer's signal (SIGALRM, SIGVTALRM, SIGPROF) to
   * `proc` in `valueMs` (0 disarms), then every `intervalMs`. Returns the
   * old setting. Not inherited by fork children; kept across exec (it lives
   * on the process). ITIMER_VIRTUAL and ITIMER_PROF count wall time: there's
   * no per-process CPU time to count (the CPU clocks are the same stand-in).
   */
  setRealTimer(proc: Process, valueMs: number, intervalMs: number, which = 0): { value: number; interval: number } {
    const key = ITIMER_KEYS[which];
    const signo = [A.SIGALRM, A.SIGVTALRM, A.SIGPROF][which];
    const old = this.realTimer(proc, which);
    const t = proc.data[key] as { handle?: ReturnType<typeof setTimeout>; deadline: number; interval: number } | undefined;
    if (t?.handle) clearTimeout(t.handle);
    if (!(valueMs > 0)) {
      delete proc.data[key];
      return old;
    }
    const timer: { handle?: ReturnType<typeof setTimeout>; deadline: number; interval: number } = { deadline: Date.now() + valueMs, interval: intervalMs > 0 ? intervalMs : 0 };
    const arm = (ms: number) => {
      // setTimeout holds at most 2^31-1 ms (~24.8 days); a longer alarm waits in steps
      timer.handle = setTimeout(() => {
        if (proc.exiting || proc.data[key] !== timer) return;
        if (timer.deadline - Date.now() > 0 && ms > 0x7fffffff) { arm(timer.deadline - Date.now()); return; }
        if (timer.interval > 0) {
          timer.deadline = Date.now() + timer.interval;
          arm(timer.interval);
        } else {
          delete proc.data[key];
        }
        this.deliver(proc, signo);
      }, Math.min(0x7fffffff, Math.max(0, ms)));
      (timer.handle as any)?.unref?.();
    };
    proc.data[key] = timer;
    if (!proc.data.realTimerCleanup) {
      proc.data.realTimerCleanup = true;
      proc.onTerminate(() => {
        for (const k of ITIMER_KEYS) {
          const cur = proc.data[k] as { handle?: ReturnType<typeof setTimeout> } | undefined;
          if (cur?.handle) clearTimeout(cur.handle);
          delete proc.data[k];
        }
      });
    }
    arm(valueMs);
    return old;
  }

  /** Terminate `proc` with a wait status: close its fds, reparent its children, notify its parent. */
  async exit(proc: Process, status: number): Promise<void> {
    if (proc.pid === 1 || !proc.beginExit()) return;
    await proc.fds.closeAll();
    this.locks.release(proc.pid);
    this.shm.detachAll(proc);
    this.sem.exited(proc);
    for (const child of this.procs.values()) {
      if (child.ppid === proc.pid) {
        // An orphan: init reaps it as soon as it is a zombie, as Linux's does
        child.ppid = 1;
        child.data.orphaned = true;
        if (child.state === 'zombie') this.procs.delete(child.pid);
      }
    }
    proc.markExited(status);
    this.logTrap(proc, status);
    const parent = this.procs.get(proc.ppid);
    if (parent && parent.pid !== 1) {
      const killed = A.WIFSIGNALED(status);
      this.deliver(parent, A.SIGCHLD, {
        signo: A.SIGCHLD, code: !killed ? A.CLD_EXITED : status & 0x80 ? A.CLD_DUMPED : A.CLD_KILLED,
        pid: proc.pid, uid: proc.ruid ?? proc.uid, status: killed ? A.WTERMSIG(status) : A.WEXITSTATUS(status),
      });
    }
    if (proc.ppid === 1) {
      // A child the page spawned directly (ppid 1) waits for its runner's waitpid
      if (proc.data.orphaned) this.procs.delete(proc.pid);
      else this.scheduleInitReap(proc);
    }
    // A parent ignoring SIGCHLD or with SA_NOCLDWAIT leaves no zombie: the
    // child is reaped now, and a wait for it ends in ECHILD (Linux)
    else if (parent && (parent.dispositions.get(A.SIGCHLD) === 'ignore' ||
             ((parent.sigactions.get(A.SIGCHLD)?.flags ?? 0) & A.SA_NOCLDWAIT))) this.procs.delete(proc.pid);
    this.notify();
  }

  /**
   * A process killed by a fault signal (a guest's SIGSEGV from Blink, a wasm
   * trap mapped to one) gets a kernel log line, as Linux's show_signal_msg
   * and traps do. `proc.data.trapReason` (set by the engine) says more.
   */
  private logTrap(proc: Process, status: number): void {
    if (!A.WIFSIGNALED(status) || proc.data.trapLogged) return;
    const sig = A.WTERMSIG(status);
    const what: Record<number, string> = {
      [A.SIGSEGV]: 'segfault', [A.SIGBUS]: 'bus error', [A.SIGILL]: 'invalid opcode', [A.SIGFPE]: 'divide error',
    };
    if (!what[sig]) return;
    const reason = typeof proc.data.trapReason === 'string' ? ` (${proc.data.trapReason})` : '';
    klog.log(LOG_INFO, `traps: ${proc.comm}[${proc.pid}] ${what[sig]}${reason}, killed by SIG${A.SIGNAL_NAMES[sig]}`);
  }

  /**
   * Log why a guest engine ended `proc` abnormally (worker error, wasm trap,
   * engine abort). Out-of-memory errors are logged like the OOM killer's.
   */
  reportFatal(proc: Process, message: string): void {
    if (proc.data.trapLogged) return;
    proc.data.trapLogged = true;
    if (/out of memory|\boom\b|cannot enlarge memory|maximum memory|memory\.grow|allocation failed|array buffer allocation/i.test(message)) {
      klog.log(LOG_ERR, `Out of memory: Killed process ${proc.pid} (${proc.comm}): ${message}`);
    } else {
      klog.log(LOG_INFO, `traps: ${proc.comm}[${proc.pid}] ${message}`);
    }
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
          const cpuMs = ProcFs.cpuMs(k) + k.childCpuMs;
          if (!(options & A.WNOWAIT)) {
            this.procs.delete(k.pid);
            caller.childCpuMs += cpuMs;
            this.notify();
          }
          return { pid: k.pid, status: k.exitStatus!, cpuMs };
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
      // (no children left, as when SA_NOCLDWAIT reaped the last: ECHILD before EINTR, as Linux's do_wait)
      if (!woke) return { pid: this.children(caller, pid).length ? -A.EINTR : -A.ECHILD, status: 0 };
    }
  }

  /** kill(2): pid > 0, 0 (caller's group), -1 (everything but init), < -1 (group -pid). sig 0 probes. */
  kill(pid: number, sig: number, sender: Process = this.init): number {
    if (sig < 0 || sig >= A.NSIG) return -A.EINVAL;
    let targets: Process[];
    if (pid > 0 && !this.procs.has(pid)) {
      // A process the page runs outside the kernel (an in-page background job,
      // a windowed command): the process table reaches it
      const other = processTable.get(pid);
      if (!other || other.status !== 'running') return -A.ESRCH;
      if (sig !== 0) processTable.kill(pid, sig);
      return 0;
    }
    if (pid > 0) targets = this.procs.has(pid) ? [this.procs.get(pid)!] : [];
    else if (pid === 0) targets = [...this.procs.values()].filter(p => p.pgid === sender.pgid && p.pid !== 1);
    else if (pid === -1) targets = [...this.procs.values()].filter(p => p.pid !== 1 && p.pid !== sender.pid);
    else targets = [...this.procs.values()].filter(p => p.pgid === -pid);
    targets = targets.filter(p => p.state !== 'zombie' || pid > 0);
    if (targets.length === 0) return -A.ESRCH;
    // the ones the sender may signal; none of several is EPERM as for one
    targets = targets.filter(p => this.maySignal(sender, p, sig));
    if (targets.length === 0) return -A.EPERM;
    if (sig === 0) return 0;
    // Group signals are rare and hard to trace afterwards (a program killpg'ing
    // its own foreground job): say who sent what to whom
    if (pid <= 0 && sender !== this.init) {
      const to = pid === 0 ? `its own process group ${sender.pgid}` : pid === -1 ? 'every process' : `process group ${-pid}`;
      klog.logRatelimited(LOG_INFO, `signal: ${sender.comm}[${sender.pid}] sent ${sigName(sig)} to ${to} (${targets.length} process${targets.length === 1 ? '' : 'es'})`);
    }
    for (const p of targets) this.deliver(p, sig, { signo: sig, code: A.SI_USER, pid: sender.pid, uid: sender.uid });
    return 0;
  }

  /**
   * Linux's kill permission: root, or the sender's real or effective uid is the
   * target's real or saved uid; SIGCONT within a session. init stands in for
   * Linux's root-owned pid 1 (the kernel's own sends come from it).
   */
  maySignal(sender: Process, target: Process, sig: number): boolean {
    if (sender === this.init || sender.uid === 0 || sender === target) return true;
    if (target === this.init) return false;
    if (sig === A.SIGCONT && sender.sid === target.sid) return true;
    const senderIds = [sender.uid, sender.ruid ?? sender.uid];
    return [target.ruid ?? target.uid, target.suid ?? target.uid].some((u) => senderIds.includes(u));
  }

  /** Deliver one signal: the signal hook (signals.ts) first, then the disposition, then the default action. */
  deliver(proc: Process, sig: number, info: A.SigInfo = { signo: sig, code: A.SI_KERNEL }): void {
    if (proc.state === 'zombie' || proc.exiting || proc.pid === 1) return;
    if (sig === A.SIGKILL) { void this.exit(proc, A.W_TERMSIG(A.SIGKILL)); return; }
    if (sig === A.SIGSTOP) { this.stopProcess(proc, sig); return; }
    if (sig === A.SIGCONT && proc.state === 'stopped') {
      proc.markContinued(); this.notify();
      if (!proc.signalHook) this.notifyParentOfStop(proc, 0);
    }
    if (proc.signalHook) {
      // (job control routes it: signals.ts queues what it carries when it goes pending)
      proc.data.sigInFlight = info;
      try { if (proc.signalHook(proc, sig)) return; } finally { delete proc.data.sigInFlight; }
    }
    const disp = proc.dispositions.get(sig) ?? 'default';
    // A blocked signal stays pending even when ignored (signalfd reads it; setSigmask drops it if still ignored)
    if (proc.sigmask.has(sig)) {
      // (a standard signal already pending coalesces; a real-time one queues)
      if (proc.queueSiginfo(info) || !proc.deferredSignals.has(sig)) { proc.deferredSignals.add(sig); notifySignalPending(proc); }
      return;
    }
    if (disp === 'ignore') return;
    if (disp === 'default' && A.defaultSignalAction(sig) === 'ignore') return;
    if (typeof disp === 'number') {
      // A guest handler: flag it for the guest and interrupt blocking syscalls (EINTR)
      if (!proc.queueSiginfo(info) && proc.pendingSignals.has(sig)) return;
      proc.pendingSignals.add(sig);
      proc.interruptSyscalls();
      (proc.data.onSignal as ((s: number) => void) | undefined)?.(sig);
      return;
    }
    switch (A.defaultSignalAction(sig)) {
      case 'term': void this.exit(proc, A.W_TERMSIG(sig)); break;
      case 'stop':
        klog.logRatelimited(LOG_INFO, `signal: ${proc.comm}[${proc.pid}] stopped by ${sigName(sig)}`);
        this.stopProcess(proc, sig); break;
      default: break;
    }
  }

  private stopProcess(proc: Process, sig: number): void {
    const was = proc.state;
    proc.markStopped(sig);
    this.notify();
    // (job control's targets have it say so: JobControl.noteStopped)
    if (was === 'running' && !proc.signalHook) this.notifyParentOfStop(proc, sig);
  }

  /** SIGCHLD to the parent for a stop (sig) or a continue (0), unless it set SA_NOCLDSTOP */
  private notifyParentOfStop(proc: Process, sig: number): void {
    const parent = this.procs.get(proc.ppid);
    if (!parent || parent.pid === 1 || ((parent.sigactions.get(A.SIGCHLD)?.flags ?? 0) & A.SA_NOCLDSTOP)) return;
    this.deliver(parent, A.SIGCHLD, {
      signo: A.SIGCHLD, code: sig ? A.CLD_STOPPED : A.CLD_CONTINUED, pid: proc.pid, uid: proc.ruid ?? proc.uid, status: sig || A.SIGCONT,
    });
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
    proc.takeSiginfo(sig, proc.pendingSignals);
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
      if (mask.has(s)) continue;
      // every queued instance, with what it carries
      const q = proc.siginfo.get(s) ?? [{ signo: s, code: A.SI_KERNEL }];
      proc.siginfo.delete(s);
      proc.deferredSignals.delete(s);
      for (const info of q) this.deliver(proc, s, info);
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
      zombie: p.state === 'zombie',
    };
  }

  // ── Files ─────────────────────────────────────────────────────────────────

  /** Absolute path for `path` relative to `dirfd` (AT_FDCWD = cwd), or -errno. */
  resolvePath(proc: Process, path: string, dirfd = A.AT_FDCWD): string | number {
    if (path === '') return -A.ENOENT;
    // PATH_MAX 4096 with its NUL, NAME_MAX 255 per component
    if (path.length >= 4096 || path.split('/').some((c) => c.length > 255)) return -A.ENAMETOOLONG;
    if (path.startsWith('/')) return this.throughFd(proc, normalize(path));
    let base = proc.cwd;
    if (dirfd !== A.AT_FDCWD) {
      const d = proc.fds.get(dirfd);
      if (!d) return -A.EBADF;
      if (d.kind !== 'dir' || !d.path) return -A.ENOTDIR;
      base = d.path;
    }
    return this.throughFd(proc, normalize(base + '/' + path));
  }

  /**
   * A path below an open directory's /proc/self/fd/N (or /dev/fd/N,
   * /proc/PID/fd/N) names something in that directory, as on Linux, where
   * the fd entry is a link to it: Claude Code pins a directory with an
   * O_PATH fd and then mkdirs, opens and renames through /proc/self/fd/N/NAME.
   */
  private throughFd(proc: Process, p: string): string | number {
    if (!p.startsWith('/proc/') && !p.startsWith('/dev/fd/')) return p;
    const m = /^\/(?:proc\/(self|thread-self|\d+)|dev)\/fd\/(\d+)(\/.+)$/.exec(p);
    if (!m) return p;
    const owner = m[1] === undefined || m[1] === 'self' || m[1] === 'thread-self' ? proc : this.procs.get(Number(m[1]));
    const d = owner?.fds.get(Number(m[2]));
    if (!d) return -A.ENOENT;
    if (d.kind !== 'dir' || !d.path) return -A.ENOTDIR;
    return normalize(d.path + m[3]);
  }

  /** Directories chmod or mkdir left without owner search (x) permission (searchDenied). */
  private noSearchDirs = new Set<string>();

  /** chmod/mkdir set `path`'s mode: remember a directory it can't be searched through. */
  private noteDirMode(path: string, mode: number): void {
    if (mode & 0o100) { this.noSearchDirs.delete(path); return; }
    if (this.fs?.lookupCached?.(path)?.node.type === 'dir') this.noSearchDirs.add(path);
  }

  /**
   * A directory on the way to `p` that a non-root process may not search: its
   * owner bits lack x (mode 0666: EACCES, LTP lstat02). Only directories the
   * kernel's chmod/mkdir made so are looked at: nothing to check otherwise
   * (stat and open are hot), and one whose mode isn't known never refuses.
   */
  private searchDenied(proc: Process, p: string): boolean {
    if (!this.noSearchDirs.size || proc.uid === 0) return false;
    for (const d of this.noSearchDirs) {
      if (!p.startsWith(d + '/')) continue;
      const node = this.fs?.lookupCached?.(d)?.node;
      if (node?.type === 'dir' && !(node.mode & 0o100)) return true;
      if (node !== undefined) this.noSearchDirs.delete(d); // (searchable again, or gone)
    }
    return false;
  }

  /** open(2) without the fd: returns the new OpenFile or -errno. */
  async open(proc: Process, path: string, flags: number, mode = 0o666, dirfd = A.AT_FDCWD): Promise<OpenFile | number> {
    // O_PATH: a descriptor that only names the file (fstat, fchdir, *at, dup, close)
    if (flags & A.O_PATH) {
      const f = await this.open(proc, path, (flags & (A.O_NOFOLLOW | A.O_DIRECTORY)) | A.O_RDONLY, mode, dirfd);
      return typeof f === 'number' ? f : pathOnlyFile(f);
    }
    const p = this.resolvePath(proc, path, dirfd);
    if (typeof p === 'number') return p;
    if (this.searchDenied(proc, p)) return -A.EACCES;
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
    // "name/" must be a directory (a symlink to one is followed even with O_NOFOLLOW)
    const mustBeDir = trailingSlash(path) || !!(flags & A.O_DIRECTORY);
    try {
      let lst: Awaited<ReturnType<FileSystem['lstat']>> | null = null;
      try { lst = await fs.lstat(p); } catch { lst = null; }
      if (lst?.isSymbolicLink() && (flags & A.O_NOFOLLOW) && !trailingSlash(path)) return -A.ELOOP;
      let st: Awaited<ReturnType<FileSystem['stat']>> | null = null;
      if (lst) {
        try { st = lst.isSymbolicLink() ? await fs.stat(p) : lst; } catch (e) {
          const err = A.errnoFromError(e, A.ENOENT);
          if (err !== -A.ENOENT) return err; // ELOOP
        }
      }
      let target = p;
      if (!st) {
        if (!(flags & A.O_CREAT)) return -A.ENOENT;
        if (trailingSlash(path)) return -A.EISDIR;
        if (flags & A.O_DIRECTORY) return -A.EINVAL;
        if (lst) {
          // A dangling symlink: O_EXCL refuses it, otherwise its target is created
          if (flags & A.O_EXCL) return -A.EEXIST;
          target = await fs.realpath(p);
        }
        await fs.writeFile(target, new Uint8Array(0), { mode: mode & ~proc.umask & 0o7777 });
      } else {
        if ((flags & A.O_CREAT) && (flags & A.O_EXCL)) return -A.EEXIST;
        if (st.isDirectory()) {
          if (canWrite(flags)) return -A.EISDIR;
          // The physical directory, as on Linux: fstat, getdents d_ino, /proc/self/fd and
          // *at() through this fd agree with stat of it when it was opened through a symlink
          return new DirFile(fs, await fs.realpath(p), statusFlags);
        }
        if (mustBeDir) return -A.ENOTDIR;
        if (ownerDenies(proc, st.mode, flags)) return -A.EACCES;
        if (st.isFIFO?.()) return await this.openFifo(proc, await fs.realpath(target), flags);
      }
      const real = await fs.realpath(target);
      const file = new RegularFile(await openInode(fs, real), statusFlags);
      if ((flags & A.O_TRUNC) && canWrite(flags)) await file.truncate(0);
      return file;
    } catch (e) {
      return this.pathErrno(p, A.errnoFromError(e));
    }
  }

  /** Named pipes in use: canonical path → the pipe all opens of it share (until every end closes). */
  private fifos = new Map<string, Pipe>();

  /**
   * open() of a named pipe (POSIX): readers and writers of the same path
   * share one pipe. A reader blocks until a writer has it open, and a writer
   * until a reader does, unless O_NONBLOCK (a reader then opens at once; a
   * writer gets ENXIO). O_RDWR never blocks. The data goes when the last
   * end closes.
   */
  async openFifo(proc: Process, path: string, flags: number): Promise<OpenFile | number> {
    let pipe = this.fifos.get(path);
    if (!pipe) {
      const p = new Pipe();
      p.onIdle = () => { if (this.fifos.get(path) === p) this.fifos.delete(path); };
      this.fifos.set(path, pipe = p);
    }
    const acc = flags & A.O_ACCMODE;
    const nonblock = flags & A.O_NONBLOCK;
    if (acc === A.O_RDWR) return new FifoRdWr(pipe, nonblock);
    if (acc === A.O_WRONLY && nonblock && pipe.readers === 0) {
      if (pipe.writers === 0 && this.fifos.get(path) === pipe) this.fifos.delete(path);
      return -A.ENXIO;
    }
    const end = new PipeEnd(pipe, acc === A.O_WRONLY ? 'w' : 'r', (acc === A.O_WRONLY ? A.O_WRONLY : A.O_RDONLY) | nonblock);
    if (nonblock) return end;
    const sig = proc.syscallSignal;
    const other = () => (end.end === 'r' ? pipe!.writers : pipe!.readers);
    while (other() === 0) {
      if (proc.exiting || !(await abortableWait(pipe.openWaiters, sig))) {
        await end.close();
        return -A.EINTR;
      }
    }
    return end;
  }

  /** A registered device node, or a directory that holds one (/dev, /dev/pts). */
  /**
   * /proc/<pid>/exe as Linux gives it: absolute and resolved. A process
   * started by name ("perl") or by a relative path has that as its path;
   * glibc's ld.so asserts the link is absolute when it expands $ORIGIN.
   */
  private async exePath(caller: Process, procPath: string, target: string): Promise<string> {
    const fs = this.fs;
    if (!fs) return target;
    let abs = target;
    if (!abs.startsWith('/')) {
      const pid = procPath.split('/')[2];
      const owner = pid === 'self' || pid === 'thread-self' ? caller : this.procs.get(Number(pid)) ?? caller;
      if (abs.includes('/')) abs = fs.resolvePath(abs, owner.cwd);
      else {
        for (const dir of (owner.env.PATH || '/usr/local/bin:/usr/bin:/bin').split(':').filter(Boolean)) {
          const c = `${dir.replace(/\/$/, '')}/${abs}`;
          if (await fs.exists(c).catch(() => false)) { abs = c; break; }
        }
        if (!abs.startsWith('/')) abs = fs.resolvePath(abs, owner.cwd);
      }
    }
    return fs.realpath(abs).catch(() => abs);
  }

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
  openSync(proc: Process, path: string, flags: number, dirfd = A.AT_FDCWD, mode = 0o666): OpenFile | number | undefined {
    const fs = this.fs;
    if (!fs || flags & A.O_PATH || trailingSlash(path)) return undefined;
    const p = this.resolvePath(proc, path, dirfd);
    if (typeof p === 'number') return p;
    if (this.devices.has(p) || /^\/(?:dev|proc)\//.test(p)) return undefined;
    const statusFlags = flags & ~(A.O_CREAT | A.O_EXCL | A.O_TRUNC | A.O_CLOEXEC | A.O_NOCTTY | A.O_DIRECTORY | A.O_NOFOLLOW);
    if (flags & (A.O_CREAT | A.O_TRUNC | A.O_NOFOLLOW)) {
      // Creating, truncating or not following: decided on the last component itself
      const own = fs.lookupCached(p, false);
      if (own === undefined) return undefined;
      if (own === null) {
        if (!(flags & A.O_CREAT)) return -A.ENOENT;
        if (flags & A.O_DIRECTORY) return undefined; // EINVAL, as open() says
        const name = p.slice(p.lastIndexOf('/') + 1);
        const dir = fs.lookupCached(p.slice(0, p.lastIndexOf('/')) || '/');
        if (!dir || dir.node.type !== 'dir') return undefined;
        const real = dir.path === '/' ? '/' + name : dir.path + '/' + name;
        const node = fs.createEmptyCachedSync(real, mode & ~proc.umask & 0o7777);
        if (!node) return undefined;
        return new RegularFile(openInodeSync(fs, real, node), statusFlags);
      }
      if (own.node.type === 'symlink') return flags & A.O_NOFOLLOW ? -A.ELOOP : undefined;
      if ((flags & A.O_CREAT) && (flags & A.O_EXCL)) return -A.EEXIST;
      if (own.node.type !== 'file' || own.node.lazy || own.node.special) return undefined;
      if (flags & A.O_DIRECTORY) return -A.ENOTDIR;
      if (ownerDenies(proc, own.node.mode, flags)) return -A.EACCES;
      const file = new RegularFile(openInodeSync(fs, own.path, own.node), statusFlags);
      if ((flags & A.O_TRUNC) && canWrite(flags)) file.truncateSync(0);
      return file;
    }
    const hit = fs.lookupCached(p);
    if (hit === undefined) return undefined;
    if (hit === null) return -A.ENOENT;
    if (hit.node.type === 'dir') return canWrite(flags) ? -A.EISDIR : new DirFile(fs, hit.path, statusFlags);
    if (flags & A.O_DIRECTORY) return -A.ENOTDIR;
    if (hit.node.type !== 'file' || hit.node.lazy || hit.node.special) return undefined; // lazy: open() fetches it; FIFOs block
    return new RegularFile(openInodeSync(fs, hit.path, hit.node), statusFlags);
  }

  /** unlink(2) from memory: 0, -errno, or undefined (use the async path). */
  private unlinkSync(proc: Process, path: string, dirfd: number): number | undefined {
    const fs = this.fs;
    if (!fs || !path || trailingSlash(path)) return undefined;
    const p = this.resolvePath(proc, path, dirfd);
    if (typeof p === 'number') return p;
    if (this.devices.has(p) || /^\/(?:dev|proc)\//.test(p) || this.socketPaths?.has(p) || this.fifos.has(p)) return undefined;
    const hit = fs.lookupCached(p, false);
    if (hit === undefined) return undefined;
    if (hit === null) return -A.ENOENT;
    if (hit.node.type === 'dir') return -A.EISDIR;
    if (isInodeOpen(fs, hit.path)) return undefined; // the open fds keep its data: unlinkInode
    if (!fs.unlinkCachedSync(hit.path)) return undefined;
    forgetInodeNumber(fs, hit.path);
    return 0;
  }

  /**
   * The canonical path for a new entry `p` (resolved, absent) from the
   * cached parent: the path, -ENOENT/-ENOTDIR, or undefined when the parent
   * isn't in memory.
   */
  private childPathSync(p: string): string | number | undefined {
    const slash = p.lastIndexOf('/');
    const parent = this.fs!.lookupCached(slash <= 0 ? '/' : p.slice(0, slash));
    if (parent === undefined) return undefined;
    if (parent === null) return -A.ENOENT;
    if (parent.node.type !== 'dir') return -A.ENOTDIR;
    return (parent.path === '/' ? '' : parent.path) + p.slice(slash);
  }

  /**
   * rmdir, mkdir and rename from memory (node in a Worker makes these back
   * to back): the result, or undefined for the async path (uncached, open,
   * a symlink or directory rename would move, sockets, FIFOs).
   */
  private pathOpSync(proc: Process, nr: number, args: ArrayLike<number>, data: Uint8Array): number | undefined {
    const fs = this.fs;
    if (!fs) return undefined;
    const at = (dirfd: number, off: number, len: number): string | number | undefined => {
      if (len <= 0 || off < 0 || off + len > data.length) return undefined;
      const s = A.decodeText(data.subarray(off, off + len));
      if (trailingSlash(s)) return undefined;
      const p = this.resolvePath(proc, s, dirfd);
      if (typeof p === 'string' && (this.devices.has(p) || /^\/(?:dev|proc)(?:\/|$)/.test(p) || this.socketPaths?.has(p) || this.fifos.has(p))) return undefined;
      return p;
    };
    switch (nr) {
      case A.SYS_rmdir: case A.SYS_unlinkat: {
        const [dirfd, len] = nr === A.SYS_rmdir ? [A.AT_FDCWD, args[0]] : [args[0], args[1]];
        const p = at(dirfd, 0, len);
        if (typeof p !== 'string') return p;
        const own = fs.lookupCached(p, false);
        if (!own) return undefined; // missing: the async path tells ENOENT from ENOTDIR
        if (own.node.type !== 'dir') return -A.ENOTDIR;
        const r = fs.rmdirNow(own.path);
        return r === undefined ? undefined : r ? 0 : -A.ENOTEMPTY;
      }
      case A.SYS_mkdir: case A.SYS_mkdirat: {
        const [dirfd, len, mode] = nr === A.SYS_mkdir ? [A.AT_FDCWD, args[0], args[1]] : [args[0], args[1], args[2]];
        const p = at(dirfd, 0, len);
        if (typeof p !== 'string') return p;
        const own = fs.lookupCached(p, false);
        if (own === undefined) return undefined;
        if (own) return -A.EEXIST;
        const real = this.childPathSync(p);
        if (typeof real !== 'string') return real;
        if (!fs.createDirNow(real, mode & ~proc.umask)) return undefined;
        this.noteDirMode(real, mode & ~proc.umask);
        return 0;
      }
      case A.SYS_rename: case A.SYS_renameat: case A.SYS_renameat2: {
        const [od, ol, nd, nl, flags] = nr === A.SYS_rename
          ? [A.AT_FDCWD, args[0], A.AT_FDCWD, args[1], 0]
          : [args[0], args[1], args[2], args[3], nr === A.SYS_renameat2 ? args[4] : 0];
        if (flags & ~A.RENAME_NOREPLACE) return undefined;
        const from = at(od, 0, ol), to = at(nd, ol, nl);
        if (typeof from !== 'string') return from;
        if (typeof to !== 'string') return to;
        const src = fs.lookupCached(from, false);
        const dst = fs.lookupCached(to, false);
        if (!src || dst === undefined || src.node.type === 'dir' || src.node.special) return undefined;
        if (from === to || src.path === dst?.path) return 0;
        if (dst) {
          if (flags & A.RENAME_NOREPLACE) return -A.EEXIST;
          if (dst.node.type === 'dir') return -A.EISDIR;
        }
        const real = dst ? dst.path : this.childPathSync(to);
        if (typeof real !== 'string') return real;
        if (isInodeOpen(fs, src.path) || isInodeOpen(fs, real) || !fs.renameNow(src.path, real)) return undefined;
        forgetInodeNumber(fs, real);
        renameLinkName(src.path, real);
        return 0;
      }
    }
    return undefined;
  }

  /** statPath from memory, encoded into `data`: 0, -errno, or undefined (use statPath). */
  private statPathSyncInto(proc: Process, path: string, follow: boolean, dirfd: number, data: Uint8Array): number | undefined {
    const fs = this.fs;
    if (!fs || trailingSlash(path)) return undefined;
    const p = this.resolvePath(proc, path, dirfd);
    if (typeof p === 'number') return p;
    if (this.devices.has(p) || p === '/proc' || p.startsWith('/proc/') || this.socketPaths?.has(p)) return undefined;
    const hit = fs.lookupCached(p, follow);
    if (hit === undefined) return undefined;
    if (hit === null) return -A.ENOENT;
    const n = hit.node;
    const open = n.type === 'file' ? inodeStat(fs, hit.path) : undefined;
    // The inode belongs to the resolved path: /bin and /usr/bin (a link to it) are one directory
    if (open) { A.encodeStat(statFor(proc, { ...open, ino: inodeNumber(this.fs, hit.path) }), data); return 0; }
    const type = n.type === 'dir' ? A.S_IFDIR : n.type === 'symlink' ? A.S_IFLNK : n.special === 'fifo' ? A.S_IFIFO : A.S_IFREG;
    A.encodeStat(statFor(proc, {
      dev: 1, ino: inodeNumber(this.fs, hit.path), mode: type | (n.mode & 0o7777), nlink: n.type === 'dir' ? 2 : linkCount(this.fs, hit.path),
      uid: 1000, gid: 1000, rdev: 0, size: n.size, blksize: 4096, blocks: Math.ceil(n.size / 512),
      atimeMs: n.atime ?? n.mtime, mtimeMs: n.mtime, ctimeMs: n.ctime,
      atimeNs: n.atime === undefined ? n.mtimeNs : n.atimeNs, mtimeNs: n.mtimeNs,
    }), data);
    return 0;
  }

  /** -ENOENT for `p` is -ENOTDIR when a leading component is an existing non-directory (path_resolution(7)) */
  private async pathErrno(p: string, errno: number): Promise<number> {
    if (errno !== -A.ENOENT || !this.fs) return errno;
    const parts = p.split('/').filter(Boolean);
    let cur = '';
    for (let k = 0; k < parts.length - 1; k++) {
      cur += '/' + parts[k];
      const st = await this.fs.stat(cur).catch(() => null);
      if (!st) return errno;
      if (!st.isDirectory()) return -A.ENOTDIR;
    }
    return errno;
  }

  async statPath(proc: Process, path: string, follow = true, dirfd = A.AT_FDCWD): Promise<A.KStat | number> {
    // "name/": the directory it names (following a symlink), or ENOTDIR
    if (trailingSlash(path)) {
      const st = await this.statPath(proc, path.replace(/\/+$/, ''), true, dirfd);
      return typeof st !== 'number' && (st.mode & A.S_IFMT) !== A.S_IFDIR ? -A.ENOTDIR : st;
    }
    const p = this.resolvePath(proc, path, dirfd);
    if (typeof p === 'number') return p;
    if (this.searchDenied(proc, p)) return -A.EACCES;
    const dev = this.devices.get(p);
    if (dev) {
      // A description just for the stat: O_NOCTTY (stat must not make a pty the
      // caller's controlling tty), closed after (a slave left open hides hangups)
      const f = await dev(proc, A.O_RDONLY | A.O_NOCTTY, p);
      if (typeof f === 'number') return f;
      try { return await f.stat(); } finally { if (f !== proc.ctty) await f.close(); }
    }
    if (p === '/proc' || p.startsWith('/proc/')) {
      // /proc/PID/fd/N followed is the open file itself (a pipe is a FIFO, a socket a socket), as on Linux
      const fdm = follow ? /^\/proc\/(\d+|self|thread-self)\/fd\/(\d+)$/.exec(p) : null;
      if (fdm) {
        const owner = /^\d+$/.test(fdm[1]) ? this.procs.get(Number(fdm[1])) : proc;
        if (owner) {
          const f = owner.fds.get(Number(fdm[2]));
          return f ? await f.stat() : -A.ENOENT;
        }
      }
      const pst = this.procfs.stat(proc, p, follow);
      if (pst !== undefined) return pst;
      const link = follow ? this.procfs.linkTarget(proc, p) : undefined;
      if (link) return this.statPath(proc, link, true);
    }
    const fs = this.fs;
    if (!fs) return -A.ENOSYS;
    try {
      const st = follow ? await fs.stat(p) : await fs.lstat(p);
      let type = st.isDirectory() ? A.S_IFDIR : st.isSymbolicLink() ? A.S_IFLNK : st.isFIFO?.() ? A.S_IFIFO : A.S_IFREG;
      // The same file or directory through a symlink is the same inode (/bin is /usr/bin)
      const slash = p.lastIndexOf('/');
      const real = follow ? await fs.realpath(p).catch(() => p)
        : slash > 0 ? (await fs.realpath(p.slice(0, slash)).catch(() => p.slice(0, slash))).replace(/\/$/, '') + p.slice(slash) : p;
      if (type === A.S_IFREG && this.socketPaths?.has(real)) type = A.S_IFSOCK;
      // A file open here: its size and times as the open descriptions see them
      const open = type === A.S_IFREG && hasOpenInodes(fs) ? inodeStat(fs, real) : undefined;
      if (open) return { ...open, ino: inodeNumber(this.fs, real) };
      return {
        dev: 1, ino: inodeNumber(this.fs, real), mode: type | (st.mode & 0o7777), nlink: st.isDirectory() ? 2 : linkCount(this.fs, real),
        uid: 1000, gid: 1000, rdev: 0, size: st.size, blksize: 4096, blocks: Math.ceil(st.size / 512),
        atimeMs: st.atimeMs ?? st.mtime.getTime(), mtimeMs: st.mtime.getTime(), ctimeMs: st.ctime.getTime(),
        atimeNs: st.atimeNs, mtimeNs: st.mtimeNs,
      };
    } catch (e) {
      return this.pathErrno(p, A.errnoFromError(e));
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
   * go to fds 1 and 2 when the command returns. The shells (sh, bash, dash)
   * use the fds themselves instead (src/shell-stdio.ts): stdin is read when
   * a command in the script needs it, output is written as it is produced.
   * fd 0 is read only if the command looks at ctx.stdin (execLazyStdin):
   * `echo`, `mkdir`... leave it for the next reader.
   */
  async runBuiltin(proc: Process, cmd: Command): Promise<number> {
    const shell = this.forkShell(proc);
    let stdio: KernelStdio | undefined;
    if (SHELL_NAMES.has(cmd.name) || SHELL_NAMES.has(proc.argv[0]?.slice(proc.argv[0].lastIndexOf('/') + 1))) {
      stdio = new KernelStdio(this, proc);
      shell.kernelStdio = stdio;
      stdio.adoptFds(shell);
      shell.kernelStdinLive = true;
    }
    const lazy = !stdio;
    const ctx: CommandContext = {
      args: proc.argv.slice(1),
      fs: this.fs ?? shell.fs,
      cwd: proc.cwd,
      env: shell.env,
      stdin: '',
      stdout: '',
      stderr: '',
      shell,
      stdoutIsTTY: proc.fds.get(1)?.kind === 'pty',
      ...(stdio ? { liveStdin: true, streamStdout: stdio.out, streamStderr: stdio.err } : {}),
    };
    let code: number;
    try {
      code = lazy ? await execLazyStdin(cmd, ctx, () => this.stdinText(proc)) : await cmd.exec(ctx);
    } catch (e: any) {
      ctx.stderr += (e?.message ?? String(e)) + '\n';
      code = 1;
    }
    if (stdio) await stdio.flush();
    if (proc.exiting) return code;
    // Byte-exact (src/utils/byte-text.ts): binary output of a builtin keeps its bytes
    if (ctx.stdout) await this.writeAll(proc, 1, encodeText(ctx.stdout));
    if (ctx.stderr && !proc.exiting) await this.writeAll(proc, 2, enc.encode(ctx.stderr));
    if (shell.cwd !== proc.cwd) proc.cwd = shell.cwd;
    return code;
  }

  /** Run argv through a forked shell (scripts, node programs, anything in PATH that is not a registered command). */
  /**
   * `sh`/`bash` as a kernel process (a program's system(), popen(), `sh -c
   * CMD`, `#!/bin/sh` scripts): the forked shell is the process
   * (`shell.kernelHost`), so programs it runs get its real fds and the tty.
   * A script uses the process's fds as its stdio (`shell.kernelStdio`,
   * src/shell-stdio.ts): builtins write to fd 1/2 as they go, `read` takes
   * one record from fd 0, other builtins read fd 0 only if they need it, and
   * programs get the fds themselves.
   */
  private async runShellProcess(proc: Process): Promise<number> {
    const shell = this.forkShell(proc);
    shell.kernelHost = { kernel: this, proc };
    // bash's options, before or after -c: `sh -c -l 'cmd'` (Claude Code), `bash -l -c 'cmd' a b`
    const name = (proc.argv[0] ?? 'sh').replace(/^.*\//, '').replace(/^-/, '') || 'sh';
    const opts = parseShellArgs(proc.argv.slice(1));
    if (opts.error) {
      await this.writeAll(proc, 2, enc.encode(`${name}: ${opts.error}\n`));
      return 2;
    }
    for (const o of opts.on) shell.options.add(o);
    for (const o of opts.off) shell.options.delete(o);
    for (const [o, on] of opts.shopts) { if (on) shell.shoptopts.add(o); else shell.shoptopts.delete(o); }
    if (opts.posix) shell.options.add('posix');
    const args = opts.rest;
    let script: string | undefined;
    let positional: string[] = [];
    // No command or script, and a terminal (or -i): an interactive shell (a tmux pane, screen window, `sh` from a program)
    if (!opts.command && (opts.interactive || ((args.length === 0 || opts.stdin) && proc.fds.get(0)?.kind === 'pty'))) {
      return this.interactiveShell(proc, shell);
    }
    if (opts.command) {
      if (!args.length) {
        await this.writeAll(proc, 2, enc.encode(`${name}: -c: option requires an argument\n`));
        return 2;
      }
      script = args[0];
      positional = args.length > 1 ? args.slice(1) : [];
    } else if (args.length && !opts.stdin) {
      try {
        const p = this.resolvePath(proc, args[0]);
        if (typeof p === 'number') throw new Error('bad path');
        const raw = await this.fs!.readFile(p);
        script = typeof raw === 'string' ? raw : A.decodeText(raw);
      } catch {
        await this.writeAll(proc, 2, enc.encode(`${name}: ${args[0]}: No such file or directory\n`));
        return 127;
      }
      positional = args;
    } else if (opts.stdin && args.length) {
      positional = [name, ...args]; // sh -s ARGS: $0 is the shell, the rest $1…
    }
    const stdio = new KernelStdio(this, proc);
    shell.kernelStdio = stdio;
    stdio.adoptFds(shell);
    // A script read from stdin has none left
    let live = true;
    if (script === undefined) {
      script = await stdio.readAll();
      live = false;
    }
    shell.kernelStdinLive = live;
    if (script.startsWith('#!')) script = script.slice(script.indexOf('\n') + 1);
    if (positional.length) shell.env['0'] = positional[0];
    let code: number;
    if (script.includes('\n')) {
      // Multi-line: compound statements accumulate across lines
      code = await shell.executeShellScript(script, positional.slice(1), { stdin: '', liveStdin: live } as CommandContext, stdio.out, stdio.err);
    } else {
      positional.slice(1).forEach((v, k) => { shell.env[String(k + 1)] = v; });
      shell.env['#'] = String(Math.max(0, positional.length - 1));
      shell.env['@'] = positional.slice(1).join(' ');
      code = await shell.execute(script, stdio.out, stdio.err, false, undefined, true);
    }
    await stdio.flush();
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
      chain = chain.then(async () => { if (!proc.exiting) await this.writeAll(proc, fd, encodeText(s.replace(/\r\n/g, '\n'))); });
    };
    // Jobs get process groups of their own and the terminal while they run (Ctrl-Z, fg, bg, jobs)
    const f0 = proc.fds.get(0);
    if (f0?.kind === 'pty') {
      const { ProcessTty } = await import('./pty');
      shell.kernelTty = { tty: new ProcessTty(proc, (f0 as PtyFile).pty), writeOutput: out(2) };
      shell.options.add('monitor');
    }
    const prompt = () => {
      const home = shell.env.HOME || '/home/user';
      const cwd = shell.cwd === home ? '~' : shell.cwd.startsWith(home + '/') ? '~' + shell.cwd.slice(home.length) : shell.cwd;
      return (shell.env.PS1 ?? '').replace(/\\([uhHwW$n\\])/g, (_, c: string) => ({
        u: shell.env.USER || 'user', h: this.hostname, H: this.hostname, w: cwd, W: cwd === '~' ? '~' : cwd.slice(cwd.lastIndexOf('/') + 1) || '/',
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
    // The shell uses this process's fds as its stdio (src/shell-stdio.ts)
    const stdio = new KernelStdio(this, proc);
    shell.kernelStdio = stdio;
    stdio.adoptFds(shell);
    shell.kernelStdinLive = true;
    const code = await shell.execute(line, stdio.out, stdio.err, false, undefined, true);
    await stdio.flush();
    return code;
  }

  private forkShell(proc: Process): Shell {
    const base = this.shell;
    if (!base) throw new Error('kernel has no shell attached');
    const shell = base.fork();
    shell.cwd = proc.cwd;
    shell.env = { ...proc.env, PWD: proc.cwd, 0: proc.argv[0] ?? proc.path };
    shell.localVars = new Set(['0']); // $0 is not exported
    // $$, $PPID and $BASHPID are the process's
    shell.shellPid = shell.bashPid = shell.kernelPid = proc.pid;
    shell.parentPid = proc.ppid;
    shell.uid = proc.uid;
    // Its fds are the process's (KernelStdio, adoptFds), not whatever exec did in the page's shell
    shell.userFds = new Map();
    shell.fileDescriptors = new Map();
    // A new process: only the page shell's `export -f` functions come along
    shell.dropUnexportedFunctions();
    // Its own abort, which its end fires. Not the page shell's: killing a
    // program's `sh -c` child would abort the page's foreground job, whose
    // abort SIGINTs that program's whole group (codex's "turn interrupted")
    const abort = new AbortController();
    shell.abortController = null;
    shell.inheritedAbort = abort;
    proc.onTerminate(() => abort.abort());
    return shell;
  }

  private async stdinText(proc: Process): Promise<string> {
    const f = proc.fds.get(0);
    if (!f) return '';
    if (f.kind === 'pipe' || f.kind === 'file' || f.kind === 'socket' || f instanceof BufferFile) {
      const r = await this.readAll(proc, 0);
      return typeof r === 'number' ? '' : decodeBytes(r);
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
      case A.SYS_close: {
        const f = proc.fds.get(args[0]);
        const r = proc.fds.closeSync(args[0]);
        if (f && r === 0) this.releaseLocks(proc, f);
        return r;
      }
      case A.SYS_open:
      case A.SYS_openat: {
        const [dirfd, len, flags, mode] = nr === A.SYS_open ? [A.AT_FDCWD, args[0], args[1], args[2]] : [args[0], args[1], args[2], args[3]];
        if (len < 0 || len > data.length) return undefined;
        const f = this.openSync(proc, A.decodeText(data.subarray(0, len)), flags, dirfd, mode);
        if (f === undefined || typeof f === 'number') return f;
        const fd = proc.fds.alloc(f, 0, !!(flags & A.O_CLOEXEC));
        if (fd < 0 && refCount(f) === 0) f.closeSync?.();
        return fd;
      }
      case A.SYS_unlink:
      case A.SYS_unlinkat: {
        const [dirfd, len, flg] = nr === A.SYS_unlink ? [A.AT_FDCWD, args[0], 0] : [args[0], args[1], args[2]];
        if (flg === A.AT_REMOVEDIR) return this.pathOpSync(proc, nr, args, data);
        if (flg !== 0 || len <= 0 || len > data.length) return undefined; // bad flags: the async path
        return this.unlinkSync(proc, A.decodeText(data.subarray(0, len)), dirfd);
      }
      case A.SYS_rmdir:
      case A.SYS_mkdir: case A.SYS_mkdirat:
      case A.SYS_rename: case A.SYS_renameat: case A.SYS_renameat2:
        return this.pathOpSync(proc, nr, args, data);
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
        A.encodeStat(statFor(proc, st), data);
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
      case A.SYS_getuid: return proc.ruid ?? proc.uid;
      case A.SYS_getgid: return proc.rgid ?? proc.gid;
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
    // A regular file never becomes ready: its tryRead/tryWrite fail only while a page of a big file must load (syscall loads it)
    if (!f || f.flags & A.O_NONBLOCK || f.kind === 'file') return undefined;
    if (nr === A.SYS_read) return f.tryRead ? f : undefined;
    return f.tryWrite && (args[1] >>> 0) <= A.PIPE_BUF ? f : undefined;
  }

  syscall(proc: Process, nr: number, args: ArrayLike<number>, data: Uint8Array): Promise<number> {
    // Time blocked inside syscalls is time the process isn't computing (/proc
    // CPU estimate); a quick call counts as CPU, as Linux's system time does
    const t0 = Date.now();
    proc.syscalls++;
    // While in a syscall the process counts as sleeping (S in /proc/PID/stat)
    if (proc.inSyscall++ === 0) proc.syscallSince = t0;
    const call = { nr, args };
    proc.calls.push(call);
    const done = () => {
      proc.inSyscall--;
      const ms = Date.now() - t0;
      if (ms >= 2) proc.kernelMs += ms;
      const i = proc.calls.indexOf(call);
      if (i >= 0) proc.calls.splice(i, 1);
    };
    // The caller awaits the call itself: the bookkeeping adds no await hop to it
    const p = this.syscallImpl(proc, nr, args, data);
    p.then(done, done);
    return p;
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

    // An O_PATH descriptor can't be read, written or changed through
    const pathFd = OPATH_FD_ARG[nr];
    if (pathFd !== undefined && ((file(args[pathFd])?.flags ?? 0) & A.O_PATH)) return -A.EBADF;

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
          // a signalfd reads the reading process's signals
          if (f instanceof SignalFile) return await f.readAs(proc, data.subarray(0, Math.min(args[1] >>> 0, data.length)), sig);
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
          if (!fn) return f.kind === 'dir' ? (nr === A.SYS_pread64 ? -A.EISDIR : -A.EBADF) : -A.ESPIPE;
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
        case A.SYS_close: {
          const f = file(args[0]);
          const r = await fds.close(args[0]);
          if (f && r === 0) this.releaseLocks(proc, f);
          return r;
        }
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
          A.encodeStat(statFor(proc, st), data);
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
          if (args[0] === args[1] || (args[2] & ~A.O_CLOEXEC)) return -A.EINVAL;
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
        case A.SYS_shmget: return this.shm.shmget(proc, args[0], (args[1] >>> 0) + (args[2] >>> 0) * 0x100000000, args[3]);
        case A.SYS_shmctl: return this.shm.shmctl(proc, args[0], args[1], data);
        case A.SYS_shiro_shmat: return this.shm.attach(proc, args[0], args[1], data);
        case A.SYS_shiro_shmdt: return this.shm.detach(proc, args[0]);
        case A.SYS_semget: return this.sem.semget(proc, args[0], args[1], args[2]);
        case A.SYS_semop: return await this.sem.semop(proc, args[0], args[1], data, -1, sig);
        case A.SYS_semtimedop: {
          // (semid, nsops, hasTimeout, tv_sec, tv_nsec): no timeout is semop
          if (!args[2]) return await this.sem.semop(proc, args[0], args[1], data, -1, sig);
          if (args[3] < 0 || args[4] < 0 || args[4] >= 1e9) return -A.EINVAL;
          return await this.sem.semop(proc, args[0], args[1], data, args[3] * 1000 + Math.floor(args[4] / 1e6), sig);
        }
        case A.SYS_semctl: return this.sem.semctl(proc, args[0], args[1], args[2], args[3], data);
        case A.SYS_shiro_siginfo: { // signo → the siginfo of the one of that number last taken (a handler's, sigwait's)
          const info = proc.lastSiginfo.get(args[0]);
          if (!info) return -A.ENOENT;
          A.encodeSiginfo(info, data);
          return 0;
        }
        case A.SYS_rt_sigqueueinfo:
        case A.SYS_rt_tgsigqueueinfo: { // (pid, sig) / (tgid, tid, sig); data = struct siginfo
          const pid = args[0] | 0, signo = nr === A.SYS_rt_sigqueueinfo ? args[1] : args[2];
          if (signo < 0 || signo > 64) return -A.EINVAL;
          const info = A.decodeSiginfo(data);
          const target = this.procs.get(pid);
          if (!target || (target.state === 'zombie' && signo !== 0)) return -A.ESRCH;
          // only the kernel may claim SI_USER, SI_TKILL or a kernel code for another process's signal
          if ((info.code >= 0 || info.code === A.SI_TKILL) && target !== proc) return -A.EPERM;
          if (!this.maySignal(proc, target, signo)) return -A.EPERM;
          if (signo === 0) return 0;
          this.deliver(target, signo, { signo, code: info.code, pid: info.pid, uid: info.uid, value: info.value });
          return 0;
        }
        case A.SYS_timer_create:
          return this.timers.create(proc, args[0] | 0, args[1] ? new DataView(data.buffer, data.byteOffset, 24) : null, (args[2] & 1) === 1);
        case A.SYS_timer_settime:
          return this.timers.settime(proc, args[0] | 0, args[1], new DataView(data.buffer, data.byteOffset, 32));
        case A.SYS_timer_gettime:
          return this.timers.gettime(proc, args[0] | 0, new DataView(data.buffer, data.byteOffset, 32));
        case A.SYS_timer_getoverrun: return this.timers.getoverrun(proc, args[0] | 0);
        case A.SYS_timer_delete: return this.timers.delete(proc, args[0] | 0);
        case A.SYS_mq_open: {
          const name = str(0, args[0]);
          const attr = args[3] ? new DataView(data.buffer, data.byteOffset + args[0], 32) : null;
          const f = this.mq.open(proc, name, args[1], args[2], attr);
          return typeof f === 'number' ? f : fds.alloc(f, 0, (args[1] & A.O_CLOEXEC) !== 0);
        }
        case A.SYS_mq_unlink: return this.mq.unlink(proc, str(0, args[0]));
        case A.SYS_mq_timedsend: {
          const f = file(args[0]);
          if (!(f instanceof MqFile)) return -A.EBADF;
          const len = args[1] >>> 0;
          const ts = args[3] ? new DataView(data.buffer, data.byteOffset + len, 16) : null;
          return await this.mq.send(proc, f, data.subarray(0, len), args[2] >>> 0, ts, sig);
        }
        case A.SYS_mq_timedreceive: {
          const f = file(args[0]);
          if (!(f instanceof MqFile)) return -A.EBADF;
          const len = args[1] >>> 0;
          const ts = args[2] ? new DataView(data.buffer.slice(data.byteOffset, data.byteOffset + 16)) : null;
          const r = await this.mq.receive(f, data.subarray(8, 8 + len), ts, sig);
          if (typeof r === 'number') return r;
          new DataView(data.buffer, data.byteOffset, 8).setUint32(0, r.prio, true);
          return r.n;
        }
        case A.SYS_mq_notify: {
          const f = file(args[0]);
          if (!(f instanceof MqFile)) return -A.EBADF;
          return this.mq.notify(proc, f, args[1] ? new DataView(data.buffer, data.byteOffset, 16) : null);
        }
        case A.SYS_mq_getsetattr: {
          const f = file(args[0]);
          if (!(f instanceof MqFile)) return -A.EBADF;
          const next = args[1] ? new DataView(data.buffer.slice(data.byteOffset, data.byteOffset + 32)) : null;
          return this.mq.getsetattr(f, next, new DataView(data.buffer, data.byteOffset, 32));
        }
        case A.SYS_msgget: return this.msg.msgget(proc, args[0], args[1]);
        case A.SYS_msgsnd: return await this.msg.msgsnd(proc, args[0], args[1], args[2], data, sig);
        case A.SYS_msgrcv: return await this.msg.msgrcv(proc, args[0], args[1], i64(args[2], args[3]), args[4], data, sig);
        case A.SYS_msgctl: return this.msg.msgctl(proc, args[0], args[1], data);
        case A.SYS_shiro_shmobj_map: {
          const instance = proc.data.engineInstance as number | undefined;
          if (!instance) return -A.ENOSYS;
          const len = (args[2] >>> 0) + (args[3] >>> 0) * 0x100000000;
          let key: string, size = len;
          let initial: (() => Uint8Array | Promise<Uint8Array>) | undefined;
          let writeBack: ((b: Uint8Array) => void | Promise<void>) | undefined;
          let onRemote: ((sab: SharedArrayBuffer) => void) | undefined;
          const kind = args[1] & ~A.SHMOBJ_EAGER;
          if (kind & ~0xff) return -A.EINVAL;
          const f = kind === 0 ? proc.fds.get(args[0]) : undefined;
          if (kind === 0 && f instanceof MemFile) {
            // A memfd (Firefox's font list, passed over SCM_RIGHTS): keyed by
            // the description; read/write go through the buffer while remote
            const mf = f;
            key = mf.shareKey;
            size = Math.max(len, mf.statSync().size);
            initial = () => mf.bytes();
            onRemote = (sab) => mf.attachShared(sab, sab.byteLength - CONTROL_BYTES); // (not the control page)
            writeBack = (b) => mf.detachShared(b);
          } else if (kind === 0) {
            if (!f) return -A.EBADF;
            const path = f.path;
            if (f.kind !== 'file' || !path || !isShareablePath(path) || !this.fs) return -A.EINVAL;
            const fs = this.fs;
            const ino = inodeNumber(fs, path);
            // (unlinked before it was mapped: its own inode is the object, not its old name's)
            // (mapped before the unlink, it still is that object)
            const attached = sharedBufferOf(f);
            const existing = attached ? this.shmobj.keyOfBuffer(attached) : undefined;
            const unlinkedKey = existing ? undefined : unlinkedFileKey(f);
            key = existing ?? unlinkedKey ?? `file:${ino}`;
            // (through the fd: writes it holds may not have reached the filesystem yet)
            initial = async () => {
              if (f.pread) {
                const b = new Uint8Array((await f.stat()).size);
                return b.subarray(0, Math.max(0, await f.pread(b, 0)));
              }
              const b = await fs.readFile(path);
              return typeof b === 'string' ? new TextEncoder().encode(b) : b;
            };
            // While remote, the file's fds read and write the buffer (not the control page)
            onRemote = (sab) => attachInodeShared(fs, path, sab, sab.byteLength - CONTROL_BYTES, f);
            // The bytes go to the file and to the names link() gave its inode
            // number (it copies): glibc's sem_open maps a temporary file,
            // links it to the semaphore's name and unlinks it (Open POSIX
            // sem_close_3-2)
            writeBack = async (b) => {
              // An unlinked object's bytes stay with its fds (the name may be another file's now)
              if (unlinkedKey) { detachOpenFileShared(f); return; }
              const dir = path.slice(0, path.lastIndexOf('/')) || '/';
              // (only names still this inode: unlinked since the map, the name may be a new file's)
              const names = new Set(fs.inoOf(path) === ino ? [path] : []);
              try {
                for (const e of await fs.readdir(dir)) if (fs.inoOf(`${dir}/${e}`) === ino) names.add(`${dir}/${e}`);
              } catch { /* (the directory is gone) */ }
              for (const p of names) if (!(await writeInodeBytes(fs, p, b)) && await fs.exists(p)) await fs.writeFile(p, b);
              detachOpenFileShared(f); // (the fd's inode may not be the path's: unlinked since the map)
            };
          } else if (kind === 1) {
            const seg = this.shm.list().find((x) => x.id === args[0]);
            if (!seg) return -A.EINVAL;
            key = `shm:${seg.id}`;
            size = seg.size;
          } else return -A.EINVAL;
          const r = await this.shmobj.map(instance, key, size, initial, writeBack, { eager: !!(args[1] & A.SHMOBJ_EAGER), onRemote });
          if (typeof r === 'number') return r;
          if (data.length >= 4) new DataView(data.buffer, data.byteOffset, 4).setInt32(0, r.remote ? 1 : 0, true);
          return r.id;
        }
        case A.SYS_shiro_shmobj_unmap: {
          const instance = proc.data.engineInstance as number | undefined;
          return instance ? await this.shmobj.unmap(instance, args[0]) : -A.ENOSYS;
        }
        case A.SYS_shiro_shmobj_published: {
          const instance = proc.data.engineInstance as number | undefined;
          return instance ? this.shmobj.published(instance, args[0]) : -A.ENOSYS;
        }
        case A.SYS_setuid: case A.SYS_setgid: case A.SYS_setreuid: case A.SYS_setregid:
        case A.SYS_setresuid: case A.SYS_setresgid: case A.SYS_getresuid: case A.SYS_getresgid:
        case A.SYS_getgroups: case A.SYS_setgroups: case A.SYS_setfsuid: case A.SYS_setfsgid:
          return setCredentials(proc, nr, args, data);
        case A.SYS_eventfd:
        case A.SYS_eventfd2: {
          const flags = nr === A.SYS_eventfd2 ? args[1] : 0;
          if (flags & ~(A.O_NONBLOCK | A.O_CLOEXEC | A.EFD_SEMAPHORE)) return -A.EINVAL;
          return fds.alloc(new EventFile(args[0], A.O_RDWR | (flags & A.O_NONBLOCK), !!(flags & A.EFD_SEMAPHORE)), 0, !!(flags & A.O_CLOEXEC));
        }
        case A.SYS_signalfd:
        case A.SYS_signalfd4: {
          // fd (-1: a new one), sizeof(sigset_t) (8), flags; data = the sigset
          const flags = nr === A.SYS_signalfd4 ? args[2] : 0;
          if (flags & ~(A.SFD_NONBLOCK | A.SFD_CLOEXEC)) return -A.EINVAL;
          if (args[1] !== 8) return -A.EINVAL;
          const dv = new DataView(data.buffer, data.byteOffset, 8);
          const mask = A.sigsetFromWords(dv.getUint32(0, true), dv.getUint32(4, true));
          if ((args[0] | 0) !== -1) {
            const f = file(args[0]);
            if (!f) return -A.EBADF;
            if (!(f instanceof SignalFile)) return -A.EINVAL;
            f.setMask(mask);
            return args[0];
          }
          return fds.alloc(new SignalFile(proc, mask, flags & A.SFD_NONBLOCK), 0, !!(flags & A.SFD_CLOEXEC));
        }
        case A.SYS_timerfd_create: {
          const clock = args[0], flags = args[1];
          if (![0, 1, 7, 8, 9].includes(clock)) return -A.EINVAL;  // REALTIME, MONOTONIC, BOOTTIME (+_ALARM)
          if (flags & ~(A.O_NONBLOCK | A.O_CLOEXEC)) return -A.EINVAL;
          return fds.alloc(new TimerFile(clock, A.O_RDONLY | (flags & A.O_NONBLOCK)), 0, !!(flags & A.O_CLOEXEC));
        }
        case A.SYS_timerfd_settime:
        case A.SYS_timerfd_gettime: {
          const f = fds.get(args[0]);
          if (!f) return -A.EBADF;
          if (!(f instanceof TimerFile)) return -A.EINVAL;
          if (data.length < 32) return -A.EFAULT;
          const dv = new DataView(data.buffer, data.byteOffset, 32);
          if (nr === A.SYS_timerfd_gettime) {
            const [v, i] = f.get();
            dv.setFloat64(0, v, true);
            dv.setFloat64(8, i, true);
            return 0;
          }
          if (args[1] & ~A.TFD_TIMER_ABSTIME) return -A.EINVAL;
          let value = dv.getFloat64(0, true);
          const interval = dv.getFloat64(8, true);
          if (!(value >= 0) || !(interval >= 0)) return -A.EINVAL;
          if (value > 0 && args[1] & A.TFD_TIMER_ABSTIME) {
            // absolute on the timer's clock; at or before now expires at once
            const now = dv.getFloat64(f.clockid === 0 || f.clockid === 8 ? 16 : 24, true);
            value = Math.max(value - now, 1e-6);
          }
          const [ov, oi] = f.set(value, interval);
          dv.setFloat64(0, ov, true);
          dv.setFloat64(8, oi, true);
          return 0;
        }
        case A.SYS_close_range: {
          const first = args[0] >>> 0;
          const last = args[1] >>> 0;
          if (first > (args[1] >>> 0)) return -A.EINVAL;
          for (const [fd] of fds.entries()) {
            if (fd < first || fd > last) continue;
            if (args[2] & 4 /* CLOSE_RANGE_CLOEXEC */) fds.setCloexec(fd, true);
            else await fds.close(fd);
          }
          return 0;
        }
        case A.SYS_shiro_vfork: {
          // the child is running code (its engine's), not idle like a builtin that makes no syscalls;
          // args[0] CLONE_PARENT: the child is the caller's sibling (its parent's child)
          const child = this.vfork(proc, (args[0] & A.CLONE_PARENT) !== 0);
          child.syscalls = 1;
          return child.pid;
        }
        case A.SYS_shiro_execve:
          return await this.sysExecve(proc, JSON.parse(str(0, args[0])), data);
        case A.SYS_alarm: {
          // seconds left on the old alarm, rounded like Linux
          const old = this.setRealTimer(proc, (args[0] >>> 0) * 1000, 0);
          return old.value > 0 ? Math.max(1, Math.round(old.value / 1000)) : 0;
        }
        case A.SYS_getitimer:
        case A.SYS_setitimer: {
          // ITIMER_REAL, ITIMER_VIRTUAL, ITIMER_PROF; struct itimerval in
          // data: interval then value, each {i64 sec, i64 usec}
          if (args[0] !== 0 && args[0] !== 1 && args[0] !== 2) return -A.EINVAL;
          const dv = new DataView(data.buffer, data.byteOffset, 32);
          const ms = (o: number) => Number(dv.getBigInt64(o, true)) * 1000 + Number(dv.getBigInt64(o + 8, true)) / 1000;
          const put = (o: number, v: number) => {
            const us = Math.max(0, Math.round(v * 1000));
            dv.setBigInt64(o, BigInt(Math.floor(us / 1e6)), true);
            dv.setBigInt64(o + 8, BigInt(us % 1e6), true);
          };
          const old = nr === A.SYS_setitimer ? this.setRealTimer(proc, ms(16), ms(0), args[0]) : this.realTimer(proc, args[0]);
          put(0, old.interval);
          put(16, old.value);
          return 0;
        }
        case A.SYS_getpid: return proc.pid;
        case A.SYS_gettid: return proc.pid;
        case A.SYS_getppid: return proc.ppid;
        case A.SYS_getuid: return proc.ruid ?? proc.uid;
        case A.SYS_getgid: return proc.rgid ?? proc.gid;
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
          // WNOHANG, WUNTRACED, WCONTINUED, WNOWAIT (waitid comes through here), __WNOTHREAD/__WALL/__WCLONE
          if ((args[1] >>> 0) & ~(A.WNOHANG | A.WUNTRACED | A.WCONTINUED | A.WNOWAIT | 0xe0000000)) return -A.EINVAL;
          // pid INT_MIN can't be negated into a process group
          if ((args[0] | 0) === -0x80000000) return -A.ESRCH;
          const r = await this.waitpid(args[0], args[1], proc, sig);
          if (r.pid > 0) new DataView(data.buffer, data.byteOffset, 4).setInt32(0, r.status, true);
          // then the reaped child's CPU time in µs (Blink 0509 fills wait4's rusage with it)
          if (r.pid > 0 && data.length >= 12) new DataView(data.buffer, data.byteOffset + 4, 8).setBigInt64(0, BigInt(Math.round((r.cpuMs ?? 0) * 1000)), true);
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
            // Blink (patch 0507) sends what all its threads block with
            // args[3] = 1, and keeps their handlers' masks itself: a signal
            // handed over meanwhile (takeSignal's frame, until host.mjs's
            // rt_sigreturn) must not bring back the mask from before. (A
            // signal this unblocks can be taken within setSigmask, adding
            // itself to the mask until that rt_sigreturn: copy it first.)
            const mask = args[3] & 1 ? [...next] : null;
            this.setSigmask(proc, next);
            if (mask) proc.signalFrames = proc.signalFrames.map(() => new Set(mask));
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
        case A.SYS_rt_sigtimedwait: {
          // args: timeout ms (-1: none); data: the set in, siginfo out. Takes the
          // lowest pending blocked signal in the set without running a handler
          // (sigwait, sigwaitinfo, sigtimedwait); EAGAIN at the timeout, EINTR
          // when a signal the caller lets through arrives
          const dv = new DataView(data.buffer, data.byteOffset, A.SIGINFO_SIZE);
          const want = A.sigsetFromWords(dv.getUint32(0, true), dv.getUint32(4, true));
          want.delete(A.SIGKILL);
          want.delete(A.SIGSTOP);
          const next = () => { let b = 0; for (const s of proc.deferredSignals) if (want.has(s) && (!b || s < b)) b = s; return b; };
          const ms = args[0] | 0;
          const end = ms >= 0 ? Date.now() + ms : Infinity;
          let got: number;
          // While it waits, the set's signals are the wait's even when not
          // blocked (Linux's real_blocked): they're held, not handled. The
          // caller's mask comes back after, delivering any others that came.
          const unblocked = [...want].filter((s) => !proc.sigmask.has(s));
          if (unblocked.length) for (const s of unblocked) proc.sigmask.add(s);
          try {
            while (!(got = next())) {
              const left = end - Date.now();
              if (left <= 0) return -A.EAGAIN;
              const wakes = new Set<() => void>();
              const off = pendingSignalListeners(proc).add(() => { for (const w of [...wakes]) w(); });
              const timer = end === Infinity ? undefined : setTimeout(() => { for (const w of [...wakes]) w(); }, left);
              const ok = await abortableWait(wakes, sig);
              off();
              if (timer !== undefined) clearTimeout(timer);
              if (!ok) return -A.EINTR;
            }
            // one instance (a real-time signal may have more queued), with what it carries
            A.encodeSiginfo(proc.takeSiginfo(got, proc.deferredSignals), data);
          } finally {
            if (unblocked.length) { const m = new Set(proc.sigmask); for (const s of unblocked) m.delete(s); this.setSigmask(proc, m); }
          }
          return got;
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
          return this.fcntl(proc, args[0], args[1], args[2], data);
        case A.SYS_fsync: { // (and fdatasync: Blink sends both here)
          const f = file(args[0]);
          if (!f) return -A.EBADF;
          // a pipe, FIFO or socket has nothing to sync: EINVAL (Open POSIX fsync_7-1)
          const type = (await f.stat()).mode & A.S_IFMT;
          if (type === A.S_IFIFO || type === A.S_IFSOCK) return -A.EINVAL;
          try { await f.sync?.(); } catch (e) { return A.errnoFromError(e); }
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
          // The cwd is the physical directory: getcwd after chdir through a symlink names the target
          p = await fs().realpath(p).catch(() => p as string);
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
          const src = await this.statPath(proc, from, false);
          if (typeof src === 'number') return src;
          const srcDir = (src.mode & A.S_IFMT) === A.S_IFDIR;
          // "name/" on either side only names a directory
          if (!srcDir && (trailingSlash(str(0, ol)) || trailingSlash(str(ol, nl)))) return -A.ENOTDIR;
          if (from === to) return 0;
          if (srcDir && to.startsWith(from === '/' ? '/' : from + '/')) return -A.EINVAL;
          const dst = await this.statPath(proc, to, false);
          if (typeof dst !== 'number') {
            if (flags & A.RENAME_NOREPLACE) return -A.EEXIST;
            const dstDir = (dst.mode & A.S_IFMT) === A.S_IFDIR;
            if (srcDir && !dstDir) return -A.ENOTDIR;
            if (!srcDir && dstDir) return -A.EISDIR;
            // A directory replaces only an empty one
            if (dstDir) await fs().rmdir(to);
          }
          // Open files follow the rename (their buffered data must not land at the old path)
          const moved = await renameInodes(fs(), from, to);
          await fs().rename(from, to);
          moved();
          forgetInodeNumber(fs(), to);
          renameLinkName(from, to);
          if (this.socketPaths?.delete(from)) this.socketPaths.add(to);
          return 0;
        }
        case A.SYS_mknod:
        case A.SYS_mknodat: {
          const [dirfd, len, mode] = nr === A.SYS_mknod ? [A.AT_FDCWD, args[0], args[1]] : [args[0], args[1], args[2]];
          const p = at(dirfd, 0, len);
          if (typeof p === 'number') return p;
          const type = mode & A.S_IFMT;
          if (type !== A.S_IFIFO && type !== A.S_IFREG && type !== 0) return -A.EPERM; // device nodes need privileges
          if (await fs().exists(p)) return -A.EEXIST;
          const perm = mode & ~proc.umask & 0o7777;
          if (type === A.S_IFIFO) await fs().mkfifo(p, perm);
          else await fs().writeFile(p, new Uint8Array(0), { mode: perm });
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
          this.noteDirMode(p, mode & ~proc.umask);
          return 0;
        }
        case A.SYS_rmdir:
        case A.SYS_unlink:
        case A.SYS_unlinkat: {
          if (nr === A.SYS_unlinkat && (args[2] & ~A.AT_REMOVEDIR)) return -A.EINVAL;
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
          // unlink("name/"): a directory (through a symlink too) is EISDIR, anything else ENOTDIR
          if (!rmdir && trailingSlash(str(0, len))) {
            const t = await this.statPath(proc, p, true);
            return typeof t !== 'number' && (t.mode & A.S_IFMT) === A.S_IFDIR ? -A.EISDIR : -A.ENOTDIR;
          }
          if (isDir) await fs().rmdir(p);
          else { await unlinkInode(fs(), p); await fs().unlink(p); forgetInodeNumber(fs(), p); this.socketPaths?.delete(p); this.fifos.delete(p); }
          return 0;
        }
        case A.SYS_symlink:
        case A.SYS_symlinkat: {
          const [tl, dirfd, ll] = nr === A.SYS_symlink ? [args[0], A.AT_FDCWD, args[1]] : [args[0], args[1], args[2]];
          const target = str(0, tl);
          if (!target) return -A.ENOENT;
          const p = at(dirfd, tl, ll);
          if (typeof p === 'number') return p;
          if (await fs().exists(p)) return -A.EEXIST;
          if (trailingSlash(str(tl, ll))) return -A.ENOENT;
          await fs().symlink(target, p);
          return 0;
        }
        case A.SYS_link:
        case A.SYS_linkat: {
          // The filesystem has no hard links (no inodes shared between names):
          // link() makes a copy that reports its source's inode number, as a
          // hard link would (git's local clone checks that). dpkg needs link()
          // to succeed for its backups (status-old, FILE.dpkg-tmp before
          // replacing FILE); a copy has the content those need.
          const [od, ol, nd, nl, lflags] = nr === A.SYS_link
            ? [A.AT_FDCWD, args[0], A.AT_FDCWD, args[1], 0] : [args[0], args[1], args[2], args[3], args[4]];
          if (lflags & ~(A.AT_SYMLINK_FOLLOW | A.AT_EMPTY_PATH)) return -A.EINVAL;
          const from = at(od, 0, ol);
          const to = at(nd, ol, nl);
          if (typeof from === 'number') return from;
          if (typeof to === 'number') return to;
          const follow = !!(lflags & A.AT_SYMLINK_FOLLOW);
          const st = await this.statPath(proc, str(0, ol), follow, od);
          if (typeof st === 'number') return st;
          if (await fs().exists(to)) return -A.EEXIST;
          if (trailingSlash(str(ol, nl))) return -A.ENOENT;
          const type = st.mode & A.S_IFMT;
          if (type === A.S_IFDIR) return -A.EPERM;
          try {
            const src = follow ? await fs().realpath(from) : from;
            if (type === A.S_IFLNK) {
              await fs().symlink(await fs().readlink(src), to);
            } else {
              await flushInode(fs(), src);
              const raw = await fs().readFile(src);
              const bytes = typeof raw === 'string' ? enc.encode(raw) : raw.slice();
              await fs().writeFile(to, bytes, { mode: st.mode & 0o7777, times: { mtime: st.mtimeMs, mtimeNs: st.mtimeNs } });
            }
            shareInodeNumber(fs(), src, to);
          } catch (e) {
            return A.errnoFromError(e);
          }
          return 0;
        }
        case A.SYS_readlink:
        case A.SYS_readlinkat: {
          const [dirfd, len, bufsiz] = nr === A.SYS_readlink ? [A.AT_FDCWD, args[0], args[1]] : [args[0], args[1], args[2]];
          const p = at(dirfd, 0, len);
          if (typeof p === 'number') return p;
          let target: string;
          const proct = p.startsWith('/proc/') ? this.procfs.readlink(proc, p) : undefined;
          if (typeof proct === 'number') return proct;
          if (proct !== undefined) {
            target = proct;
            // /proc/<pid>/exe is the resolved path, as on Linux (ld.so's $ORIGIN;
            // a venv's bin/python is a symlink). procfs only resolves from the cache.
            if (/^\/proc\/[^/]+\/exe$/.test(p)) target = await this.exePath(proc, p, target);
          } else if (this.isDevicePath(p)) return -A.EINVAL; // a device node or /dev, /dev/pts: not links
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
          else if (args[1] === 0 && args[0] >= 0) {
            // fchmodat2(fd, "", mode, AT_EMPTY_PATH) (Blink passes it without
            // the flags): systemd's fchmod_opath on an O_PATH descriptor
            const f = file(args[0]);
            if (!f) return -A.EBADF;
            if (!f.path) return -A.EINVAL;
            p = f.path;
            mode = args[2];
          } else { p = at(args[0], 0, args[1]); mode = args[2]; }
          if (typeof p === 'number') return p;
          // chmod("/proc/self/fd/N"): the file the descriptor has open (glibc's
          // and systemd's fallback for O_PATH descriptors)
          let path: string = p;
          for (let hops = 0; hops < 8 && (path.startsWith('/proc/') || path.startsWith('/dev/fd/')); hops++) {
            const fdm = /^\/dev\/fd\/(\d+)$/.exec(path);
            const link: string | undefined = fdm ? proc.fds.get(Number(fdm[1]))?.path : this.procfs.linkTarget(proc, path);
            if (!link || link === path) break;
            path = link;
          }
          const real = await fs().realpath(path);
          await flushInode(fs(), real);
          await fs().chmod(real, mode & 0o7777);
          this.noteDirMode(real, mode);
          setInodeMode(fs(), real, mode);
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
          const follow = !(args[2] & A.AT_SYMLINK_NOFOLLOW);
          // An open file's times are its inode's until written back
          if (follow) await flushInode(fs(), await fs().realpath(p).catch(() => p));
          const st = await this.statPath(proc, p, follow);
          if (typeof st === 'number') return st;
          const now = Date.now();
          let atime = { ms: now, ns: 0 }, mtime = { ms: now, ns: 0 };
          if (args[3]) {
            const dv = new DataView(data.buffer, data.byteOffset + args[1], 32);
            const ts = (o: number, ms: number, ns = 0) => {
              const nsec = dv.getUint32(o + 8, true);
              if (nsec === A.UTIME_NOW) return { ms: now, ns: 0 };
              if (nsec === A.UTIME_OMIT) return { ms, ns };
              if (nsec >= 1e9 || dv.getUint32(o + 12, true)) return null;
              return { ms: i64(dv.getUint32(o, true), dv.getUint32(o + 4, true)) * 1000 + Math.floor(nsec / 1e6), ns: nsec % 1e6 };
            };
            const a = ts(0, st.atimeMs, st.atimeNs), m = ts(16, st.mtimeMs, st.mtimeNs);
            if (!a || !m) return -A.EINVAL;
            atime = a; mtime = m;
          }
          const target = follow ? await fs().realpath(p) : p;
          await setInodeTimes(fs(), target, { atimeMs: atime.ms, atimeNs: atime.ns, mtimeMs: mtime.ms, mtimeNs: mtime.ns });
          await fs().utimes(target, atime.ms, mtime.ms, { atime: atime.ns, mtime: mtime.ns });
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
        case A.SYS_syslog: {
          // Reading the whole log and its size is open to everyone (dmesg_restrict=0); the rest needs root
          const type = args[0];
          const open = type === SYSLOG_ACTION_READ_ALL || type === SYSLOG_ACTION_SIZE_BUFFER || type === SYSLOG_ACTION_SIZE_UNREAD || type <= 1;
          if (!open && proc.uid !== 0) return -A.EPERM;
          return await klog.syslogAction(type, data, args[1] | 0, sig);
        }
        case A.SYS_sysinfo: { // → struct sysinfo: the memory free and /proc/meminfo report (src/utils/sysinfo.ts)
          if (data.length < A.SYSINFO_SIZE) return -A.EFAULT;
          const v = new DataView(data.buffer, data.byteOffset, A.SYSINFO_SIZE);
          data.fill(0, 0, A.SYSINFO_SIZE);
          const mem = memoryInfo();
          const loads = this.procfs.loadavg();
          v.setBigInt64(0, BigInt(Math.floor((Date.now() - bootMs) / 1000)), true); // uptime
          for (let i = 0; i < 3; i++) v.setBigUint64(8 + i * 8, BigInt(Math.round(loads[i] * 65536)), true); // loads[3], 1<<16 fixed point
          v.setBigUint64(32, BigInt(mem.total), true); // totalram
          v.setBigUint64(40, BigInt(mem.free), true); // freeram
          v.setUint16(80, Math.min(0xffff, this.procs.size), true); // procs
          v.setUint32(104, 1, true); // mem_unit
          return 0;
        }
        case A.SYS_memfd_create: { // nameLen, flags; data = name → an fd on an anonymous in-memory file
          const name = str(0, args[0]);
          if (name.length > 249) return -A.EINVAL;
          if (args[1] & ~(A.MFD_CLOEXEC | A.MFD_ALLOW_SEALING)) return -A.EINVAL;
          const file = new MemFile(`/memfd:${name} (deleted)`);
          if (args[1] & A.MFD_ALLOW_SEALING) file.seals = 0;
          return fds.alloc(file, 0, (args[1] & A.MFD_CLOEXEC) !== 0);
        }
        case A.SYS_prlimit64: { // pid, resource, set → data: old {cur, max} (u64s); a new one first when set
          // RLIMIT_NOFILE only (the fd table's): engines keep the other limits
          if (args[1] !== A.RLIMIT_NOFILE) return -A.EINVAL;
          const target = args[0] ? this.procs.get(args[0]) : proc;
          if (!target) return -A.ESRCH;
          if (data.length < 16) return -A.EFAULT;
          const dv = new DataView(data.buffer, data.byteOffset, 16);
          const t = target.fds;
          const old = [t.limit, t.hardLimit];
          if (args[2]) {
            const big = (o: number) => { const v = dv.getBigUint64(o, true); return v > BigInt(A.NR_OPEN) ? Infinity : Number(v); };
            const cur = big(0), max = big(8);
            if (cur > max) return -A.EINVAL;
            // nothing above fs.nr_open; raising the hard limit takes root
            if (max > A.NR_OPEN || (max > t.hardLimit && proc.uid !== 0)) return -A.EPERM;
            t.limit = cur; t.hardLimit = max;
          }
          dv.setBigUint64(0, BigInt(old[0]), true);
          dv.setBigUint64(8, BigInt(old[1]), true);
          return 0;
        }
        case A.SYS_uname: { // → struct utsname (engines that report their own machine take the names from here)
          if (data.length < A.UTSNAME_FIELD * 6) return -A.EFAULT;
          const fields = ['Linux', this.hostname, unameRelease(this.hostname), UNAME_VERSION, 'x86_64', '(none)'];
          data.fill(0, 0, A.UTSNAME_FIELD * 6);
          fields.forEach((f, i) => data.set(enc.encode(f).subarray(0, A.UTSNAME_FIELD - 1), i * A.UTSNAME_FIELD));
          return 0;
        }
        case A.SYS_getdents64:
          return await this.getdents(proc, args[0], data.subarray(0, Math.min(args[1] >>> 0, data.length)));
        case A.SYS_spawn:
          return await this.sysSpawn(proc, JSON.parse(str(0, args[0])));
        case A.SYS_shiro_sleeping: {
          const was = proc.engineSleeps;
          proc.engineSleeps = Math.max(0, proc.engineSleeps + (args[0] | 0));
          if (!was && proc.engineSleeps) proc.engineSleepSince = Date.now();
          else if (was && !proc.engineSleeps) proc.kernelMs += Date.now() - proc.engineSleepSince;
          return 0;
        }
        case A.SYS_shiro_cputimes: {
          // the caller's CPU time and its reaped children's, in µs (times, getrusage)
          if (data.length < 16) return -A.EINVAL;
          const dv = new DataView(data.buffer, data.byteOffset, 16);
          dv.setBigInt64(0, BigInt(Math.round(ProcFs.cpuMs(proc) * 1000)), true);
          dv.setBigInt64(8, BigInt(Math.round(proc.childCpuMs * 1000)), true);
          return 0;
        }
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
        proc.dropSignal(signum);
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

  /** Closing any fd for a file drops the process's POSIX locks on it; the last close of a description, its OFD locks */
  private releaseLocks(proc: Process, f: OpenFile): void {
    if (f.path) this.locks.release(proc.pid, f.path);
    if (refCount(f) === 0) this.locks.release(f);
  }

  /** fcntl record locks; `data` holds the struct flock (l_type, l_whence, l_start, l_len, l_pid) */
  private async recordLock(proc: Process, f: OpenFile, cmd: number, data?: Uint8Array): Promise<number> {
    if (!data || data.length < A.FLOCK_SIZE) return -A.EFAULT;
    const dv = new DataView(data.buffer, data.byteOffset, A.FLOCK_SIZE);
    const type = dv.getInt16(0, true), whence = dv.getInt16(2, true);
    const start = Number(dv.getBigInt64(8, true)), len = Number(dv.getBigInt64(16, true));
    if (type !== F_RDLCK && type !== F_WRLCK && type !== F_UNLCK) return -A.EINVAL;
    const ofd = cmd === A.F_OFD_GETLK || cmd === A.F_OFD_SETLK || cmd === A.F_OFD_SETLKW;
    if (ofd && dv.getInt32(24, true) !== 0) return -A.EINVAL;
    const set = cmd !== A.F_GETLK && cmd !== A.F_OFD_GETLK;
    const acc = f.flags & A.O_ACCMODE;
    if (set && ((type === F_RDLCK && acc === A.O_WRONLY) || (type === F_WRLCK && acc === A.O_RDONLY))) return -A.EBADF;
    let base = 0;
    if (whence === A.SEEK_CUR) base = f.seek?.(0, A.SEEK_CUR) ?? 0;
    else if (whence === A.SEEK_END) base = (await f.stat()).size;
    else if (whence !== A.SEEK_SET) return -A.EINVAL;
    let lo = base + start, hi = len > 0 ? lo + len : len === 0 ? Infinity : lo;
    if (len < 0) lo += len;
    if (lo < 0) return -A.EINVAL;
    const path = f.path ?? `anon:${proc.pid}:${fileKey(f)}`;
    const owner = ofd ? f : proc.pid;
    if (!set) {
      const l = this.locks.get(path, owner, type, lo, hi);
      dv.setInt16(0, l ? l.type : F_UNLCK, true);
      if (l) {
        dv.setInt16(2, A.SEEK_SET, true);
        dv.setBigInt64(8, BigInt(l.start), true);
        dv.setBigInt64(16, BigInt(l.end === Infinity ? 0 : l.end - l.start), true);
        dv.setInt32(24, l.pid, true);
      }
      return 0;
    }
    const wait = cmd === A.F_SETLKW || cmd === A.F_OFD_SETLKW;
    return this.locks.set(path, owner, ofd ? -1 : proc.pid, type, lo, hi, wait, proc.syscallSignal);
  }

  private fcntl(proc: Process, fd: number, cmd: number, arg: number, data?: Uint8Array): number | Promise<number> {
    const fds = proc.fds;
    const f = fds.get(fd);
    if (!f) return -A.EBADF;
    switch (cmd) {
      case A.F_GETLK: case A.F_SETLK: case A.F_SETLKW:
      case A.F_OFD_GETLK: case A.F_OFD_SETLK: case A.F_OFD_SETLKW:
        return this.recordLock(proc, f, cmd, data);
      case A.F_DUPFD: return fds.dup(fd, arg);
      case A.F_DUPFD_CLOEXEC: return fds.dup(fd, arg, true);
      case A.F_GETFD: return fds.getCloexec(fd) ? A.FD_CLOEXEC : 0;
      case A.F_SETFD: return fds.setCloexec(fd, !!(arg & A.FD_CLOEXEC));
      // a socket is open for reading and writing (Linux reports O_RDWR)
      case A.F_GETFL: return f.kind === 'socket' ? (f.flags & ~A.O_ACCMODE) | A.O_RDWR : f.flags;
      case A.F_SETFL: {
        const mask = A.O_NONBLOCK | A.O_APPEND;
        f.flags = (f.flags & ~mask) | (arg & mask);
        return 0;
      }
      case A.F_GETPIPE_SZ:
      case A.F_SETPIPE_SZ: {
        if (!(f instanceof PipeEnd)) return -A.EBADF;
        if (cmd === A.F_GETPIPE_SZ) return f.pipe.capacity;
        const size = arg | 0;
        if (size < 0) return -A.EINVAL;
        if (size > A.PIPE_MAX_SIZE) return -A.EPERM;
        return f.pipe.resize(size);
      }
      case A.F_ADD_SEALS:
      case A.F_GET_SEALS: {
        // memfds only (Linux: shmem files; anything else is EINVAL)
        if (!(f instanceof MemFile)) return -A.EINVAL;
        if (cmd === A.F_GET_SEALS) return f.seals;
        const known = A.F_SEAL_SEAL | A.F_SEAL_SHRINK | A.F_SEAL_GROW | A.F_SEAL_WRITE | A.F_SEAL_FUTURE_WRITE;
        if (arg & ~known) return -A.EINVAL;
        if ((f.flags & A.O_ACCMODE) === A.O_RDONLY) return -A.EPERM;
        if (f.seals & A.F_SEAL_SEAL) return -A.EPERM;
        f.seals |= arg;
        return 0;
      }
      default: return -A.EINVAL;
    }
  }

  /** poll(2) over `nfds` struct pollfd entries at the start of `data`. timeout < 0 waits forever. */
  async poll(proc: Process, data: Uint8Array, nfds: number, timeoutMs: number): Promise<number> {
    if (nfds < 0 || nfds > Math.max(A.OPEN_MAX, proc.fds.limit) || nfds * A.POLLFD_SIZE > data.length) return -A.EINVAL;
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
    if (nfds < 0 || nfds > Math.max(A.OPEN_MAX, proc.fds.limit)) return -A.EINVAL;
    const setBytes = Math.ceil(nfds / 64) * 8;
    if (setBytes * 3 > data.length) return -A.EINVAL;
    const present = args[1];
    const tvSec = args[2];
    const timeoutMs = tvSec < 0 ? -1 : tvSec * 1000 + (nr === A.SYS_pselect6 ? args[3] / 1e6 : args[3] / 1000); // fractional: never wake early
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
      const dino = inodeNumber(this.fs, full);
      dv.setUint32(off, dino >>> 0, true);
      dv.setUint32(off + 4, Math.floor(dino / 0x100000000), true);
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
  vfork(parent: Process, cloneParent = false): Process {
    const pid = this.allocPid();
    const child = new Process({
      pid, ppid: cloneParent ? parent.ppid : parent.pid, pgid: parent.pgid, sid: parent.sid,
      path: parent.path, argv: [...parent.argv], env: { ...parent.env }, cwd: parent.cwd,
      fds: parent.fds.fork(), umask: parent.umask,
    });
    child.ctty = parent.ctty;
    child.uid = parent.uid;
    child.gid = parent.gid;
    copyCredentials(parent, child);
    this.shm.forked(parent, child);
    this.sem.forked(parent, child);
    child.data.embryo = true;
    child.data.forkParent = parent.pid; // startForkChild: the parent may have exited (and the child been reparented) by then
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

  /**
   * The engine of `parent` finished copying it for its fork() child `pid`:
   * start the child. The parent may already have exited (daemon() forks and
   * exits at once), so the child is found by who forked it, not its ppid.
   */
  startForkChild(parent: Process, pid: number, run: Runner): boolean {
    const child = this.procs.get(pid);
    if (!child || !child.data.embryo || child.data.forkParent !== parent.pid) return false;
    this.startEmbryo(child, run);
    return true;
  }

  /** SYS_shiro_execve (see abi.ts). */
  private async sysExecve(proc: Process, req: { path: string; argv?: string[]; env?: string[]; inproc?: boolean }, data: Uint8Array): Promise<number> {
    if (!req || typeof req.path !== 'string' || !req.path) return -A.ENOENT;
    const resolved = this.resolvePath(proc, req.path);
    if (typeof resolved === 'number') return resolved;
    let path: string = resolved;
    // /proc/self/exe and /proc/PID/fd/N: the file they name (the engine loads
    // the path it gets back, and /proc isn't a directory it can read)
    for (let hops = 0; hops < 8 && path.startsWith('/proc/'); hops++) {
      const t = this.procfs.readlink(proc, path);
      if (typeof t !== 'string') break;
      // (exe as readlink gives it: absolute and resolved, however the program was started)
      const next = /^\/proc\/[^/]+\/exe$/.test(path) ? await this.exePath(proc, path, t) : t.startsWith('/') ? t : `/proc/${t}`;
      if (next === path) break;
      path = next;
    }
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
    let interp: string | null = null;
    if (!builtin) try {
      const raw = await this.fs!.readFile(path);
      head = typeof raw === 'string' ? enc.encode(raw.slice(0, 4)) : raw.subarray(0, 4);
      if (typeof raw !== 'string') interp = elfInterpreter(raw);
    } catch { /* unreadable: let the loaders decide */ }
    const isElf = head.length === 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;
    // A dynamic executable whose loader isn't there is ENOENT, as on Linux
    // (bash: "cannot execute: required file not found")
    if (interp && typeof (await this.statPath(proc, interp)) === 'number') return -A.ENOENT;
    const probe = new Process({ pid: -1, ppid: proc.pid, path, argv, env, cwd: proc.cwd });
    const embryo = !!proc.data.embryo;
    // A package command with its own arguments (zcat = gzip -dc) can't be
    // reloaded in place with the caller's argv: start it like any program
    const inproc = isElf && !!req.inproc && !(this.fs && (await packageArgsForPath(this.fs, path)));
    const runner = embryo || !inproc ? await this.findProgram(path, probe) : null;
    if ((embryo || !inproc) && !runner) return -A.ENOEXEC;
    // The point of no return: exec bookkeeping, as Linux does it
    await proc.fds.closeOnExec();
    this.shm.detachAll(proc); // exec drops SysV shm attachments
    this.timers.clear(proc); // and POSIX timers
    proc.path = path;
    proc.argv = argv;
    proc.env = env;
    for (const [sig, d] of [...proc.dispositions]) {
      if (typeof d === 'number') { proc.dispositions.delete(sig); proc.sigactions.delete(sig); }
    }
    for (const sig of [...proc.pendingSignals]) proc.dropSignal(sig);
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
  if (w?.__tabcomputerKernel) return w.__tabcomputerKernel;
  if (!singleton) singleton = new Kernel();
  if (w) w.__tabcomputerKernel = singleton;
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


/** fork and spawn without a new uid: the child has the parent's real, saved and supplementary ids. */
function copyCredentials(from: Process, to: Process): void {
  to.ruid = from.ruid; to.suid = from.suid; to.rgid = from.rgid; to.sgid = from.sgid;
  to.groups = from.groups ? [...from.groups] : undefined;
}

/**
 * set*id/get*id/setgroups as Linux does them, with CAP_SETUID/CAP_SETGID
 * meaning an effective uid of 0 (su, runuser, setpriv, daemons dropping
 * root). -1 leaves an id unchanged. Data: getres*id writes three u32s,
 * getgroups up to args[0] u32s, setgroups reads args[0] u32s.
 */
function setCredentials(proc: Process, nr: number, args: ArrayLike<number>, data: Uint8Array): number {
  const priv = proc.uid === 0;
  const u = { r: proc.ruid ?? proc.uid, e: proc.uid, s: proc.suid ?? proc.uid };
  const g = { r: proc.rgid ?? proc.gid, e: proc.gid, s: proc.sgid ?? proc.gid };
  const id = (v: number) => (v | 0) === -1 ? -1 : v >>> 0;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const apply = (kind: 'u' | 'g', c: { r: number; e: number; s: number }) => {
    if (kind === 'u') { proc.uid = c.e; proc.ruid = c.r; proc.suid = c.s; } else { proc.gid = c.e; proc.rgid = c.r; proc.sgid = c.s; }
    return 0;
  };
  const one = (kind: 'u' | 'g', cur: { r: number; e: number; s: number }, v: number) => {
    // setuid/setgid: privileged sets all three; otherwise only the effective id, to the real or saved one
    if (priv) return apply(kind, { r: v, e: v, s: v });
    if (v !== cur.r && v !== cur.s) return -A.EPERM;
    return apply(kind, { ...cur, e: v });
  };
  const res = (kind: 'u' | 'g', cur: { r: number; e: number; s: number }, r: number, e: number, s: number) => {
    const allowed = (v: number) => v === -1 || priv || v === cur.r || v === cur.e || v === cur.s;
    if (!allowed(r) || !allowed(e) || !allowed(s)) return -A.EPERM;
    return apply(kind, { r: r === -1 ? cur.r : r, e: e === -1 ? cur.e : e, s: s === -1 ? cur.s : s });
  };
  const re = (kind: 'u' | 'g', cur: { r: number; e: number; s: number }, r: number, e: number) => {
    if (!priv && ((r !== -1 && r !== cur.r && r !== cur.e) || (e !== -1 && e !== cur.r && e !== cur.e && e !== cur.s))) return -A.EPERM;
    const next = { r: r === -1 ? cur.r : r, e: e === -1 ? cur.e : e, s: cur.s };
    // The saved id follows a changed real id, or an effective id set to something but the old real id
    if (r !== -1 || (e !== -1 && e !== cur.r)) next.s = next.e;
    return apply(kind, next);
  };
  switch (nr) {
    case A.SYS_setuid: return one('u', u, id(args[0]));
    case A.SYS_setgid: return one('g', g, id(args[0]));
    case A.SYS_setresuid: return res('u', u, id(args[0]), id(args[1]), id(args[2]));
    case A.SYS_setresgid: return res('g', g, id(args[0]), id(args[1]), id(args[2]));
    case A.SYS_setreuid: return re('u', u, id(args[0]), id(args[1]));
    case A.SYS_setregid: return re('g', g, id(args[0]), id(args[1]));
    case A.SYS_getresuid: case A.SYS_getresgid: {
      if (data.length < 12) return -A.EFAULT;
      const c = nr === A.SYS_getresuid ? u : g;
      dv.setUint32(0, c.r, true); dv.setUint32(4, c.e, true); dv.setUint32(8, c.s, true);
      return 0;
    }
    case A.SYS_getgroups: {
      const groups = proc.groups ?? [proc.gid];
      const size = args[0] | 0;
      if (size < 0) return -A.EINVAL;
      if (size === 0) return groups.length;
      if (size < groups.length) return -A.EINVAL;
      if (data.length < groups.length * 4) return -A.EFAULT;
      groups.forEach((x, i) => dv.setUint32(i * 4, x, true));
      return groups.length;
    }
    case A.SYS_setgroups: {
      if (!priv) return -A.EPERM;
      const n = args[0] | 0;
      if (n < 0 || n > 65536) return -A.EINVAL;
      if (data.length < n * 4) return -A.EFAULT;
      // Linux keeps them sorted (getgroups lists them in order)
      proc.groups = Array.from({ length: n }, (_, i) => dv.getUint32(i * 4, true)).sort((a, b) => a - b);
      return 0;
    }
    // setfsuid/setfsgid: the filesystem id is the effective id here; the call returns the old one
    case A.SYS_setfsuid: return u.e;
    case A.SYS_setfsgid: return g.e;
  }
  return -A.ENOSYS;
}

const SIG_NAMES = ['', 'HUP', 'INT', 'QUIT', 'ILL', 'TRAP', 'ABRT', 'BUS', 'FPE', 'KILL', 'USR1', 'SEGV', 'USR2', 'PIPE', 'ALRM', 'TERM',
  'STKFLT', 'CHLD', 'CONT', 'STOP', 'TSTP', 'TTIN', 'TTOU', 'URG', 'XCPU', 'XFSZ', 'VTALRM', 'PROF', 'WINCH', 'IO', 'PWR', 'SYS'];
/** SIGINT, SIGRTMIN+3, … for log lines */
function sigName(sig: number): string {
  return SIG_NAMES[sig] ? `SIG${SIG_NAMES[sig]}` : sig >= 32 ? `SIGRTMIN+${sig - 32}` : `signal ${sig}`;
}
