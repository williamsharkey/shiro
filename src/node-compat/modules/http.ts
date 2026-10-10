/**
 * Node.js 'http', 'https', and 'http2' module shims.
 * Extracted from node-cmd.ts case 'http' / 'https' / 'http2'.
 */

import type { CommandContext } from '../../commands/index';
import { createServerFactory } from './http-server';

export interface HttpDeps {
  ctx: CommandContext;
  iframeServer: {
    serve: (port: number, handler: (req: any) => Promise<any>, label: string, opts?: { connect?: (c: any) => void }) => () => void;
    createIframe: (port: number, container: any, opts: { height: string }) => Promise<any>;
    isPortInUse?: (port: number) => boolean;
  };
  fakeConsole: { log: (...args: any[]) => void; warn: (...args: any[]) => void };
  getBuiltinModule: (name: string) => any;
  /** Counts a promise as the script's async activity (keeps it from idling out) */
  trackAsync?: <T>(p: Promise<T>) => Promise<T>;
  atExit?: (fn: () => void) => void;
}

export function createHttpModule(deps: HttpDeps): any {
  return _createHttpOrHttpsModule(deps, false);
}

export function createHttpsModule(deps: HttpDeps): any {
  return _createHttpOrHttpsModule(deps, true);
}

function _createHttpOrHttpsModule(deps: HttpDeps, isHttps: boolean): any {
  const { ctx, iframeServer, fakeConsole, getBuiltinModule } = deps;

  // http.createServer on the page's port table (http-server.ts)
  const serverApi = createServerFactory({
    host: iframeServer,
    getBuiltinModule,
    isHttps,
    atExit: deps.atExit,
    // Nothing in the program's own output: real node prints nothing when a server listens
    log: () => {},
    // A split-view preview pane for a server that stays up (not one a script starts, uses and closes)
    onListen: (port) => {
      if (typeof document === 'undefined') return;
      setTimeout(() => {
        if (iframeServer.isPortInUse?.(port) === false) return;
        import('../../split-view').then(({ createSplitView }) => {
          createSplitView({ port, direction: 'right', title: `Server :${port}` });
        }).catch(() => { /* no desktop to show it in */ });
      }, 1000);
    },
  });
  const createServer = serverApi.createServer;

  // IncomingMessage — needed for class extends
  class IncomingMessage {
    headers: Record<string, string> = {};
    method = 'GET';
    url = '/';
    statusCode = 200;
    httpVersion = '1.1';
    on(_e: string, _fn: Function) { return this; }
    once(_e: string, _fn: Function) { return this; }
    pipe(dest: any) { return dest; }
  }

  // Agent — used as base class by AWS SDK, gRPC, etc.
  // An EventEmitter, as in Node (agentkeepalive and pnpm's agents subclass it and listen)
  const AgentBase: any = getBuiltinModule('events');
  class Agent extends AgentBase {
    maxSockets = Infinity;
    maxFreeSockets = 256;
    options: any = {};
    requests: any = {};
    sockets: any = {};
    freeSockets: any = {};
    constructor(opts?: any) { super(); if (opts) this.options = opts; }
    destroy() {}
    createConnection(opts: any, cb: Function) { cb(null, new (getBuiltinModule('net') as any).Socket()); }
  }

  // ClientRequest — uses browser fetch to make real HTTP requests
  class FetchClientRequest {
    _events: Record<string, Function[]> = {};
    _headers: Record<string, string> = {};
    _body: string[] = [];
    _opts: any;
    _ended = false;
    _aborted = false;
    _timeout = 0;
    _abortController: AbortController | null = null;

    constructor(opts: any) {
      this._opts = opts;
      if (opts.headers) {
        for (const [k, v] of Object.entries(opts.headers)) {
          this._headers[k.toLowerCase()] = String(v);
        }
      }
      if (opts.timeout) this._timeout = opts.timeout;
    }
    on(ev: string, fn: Function) { (this._events[ev] ??= []).push(fn); return this; }
    once(ev: string, fn: Function) {
      const wrapper = (...args: any[]) => {
        this._events[ev] = (this._events[ev] || []).filter(f => f !== wrapper);
        fn(...args);
      };
      return this.on(ev, wrapper);
    }
    emit(ev: string, ...args: any[]) { (this._events[ev] || []).forEach(f => f(...args)); }
    setHeader(name: string, value: string) { this._headers[name.toLowerCase()] = String(value); }
    getHeader(name: string) { return this._headers[name.toLowerCase()]; }
    removeHeader(name: string) { delete this._headers[name.toLowerCase()]; }
    write(chunk: string | Uint8Array) {
      this._body.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    }
    end(data?: string | Uint8Array) {
      if (this._ended) return;
      this._ended = true;
      if (data) this.write(data);
      if (this._aborted) return;

      // Build URL from opts
      const o = this._opts;
      const protocol = o.protocol || (isHttps ? 'https:' : 'http:');
      const host = o.hostname || o.host || 'localhost';
      const port = o.port ? `:${o.port}` : '';
      const path = o.path || '/';
      const url = `${protocol}//${host}${port}${path}`;

      // Use AbortController for timeout support
      this._abortController = new AbortController();
      const timeoutMs = this._timeout || 30000; // default 30s timeout
      const timeoutId = setTimeout(() => {
        this._abortController?.abort();
        this.emit('timeout');
      }, timeoutMs);

      const fetchOpts: RequestInit = {
        method: o.method || 'GET',
        headers: this._headers,
        signal: this._abortController.signal,
      };
      if (this._body.length > 0 && o.method !== 'GET' && o.method !== 'HEAD') {
        fetchOpts.body = this._body.join('');
      }

      globalThis.fetch(url, fetchOpts).then(async (resp) => {
        clearTimeout(timeoutId);
        // Build IncomingMessage-like response
        // The browser already decoded the body: no content-encoding (node-fetch
        // would gunzip it again) and no length of the encoded body
        const resHeaders: Record<string, string> = {};
        const rawHeaders: string[] = [];
        resp.headers.forEach((v, k) => {
          if (k === 'content-encoding' || k === 'content-length') return;
          resHeaders[k] = v;
          rawHeaders.push(k, v);
        });
        const body = resp.body;

        // A real Readable, so pipeline/pipe/async iteration work (node-fetch)
        const { Readable } = getBuiltinModule('stream');
        const B = getBuiltinModule('buffer').Buffer;
        const res: any = new Readable({ read() {} });
        res.statusCode = resp.status;
        res.statusMessage = resp.statusText;
        res.headers = resHeaders;
        res.rawHeaders = rawHeaders;
        res.trailers = {};
        res.rawTrailers = [];
        res.httpVersion = '1.1';
        res.httpVersionMajor = 1;
        res.httpVersionMinor = 1;
        res.complete = false;
        res.req = this;
        res.url = '';
        res.method = null;
        // The browser did TLS (and checked the certificate): request/yarn
        // refuse an https response whose socket isn't authorized
        const secure = protocol === 'https:';
        res.socket = res.connection = {
          authorized: secure, encrypted: secure, authorizationError: null, remoteAddress: host,
          setTimeout() { return this; }, setNoDelay() { return this; }, setKeepAlive() { return this; },
          on() { return this; }, once() { return this; }, off() { return this; }, removeListener() { return this; },
          prependListener() { return this; }, destroy() {}, ref() {}, unref() {},
        };
        res.setTimeout = (_ms: number, cb?: Function) => { if (cb) res.once('timeout', cb); return res; };

        // Emit response callback
        this.emit('response', res);

        // Stream body data
        if (body) {
          const reader = body.getReader();
          const pump = async () => {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (res.destroyed) { reader.cancel().catch(() => {}); return; }
              res.push(B.from(value));
            }
            res.complete = true;
            res.push(null);
          };
          // A body still arriving is activity: yarn's tarball downloads ended
          // with the script, which had looked idle once the headers came
          const pumped = pump().catch(err => { res.destroy(err); });
          deps.trackAsync?.(pumped);
        } else {
          res.complete = true;
          res.push(null);
        }
      }).catch(err => {
        clearTimeout(timeoutId);
        this.emit('error', err);
      });
    }
    abort() { this._aborted = true; this._abortController?.abort(); this.emit('abort'); }
    destroy(err?: Error) { this._aborted = true; this._abortController?.abort(); if (err) this.emit('error', err); }
    setTimeout(ms: number, cb?: Function) { this._timeout = ms; if (cb) this.on('timeout', cb); return this; }
    flushHeaders() {}
    setNoDelay() {}
    setSocketKeepAlive() {}
  }

  const makeRequest = (optsOrUrl: any, cbOrOpts?: any, cb?: Function) => {
    let opts: any;
    let callback: Function | undefined;
    if (typeof optsOrUrl === 'string') {
      const u = new URL(optsOrUrl);
      opts = { protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET' };
      callback = typeof cbOrOpts === 'function' ? cbOrOpts : cb;
      if (typeof cbOrOpts === 'object') Object.assign(opts, cbOrOpts);
    } else if (optsOrUrl instanceof URL) {
      opts = { protocol: optsOrUrl.protocol, hostname: optsOrUrl.hostname, port: optsOrUrl.port, path: optsOrUrl.pathname + optsOrUrl.search, method: 'GET' };
      callback = typeof cbOrOpts === 'function' ? cbOrOpts : cb;
    } else {
      opts = optsOrUrl;
      callback = typeof cbOrOpts === 'function' ? cbOrOpts : cb;
    }
    const req = new FetchClientRequest(opts);
    if (callback) req.on('response', callback);
    return req;
  };

  const makeGet = (optsOrUrl: any, cbOrOpts?: any, cb?: Function) => {
    const req = makeRequest(optsOrUrl, cbOrOpts, cb);
    req.end();
    return req;
  };

  const STATUS_CODES = serverApi.STATUS_CODES;

  const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH'];

  return {
    createServer,
    Server: function(handler?: any) { return createServer(handler); },
    request: makeRequest,
    get: makeGet,
    IncomingMessage,
    ServerResponse: serverApi.ServerResponse,
    ClientRequest: FetchClientRequest,
    Agent,
    globalAgent: new Agent(),
    STATUS_CODES,
    METHODS,
  };
}

export function createHttp2Module(): any {
  const createSecureClient = () => {
    const ee: any = { on: () => ee, once: () => ee, off: () => ee, emit: () => {}, close: () => {}, destroy: () => {} };
    return ee;
  };
  return {
    connect: createSecureClient,
    createServer: () => createSecureClient(),
    createSecureServer: () => createSecureClient(),
    constants: {
      HTTP2_HEADER_PATH: ':path',
      HTTP2_HEADER_METHOD: ':method',
      HTTP2_HEADER_STATUS: ':status',
      HTTP2_HEADER_CONTENT_TYPE: 'content-type',
      NGHTTP2_CANCEL: 0x8,
    },
  };
}
