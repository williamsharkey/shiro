/**
 * Named pipes in the shell's own redirections (`< fifo`, `> fifo`,
 * `exec 8>fifo`): the shell keeps file contents as strings, so a FIFO path
 * goes through the kernel instead (Kernel.openFifo), with its blocking open
 * and EOF-when-the-last-writer-closes semantics.
 */
import type { Shell } from './shell';
import type { OpenFile } from './kernel/fd';

async function kernelOf(shell: Shell) {
  if (shell.kernelHost) return shell.kernelHost;
  const { kernelForContext } = await import('./wasi/run-command');
  const kernel = kernelForContext({ fs: shell.fs, shell } as any);
  return { kernel, proc: kernel.init };
}

/** Is `path` (absolute) a named pipe? Answered from memory when the FileSystem can (every redirect asks). */
export function isFifo(shell: Shell, path: string): boolean | Promise<boolean> {
  const hit = shell.fs.lookupCached(path);
  if (hit !== undefined) return hit?.node.special === 'fifo';
  return shell.fs.stat(path).then(st => !!st.isFIFO?.(), () => false);
}

/** Open a named pipe like open(2): blocks until the other side opens. */
export async function openFifoEnd(shell: Shell, path: string, mode: 'r' | 'w'): Promise<OpenFile> {
  const { kernel, proc } = await kernelOf(shell);
  const A = await import('./kernel/abi');
  const f = await kernel.open(proc, path, mode === 'r' ? A.O_RDONLY : A.O_WRONLY);
  if (typeof f === 'number') throw new Error(`${path}: cannot open (errno ${-f})`);
  return f;
}

/** Everything written to the FIFO until its last writer closes. */
export async function readFifo(shell: Shell, path: string): Promise<string> {
  const f = await openFifoEnd(shell, path, 'r');
  const chunks: Uint8Array[] = [];
  try {
    const buf = new Uint8Array(65536);
    for (;;) {
      const n = await f.read(buf);
      if (n <= 0) break;
      chunks.push(buf.slice(0, n));
    }
  } finally {
    await f.close();
  }
  return new TextDecoder().decode(concat(chunks));
}

/** Write all of `text` to an open FIFO end. */
export async function writeOpenFifo(f: OpenFile, text: string): Promise<void> {
  const b = new TextEncoder().encode(text);
  for (let off = 0; off < b.length;) {
    const n = await f.write(b.subarray(off));
    if (n <= 0) throw new Error(n === 0 ? 'write returned 0' : `write failed (errno ${-n})`);
    off += n;
  }
}

/** `cmd > fifo`: open (waiting for a reader), write, close. */
export async function writeFifo(shell: Shell, path: string, text: string): Promise<void> {
  const f = await openFifoEnd(shell, path, 'w');
  try { await writeOpenFifo(f, text); } finally { await f.close(); }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}
