/**
 * Runs a guest in a Worker bound to a kernel Process: creates the syscall
 * channel, posts the start message, serves syscalls, and terminates the
 * worker when the process exits or is killed (SIGKILL → worker.terminate()).
 */

import type { Kernel, Runner, SpawnOptions } from './kernel';
import type { Process } from './process';
import { KernelChannel, createChannelBuffer, SYS_MESSAGE, type GuestStartMessage } from './channel';

/** The parts of a Worker the host needs; adapters below wrap browser and Node workers. */
export interface GuestWorker {
  postMessage(msg: unknown): void;
  terminate(): unknown;
  /** Subscribe to message payloads from the guest. */
  onMessage(cb: (msg: unknown) => void): void;
  onError(cb: (err: unknown) => void): void;
  /** Called when the worker's script ends on its own (Node reports this; browsers don't). */
  onExit?(cb: (code: number) => void): void;
}

/** Adapter for a browser Worker. */
export function webWorker(w: Worker): GuestWorker {
  return {
    postMessage: m => w.postMessage(m),
    terminate: () => w.terminate(),
    onMessage: cb => w.addEventListener('message', e => cb((e as MessageEvent).data)),
    onError: cb => w.addEventListener('error', e => { e.preventDefault?.(); cb((e as ErrorEvent).error ?? new Error((e as ErrorEvent).message)); }),
  };
}

export interface WorkerRunnerOptions {
  /** Channel data area size in bytes (default 1 MiB). */
  dataSize?: number;
  /** Extra fields for the start message (module URL, wasm bytes, ...). */
  startData?: Record<string, unknown>;
}

/** A Runner that starts `createWorker()` as the process. */
export function workerRunner(createWorker: (proc: Process) => GuestWorker, opts: WorkerRunnerOptions = {}): Runner {
  return (proc: Process, kernel: Kernel) => new Promise<number | void>(resolve => {
    const sab = createChannelBuffer(opts.dataSize);
    const channel = new KernelChannel(sab, kernel, proc);
    const worker = createWorker(proc);
    proc.data.worker = worker;
    proc.data.channel = channel;
    proc.onTerminate(() => {
      channel.stop();
      try { void worker.terminate(); } catch { /* already gone */ }
      resolve();
    });
    worker.onMessage(m => {
      if (m === SYS_MESSAGE) void channel.handle();
    });
    worker.onError(err => {
      const msg = (err as Error)?.message ?? String(err);
      void kernel.writeAll(proc, 2, new TextEncoder().encode(`${proc.comm}: ${msg}\n`)).finally(() => resolve(1));
    });
    worker.onExit?.(code => resolve(code));
    const start: GuestStartMessage = {
      type: 'shiro-start', sab, pid: proc.pid, argv: proc.argv, env: proc.env, cwd: proc.cwd,
      ...(opts.startData ?? {}),
    };
    worker.postMessage(start);
  });
}

/** Spawn a process whose program is a guest Worker. */
export function startWorker(
  kernel: Kernel,
  createWorker: (proc: Process) => GuestWorker,
  spawn: Omit<SpawnOptions, 'run'>,
  opts: WorkerRunnerOptions = {},
): Process {
  return kernel.spawn({ ...spawn, run: workerRunner(createWorker, opts) });
}
