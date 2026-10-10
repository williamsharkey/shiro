/**
 * What the page needs of node-worker at boot, kept small: whether node runs
 * as a kernel guest for a process (TABCOMPUTER_NODE_WORKER=1, a blocking
 * channel, a way to make the Worker), and a kernel loader that only then
 * loads the rest (host.ts and the guest's Worker) — a page that never sets
 * the flag never fetches them.
 */
import type { Kernel } from '../kernel/kernel';
import { canBlock } from '../kernel/channel';
import type { GuestWorker } from '../kernel/worker-host';
import type { Runner } from '../kernel/kernel';

let factory: (() => GuestWorker) | null = null;

/** Tests (Node worker_threads) set how a guest worker is made; null restores the default */
export function setNodeWorkerFactory(f: (() => GuestWorker) | null): void { factory = f; }
export function nodeWorkerFactory(): (() => GuestWorker) | null { return factory; }

/** Whether `node` runs as a kernel guest here */
export function nodeWorkerMode(env: Record<string, string | undefined>): boolean {
  if (env.TABCOMPUTER_NODE_WORKER !== '1' || canBlock() !== 'sab') return false;
  return !!factory || (typeof Worker !== 'undefined' && typeof window !== 'undefined');
}

const installed = new WeakSet<Kernel>();

/**
 * With TABCOMPUTER_NODE_WORKER=1 in its environment, a process the kernel
 * starts as `node` (or as a `#!...node` script) runs the guest itself
 * (host.ts nodeLoader); `sh -c 'node ...'` (execSync, npm scripts) execs it
 * in place so the loader sees it. Without the flag nothing changes.
 */
export function installNodeWorkerBoot(kernel: Kernel): void {
  if (installed.has(kernel)) return;
  installed.add(kernel);
  kernel.execDirect.push((name, proc) => name === 'node' && nodeWorkerMode(proc.env));
  kernel.addLoader(async (path, proc, k) => {
    if (!nodeWorkerMode(proc.env)) return null;
    return (await import('./host')).nodeLoader(path, proc, k);
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
