/**
 * Previews of in-tab servers as real documents: an iframe at
 * /__preview/<page>/<port>/<path>, whose every request public/preview-sw.js
 * (a service worker scoped to /__preview/) hands to this page, which asks the
 * server on <port> (iframeServer.fetch).
 *
 * A srcdoc preview (iframe-server.ts) loads each resource by postMessage, so a
 * page's ES modules can't import one another by URL: vite's dev server
 * (`/@vite/client`, `/node_modules/.vite/deps/react.js`, hot updates as
 * `import('/src/App.jsx?t=…')`) needs the browser's own module loader, which
 * only a service worker can answer. Every request the preview document makes
 * to this origin goes to the server, by path (`/@vite/client` as well as
 * `./x` under the prefix). WebSocket and EventSource, which no service worker
 * sees, go through preview-streams.ts as in a srcdoc preview.
 *
 * <page> tells this tab from another tab of the app: the worker asks every
 * tab, and only the one whose id it is answers.
 */
import { iframeServer } from './iframe-server';
import { previewStreamsScript, installStreamProxy } from './preview-streams';

const PAGE = Math.random().toString(36).slice(2, 10);
const SCOPE = '/__preview/';
let ready: Promise<boolean> | null = null;

/** The URL that shows `path` of the server on `port`, or null where service workers aren't available (srcdoc then) */
export async function previewUrl(port: number, path = '/'): Promise<string | null> {
  ready ??= start();
  if (!await ready) return null;
  return `${SCOPE}${PAGE}/${port}${path.startsWith('/') ? path : '/' + path}`;
}

async function start(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker || location.protocol === 'file:') return false;
    const sw = navigator.serviceWorker;
    sw.addEventListener('message', onMessage);
    sw.startMessages();
    installStreamProxy(iframeServer);
    const reg = await sw.register('/preview-sw.js', { scope: SCOPE });
    // (navigator.serviceWorker.ready waits for one that controls this page, which this one never does)
    const w = reg.active ?? reg.waiting ?? reg.installing;
    if (!w) return false;
    if (w.state !== 'activated') {
      // (the listener goes once settled: the worker object lives as long as the
      // page, and the timer may be a node script's, which kept the script)
      await new Promise<void>((resolve, reject) => {
        const done = (err?: Error) => { clearTimeout(t); w.removeEventListener('statechange', onState); if (err) reject(err); else resolve(); };
        const onState = () => {
          if (w.state === 'activated') done();
          if (w.state === 'redundant') done(new Error('preview service worker failed'));
        };
        const t = setTimeout(() => done(new Error('preview service worker did not activate')), 10_000);
        w.addEventListener('statechange', onState);
      });
    }
    return true;
  } catch (e) {
    console.warn('[preview] service worker unavailable, previews use srcdoc:', e);
    return false;
  }
}

interface PreviewFetch {
  type: 'tc-preview-fetch'; page: string; port: number; path: string; method: string;
  headers: Record<string, string>; body: ArrayBuffer | null; navigate: boolean;
}

async function onMessage(e: MessageEvent) {
  const d = e.data as PreviewFetch;
  if (d?.type !== 'tc-preview-fetch' || d.page !== PAGE) return;
  const reply = e.ports[0];
  if (!reply) return;
  try {
    const r = await iframeServer.fetch(d.port, d.path, {
      method: d.method,
      headers: d.headers,
      body: d.body ? (new Uint8Array(d.body) as any) : null,
    });
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.headers ?? {})) headers[k.toLowerCase()] = String(v);
    if (r.contentType && !headers['content-type']) headers['content-type'] = r.contentType;
    let body: ArrayBuffer | ReadableStream<Uint8Array> | null;
    if (r.body instanceof ReadableStream) body = r.body as ReadableStream<Uint8Array>;
    else if (r.body instanceof Uint8Array) body = r.body.slice().buffer;
    else if (typeof r.body === 'string') body = new TextEncoder().encode(r.body).buffer;
    else if (r.body != null) {
      body = new TextEncoder().encode(JSON.stringify(r.body)).buffer;
      headers['content-type'] ??= 'application/json';
    } else body = null;

    // A document gets the WebSocket/EventSource bridge before its own scripts
    if (d.navigate && /^text\/html/i.test(headers['content-type'] ?? 'text/html') && body) {
      const html = body instanceof ReadableStream ? await new Response(body).text() : new TextDecoder().decode(body);
      const script = previewStreamsScript(d.port, `${SCOPE}${PAGE}/${d.port}`);
      const at = html.search(/<head[^>]*>/i);
      const out = at >= 0 ? html.replace(/<head[^>]*>/i, (m) => m + script) : script + html;
      body = new TextEncoder().encode(out).buffer;
      delete headers['content-length'];
    }
    const status = r.status ?? 200;
    const msg = { status: status < 200 ? 200 : status, statusText: r.statusText ?? '', headers, body };
    if (body instanceof ReadableStream) {
      // Streamed (server-sent events, a flushed head) where streams transfer; else whole
      try { reply.postMessage(msg, [body as unknown as Transferable]); return; } catch { /* not transferable here */ }
      msg.body = await new Response(body).arrayBuffer();
    }
    reply.postMessage(msg, msg.body instanceof ArrayBuffer ? [msg.body] : []);
  } catch (err) {
    reply.postMessage({ status: 502, statusText: 'Bad Gateway', headers: { 'content-type': 'text/plain' }, body: new TextEncoder().encode(String(err)).buffer });
  }
}
