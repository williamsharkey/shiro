// The service worker of every browse origin (served as /__tc/sw.js; see
// docs/BROWSER.md "Moving parts"). It owns nothing: each request goes over a
// MessagePort to the Browser app's broker, which the app bound to the document
// that made it (its tab, real origin and cookie partition).
//
// Navigations take one extra local hop so that context is never guessed from
// the request: the SW answers a navigation with a tiny shell document; the
// shell asks the app for a port (the app sees exactly which tab and frame it
// is), the broker fetches through that port, and the shell replaces itself
// with `?__tc_nav=<token>`, which the SW answers from the stored response.
import { OriginMap, templateFromBrowseOrigin } from './origin-map';
import type { BrokerReply, FetchMsg } from './protocol';

const sw = self as any;
const APPS = new URL(sw.location.href).searchParams.get('apps') || '';
const template = templateFromBrowseOrigin(sw.location.origin);
const map = template ? new OriginMap(template) : null;
const NAV = '__tc_nav';

interface PortState { port: MessagePort; next: number; pending: Map<number, (r: BrokerReply) => void> }
const ports = new Map<string, PortState>();     // clientId → its document's port
const portWaiters = new Map<string, ((p: PortState | null) => void)[]>();
let lastPort: PortState | null = null;

interface Stored { reply: BrokerReply; port: PortState; at: number }
const pendingNav = new Map<string, { req: Omit<FetchMsg, 'id' | 'type'>; at: number }>();
const readyNav = new Map<string, Stored>();

function wrapPort(port: MessagePort): PortState {
  const st: PortState = { port, next: 1, pending: new Map() };
  port.onmessage = (e: MessageEvent) => {
    const r = e.data as BrokerReply;
    const cb = st.pending.get(r?.id);
    if (cb) { st.pending.delete(r.id); cb(r); }
  };
  port.start?.();
  return st;
}

function rpc(st: PortState, msg: Omit<FetchMsg, 'id' | 'type'>, transfer: Transferable[] = []): Promise<BrokerReply> {
  const id = st.next++;
  return new Promise((resolve) => {
    st.pending.set(id, resolve);
    st.port.postMessage({ ...msg, type: 'fetch', id }, transfer);
  });
}

function setPort(clientId: string, st: PortState) {
  ports.set(clientId, st);
  lastPort = st;
  for (const w of portWaiters.get(clientId) ?? []) w(st);
  portWaiters.delete(clientId);
}

sw.addEventListener('install', () => sw.skipWaiting());
sw.addEventListener('activate', (e: any) => e.waitUntil(sw.clients.claim()));

sw.addEventListener('message', (e: any) => {
  const d = e.data;
  const src = e.source;
  if (!d || typeof d !== 'object' || !src) return;
  if (d.tc === 'port' && e.ports?.[0]) setPort(src.id, wrapPort(e.ports[0]));
  else if (d.tc === 'nav' && e.ports?.[0]) void runNavigation(String(d.token), wrapPort(e.ports[0]), src);
});

/** The shell asked to perform navigation `token` through the port the app gave it. */
async function runNavigation(token: string, st: PortState, client: any) {
  const p = pendingNav.get(token);
  pendingNav.delete(token);
  if (!p) { client.postMessage({ tc: 'nav-retry' }); return; }
  lastPort = st;
  const reply = await rpc(st, p.req);
  if (reply.type === 'redirect') {
    const target = map!.toBrowse(reply.location);
    client.postMessage(target ? { tc: 'nav-go', url: target } : { tc: 'nav-unproxyable', url: reply.location });
    return;
  }
  if (reply.type === 'error') { client.postMessage({ tc: 'nav-error', message: reply.message, fallback: reply.fallback }); return; }
  readyNav.set(token, { reply, port: st, at: Date.now() });
  const u = new URL(map!.toBrowse(p.req.url) ?? p.req.url);
  u.searchParams.set(NAV, token);
  client.postMessage({ tc: 'nav-go', url: u.href });
}

function headersOf(req: Request): [string, string][] {
  const out: [string, string][] = [];
  req.headers.forEach((v, k) => out.push([k, v]));
  return out;
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);
function toResponse(r: BrokerReply): Response {
  if (r.type === 'error') return Response.error();
  if (r.type === 'redirect') return Response.redirect(map!.toBrowse(r.location) ?? r.location, 302);
  const status = r.status >= 200 && r.status <= 599 ? r.status : 502;
  return new Response(NULL_BODY.has(status) ? null : (r.body as BodyInit | null), { status, statusText: r.statusText, headers: r.headers });
}

/** What a document inside the cross-origin isolated desktop needs to be allowed to load. */
const DOC_HEADERS = { 'cross-origin-embedder-policy': 'credentialless', 'cross-origin-resource-policy': 'cross-origin', 'origin-agent-cluster': '?1' };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
function shell(token: string): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title></title>`
    + `<script src="/__tc/boot.js" data-apps="${esc(APPS)}" data-token="${esc(token)}"></script></head><body></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...DOC_HEADERS } });
}

function token(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Wait for a document's port (it asks the app on startup); ask it again after a SW restart. */
async function portFor(clientId: string): Promise<PortState | null> {
  const have = ports.get(clientId);
  if (have) return have;
  const client = clientId ? await sw.clients.get(clientId) : null;
  if (client && client.type === 'window') client.postMessage({ tc: 'need-port' });
  const got = await new Promise<PortState | null>((resolve) => {
    const list = portWaiters.get(clientId) ?? [];
    list.push(resolve);
    portWaiters.set(clientId, list);
    setTimeout(() => resolve(null), client ? 8000 : 0);
  });
  // Workers and documents that never said hello: any port of this origin will do
  return got ?? lastPort;
}

function sweep() {
  const old = Date.now() - 60_000;
  for (const [k, v] of pendingNav) if (v.at < old) pendingNav.delete(k);
  for (const [k, v] of readyNav) if (v.at < old) readyNav.delete(k);
}

async function requestMsg(req: Request, url: string, navigation: boolean): Promise<Omit<FetchMsg, 'id' | 'type'>> {
  const body = req.method === 'GET' || req.method === 'HEAD' ? null : await req.arrayBuffer();
  return {
    url, method: req.method, headers: headersOf(req), body,
    mode: req.mode, destination: req.destination, credentials: req.credentials, redirect: req.redirect,
    referrer: req.referrer ? map!.toReal(req.referrer) : '', referrerPolicy: req.referrerPolicy, navigation,
  };
}

sw.addEventListener('fetch', (e: any) => {
  const req: Request = e.request;
  const url = new URL(req.url);
  if (url.origin === sw.location.origin && url.pathname.startsWith('/__tc/')) return; // the server's own files
  if (!map) return;
  if (!/^https?:$/.test(url.protocol)) return;
  e.respondWith((async () => {
    sweep();
    if (req.mode === 'navigate') {
      const t = url.searchParams.get(NAV);
      const stored = t ? readyNav.get(t) : undefined;
      if (t && stored) {
        readyNav.delete(t);
        if (e.resultingClientId) setPort(e.resultingClientId, stored.port);
        return toResponse(stored.reply);
      }
      if (t) url.searchParams.delete(NAV); // stale token (reload, back): fetch again
      const real = map.toReal(url.href);
      const tok = token();
      pendingNav.set(tok, { req: await requestMsg(req, real, true), at: Date.now() });
      return shell(tok);
    }
    const st = await portFor(e.clientId);
    if (!st) return new Response('Browser app: no connection to the app', { status: 503 });
    const msg = await requestMsg(req, map.toReal(url.href), false);
    return toResponse(await rpc(st, msg, msg.body ? [msg.body] : []));
  })());
});
