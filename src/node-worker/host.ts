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
import type { Kernel, Runner } from '../kernel/kernel';
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

/** A guest on a terminal started a server: its preview pane, as for node in the page */
function openPreview(port: number): void {
  if (typeof document === 'undefined') return;
  setTimeout(() => {
    import('../iframe-server').then(({ iframeServer }) => {
      if (!iframeServer.isPortInUse(port)) return; // gone already (a script that starts a server, uses and closes it)
      return import('../split-view').then(({ createSplitView }) => createSplitView({ port, direction: 'right', title: `Server :${port}` }));
    }).catch(() => { /* no desktop to show it in */ });
  }, 1000);
}

/** The kernel Runner: the process's program is a node guest worker */
export function nodeWorkerRunner(): Runner {
  return workerRunner(() => {
    const w = createNodeWorker();
    w.onMessage((m: any) => { if (m?.type === 'node-guest-listen' && typeof m.port === 'number') openPreview(m.port); });
    return w;
  }, { dataSize: 1 << 20 });
}

/** `#!/usr/bin/env node`, `#!/usr/bin/env -S node --flag`, `#!/usr/local/bin/node`: the flags after node, or null */
export function nodeShebangArgs(head: string): string[] | null {
  if (!head.startsWith('#!')) return null;
  const words = head.slice(2).split('\n')[0].replace(/\r$/, '').trim().split(/\s+/);
  let i = 0;
  if (/^\/(usr\/)?bin\/env$/.test(words[0])) {
    i = 1;
    if (words[1] === '-S') i = 2;
  }
  return /^(\/(usr\/)?(local\/)?bin\/)?node$/.test(words[i] ?? '') && (i > 0 || words[i].startsWith('/')) ? words.slice(i + 1) : null;
}

const loaderInstalled = new WeakSet<Kernel>();

/**
 * With TABCOMPUTER_NODE_WORKER=1 in its environment, a process the kernel
 * starts as `node` (or as a `#!...node` script) runs the guest itself: its
 * fds are the node's stdio and it is the process its parent waits for (not a
 * builtin that starts a second process for the guest). Otherwise (the flag off, no blocking channel, a packaged node
 * on PATH) the usual loaders run it as before.
 */
export function installNodeLoader(kernel: Kernel): void {
  if (loaderInstalled.has(kernel)) return;
  loaderInstalled.add(kernel);
  // the guest's sockets are kernel sockets (the page's kernel has them from boot)
  void import('../kernel/net').then((n) => { if (!n.netStackOf(kernel)) n.installNet(kernel); });
  // `sh -c 'node ...'` (execSync, npm scripts) execs node in place, so this loader sees it
  kernel.execDirect.push((name, proc) => name === 'node' && proc.env.TABCOMPUTER_NODE_WORKER === '1' && nodeWorkerMode(proc.env));
  kernel.addLoader(async (path, proc, k) => {
    if (proc.env.TABCOMPUTER_NODE_WORKER !== '1' || !nodeWorkerMode(proc.env) || !k.shell?.commands.get('node')) return null;
    const fs = k.fs;
    const base = path.slice(path.lastIndexOf('/') + 1);
    if (base === 'node' && (!path.includes('/') || /^\/(usr\/)?(local\/)?bin\/node$/.test(path))) {
      if (fs && (await import('../pkg-manager')).packageShadows(fs).has('node')) return null;
      return nodeWorkerRunner();
    }
    if (!fs || !path.includes('/')) return null;
    let flags: string[] | null;
    try {
      const abs = fs.resolvePath(path, proc.cwd);
      const raw = await fs.readFile(abs);
      const head = typeof raw === 'string' ? raw.slice(0, 256) : A.decodeText(raw.subarray(0, 256));
      flags = nodeShebangArgs(head);
    } catch { return null; }
    if (!flags || (await import('../pkg-manager')).packageShadows(fs).has('node')) return null;
    const run = nodeWorkerRunner();
    return (p, kk) => {
      p.argv = ['node', ...flags!, path, ...p.argv.slice(1)];
      return run(p, kk);
    };
  });
}

/** `node ARGS` from the shell as a kernel process: a foreground job on the terminal's pty, or on the shell's stdio */
export async function runNodeInWorker(ctx: CommandContext): Promise<number> {
  const argv = ['node', ...ctx.args];
  const env = { ...ctx.env };
  const { kernelForContext } = await import('../wasi/run-command');
  installNodeLoader(kernelForContext(ctx)); // node that this node starts runs as a guest too
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
