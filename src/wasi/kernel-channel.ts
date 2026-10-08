/**
 * kernel-channel.ts — serve a WASM guest's syscall channel through
 * Kernel.syscall, passing it a private copy of the data area.
 *
 * TEMPORARY WORKAROUND for src/kernel/channel.ts KernelChannel: it hands
 * Kernel.syscall a view of the SharedArrayBuffer, and Kernel.syscall decodes
 * paths and spawn JSON from it with TextDecoder, which browsers refuse for
 * shared memory (Node allows it, so headless tests pass). Every path syscall
 * from a Worker then fails with EIO in a real browser. Reported to
 * unix/kernel; once Kernel.syscall decodes copies, use KernelChannel again.
 *
 * The guest (./guest-worker.ts) puts the request's data length in arg slot
 * 11 and the most reply bytes it expects in slot 10 (no kernel syscall uses
 * more than 4 args), so only those bytes are copied.
 */

import * as A from '../kernel/abi';
import type { Kernel } from '../kernel/kernel';
import type { Process } from '../kernel/process';

export const ARG_REPLY_LEN = 10;
export const ARG_REQUEST_LEN = 11;

export class CopyingKernelChannel {
  readonly i32: Int32Array;
  readonly data: Uint8Array;
  private busy = false;
  private stopped = false;

  constructor(readonly sab: SharedArrayBuffer, readonly kernel: Kernel, readonly proc: Process) {
    this.i32 = new Int32Array(sab, 0, A.CH_DATA / 4);
    this.data = new Uint8Array(sab, A.CH_DATA);
    proc.data.onSignal = () => this.flagSignals();
  }

  /** Mirror the process's pending signals into the channel's signal word (as KernelChannel does). */
  flagSignals(): void {
    const next = [...this.proc.pendingSignals].sort((a, b) => a - b)[0];
    if (next !== undefined && Atomics.load(this.i32, A.CH_SIGNAL) === 0) {
      this.proc.pendingSignals.delete(next);
      Atomics.store(this.i32, A.CH_SIGNAL, next);
    }
  }

  async handle(): Promise<void> {
    if (this.busy || this.stopped) return;
    if (Atomics.load(this.i32, A.CH_STATE) !== A.STATE_REQUEST) return;
    this.busy = true;
    try {
      const nr = this.i32[A.CH_SYSNO];
      const args = Array.from(this.i32.subarray(A.CH_ARGS, A.CH_ARGS + A.CH_NARGS));
      const clamp = (n: number) => Math.max(0, Math.min(n | 0, this.data.length));
      const reqLen = clamp(args[ARG_REQUEST_LEN]);
      const size = Math.max(reqLen, clamp(args[ARG_REPLY_LEN]));
      const buf = this.data.slice(0, size); // not shared, so the kernel can decode it
      let result = await this.kernel.syscall(this.proc, nr, args, buf);
      if (this.stopped || this.proc.exiting) return;
      this.data.set(buf);
      if (result > 0x7fffffff || result < -0x80000000) {
        this.i32[A.CH_ARGS] = Math.floor(result / 0x100000000);
        result = result >>> 0;
      } else {
        this.i32[A.CH_ARGS] = result < 0 ? -1 : 0;
      }
      this.i32[A.CH_RESULT] = result | 0;
      this.flagSignals();
      Atomics.store(this.i32, A.CH_STATE, A.STATE_REPLY);
      Atomics.notify(this.i32, A.CH_STATE);
    } finally {
      this.busy = false;
    }
  }

  stop(): void {
    this.stopped = true;
  }
}
