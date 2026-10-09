/**
 * An in-page byte connection: two ends, each reading what the other writes.
 * A preview's WebSocket reaches an in-tab server through one (iframeServer.connect):
 * the page end speaks RFC 6455 (src/browser/websocket.ts) and the server end is a
 * node http server's 'upgrade' socket or a kernel loopback connection.
 */

/** One end of a byte connection (the shape of src/browser/http1.ts ByteStream). */
export interface ByteChannel {
  /** The next chunk, or undefined once the other end has closed and everything is read. */
  read(): Promise<Uint8Array | undefined>;
  /** Fails once either end has closed. */
  write(data: Uint8Array): Promise<void>;
  /** Ends the connection both ways. */
  close(): void;
}

class End implements ByteChannel {
  peer!: End;
  private inbox: Uint8Array[] = [];
  private waiter: ((c: Uint8Array | undefined) => void) | null = null;
  private eof = false;
  closed = false;

  deliver(data: Uint8Array) {
    if (this.eof) return;
    if (this.waiter) { const w = this.waiter; this.waiter = null; w(data); } else this.inbox.push(data);
  }
  end() {
    this.eof = true;
    if (this.waiter && !this.inbox.length) { const w = this.waiter; this.waiter = null; w(undefined); }
  }
  read(): Promise<Uint8Array | undefined> {
    if (this.inbox.length) return Promise.resolve(this.inbox.shift());
    if (this.eof) return Promise.resolve(undefined);
    return new Promise((r) => { this.waiter = r; });
  }
  write(data: Uint8Array): Promise<void> {
    if (this.closed || this.peer.closed) return Promise.reject(new Error('EPIPE: connection closed'));
    if (data.length) this.peer.deliver(data.slice());
    return Promise.resolve();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.end();
    this.peer.end();
  }
}

/** A connected pair: what one end writes, the other reads. */
export function bytePipe(): [ByteChannel, ByteChannel] {
  const a = new End();
  const b = new End();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
