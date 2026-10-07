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
  signalHook?: SignalHook;
  /** Free-form per-runtime state (worker handle, WASI instance, ...). */
  data: Record<string, unknown> = {};

  /** Aborted when a signal interrupts the process: blocked syscalls return -EINTR. */
  private interrupt = new AbortController();
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
    old.abort();
  }

  /** Resolves with the wait status when the process exits. Does not reap it. */
  wait(): Promise<number> {
    if (this.exitStatus !== undefined) return Promise.resolve(this.exitStatus);
    return new Promise(resolve => this.exitWaiters.push(resolve));
  }

  /** Register cleanup run when the process is killed or exits (e.g. worker.terminate). */
  onTerminate(fn: () => void): void {
    if (this.state === 'zombie') { fn(); return; }
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

  /** Mark exited. Called by the kernel only (Kernel.exit also closes fds and reparents). */
  markExited(status: number): boolean {
    if (this.state === 'zombie') return false;
    this.state = 'zombie';
    this.exitStatus = status;
    this.interruptSyscalls();
    for (const t of this.terminators.splice(0)) {
      try { t(); } catch { /* ignore */ }
    }
    for (const w of this.exitWaiters.splice(0)) w(status);
    this.notifyStateChange();
    return true;
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
