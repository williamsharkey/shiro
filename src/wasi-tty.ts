/**
 * wasi-tty.ts — interactive stdin for WASI programs.
 *
 * WASI preview1 calls are synchronous, but keystrokes arrive asynchronously.
 * With JS Promise Integration (WebAssembly.Suspending / WebAssembly.promising)
 * a WASI import can await, suspending the WASM stack until a key or timer
 * arrives. WasiTTY is the byte queue those imports wait on. LineDiscipline
 * turns raw xterm data into what a cooked Unix tty would deliver.
 */

/** True when this engine can suspend WASM on a JS promise (JSPI). */
export function jspiAvailable(): boolean {
  const W = WebAssembly as any;
  return typeof W.Suspending === 'function' && typeof W.promising === 'function';
}

export class WasiTTY {
  private chunks: Uint8Array[] = [];
  private eof = false;
  private failure: unknown = null;
  private waiters: Array<() => void> = [];
  /** Raw mode: bytes go to the program unprocessed (no echo, no line editing). */
  raw = false;

  push(bytes: Uint8Array): void {
    if (bytes.length === 0 || this.eof) return;
    this.chunks.push(bytes);
    this.wake();
  }

  pushText(text: string): void {
    this.push(new TextEncoder().encode(text));
  }

  /** End of input (Ctrl-D on an empty cooked line). Pending bytes stay readable. */
  close(): void {
    this.eof = true;
    this.wake();
  }

  /** Make every pending and future wait throw `err` (used to kill the program). */
  abort(err: unknown): void {
    this.failure = err;
    this.wake();
  }

  /** Bytes or EOF are available without waiting. */
  readable(): boolean {
    return this.chunks.length > 0 || this.eof || this.failure !== null;
  }

  isEOF(): boolean {
    return this.eof && this.chunks.length === 0;
  }

  /** Take up to `max` queued bytes; empty when nothing is queued. */
  read(max: number): Uint8Array {
    if (this.failure !== null) throw this.failure;
    const out = new Uint8Array(Math.min(max, this.queued()));
    let n = 0;
    while (n < out.length) {
      const head = this.chunks[0];
      const take = Math.min(head.length, out.length - n);
      out.set(head.subarray(0, take), n);
      n += take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    return out;
  }

  private queued(): number {
    let n = 0;
    for (const c of this.chunks) n += c.length;
    return n;
  }

  /**
   * Resolve when input is readable, or after `timeoutMs` (undefined = no
   * timeout). Returns true when input became readable.
   */
  wait(timeoutMs?: number): Promise<boolean> {
    if (this.failure !== null) return Promise.reject(this.failure);
    if (this.readable()) return Promise.resolve(true);
    return new Promise<boolean>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (timer !== undefined) clearTimeout(timer);
        this.waiters = this.waiters.filter(w => w !== done);
        if (this.failure !== null) reject(this.failure);
        else resolve(this.readable());
      };
      this.waiters.push(done);
      if (timeoutMs !== undefined) timer = setTimeout(done, Math.max(0, timeoutMs));
    });
  }

  private wake(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }
}

/**
 * Minimal cooked-mode line discipline: echo, backspace, Ctrl-U, Enter,
 * Ctrl-D (EOF on an empty line), Ctrl-C (interrupt). In raw mode data
 * passes straight through and the program handles every byte itself.
 */
export class LineDiscipline {
  private line = '';
  /** Inside an escape sequence (arrow keys etc.), which cooked mode ignores. */
  private escape = false;

  constructor(
    private tty: WasiTTY,
    private echo: (text: string) => void,
    private interrupt: () => void,
  ) {}

  input(data: string): void {
    if (this.tty.raw) {
      if (this.line) { this.tty.pushText(this.line); this.line = ''; }
      this.tty.pushText(data);
      return;
    }
    for (const ch of data) {
      if (this.escape) {
        // CSI/SS3 sequences end at a letter or '~'; '[' and 'O' introduce them.
        if ((ch >= '@' && ch <= '~' && ch !== '[' && ch !== 'O') || ch === '~') this.escape = false;
        continue;
      }
      if (ch === '\x1b') { this.escape = true; continue; }
      switch (ch) {
        case '\r':
        case '\n':
          this.echo('\r\n');
          this.tty.pushText(this.line + '\n');
          this.line = '';
          break;
        case '\x7f':
        case '\b':
          if (this.line) {
            this.line = Array.from(this.line).slice(0, -1).join('');
            this.echo('\b \b');
          }
          break;
        case '\x15': // Ctrl-U
          this.echo('\b \b'.repeat(Array.from(this.line).length));
          this.line = '';
          break;
        case '\x04': // Ctrl-D
          if (this.line) { this.tty.pushText(this.line); this.line = ''; }
          else this.tty.close();
          break;
        case '\x03': // Ctrl-C
          this.echo('^C\r\n');
          this.line = '';
          this.interrupt();
          return;
        default:
          if (ch >= ' ' || ch === '\t') {
            this.line += ch;
            this.echo(ch);
          }
      }
    }
  }
}
