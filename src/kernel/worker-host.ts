/**
 * Runs a guest in a Worker bound to a kernel Process: creates the syscall
 * channel, posts the start message, serves syscalls, and terminates the
 * worker when the process exits or is killed (SIGKILL → worker.terminate()).
 */

import type { Kernel, Runner, SpawnOptions } from './kernel';
import type { Process } from './process';
import { KernelChannel, canWatch, createChannelBuffer, SYS_MESSAGE, type GuestStartMessage } from './channel';
import { W_EXITCODE } from './abi';

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
    const wake = serve(channel, worker);
    worker.onError(err => {
      if (proc.exiting) return;
      const msg = (err as Error)?.message ?? String(err);
      kernel.reportFatal(proc, msg);
      void kernel.writeAll(proc, 2, new TextEncoder().encode(`${proc.comm}: ${msg}\n`)).finally(() => resolve(1));
    });
    worker.onExit?.(code => resolve(code));
    const start: GuestStartMessage = {
      type: 'shiro-start', sab, pid: proc.pid, argv: proc.argv, env: proc.env, cwd: proc.cwd, wake,
      ...(opts.startData ?? {}),
    };
    worker.postMessage(start);
  });
}

/**
 * Serve `channel` for `worker`: with Atomics.waitAsync the kernel watches the
 * state word (faster, and the guest posts nothing per request); otherwise it
 * answers each SYS_MESSAGE. Returns the start message's `wake` field.
 */
export function serve(channel: KernelChannel, worker: GuestWorker): 'atomics' | 'message' {
  if (canWatch()) {
    void channel.watch();
    return 'atomics';
  }
  worker.onMessage(m => {
    if (m === SYS_MESSAGE) void channel.handle();
  });
  return 'message';
}

export interface GuestThread {
  tid: number;
  worker: GuestWorker;
  channel: KernelChannel;
  /** Resolves with the thread's exit code (SYS_exit), or undefined if the process ended first. */
  exited: Promise<number | undefined>;
  /** Stop this thread only. */
  terminate(): void;
}

/**
 * Run an extra Worker as a thread of `proc`: its own channel and tid, the
 * same fds, cwd and signal state. SYS_exit from it ends only the thread;
 * exit_group (or the process being killed) ends every thread. The start
 * message carries `tid` (and anything in `opts.startData`).
 */
export function attachThread(
  kernel: Kernel,
  proc: Process,
  createWorker: (proc: Process, tid: number) => GuestWorker,
  opts: WorkerRunnerOptions = {},
): GuestThread {
  const tid = kernel.allocTid(proc);
  const sab = createChannelBuffer(opts.dataSize);
  let finish!: (code: number | undefined) => void;
  const exited = new Promise<number | undefined>(r => { finish = r; });
  let done = false;
  const worker = createWorker(proc, tid);
  const end = (code: number | undefined) => {
    if (done) return;
    done = true;
    channel.stop();
    proc.tids.delete(tid);
    try { void worker.terminate(); } catch { /* already gone */ }
    finish(code);
  };
  const channel: KernelChannel = new KernelChannel(sab, kernel, proc, { tid, onThreadExit: code => end(code) });
  proc.onTerminate(() => end(undefined));
  const wake = serve(channel, worker);
  worker.onError(err => {
    if (done || proc.exiting) return;
    // An uncaught error in any thread takes the process down, as a crash would
    const msg = (err as Error)?.message ?? String(err);
    kernel.reportFatal(proc, `thread ${tid}: ${msg}`);
    void kernel.writeAll(proc, 2, new TextEncoder().encode(`${proc.comm}[${tid}]: ${msg}\n`))
      .finally(() => kernel.exit(proc, W_EXITCODE(1)));
  });
  worker.onExit?.(() => end(undefined));
  const start: GuestStartMessage & { tid: number } = {
    type: 'shiro-start', sab, pid: proc.pid, tid, argv: proc.argv, env: proc.env, cwd: proc.cwd, wake,
    ...(opts.startData ?? {}),
  };
  worker.postMessage(start);
  return { tid, worker, channel, exited, terminate: () => end(undefined) };
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
