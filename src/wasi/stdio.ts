/**
 * stdio.ts — OpenFiles for running WASM programs from the shell: a
 * terminal tty with a cooked line discipline and a callback sink.
 *
 * TtyFile stands in for the unix/pty line discipline (src/kernel/pty.ts)
 * until that lands; then run-command.ts should open the pty slave instead.
 */

import * as A from '../kernel/abi';
import { type OpenFile, type OpenFileKind, ReadyListeners, abortableWait, charDevStat } from '../kernel/fd';

export interface TtyHost {
  /** Text for the screen (\n already turned into \r\n in cooked mode). */
  output(text: string): void;
  /** Ctrl-C (SIGINT) / Ctrl-\ (SIGQUIT) from the keyboard. */
  signal(sig: number): void;
}

/**
 * A terminal as an OpenFile. Cooked by default (echo, backspace, ^U, ^D EOF,
 * ^C → SIGINT, ^\ → SIGQUIT); `raw = true` passes keystrokes through.
 */
export class TtyFile implements OpenFile {
  kind: OpenFileKind = 'pty';
  flags = A.O_RDWR;
  raw = false;
  private queue: Uint8Array[] = [];
  private queued = 0;
  private eofPending = false;
  private hungUp = false;
  private line = '';
  private escape = false;
  private waiters = new Set<() => void>();
  private listeners = new ReadyListeners();
  private enc = new TextEncoder();
  private dec = new TextDecoder();

  constructor(private host: TtyHost) {}

  /** Keyboard input. */
  input(data: string): void {
    if (this.raw) { this.push(this.enc.encode(data)); return; }
    for (const ch of data) {
      if (this.escape) {
        // CSI/SS3 sequences (arrow keys…) end at a final byte; cooked mode drops them
        if (ch >= '@' && ch <= '~' && ch !== '[' && ch !== 'O') this.escape = false;
        continue;
      }
      switch (ch) {
        case '\x1b': this.escape = true; break;
        case '\r': case '\n':
          this.host.output('\r\n');
          this.push(this.enc.encode(this.line + '\n'));
          this.line = '';
          break;
        case '\x7f': case '\b':
          if (this.line) { this.line = Array.from(this.line).slice(0, -1).join(''); this.host.output('\b \b'); }
          break;
        case '\x15':
          this.host.output('\b \b'.repeat(Array.from(this.line).length));
          this.line = '';
          break;
        case '\x04':
          if (this.line) { this.push(this.enc.encode(this.line)); this.line = ''; }
          else { this.eofPending = true; this.wake(); }
          break;
        case '\x03':
          this.host.output('^C\r\n');
          this.line = '';
          this.host.signal(A.SIGINT);
          return;
        case '\x1c':
          this.host.output('^\\\r\n');
          this.line = '';
          this.host.signal(A.SIGQUIT);
          return;
        default:
          if (ch >= ' ' || ch === '\t') { this.line += ch; this.host.output(ch); }
      }
    }
  }

  /** The terminal went away: every later read is EOF. */
  hangup(): void { this.eofPending = true; this.hungUp = true; this.wake(); }

  private push(bytes: Uint8Array): void {
    if (!bytes.length) return;
    this.queue.push(bytes);
    this.queued += bytes.length;
    this.wake();
  }
  private wake(): void {
    for (const w of [...this.waiters]) w();
    this.listeners.fire();
  }

  async read(buf: Uint8Array, signal?: AbortSignal): Promise<number> {
    for (;;) {
      if (this.queued > 0) {
        let n = 0;
        while (n < buf.length && this.queue.length) {
          const head = this.queue[0];
          const k = Math.min(head.length, buf.length - n);
          buf.set(head.subarray(0, k), n);
          n += k;
          if (k === head.length) this.queue.shift(); else this.queue[0] = head.subarray(k);
        }
        this.queued -= n;
        return n;
      }
      if (this.eofPending) { if (!this.hungUp) this.eofPending = false; return 0; }
      if (this.flags & A.O_NONBLOCK) return -A.EAGAIN;
      if (!(await abortableWait(this.waiters, signal))) return -A.EINTR;
    }
  }

  async write(buf: Uint8Array): Promise<number> {
    // slice(): browsers refuse to decode views of a SharedArrayBuffer (the channel)
    const text = this.dec.decode(buf.slice(), { stream: true });
    this.host.output(this.raw ? text : text.replace(/\r?\n/g, '\r\n'));
    return buf.length;
  }

  poll(events: number): number {
    let r = A.POLLOUT;
    if (this.queued > 0 || this.eofPending) r |= A.POLLIN;
    return r & events;
  }
  onReady(cb: () => void): () => void { return this.listeners.add(cb); }
  seek(): number { return -A.ESPIPE; }
  async stat(): Promise<A.KStat> { return charDevStat(0x8800); }
  async close(): Promise<void> {}
}

/** Output delivered to a callback, seen by the program as a pipe (not a tty). */
export class SinkFile implements OpenFile {
  kind: OpenFileKind = 'pipe';
  flags = A.O_WRONLY;
  private listeners = new ReadyListeners();
  private dec = new TextDecoder();
  constructor(private cb: (text: string) => void, opts: { tty?: boolean } = {}) {
    if (opts.tty) this.kind = 'pty';
  }
  async read(): Promise<number> { return -A.EBADF; }
  async write(buf: Uint8Array): Promise<number> {
    this.cb(this.dec.decode(buf.slice(), { stream: true })); // see TtyFile.write
    return buf.length;
  }
  poll(events: number): number { return events & A.POLLOUT; }
  onReady(cb: () => void): () => void { return this.listeners.add(cb); }
  seek(): number { return -A.ESPIPE; }
  async stat(): Promise<A.KStat> {
    if (this.kind === 'pty') return charDevStat(0x8801);
    const now = Date.now();
    return { dev: 2, ino: 0, mode: A.S_IFIFO | 0o600, nlink: 1, uid: 1000, gid: 1000, rdev: 0, size: 0, blksize: 4096, blocks: 0, atimeMs: now, mtimeMs: now, ctimeMs: now };
  }
  async close(): Promise<void> {}
}
