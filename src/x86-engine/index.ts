/**
 * Picks the engine for x86-64 Linux ELF binaries.
 *
 *   blink — jart/blink compiled to WebAssembly (src/x86-engine/blink.ts).
 *           Real threads, futex, epoll, signals, SSE; needs SharedArrayBuffer
 *           (a cross-origin isolated page, or Node).
 *   x86   — the built-in TypeScript interpreter (src/x86). Single-threaded,
 *           main thread; fine for small static tools.
 *
 * `SHIRO_X86_ENGINE=x86|blink` in the environment forces one.
 * See docs/X86_ENGINES.md.
 */

import type { X86Context } from '../x86/runtime';

export type X86EngineName = 'blink' | 'x86';

export async function chooseX86Engine(env: Record<string, string> = {}): Promise<X86EngineName> {
  const forced = env.SHIRO_X86_ENGINE;
  if (forced === 'x86') return 'x86';
  const { blinkSupported } = await import('./blink');
  if (blinkSupported()) return 'blink';
  return 'x86';
}

/** Run the ELF at `path` (already known to start with \x7fELF). */
export async function runElf(path: string, args: string[], ctx: X86Context, signal?: AbortSignal): Promise<number> {
  const engine = await chooseX86Engine(ctx.env);
  if (engine === 'blink') {
    const { runElfWithBlink } = await import('./blink');
    return runElfWithBlink(path, args, {
      fs: ctx.fs, cwd: ctx.cwd, env: ctx.env, stdin: ctx.stdin,
      writeStdout: ctx.writeStdout, writeStderr: ctx.writeStderr, signal,
    });
  }
  const { executeElf } = await import('../x86/runtime');
  return executeElf(path, args, ctx);
}
