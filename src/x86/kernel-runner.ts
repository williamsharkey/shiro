/**
 * Run an x86-64 ELF in the emulator as a kernel process: stdin is a blocking
 * read on fd 0 (a pty, a pipe), output goes to fds 1 and 2 in order, a
 * stopped process pauses at its next syscall, and a kill ends the loop.
 */
import type { Runner } from '../kernel/kernel';
import { executeElfFromBytes, X86Killed } from './runtime';

const enc = new TextEncoder();

export function x86Runner(elf: Uint8Array, argv0: string): Runner {
  return async (proc, kernel) => {
    if (!kernel.fs) throw new Error('x86: kernel has no filesystem');
    const abort = new AbortController();
    proc.onTerminate(() => abort.abort());
    // Writes are queued so output keeps its order and is flushed before reads
    let pending: Promise<unknown> = Promise.resolve();
    const writer = (fd: number) => (s: string) => {
      const data = enc.encode(s);
      pending = pending.then(() => kernel.writeAll(proc, fd, data)).catch(() => {});
    };
    try {
      const code = await executeElfFromBytes(elf, argv0, proc.argv.slice(1), {
        fs: kernel.fs,
        cwd: proc.cwd,
        args: proc.argv.slice(1),
        env: proc.env,
        stdin: '',
        writeStdout: writer(1),
        writeStderr: writer(2),
        signal: abort.signal,
        checkpoint: () => proc.waitWhileStopped(),
        readStdin: async (n) => {
          await pending;
          const f = proc.fds.get(0);
          if (!f) return new Uint8Array(0);
          const buf = new Uint8Array(Math.max(1, Math.min(n, 65536)));
          const r = await f.read(buf, proc.syscallSignal);
          return r > 0 ? buf.subarray(0, r) : new Uint8Array(0);
        },
      });
      await pending;
      return code;
    } catch (e) {
      if (e instanceof X86Killed) return; // the kernel already recorded the signal
      throw e;
    }
  };
}
