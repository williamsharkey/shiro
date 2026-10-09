// HTTP/2 (RFC 9113) client session for the Browser app's broker, over a TLS
// session that negotiated "h2". One session per origin carries all of a
// page's requests to it, so a page isn't limited to 6 connections and pays
// one relay connect and one TLS handshake per origin.
//
// It introduces itself like Chrome (SETTINGS values and order, the
// connection window, pseudo-header order :method :authority :scheme :path),
// since HTTP/2 fingerprints are checked by the same bot defenses as TLS ones.
import type { ByteStream, HeaderList, HttpResponse } from './http1';
import { HpackDecoder, hpackEncode, type Header } from './hpack';

const DATA = 0, HEADERS = 1, PRIORITY = 2, RST_STREAM = 3, SETTINGS = 4, PUSH_PROMISE = 5, PING = 6, GOAWAY = 7, WINDOW_UPDATE = 8, CONTINUATION = 9;
const END_STREAM = 1, ACK = 1, END_HEADERS = 4, PADDED = 8, PRIORITY_FLAG = 32;
const PREFACE = new TextEncoder().encode('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');

// Chrome's SETTINGS: HEADER_TABLE_SIZE 65536, ENABLE_PUSH 0, INITIAL_WINDOW_SIZE 6 MiB, MAX_HEADER_LIST_SIZE 256 KiB
const OUR_SETTINGS: [number, number][] = [[1, 65536], [2, 0], [4, 6291456], [6, 262144]];
const CONN_WINDOW = 15728640; // Chrome raises the connection window to 15 MiB

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'host', 'te']);

interface Stream {
  id: number;
  head: ((h: { status: number; headers: HeaderList }) => void) | null;
  fail: (e: Error) => void;
  ctrl: ReadableStreamDefaultController<Uint8Array> | null;
  queued: Uint8Array[];
  ended: boolean;
  error: Error | null;
  sendWindow: number;
  windowWaiters: (() => void)[];
  headerBlock: Uint8Array[] | null;
  headersDone: boolean;
  /** END_STREAM came on the HEADERS frame whose block is still being continued */
  endAfterHeaders: boolean;
  finish: ((ok: boolean) => void) | null;
}

function frame(type: number, flags: number, stream: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const f = new Uint8Array(9 + payload.length);
  f[0] = payload.length >> 16; f[1] = (payload.length >> 8) & 255; f[2] = payload.length & 255;
  f[3] = type; f[4] = flags;
  new DataView(f.buffer).setUint32(5, stream & 0x7fffffff);
  f.set(payload, 9);
  return f;
}
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; };

export class H2Session {
  private next = 1;
  private streams = new Map<number, Stream>();
  private decoder = new HpackDecoder(65536, 65536);
  private peerMaxFrame = 16384;
  private peerInitialWindow = 65535;
  private connSendWindow = 65535;
  private connWaiters: (() => void)[] = [];
  private maxConcurrent = 100;
  private writeChain: Promise<void> = Promise.resolve();
  private recvUnacked = 0;
  closed = false;
  goingAway = false;
  private lastUsed = Date.now();

  constructor(private s: ByteStream, private authority: string) {}

  async start(): Promise<void> {
    const settings = new Uint8Array(OUR_SETTINGS.length * 6);
    OUR_SETTINGS.forEach(([id, v], i) => { new DataView(settings.buffer).setUint16(i * 6, id); new DataView(settings.buffer).setUint32(i * 6 + 2, v); });
    await this.send(PREFACE, frame(SETTINGS, 0, 0, settings), frame(WINDOW_UPDATE, 0, 0, u32(CONN_WINDOW - 65535)));
    void this.readLoop();
  }

  /** Room for another request on this connection. */
  get available(): boolean { return !this.closed && !this.goingAway && this.streams.size < this.maxConcurrent && this.next < 0x7fffffff; }
  get active(): number { return this.streams.size; }
  get idleFor(): number { return this.streams.size ? 0 : Date.now() - this.lastUsed; }

  private send(...frames: Uint8Array[]): Promise<void> {
    const data = frames.length === 1 ? frames[0] : (() => {
      const out = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
      let o = 0;
      for (const f of frames) { out.set(f, o); o += f.length; }
      return out;
    })();
    this.writeChain = this.writeChain.then(() => this.s.write(data));
    return this.writeChain;
  }

  async request(method: string, url: URL, headers: HeaderList, body: Uint8Array | ReadableStream<Uint8Array> | null, signal?: AbortSignal): Promise<HttpResponse> {
    if (!this.available) throw new Error('HTTP/2 connection not available');
    const id = this.next;
    this.next += 2;
    this.lastUsed = Date.now();
    const pseudo: Header[] = [[':method', method], [':authority', url.host || this.authority], [':scheme', 'https'], [':path', (url.pathname || '/') + url.search]];
    const regular: Header[] = [];
    for (const [k, v] of headers) {
      const n = k.toLowerCase();
      if (HOP.has(n) || n.startsWith(':')) continue;
      if (n === 'cookie') for (const c of v.split(/;\s*/)) regular.push(['cookie', c]); // RFC 9113 8.2.3: crumbs compress better
      else regular.push([n, v]);
    }
    const block = hpackEncode([...pseudo, ...regular]);
    const hasBody = body !== null && !(body instanceof Uint8Array && body.length === 0);
    let resolveHead!: (h: { status: number; headers: HeaderList }) => void;
    let rejectHead!: (e: Error) => void;
    const headP = new Promise<{ status: number; headers: HeaderList }>((res, rej) => { resolveHead = res; rejectHead = rej; });
    const st: Stream = {
      id, head: resolveHead, fail: (e) => { rejectHead(e); }, ctrl: null, queued: [], ended: false, error: null,
      sendWindow: this.peerInitialWindow, windowWaiters: [], headerBlock: null, headersDone: false, endAfterHeaders: false, finish: null,
    };
    const reusable = new Promise<boolean>((res) => { st.finish = res; });
    this.streams.set(id, st);
    // HEADERS (+ CONTINUATION when the block is larger than a frame)
    const frames: Uint8Array[] = [];
    for (let off = 0; off < block.length || off === 0; off += this.peerMaxFrame) {
      const part = block.subarray(off, off + this.peerMaxFrame);
      const last = off + this.peerMaxFrame >= block.length;
      const flags = (last ? END_HEADERS : 0) | (off === 0 && !hasBody ? END_STREAM : 0);
      frames.push(frame(off === 0 ? HEADERS : CONTINUATION, flags, id, part));
      if (last) break;
    }
    await this.send(...frames);
    if (hasBody) void this.sendBody(st, body!).catch((e) => this.resetStream(id, 8, e));
    signal?.addEventListener('abort', () => this.resetStream(id, 8, new Error('aborted')), { once: true });

    const head = await headP;
    const bodyStream = new ReadableStream<Uint8Array>({
      start: (ctrl) => { st.ctrl = ctrl; this.flush(st); },
      pull: () => { this.flush(st); },
      cancel: () => { this.resetStream(id, 8, null); st.finish?.(false); },
    }, { highWaterMark: 1 << 20, size: (c) => c.byteLength });
    return { status: head.status, statusText: '', headers: head.headers, body: bodyStream, reusable };
  }

  private async sendBody(st: Stream, body: Uint8Array | ReadableStream<Uint8Array>) {
    const chunks: AsyncIterable<Uint8Array> | Uint8Array[] = body instanceof Uint8Array ? [body] : (async function* () {
      const r = body.getReader();
      for (;;) { const { value, done } = await r.read(); if (done) return; if (value?.length) yield value; }
    })();
    for await (const chunk of chunks) {
      for (let off = 0; off < chunk.length;) {
        while (st.sendWindow <= 0 || this.connSendWindow <= 0) {
          if (st.error || this.closed) throw st.error ?? new Error('connection closed');
          await new Promise<void>((r) => (st.sendWindow <= 0 ? st.windowWaiters : this.connWaiters).push(r));
        }
        const n = Math.min(chunk.length - off, st.sendWindow, this.connSendWindow, this.peerMaxFrame);
        st.sendWindow -= n; this.connSendWindow -= n;
        await this.send(frame(DATA, 0, st.id, chunk.subarray(off, off + n)));
        off += n;
      }
    }
    await this.send(frame(DATA, END_STREAM, st.id));
  }

  /** Hand queued DATA to the body stream as it is read, and open the windows by what was consumed. */
  private flush(st: Stream) {
    if (!st.ctrl) return;
    let consumed = 0;
    // Hand data over while the body stream has room (1 MiB, below); the window opens by what it took,
    // so a slow reader holds at most that queue plus the window we advertise
    while (st.queued.length && (st.ctrl.desiredSize ?? 1) > 0) {
      const c = st.queued.shift()!;
      consumed += c.length;
      st.ctrl.enqueue(c);
    }
    if (!st.queued.length && (st.ended || st.error)) {
      if (st.error) { try { st.ctrl.error(st.error); } catch { /* done */ } } else { try { st.ctrl.close(); } catch { /* done */ } }
      st.finish?.(!st.error);
      st.finish = null;
      st.ctrl = null;
    }
    if (consumed) this.consumed(st.id, consumed);
  }

  /** Data the reader took (or we dropped): give the window back, per stream and, in batches, for the connection. */
  private consumed(id: number, n: number) {
    if (this.closed) return;
    this.recvUnacked += n;
    const frames: Uint8Array[] = [];
    if (this.streams.has(id)) frames.push(frame(WINDOW_UPDATE, 0, id, u32(n)));
    if (this.recvUnacked >= CONN_WINDOW / 4) { frames.push(frame(WINDOW_UPDATE, 0, 0, u32(this.recvUnacked))); this.recvUnacked = 0; }
    if (frames.length) void this.send(...frames).catch(() => {});
  }

  private resetStream(id: number, code: number, err: Error | null) {
    const st = this.streams.get(id);
    if (!st) return;
    this.streams.delete(id);
    if (!this.closed) void this.send(frame(RST_STREAM, 0, id, u32(code))).catch(() => {});
    if (err) this.failStream(st, err);
  }

  private failStream(st: Stream, err: Error) {
    st.error = err;
    st.head = null;
    st.fail(err);
    for (const w of st.windowWaiters.splice(0)) w();
    this.flush(st);
  }

  private async readLoop() {
    const buf = new Uint8Array(0);
    let acc = buf;
    const need = async (n: number): Promise<boolean> => {
      while (acc.length < n) {
        const d = await this.s.read();
        if (!d) return false;
        const b = new Uint8Array(acc.length + d.length);
        b.set(acc); b.set(d, acc.length);
        acc = b;
      }
      return true;
    };
    try {
      for (;;) {
        if (!(await need(9))) break;
        const len = (acc[0] << 16) | (acc[1] << 8) | acc[2];
        const type = acc[3], flags = acc[4];
        const id = new DataView(acc.buffer, acc.byteOffset + 5, 4).getUint32(0) & 0x7fffffff;
        if (len > 16384 * 64) throw new Error('HTTP/2 frame too large');
        if (!(await need(9 + len))) break;
        const payload = acc.slice(9, 9 + len);
        acc = acc.subarray(9 + len);
        this.onFrame(type, flags, id, payload);
      }
      this.shutdown(new Error('HTTP/2 connection closed'));
    } catch (e) {
      this.shutdown(e as Error);
    }
  }

  private onFrame(type: number, flags: number, id: number, p: Uint8Array) {
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    const st = this.streams.get(id);
    const unpad = (data: Uint8Array) => {
      if (!(flags & PADDED)) return data;
      const pad = data[0];
      return data.subarray(1, data.length - pad);
    };
    switch (type) {
      case DATA: {
        const data = unpad(p);
        if (!st) { this.consumed(id, p.length); return; }
        if (data.length) st.queued.push(data.slice());
        if (p.length !== data.length) this.consumed(id, p.length - data.length);
        if (flags & END_STREAM) { st.ended = true; this.streams.delete(id); }
        this.flush(st);
        return;
      }
      case HEADERS: case CONTINUATION: {
        if (!st) return;
        let block = type === HEADERS ? unpad(p) : p;
        if (type === HEADERS && flags & PRIORITY_FLAG) block = block.subarray(5);
        st.headerBlock = [...(type === CONTINUATION ? st.headerBlock ?? [] : []), block.slice()];
        if (type === HEADERS) st.endAfterHeaders = !!(flags & END_STREAM);
        if (!(flags & END_HEADERS)) return;
        const all = st.headerBlock;
        st.headerBlock = null;
        const total = new Uint8Array(all.reduce((n, b) => n + b.length, 0));
        let o = 0;
        for (const b of all) { total.set(b, o); o += b.length; }
        const fields = this.decoder.decode(total);
        const endAfter = st.endAfterHeaders;
        if (!st.headersDone) {
          const status = Number(fields.find(([k]) => k === ':status')?.[1]);
          if (status >= 100 && status < 200) return; // informational
          st.headersDone = true;
          st.head?.({ status, headers: fields.filter(([k]) => !k.startsWith(':')) });
          st.head = null;
        }
        if (endAfter) { st.ended = true; this.streams.delete(id); this.flush(st); }
        return;
      }
      case RST_STREAM: {
        if (st) { this.streams.delete(id); this.failStream(st, new Error(`HTTP/2 stream reset (${dv.getUint32(0)})`)); }
        return;
      }
      case SETTINGS: {
        if (flags & ACK) return;
        for (let i = 0; i + 6 <= p.length; i += 6) {
          const k = dv.getUint16(i), v = dv.getUint32(i + 2);
          if (k === 3) this.maxConcurrent = v;
          else if (k === 4) {
            const delta = v - this.peerInitialWindow;
            this.peerInitialWindow = v;
            for (const s of this.streams.values()) { s.sendWindow += delta; for (const w of s.windowWaiters.splice(0)) w(); }
          } else if (k === 5) this.peerMaxFrame = Math.min(v, 1 << 20);
        }
        void this.send(frame(SETTINGS, ACK, 0)).catch(() => {});
        return;
      }
      case PING: if (!(flags & ACK)) void this.send(frame(PING, ACK, 0, p)).catch(() => {}); return;
      case GOAWAY: {
        this.goingAway = true;
        const last = dv.getUint32(0) & 0x7fffffff;
        for (const [sid, s] of this.streams) if (sid > last) { this.streams.delete(sid); this.failStream(s, Object.assign(new Error('HTTP/2 GOAWAY'), { retry: true })); }
        return;
      }
      case WINDOW_UPDATE: {
        const inc = dv.getUint32(0) & 0x7fffffff;
        if (id === 0) { this.connSendWindow += inc; for (const w of this.connWaiters.splice(0)) w(); }
        else if (st) { st.sendWindow += inc; for (const w of st.windowWaiters.splice(0)) w(); }
        return;
      }
      case PUSH_PROMISE: // push is disabled in our SETTINGS: a server sending one is broken
        this.shutdown(new Error('HTTP/2 PUSH_PROMISE with push disabled'));
        return;
      case PRIORITY: default:
        return;
    }
  }

  private shutdown(err: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const st of this.streams.values()) this.failStream(st, err);
    this.streams.clear();
    for (const w of this.connWaiters.splice(0)) w();
    this.s.close();
  }

  close() {
    if (this.closed) return;
    void this.send(frame(GOAWAY, 0, 0, new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]))).catch(() => {}).finally(() => this.shutdown(new Error('closed')));
  }
}

