/**
 * What node-compat does differently as a kernel guest in a Worker
 * (by default; TABCOMPUTER_NODE_WORKER=0 opts out): `ctx.nodeGuest`, set by guest.ts. Absent in
 * the page, where node-compat works as before.
 */
import type { ChildOptions, ChildResult } from './child';

export interface NodeGuestHooks {
  /** A file's text for the module/file cache (read through on a miss), undefined if missing or binary */
  readText(path: string): string | undefined;
  /** child_process's sync calls: run `sh -c CMD` to the end (blocks the worker) */
  runChildSync(cmd: string, opts?: ChildOptions): ChildResult;
  /** child_process's async calls: the same, the event loop running meanwhile */
  runChild(cmd: string, opts?: ChildOptions): Promise<ChildResult>;
  /** Write to fd 1 or 2 now (output streams to a pipe or file instead of waiting for exit) */
  writeOut?(fd: 1 | 2, s: string): void;
  /** node's net module's stack: sockets over socket syscalls (net.ts) */
  netStack?: unknown;
  /** Who hears the worker's unhandled promise rejections (node's process 'unhandledRejection'; null: nobody) */
  onUnhandledRejection?(fn: ((reason: unknown, promise: Promise<unknown>) => void) | null): void;
  /** worker_threads: start `file` (or code, with eval) as a thread of this process, a guest of its own */
  startThread?(file: string, opts: { threadId: number; eval?: boolean; workerData?: unknown; argv?: string[]; env?: Record<string, string> }, events: ThreadEvents): ThreadHandle;
  /** Set in a worker_threads thread */
  thread?: ThreadSide;
  /** process.stdin on the terminal: fd 0 read as the process on the pty (tty.ts); set when fd 0 is a tty */
  ttyStdin?(on: { data(text: string): void; end(): void; signal(sig: number): void }): {
    readonly reading: boolean; start(): void; pause(): void; setRaw(on: boolean): void; close(): void;
  };
  /** What only the page can do: the clipboard, a server's preview pane */
  page?: { clipboard(text: string): void; preview(port: number): void };
  /** Whether open handles (sockets, servers) keep the program running */
  busy?(): boolean;
  /**
   * NODE_CHANNEL_FD: this node was forked (fork(), stdio 'ipc') and this is its
   * channel to the parent: newline-delimited JSON both ways, as node's 'json'
   * serialization. Bytes as they arrive, null when the parent closes it.
   */
  ipc?: GuestIpc;
  /** The kernel's process ids for this node (process.pid, process.ppid) */
  ids?: { pid: number; ppid: number };
  /** kill(2) another process: 0 or -errno */
  kill?(pid: number, sig: number): number;
  /** node:wasi's preview1 imports: blocking syscalls on this thread's channel (modules/wasi.ts) */
  wasi?: import('../node-compat/modules/wasi').WasiSys;
}

/** A worker_threads Worker's thread, as its parent sees it */
export interface ThreadHandle {
  post(value: unknown): void;
  terminate(): void;
}

export interface ThreadEvents {
  online(): void;
  message(value: unknown): void;
  error(err: { message: string; stack?: string }): void;
  exit(code: number): void;
}

/** In a worker_threads thread: its side of the link to the parent */
export interface ThreadSide {
  threadId: number;
  workerData: unknown;
  post(value: unknown): void;
  onMessage(fn: (value: unknown) => void): void;
}

export function nodeGuestOf(ctx: unknown): NodeGuestHooks | undefined {
  return (ctx as { nodeGuest?: NodeGuestHooks } | null)?.nodeGuest;
}

export interface GuestIpc {
  /** Write a whole message (blocks until the kernel takes it); false once closed */
  send(text: string): boolean;
  /** Start reading: chunks to `fn`, then null at the channel's end */
  onData(fn: (b: Uint8Array | null) => void): void;
  close(): void;
}
