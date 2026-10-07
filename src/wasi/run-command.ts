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
import { shellExitCode, SIGINT, SIGKILL } from './abi';
import { BufferSource, CallbackSink, OpenFile, TtyFile, kernelFor } from './kernel';
import { installWasmBinfmt, startWasmProcess, wasmProcessMode } from './host';

export interface RunWasiOptions {
  module: WebAssembly.Module;
  /** The binary, when known: needed to give threaded modules shared memory. */
  image?: Uint8Array;
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
}

const installed = new WeakSet<object>();

export async function runWasiProgram(ctx: CommandContext, opts: RunWasiOptions): Promise<number> {
  const cwd = opts.cwd ?? ctx.cwd;
  const env = { ...(opts.env ?? ctx.env) };
  if (wasmProcessMode() === 'none') return runLegacy(ctx, opts, cwd, env);

  const kernel = kernelFor(ctx.fs);
  if (ctx.shell) kernel.shell = ctx.shell;
  if (!installed.has(kernel)) { installWasmBinfmt(kernel); installed.add(kernel); }

  const term = ctx.terminal;
  const toTerminal = !!term && ctx.stdoutIsTTY !== false;
  const interactive = toTerminal && !ctx.stdin;
  let pgid = 0;
  let tty: TtyFile | null = null;
  let fds: Record<number, OpenFile>;
  if (interactive) {
    tty = new TtyFile({
      output: (t) => term!.writeOutput(t),
      signal: (sig) => { if (pgid) void kernel.kill(-pgid, sig); },
      size: () => term!.getSize(),
    });
    const { cols, rows } = term!.getSize();
    env.TERM ??= 'xterm-256color';
    env.COLUMNS ??= String(cols);
    env.LINES ??= String(rows);
    fds = { 0: tty, 1: tty, 2: tty };
  } else {
    const stdout = toTerminal
      ? new CallbackSink((t) => term!.writeOutput(t.replace(/\r?\n/g, '\r\n')), { tty: true })
      : new CallbackSink((t) => { ctx.stdout += t; });
    fds = {
      0: new BufferSource(new TextEncoder().encode(ctx.stdin || '')),
      1: stdout,
      2: new CallbackSink((t) => { ctx.stderr += t; }),
    };
  }

  const proc = kernel.createProcess({ argv: opts.argv, env, cwd, fds });
  pgid = proc.pgid;
  const abort = (ctx.shell as any)?.abortController as AbortController | null | undefined;
  const onAbort = () => { void kernel.kill(proc.pid, SIGINT); };
  abort?.signal.addEventListener('abort', onAbort);
  if (tty) term!.enterStdinPassthrough((d) => tty!.input(d), () => { void kernel.kill(-pgid, SIGKILL); });
  try {
    await startWasmProcess(kernel, proc, opts.module, opts.image);
    const status = await proc.wait();
    return shellExitCode(status);
  } catch (e: any) {
    ctx.stderr += `${opts.argv[0]}: ${e?.message ?? e}\n`;
    await proc.exit(1 << 8);
    return 1;
  } finally {
    kernel.reap(proc);
    abort?.signal.removeEventListener('abort', onAbort);
    if (tty) { tty.hangup(); term!.exitStdinPassthrough(); }
  }
}

async function runLegacy(ctx: CommandContext, opts: RunWasiOptions, cwd: string, env: Record<string, string>): Promise<number> {
  const { WasiRT, WasiExit } = await import('../wasi-runtime');
  const wasi = new WasiRT({
    fs: ctx.fs, cwd, args: opts.argv, env,
    stdin: ctx.stdin || '',
    onStdout: (text) => { ctx.stdout += text; },
    onStderr: (text) => { ctx.stderr += text; },
    preopens: { '/': '/', '.': cwd },
  });
  try {
    await wasi.preloadTree(cwd, 3, 100);
    return await wasi.run(opts.module);
  } catch (e) {
    if (e instanceof WasiExit) return e.code;
    throw e;
  }
}
