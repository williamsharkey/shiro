// Previews of in-tab servers (src/preview-sw-host.ts). Scope /__preview/:
// a document at /__preview/<page>/<port>/<path> is <path> of the server on
// <port> in the app tab <page>, and every request that document makes to this
// origin (`/@vite/client`, `./style.css`) goes to that server too. The app tab
// answers: this worker asks each tab, and the one named <page> replies on the
// MessageChannel it is given.
const PREFIX = /^\/__preview\/([\w-]+)\/(\d+)(\/.*)?$/;
/** clientId → { page, port }: the preview document a request comes from (after its history.pushState too) */
const owners = new Map();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  const m = PREFIX.exec(url.pathname);
  if (m) {
    const owner = { page: m[1], port: +m[2] };
    if (e.resultingClientId) owners.set(e.resultingClientId, owner);
    e.respondWith(forward(e.request, owner, (m[3] || '/') + url.search));
    return;
  }
  if (!e.clientId) return;
  e.respondWith((async () => {
    let owner = owners.get(e.clientId);
    if (!owner) {
      const c = await self.clients.get(e.clientId);
      const cm = c && PREFIX.exec(new URL(c.url).pathname);
      if (cm) owners.set(e.clientId, owner = { page: cm[1], port: +cm[2] });
    }
    if (!owner) return fetch(e.request);
    return forward(e.request, owner, url.pathname + url.search);
  })());
});

async function forward(request, owner, path) {
  const method = request.method.toUpperCase();
  const body = method === 'GET' || method === 'HEAD' ? null : await request.arrayBuffer();
  const headers = {};
  request.headers.forEach((v, k) => { headers[k] = v; });
  const tabs = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
    .filter((c) => !PREFIX.test(new URL(c.url).pathname));
  const reply = await new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, 60000);
    for (const tab of tabs) {
      const ch = new MessageChannel();
      ch.port1.onmessage = (m) => { if (!done) { done = true; clearTimeout(timer); resolve(m.data); } };
      tab.postMessage({ type: 'tc-preview-fetch', page: owner.page, port: owner.port, path, method, headers, body, navigate: request.mode === 'navigate' }, [ch.port2]);
    }
    if (!tabs.length) { done = true; clearTimeout(timer); resolve(null); }
  });
  if (!reply) return new Response(`No tab of the app has the server on port ${owner.port} (it was closed or reloaded)`, { status: 502, headers: { 'content-type': 'text/plain' } });
  const h = new Headers();
  for (const [k, v] of Object.entries(reply.headers || {})) { try { h.set(k, v); } catch { /* not a header the Fetch API takes */ } }
  // The app page is cross-origin isolated (server.mjs): its frames need the same policy
  if (request.mode === 'navigate') h.set('cross-origin-embedder-policy', 'credentialless');
  const noBody = method === 'HEAD' || reply.status === 204 || reply.status === 205 || reply.status === 304;
  return new Response(noBody ? null : reply.body, { status: reply.status, statusText: reply.statusText || '', headers: h });
}
