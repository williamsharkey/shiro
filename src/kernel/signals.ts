/**
 * Signals, process groups, sessions and job control (unix/pty workstream).
 *
 * Linux numbering and semantics. The kernel's Process satisfies `SignalTarget`
 * structurally (pid/ppid/pgid/sid plus a `signals: SignalState`) and supplies
 * the runtime hooks: `terminate` (worker.terminate() or an AbortController for
 * in-page programs), `notifyPending` (sets Int32[3] of the syscall channel),
 * and optionally `onStop`/`onCont`/`onHandler`.
 *
 * Stopping is cooperative: a stopped process simply doesn't get syscall
 * replies (the kernel's dispatch waits in `proc.waitWhileStopped()`), and
 * in-page programs await `jobControl.whileStopped` at their own checkpoints.
 *
 * `attachKernel` adopts every kernel Process: its `signalHook` routes all
 * delivery here, its dispositions and mask back the SignalState, and its
 * state changes are reported as job events.
 */
import type { Kernel } from './kernel';
import { Process } from './process';
import { processTable } from '../process-table';
import { notifySignalPending } from './signalfd';
import { SI_USER, SIGRTMIN as KSIGRTMIN, CLD_STOPPED, CLD_CONTINUED, type SigInfo } from './abi';

// ── Linux signal numbers ────────────────────────────────────────────────────
export const SIGHUP = 1;
export const SIGINT = 2;
export const SIGQUIT = 3;
export const SIGILL = 4;
export const SIGTRAP = 5;
export const SIGABRT = 6;
export const SIGBUS = 7;
export const SIGFPE = 8;
export const SIGKILL = 9;
export const SIGUSR1 = 10;
export const SIGSEGV = 11;
export const SIGUSR2 = 12;
export const SIGPIPE = 13;
export const SIGALRM = 14;
export const SIGTERM = 15;
export const SIGSTKFLT = 16;
export const SIGCHLD = 17;
export const SIGCONT = 18;
export const SIGSTOP = 19;
export const SIGTSTP = 20;
export const SIGTTIN = 21;
export const SIGTTOU = 22;
export const SIGURG = 23;
export const SIGXCPU = 24;
export const SIGXFSZ = 25;
export const SIGVTALRM = 26;
export const SIGPROF = 27;
export const SIGWINCH = 28;
export const SIGIO = 29;
export const SIGPWR = 30;
export const SIGSYS = 31;
export const SIGRTMIN = 34;
export const SIGRTMAX = 64;
/** Highest signal number + 1 (Linux _NSIG) */
export const NSIG = 65;

/** Names without the SIG prefix, indexed by number (1..31) */
export const SIGNAL_NAMES: readonly string[] = [
  '', 'HUP', 'INT', 'QUIT', 'ILL', 'TRAP', 'ABRT', 'BUS', 'FPE', 'KILL', 'USR1',
  'SEGV', 'USR2', 'PIPE', 'ALRM', 'TERM', 'STKFLT', 'CHLD', 'CONT', 'STOP', 'TSTP',
  'TTIN', 'TTOU', 'URG', 'XCPU', 'XFSZ', 'VTALRM', 'PROF', 'WINCH', 'IO', 'PWR', 'SYS',
];

const SIGNAL_ALIASES: Record<string, number> = { IOT: SIGABRT, POLL: SIGIO, CLD: SIGCHLD, UNUSED: SIGSYS };

/** Name for a signal number: `signalName(2)` → 'INT', real-time → 'RTMIN+3' */
export function signalName(sig: number): string {
  if (sig > 0 && sig < SIGNAL_NAMES.length) return SIGNAL_NAMES[sig];
  if (sig === SIGRTMIN) return 'RTMIN';
  if (sig === SIGRTMAX) return 'RTMAX';
  if (sig > SIGRTMIN && sig < SIGRTMAX) return sig - SIGRTMIN <= (SIGRTMAX - SIGRTMIN) / 2 ? `RTMIN+${sig - SIGRTMIN}` : `RTMAX-${SIGRTMAX - sig}`;
  return String(sig);
}

/** Parse 'INT', 'SIGINT', 'sigint', '2', 'RTMIN+1'. Returns undefined when unknown. 0 is valid (existence check). */
export function signalNumber(spec: string | number): number | undefined {
  if (typeof spec === 'number') return spec >= 0 && spec < NSIG ? spec : undefined;
  const s = spec.trim();
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return n < NSIG ? n : undefined;
  }
  let name = s.toUpperCase();
  if (name.startsWith('SIG')) name = name.slice(3);
  const idx = SIGNAL_NAMES.indexOf(name);
  if (idx > 0) return idx;
  if (name in SIGNAL_ALIASES) return SIGNAL_ALIASES[name];
  const rt = /^RT(MIN|MAX)(?:([+-])(\d+))?$/.exec(name);
  if (rt) {
    const base = rt[1] === 'MIN' ? SIGRTMIN : SIGRTMAX;
    const n = rt[3] ? parseInt(rt[3], 10) * (rt[2] === '-' ? -1 : 1) : 0;
    const sig = base + n;
    return sig >= SIGRTMIN && sig <= SIGRTMAX ? sig : undefined;
  }
  return undefined;
}

export type DefaultAction = 'term' | 'core' | 'ign' | 'stop' | 'cont';

/** signal(7) default actions */
export function defaultAction(sig: number): DefaultAction {
  switch (sig) {
    case SIGCHLD: case SIGURG: case SIGWINCH: return 'ign';
    case SIGCONT: return 'cont';
    case SIGSTOP: case SIGTSTP: case SIGTTIN: case SIGTTOU: return 'stop';
    case SIGQUIT: case SIGILL: case SIGTRAP: case SIGABRT: case SIGBUS: case SIGFPE:
    case SIGSEGV: case SIGXCPU: case SIGXFSZ: case SIGSYS: return 'core';
    default: return 'term';
  }
}

export function isStopSignal(sig: number): boolean {
  return sig === SIGSTOP || sig === SIGTSTP || sig === SIGTTIN || sig === SIGTTOU;
}

// ── Linux wait status encoding ──────────────────────────────────────────────
export const W_EXITCODE = (code: number) => (code & 0xff) << 8;
export const W_TERMSIG = (sig: number, core = false) => (sig & 0x7f) | (core ? 0x80 : 0);
export const W_STOPCODE = (sig: number) => ((sig & 0xff) << 8) | 0x7f;
export const W_CONTINUED = 0xffff;
export const WIFEXITED = (s: number) => (s & 0x7f) === 0;
export const WEXITSTATUS = (s: number) => (s >> 8) & 0xff;
export const WIFSIGNALED = (s: number) => (s & 0x7f) !== 0 && (s & 0x7f) !== 0x7f;
export const WTERMSIG = (s: number) => s & 0x7f;
export const WIFSTOPPED = (s: number) => (s & 0xff) === 0x7f;
export const WSTOPSIG = (s: number) => (s >> 8) & 0xff;
export const WIFCONTINUED = (s: number) => s === W_CONTINUED;
/** Shell `$?` for a wait status: exit code, or 128+signal */
export function shellStatus(status: number): number {
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSTOPPED(status)) return 128 + WSTOPSIG(status);
  return 128 + WTERMSIG(status);
}

// ── sigaction / sigprocmask ─────────────────────────────────────────────────
export const SIG_DFL = 0;
export const SIG_IGN = 1;
export const SIG_BLOCK = 0;
export const SIG_UNBLOCK = 1;
export const SIG_SETMASK = 2;

export const SA_NOCLDSTOP = 0x00000001;
export const SA_NOCLDWAIT = 0x00000002;
export const SA_SIGINFO = 0x00000004;
export const SA_ONSTACK = 0x08000000;
export const SA_RESTART = 0x10000000;
export const SA_NODEFER = 0x40000000;
export const SA_RESETHAND = 0x80000000;

/**
 * A signal disposition. `handler` is SIG_DFL, SIG_IGN, a guest function
 * pointer (any other number; the guest runs it when it sees the pending flag),
 * or a JS function for in-page programs (called by the kernel on delivery).
 */
export interface SigAction {
  handler: number | ((sig: number) => void);
  flags: number;
  /** Signals blocked while the handler runs */
  mask: bigint;
}

const bit = (sig: number) => 1n << BigInt(sig - 1);
/** sigset_t helpers (bit sig-1, 64 bits like Linux) */
export const sigset = {
  empty: 0n,
  of: (...sigs: number[]) => sigs.reduce((s, n) => s | bit(n), 0n),
  has: (set: bigint, sig: number) => (set & bit(sig)) !== 0n,
  add: (set: bigint, sig: number) => set | bit(sig),
  del: (set: bigint, sig: number) => set & ~bit(sig),
  /** Lowest signal in the set, 0 if empty */
  first(set: bigint): number {
    for (let s = 1; s < NSIG; s++) if (set & bit(s)) return s;
    return 0;
  },
};
const UNBLOCKABLE = sigset.of(SIGKILL, SIGSTOP);
const STOP_SET = sigset.of(SIGSTOP, SIGTSTP, SIGTTIN, SIGTTOU);
const FULL_SET = (1n << 64n) - 1n;

const EINVAL = 22;

/** Per-process signal state: dispositions, blocked mask, pending set. */
export class SignalState {
  protected actions = new Map<number, SigAction>();
  private maskBits: bigint = 0n;
  private pendingBits: bigint = 0n;

  /** Pending signals held back by the mask */
  get pending(): bigint { return this.pendingBits; }
  set pending(v: bigint) { this.pendingBits = v; }

  /** Blocked signals (sigprocmask) */
  get mask(): bigint { return this.maskBits; }
  set mask(v: bigint) { this.maskBits = v; }

  getAction(sig: number): SigAction {
    return this.actions.get(sig) ?? { handler: SIG_DFL, flags: 0, mask: 0n };
  }

  /** sigaction(2). Returns 0 or -EINVAL (bad number, or SIGKILL/SIGSTOP). */
  setAction(sig: number, act: SigAction): number {
    if (sig < 1 || sig >= NSIG || sig === SIGKILL || sig === SIGSTOP) return -EINVAL;
    if (act.handler === SIG_DFL && act.flags === 0 && act.mask === 0n) this.actions.delete(sig);
    else this.actions.set(sig, { ...act, mask: act.mask & ~UNBLOCKABLE });
    // Setting SIG_IGN (or SIG_DFL for a default-ignored signal) discards a pending one
    if (this.isIgnored(sig)) this.pending = sigset.del(this.pending, sig);
    return 0;
  }

  /** Convenience for in-page programs and tests */
  handle(sig: number, handler: SigAction['handler'], flags = 0): number {
    return this.setAction(sig, { handler, flags, mask: 0n });
  }

  /** sigprocmask(2). Returns the old mask. SIGKILL/SIGSTOP can't be blocked. */
  sigprocmask(how: number, set: bigint): bigint {
    const old = this.mask;
    if (how === SIG_BLOCK) this.mask |= set;
    else if (how === SIG_UNBLOCK) this.mask &= ~set;
    else this.mask = set;
    this.mask &= ~UNBLOCKABLE & FULL_SET;
    return old;
  }

  isBlocked(sig: number): boolean {
    return sigset.has(this.mask, sig);
  }

  /** Explicitly ignored, or default-ignored and not handled */
  isIgnored(sig: number): boolean {
    if (sig === SIGKILL || sig === SIGSTOP) return false;
    const h = this.getAction(sig).handler;
    return h === SIG_IGN || (h === SIG_DFL && defaultAction(sig) === 'ign');
  }

  isCaught(sig: number): boolean {
    const h = this.getAction(sig).handler;
    return h !== SIG_DFL && h !== SIG_IGN;
  }

  /** Signals that are pending and not blocked */
  deliverable(): bigint {
    return this.pending & ~this.mask;
  }

  /** Take the lowest deliverable pending signal (for the guest's handler loop). 0 if none. */
  dequeue(): number {
    const sig = sigset.first(this.deliverable());
    if (sig) this.pending = sigset.del(this.pending, sig);
    return sig;
  }

  /** fork(2): dispositions and mask are inherited, pending is cleared */
  fork(): SignalState {
    const s = new SignalState();
    for (const [k, v] of this.actions) s.actions.set(k, { ...v });
    s.mask = this.mask;
    return s;
  }

  /** execve(2): caught signals revert to SIG_DFL; ignored stay ignored; mask and pending survive */
  exec(): void {
    for (const [sig, act] of [...this.actions]) {
      if (act.handler === SIG_IGN) this.actions.set(sig, { handler: SIG_IGN, flags: 0, mask: 0n });
      else this.actions.delete(sig);
    }
  }
}

// ── Processes as seen by job control ────────────────────────────────────────
export type RunState = 'running' | 'stopped' | 'zombie';

/**
 * What job control needs from a process. The kernel's Process satisfies this;
 * tests and in-page programs can use `createSignalTarget`.
 */
export interface SignalTarget {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  signals: SignalState;
  /** Maintained by JobControl */
  runState?: RunState;
  /** Kill the process now (default action term/core, or SIGKILL). The kernel then calls `jobControl.exited`. */
  terminate(sig: number, core: boolean): void;
  /** A guest-handled signal is pending: set the syscall channel's pending-signal flag */
  notifyPending?(sig: number): void;
  /** Make the process stopped/running (the kernel's markStopped/markContinued); default: set runState */
  onStop?(sig: number): void;
  onCont?(): void;
  /** Lifecycle owned by the kernel: it reparents children and sends SIGCHLD on exit itself */
  managed?: boolean;
  /** True once the process is gone from its owner's table (reaped); job control then forgets it */
  reaped?(): boolean;
  /** The process's uid (SIGCHLD's si_uid) */
  uid?: number;
  /** Run `fn` (a send to this process) with the siginfo the signal carries */
  carry?(info: SigInfo, fn: () => void): void;
}

export type JobEvent =
  | { type: 'stopped'; pid: number; sig: number }
  | { type: 'continued'; pid: number }
  | { type: 'exited'; pid: number; status: number }
  /** A caught signal was queued for the process (wakes its blocked calls with EINTR) */
  | { type: 'signal'; pid: number; sig: number };

const ESRCH = 3;
const EPERM = 1;

/**
 * The process-group/session view of the process table, plus delivery.
 * One shared instance (`jobControl`); the kernel registers every Process.
 */
export class JobControl {
  private procs = new Map<number, SignalTarget>();
  private listeners = new Set<(ev: JobEvent) => void>();
  private resumeWaiters = new Map<number, Array<() => void>>();
  /** Unreaped wait statuses (for stop/continue/exit reports before the waiter subscribed) */
  private lastStatus = new Map<number, number>();
  /** Last state reported per pid, so kernel and job-control paths never report a change twice */
  private reported = new Map<number, RunState>();

  /** Pid allocator for in-page processes: the page-wide one the kernel uses too, unless overridden. */
  allocPid(): number {
    return this.pidAllocator ? this.pidAllocator() : processTable.allocatePid();
  }

  private callerResolvers: Array<(hint: unknown) => SignalTarget | undefined> = [];
  /**
   * Which process is making a call, from whatever the transport passes along
   * (the kernel passes the process's syscall AbortSignal to read/write).
   */
  resolveCaller(hint: unknown): SignalTarget | undefined {
    if (hint && typeof hint === 'object' && 'pid' in hint && 'signals' in hint) return hint as SignalTarget;
    for (const r of this.callerResolvers) {
      const t = r(hint);
      if (t) return t;
    }
    return undefined;
  }
  addCallerResolver(fn: (hint: unknown) => SignalTarget | undefined): () => void {
    this.callerResolvers.push(fn);
    return () => { this.callerResolvers = this.callerResolvers.filter((r) => r !== fn); };
  }
  private pidAllocator?: () => number;
  setPidAllocator(fn: () => number): void {
    this.pidAllocator = fn;
  }

  register(p: SignalTarget): void {
    p.runState ??= 'running';
    this.procs.set(p.pid, p);
  }

  unregister(pid: number): void {
    this.procs.delete(pid);
    this.lastStatus.delete(pid);
    this.reported.delete(pid);
    this.wakeResumeWaiters(pid);
  }

  get(pid: number): SignalTarget | undefined {
    const p = this.procs.get(pid);
    if (p?.reaped?.()) { this.unregister(pid); return undefined; }
    return p;
  }

  all(): SignalTarget[] {
    for (const p of [...this.procs.values()]) if (p.reaped?.()) this.unregister(p.pid);
    return [...this.procs.values()];
  }

  /** Live members of a process group */
  group(pgid: number): SignalTarget[] {
    return this.all().filter((p) => p.pgid === pgid && p.runState !== 'zombie');
  }

  subscribe(fn: (ev: JobEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(ev: JobEvent): void {
    for (const fn of [...this.listeners]) {
      try { fn(ev); } catch (e) { console.error('[signals] listener failed', e); }
    }
  }

  // ── groups and sessions ──

  /** setpgid(2). pid/pgid 0 mean the caller. */
  setpgid(caller: SignalTarget, pid: number, pgid: number): number {
    const p = pid === 0 ? caller : this.procs.get(pid);
    if (!p || (p !== caller && p.ppid !== caller.pid)) return -ESRCH;
    if (pgid < 0) return -EINVAL;
    if (p.sid !== caller.sid || p.pid === p.sid) return -EPERM;
    const target = pgid === 0 ? p.pid : pgid;
    if (target !== p.pid && !this.all().some((q) => q.pgid === target && q.sid === caller.sid)) return -EPERM;
    p.pgid = target;
    return 0;
  }

  /** setsid(2). Returns the new sid or -EPERM if already a group leader. */
  setsid(p: SignalTarget): number {
    if (this.all().some((q) => q.pgid === p.pid)) return -EPERM;
    p.sid = p.pid;
    p.pgid = p.pid;
    return p.sid;
  }

  /**
   * A process group is orphaned when no member has a parent in a different
   * group of the same session (POSIX). Stop signals from the tty are discarded
   * for orphaned groups so they can't be stopped forever.
   */
  isOrphanedPgrp(pgid: number): boolean {
    const members = this.group(pgid);
    if (members.length === 0) return true;
    return !members.some((m) => {
      const parent = this.procs.get(m.ppid);
      return parent && parent.runState !== 'zombie' && parent.pgid !== pgid && parent.sid === m.sid;
    });
  }

  // ── delivery ──

  /** kill(2): pid > 0 one process, 0 the caller's group, -1 everyone but init, < -1 group -pid. */
  kill(pid: number, sig: number, caller?: SignalTarget): number {
    if (sig < 0 || sig >= NSIG) return -EINVAL;
    let targets: SignalTarget[];
    if (pid > 0) {
      const p = this.procs.get(pid);
      targets = p ? [p] : [];
    } else if (pid === 0) {
      if (!caller) return -ESRCH;
      targets = this.group(caller.pgid);
    } else if (pid === -1) {
      targets = this.all().filter((p) => p.pid !== 1 && p !== caller);
    } else {
      targets = this.group(-pid);
    }
    targets = targets.filter((p) => p.runState !== 'zombie' || pid > 0);
    if (targets.length === 0) return -ESRCH;
    for (const p of targets) this.send(p, sig);
    return 0;
  }

  /** killpg(2) */
  killpg(pgid: number, sig: number): number {
    return pgid > 0 ? this.kill(-pgid, sig) : -EINVAL;
  }

  /** Deliver one signal to one process (the core of kill/tty/SIGCHLD/SIGPIPE delivery). */
  send(p: SignalTarget, sig: number): void {
    if (sig === 0 || p.runState === 'zombie') return;
    const st = p.signals;

    if (sig === SIGKILL) {
      this.resume(p, false);
      p.terminate(SIGKILL, false);
      return;
    }
    if (sig === SIGCONT) {
      // SIGCONT resumes even when blocked, ignored or caught, and discards pending stops
      st.pending &= ~STOP_SET;
      this.resume(p, true);
    } else if (isStopSignal(sig)) {
      st.pending = sigset.del(st.pending, SIGCONT);
    }

    // A blocked signal stays pending even when ignored (Linux: the disposition may change before
    // it is unblocked, and signalfd reads it); flushPending discards it if it is still ignored then
    if (st.isBlocked(sig)) {
      st.pending = sigset.add(st.pending, sig);
      return;
    }
    if (st.isIgnored(sig)) return;
    this.act(p, sig);
  }

  /** Apply a deliverable, unblocked signal */
  private act(p: SignalTarget, sig: number): void {
    const st = p.signals;
    const action = st.getAction(sig);
    const h = action.handler;
    if (typeof h === 'function') {
      // In-page handler: runs asynchronously, like a signal arriving between instructions
      if (action.flags & SA_RESETHAND) st.setAction(sig, { handler: SIG_DFL, flags: 0, mask: 0n });
      queueMicrotask(() => {
        const saved = st.mask;
        st.mask |= action.mask | ((action.flags & SA_NODEFER) ? 0n : sigset.of(sig));
        st.mask &= ~UNBLOCKABLE;
        try { h(sig); } catch (e) { console.error(`[signals] SIG${signalName(sig)} handler threw`, e); }
        finally { st.mask = saved; this.flushPending(p); }
      });
      this.emit({ type: 'signal', pid: p.pid, sig });
      return;
    }
    if (h !== SIG_DFL) {
      // Guest handler pointer: the guest library dequeues and runs it after its next syscall reply
      st.pending = sigset.add(st.pending, sig);
      p.notifyPending?.(sig);
      this.emit({ type: 'signal', pid: p.pid, sig });
      return;
    }
    switch (defaultAction(sig)) {
      case 'ign':
      case 'cont':
        return;
      case 'stop':
        // Terminal-generated stops are discarded for orphaned groups (POSIX)
        if (sig !== SIGSTOP && this.isOrphanedPgrp(p.pgid)) return;
        this.stop(p, sig);
        return;
      case 'core':
        p.terminate(sig, true);
        return;
      default:
        p.terminate(sig, false);
    }
  }

  /** Deliver anything that became unblocked (call after sigprocmask/sigaction changes). */
  flushPending(p: SignalTarget): void {
    let sig: number;
    // Guest handlers stay pending for the guest; only re-act on default/JS dispositions
    while ((sig = sigset.first(p.signals.deliverable() & ~this.guestCaught(p))) !== 0) {
      p.signals.pending = sigset.del(p.signals.pending, sig);
      if (p.signals.isIgnored(sig)) continue;
      this.act(p, sig);
      if (p.runState !== 'running') break;
    }
    const guest = sigset.first(p.signals.deliverable() & this.guestCaught(p));
    if (guest) p.notifyPending?.(guest);
  }

  private guestCaught(p: SignalTarget): bigint {
    let set = 0n;
    for (let s = 1; s < NSIG; s++) {
      const h = p.signals.getAction(s).handler;
      if (typeof h === 'number' && h !== SIG_DFL && h !== SIG_IGN) set = sigset.add(set, s);
    }
    return set;
  }

  private stop(p: SignalTarget, sig: number): void {
    if (p.runState !== 'running') return;
    if (p.onStop) p.onStop(sig);
    else p.runState = 'stopped';
    this.noteStopped(p, sig);
  }

  private resume(p: SignalTarget, report: boolean): void {
    if (p.runState !== 'stopped') return;
    if (p.onCont) p.onCont();
    else p.runState = 'running';
    this.noteContinued(p, report);
  }

  /** Record a stop (also called by the kernel bridge when the kernel stops a process itself). */
  noteStopped(p: SignalTarget, sig: number): void {
    if (this.reported.get(p.pid) === 'stopped' || this.reported.get(p.pid) === 'zombie') return;
    this.reported.set(p.pid, 'stopped');
    this.lastStatus.set(p.pid, W_STOPCODE(sig));
    this.emit({ type: 'stopped', pid: p.pid, sig });
    this.notifyParent(p, true, sig);
  }

  /** Record a continue (SIGCONT, from either path). */
  noteContinued(p: SignalTarget, report = true): void {
    if (this.reported.get(p.pid) !== 'stopped') return;
    this.reported.set(p.pid, 'running');
    this.wakeResumeWaiters(p.pid);
    if (!report) return;
    this.lastStatus.set(p.pid, W_CONTINUED);
    this.emit({ type: 'continued', pid: p.pid });
    this.notifyParent(p, true);
  }

  /** SIGCHLD for a stop (with its signal) or a continue: si_code CLD_STOPPED or CLD_CONTINUED, the child's pid */
  private notifyParent(p: SignalTarget, stopOrCont: boolean, stopSig?: number): void {
    const parent = this.procs.get(p.ppid);
    if (!parent || parent.runState === 'zombie') return;
    if (stopOrCont && (parent.signals.getAction(SIGCHLD).flags & SA_NOCLDSTOP)) return;
    const info: SigInfo = { signo: SIGCHLD, code: stopSig ? CLD_STOPPED : CLD_CONTINUED, pid: p.pid, uid: p.uid ?? 0, status: stopSig ?? SIGCONT };
    if (parent.carry) parent.carry(info, () => this.send(parent, SIGCHLD));
    else this.send(parent, SIGCHLD);
  }

  /**
   * The kernel reports a process exit (wait status, Linux encoding). Marks it
   * a zombie, sends SIGCHLD to the parent, and reparents children to init (1)
   * or drops their ppid.
   */
  exited(pid: number, status: number): void {
    const p = this.procs.get(pid);
    if (!p || this.reported.get(pid) === 'zombie') return;
    this.reported.set(pid, 'zombie');
    if (!p.managed) p.runState = 'zombie';
    this.lastStatus.set(pid, status);
    this.wakeResumeWaiters(pid);
    const children = this.all().filter((c) => c.ppid === pid);
    if (!p.managed) for (const c of children) if (!c.managed) c.ppid = this.procs.has(1) ? 1 : 0;
    this.emit({ type: 'exited', pid, status });
    if (!p.managed) this.notifyParent(p, false);
    // An exit that orphans a group with stopped members sends it SIGHUP then SIGCONT (POSIX)
    for (const pg of new Set([p.pgid, ...children.map((c) => c.pgid)])) {
      if (this.group(pg).some((q) => q.runState === 'stopped') && this.isOrphanedPgrp(pg)) {
        this.kill(-pg, SIGHUP);
        this.kill(-pg, SIGCONT);
      }
    }
  }

  /** Last stop/continue/exit status reported for pid, if any */
  status(pid: number): number | undefined {
    return this.lastStatus.get(pid);
  }

  /** Resolves when p is no longer stopped (running again, or dead). */
  whileStopped(p: SignalTarget): Promise<void> {
    if (p.runState !== 'stopped') return Promise.resolve();
    return new Promise((resolve) => {
      const list = this.resumeWaiters.get(p.pid) ?? [];
      list.push(resolve);
      this.resumeWaiters.set(p.pid, list);
    });
  }

  private wakeResumeWaiters(pid: number): void {
    const list = this.resumeWaiters.get(pid);
    if (!list) return;
    this.resumeWaiters.delete(pid);
    for (const fn of list) fn();
  }

  /**
   * Wait for a job (process group): resolves `exited` when every member is
   * gone (status of the group leader, else the last to exit), or `stopped`
   * as soon as any member stops.
   */
  waitJob(pgid: number, pids?: number[]): Promise<{ type: 'exited'; status: number } | { type: 'stopped'; sig: number }> {
    const members = () => (pids ?? this.group(pgid).map((p) => p.pid));
    const tracked = new Set(members());
    return new Promise((resolve) => {
      let lastStatus = 0;
      const leaderStatus = () => this.lastStatus.get(pgid);
      const check = (): boolean => {
        for (const pid of tracked) {
          const p = this.procs.get(pid);
          if (p && p.runState === 'stopped') {
            const st = this.lastStatus.get(pid) ?? W_STOPCODE(SIGSTOP);
            resolve({ type: 'stopped', sig: WSTOPSIG(st) });
            return true;
          }
        }
        const live = [...tracked].filter((pid) => {
          const p = this.procs.get(pid);
          return p && p.runState !== 'zombie';
        });
        if (live.length === 0) {
          for (const pid of tracked) {
            const s = this.lastStatus.get(pid);
            if (s !== undefined && !WIFSTOPPED(s) && !WIFCONTINUED(s)) lastStatus = s;
          }
          const ls = leaderStatus();
          resolve({ type: 'exited', status: ls !== undefined && !WIFSTOPPED(ls) && !WIFCONTINUED(ls) ? ls : lastStatus });
          return true;
        }
        return false;
      };
      if (check()) return;
      const unsub = this.subscribe((ev) => {
        if (!tracked.has(ev.pid)) return;
        if (check()) unsub();
      });
    });
  }
}

/** The shared job-control instance (the kernel registers its processes here). */
export const jobControl = new JobControl();

/**
 * A SignalTarget for an in-page program (a builtin, a JS task, a test fake).
 * Default actions abort `controller`; the creator calls `jobControl.exited`
 * when the program finishes (done for you by `finish`).
 */
export function createSignalTarget(opts: {
  pid?: number;
  ppid?: number;
  pgid?: number;
  sid?: number;
  jc?: JobControl;
  onTerminate?: (sig: number) => void;
} = {}): SignalTarget & { controller: AbortController; finish(code: number): void; killedBy?: number } {
  const jc = opts.jc ?? jobControl;
  const pid = opts.pid ?? jc.allocPid();
  const controller = new AbortController();
  const t: SignalTarget & { controller: AbortController; finish(code: number): void; killedBy?: number } = {
    pid,
    ppid: opts.ppid ?? 0,
    pgid: opts.pgid ?? pid,
    sid: opts.sid ?? opts.pgid ?? pid,
    signals: new SignalState(),
    controller,
    terminate(sig, core) {
      if (t.runState === 'zombie') return;
      t.killedBy = sig;
      controller.abort(Object.assign(new Error(`killed by SIG${signalName(sig)}`), { signal: sig }));
      opts.onTerminate?.(sig);
      jc.exited(pid, W_TERMSIG(sig, core));
    },
    finish(code) {
      jc.exited(pid, W_EXITCODE(code));
    },
  };
  jc.register(t);
  return t;
}

const EPIPE = 32;
/**
 * A write to a pipe or socket with no reader: SIGPIPE to the writer, then
 * -EPIPE (for pipe.ts / net.ts). With SIGPIPE ignored the write just fails.
 */
export function brokenPipe(writer: SignalTarget | undefined, jc: JobControl = jobControl): number {
  if (writer) jc.send(writer, SIGPIPE);
  return -EPIPE;
}

// ── kernel bridge ───────────────────────────────────────────────────────────

/**
 * SignalState of a kernel Process: SIG_DFL/SIG_IGN/guest handlers live in
 * `proc.dispositions` and the mask in `proc.sigmask` (the kernel's view);
 * JS handlers for in-page code stay here.
 */
class ProcessSignalState extends SignalState {
  constructor(private proc: Process) { super(); }

  /** Blocked signals wait in the kernel's deferredSignals; kernel.setSigmask delivers them on unblock */
  get pending(): bigint {
    let m = 0n;
    for (const s of this.proc.deferredSignals) m = sigset.add(m, s);
    return m;
  }
  set pending(v: bigint) {
    const p = this.proc, before = p.deferredSignals.size, was = p.deferredSignals;
    p.deferredSignals = new Set();
    for (let s = 1; s < NSIG; s++) if (sigset.has(v, s)) p.deferredSignals.add(s);
    // what the signal going pending carries (kernel.deliver's, while it routes it here)
    const info = p.data.sigInFlight as SigInfo | undefined;
    for (const s of p.deferredSignals) {
      if (!was.has(s)) p.queueSiginfo(info?.signo === s ? info : { signo: s, code: SI_USER });
      else if (info?.signo === s && s >= KSIGRTMIN) p.queueSiginfo(info); // another real-time instance
    }
    for (const s of was) if (!p.deferredSignals.has(s) && !p.pendingSignals.has(s)) p.siginfo.delete(s);
    if (p.deferredSignals.size > before) notifySignalPending(p);
  }

  get mask(): bigint {
    let m = 0n;
    for (const s of this.proc.sigmask) m = sigset.add(m, s);
    return m;
  }
  set mask(v: bigint) {
    this.proc.sigmask = new Set();
    for (let s = 1; s < NSIG; s++) if (sigset.has(v, s)) this.proc.sigmask.add(s);
  }

  getAction(sig: number): SigAction {
    const local = this.actions.get(sig);
    if (local) return local;
    const d = this.proc.dispositions.get(sig);
    // (the flags rt_sigaction gave the kernel: SA_NOCLDSTOP for SIGCHLD)
    return { handler: d === 'ignore' ? SIG_IGN : typeof d === 'number' ? d : SIG_DFL, flags: this.proc.sigactions.get(sig)?.flags ?? 0, mask: 0n };
  }

  setAction(sig: number, act: SigAction): number {
    const r = super.setAction(sig, act);
    if (r < 0) return r;
    if (typeof act.handler === 'function') {
      this.proc.dispositions.delete(sig);
    } else {
      this.actions.delete(sig);
      if (act.handler === SIG_DFL) this.proc.dispositions.delete(sig);
      else this.proc.dispositions.set(sig, act.handler === SIG_IGN ? 'ignore' : act.handler);
    }
    return 0;
  }
}

const attached = new WeakMap<Kernel, JobControl>();

/** The job-control view of a kernel process (adopted by `attachKernel`). */
function kernelTarget(kernel: Kernel, proc: Process, jc: JobControl): SignalTarget {
  const notify = () => kernel.notify();
  return {
    get pid() { return proc.pid; },
    get ppid() { return proc.ppid; },
    set ppid(v: number) { proc.ppid = v; },
    get pgid() { return proc.pgid; },
    set pgid(v: number) { proc.pgid = v; },
    get sid() { return proc.sid; },
    set sid(v: number) { proc.sid = v; },
    get runState(): RunState { return proc.state; },
    set runState(_v: RunState | undefined) { /* driven by the kernel's markStopped/markContinued/markExited */ },
    signals: new ProcessSignalState(proc),
    get uid() { return proc.ruid ?? proc.uid; },
    carry(info, fn) {
      proc.data.sigInFlight = info;
      try { fn(); } finally { delete proc.data.sigInFlight; }
    },
    managed: true,
    reaped: () => kernel.procs.get(proc.pid) !== proc,
    terminate(sig, core) {
      void kernel.exit(proc, W_TERMSIG(sig, core));
    },
    onStop(sig) {
      proc.markStopped(sig);
      notify(); // wake waitpid(WUNTRACED)
    },
    onCont() {
      proc.markContinued();
      notify();
    },
    notifyPending(sig) {
      // The kernel's queue owns guest-bound signals: the channel flags them one at a time
      const t = jc.get(proc.pid);
      if (t) t.signals.pending = sigset.del(t.signals.pending, sig);
      const info = proc.data.sigInFlight as SigInfo | undefined;
      proc.queueSiginfo(info?.signo === sig ? info : { signo: sig, code: SI_USER });
      proc.pendingSignals.add(sig);
      proc.interruptSyscalls();
      (proc.data.onSignal as ((s: number) => void) | undefined)?.(sig);
    },
  };
}

/**
 * Route a kernel's signals through job control. Every process it spawns is
 * registered with `jc`; kill(2), SIGCHLD, SIGPIPE and tty signals all go
 * through `jc.send`, and kernel-side stops/exits are reported as job events.
 * Idempotent; returns a detach function.
 */
export function attachKernel(kernel: Kernel, jc: JobControl = jobControl): () => void {
  if (attached.has(kernel)) return () => {};
  attached.set(kernel, jc);

  const adopt = (proc: Process) => {
    if (proc.pid === 1 || jc.get(proc.pid)) return;
    const t = kernelTarget(kernel, proc, jc);
    jc.register(t);
    proc.signalHook = (_p, sig) => { jc.send(t, sig); return true; };
    let last = proc.state;
    proc.onStateChange(() => {
      const now = proc.state;
      if (now === last) return;
      last = now;
      if (now === 'stopped') jc.noteStopped(t, WSTOPSIG(proc.pendingStopReport ?? W_STOPCODE(SIGSTOP)) || SIGSTOP);
      else if (now === 'running') jc.noteContinued(t);
      else jc.exited(proc.pid, proc.exitStatus ?? 0);
    });
    if (proc.state === 'zombie') jc.exited(proc.pid, proc.exitStatus ?? 0);
  };
  for (const p of kernel.procs.values()) adopt(p);

  // Adopted synchronously, before the program starts
  const unspawn = kernel.onSpawn(adopt);

  // read/write/ioctl get the caller's syscall AbortSignal: map it back to the process
  const unresolve = jc.addCallerResolver((hint) => {
    const p = Process.fromSyscallSignal(hint);
    return p && kernel.procs.get(p.pid) === p ? jc.get(p.pid) : undefined;
  });

  return () => {
    unspawn();
    unresolve();
    attached.delete(kernel);
  };
}

/** The job-control target for a kernel process (after `attachKernel`). */
export function targetOf(proc: Process, jc: JobControl = jobControl): SignalTarget | undefined {
  return jc.get(proc.pid);
}
