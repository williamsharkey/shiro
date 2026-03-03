/**
 * Node.js 'http', 'https', and 'http2' module shims.
 * Extracted from node-cmd.ts case 'http' / 'https' / 'http2'.
 */

import type { CommandContext } from '../../commands/index';

export interface HttpDeps {
  ctx: CommandContext;
  iframeServer: {
    serve: (port: number, handler: (req: any) => Promise<any>, label: string) => () => void;
    createIframe: (port: number, container: any, opts: { height: string }) => Promise<any>;
  };
  fakeConsole: { log: (...args: any[]) => void; warn: (...args: any[]) => void };
  getBuiltinModule: (name: string) => any;
}

export function createHttpModule(deps: HttpDeps): any {
  return _createHttpOrHttpsModule(deps, false);
}

export function createHttpsModule(deps: HttpDeps): any {
  return _createHttpOrHttpsModule(deps, true);
}

function _createHttpOrHttpsModule(deps: HttpDeps, isHttps: boolean): any {
  const { ctx, iframeServer, fakeConsole, getBuiltinModule } = deps;

  // HTTP server shim using Shiro's virtual server
  const createServer = (handler?: (req: any, res: any) => void) => {
    let requestHandler = handler;
    let cleanupFn: (() => void) | null = null;
    let listeningPort: number | null = null;

    const server: any = {
      _events: {} as Record<string, Function[]>,
      listening: false,
      on(event: string, cb: Function) {
        if (event === 'request' && !requestHandler) {
          requestHandler = cb as any;
        }
        (this._events[event] ??= []).push(cb);
        return this;
      },
      once(event: string, cb: Function) {
        const wrapper = (...args: any[]) => {
          this.off(event, wrapper);
          cb(...args);
        };
        return this.on(event, wrapper);
      },
      off(event: string, cb: Function) {
        if (this._events[event]) {
          this._events[event] = this._events[event].filter((f: Function) => f !== cb);
        }
        return this;
      },
      removeListener(event: string, cb: Function) { return this.off(event, cb); },
      removeAllListeners(event?: string) {
        if (event) delete this._events[event];
        else this._events = {};
        return this;
      },
      addListener(event: string, cb: Function) { return this.on(event, cb); },
      listeners(event: string) { return [...(this._events[event] || [])]; },
      listenerCount(event: string) { return (this._events[event] || []).length; },
      emit(event: string, ...args: any[]) {
        (this._events[event] || []).forEach((fn: Function) => fn(...args));
        return (this._events[event] || []).length > 0;
      },
      ref() { return this; },
      unref() { return this; },
      setTimeout() { return this; },
      maxConnections: Infinity,
      connections: 0,
      listen(port: number, hostOrCallback?: string | (() => void), callback?: () => void) {
        const cb = typeof hostOrCallback === 'function' ? hostOrCallback : callback;
        // Port 0 means "pick a random available port"
        if (port === 0) port = 30000 + Math.floor(Math.random() * 10000);
        listeningPort = port;

        // Use iframe-based server for visibility
        const handler = async (vReq: any) => {
          return new Promise<any>((resolve) => {
            // Build Node-like request object
            const req: any = {
              method: vReq.method,
              url: vReq.path + (Object.keys(vReq.query || {}).length ? '?' + new URLSearchParams(vReq.query).toString() : ''),
              headers: vReq.headers || {},
              query: vReq.query || {},
              body: vReq.body,
              on(event: string, handler: Function) {
                if (event === 'data' && vReq.body) {
                  setTimeout(() => handler(vReq.body), 0);
                }
                if (event === 'end') {
                  setTimeout(() => handler(), 0);
                }
                return this;
              },
            };

            // Build Node-like response object
            let statusCode = 200;
            let responseHeaders: Record<string, string> = {};
            let responseBody = '';

            const res: any = {
              statusCode: 200,
              setHeader(name: string, value: string) {
                responseHeaders[name.toLowerCase()] = value;
              },
              getHeader(name: string) {
                return responseHeaders[name.toLowerCase()];
              },
              writeHead(code: number, headers?: Record<string, string>) {
                statusCode = code;
                if (headers) {
                  for (const [k, v] of Object.entries(headers)) {
                    responseHeaders[k.toLowerCase()] = v;
                  }
                }
                return this;
              },
              write(chunk: string) {
                responseBody += chunk;
                return true;
              },
              end(data?: string) {
                if (data) responseBody += data;
                resolve({
                  status: statusCode,
                  headers: responseHeaders,
                  body: responseBody,
                });
              },
              // Express-style helpers
              status(code: number) {
                statusCode = code;
                return this;
              },
              json(data: any) {
                responseHeaders['content-type'] = 'application/json';
                this.end(JSON.stringify(data));
              },
              send(data: any) {
                if (typeof data === 'object') {
                  this.json(data);
                } else {
                  this.end(String(data));
                }
              },
            };

            // Call the request handler
            if (requestHandler) {
              try {
                requestHandler(req, res);
              } catch (err: any) {
                resolve({
                  status: 500,
                  body: `Server error: ${err.message}`,
                });
              }
            } else {
              resolve({ status: 404, body: 'No handler' });
            }
          });
        };

        // Register with iframe server
        const proto = isHttps ? 'https' : 'http';
        cleanupFn = iframeServer.serve(port, handler, `${proto}:${port}`);
        fakeConsole.log(`Server listening on port ${port}`);

        // Open split-view preview pane
        try {
          if (typeof document !== 'undefined') {
            import('../../split-view').then(({ createSplitView }) => {
              createSplitView({ port, direction: 'right', title: `Server :${port}` });
              fakeConsole.log('Browser window opened');
            }).catch((err: Error) => fakeConsole.warn('Could not open browser:', err.message));
          }
        } catch {}

        server.listening = true;
        // Fire callback async (like real Node.js nextTick)
        setTimeout(() => {
          server.emit('listening');
          cb?.();
        }, 0);

        return this;
      },
      close(cb?: () => void) {
        server.listening = false;
        if (cleanupFn) {
          cleanupFn();
          cleanupFn = null;
        }
        if (listeningPort) {
          fakeConsole.log(`Server on port ${listeningPort} closed`);
          listeningPort = null;
        }
        // Close split-view pane
        try {
          if (typeof document !== 'undefined') {
            import('../../split-view').then(({ closeSplitView }) => closeSplitView()).catch(() => {});
          }
        } catch {}
        server.emit('close');
        cb?.();
        return this;
      },
      address() {
        return listeningPort ? { port: listeningPort, address: '0.0.0.0' } : null;
      },
      closeAllConnections() { /* no-op stub */ },
      closeIdleConnections() { /* no-op stub */ },
      getConnections(cb?: Function) { cb?.(null, 0); },
    };
    return server;
  };

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
  class Agent {
    maxSockets = Infinity;
    maxFreeSockets = 256;
    options: any = {};
    requests: any = {};
    sockets: any = {};
    freeSockets: any = {};
    constructor(opts?: any) { if (opts) this.options = opts; }
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
        const resHeaders: Record<string, string> = {};
        resp.headers.forEach((v, k) => { resHeaders[k] = v; });
        const body = resp.body;

        const res: any = new IncomingMessage();
        res.statusCode = resp.status;
        res.statusMessage = resp.statusText;
        res.headers = resHeaders;
        res.httpVersion = '1.1';

        const resEvents: Record<string, Function[]> = {};
        res.on = (ev: string, fn: Function) => { (resEvents[ev] ??= []).push(fn); return res; };
        res.once = (ev: string, fn: Function) => { return res.on(ev, fn); };
        res.removeListener = (ev: string, fn: Function) => { resEvents[ev] = (resEvents[ev] || []).filter(f => f !== fn); return res; };
        res.removeAllListeners = (ev?: string) => { if (ev) delete resEvents[ev]; else Object.keys(resEvents).forEach(k => delete resEvents[k]); return res; };
        res.pipe = (dest: any) => {
          res.on('data', (chunk: any) => dest.write(chunk));
          res.on('end', () => { if (dest.end) dest.end(); });
          return dest;
        };
        res.resume = () => res;
        res.destroy = () => res;
        res.setEncoding = (_enc: string) => res;

        // Emit response callback
        this.emit('response', res);

        // Stream body data
        if (body) {
          const reader = body.getReader();
          const pump = async () => {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              (resEvents['data'] || []).forEach(fn => fn(value));
            }
            (resEvents['end'] || []).forEach(fn => fn());
            (resEvents['close'] || []).forEach(fn => fn());
          };
          pump().catch(err => {
            (resEvents['error'] || []).forEach(fn => fn(err));
          });
        } else {
          queueMicrotask(() => {
            (resEvents['end'] || []).forEach(fn => fn());
            (resEvents['close'] || []).forEach(fn => fn());
          });
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

  const STATUS_CODES: Record<number, string> = {
    200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently',
    302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized',
    403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
    500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
  };

  const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH'];

  return {
    createServer,
    Server: function(handler?: any) { return createServer(handler); },
    request: makeRequest,
    get: makeGet,
    IncomingMessage,
    ServerResponse: class ServerResponse {},
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
