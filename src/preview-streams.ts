/**
 * Live connections from a preview window to the in-tab server it shows:
 * WebSocket, EventSource and streamed fetch/XHR. Dev servers rely on them
 * (vite's HMR socket, webpack-dev-server, Socket.IO, live-reload SSE).
 *
 * A preview is a srcdoc iframe, so its own WebSocket and fetch would go to
 * the real network. previewStreamsScript() replaces them in the page for
 * local URLs (relative, localhost, 127.0.0.1, or no host at all); the page
 * asks its parent by postMessage, and installStreamProxy() answers there:
 *
 *   fetch/XHR/EventSource  vfs-stream-fetch → iframeServer.fetch, the head
 *                          then the body in chunks as the server writes them
 *   WebSocket              vfs-ws-open → iframeServer.connect, an RFC 6455
 *                          client (src/browser/websocket.ts) over the raw
 *                          connection; the server end is a node http server's
 *                          'upgrade' (ws, engine.io) or a kernel listener
 */
import type { ByteChannel } from './byte-pipe';
import { WsClient } from './browser/websocket';

export interface StreamHost {
  fetch(port: number, path: string, opts?: { method?: string; headers?: Record<string, string>; body?: any }): Promise<{
    status?: number; statusText?: string; headers?: Record<string, string>; body?: any;
  }>;
  connect(port: number): ByteChannel;
}

/** The page side, as a <script> to put after the resource interceptor (PORT: the server the page came from) */
export function previewStreamsScript(port: number): string {
  return `
<script>
(function() {
  var PORT = ${port};
  var P = 'p' + Math.random().toString(36).slice(2) + '_';
  var seq = 0, streams = {}, sockets = {};
  var parentWin = window.parent;
  function post(m, transfer) { parentWin.postMessage(m, '*', transfer || []); }
  // {port, path} for a URL the in-tab servers answer, else null
  function local(u) {
    u = String(u);
    if (/^(\\/(?!\\/)|\\.\\.?\\/)/.test(u)) return { port: PORT, path: u };
    var m = /^(https?|wss?):\\/\\/([^\\/?#]*)(.*)$/i.exec(u);
    if (!m) return null;
    var hm = /^(\\[[^\\]]*\\]|[^:]*)(?::(\\d+))?$/.exec(m[2]);
    if (!hm) return null;
    var host = hm[1].toLowerCase();
    if (host !== '' && host !== 'localhost' && host !== '127.0.0.1' && host !== '0.0.0.0' && host !== '[::1]') return null;
    var port = hm[2] ? +hm[2] : (host === '' ? PORT : (/^(https|wss)/i.test(m[1]) ? 443 : 80));
    return { port: port, path: m[3] || '/' };
  }
  window.addEventListener('message', function(e) {
    var d = e.data;
    if (!d || typeof d.type !== 'string' || d.type.indexOf('vfs-') !== 0) return;
    if (d.type === 'vfs-ws-event') { var w = sockets[d.id]; if (w) w._event(d); return; }
    var s = streams[d.id];
    if (!s) return;
    if (d.type === 'vfs-stream-head') s.head(d);
    else if (d.type === 'vfs-stream-chunk') { try { s.ctrl.enqueue(new Uint8Array(d.chunk)); } catch (x) {} }
    else if (d.type === 'vfs-stream-end') { delete streams[d.id]; try { s.ctrl.close(); } catch (x) {} }
    else if (d.type === 'vfs-stream-error') { delete streams[d.id]; s.fail(new TypeError('Failed to fetch: ' + d.message)); }
  });

  // ── fetch, streamed ──
  function bodyOf(b) {
    if (b == null) return Promise.resolve(null);
    if (typeof b === 'string') return Promise.resolve(b);
    if (b instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(b.slice(0)));
    if (ArrayBuffer.isView(b)) return Promise.resolve(new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
    if (b instanceof URLSearchParams) return Promise.resolve(b.toString());
    return new Response(b).arrayBuffer().then(function(a) { return new Uint8Array(a); });
  }
  function streamFetch(t, init) {
    init = init || {};
    var headers = {};
    if (init.headers) new Headers(init.headers).forEach(function(v, k) { headers[k] = v; });
    if (init.body instanceof URLSearchParams && !headers['content-type']) headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    return bodyOf(init.body).then(function(body) {
      return new Promise(function(resolve, reject) {
        var id = P + (++seq), ctrl, started = false;
        var rs = new ReadableStream({
          start: function(c) { ctrl = c; },
          cancel: function() { delete streams[id]; post({ type: 'vfs-stream-cancel', id: id }); }
        });
        streams[id] = {
          get ctrl() { return ctrl; },
          head: function(d) {
            started = true;
            var nobody = d.status === 204 || d.status === 205 || d.status === 304 || (init.method || 'GET').toUpperCase() === 'HEAD';
            var r = new Response(nobody ? null : rs, { status: d.status < 200 ? 200 : d.status, statusText: d.statusText || '', headers: d.headers || {} });
            try { Object.defineProperty(r, 'url', { value: t.url }); } catch (x) {}
            resolve(r);
          },
          fail: function(err) { if (started) { try { ctrl.error(err); } catch (x) {} } else reject(err); }
        };
        if (init.signal) {
          if (init.signal.aborted) { delete streams[id]; reject(new DOMException('The operation was aborted.', 'AbortError')); return; }
          init.signal.addEventListener('abort', function() {
            if (!streams[id]) return;
            delete streams[id];
            post({ type: 'vfs-stream-cancel', id: id });
            var err = new DOMException('The operation was aborted.', 'AbortError');
            if (started) { try { ctrl.error(err); } catch (x) {} } else reject(err);
          });
        }
        post({ type: 'vfs-stream-fetch', id: id, port: t.port, url: t.path, method: (init.method || 'GET').toUpperCase(), headers: headers, body: body });
      });
    });
  }
  var baseFetch = window.fetch;
  window.fetch = function(input, init) {
    var u = typeof input === 'string' ? input : input instanceof URL ? input.href : (input && input.url) || String(input);
    var t = local(u);
    if (!t) return baseFetch.apply(this, arguments);
    t.url = u;
    if (input && typeof input === 'object' && !(input instanceof URL) && input.method) {
      init = Object.assign({ method: input.method, headers: input.headers, signal: input.signal }, init || {});
      if (!init.body && input.method !== 'GET' && input.method !== 'HEAD') return input.arrayBuffer().then(function(b) { init.body = b; return streamFetch(t, init); });
    }
    return streamFetch(t, init);
  };

  // ── XMLHttpRequest (socket.io-client long-polls with it) ──
  var BaseXHR = window.XMLHttpRequest;
  var XHR_EVENTS = ['readystatechange', 'loadstart', 'progress', 'load', 'error', 'abort', 'timeout', 'loadend'];
  function LocalXHR() {
    var x = this;
    x._et = new EventTarget(); x._real = null; x._headers = {}; x._resHeaders = {};
    x.readyState = 0; x.status = 0; x.statusText = ''; x.response = ''; x.responseText = ''; x.responseURL = '';
    x.responseType = ''; x.timeout = 0; x.withCredentials = false; x.upload = new EventTarget();
  }
  LocalXHR.UNSENT = 0; LocalXHR.OPENED = 1; LocalXHR.HEADERS_RECEIVED = 2; LocalXHR.LOADING = 3; LocalXHR.DONE = 4;
  LocalXHR.prototype = {
    constructor: LocalXHR, UNSENT: 0, OPENED: 1, HEADERS_RECEIVED: 2, LOADING: 3, DONE: 4,
    addEventListener: function(t, f, o) { this._et.addEventListener(t, f, o); },
    removeEventListener: function(t, f, o) { this._et.removeEventListener(t, f, o); },
    dispatchEvent: function(e) { return this._et.dispatchEvent(e); },
    _fire: function(t) {
      var e = t === 'readystatechange' ? new Event(t) : new ProgressEvent(t);
      var h = this['on' + t];
      if (typeof h === 'function') h.call(this, e);
      this._et.dispatchEvent(e);
    },
    open: function(method, url) {
      var t = local(url);
      if (!t) {
        // Not ours: a real XHR does it all; its events and state are mirrored here
        var x = this, r = this._real = new BaseXHR();
        XHR_EVENTS.forEach(function(ev) {
          r.addEventListener(ev, function() {
            ['readyState', 'status', 'statusText', 'responseURL'].forEach(function(k) { x[k] = r[k]; });
            if (r.readyState === 4 || ev === 'progress') { try { x.response = r.response; } catch (e) {} try { x.responseText = r.responseText; } catch (e) {} }
            x._fire(ev);
          });
        });
        r.upload = r.upload; this.upload = r.upload;
        return r.open.apply(r, arguments);
      }
      this._t = t; this._method = String(method || 'GET').toUpperCase(); this._url = url;
      this.readyState = 1; this._fire('readystatechange');
    },
    setRequestHeader: function(k, v) { if (this._real) return this._real.setRequestHeader(k, v); this._headers[k] = v; },
    overrideMimeType: function(m) { if (this._real) this._real.overrideMimeType(m); },
    getResponseHeader: function(k) { if (this._real) return this._real.getResponseHeader(k); var v = this._resHeaders[String(k).toLowerCase()]; return v === undefined ? null : v; },
    getAllResponseHeaders: function() { if (this._real) return this._real.getAllResponseHeaders(); var h = this._resHeaders; return Object.keys(h).map(function(k) { return k + ': ' + h[k] + '\\r\\n'; }).join(''); },
    abort: function() {
      if (this._real) return this._real.abort();
      if (this._ac) this._ac.abort();
      if (this.readyState > 0 && this.readyState < 4) { this.readyState = 4; this._fire('readystatechange'); this._fire('abort'); this._fire('loadend'); }
      this.readyState = 0;
    },
    send: function(body) {
      var x = this;
      if (x._real) { ['timeout', 'withCredentials', 'responseType'].forEach(function(k) { try { x._real[k] = x[k]; } catch (e) {} }); return x._real.send(body); }
      x._ac = new AbortController();
      var timer = x.timeout ? setTimeout(function() { x._ac.abort(); x.readyState = 4; x._fire('readystatechange'); x._fire('timeout'); x._fire('loadend'); }, x.timeout) : 0;
      x._fire('loadstart');
      var t = Object.assign({ url: x._url }, x._t);
      streamFetch(t, { method: x._method, headers: x._headers, body: x._method === 'GET' || x._method === 'HEAD' ? null : body, signal: x._ac.signal }).then(function(r) {
        x.status = r.status; x.statusText = r.statusText; x.responseURL = x._url;
        r.headers.forEach(function(v, k) { x._resHeaders[k] = v; });
        x.readyState = 2; x._fire('readystatechange');
        x.readyState = 3; x._fire('readystatechange');
        return r.arrayBuffer();
      }).then(function(buf) {
        clearTimeout(timer);
        var text = '';
        if (x.responseType === '' || x.responseType === 'text' || x.responseType === 'json') text = new TextDecoder().decode(buf);
        if (x.responseType === 'arraybuffer') x.response = buf;
        else if (x.responseType === 'blob') x.response = new Blob([buf], { type: x._resHeaders['content-type'] || '' });
        else if (x.responseType === 'json') { try { x.response = JSON.parse(text); } catch (e) { x.response = null; } }
        else { x.response = text; x.responseText = text; }
        x.readyState = 4; x._fire('readystatechange'); x._fire('progress'); x._fire('load'); x._fire('loadend');
      }, function(err) {
        clearTimeout(timer);
        if (err && err.name === 'AbortError') return;
        x.readyState = 4; x.status = 0; x._fire('readystatechange'); x._fire('error'); x._fire('loadend');
      });
    }
  };
  window.XMLHttpRequest = LocalXHR;

  // ── EventSource ──
  var BaseES = window.EventSource;
  function LocalES(url, opts) {
    var t = local(url);
    if (!t && BaseES) return new BaseES(url, opts);
    var es = this;
    es._et = new EventTarget(); es.url = String(url); es.withCredentials = !!(opts && opts.withCredentials);
    es.readyState = 0; es._retry = 3000; es._last = ''; es._t = t;
    setTimeout(function() { es._connect(); }, 0);
  }
  LocalES.CONNECTING = 0; LocalES.OPEN = 1; LocalES.CLOSED = 2;
  LocalES.prototype = {
    constructor: LocalES, CONNECTING: 0, OPEN: 1, CLOSED: 2,
    addEventListener: function(t, f, o) { this._et.addEventListener(t, f, o); },
    removeEventListener: function(t, f, o) { this._et.removeEventListener(t, f, o); },
    dispatchEvent: function(e) { return this._et.dispatchEvent(e); },
    _fire: function(e) { var h = this['on' + e.type]; if (typeof h === 'function') h.call(this, e); this._et.dispatchEvent(e); },
    close: function() { this.readyState = 2; if (this._ac) this._ac.abort(); clearTimeout(this._timer); },
    _again: function() {
      var es = this;
      if (es.readyState === 2) return;
      es.readyState = 0; es._fire(new Event('error'));
      es._timer = setTimeout(function() { es._connect(); }, es._retry);
    },
    _connect: function() {
      var es = this;
      if (es.readyState === 2) return;
      es._ac = new AbortController();
      var headers = { accept: 'text/event-stream', 'cache-control': 'no-cache' };
      if (es._last) headers['last-event-id'] = es._last;
      streamFetch(Object.assign({ url: es.url }, es._t), { headers: headers, signal: es._ac.signal }).then(function(r) {
        if (es.readyState === 2) return;
        if (r.status !== 200 || !/^text\\/event-stream/i.test(r.headers.get('content-type') || '')) {
          es.readyState = 2; es._fire(new Event('error')); return;
        }
        es.readyState = 1; es._fire(new Event('open'));
        var reader = r.body.getReader(), dec = new TextDecoder(), buf = '', data = [], type = '', id = null;
        function line(l) {
          if (l === '') {
            if (id !== null) es._last = id;
            if (data.length) es._fire(new MessageEvent(type || 'message', { data: data.join('\\n'), lastEventId: es._last, origin: location.origin }));
            data = []; type = ''; id = null; return;
          }
          if (l[0] === ':') return;
          var c = l.indexOf(':'), f = c < 0 ? l : l.slice(0, c), v = c < 0 ? '' : l.slice(c + 1);
          if (v[0] === ' ') v = v.slice(1);
          if (f === 'data') data.push(v);
          else if (f === 'event') type = v;
          else if (f === 'id' && v.indexOf('\\0') < 0) id = v;
          else if (f === 'retry' && /^\\d+$/.test(v)) es._retry = +v;
        }
        (function pump() {
          reader.read().then(function(x) {
            if (x.done) { es._again(); return; }
            buf += dec.decode(x.value, { stream: true });
            var m;
            while ((m = /\\r\\n|\\r|\\n/.exec(buf))) {
              if (m[0] === '\\r' && m.index === buf.length - 1) break; // a \\r\\n split across chunks
              line(buf.slice(0, m.index)); buf = buf.slice(m.index + m[0].length);
            }
            pump();
          }, function() { es._again(); });
        })();
      }, function(err) { if (!err || err.name !== 'AbortError') es._again(); });
    }
  };
  window.EventSource = LocalES;

  // ── WebSocket ──
  var BaseWS = window.WebSocket;
  function LocalWS(url, protocols) {
    var t = local(url);
    if (!t) return protocols === undefined ? new BaseWS(url) : new BaseWS(url, protocols);
    var ws = this;
    ws._et = new EventTarget(); ws.url = String(url); ws.readyState = 0; ws.protocol = ''; ws.extensions = '';
    ws.bufferedAmount = 0; ws.binaryType = 'blob';
    ws._id = P + (++seq); sockets[ws._id] = ws;
    var list = protocols === undefined ? [] : typeof protocols === 'string' ? [protocols] : Array.prototype.slice.call(protocols);
    post({ type: 'vfs-ws-open', id: ws._id, port: t.port, path: t.path, protocols: list });
  }
  LocalWS.CONNECTING = 0; LocalWS.OPEN = 1; LocalWS.CLOSING = 2; LocalWS.CLOSED = 3;
  LocalWS.prototype = {
    constructor: LocalWS, CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3,
    addEventListener: function(t, f, o) { this._et.addEventListener(t, f, o); },
    removeEventListener: function(t, f, o) { this._et.removeEventListener(t, f, o); },
    dispatchEvent: function(e) { return this._et.dispatchEvent(e); },
    _fire: function(e) { var h = this['on' + e.type]; if (typeof h === 'function') h.call(this, e); this._et.dispatchEvent(e); },
    send: function(data) {
      if (this.readyState === 0) throw new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", 'InvalidStateError');
      if (this.readyState !== 1) return;
      var id = this._id;
      if (typeof data === 'string') post({ type: 'vfs-ws-send', id: id, data: data });
      else if (data instanceof Blob) data.arrayBuffer().then(function(b) { post({ type: 'vfs-ws-send', id: id, data: b }, [b]); });
      else {
        var b = data instanceof ArrayBuffer ? data.slice(0) : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        post({ type: 'vfs-ws-send', id: id, data: b }, [b]);
      }
    },
    close: function(code, reason) {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      post({ type: 'vfs-ws-close', id: this._id, code: code, reason: reason });
    },
    _event: function(d) {
      if (d.kind === 'open') { this.readyState = 1; this.protocol = d.protocol || ''; this.extensions = d.extensions || ''; this._fire(new Event('open')); }
      else if (d.kind === 'message') {
        var data = d.data;
        if (typeof data !== 'string' && this.binaryType === 'blob') data = new Blob([data]);
        this._fire(new MessageEvent('message', { data: data, origin: 'ws://localhost:' + PORT }));
      }
      else if (d.kind === 'error') this._fire(new Event('error'));
      else if (d.kind === 'close') {
        delete sockets[this._id];
        this.readyState = 3;
        this._fire(new CloseEvent('close', { code: d.code, reason: d.reason || '', wasClean: !!d.wasClean }));
      }
    }
  };
  window.WebSocket = LocalWS;
})();
</script>`;
}

/** Messages the page posts that the parent answers */
type PageMessage =
  | { type: 'vfs-stream-fetch'; id: string; port: number; url: string; method: string; headers: Record<string, string>; body: string | Uint8Array | null }
  | { type: 'vfs-stream-cancel'; id: string }
  | { type: 'vfs-ws-open'; id: string; port: number; path: string; protocols: string[] }
  | { type: 'vfs-ws-send'; id: string; data: string | ArrayBuffer }
  | { type: 'vfs-ws-close'; id: string; code?: number; reason?: string };

const te = new TextEncoder();

/** The parent side: answers the page's stream and socket messages from `host` (once per window) */
export function installStreamProxy(host: StreamHost, win: Window = window): void {
  const w = win as Window & { __vfsStreamProxy?: boolean };
  if (w.__vfsStreamProxy) return;
  w.__vfsStreamProxy = true;
  const readers = new Map<string, ReadableStreamDefaultReader<Uint8Array>>();
  const sockets = new Map<string, WsClient>();

  win.addEventListener('message', async (event: MessageEvent) => {
    const d = event.data as PageMessage;
    if (!d || typeof d.type !== 'string' || !d.type.startsWith('vfs-')) return;
    const src = event.source as Window | null;
    if (!src) return;
    const reply = (m: any, transfer: Transferable[] = []) => { try { src.postMessage(m, '*', transfer); } catch { /* the page is gone */ } };

    if (d.type === 'vfs-stream-fetch') {
      try {
        const r = await host.fetch(d.port, d.url, { method: d.method, headers: d.headers, body: d.body });
        reply({ type: 'vfs-stream-head', id: d.id, status: r.status ?? 200, statusText: r.statusText ?? '', headers: r.headers ?? {} });
        const body = r.body;
        if (body instanceof ReadableStream) {
          const reader = (body as ReadableStream<Uint8Array>).getReader();
          readers.set(d.id, reader);
          try {
            for (let x = await reader.read(); !x.done; x = await reader.read()) {
              const chunk = x.value.slice().buffer;
              reply({ type: 'vfs-stream-chunk', id: d.id, chunk }, [chunk]);
            }
            reply({ type: 'vfs-stream-end', id: d.id });
          } catch (e: any) {
            reply({ type: 'vfs-stream-error', id: d.id, message: String(e?.message ?? e) });
          } finally {
            readers.delete(d.id);
          }
          return;
        }
        const bytes = body == null ? new Uint8Array(0) : typeof body === 'string' ? te.encode(body)
          : body instanceof Uint8Array ? body.slice() : te.encode(JSON.stringify(body));
        if (bytes.length) reply({ type: 'vfs-stream-chunk', id: d.id, chunk: bytes.buffer }, [bytes.buffer]);
        reply({ type: 'vfs-stream-end', id: d.id });
      } catch (e: any) {
        reply({ type: 'vfs-stream-error', id: d.id, message: String(e?.message ?? e) });
      }
      return;
    }
    if (d.type === 'vfs-stream-cancel') {
      readers.get(d.id)?.cancel().catch(() => {});
      readers.delete(d.id);
      return;
    }
    if (d.type === 'vfs-ws-open') {
      const ev = (m: any, transfer?: Transferable[]) => reply({ type: 'vfs-ws-event', id: d.id, ...m }, transfer);
      let conn: ByteChannel;
      try {
        conn = host.connect(d.port);
      } catch {
        ev({ kind: 'error' });
        ev({ kind: 'close', code: 1006, reason: '', wasClean: false });
        return;
      }
      let closed = false;
      const client = new WsClient(conn, {
        open: (protocol, extensions) => ev({ kind: 'open', protocol, extensions }),
        message: (data) => (typeof data === 'string' ? ev({ kind: 'message', data }) : ev({ kind: 'message', data }, [data])),
        close: (code, reason, wasClean) => { if (closed) return; closed = true; sockets.delete(d.id); ev({ kind: 'close', code, reason, wasClean }); },
        error: () => ev({ kind: 'error' }),
      });
      sockets.set(d.id, client);
      const url = new URL(`ws://localhost:${d.port}${d.path.startsWith('/') ? d.path : '/' + d.path}`);
      client.run(url, [['Origin', `http://localhost:${d.port}`]], d.protocols ?? []).catch(() => {
        // The handshake failed (no upgrade handler, a refused subprotocol)
        conn.close();
        if (closed) return;
        closed = true;
        sockets.delete(d.id);
        ev({ kind: 'error' });
        ev({ kind: 'close', code: 1006, reason: '', wasClean: false });
      });
      return;
    }
    if (d.type === 'vfs-ws-send') {
      void sockets.get(d.id)?.send(d.data);
      return;
    }
    if (d.type === 'vfs-ws-close') {
      void sockets.get(d.id)?.close(d.code ?? 1000, d.reason ?? '');
    }
  });
}
