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
}

export function nodeGuestOf(ctx: unknown): NodeGuestHooks | undefined {
  return (ctx as { nodeGuest?: NodeGuestHooks } | null)?.nodeGuest;
}
