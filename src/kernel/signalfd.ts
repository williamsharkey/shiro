/**
 * signalfd(2): a descriptor that reads the caller's pending signals as
 * struct signalfd_siginfo (128 bytes each) instead of running handlers.
 * Only blocked signals stay pending (an unblocked one is delivered), so a
 * program blocks the signals with sigprocmask and then reads or polls the
 * fd (PostgreSQL 17's latch does this for SIGURG).
 *
 * A read takes signals from the reading process (as Linux does for the
 * reading thread); poll/epoll readiness is the creating process's, which is
 * the only reader in practice.
 */

import { type KStat, EAGAIN, EINTR, EINVAL, O_NONBLOCK, POLLIN, SIGKILL, SIGSTOP } from './abi';
import { type OpenFile, type OpenFileKind, ReadyListeners, abortableWait, charDevStat } from './fd';
import type { Process } from './process';

/** sizeof(struct signalfd_siginfo) */
export const SIGNALFD_SIGINFO_SIZE = 128;

/** Listeners of `proc` that a signal became pending (blocked) for it: kernel.deliver and signals.ts fire them. */
export function pendingSignalListeners(proc: Process): ReadyListeners {
  return (proc.data.signalfdListeners ??= new ReadyListeners()) as ReadyListeners;
}

/** A signal became pending for `proc`: wake its signalfds. */
export function notifySignalPending(proc: Process): void {
  (proc.data.signalfdListeners as ReadyListeners | undefined)?.fire();
}

export class SignalFile implements OpenFile {
  /** /proc/PID/fd's anon_inode:[signalfd] */
  readonly anonName = 'signalfd';
  kind: OpenFileKind = 'dev';
  path = 'anon_inode:[signalfd]';
  private mask = new Set<number>();
  private listeners = new ReadyListeners();
  private waiters = new Set<() => void>();
  private off: () => void;

  constructor(private owner: Process, mask: Set<number>, public flags = 0) {
    this.setMask(mask);
    this.off = pendingSignalListeners(owner).add(() => this.wake());
  }

  /** signalfd() on an existing fd replaces its mask (SIGKILL and SIGSTOP can't be read this way) */
  setMask(mask: Set<number>): void {
    this.mask = new Set([...mask].filter((s) => s !== SIGKILL && s !== SIGSTOP));
    this.wake();
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
    this.listeners.fire();
  }

  /** The lowest pending signal of `proc` in this fd's mask, or 0 */
  private next(proc: Process): number {
    let best = 0;
    for (const s of proc.deferredSignals) if (this.mask.has(s) && (best === 0 || s < best)) best = s;
    return best;
  }

  /** read(2) by `proc`: as many whole siginfo records as fit; blocks (unless O_NONBLOCK) until one is pending */
  async readAs(proc: Process, buf: Uint8Array, signal?: AbortSignal): Promise<number> {
    if (buf.length < SIGNALFD_SIGINFO_SIZE) return -EINVAL;
    while (!this.next(proc)) {
      if (this.flags & O_NONBLOCK) return -EAGAIN;
      // (signals the owner gets wake us; another reader re-checks on its own wake-ups)
      const wakes = proc === this.owner ? this.waiters : new Set<() => void>();
      const off = proc === this.owner ? () => {} : pendingSignalListeners(proc).add(() => { for (const w of [...wakes]) w(); });
      const ok = await abortableWait(wakes, signal);
      off();
      if (!ok) return -EINTR;
    }
    let n = 0;
    for (let sig; n + SIGNALFD_SIGINFO_SIZE <= buf.length && (sig = this.next(proc)); n += SIGNALFD_SIGINFO_SIZE) {
      // one instance (a real-time signal may have more queued), with what it carries
      const info = proc.takeSiginfo(sig, proc.deferredSignals);
      const rec = new DataView(buf.buffer, buf.byteOffset + n, SIGNALFD_SIGINFO_SIZE);
      for (let i = 0; i < SIGNALFD_SIGINFO_SIZE; i += 4) rec.setUint32(i, 0, true);
      rec.setUint32(0, sig, true); // ssi_signo
      rec.setInt32(8, info.code, true); // ssi_code
      rec.setUint32(12, info.pid ?? 0, true); // ssi_pid
      rec.setUint32(16, info.uid ?? proc.uid, true); // ssi_uid
      rec.setUint32(24, info.timerid ?? 0, true); // ssi_tid
      rec.setUint32(32, info.overrun ?? 0, true); // ssi_overrun
      rec.setInt32(40, info.status ?? 0, true); // ssi_status
      const v = info.value ?? 0n;
      rec.setInt32(44, Number(BigInt.asIntN(32, v)), true); // ssi_int
      rec.setBigUint64(48, BigInt.asUintN(64, v), true); // ssi_ptr
    }
    return n;
  }

  async read(buf: Uint8Array, signal?: AbortSignal): Promise<number> {
    return this.readAs(this.owner, buf, signal);
  }
  async write(): Promise<number> { return -EINVAL; }
  poll(events: number): number {
    return this.next(this.owner) ? events & POLLIN : 0;
  }
  onReady(cb: () => void): () => void { return this.listeners.add(cb); }
  async stat(): Promise<KStat> { return charDevStat(0); }
  async close(): Promise<void> {
    this.off();
    this.wake();
  }
}
