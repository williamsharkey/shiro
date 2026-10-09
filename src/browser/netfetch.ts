// fetch() for the Browser app's broker: HTTP/2 (http2.ts) or HTTP/1.1
// (http1.ts) over TLS in the page (tls.ts) over raw TCP from a Dialer (the
// kernel's relay sockets in the app, plain node:net in tests). HTTPS offers
// h2 and http/1.1 by ALPN, like a browser. An h2 origin gets one shared
// session; HTTP/1.1 origins keep up to 6 kept-alive connections. Either way a
// page's dozens of requests don't each pay a relay connect and a TLS
// handshake (the relay also rate-limits connects per client IP).
import { ByteStream, HeaderList, HttpResponse, StreamReader, headerGet, readResponse, serializeRequest, writeBody } from './http1';
import { H2Session } from './http2';
import { tlsConnect } from './tls';

export type Dialer = (host: string, port: number) => Promise<ByteStream>;

export interface NetRequest {
  url: string;
  method: string;
  headers: HeaderList;
  body: Uint8Array | ReadableStream<Uint8Array> | null;
  signal?: AbortSignal;
}

export interface NetResponse extends HttpResponse {
  url: string;
  /** Bytes received on the wire for this response (head + body, before content decoding). */
  wireBytes: () => number;
}

interface Conn { stream: ByteStream; reader: StreamReader; key: string; uses: number; bytes: number; idleTimer?: ReturnType<typeof setTimeout> }

export interface NetFetchOptions {
  dial: Dialer;
  /** Wrap a raw connection in TLS (default tlsConnect); a result with `alpn: 'h2'` gets HTTP/2. */
  tls?: (raw: ByteStream, host: string, redial?: () => Promise<ByteStream>, alpn?: string[]) => Promise<ByteStream & { alpn?: string | null }>;
  /** Offer HTTP/2 (default true). */
  http2?: boolean;
  maxPerOrigin?: number;
  idleMs?: number;
  /** Count bytes per caller (the app shows per-tab download totals). */
  onBytes?: (n: number) => void;
}

/** A Brotli-capable DecompressionStream, where the browser has one. */
export function supportsBrotli(): boolean {
  try { new DecompressionStream('brotli' as CompressionFormat); return true; } catch { return false; }
}

/** What the broker needs from a transport (NetFetcher here; ServerFetcher for local comparisons). */
export interface Fetcher {
  fetch(req: NetRequest): Promise<NetResponse>;
  closeAll(): void;
  stats: { connects: number; reused: number; requests: number; bytes: number };
}

export class NetFetcher implements Fetcher {
  private idle = new Map<string, Conn[]>();
  private active = new Map<string, number>();
  private waiters = new Map<string, (() => void)[]>();
  private opts: Required<Omit<NetFetchOptions, 'onBytes'>> & Pick<NetFetchOptions, 'onBytes'>;
  /** origin → its HTTP/2 session */
  private h2 = new Map<string, H2Session>();
  /** origin → the first connection being opened (requests wait to see whether it is h2) */
  private opening = new Map<string, Promise<void>>();
  /** origins that answered with HTTP/1.1 */
  private h1Origins = new Set<string>();
  stats = { connects: 0, reused: 0, requests: 0, bytes: 0, h2Sessions: 0, h2Streams: 0 };

  constructor(opts: NetFetchOptions) {
    this.opts = { tls: tlsConnect, maxPerOrigin: 6, idleMs: 60_000, http2: true, ...opts };
  }

  /** An idle HTTP/2 session with room for a stream, else null. */
  private h2For(key: string): H2Session | null {
    const s = this.h2.get(key);
    if (s && s.available) return s;
    if (s && (s.closed || s.goingAway)) this.h2.delete(key);
    return null;
  }

  private async acquire(u: URL): Promise<Conn | H2Session> {
    const key = `${u.protocol}//${u.host}`;
    for (;;) {
      const list = this.idle.get(key);
      const c = list?.pop();
      if (c) { clearTimeout(c.idleTimer); this.stats.reused++; c.uses++; return c; }
      if ((this.active.get(key) ?? 0) < this.opts.maxPerOrigin) break;
      await new Promise<void>((res) => { const w = this.waiters.get(key) ?? []; w.push(res); this.waiters.set(key, w); });
    }
    this.active.set(key, (this.active.get(key) ?? 0) + 1);
    try {
      const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
      const host = u.hostname.replace(/^\[|\]$/g, '');
      let stream: ByteStream & { alpn?: string | null } = await this.opts.dial(host, port);
      this.stats.connects++;
      if (u.protocol === 'https:') {
        stream = await this.opts.tls(stream, host, () => this.opts.dial(host, port), this.opts.http2 ? ['h2', 'http/1.1'] : ['http/1.1']);
      }
      if (stream.alpn === 'h2') {
        // Not an HTTP/1.1 slot after all: one shared session for the origin
        this.release(key);
        const counted = this.counting(stream, { bytes: 0 } as Conn);
        const session = new H2Session(counted, u.host);
        await session.start();
        this.h2.set(key, session);
        this.stats.h2Sessions++;
        return session;
      }
      if (u.protocol === 'https:') this.h1Origins.add(key);
      const c = { key, uses: 1, bytes: 0 } as Conn;
      c.stream = this.counting(stream, c);
      c.reader = new StreamReader(c.stream);
      return c;
    } catch (e) {
      this.release(key);
      throw e;
    }
  }

  private counting(s: ByteStream, c: Conn): ByteStream {
    return {
      read: async () => {
        const d = await s.read();
        if (d) { this.stats.bytes += d.length; this.opts.onBytes?.(d.length); c.bytes += d.length; }
        return d;
      },
      write: (d) => s.write(d),
      close: () => s.close(),
    };
  }

  private release(key: string) {
    this.active.set(key, Math.max(0, (this.active.get(key) ?? 1) - 1));
    this.waiters.get(key)?.shift()?.();
  }

  private park(c: Conn) {
    const list = this.idle.get(c.key) ?? [];
    c.idleTimer = setTimeout(() => {
      const l = this.idle.get(c.key);
      const i = l?.indexOf(c) ?? -1;
      if (i >= 0) l!.splice(i, 1);
      c.stream.close();
      this.release(c.key);
    }, this.opts.idleMs);
    list.push(c);
    this.idle.set(c.key, list);
    // Parked connections still count as active; hand them to a waiter directly
    const w = this.waiters.get(c.key)?.shift();
    if (w) w();
  }

  /** One HTTP exchange (no redirects, no cookies: the broker does those). */
  async fetch(req: NetRequest): Promise<NetResponse> {
    const u = new URL(req.url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`unsupported scheme ${u.protocol}`);
    this.stats.requests++;
    const replayable = !(req.body instanceof ReadableStream);
    const key = `${u.protocol}//${u.host}`;
    for (let attempt = 0; ; attempt++) {
      // HTTP/2: an existing session, or wait for the origin's first connection to say whether it is h2
      let session = u.protocol === 'https:' ? this.h2For(key) : null;
      if (!session && u.protocol === 'https:' && this.opts.http2 && !this.h1Origins.has(key)) {
        const pending = this.opening.get(key);
        if (pending) { await pending.catch(() => {}); continue; }
      }
      let got: Conn | H2Session;
      if (session) got = session;
      else {
        const first = u.protocol === 'https:' && this.opts.http2 && !this.h1Origins.has(key) && !this.h2.has(key);
        const p = this.acquire(u);
        if (first) this.opening.set(key, p.then(() => {}, () => {}).finally(() => this.opening.delete(key)));
        got = await p;
      }
      if (got instanceof H2Session) {
        try {
          this.stats.h2Streams++;
          const res = await got.request(req.method, u, req.headers, req.body, req.signal);
          // Wire bytes for the per-tab counter: the DATA payload plus a rough header size
          let n = res.headers.reduce((t, [k, v]) => t + k.length + v.length + 2, 0);
          const body = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform: (c, ctl) => { n += c.length; ctl.enqueue(c); } }));
          return { ...res, body, url: req.url, wireBytes: () => n };
        } catch (e) {
          // A GOAWAY before our stream was processed: safe to retry once on a new connection
          if ((e as { retry?: boolean }).retry && attempt === 0 && replayable) continue;
          throw e;
        }
      }
      const c = got;
      const reused = c.uses > 1;
      try {
        const headers = req.headers.slice();
        let bodyLen: number | null = null;
        let chunked = false;
        if (req.body instanceof Uint8Array) bodyLen = req.body.length;
        else if (req.body) { chunked = !headerGet(headers, 'content-length'); if (chunked) headers.push(['Transfer-Encoding', 'chunked']); }
        else if (!['GET', 'HEAD', 'OPTIONS', 'DELETE'].includes(req.method)) bodyLen = 0;
        await c.stream.write(serializeRequest(req.method, u, headers, bodyLen));
        await writeBody(c.stream, req.body, chunked);
        const before = c.bytes - c.reader.buffered;
        const res = await readResponse(c.reader, req.method);
        res.reusable.then((ok) => {
          if (ok && c.reader.buffered === 0) this.park(c);
          else { c.stream.close(); this.release(c.key); }
        });
        if (req.signal) req.signal.addEventListener('abort', () => { void res.body.cancel().catch(() => {}); }, { once: true });
        return { ...res, url: req.url, wireBytes: () => c.bytes - c.reader.buffered - before };
      } catch (e) {
        c.stream.close();
        this.release(c.key);
        // A kept-alive connection the server already closed: retry once on a fresh one
        if (reused && attempt === 0 && replayable) continue;
        throw e;
      }
    }
  }

  closeAll() {
    for (const s of this.h2.values()) s.close();
    this.h2.clear();
    for (const list of this.idle.values()) for (const c of list) { clearTimeout(c.idleTimer); c.stream.close(); }
    this.idle.clear(); this.active.clear();
  }
}

/** Undo Content-Encoding (gzip, deflate, br where supported); unknown codings pass through untouched. */
export function decodeBody(body: ReadableStream<Uint8Array>, contentEncoding: string | null): { body: ReadableStream<Uint8Array>; decoded: boolean } {
  const codings = (contentEncoding ?? '').toLowerCase().split(',').map((s) => s.trim()).filter((s) => s && s !== 'identity');
  if (!codings.length) return { body, decoded: false };
  let out = body;
  for (const c of codings.reverse()) {
    const fmt = c === 'gzip' || c === 'x-gzip' ? 'gzip' : c === 'deflate' ? 'deflate' : c === 'br' ? 'brotli' : null;
    if (!fmt) return { body, decoded: false };
    try {
      out = out.pipeThrough(new DecompressionStream(fmt as CompressionFormat) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
    } catch { return { body, decoded: false }; }
  }
  return { body: out, decoded: true };
}
