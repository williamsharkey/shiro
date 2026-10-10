/**
 * POSIX per-process timers (timer_create, timer_settime, timer_gettime,
 * timer_getoverrun, timer_delete), as Linux keeps them: ids per process,
 * not inherited by fork, gone at exec and exit; an expiry sends the
 * timer's signal (SIGEV_SIGNAL, or SIGEV_THREAD_ID to the process: signals
 * carry no thread yet), or nothing (SIGEV_NONE). Expiries while that
 * signal is still pending are counted as overruns, reported for the
 * signal once it has been taken.
 *
 * ABI (data area as in kernel.ts; struct itimerspec = interval {sec, nsec},
 * value {sec, nsec}, i64 each):
 *   timer_create 222 (clockid, hasSigevent); data = sigev_value i64,
 *            sigev_signo i32, sigev_notify i32, sigev_tid i32  → timer id
 *   timer_settime 223 (id, flags); data in = the new itimerspec (value
 *            absolute with TIMER_ABSTIME), out = the old one
 *   timer_gettime 224 (id); data out = the itimerspec (time left)
 *   timer_getoverrun 225 (id)
 *   timer_delete 226 (id)
 */
import * as A from './abi';
import type { Process } from './process';

const SIGEV_SIGNAL = 0;
const SIGEV_NONE = 1;
const SIGEV_THREAD = 2;
const SIGEV_THREAD_ID = 4;
const TIMER_ABSTIME = 1;
const DELAYTIMER_MAX = 0x7fffffff;
// The clocks a timer may count on (CPU-time clocks count wall time here)
const CLOCKS = new Set([0, 1, 2, 3, 5, 6, 7]);

interface Timer {
  id: number;
  value: bigint; // sigev_value
  clock: number;
  signo: number; // 0: SIGEV_NONE
  deadline: number; // ms on the timer's clock (performance-based), 0 = disarmed
  interval: number; // ms
  handle?: ReturnType<typeof setTimeout>;
  queued: boolean; // its signal was sent and may still be pending
  cur: number; // expiries while that signal was pending
  last: number; // overruns of the last signal taken
}

const now = () => performance.now();

export class PosixTimers {
  constructor(private deliver: (proc: Process, sig: number, info: A.SigInfo) => void, private bootMs: number) {}

  private table(proc: Process): Map<number, Timer> {
    let t = proc.data.posixTimers as Map<number, Timer> | undefined;
    if (!t) {
      t = new Map();
      proc.data.posixTimers = t;
      proc.onTerminate(() => this.clear(proc));
    }
    return t;
  }

  /** exec and exit: every timer goes */
  clear(proc: Process): void {
    const t = proc.data.posixTimers as Map<number, Timer> | undefined;
    if (!t) return;
    for (const tm of t.values()) if (tm.handle) clearTimeout(tm.handle);
    t.clear();
  }

  create(proc: Process, clock: number, sev: DataView | null): number {
    // (a negative id is a process's or thread's CPU clock, clock_getcpuclockid's: wall time here too)
    if (!CLOCKS.has(clock) && clock >= 0) return clock === 8 || clock === 9 ? -A.EPERM : -A.EINVAL; // the alarm clocks take CAP_WAKE_ALARM
    let signo = A.SIGALRM;
    let value: bigint | undefined;
    if (sev) {
      value = sev.getBigInt64(0, true);
      const how = sev.getInt32(12, true);
      signo = sev.getInt32(8, true);
      if (how === SIGEV_NONE) signo = 0;
      else if (how === SIGEV_SIGNAL || how === SIGEV_THREAD_ID) {
        if (signo < 1 || signo > 64) return -A.EINVAL;
        if (how === SIGEV_THREAD_ID) {
          const tid = sev.getInt32(16, true);
          if (tid !== proc.pid && !proc.tids.has(tid)) return -A.EINVAL;
        }
      } else return how === SIGEV_THREAD ? -A.EINVAL : -A.EINVAL; // (glibc makes SIGEV_THREAD a SIGEV_THREAD_ID)
    }
    const t = this.table(proc);
    let id = 0;
    while (t.has(id)) id++;
    // (with no sigevent, the value is the timer's id, as on Linux)
    t.set(id, { id, value: value ?? BigInt(id), clock, signo, deadline: 0, interval: 0, queued: false, cur: 0, last: 0 });
    return id;
  }

  private static pending(proc: Process, sig: number): boolean {
    return proc.pendingSignals.has(sig) || proc.deferredSignals.has(sig);
  }

  /** A queued signal the process has taken since: its overruns become the reported ones */
  private settle(proc: Process, tm: Timer): void {
    if (tm.queued && !PosixTimers.pending(proc, tm.signo)) {
      tm.last = tm.cur;
      tm.cur = 0;
      tm.queued = false;
    }
  }

  /** Would `sig` be discarded on arrival (unblocked, and ignored by disposition or default)? */
  private static discarded(proc: Process, sig: number): boolean {
    if (proc.sigmask.has(sig)) return false;
    const d = proc.dispositions.get(sig);
    if (d === 'ignore') return true;
    if (d !== undefined) return false;
    const a = A.defaultSignalAction(sig);
    return a === 'ignore' || (a === 'cont' && proc.state !== 'stopped');
  }

  private fire(proc: Process, tm: Timer): void {
    if (tm.signo) {
      this.settle(proc, tm);
      // A signal that would only be discarded isn't generated, and the last
      // signal's overruns stay the reported ones (Linux 6.13's ignored timers)
      if (!tm.queued && PosixTimers.discarded(proc, tm.signo)) tm.cur = 0;
      else if (tm.queued) tm.cur = Math.min(DELAYTIMER_MAX, tm.cur + 1);
      else {
        tm.queued = true;
        this.deliver(proc, tm.signo, { signo: tm.signo, code: A.SI_TIMER, timerid: tm.id, overrun: 0, value: tm.value });
      }
    }
    if (tm.interval > 0) {
      tm.deadline += tm.interval;
      // (behind by more than an interval: the missed expiries are overruns too)
      const behind = now() - tm.deadline;
      if (behind > tm.interval) {
        const n = Math.floor(behind / tm.interval);
        if (tm.signo) tm.cur = Math.min(DELAYTIMER_MAX, tm.cur + n);
        tm.deadline += n * tm.interval;
      }
      this.arm(proc, tm);
    } else tm.deadline = 0;
  }

  private arm(proc: Process, tm: Timer): void {
    const ms = tm.deadline - now();
    tm.handle = setTimeout(() => {
      if (proc.exiting || tm.deadline === 0) return;
      if (tm.deadline - now() > 1) { this.arm(proc, tm); return; } // (a long one waits in steps)
      this.fire(proc, tm);
    }, Math.min(0x7fffffff, Math.max(0, ms)));
    (tm.handle as { unref?: () => void })?.unref?.();
  }

  /** What `abs` (ms on the timer's clock) is on performance.now()'s */
  private toNow(clock: number, absMs: number): number {
    const at = clock === 0 || clock === 5 ? Date.now()
      : clock === 7 ? Date.now() - this.bootMs
      : performance.timeOrigin + performance.now(); // emscripten's CLOCK_MONOTONIC in Blink's threads
    return now() + (absMs - at);
  }

  private static spec(dv: DataView, off: number): number | null {
    const sec = Number(dv.getBigInt64(off, true)), nsec = Number(dv.getBigInt64(off + 8, true));
    if (sec < 0 || nsec < 0 || nsec >= 1e9) return null;
    return sec * 1000 + nsec / 1e6;
  }

  private static put(dv: DataView, off: number, ms: number): void {
    const ns = Math.max(0, Math.round(ms * 1e6));
    dv.setBigInt64(off, BigInt(Math.floor(ns / 1e9)), true);
    dv.setBigInt64(off + 8, BigInt(ns % 1e9), true);
  }

  private get(proc: Process, id: number): Timer | undefined {
    return (proc.data.posixTimers as Map<number, Timer> | undefined)?.get(id);
  }

  /** The time left and the interval into `out` (an itimerspec) */
  gettime(proc: Process, id: number, out: DataView): number {
    const tm = this.get(proc, id);
    if (!tm) return -A.EINVAL;
    PosixTimers.put(out, 0, tm.interval);
    // an armed timer due now still reads 1 ns, not 0 (0 means disarmed)
    PosixTimers.put(out, 16, tm.deadline ? Math.max(1e-6, tm.deadline - now()) : 0);
    return 0;
  }

  settime(proc: Process, id: number, flags: number, io: DataView): number {
    const tm = this.get(proc, id);
    if (!tm) return -A.EINVAL;
    const interval = PosixTimers.spec(io, 0), value = PosixTimers.spec(io, 16);
    if (interval === null || value === null) return -A.EINVAL;
    this.gettime(proc, id, io);
    if (tm.handle) clearTimeout(tm.handle);
    tm.handle = undefined;
    tm.interval = value > 0 ? interval : 0;
    if (value === 0) { tm.deadline = 0; return 0; }
    tm.deadline = flags & TIMER_ABSTIME ? this.toNow(tm.clock, value) : now() + value;
    this.arm(proc, tm);
    return 0;
  }

  getoverrun(proc: Process, id: number): number {
    const tm = this.get(proc, id);
    if (!tm) return -A.EINVAL;
    this.settle(proc, tm);
    return tm.last;
  }

  delete(proc: Process, id: number): number {
    const t = proc.data.posixTimers as Map<number, Timer> | undefined;
    const tm = t?.get(id);
    if (!tm) return -A.EINVAL;
    if (tm.handle) clearTimeout(tm.handle);
    tm.deadline = 0;
    t!.delete(id);
    return 0;
  }
}
