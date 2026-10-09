/**
 * Pipes: a bounded ring buffer with a read end and a write end.
 *
 * - read blocks while the pipe is empty and a writer is open; 0 (EOF) once
 *   every write end has closed.
 * - write blocks while the pipe is full; -EPIPE when no read end is open
 *   (the kernel turns that into SIGPIPE for the writer). Writes of at most
 *   PIPE_BUF bytes are atomic.
 * - O_NONBLOCK gives -EAGAIN instead of blocking.
 */

import {
  type KStat, EAGAIN, EINTR, EPIPE, ENOTTY, ESPIPE, O_RDONLY, O_WRONLY, O_NONBLOCK,
  POLLIN, POLLOUT, POLLHUP, POLLERR, PIPE_BUF, PIPE_CAPACITY, S_IFIFO, FIONREAD,
} from './abi';
import { type OpenFile, type OpenFileKind, ReadyListeners, abortableWait } from './fd';

let nextPipeIno = 1;

export class Pipe {
  private buf: Uint8Array;
  private head = 0;   // next byte to read
  private count = 0;  // bytes buffered
  readers = 0;
  writers = 0;
  readonly ino = nextPipeIno++;
  private readWaiters = new Set<() => void>();
  private writeWaiters = new Set<() => void>();
  readonly listeners = new ReadyListeners();
  /** Named pipes: opens waiting for the other side to open (see Kernel.openFifo). */
  readonly openWaiters = new Set<() => void>();
  /** Named pipes: called when the last end closes (the kernel forgets the pipe). */
  onIdle?: () => void;

  constructor(readonly capacity = PIPE_CAPACITY) {
    this.buf = new Uint8Array(capacity);
  }

  get available(): number { return this.count; }
  get space(): number { return this.capacity - this.count; }

  private wakeReaders() {
    for (const w of [...this.readWaiters]) w();
    this.listeners.fire();
  }
  private wakeWriters() {
    for (const w of [...this.writeWaiters]) w();
    this.listeners.fire();
  }

  private take(out: Uint8Array): number {
    const n = Math.min(out.length, this.count);
    const first = Math.min(n, this.capacity - this.head);
    out.set(this.buf.subarray(this.head, this.head + first));
    if (n > first) out.set(this.buf.subarray(0, n - first), first);
    this.head = (this.head + n) % this.capacity;
    this.count -= n;
    return n;
  }

  private put(src: Uint8Array): number {
    const n = Math.min(src.length, this.space);
    const tail = (this.head + this.count) % this.capacity;
    const first = Math.min(n, this.capacity - tail);
    this.buf.set(src.subarray(0, first), tail);
    if (n > first) this.buf.set(src.subarray(first, n), 0);
    this.count += n;
    return n;
  }

  /** read() when it needn't wait: data buffered, EOF, or an empty read. */
  tryRead(out: Uint8Array): number | undefined {
    if (out.length === 0) return 0;
    if (this.count > 0) {
      const n = this.take(out);
      this.wakeWriters();
      return n;
    }
    return this.writers === 0 ? 0 : undefined;
  }

  /** write() when all of `src` fits now (no wait, no EPIPE). */
  tryWrite(src: Uint8Array): number | undefined {
    if (this.readers === 0 || src.length > this.space) return undefined;
    if (src.length === 0) return 0;
    this.put(src);
    this.wakeReaders();
    return src.length;
  }

  async read(out: Uint8Array, nonblock: boolean, signal?: AbortSignal): Promise<number> {
    if (out.length === 0) return 0;
    for (;;) {
      if (this.count > 0) {
        const n = this.take(out);
        this.wakeWriters();
        return n;
      }
      if (this.writers === 0) return 0;
      if (nonblock) return -EAGAIN;
      if (!(await abortableWait(this.readWaiters, signal))) return -EINTR;
    }
  }

  async write(src: Uint8Array, nonblock: boolean, signal?: AbortSignal): Promise<number> {
    if (this.readers === 0) return -EPIPE;
    if (src.length === 0) return 0;
    const atomic = src.length <= Math.min(PIPE_BUF, this.capacity);
    let done = 0;
    while (done < src.length) {
      if (this.readers === 0) return done > 0 ? done : -EPIPE;
      const want = src.length - done;
      if (this.space > 0 && (!atomic || this.space >= want)) {
        done += this.put(src.subarray(done));
        this.wakeReaders();
        continue;
      }
      if (nonblock) return done > 0 ? done : -EAGAIN;
      if (!(await abortableWait(this.writeWaiters, signal))) return done > 0 ? done : -EINTR;
    }
    return done;
  }

  /** An end was opened: wake opens waiting for it. */
  noteOpen() {
    for (const w of [...this.openWaiters]) w();
  }

  closeReader() {
    this.readers--;
    this.wakeWriters();
    if (this.readers === 0 && this.writers === 0) this.onIdle?.();
  }
  closeWriter() {
    this.writers--;
    this.wakeReaders();
    if (this.readers === 0 && this.writers === 0) this.onIdle?.();
  }

  stat(): KStat {
    const now = Date.now();
    return {
      dev: 8, ino: this.ino, mode: S_IFIFO | 0o600, nlink: 1, uid: 1000, gid: 1000, rdev: 0,
      size: this.count, blksize: PIPE_BUF, blocks: 0, atimeMs: now, mtimeMs: now, ctimeMs: now,
    };
  }
}

export class PipeEnd implements OpenFile {
  kind: OpenFileKind = 'pipe';
  private closed = false;

  constructor(readonly pipe: Pipe, readonly end: 'r' | 'w', public flags: number) {
    if (end === 'r') pipe.readers++;
    else pipe.writers++;
    pipe.noteOpen();
  }

  read(buf: Uint8Array, signal?: AbortSignal): Promise<number> {
    if (this.end !== 'r') return Promise.resolve(-9 /* EBADF */);
    return this.pipe.read(buf, !!(this.flags & O_NONBLOCK), signal);
  }

  write(buf: Uint8Array, signal?: AbortSignal): Promise<number> {
    if (this.end !== 'w') return Promise.resolve(-9 /* EBADF */);
    return this.pipe.write(buf, !!(this.flags & O_NONBLOCK), signal);
  }

  tryRead(buf: Uint8Array): number | undefined {
    return this.end === 'r' ? this.pipe.tryRead(buf) : undefined;
  }

  tryWrite(buf: Uint8Array): number | undefined {
    return this.end === 'w' ? this.pipe.tryWrite(buf) : undefined;
  }

  statSync(): KStat { return this.pipe.stat(); }

  poll(events: number): number {
    const p = this.pipe;
    let r = 0;
    if (this.end === 'r') {
      if (p.available > 0) r |= POLLIN;
      if (p.writers === 0) r |= POLLHUP;
    } else {
      if (p.readers === 0) r |= POLLERR;
      else if (p.space > 0) r |= POLLOUT;
    }
    return r & (events | POLLHUP | POLLERR);
  }

  onReady(cb: () => void): () => void { return this.pipe.listeners.add(cb); }

  seek(): number { return -ESPIPE; }

  async ioctl(req: number, arg: Uint8Array): Promise<number> {
    if (req === FIONREAD && arg.length >= 4) {
      new DataView(arg.buffer, arg.byteOffset, 4).setInt32(0, this.pipe.available, true);
      return 0;
    }
    return -ENOTTY;
  }

  async stat(): Promise<KStat> { return this.pipe.stat(); }

  async close(): Promise<void> { this.closeSync(); }

  closeSync(): boolean {
    if (this.closed) return true;
    this.closed = true;
    if (this.end === 'r') this.pipe.closeReader();
    else this.pipe.closeWriter();
    return true;
  }
}

/** A new pipe: [read end, write end]. `flags` may carry O_NONBLOCK. */
export function createPipe(flags = 0, capacity = PIPE_CAPACITY): [PipeEnd, PipeEnd] {
  const p = new Pipe(capacity);
  return [new PipeEnd(p, 'r', O_RDONLY | (flags & O_NONBLOCK)), new PipeEnd(p, 'w', O_WRONLY | (flags & O_NONBLOCK))];
}

/** A named pipe opened O_RDWR: a read end and a write end in one description (never blocks on open, as on Linux). */
export class FifoRdWr implements OpenFile {
  kind: OpenFileKind = 'pipe';
  private r: PipeEnd;
  private w: PipeEnd;
  constructor(readonly pipe: Pipe, public flags: number) {
    this.r = new PipeEnd(pipe, 'r', flags & O_NONBLOCK);
    this.w = new PipeEnd(pipe, 'w', flags & O_NONBLOCK);
  }
  private syncFlags() { this.r.flags = this.w.flags = this.flags & O_NONBLOCK; }
  read(buf: Uint8Array, signal?: AbortSignal): Promise<number> { this.syncFlags(); return this.r.read(buf, signal); }
  write(buf: Uint8Array, signal?: AbortSignal): Promise<number> { this.syncFlags(); return this.w.write(buf, signal); }
  tryRead(buf: Uint8Array): number | undefined { return this.r.tryRead(buf); }
  tryWrite(buf: Uint8Array): number | undefined { return this.w.tryWrite(buf); }
  poll(events: number): number { return this.r.poll(events) | this.w.poll(events); }
  onReady(cb: () => void): () => void { return this.pipe.listeners.add(cb); }
  seek(): number { return -ESPIPE; }
  ioctl(req: number, arg: Uint8Array): Promise<number> { return this.r.ioctl(req, arg); }
  async stat(): Promise<KStat> { return this.pipe.stat(); }
  statSync(): KStat { return this.pipe.stat(); }
  async close(): Promise<void> { this.closeSync(); }
  closeSync(): boolean { this.r.closeSync(); this.w.closeSync(); return true; }
}
