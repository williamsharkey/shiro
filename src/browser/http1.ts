// HTTP/1.1 client over any byte stream (docs/BROWSER.md, "Network").
//
// The Browser app's broker speaks HTTP itself because its bytes travel through
// TLS done in the page (src/browser/tls.ts) over the TCP relay: there is no
// host-browser fetch() underneath. This is the small, strict subset a browser
// needs: request serialization, response parsing (Content-Length, chunked,
// close-delimited), streaming bodies, keep-alive and 1xx skipping.

export interface ByteStream {
  /** Next chunk, or undefined at EOF. */
  read(): Promise<Uint8Array | undefined>;
  write(data: Uint8Array): Promise<void>;
  close(): void;
}

export type HeaderList = [string, string][];

export interface HttpResponseHead {
  status: number;
  statusText: string;
  headers: HeaderList;
}

export interface HttpResponse extends HttpResponseHead {
  /** The (still transfer-decoded but not content-decoded) body. */
  body: ReadableStream<Uint8Array>;
  /** Resolves true once the body was read to its end and the connection may be reused. */
  reusable: Promise<boolean>;
}

const enc = new TextEncoder();
const dec = new TextDecoder('latin1');

/** Buffered reader with pushback, over a ByteStream. */
export class StreamReader {
  private buf: Uint8Array = new Uint8Array(0);
  private eof = false;
  constructor(private s: ByteStream) {}

  private async fill(): Promise<boolean> {
    if (this.eof) return false;
    const d = await this.s.read();
    if (!d) { this.eof = true; return false; }
    if (!this.buf.length) this.buf = d;
    else { const b = new Uint8Array(this.buf.length + d.length); b.set(this.buf); b.set(d, this.buf.length); this.buf = b; }
    return true;
  }

  /** Bytes up to and including CRLF (or LF), without it. Throws on EOF or an over-long line. */
  async line(max = 64 * 1024): Promise<string> {
    let from = 0;
    for (;;) {
      const i = this.buf.indexOf(10, from);
      if (i >= 0) {
        const end = i > 0 && this.buf[i - 1] === 13 ? i - 1 : i;
        const s = dec.decode(this.buf.subarray(0, end));
        this.buf = this.buf.subarray(i + 1);
        return s;
      }
      from = this.buf.length;
      if (this.buf.length > max) throw new Error('header line too long');
      if (!(await this.fill())) throw new Error('connection closed before the response head');
    }
  }

  /** Up to `max` bytes (at least 1), or undefined at EOF. */
  async some(max: number): Promise<Uint8Array | undefined> {
    if (!this.buf.length && !(await this.fill())) return undefined;
    const n = Math.min(max, this.buf.length);
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** Exactly n bytes; throws at EOF. */
  async exactly(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) if (!(await this.fill())) throw new Error('connection closed mid-body');
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  get buffered(): number { return this.buf.length; }
  get atEof(): boolean { return this.eof && !this.buf.length; }
}

export function headerGet(h: HeaderList, name: string): string | null {
  const n = name.toLowerCase();
  const all = h.filter(([k]) => k.toLowerCase() === n).map(([, v]) => v);
  return all.length ? all.join(', ') : null;
}

export function serializeRequest(method: string, url: URL, headers: HeaderList, bodyLength: number | null): Uint8Array {
  const target = (url.pathname || '/') + url.search;
  if (/[\s]/.test(target) || /[^A-Z]/.test(method)) throw new Error('bad request line');
  const lines = [`${method} ${target} HTTP/1.1`];
  const has = (n: string) => headers.some(([k]) => k.toLowerCase() === n);
  if (!has('host')) lines.push(`Host: ${url.host}`);
  for (const [k, v] of headers) {
    if (/[\r\n]/.test(k) || /[\r\n]/.test(v) || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k)) throw new Error(`bad header ${JSON.stringify(k)}`);
    lines.push(`${k}: ${v}`);
  }
  if (bodyLength !== null && !has('content-length') && !has('transfer-encoding')) lines.push(`Content-Length: ${bodyLength}`);
  return enc.encode(lines.join('\r\n') + '\r\n\r\n');
}

export async function readResponseHead(r: StreamReader): Promise<HttpResponseHead> {
  const statusLine = await r.line();
  const m = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(statusLine);
  if (!m) throw new Error(`bad status line: ${statusLine.slice(0, 80)}`);
  const headers: HeaderList = [];
  let size = 0;
  for (;;) {
    const l = await r.line();
    if (l === '') break;
    size += l.length;
    if (size > 256 * 1024 || headers.length > 500) throw new Error('response head too large');
    if (/^[ \t]/.test(l) && headers.length) { headers[headers.length - 1][1] += ' ' + l.trim(); continue; } // obs-fold
    const c = l.indexOf(':');
    if (c <= 0) continue;
    headers.push([l.slice(0, c).trim(), l.slice(c + 1).trim()]);
  }
  return { status: Number(m[1]), statusText: m[2] ?? '', headers };
}

/**
 * Read one response (skipping 1xx) and expose its body as a stream.
 * `onDone(reusable)` runs once the body ends, errors, or is cancelled.
 */
export async function readResponse(r: StreamReader, method: string): Promise<HttpResponse> {
  let head = await readResponseHead(r);
  while (head.status >= 100 && head.status < 200 && head.status !== 101) head = await readResponseHead(r);
  const te = headerGet(head.headers, 'transfer-encoding')?.toLowerCase() ?? '';
  const cl = headerGet(head.headers, 'content-length');
  const connHdr = headerGet(head.headers, 'connection')?.toLowerCase() ?? '';
  const noBody = method === 'HEAD' || head.status === 204 || head.status === 304 || head.status === 101;
  let mode: 'none' | 'chunked' | 'length' | 'close';
  let remaining = 0;
  if (noBody) mode = 'none';
  else if (te.split(',').map((s) => s.trim()).includes('chunked')) mode = 'chunked';
  else if (cl !== null) {
    const n = Number(cl.split(',')[0].trim());
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('bad content-length');
    mode = 'length'; remaining = n;
  } else mode = 'close';
  let resolveReusable!: (v: boolean) => void;
  const reusable = new Promise<boolean>((res) => { resolveReusable = res; });
  const keepAlive = !connHdr.includes('close') && mode !== 'close';
  let chunkLeft = 0;
  let finished = false;
  const finish = (ok: boolean) => { if (!finished) { finished = true; resolveReusable(ok && keepAlive); } };
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      try {
        if (mode === 'none') { finish(true); ctrl.close(); return; }
        if (mode === 'length') {
          if (remaining === 0) { finish(true); ctrl.close(); return; }
          const d = await r.some(Math.min(remaining, 256 * 1024));
          if (!d) throw new Error('connection closed mid-body');
          remaining -= d.length;
          ctrl.enqueue(d.slice());
          if (remaining === 0) { finish(true); ctrl.close(); }
          return;
        }
        if (mode === 'close') {
          const d = await r.some(256 * 1024);
          if (!d) { finish(false); ctrl.close(); return; }
          ctrl.enqueue(d.slice());
          return;
        }
        // chunked
        if (chunkLeft === 0) {
          const sizeLine = await r.line();
          const size = parseInt(sizeLine.split(';')[0].trim(), 16);
          if (!Number.isFinite(size) || size < 0) throw new Error('bad chunk size');
          if (size === 0) {
            while ((await r.line()) !== '') { /* trailers */ }
            finish(true); ctrl.close(); return;
          }
          chunkLeft = size;
        }
        const d = await r.some(Math.min(chunkLeft, 256 * 1024));
        if (!d) throw new Error('connection closed mid-chunk');
        chunkLeft -= d.length;
        ctrl.enqueue(d.slice());
        if (chunkLeft === 0) await r.exactly(2); // CRLF after the chunk
      } catch (e) {
        finish(false);
        ctrl.error(e);
      }
    },
    cancel() { finish(false); },
  }, { highWaterMark: 0 });
  if (mode === 'none') finish(true);
  return { ...head, body, reusable };
}

/** Write a request body (bytes or a stream) to the connection, chunked when its length is unknown. */
export async function writeBody(s: ByteStream, body: Uint8Array | ReadableStream<Uint8Array> | null, chunked: boolean): Promise<void> {
  if (!body) return;
  if (body instanceof Uint8Array) { if (body.length) await s.write(body); return; }
  const reader = body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value?.length) continue;
    if (chunked) {
      await s.write(enc.encode(value.length.toString(16) + '\r\n'));
      await s.write(value);
      await s.write(enc.encode('\r\n'));
    } else await s.write(value);
  }
  if (chunked) await s.write(enc.encode('0\r\n\r\n'));
}
