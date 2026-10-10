/**
 * The page's side of node as a kernel guest (TABCOMPUTER_NODE_WORKER=1):
 * `node` runs as a kernel process whose program is a Worker (guest.ts), so
 * its files and children are real syscalls and its *Sync child_process
 * calls really block. Needs a blocking channel (a cross-origin isolated
 * page); otherwise node runs in the page as before.
 */
import type { CommandContext } from '../commands/index';
import * as A from '../kernel/abi';
import { BufferFile, type OpenFile } from '../kernel/fd';
import type { Kernel, Runner } from '../kernel/kernel';
import { attachThread, webWorker, workerRunner, type GuestThread, type GuestWorker } from '../kernel/worker-host';
import { installNodeWorkerBoot, nodeWorkerFactory, nodeWorkerMode } from './boot';
import type { Process } from '../kernel/process';

export { setNodeWorkerFactory, nodeWorkerMode } from './boot';

function createNodeWorker(): GuestWorker {
  const factory = nodeWorkerFactory();
  if (factory) return factory();
  // The browser: a module worker built from guest-entry.ts (vite bundles it)
  return webWorker(new Worker(new URL('./guest-entry.ts', import.meta.url), { type: 'module', name: 'node' }));
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

/**
 * The page's side of a node guest worker (the process's main thread or a
 * worker_threads thread): its preview pane, the filesystem's changes once it
 * watches, and the threads it starts (each a guest of its own, attached to
 * the process; their messages pass through here).
 */
function wire(w: GuestWorker, proc: Process, kernel: Kernel): void {
  let watching = false;
  const threads = new Map<number, GuestThread>();
  const toGuest = (m: unknown) => { try { w.postMessage(m); } catch { /* gone */ } };
  w.onMessage((m: any) => {
    switch (m?.type) {
      case 'node-guest-listen':
        if (typeof m.port === 'number') openPreview(m.port);
        return;
      case 'node-guest-watch': {
        // fs.watch in the guest: the filesystem's changes (every process's writes) go to it
        if (watching || !kernel.fs) return;
        watching = true;
        const off = kernel.fs.onChange((event, path, newPath) => toGuest({ type: 'node-guest-fs', event, path, newPath }));
        proc.onTerminate(off);
        return;
      }
      case 'node-guest-thread': {
        const id = m.id as number;
        let exited = false;
        const ev = (kind: string, value?: unknown) => {
          if (exited) return;
          if (kind === 'exit') { exited = true; threads.delete(id); }
          toGuest({ type: 'node-guest-thread-ev', id, kind, value });
        };
        let th: GuestThread;
        try {
          th = attachThread(kernel, proc, () => {
            const tw = createNodeWorker();
            wire(tw, proc, kernel);
            tw.onMessage((o: any) => { if (o?.type === 'node-thread-out') ev(o.kind, o.value); });
            return tw;
          }, {
            dataSize: 1 << 20,
            startData: { nodeThread: { file: m.file, eval: m.eval, workerData: m.workerData, argv: m.argv, threadId: m.threadId } },
          });
        } catch (e: any) {
          ev('error', { message: String(e?.message ?? e) });
          ev('exit', 1);
          return;
        }
        threads.set(id, th);
        ev('online');
        // A thread says when it exits, after its last messages; one that was killed doesn't
        void th.exited.then((code) => setTimeout(() => ev('exit', code ?? 1), 200));
        return;
      }
      case 'node-guest-thread-post':
        try { threads.get(m.id)?.worker.postMessage({ type: 'node-guest-parent-msg', value: m.value }); } catch { /* gone */ }
        return;
      case 'node-guest-thread-kill':
        threads.get(m.id)?.terminate();
        return;
    }
  });
}

/** The kernel Runner: the process's program is a node guest worker */
export function nodeWorkerRunner(): Runner {
  return (proc, kernel) => workerRunner((p) => {
    const w = createNodeWorker();
    wire(w, p, kernel);
    return w;
  }, { dataSize: 1 << 20 })(proc, kernel);
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

/**
 * The kernel's node loader (boot.ts calls it once the flag is on): `node` by
 * name or in a bin directory, or a `#!...node` script, runs the guest itself:
 * its fds are the node's stdio and it is the process its parent waits for.
 * A packaged node on PATH, or no node builtin, leaves it to the other loaders.
 */
export async function nodeLoader(path: string, proc: Process, k: Kernel): Promise<Runner | null> {
  if (!nodeWorkerMode(proc.env) || !k.shell?.commands.get('node')) return null;
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
}

/** A kernel that may not have booted with node-worker (tests' kernels): its loader and socket syscalls */
export function installNodeLoader(kernel: Kernel): void {
  installNodeWorkerBoot(kernel);
  // the guest's sockets are kernel sockets (the page's kernel has them from boot)
  void import('../kernel/net').then((n) => { if (!n.netStackOf(kernel)) n.installNet(kernel); });
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
