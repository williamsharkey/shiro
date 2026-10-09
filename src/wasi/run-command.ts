/**
 * run-command.ts — run a WASM program for a shell command.
 *
 * Uses a kernel process (./host.ts: Worker + blocking syscalls, or JSPI)
 * when the page can block, so stdin from a terminal is interactive, output
 * streams, and files are read and written as the program goes. Falls back
 * to the old in-page runtime (src/wasi-runtime.ts: preloaded files, fixed
 * stdin) when canBlock() === 'none'.
 */

import type { CommandContext } from '../commands/index';
import type { FileSystem } from '../filesystem';
import * as A from '../kernel/abi';
import { BufferFile, type OpenFile } from '../kernel/fd';
import { Kernel, getKernel } from '../kernel/kernel';
import { installWasmLoader, wasmProcessMode, wasmRunner } from './host';
import { SinkFile, TtyFile } from './stdio';

export interface RunWasiOptions {
  module: WebAssembly.Module;
  /** The binary, when known: needed to give threaded modules shared memory. */
  image?: Uint8Array;
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Absolute directories to preopen by name besides "/" and "." (see wasmRunner) */
  preopens?: string[];
  /** Directories the program sees at other paths: guest path → absolute directory (see wasmRunner) */
  mounts?: Record<string, string>;
  /** The program's own path, when not argv[0] found on PATH (see wasmRunner) */
  exe?: string;
  /** Preopen only `mounts` and `preopens`, not the default "/" and "." (see wasmRunner) */
  bare?: boolean;
}

const kernels = new WeakMap<FileSystem, Kernel>();

/** The page kernel when it serves this filesystem, else one per filesystem (tests). */
export function kernelForContext(ctx: CommandContext): Kernel {
  const page = getKernel();
  let k: Kernel;
  if (page.fs === ctx.fs) {
    k = page; // main.ts attached the page's fs and shell at boot
  } else {
    k = kernels.get(ctx.fs) ?? new Kernel({ fs: ctx.fs, shell: ctx.shell, registerWithProcessTable: false });
    kernels.set(ctx.fs, k);
  }
  if (!k.shell && ctx.shell) k.shell = ctx.shell;
  installWasmLoader(k);
  return k;
}

export async function runWasiProgram(ctx: CommandContext, opts: RunWasiOptions): Promise<number> {
  const cwd = opts.cwd ?? ctx.cwd;
  const env = { ...(opts.env ?? ctx.env) };
  // The kernel guest implements preview1; snapshot-0 programs keep the old
  // runtime, which adapts wasi_unstable (src/wasi-preview0.ts)
  const snapshot0 = WebAssembly.Module.imports(opts.module).some(i => i.module === 'wasi_unstable');
  if (wasmProcessMode() === 'none' || snapshot0) return runLegacy(ctx, opts, cwd, env);

  const term = ctx.terminal;
  const toTerminal = !!term && ctx.stdoutIsTTY !== false;
  const interactive = toTerminal && !ctx.stdin;
  // A terminal with a pty session: run as a foreground job on its tty (job control, termios, SIGWINCH)
  if (toTerminal && term!.tty && ctx.shell) {
    const { runKernelPipeline } = await import('../shell-kernel');
    const r = await runKernelPipeline(ctx.shell, [{ argv: opts.argv, run: wasmRunner(opts.module, opts.image, opts.preopens, opts.mounts, opts.exe, opts.bare) }], {
      stdin: ctx.stdin ? ctx.stdin : undefined,
      captureStdout: false,
      captureStderr: false,
      writeStdout: (t) => { ctx.stdout += t; },
      writeStderr: (t) => { ctx.stderr += t; },
      terminal: term,
      command: opts.argv.join(' '),
      cwd,
      env,
    });
    return r.exitCode;
  }
  const kernel = kernelForContext(ctx);
  let pgid = 0;
  let tty: TtyFile | null = null;
  let fds: Record<number, OpenFile>;
  if (interactive) {
    tty = new TtyFile({
      output: (t) => term!.writeOutput(t),
      signal: (sig) => { if (pgid) kernel.kill(-pgid, sig); },
    });
    const { cols, rows } = term!.getSize();
    env.TERM ??= 'xterm-256color';
    env.COLUMNS ??= String(cols);
    env.LINES ??= String(rows);
    fds = { 0: tty, 1: tty, 2: tty };
  } else {
    fds = {
      0: new BufferFile(ctx.stdin || '', A.O_RDONLY, { fifo: !!ctx.stdin }),
      1: toTerminal
        ? new SinkFile((t) => term!.writeOutput(t.replace(/\r?\n/g, '\r\n')), { tty: true })
        : new SinkFile((t) => { ctx.stdout += t; }),
      2: new SinkFile((t) => { ctx.stderr += t; }),
    };
  }

  // Its own process group, so ^C reaches it and everything it spawns
  const proc = kernel.spawn({ path: opts.argv[0], argv: opts.argv, env, cwd, fds, pgid: 0, run: wasmRunner(opts.module, opts.image, opts.preopens, opts.mounts, opts.exe, opts.bare) });
  pgid = proc.pgid;
  const abort = (ctx.shell as any)?.abortController as AbortController | null | undefined;
  const onAbort = () => { kernel.kill(-pgid, A.SIGINT); };
  abort?.signal.addEventListener('abort', onAbort);
  if (tty) term!.enterStdinPassthrough((d) => tty!.input(d), () => { kernel.kill(-pgid, A.SIGKILL); });
  try {
    const status = await proc.wait();
    await kernel.waitpid(proc.pid, A.WNOHANG); // reap it now rather than in 30 s
    return A.shellExitCode(status);
  } finally {
    abort?.signal.removeEventListener('abort', onAbort);
    if (tty) { tty.hangup(); term!.exitStdinPassthrough(); }
  }
}

async function runLegacy(ctx: CommandContext, opts: RunWasiOptions, cwd: string, env: Record<string, string>): Promise<number> {
  const { WasiRT, WasiExit } = await import('../wasi-runtime');
  const wasi = new WasiRT({
    fs: ctx.fs, cwd, args: opts.argv, env,
    stdin: ctx.stdin || '',
    stdinIsTTY: !ctx.stdin,
    stdoutIsTTY: ctx.stdoutIsTTY !== false,
    onStdout: (text) => { ctx.stdout += text; },
    onStderr: (text) => { ctx.stderr += text; },
    preopens: { '/': opts.mounts?.['/'] ?? '/', '.': cwd },
  });
  try {
    await wasi.preloadTree(cwd, 3, 100);
    return await wasi.run(opts.module);
  } catch (e) {
    if (e instanceof WasiExit) return e.code;
    throw e;
  }
}
