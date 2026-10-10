/**
 * The page's side of node as a kernel guest (TABCOMPUTER_NODE_WORKER=1):
 * `node` runs as a kernel process whose program is a Worker (guest.ts), so
 * its files and children are real syscalls and its *Sync child_process
 * calls really block. Needs a blocking channel (a cross-origin isolated
 * page); otherwise node runs in the page as before.
 */
import type { CommandContext } from '../commands/index';
import * as A from '../kernel/abi';
import { canBlock } from '../kernel/channel';
import { BufferFile, type OpenFile } from '../kernel/fd';
import type { Runner } from '../kernel/kernel';
import { webWorker, workerRunner, type GuestWorker } from '../kernel/worker-host';

let factory: (() => GuestWorker) | null = null;

/** Tests (Node worker_threads) set how a guest worker is made; null restores the default */
export function setNodeWorkerFactory(f: (() => GuestWorker) | null): void { factory = f; }

function createNodeWorker(): GuestWorker {
  if (factory) return factory();
  // The browser: a module worker built from guest-entry.ts (vite bundles it)
  return webWorker(new Worker(new URL('./guest-entry.ts', import.meta.url), { type: 'module', name: 'node' }));
}

/** Whether `node` runs as a kernel guest here */
export function nodeWorkerMode(env: Record<string, string | undefined>): boolean {
  if (env.TABCOMPUTER_NODE_WORKER !== '1' || canBlock() !== 'sab') return false;
  return !!factory || (typeof Worker !== 'undefined' && typeof window !== 'undefined');
}

/** The kernel Runner: the process's program is a node guest worker */
export function nodeWorkerRunner(): Runner {
  return workerRunner(() => createNodeWorker(), { dataSize: 1 << 20 });
}

/** `node ARGS` from the shell as a kernel process: a foreground job on the terminal's pty, or on the shell's stdio */
export async function runNodeInWorker(ctx: CommandContext): Promise<number> {
  const argv = ['node', ...ctx.args];
  const env = { ...ctx.env };
  const term = ctx.terminal;
  const toTerminal = !!term && ctx.stdoutIsTTY !== false;
  const readStdin = (ctx as any).readStdin as (() => Promise<string>) | undefined;
  // (a lazy stdin that isn't the terminal is read before the program starts)
  if (!ctx.stdin && readStdin && !(toTerminal && term!.tty)) ctx.stdin = await readStdin();
  if (toTerminal && term!.tty && ctx.shell) {
    const { runKernelPipeline } = await import('../shell-kernel');
    const r = await runKernelPipeline(ctx.shell, [{ argv, run: nodeWorkerRunner() }], {
      stdin: ctx.stdin ? ctx.stdin : undefined,
      captureStdout: false,
      captureStderr: false,
      writeStdout: (t) => { ctx.stdout += t; },
      writeStderr: (t) => { ctx.stderr += t; },
      terminal: term,
      command: argv.join(' '),
      cwd: ctx.cwd,
      env,
    });
    return r.exitCode;
  }
  const { kernelForContext } = await import('../wasi/run-command');
  const { SinkFile } = await import('../wasi/stdio');
  const kernel = kernelForContext(ctx);
  const fds: Record<number, OpenFile> = {
    0: new BufferFile(ctx.stdin || '', A.O_RDONLY, { fifo: !!ctx.stdin }),
    1: toTerminal
      ? new SinkFile((t) => term!.writeOutput(t.replace(/\r?\n/g, '\r\n')), { tty: true })
      : new SinkFile((t) => { ctx.stdout += t; }),
    2: new SinkFile((t) => { ctx.stderr += t; }),
  };
  const proc = kernel.spawn({ path: 'node', argv, env, cwd: ctx.cwd, fds, pgid: 0, run: nodeWorkerRunner() });
  const abort = (ctx.shell as any)?.abortController as AbortController | null | undefined;
  const onAbort = () => { kernel.kill(-proc.pgid, A.SIGINT); };
  abort?.signal.addEventListener('abort', onAbort);
  try {
    const status = await proc.wait();
    await kernel.waitpid(proc.pid, A.WNOHANG);
    return A.shellExitCode(status);
  } finally {
    abort?.signal.removeEventListener('abort', onAbort);
  }
}
