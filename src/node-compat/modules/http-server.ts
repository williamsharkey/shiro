/**
 * http.createServer as node has it, served on the page's port table
 * (iframeServer): an EventEmitter with 'request', 'upgrade', 'listening' and
 * 'close'; IncomingMessage a Readable of the body; ServerResponse with
 * statusCode, headers, write/end of strings and bytes. connect (vite's
 * middleware stack), engine.io (Socket.IO) and ws attach to it as they do in
 * node. As before, the script returns to the prompt and the port keeps
 * serving from the page's table until close().
 *
 * A response goes back whole at end(), unless it streams: server-sent events
 * (text/event-stream) or flushHeaders() send the head at once and each write
 * as it comes. A raw connection to the port (iframeServer.connect: a preview's
 * WebSocket) is parsed up to its request head; an Upgrade request is the
 * server's 'upgrade' event with a Duplex socket over the connection, anything
 * else is answered as an ordinary request.
 */
import type { ByteChannel } from '../../byte-pipe';

export interface ServerHost {
  serve: (port: number, handler: (req: any) => Promise<any>, label: string, opts?: { connect?: (c: ByteChannel) => void }) => () => void;
}

export interface ServerDeps {
  host: ServerHost;
  getBuiltinModule: (name: string) => any;
  log: (msg: string) => void;
  /** Opens the preview pane for a new server */
  onListen?: (port: number) => void;
  isHttps: boolean;
}

export const STATUS_CODES: Record<number, string> = {
  100: 'Continue', 101: 'Switching Protocols', 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
  206: 'Partial Content', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified',
  307: 'Temporary Redirect', 308: 'Permanent Redirect', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
  404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable', 408: 'Request Timeout', 409: 'Conflict',
  410: 'Gone', 413: 'Payload Too Large', 415: 'Unsupported Media Type', 426: 'Upgrade Required',
  429: 'Too Many Requests', 500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway',
  503: 'Service Unavailable', 504: 'Gateway Timeout',
};

const te = new TextEncoder();
const toBytes = (chunk: any, enc?: string, B?: any): Uint8Array => {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === 'string') return enc && enc !== 'utf8' && enc !== 'utf-8' && B ? new Uint8Array(B.from(chunk, enc)) : te.encode(chunk);
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return te.encode(String(chunk));
};
const concat = (parts: Uint8Array[]): Uint8Array => {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/** The request head of raw HTTP bytes: null until the blank line has arrived */
function parseHead(buf: Uint8Array): { method: string; url: string; version: string; headers: [string, string][]; rest: Uint8Array } | null {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) {
      const lines = new TextDecoder().decode(buf.subarray(0, i)).split('\r\n');
      const [method = 'GET', url = '/', proto = 'HTTP/1.1'] = lines[0].split(' ');
      const headers: [string, string][] = [];
      for (const l of lines.slice(1)) {
        const c = l.indexOf(':');
        if (c > 0) headers.push([l.slice(0, c).trim(), l.slice(c + 1).trim()]);
      }
      return { method, url, version: proto.replace('HTTP/', ''), headers, rest: buf.slice(i + 4) };
    }
  }
  return null;
}

export function createServerFactory(deps: ServerDeps) {
  const { getBuiltinModule } = deps;
  const { EventEmitter } = getBuiltinModule('events');
  const stream = getBuiltinModule('stream');
  const B = getBuiltinModule('buffer')?.Buffer;
  const asBuffer = (u: Uint8Array) => (B ? B.from(u.buffer, u.byteOffset, u.byteLength) : u);

  /** A socket-like object for req.socket / res.socket on an ordinary request */
  const fakeSocket = (port: number) => {
    const s: any = new EventEmitter();
    Object.assign(s, {
      remoteAddress: '127.0.0.1', remoteFamily: 'IPv4', remotePort: 40000 + Math.floor(Math.random() * 20000),
      localAddress: '127.0.0.1', localPort: port, encrypted: deps.isHttps || undefined, readable: true, writable: true,
      setTimeout() { return s; }, setNoDelay() { return s; }, setKeepAlive() { return s; }, ref() { return s; }, unref() { return s; },
      address: () => ({ address: '127.0.0.1', family: 'IPv4', port }), destroy() { s.destroyed = true; s.emit('close'); return s; },
      end() { return s; }, write() { return true; }, cork() {}, uncork() {},
    });
    return s;
  };

  const makeIncoming = (method: string, url: string, headerList: [string, string][], socket: any, version = '1.1') => {
    const req: any = new stream.Readable({ read() {} });
    const headers: Record<string, any> = {};
    for (const [k, v] of headerList) {
      const key = k.toLowerCase();
      if (key === 'set-cookie') (headers[key] ??= []).push(v);
      else headers[key] = headers[key] !== undefined ? `${headers[key]}, ${v}` : v;
    }
    Object.assign(req, {
      method: method.toUpperCase(), url, headers, rawHeaders: headerList.flat(), trailers: {}, rawTrailers: [],
      httpVersion: version, httpVersionMajor: Number(version.split('.')[0]) || 1, httpVersionMinor: Number(version.split('.')[1]) || 1,
      socket, connection: socket, complete: false, aborted: false,
      setTimeout() { return req; },
    });
    req.on('end', () => { req.complete = true; });
    return req;
  };

  class ServerResponse extends EventEmitter {
    statusCode = 200;
    statusMessage = '';
    headersSent = false;
    finished = false;
    writableEnded = false;
    writableFinished = false;
    sendDate = true;
    chunkedEncoding = false;
    shouldKeepAlive = false;
    socket: any;
    connection: any;
    req: any;
    private headers = new Map<string, { name: string; value: any }>();
    private parts: Uint8Array[] = [];
    private allText = true;
    private stream: ReadableStreamDefaultController<Uint8Array> | null = null;
    constructor(req: any, private deliver: (r: { status: number; statusText: string; headers: Record<string, string>; body: any }) => void) {
      super();
      this.req = req;
      this.socket = this.connection = req.socket;
    }
    setHeader(name: string, value: any) {
      if (this.headersSent) throw Object.assign(new Error('Cannot set headers after they are sent to the client'), { code: 'ERR_HTTP_HEADERS_SENT' });
      this.headers.set(name.toLowerCase(), { name, value });
      return this;
    }
    appendHeader(name: string, value: any) {
      const h = this.headers.get(name.toLowerCase());
      const prev = h ? (Array.isArray(h.value) ? h.value : [h.value]) : [];
      return this.setHeader(name, [...prev, ...(Array.isArray(value) ? value : [value])]);
    }
    getHeader(name: string) { return this.headers.get(name.toLowerCase())?.value; }
    getHeaders() { const o: any = Object.create(null); for (const [k, h] of this.headers) o[k] = h.value; return o; }
    getHeaderNames() { return [...this.headers.keys()]; }
    getRawHeaderNames() { return [...this.headers.values()].map((h) => h.name); }
    hasHeader(name: string) { return this.headers.has(name.toLowerCase()); }
    removeHeader(name: string) { this.headers.delete(name.toLowerCase()); }
    writeHead(code: number, msgOrHeaders?: any, maybeHeaders?: any) {
      this.statusCode = code;
      let headers = maybeHeaders;
      if (typeof msgOrHeaders === 'string') this.statusMessage = msgOrHeaders; else headers = msgOrHeaders;
      if (Array.isArray(headers)) {
        // [[k, v], ...] or the flat [k, v, k, v] form
        const pairs = Array.isArray(headers[0]) ? headers : headers.reduce((a: any[], x: any, i: number) => (i % 2 ? a : [...a, [x, headers[i + 1]]]), []);
        for (const [k, v] of pairs) this.appendHeader(k, v);
      } else if (headers) for (const k of Object.keys(headers)) this.setHeader(k, headers[k]);
      return this;
    }
    writeContinue() {}
    writeProcessing() {}
    addTrailers() {}
    setTimeout() { return this; }
    cork() {}
    uncork() {}
    flushHeaders() { this.startStream(); }
    private headerRecord(): Record<string, string> {
      const out: Record<string, string> = {};
      for (const [k, h] of this.headers) out[k] = Array.isArray(h.value) ? h.value.join(k === 'set-cookie' ? '\n' : ', ') : String(h.value);
      return out;
    }
    private head() {
      return { status: this.statusCode, statusText: this.statusMessage || STATUS_CODES[this.statusCode] || '', headers: this.headerRecord() };
    }
    /** Send the head now; the body follows as it is written */
    private startStream() {
      if (this.headersSent) return;
      this.headersSent = true;
      const body = new ReadableStream<Uint8Array>({
        start: (c) => { this.stream = c; },
        cancel: () => { this.stream = null; this.req.socket.destroyed = true; this.emit('close'); this.req.emit('close'); },
      });
      this.deliver({ ...this.head(), body });
    }
    write(chunk: any, enc?: any, cb?: any) {
      if (typeof enc === 'function') { cb = enc; enc = undefined; }
      if (this.writableEnded) { const e = Object.assign(new Error('write after end'), { code: 'ERR_STREAM_WRITE_AFTER_END' }); queueMicrotask(() => (cb ? cb(e) : this.emit('error', e))); return false; }
      if (!this.headersSent && /text\/event-stream/i.test(String(this.getHeader('content-type') ?? ''))) this.startStream();
      if (chunk !== undefined && chunk !== null && chunk !== '') {
        if (typeof chunk !== 'string') this.allText = false;
        const bytes = toBytes(chunk, enc, B);
        if (this.stream) { try { this.stream.enqueue(bytes.slice()); } catch { /* reader gone */ } }
        else this.parts.push(bytes.slice());
      }
      if (cb) queueMicrotask(cb);
      return true;
    }
    end(chunk?: any, enc?: any, cb?: any) {
      if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
      if (typeof enc === 'function') { cb = enc; enc = undefined; }
      if (this.writableEnded) { if (cb) queueMicrotask(cb); return this; }
      if (chunk !== undefined && chunk !== null) this.write(chunk, enc);
      this.writableEnded = this.finished = true;
      if (this.stream) {
        try { this.stream.close(); } catch { /* reader gone */ }
      } else {
        this.headersSent = true;
        const bytes = concat(this.parts);
        // Text stays a string for the callers that read one (the preview's resource proxy, curl)
        const body = this.allText ? new TextDecoder().decode(bytes) : bytes;
        this.deliver({ ...this.head(), body: this.req.method === 'HEAD' ? '' : body });
      }
      queueMicrotask(() => {
        this.writableFinished = true;
        this.emit('prefinish');
        this.emit('finish');
        this.emit('close');
        cb?.();
      });
      return this;
    }
    destroy(err?: any) {
      if (!this.writableEnded) {
        if (this.stream) { try { this.stream.error(err ?? new Error('socket hang up')); } catch { /* gone */ } }
        else this.deliver({ status: 502, statusText: 'Bad Gateway', headers: {}, body: 'socket hang up' });
      }
      this.writableEnded = true;
      queueMicrotask(() => this.emit('close'));
      return this;
    }
    get writable() { return !this.writableEnded; }
  }

  /** The raw HTTP/1.1 response for an ordinary request that arrived over a raw connection */
  const serialize = (r: { status: number; statusText: string; headers: Record<string, string>; body: any }, bytes: Uint8Array) => {
    const lines = [`HTTP/1.1 ${r.status} ${r.statusText || STATUS_CODES[r.status] || ''}`];
    for (const [k, v] of Object.entries(r.headers)) if (k !== 'content-length' && k !== 'transfer-encoding' && k !== 'connection') lines.push(`${k}: ${v}`);
    lines.push(`content-length: ${bytes.length}`, 'connection: close', '', '');
    return concat([te.encode(lines.join('\r\n')), bytes]);
  };

  function createServer(optsOrHandler?: any, maybeHandler?: any): any {
    const handler = typeof optsOrHandler === 'function' ? optsOrHandler : maybeHandler;
    const server: any = new EventEmitter();
    if (handler) server.on('request', handler);
    let port: number | null = null;
    let unserve: (() => void) | null = null;
    const open = new Set<any>();
    Object.assign(server, {
      listening: false, maxHeadersCount: null, timeout: 0, keepAliveTimeout: 5000, headersTimeout: 60000,
      requestTimeout: 300000, maxRequestsPerSocket: 0, maxConnections: Infinity,
      setTimeout() { return server; }, ref() { return server; }, unref() { return server; },
      address: () => (port === null ? null : { address: '::', family: 'IPv6', port }),
      getConnections: (cb: Function) => queueMicrotask(() => cb(null, open.size)),
      closeAllConnections() { for (const s of [...open]) s.destroy(); },
      closeIdleConnections() {},
    });

    /** One request: the 'request' event, its response when end() (or a stream) gives it */
    const handle = (req: any, body: Uint8Array | null): Promise<any> => new Promise((resolve) => {
      const res = new ServerResponse(req, resolve);
      if (body?.length) req.push(asBuffer(body));
      req.push(null);
      if (!server.listenerCount('request')) { res.statusCode = 404; res.end('No handler'); return; }
      try {
        server.emit('request', req, res);
      } catch (e: any) {
        if (!res.headersSent) { res.statusCode = 500; res.end(`Server error: ${e?.message ?? e}`); }
        server.emit('error', e);
      }
    });

    const fromVirtual = (v: any) => {
      const q = v.query && Object.keys(v.query).length ? '?' + new URLSearchParams(v.query).toString() : '';
      const req = makeIncoming(v.method || 'GET', (v.path || '/') + q, Object.entries(v.headers || {}).map(([k, x]) => [k, String(x)]), fakeSocket(port!));
      const body = v.body == null ? null : typeof v.body === 'string' ? te.encode(v.body) : toBytes(v.body);
      return handle(req, body);
    };

    /** A raw connection: its request head, then 'upgrade' with a socket over it, or an ordinary request */
    const onConnect = async (conn: ByteChannel) => {
      let buf: Uint8Array = new Uint8Array(0);
      let head: ReturnType<typeof parseHead> = null;
      while (!head) {
        const d = await conn.read();
        if (!d) { conn.close(); return; }
        buf = concat([buf, d]);
        head = parseHead(buf);
        if (!head && buf.length > 64 * 1024) { conn.close(); return; }
      }
      const socket: any = new stream.Duplex({
        read() {},
        // (bytesWritten: engine.io ends an upgrade on another path that has written nothing)
        write(this: any, chunk: any, enc: any, cb: Function) { const b = toBytes(chunk, enc, B); this.bytesWritten += b.length; conn.write(b).then(() => cb(), (e) => cb(e)); },
        final(cb: Function) { conn.close(); cb(); },
        destroy(err: any, cb: Function) { conn.close(); cb(err); },
      });
      Object.assign(socket, {
        remoteAddress: '127.0.0.1', remoteFamily: 'IPv4', remotePort: 40000 + Math.floor(Math.random() * 20000),
        localAddress: '127.0.0.1', localPort: port, encrypted: deps.isHttps || undefined, server, bytesRead: 0, bytesWritten: 0,
        setTimeout() { return socket; }, setNoDelay() { return socket; }, setKeepAlive() { return socket; },
        ref() { return socket; }, unref() { return socket; }, address: () => ({ address: '127.0.0.1', family: 'IPv4', port }),
      });
      open.add(socket);
      socket.on('close', () => open.delete(socket));
      const req = makeIncoming(head.method, head.url, head.headers, socket, head.version);
      const upgrade = String(req.headers.upgrade ?? '');
      if (upgrade && /upgrade/i.test(String(req.headers.connection ?? '')) && server.listenerCount('upgrade')) {
        req.push(null);
        // The page end's bytes flow in as the socket's data
        void (async () => {
          for (let d = await conn.read(); d; d = await conn.read()) socket.push(asBuffer(d));
          socket.push(null);
          if (!socket.destroyed) socket.destroy();
        })();
        server.emit('upgrade', req, socket, asBuffer(head.rest));
        return;
      }
      // Not an upgrade (or nobody takes it): answer it as a request and hang up
      const r = await handle(req, head.rest);
      let bytes: Uint8Array;
      if (r.body instanceof ReadableStream) {
        const parts: Uint8Array[] = [];
        const rd = r.body.getReader();
        for (let x = await rd.read(); !x.done; x = await rd.read()) parts.push(x.value);
        bytes = concat(parts);
      } else bytes = typeof r.body === 'string' ? te.encode(r.body) : r.body ?? new Uint8Array(0);
      if (upgrade && !server.listenerCount('upgrade')) r.status = r.status === 200 ? 426 : r.status;
      await conn.write(serialize(r, bytes)).catch(() => {});
      conn.close();
    };

    server.listen = (...args: any[]) => {
      let cb: Function | undefined;
      if (typeof args[args.length - 1] === 'function') cb = args.pop();
      let p = args[0];
      if (p && typeof p === 'object') p = p.port;
      p = Number(p ?? 0);
      if (!p) p = 30000 + Math.floor(Math.random() * 10000);
      try {
        unserve = deps.host.serve(p, fromVirtual, `${deps.isHttps ? 'https' : 'http'}:${p}`, { connect: (c) => { void onConnect(c); } });
      } catch (e: any) {
        const err = Object.assign(new Error(`listen EADDRINUSE: address already in use :::${p}`), { code: 'EADDRINUSE', errno: -98, syscall: 'listen', address: '::', port: p });
        queueMicrotask(() => server.emit('error', err));
        return server;
      }
      port = p;
      server.listening = true;
      deps.log(`Server listening on port ${p}`);
      deps.onListen?.(p);
      setTimeout(() => { server.emit('listening'); cb?.(); }, 0);
      return server;
    };
    server.close = (cb?: Function) => {
      if (!server.listening) {
        const err = Object.assign(new Error('Server is not running.'), { code: 'ERR_SERVER_NOT_RUNNING' });
        if (cb) queueMicrotask(() => cb(err));
        return server;
      }
      server.listening = false;
      unserve?.();
      unserve = null;
      setTimeout(() => { server.emit('close'); cb?.(); }, 0);
      return server;
    };
    server[Symbol.asyncDispose] = () => new Promise<void>((r) => server.close(() => r()));
    return server;
  }

  return { createServer, ServerResponse, STATUS_CODES };
}
