/**
 * What node-compat does differently as a kernel guest in a Worker
 * (TABCOMPUTER_NODE_WORKER=1): `ctx.nodeGuest`, set by guest.ts. Absent in
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
  /** Whether open handles (sockets, servers) keep the program running */
  busy?(): boolean;
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
