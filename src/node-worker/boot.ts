/**
 * What the page needs of node-worker at boot, kept small: whether node runs
 * as a kernel guest for a process (by default, where the page can: a
 * blocking channel, a way to make the Worker; TABCOMPUTER_NODE_WORKER=0 in
 * the environment keeps node in the page), and a kernel loader that only
 * then loads the rest (host.ts and the guest's Worker) — a page that never
 * runs node never fetches them.
 */
import type { Kernel } from '../kernel/kernel';
import { canBlock } from '../kernel/channel';
import type { GuestWorker } from '../kernel/worker-host';
import type { Runner } from '../kernel/kernel';

let factory: (() => GuestWorker) | null = null;

/** Tests (Node worker_threads) set how a guest worker is made; null restores the default */
export function setNodeWorkerFactory(f: (() => GuestWorker) | null): void { factory = f; }
export function nodeWorkerFactory(): (() => GuestWorker) | null { return factory; }

/** Whether `node` runs as a kernel guest here: where it can, unless TABCOMPUTER_NODE_WORKER=0 */
export function nodeWorkerMode(env: Record<string, string | undefined>): boolean {
  if (env.TABCOMPUTER_NODE_WORKER === '0' || canBlock() !== 'sab') return false;
  return !!factory || (typeof Worker !== 'undefined' && typeof window !== 'undefined');
}

const installed = new WeakSet<Kernel>();

/**
 * When node runs as a guest (nodeWorkerMode), a process the kernel
 * starts as `node` (or as a `#!...node` script) runs the guest itself
 * (host.ts nodeLoader); `sh -c 'node ...'` (execSync, npm scripts) execs it
 * in place so the loader sees it. With TABCOMPUTER_NODE_WORKER=0 nothing changes.
 */
export function installNodeWorkerBoot(kernel: Kernel): void {
  if (installed.has(kernel)) return;
  installed.add(kernel);
  kernel.execDirect.push((name, proc) => name === 'node' && nodeWorkerMode(proc.env));
  kernel.addLoader((path, proc, k) => {
    // (the first loader of every spawn: a bare name other than node is no node program,
    // known without loading host.ts or awaiting anything)
    if (!path.includes('/') && path !== 'node') return null;
    if (!nodeWorkerMode(proc.env)) return null;
    return import('./host').then((h) => h.nodeLoader(path, proc, k));
  });
}

/**
 * The shell's view (shell-kernel.ts): with the flag on, `node ARGS` is a
 * kernel program like any other, so pipes, redirects and a kernel shell's
 * own fds work as they do for WASM and x86 programs, and node is the
 * child of the shell that runs it. Null otherwise (the builtin runs).
 */
export function nodeKernelProgram(env: Record<string, string | undefined>, name: string, args: string[], terminal?: unknown): { argv: string[]; run: Runner } | null {
  if (name !== 'node' || !nodeWorkerMode(env)) return null;
  // A terminal with no pty behind it (a stand-in that takes text) isn't a kernel program's: the builtin's
  if (terminal && !(terminal as { tty?: unknown }).tty) return null;
  return {
    argv: ['node', ...args],
    run: async (proc, kernel) => {
      const host = await import('./host');
      host.installNodeLoader(kernel); // node that this node starts runs as a guest too
      return host.nodeWorkerRunner()(proc, kernel);
    },
  };
}
