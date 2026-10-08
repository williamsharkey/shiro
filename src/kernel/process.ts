/**
 * A kernel process: identity (pid/ppid/pgid/sid), cwd, env, umask, fd table,
 * signal state, and its exit status in the Linux wait encoding.
 *
 * What a process *runs* (a Worker, an in-page builtin, a WASM module) is not
 * part of Process; the runner attaches cleanup through `onTerminate`.
 */

import { FdTable, type OpenFile } from './fd';
import { W_STOPCODE } from './abi';

export type ProcessState = 'running' | 'stopped' | 'zombie';

/**
 * Signal hook installed by signals.ts (unix/pty). Return true when the
 * signal was handled (caught, ignored, or queued for a guest handler);
 * false lets the kernel apply the default action.
 */
export type SignalHook = (proc: Process, sig: number) => boolean;

export class Process {
  readonly pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  cwd: string;
  env: Record<string, string>;
  argv: string[];
  /** Program path as passed to spawn. */
  path: string;
  umask = 0o022;
  uid = 1000;
  gid = 1000;
  fds: FdTable;
  /** Controlling terminal (pty.ts sets it; /dev/tty opens it). */
  ctty?: OpenFile;
  state: ProcessState = 'running';
  /** Linux wait status once the process has exited. */
  exitStatus?: number;
  /** A stop/continue the parent has not collected with waitpid(WUNTRACED/WCONTINUED). */
  pendingStopReport?: number;
  readonly startTime = Date.now();
  /** Pending signals not yet seen by the guest (also mirrored in the channel's signal word). */
  pendingSignals = new Set<number>();
  /** Blocked signals (sigprocmask); signals.ts maintains it. */
  sigmask = new Set<number>();
  /** Handlers by signal number: 'default' | 'ignore' | guest handler address/id. signals.ts maintains it. */
  dispositions = new Map<number, 'default' | 'ignore' | number>();
  /** sa_flags / sa_mask / sa_restorer per signal, set by rt_sigaction (the handler itself is in `dispositions`). */
  sigactions = new Map<number, { flags: number; mask: Set<number>; restorer: number }>();
  /** Signals that arrived while blocked; delivered when unblocked (rt_sigprocmask, rt_sigreturn). */
  deferredSignals = new Set<number>();
  /** Masks saved when a guest handler starts; rt_sigreturn restores the top one. */
  signalFrames: Set<number>[] = [];
  /** sigaltstack(2) state, recorded but not used (guests run handlers on their own stacks). */
  altStack = { sp: 0, flags: 2 /* SS_DISABLE */, size: 0 };
  signalHook?: SignalHook;
  /** Thread ids of extra threads (worker-host attachThread); the main thread's tid is the pid. */
  tids = new Set<number>();
  /**
   * Free-form per-runtime state (worker handle, WASI instance, ...).
   * `data.onSignal(sig)` fans out to every `addSignalListener` listener; keep
   * calling it, don't replace it.
   */
  data: Record<string, unknown> = {};

  /** Aborted when a signal interrupts the process: blocked syscalls return -EINTR. */
  private interrupt = new AbortController();
  private signalListeners = new Set<(sig: number) => void>();
  private static bySignal = new WeakMap<AbortSignal, Process>();

  /** The process whose `syscallSignal` this is (what OpenFile read/write/ioctl receive as their last argument). */
  static fromSyscallSignal(signal: unknown): Process | undefined {
    return signal instanceof AbortSignal ? Process.bySignal.get(signal) : undefined;
  }

  /**
   * Called when a signal is queued for the guest (`pendingSignals`). Each
   * syscall channel (one per thread) registers here and flags the signal in
   * its signal word; only one channel takes each signal.
   */
  addSignalListener(cb: (sig: number) => void): () => void {
    this.signalListeners.add(cb);
    return () => this.signalListeners.delete(cb);
  }
  private exitWaiters: ((status: number) => void)[] = [];
  private stateWaiters = new Set<() => void>();
  private terminators: (() => void)[] = [];

  constructor(init: {
    pid: number; ppid: number; pgid?: number; sid?: number;
    path: string; argv: string[]; env: Record<string, string>; cwd: string;
    fds?: FdTable; umask?: number;
  }) {
    this.pid = init.pid;
    this.ppid = init.ppid;
    this.pgid = init.pgid ?? init.pid;
    this.sid = init.sid ?? this.pgid;
    this.path = init.path;
    this.argv = init.argv;
    this.env = init.env;
    this.cwd = init.cwd;
    this.fds = init.fds ?? new FdTable();
    if (init.umask !== undefined) this.umask = init.umask;
    Process.bySignal.set(this.interrupt.signal, this);
    this.data.onSignal = (sig: number) => {
      for (const cb of [...this.signalListeners]) cb(sig);
    };
  }

  /** Short command name, like /proc/PID/comm. */
  get comm(): string {
    const a0 = this.argv[0] ?? this.path;
    return a0.slice(a0.lastIndexOf('/') + 1);
  }

  get alive(): boolean { return this.state !== 'zombie'; }

  /** Abort signal for the syscall about to run; aborted when a signal interrupts it. */
  get syscallSignal(): AbortSignal { return this.interrupt.signal; }

  /** Interrupt blocked syscalls (EINTR) and arm a fresh signal for the next ones. */
  interruptSyscalls(): void {
    const old = this.interrupt;
    this.interrupt = new AbortController();
    Process.bySignal.set(this.interrupt.signal, this);
    old.abort();
  }

  /** Resolves with the wait status when the process exits. Does not reap it. */
  wait(): Promise<number> {
    if (this.exitStatus !== undefined) return Promise.resolve(this.exitStatus);
    return new Promise(resolve => this.exitWaiters.push(resolve));
  }

  /** Register cleanup run when the process is killed or exits (e.g. worker.terminate). */
  onTerminate(fn: () => void): void {
    if (this.exiting) { fn(); return; }
    this.terminators.push(fn);
  }

  /** Wake waitpid() callers watching this process (state change). */
  notifyStateChange(): void {
    for (const w of [...this.stateWaiters]) w();
  }
  onStateChange(cb: () => void): () => void {
    this.stateWaiters.add(cb);
    return () => this.stateWaiters.delete(cb);
  }

  /** True from the moment exit starts (fds still closing) until reaped. */
  exiting = false;

  /**
   * First half of exit: stop the runner (terminators) and interrupt blocked
   * syscalls. Returns false if the process is already exiting.
   */
  beginExit(): boolean {
    if (this.exiting) return false;
    this.exiting = true;
    this.interruptSyscalls();
    for (const t of this.terminators.splice(0)) {
      try { t(); } catch { /* ignore */ }
    }
    return true;
  }

  /**
   * execve that replaces the runner: stop the current one (its terminators
   * run, e.g. worker.terminate()) without ending the process.
   */
  stopRunner(): void {
    this.interruptSyscalls();
    for (const t of this.terminators.splice(0)) {
      try { t(); } catch { /* ignore */ }
    }
  }

  /** Second half of exit, after the kernel has closed the fds: become a zombie and wake waiters. */
  markExited(status: number): void {
    if (this.state === 'zombie') return;
    this.state = 'zombie';
    this.exitStatus = status;
    for (const w of this.exitWaiters.splice(0)) w(status);
    this.notifyStateChange();
  }

  markStopped(sig: number): void {
    if (this.state !== 'running') return;
    this.state = 'stopped';
    this.pendingStopReport = W_STOPCODE(sig);
    this.notifyStateChange();
  }

  markContinued(): void {
    if (this.state !== 'stopped') return;
    this.state = 'running';
    this.pendingStopReport = 0xffff;
    this.notifyStateChange();
  }

  /** Resolves when a stopped process is continued (or exits). Syscalls from a stopped process wait here. */
  waitWhileStopped(): Promise<void> {
    if (this.state !== 'stopped') return Promise.resolve();
    return new Promise(resolve => {
      const off = this.onStateChange(() => {
        if (this.state !== 'stopped') { off(); resolve(); }
      });
    });
  }
}
