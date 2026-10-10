/**
 * A node process's stdin when it is a live pipe (ctx.stdinStream: a spawned
 * child's stdin, written by its parent as it goes): bytes as they arrive,
 * for process.stdin's 'data' events and for fs.read(0)/fs.readSync(0).
 *
 * esbuild's API runs `node bin/esbuild --service` as a child and talks to it
 * over its stdin and stdout for as long as it lives; Go reads fd 0 with
 * fs.read. Reading only what was written by the time the child started (or
 * nothing) ended the service at once.
 *
 * One reader serves both: a flowing consumer (process.stdin 'data') takes
 * every chunk; otherwise fd reads take what they asked for and the rest stays
 * queued. An outstanding read keeps the process alive, as an open pipe does.
 */
export interface StdinStream {
  /** The next chunk, or null at EOF */
  read(): Promise<Uint8Array | null>;
}

export class LiveStdin {
  private queue: Uint8Array[] = [];
  private ended = false;
  private reading = false;
  private onChunk: ((b: Uint8Array | null) => void) | null = null;
  private waiters: { buf: Uint8Array; off: number; len: number; resolve: (n: number) => void }[] = [];

  constructor(private stream: StdinStream, private keepAlive: (p: Promise<unknown>) => void) {}

  /** Every chunk to `onChunk` as it arrives, then null at EOF */
  flow(onChunk: (b: Uint8Array | null) => void): void {
    this.onChunk = onChunk;
    this.deliver();
  }

  /** fs.read(0): up to `len` bytes into buf at off; 0 at EOF */
  read(buf: Uint8Array, off: number, len: number): Promise<number> {
    const n = this.tryRead(buf, off, len);
    if (n !== null) return Promise.resolve(n);
    return new Promise((resolve) => { this.waiters.push({ buf, off, len, resolve }); this.demand(); });
  }

  /** fs.readSync(0): what has arrived (0 at EOF), or null when nothing has yet (EAGAIN) */
  tryRead(buf: Uint8Array, off: number, len: number): number | null {
    if (this.queue.length) return this.take(buf, off, len);
    if (this.ended) return 0;
    this.demand();
    return null;
  }

  /** Read to EOF now (input that arrives whole, before a script reads it synchronously) */
  async fill(): Promise<void> {
    while (!this.ended) {
      this.demand();
      await new Promise<void>((r) => this.waiters.push({ buf: new Uint8Array(0), off: 0, len: 0, resolve: () => r() }));
    }
  }

  /** Everything that has arrived (readFileSync(0)) */
  takeAll(): Uint8Array {
    const n = this.queue.reduce((a, c) => a + c.length, 0);
    const out = new Uint8Array(n);
    this.take(out, 0, n);
    return out;
  }

  private take(buf: Uint8Array, off: number, len: number): number {
    let n = 0;
    while (n < len && this.queue.length) {
      const c = this.queue[0];
      const k = Math.min(len - n, c.length);
      buf.set(c.subarray(0, k), off + n);
      n += k;
      if (k === c.length) this.queue.shift(); else this.queue[0] = c.subarray(k);
    }
    return n;
  }

  private demand(): void {
    if (this.reading || this.ended) return;
    this.reading = true;
    const p = this.stream.read().then((c) => {
      this.reading = false;
      if (c === null) this.ended = true;
      else if (c.length) this.queue.push(c);
      this.deliver();
    }, () => { this.reading = false; this.ended = true; this.deliver(); });
    this.keepAlive(p);
  }

  private deliver(): void {
    if (this.onChunk) {
      const f = this.onChunk;
      for (const c of this.queue.splice(0)) f(c);
      if (this.ended) { this.onChunk = null; f(null); } else this.demand();
      return;
    }
    while (this.waiters.length && (this.queue.length || this.ended)) {
      const w = this.waiters.shift()!;
      w.resolve(this.queue.length ? this.take(w.buf, w.off, w.len) : 0);
    }
    if (this.waiters.length) this.demand();
  }
}

/** A pipe's write end and read end: what the parent writes, the child reads */
export function stdinPipe(): { write(b: Uint8Array): void; end(): void; stream: StdinStream } {
  const chunks: (Uint8Array | null)[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    write(b) { if (closed || !b.length) return; chunks.push(b); wake?.(); },
    end() { if (closed) return; closed = true; chunks.push(null); wake?.(); },
    stream: {
      async read() {
        while (!chunks.length) {
          if (closed) return null;
          await new Promise<void>((r) => { wake = r; });
        }
        wake = null;
        return chunks.shift()!;
      },
    },
  };
}
