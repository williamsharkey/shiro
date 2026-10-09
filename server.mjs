/**
 * Shiro unified server — static files + API proxy + OAuth callback + WebSocket relay
 * + opt-in WebSocket-to-TCP relay for kernel sockets (SHIRO_TCP_RELAY=1, see docs/NETWORKING.md).
 * Single Node.js process; depends on `ws` (and optionally `undici`).
 */

import { createServer } from 'node:http';
import { readFile, writeFile, stat, readdir, unlink, mkdir, rename } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { WebSocketServer } from 'ws';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import net from 'node:net';
import dns from 'node:dns/promises';

const PORT = process.env.PORT || 3000;
const STATIC_DIR = process.env.STATIC_DIR || '/opt/shiro/public';

// --- Cross-origin isolation ---
// COOP same-origin + COEP credentialless make the app page crossOriginIsolated,
// which turns on SharedArrayBuffer and Atomics.wait (needed for blocking
// syscalls from worker processes; see docs/UNIX_COMPAT.md). credentialless
// (not require-corp) lets no-cors CDN loads (Pyodide, esm.sh, fonts) through
// without CORP headers; they just go out without cookies.
// SHIRO_ISOLATION=0 turns it off.
export function isolationEnabled() {
  return process.env.SHIRO_ISOLATION !== '0';
}

export function isolationHeaders() {
  if (!isolationEnabled()) return {};
  return {
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'credentialless',
  };
}

// --- MIME types ---
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.txt': 'text/plain',
  '.map': 'application/json', '.mjs': 'application/javascript',
};

// --- API proxy ---
// Node's built-in fetch gives up if response headers take over 5 minutes. A
// non-streaming model call only sends headers when the whole reply is done, so
// long ones died at exactly 5:00 ("fetch failed") and Claude Code sat waiting.
// undici (installed next to server.mjs on the host) lets the proxy wait as long
// as the client does; without it we fall back to the built-in fetch.
let upstreamFetch = fetch;
try {
  const { Agent, fetch: undiciFetch } = await import('undici');
  const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  upstreamFetch = (url, init) => undiciFetch(url, { ...init, dispatcher });
} catch { console.warn('[proxy] undici not installed; upstream calls time out after 5 minutes'); }

const PROXY_TARGETS = {
  'anthropic': 'https://api.anthropic.com',
  'platform': 'https://platform.claude.com',
  'mcp-proxy': 'https://mcp-proxy.anthropic.com',
  'github': 'https://api.github.com',
  // GitHub's OAuth device flow lives on github.com, which has no CORS
  'github-login': 'https://github.com',
};

// Only these paths may be proxied per target (targets not listed are unrestricted)
const PROXY_ALLOWED_PATHS = {
  'github-login': ['/login/device/code', '/login/oauth/access_token'],
};

const SKIP_REQUEST_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'accept-encoding',
  'origin', 'referer', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
  'sec-fetch-user', 'anthropic-dangerous-direct-browser-access',
  'user-agent',  // Browser UA causes API to reject OAuth tokens
]);

// Node fetch auto-decompresses, so strip encoding headers from upstream responses
const SKIP_RESPONSE_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding', 'connection',
]);

// The git proxy also drops WWW-Authenticate: a browser answers it with a native
// login prompt that stalls the request (and later ones to the origin). Git
// clients still see the 401 and supply credentials themselves.
const SKIP_GIT_RESPONSE_HEADERS = new Set([...SKIP_RESPONSE_HEADERS, 'www-authenticate']);

const DEFAULT_CORS_ALLOW_HEADERS = [
  'Content-Type',
  'Authorization',
  'x-api-key',
  'anthropic-version',
  'anthropic-beta',
  'anthropic-dangerous-direct-browser-access',
  'x-app',
  'x-stainless-arch',
  'x-stainless-lang',
  'x-stainless-os',
  'x-stainless-package-version',
  'x-stainless-retry-count',
  'x-stainless-runtime',
  'x-stainless-runtime-version',
  'x-stainless-timeout',
  'mcp-session-id',
];

function buildAllowedHeaders(requestHeaders) {
  const requested = String(requestHeaders || '')
    .split(',')
    .map((header) => header.trim())
    .filter(Boolean);
  return Array.from(new Set([...DEFAULT_CORS_ALLOW_HEADERS, ...requested])).join(', ');
}

export function corsHeaders(origin, requestHeaders) {
  return {
    'access-control-allow-origin': origin || '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': buildAllowedHeaders(requestHeaders),
    'access-control-expose-headers': 'x-request-id, request-id, x-oauth-scopes, anthropic-ratelimit-requests-limit, anthropic-ratelimit-requests-remaining, anthropic-ratelimit-tokens-limit, anthropic-ratelimit-tokens-remaining, retry-after, mcp-session-id',
    'access-control-max-age': '86400',
    'vary': 'Origin, Access-Control-Request-Headers',
  };
}

async function handleProxy(req, res, pathAfterApi) {
  const origin = req.headers['origin'];
  const cors = corsHeaders(origin, req.headers['access-control-request-headers']);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }

  // Log all proxy requests for debugging
  console.log(`[proxy] ${req.method} /api/${pathAfterApi}`);

  const slashIdx = pathAfterApi.indexOf('/');
  const target = slashIdx === -1 ? pathAfterApi : pathAfterApi.slice(0, slashIdx);
  const rest = slashIdx === -1 ? '/' : pathAfterApi.slice(slashIdx);
  const base = PROXY_TARGETS[target];

  if (!base) {
    res.writeHead(404, cors);
    return res.end(`Unknown API target: ${target}`);
  }

  const allowed = PROXY_ALLOWED_PATHS[target];
  if (allowed && (!allowed.includes(rest) || req.method !== 'POST')) {
    res.writeHead(403, cors);
    return res.end(`Not allowed: ${req.method} ${target}${rest}`);
  }

  // Collect body
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  // Build upstream headers
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!SKIP_REQUEST_HEADERS.has(k.toLowerCase())) headers[k] = v;
  }
  headers['host'] = new URL(base).host;
  // Replace browser UA with Node.js-like UA to avoid API rejecting OAuth from browsers
  headers['user-agent'] = 'node-fetch/1.0 (+https://github.com/node-fetch/node-fetch)';
  if (body.length) headers['content-length'] = String(body.length);

  try {
    const url = new URL(rest, base);
    // Preserve query string from original request
    const origUrl = new URL(req.url, 'http://localhost');
    url.search = origUrl.search;

    // One line per model call: size, streaming, and time to first byte of headers
    let callInfo = '';
    if (rest.startsWith('/v1/messages') && body.length) {
      try {
        const j = JSON.parse(body.toString());
        callInfo = ` model=${j.model} stream=${!!j.stream} max_tokens=${j.max_tokens} bytes=${body.length}`;
      } catch { /* not JSON */ }
    }
    const t0 = Date.now();
    const upstream = await upstreamFetch(url.toString(), {
      method: req.method,
      headers,
      body: body.length ? body : undefined,
      duplex: 'half',
    });
    if (callInfo) console.log(`[proxy] messages${callInfo} → ${upstream.status} headers in ${Date.now() - t0}ms`);

    const respHeaders = { ...cors };
    // Allow-listed targets are github.com pages: pass only the body's type. Their
    // headers (long CSP, cookies) overflow nginx's proxy buffer (502) and the page
    // has no use for them.
    const passHeader = allowed ? (k) => k.toLowerCase() === 'content-type' : (k) => !SKIP_RESPONSE_HEADERS.has(k.toLowerCase());
    for (const [k, v] of upstream.headers) {
      if (passHeader(k)) respHeaders[k] = v;
    }
    // Stream event-streams straight through. nginx buffers proxied responses by
    // default, so while a model thinks (only tiny keep-alive pings) the browser saw
    // nothing, not even headers, for minutes, then the whole reply at once.
    if ((upstream.headers.get('content-type') || '').includes('text/event-stream')) {
      respHeaders['x-accel-buffering'] = 'no';
      respHeaders['cache-control'] = 'no-cache';
    }

    console.log(`[proxy] ${req.method} /api/${pathAfterApi} → ${upstream.status}`);
    res.writeHead(upstream.status, respHeaders);
    if (upstream.body) {
      const reader = upstream.body.getReader();
      // For model streams, note how each one ends: an `event: error` from the API
      // (overloaded, etc.), an upstream read failure, or the browser going away.
      const isStream = callInfo && (upstream.headers.get('content-type') || '').includes('text/event-stream');
      let bytes = 0, sawStop = false, apiError = '';
      let clientGone = false;
      res.on('close', () => {
        if (!res.writableFinished) clientGone = true;
        // A non-streaming reply only arrives when complete; say whether it reached the browser
        if (callInfo && !isStream) console.log(`[proxy] reply ${res.writableFinished ? 'delivered' : 'NOT delivered (browser went away)'}: ${bytes} bytes, ${Date.now() - t0}ms`);
      });
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (isStream) {
            const text = Buffer.from(value).toString();
            if (text.includes('message_stop')) sawStop = true;
            const m = text.match(/event: error\ndata: (.*)/);
            if (m) apiError = m[1].slice(0, 300);
          }
          if (clientGone) { reader.cancel().catch(() => {}); break; }
          res.write(value);
        }
        res.end();
      };
      pump().then(() => {
        if (isStream && (!sawStop || apiError || clientGone)) {
          console.log(`[proxy] stream ended early: ${bytes} bytes in ${Date.now() - t0}ms` +
            `${apiError ? ` api error: ${apiError}` : ''}${clientGone ? ' (browser closed it)' : ''}` +
            `${!sawStop && !apiError && !clientGone ? ' (no message_stop from upstream)' : ''}`);
        }
      }, (err) => {
        if (isStream) console.log(`[proxy] stream read failed after ${bytes} bytes in ${Date.now() - t0}ms: ${err?.message || err} ${err?.cause?.code || ''}`);
        res.end();
      });
    } else {
      res.end();
    }
  } catch (err) {
    console.error(`Proxy error [${req.method} ${req.url}]:`, err.message || err, err.cause?.code || err.cause?.message || '');
    res.writeHead(502, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// --- OAuth callback ---
function handleOAuthCallback(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const params = Object.fromEntries(url.searchParams.entries());

  const html = `<!DOCTYPE html>
<html><head><title>OAuth Callback - Shiro</title></head>
<body><p>Authenticating...</p>
<script>
(function() {
  var params = ${JSON.stringify(params)};
  var msg = {
    type: 'shiro-oauth-callback',
    code: params.code || '', state: params.state || '',
    port: params.port || '', params: params
  };
  // COOP same-origin on Shiro severs window.opener once the popup has been to
  // the provider's origin, so also post on a same-origin BroadcastChannel.
  var sent = false;
  if (window.opener) {
    try { window.opener.postMessage(msg, window.location.origin); sent = true; } catch (e) {}
  }
  if (!sent && typeof BroadcastChannel !== 'undefined') {
    var bc = new BroadcastChannel('shiro-oauth-callback');
    bc.postMessage(msg);
    bc.close();
    sent = true;
  }
  if (sent) {
    document.body.innerHTML = '<p>Authentication complete. You can close this window.</p>';
    setTimeout(function() { window.close(); }, 1000);
  } else {
    document.body.innerHTML = '<p>Error: Could not communicate with Shiro.</p>';
  }
})();
</script></body></html>`;

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...isolationHeaders() });
  res.end(html);
}

// --- Static file server ---
async function handleStatic(req, res) {
  let pathname = new URL(req.url, 'http://localhost').pathname;
  let filePath = join(STATIC_DIR, pathname);
  const requestExt = extname(pathname);
  const staticHeaders = {
    'access-control-allow-origin': '*',
    'cross-origin-resource-policy': 'cross-origin',
  };

  try {
    const s = await stat(filePath);
    if (s.isDirectory()) filePath = join(filePath, 'index.html');
  } catch {
    if (pathname.startsWith('/assets/') || requestExt) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...staticHeaders });
      return res.end('Not found');
    }
    // Try .html extension (e.g. /about → about.html)
    try {
      await stat(filePath + '.html');
      filePath = filePath + '.html';
    } catch {
      // Fall through to index.html for SPA routing
      filePath = join(STATIC_DIR, 'index.html');
    }
  }

  try {
    const data = await readFile(filePath);
    const ext = extname(filePath);
    // Isolation headers go on the app shell (index.html, also the SPA fallback for
    // /s/:id) and on scripts, which a same-origin Worker needs to start inside an
    // isolated page. The public/*.html docs pages stay unisolated: they embed
    // the app in iframes and need nothing from SharedArrayBuffer.
    const isAppShell = filePath === join(STATIC_DIR, 'index.html');
    const isolation = isAppShell || ext === '.js' || ext === '.mjs' ? isolationHeaders() : {};
    // The streamed Debian rootfs's chunks are content-addressed (named by sha256)
    const immutable = pathname.startsWith('/debian/chunks/') ? { 'cache-control': 'public, max-age=31536000, immutable' } : {};
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', ...staticHeaders, ...isolation, ...immutable });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...staticHeaders });
    res.end('Not found');
  }
}

// --- Debian package mirror (docs/DEBIAN.md "Package mirror") ---
// apt inside the page fetches http://HOST/PATH as /debian/mirror/HOST/PATH
// (src/debian/apt-method.ts), so it needs no TCP relay. Only the hosts in
// SHIRO_DEBIAN_MIRRORS are served ("host=https://upstream,host2=..."; by
// default deb.debian.org and security.debian.org from their own CDNs), and
// only archive paths (dists/, pool/). apt verifies everything against the
// signed InRelease, so the mirror needs no trust. Files under pool/ and
// by-hash/ are immutable and kept in SHIRO_DEBIAN_CACHE (when set) forever;
// other index files for SHIRO_DEBIAN_INDEX_TTL seconds (default 600).
function debianMirrorConfig() {
  const upstreams = new Map([['deb.debian.org', 'https://deb.debian.org'], ['security.debian.org', 'https://security.debian.org']]);
  if (process.env.SHIRO_DEBIAN_MIRRORS) {
    upstreams.clear();
    for (const part of process.env.SHIRO_DEBIAN_MIRRORS.split(',')) {
      const i = part.indexOf('=');
      if (i > 0) upstreams.set(part.slice(0, i).trim(), part.slice(i + 1).trim().replace(/\/+$/, ''));
    }
  }
  return {
    upstreams,
    cacheDir: process.env.SHIRO_DEBIAN_CACHE || '',
    indexTtl: Number(process.env.SHIRO_DEBIAN_INDEX_TTL || 600) * 1000,
  };
}
const DEBIAN_MIRROR = debianMirrorConfig();
const DEBIAN_PATH = /^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._+~%-]+)*\/(?:dists|pool)\/[A-Za-z0-9._+~%/-]+$/;
const debianInflight = new Map();

async function debianFetch(upstreamUrl, cacheFile, immutable) {
  if (cacheFile) {
    try {
      const st = await stat(cacheFile);
      if (immutable || Date.now() - st.mtimeMs < DEBIAN_MIRROR.indexTtl) {
        return { status: 200, body: await readFile(cacheFile), lastModified: await readFile(cacheFile + '.lm', 'utf8').catch(() => '') };
      }
    } catch { /* not cached */ }
  }
  let r;
  try {
    r = await fetch(upstreamUrl, { redirect: 'follow' });
  } catch (e) {
    // Upstream down: a stale index beats none
    if (cacheFile) {
      try { return { status: 200, body: await readFile(cacheFile), lastModified: '' }; } catch {}
    }
    return { status: 502, body: Buffer.from(`upstream: ${e.message}\n`) };
  }
  if (!r.ok) return { status: r.status, body: Buffer.from(`upstream: ${r.status} ${r.statusText}\n`) };
  const body = Buffer.from(await r.arrayBuffer());
  const lastModified = r.headers.get('last-modified') || '';
  if (cacheFile) {
    try {
      await mkdir(cacheFile.slice(0, cacheFile.lastIndexOf('/')), { recursive: true });
      const tmp = `${cacheFile}.${process.pid}.${randomBytes(4).toString('hex')}`;
      await writeFile(tmp, body);
      await writeFile(cacheFile + '.lm', lastModified);
      await rename(tmp, cacheFile);
    } catch (e) { console.warn('[debian-mirror] cache write failed:', e.message); }
  }
  return { status: 200, body, lastModified };
}

async function handleDebianMirror(req, res, rest) {
  const slash = rest.indexOf('/');
  const host = slash > 0 ? rest.slice(0, slash) : '';
  const path = slash > 0 ? rest.slice(slash) : '';
  const upstream = DEBIAN_MIRROR.upstreams.get(host);
  if (!upstream || !DEBIAN_PATH.test(path) || path.includes('..') || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('not a mirrored Debian archive path\n');
  }
  const immutable = path.includes('/pool/') || path.includes('/by-hash/');
  const cacheFile = DEBIAN_MIRROR.cacheDir ? join(DEBIAN_MIRROR.cacheDir, host, path) : '';
  const key = upstream + path;
  let p = debianInflight.get(key);
  if (!p) {
    p = debianFetch(upstream + path, cacheFile, immutable).finally(() => debianInflight.delete(key));
    debianInflight.set(key, p);
  }
  const r = await p;
  const headers = {
    'content-type': r.status === 200 ? 'application/octet-stream' : 'text/plain; charset=utf-8',
    'cache-control': r.status === 200 && immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'cross-origin-resource-policy': 'same-origin',
  };
  if (r.lastModified) headers['last-modified'] = r.lastModified;
  const ims = req.headers['if-modified-since'];
  if (r.status === 200 && ims && r.lastModified && Date.parse(ims) >= Date.parse(r.lastModified)) {
    res.writeHead(304, headers);
    return res.end();
  }
  headers['content-length'] = r.body.length;
  res.writeHead(r.status, headers);
  res.end(req.method === 'HEAD' ? undefined : r.body);
}

// --- WebRTC signaling ---
const offers = new Map(); // code -> { offer, candidates, answer, answerCandidates, created }
const OFFER_TTL = 5 * 60 * 1000; // 5 minutes

// Prune expired offers every minute
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of offers) {
    if (now - entry.created > OFFER_TTL) offers.delete(code);
  }
}, 60_000).unref();

async function handleSignaling(req, res, pathname) {
  const origin = req.headers['origin'];
  const cors = corsHeaders(origin, req.headers['access-control-request-headers']);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }

  // POST /offer — register a new offer
  if (pathname === '/offer' && req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks).toString());

    if (!data.code || !data.offer) {
      res.writeHead(400, { 'content-type': 'application/json', ...cors });
      return res.end(JSON.stringify({ error: 'Missing code or offer' }));
    }

    console.log(`[signal] offer registered: ${data.code} (${offers.has(data.code) ? 'refresh' : 'new'})`);
    offers.set(data.code, {
      offer: data.offer,
      candidates: data.candidates || [],
      answer: null,
      answerCandidates: null,
      created: Date.now(),
    });

    res.writeHead(200, { 'content-type': 'application/json', ...cors });
    return res.end(JSON.stringify({ ok: true }));
  }

  // GET /offer/:code — retrieve an offer (for MCP client connecting)
  const offerMatch = pathname.match(/^\/offer\/(.+)$/);
  if (offerMatch && req.method === 'GET') {
    const entry = offers.get(offerMatch[1]);
    if (!entry) {
      console.log(`[signal] offer lookup miss: ${offerMatch[1]} (known: ${[...offers.keys()].join(', ') || 'none'})`);
      res.writeHead(404, { 'content-type': 'application/json', ...cors });
      return res.end(JSON.stringify({ error: 'Not found' }));
    }
    res.writeHead(200, { 'content-type': 'application/json', ...cors });
    return res.end(JSON.stringify({ offer: entry.offer, candidates: entry.candidates }));
  }

  // /answer/:code
  const answerMatch = pathname.match(/^\/answer\/(.+)$/);
  if (answerMatch) {
    const code = answerMatch[1];

    // POST /answer/:code — store an answer
    if (req.method === 'POST') {
      const entry = offers.get(code);
      if (!entry) {
        res.writeHead(404, { 'content-type': 'application/json', ...cors });
        return res.end(JSON.stringify({ error: 'Not found' }));
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const data = JSON.parse(Buffer.concat(chunks).toString());
      entry.answer = data.answer;
      entry.answerCandidates = data.candidates || [];

      res.writeHead(200, { 'content-type': 'application/json', ...cors });
      return res.end(JSON.stringify({ ok: true }));
    }

    // GET /answer/:code — poll for answer
    if (req.method === 'GET') {
      const entry = offers.get(code);
      if (!entry) {
        res.writeHead(200, { 'content-type': 'application/json', ...cors });
        return res.end(JSON.stringify({ expired: true }));
      }
      if (entry.answer) {
        res.writeHead(200, { 'content-type': 'application/json', ...cors });
        return res.end(JSON.stringify({ answer: entry.answer, candidates: entry.answerCandidates }));
      }
      res.writeHead(200, { 'content-type': 'application/json', ...cors });
      return res.end(JSON.stringify({ waiting: true }));
    }
  }

  res.writeHead(404, { 'content-type': 'application/json', ...cors });
  return res.end(JSON.stringify({ error: 'Unknown signaling endpoint' }));
}

// --- Git CORS proxy (for isomorphic-git clone) ---
async function handleGitProxy(req, res, targetUrl) {
  const origin = req.headers['origin'];
  const cors = corsHeaders(origin, req.headers['access-control-request-headers']);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }

  // Collect body
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  // Forward headers (strip browser-specific ones)
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!SKIP_REQUEST_HEADERS.has(k.toLowerCase())) headers[k] = v;
  }
  headers['host'] = new URL(targetUrl).host;
  if (body.length) headers['content-length'] = String(body.length);

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: body.length ? body : undefined,
      duplex: 'half',
    });

    const respHeaders = { ...cors };
    for (const [k, v] of upstream.headers) {
      if (!SKIP_GIT_RESPONSE_HEADERS.has(k.toLowerCase())) respHeaders[k] = v;
    }

    res.writeHead(upstream.status, respHeaders);
    if (upstream.body) {
      const reader = upstream.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      };
      pump().catch(() => res.end());
    } else {
      res.end();
    }
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// --- Seed sharing ---
const SEED_DIR = process.env.SEED_DIR || '/opt/shiro/seeds';
const SEED_MAX_SIZE = 512 * 1024; // 512KB max per seed (gzipped)
const SEED_RATE_LIMIT = 200; // per IP per month

// In-memory rate limit tracker: ip -> { count, resetAt }
const seedRates = new Map();

// Ensure seed directory exists
mkdir(SEED_DIR, { recursive: true }).catch(() => {});

function checkSeedRateLimit(ip) {
  const now = Date.now();
  let entry = seedRates.get(ip);
  if (!entry || now > entry.resetAt) {
    // Reset monthly
    entry = { count: 0, resetAt: now + 30 * 24 * 60 * 60 * 1000 };
    seedRates.set(ip, entry);
  }
  if (entry.count >= SEED_RATE_LIMIT) return false;
  entry.count++;
  return true;
}

async function handleSeedUpload(req, res) {
  const origin = req.headers['origin'];
  const cors = corsHeaders(origin, req.headers['access-control-request-headers']);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  if (!checkSeedRateLimit(ip)) {
    res.writeHead(429, { 'content-type': 'application/json', ...cors });
    return res.end(JSON.stringify({ error: 'Rate limit exceeded (200/month)' }));
  }

  // Collect body (already gzipped from client)
  const chunks = [];
  let totalSize = 0;
  for await (const chunk of req) {
    totalSize += chunk.length;
    if (totalSize > SEED_MAX_SIZE) {
      res.writeHead(413, { 'content-type': 'application/json', ...cors });
      return res.end(JSON.stringify({ error: 'Seed too large (max 512KB)' }));
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);

  // Generate short ID (8 chars, base36)
  const id = randomBytes(5).toString('base36').slice(0, 8).padEnd(8, '0');
  const meta = JSON.stringify({ created: Date.now(), lastVisited: Date.now(), ip, size: body.length });

  try {
    await writeFile(join(SEED_DIR, `${id}.gz`), body);
    await writeFile(join(SEED_DIR, `${id}.meta`), meta);
    console.log(`[seed] Created ${id} (${body.length} bytes) from ${ip}`);
    res.writeHead(200, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify({ id, url: `/s/${id}` }));
  } catch (err) {
    console.error('[seed] Write error:', err.message);
    res.writeHead(500, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify({ error: 'Failed to save seed' }));
  }
}

async function handleSeedDownload(req, res, id) {
  const origin = req.headers['origin'];
  const cors = corsHeaders(origin, req.headers['access-control-request-headers']);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }

  try {
    const data = await readFile(join(SEED_DIR, `${id}.gz`));
    // Update lastVisited
    try {
      const metaPath = join(SEED_DIR, `${id}.meta`);
      const meta = JSON.parse(await readFile(metaPath, 'utf-8'));
      meta.lastVisited = Date.now();
      await writeFile(metaPath, JSON.stringify(meta));
    } catch {}
    res.writeHead(200, { 'content-type': 'application/octet-stream', ...cors });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify({ error: 'Seed not found' }));
  }
}

// Lazy cleanup: delete seeds not visited in 60 days (runs every 6 hours)
setInterval(async () => {
  try {
    const files = await readdir(SEED_DIR);
    const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
    for (const file of files) {
      if (!file.endsWith('.meta')) continue;
      try {
        const meta = JSON.parse(await readFile(join(SEED_DIR, file), 'utf-8'));
        if (meta.lastVisited < cutoff) {
          const id = file.replace('.meta', '');
          await unlink(join(SEED_DIR, `${id}.gz`)).catch(() => {});
          await unlink(join(SEED_DIR, `${id}.meta`)).catch(() => {});
          console.log(`[seed] Cleaned up expired seed: ${id}`);
        }
      } catch {}
    }
  } catch {}
}, 6 * 60 * 60 * 1000).unref();

// --- TCP relay (kernel sockets) ---
// One WebSocket per TCP connection at /tcp. Opt-in with SHIRO_TCP_RELAY=1.
// Protocol (docs/NETWORKING.md): the first frame is text JSON, either
//   {"op":"connect","host":"example.com","port":443}  → {"op":"connected",...} | {"op":"error",...}
//   {"op":"resolve","host":"example.com"}             → {"op":"resolved","addresses":[...]} | {"op":"error",...}
// After "connected", binary frames are the byte stream in both directions and
// text frames are control: client {"op":"shutdown"} (SHUT_WR), {"op":"ack","n":N}
// (bytes consumed, opens the flow-control window); server {"op":"eof"} (peer
// sent FIN) and {"op":"error","code":"E..."}.
//
// Security model: the egress policy is the boundary. Every address a host
// resolves to is checked against the blocked ranges below, the relay connects
// to the checked IP literal (never re-resolving, so DNS rebinding can't swap in
// a private address between check and connect), and only allow-listed ports
// are reachable. On top of that: Origin allow-list, a short-lived HMAC token
// bound to the client IP (issued by POST /tcp/token), per-IP and global
// connection caps, per-IP connect rate, per-IP bandwidth and hourly byte
// budget, per-connection byte cap, handshake/connect/idle/lifetime timeouts,
// and logs that record endpoints and byte counts but never payloads.

const TCP_BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
// Mapped/translated forms (::ffff:0:0/96, NAT64, 6to4, Teredo) embed IPv4
// addresses, so they are blocked outright rather than decoded.
const TCP_BLOCKED_V6 = [
  ['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10],
  ['fec0::', 10], ['ff00::', 8],
];
// Separate lists per family: node's BlockList matches an IPv4 address against
// the IPv6 subnet ::ffff:0:0/96, so one shared list blocked every IPv4 address.
const tcpBuiltinBlockV4 = new net.BlockList();
const tcpBuiltinBlockV6 = new net.BlockList();
for (const [a, p] of TCP_BLOCKED_V4) tcpBuiltinBlockV4.addSubnet(a, p, 'ipv4');
for (const [a, p] of TCP_BLOCKED_V6) tcpBuiltinBlockV6.addSubnet(a, p, 'ipv6');

function cidrBlockList(cidrs) {
  const list = new net.BlockList();
  for (const c of cidrs || []) {
    const [addr, bits] = String(c).trim().split('/');
    const family = net.isIP(addr);
    if (!family) continue;
    const type = family === 6 ? 'ipv6' : 'ipv4';
    list.addSubnet(addr, bits === undefined ? (family === 6 ? 128 : 32) : Number(bits), type);
  }
  return list;
}

/** True if the relay must not connect to `ip` (private, loopback, link-local, metadata, ...). */
export function isBlockedAddress(ip, { allow, deny } = {}) {
  const family = net.isIP(ip);
  if (!family) return true;
  const type = family === 6 ? 'ipv6' : 'ipv4';
  if (allow && allow.check(ip, type)) return false;
  if (deny && deny.check(ip, type)) return true;
  return (family === 6 ? tcpBuiltinBlockV6 : tcpBuiltinBlockV4).check(ip, type);
}

const envList = (v) => (v ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : null);
const envInt = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

// 22 (ssh, git over ssh), 80/443 (http/https, the bulk of guest traffic), 9418
// (git://). SMTP and database ports stay closed by default: an open relay to
// 25 is a spam cannon, and nobody should reach a database through a browser.
export const TCP_DEFAULT_PORTS = [22, 80, 443, 9418];

export function tcpRelayConfigFromEnv(env = process.env) {
  return {
    enabled: env.SHIRO_TCP_RELAY === '1',
    allowedOrigins: envList(env.SHIRO_TCP_ORIGINS) || ['https://shiro.computer', 'https://*.shiro.computer'],
    ports: (envList(env.SHIRO_TCP_PORTS) || TCP_DEFAULT_PORTS).map(Number).filter((p) => p > 0 && p < 65536),
    allowCidrs: envList(env.SHIRO_TCP_ALLOW_CIDRS) || [],
    denyCidrs: envList(env.SHIRO_TCP_DENY_CIDRS) || [],
    secret: env.SHIRO_TCP_SECRET || '',
    trustProxy: env.SHIRO_TRUST_PROXY || 'loopback', // 'loopback' | 'always' | 'never'
    tokenTtlMs: envInt(env.SHIRO_TCP_TOKEN_TTL_MS, 10 * 60_000),
    maxConns: envInt(env.SHIRO_TCP_MAX_CONNS, 512),
    maxConnsPerIp: envInt(env.SHIRO_TCP_MAX_CONNS_PER_IP, 16),
    connectsPerMinute: envInt(env.SHIRO_TCP_CONNECTS_PER_MIN, 60),
    bytesPerSecPerIp: envInt(env.SHIRO_TCP_BYTES_PER_SEC, 4 * 1024 * 1024),
    byteBurstPerIp: envInt(env.SHIRO_TCP_BYTE_BURST, 16 * 1024 * 1024),
    maxBytesPerIpPerHour: envInt(env.SHIRO_TCP_BYTES_PER_HOUR, 4 * 1024 ** 3),
    maxBytesPerConn: envInt(env.SHIRO_TCP_MAX_BYTES_PER_CONN, 1024 ** 3),
    handshakeTimeoutMs: envInt(env.SHIRO_TCP_HANDSHAKE_TIMEOUT_MS, 10_000),
    connectTimeoutMs: envInt(env.SHIRO_TCP_CONNECT_TIMEOUT_MS, 15_000),
    idleTimeoutMs: envInt(env.SHIRO_TCP_IDLE_TIMEOUT_MS, 5 * 60_000),
    maxLifetimeMs: envInt(env.SHIRO_TCP_MAX_LIFETIME_MS, 4 * 60 * 60_000),
    window: envInt(env.SHIRO_TCP_WINDOW, 512 * 1024),
  };
}

function originAllowed(origin, allowed) {
  if (!origin) return false;
  for (const pat of allowed) {
    if (pat === '*' || pat === origin) return true;
    const star = pat.indexOf('://*.');
    if (star !== -1) {
      const scheme = pat.slice(0, star + 3);
      const suffix = pat.slice(star + 4); // ".example.com"
      if (origin.startsWith(scheme) && origin.endsWith(suffix) && !origin.slice(scheme.length, -suffix.length).includes('/')) return true;
    }
  }
  return false;
}

function rejectUpgrade(socket, status, text) {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${text.length}\r\n\r\n${text}`);
  } catch { /* socket already gone */ }
  socket.destroy();
}

const HOSTNAME_RE = /^(?=.{1,253}$)[a-zA-Z0-9_]([a-zA-Z0-9_-]{0,62})(\.[a-zA-Z0-9_]([a-zA-Z0-9_-]{0,62}))*\.?$/;

/**
 * Create the relay. Returns { handleUpgrade(req, socket, head), handleToken(req, res), close(), stats() }.
 * `lookup(host)` → [{address, family}] can be injected (tests); defaults to dns.lookup(all).
 */
export function createTcpRelay(config, { lookup, log = console.log } = {}) {
  const cfg = { ...tcpRelayConfigFromEnv({}), ...config };
  const secret = cfg.secret || randomBytes(32).toString('hex');
  const allow = cidrBlockList(cfg.allowCidrs);
  const deny = cidrBlockList(cfg.denyCidrs);
  const ports = new Set(cfg.ports);
  const resolve = lookup || ((host) => dns.lookup(host, { all: true, verbatim: true }));
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
  const perIp = new Map(); // ip -> { conns, connTokens, connAt, byteTokens, byteAt, hourBytes, hourAt }
  const live = new Set();
  let total = 0;
  let nextId = 1;

  const ipState = (ip) => {
    let st = perIp.get(ip);
    if (!st) {
      const now = Date.now();
      st = { conns: 0, connTokens: cfg.connectsPerMinute, connAt: now, byteTokens: cfg.byteBurstPerIp, byteAt: now, hourBytes: 0, hourAt: now };
      perIp.set(ip, st);
    }
    return st;
  };
  const refill = (st, now = Date.now()) => {
    st.connTokens = Math.min(cfg.connectsPerMinute, st.connTokens + ((now - st.connAt) / 60_000) * cfg.connectsPerMinute);
    st.connAt = now;
    st.byteTokens = Math.min(cfg.byteBurstPerIp, st.byteTokens + ((now - st.byteAt) / 1000) * cfg.bytesPerSecPerIp);
    st.byteAt = now;
    if (now - st.hourAt >= 3_600_000) { st.hourBytes = 0; st.hourAt = now; }
  };
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [ip, st] of perIp) {
      refill(st, now);
      if (st.conns === 0 && st.connTokens >= cfg.connectsPerMinute && st.byteTokens >= cfg.byteBurstPerIp && st.hourBytes === 0) perIp.delete(ip);
    }
  }, 60_000);
  sweep.unref?.();

  const clientIp = (req) => {
    const peer = req.socket.remoteAddress || '';
    const loop = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
    if (cfg.trustProxy === 'always' || (cfg.trustProxy === 'loopback' && loop)) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (xff.length) return xff[xff.length - 1];
    }
    return peer;
  };

  const sign = (exp, ip) => createHmac('sha256', secret).update(`shiro-tcp.${exp}.${ip}`).digest('base64url');
  const issueToken = (ip) => {
    const exp = Date.now() + cfg.tokenTtlMs;
    return { token: `${exp}.${sign(exp, ip)}`, expires: exp };
  };
  const tokenValid = (token, ip) => {
    const m = /^(\d{10,16})\.([A-Za-z0-9_-]{43})$/.exec(String(token || ''));
    if (!m || Number(m[1]) < Date.now()) return false;
    const want = Buffer.from(sign(m[1], ip));
    const got = Buffer.from(m[2]);
    return want.length === got.length && timingSafeEqual(want, got);
  };

  /** POST /tcp/token from an allowed Origin → { token, expires } bound to the caller's IP. */
  function handleToken(req, res) {
    const origin = req.headers['origin'];
    const ok = originAllowed(origin, cfg.allowedOrigins);
    const headers = ok ? { 'access-control-allow-origin': origin, 'vary': 'Origin', 'access-control-allow-methods': 'POST, OPTIONS' } : {};
    if (req.method === 'OPTIONS') { res.writeHead(ok ? 204 : 403, headers); return res.end(); }
    if (req.method !== 'POST' || !ok) {
      res.writeHead(403, { 'content-type': 'text/plain', ...headers });
      return res.end('Forbidden');
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(issueToken(clientIp(req))));
  }

  function handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost');
    const ip = clientIp(req);
    if (!originAllowed(req.headers['origin'], cfg.allowedOrigins)) {
      log(`[tcp] refused ${ip}: origin ${req.headers['origin'] || '(none)'}`);
      return rejectUpgrade(socket, 403, 'Forbidden');
    }
    if (!tokenValid(url.searchParams.get('t'), ip)) {
      log(`[tcp] refused ${ip}: bad or expired token`);
      return rejectUpgrade(socket, 401, 'Unauthorized');
    }
    const st = ipState(ip);
    refill(st);
    if (total >= cfg.maxConns) return rejectUpgrade(socket, 503, 'Relay busy');
    if (st.conns >= cfg.maxConnsPerIp) {
      log(`[tcp] refused ${ip}: ${st.conns} connections open`);
      return rejectUpgrade(socket, 429, 'Too many connections');
    }
    if (st.connTokens < 1) {
      log(`[tcp] refused ${ip}: connect rate`);
      return rejectUpgrade(socket, 429, 'Too many requests');
    }
    st.connTokens -= 1;
    // Reserve the slot now so concurrent handshakes can't overshoot the caps.
    st.conns++; total++;
    let released = false;
    let attached = false;
    const release = () => { if (!released) { released = true; st.conns--; total--; } };
    socket.once('close', () => { if (!attached) release(); });
    wss.handleUpgrade(req, socket, head, (ws) => {
      attached = true;
      onConnection(ws, ip, st, release);
    });
  }

  function onConnection(ws, ip, st, release) {
    const id = nextId++;
    const started = Date.now();
    let phase = 'handshake'; // handshake → connecting → open → closed
    let tcp = null;
    let target = '';
    let up = 0, down = 0;
    let inflight = 0;          // bytes sent to the client and not yet acked
    let tcpWriteBlocked = false;
    let throttledUntil = 0;
    let throttleTimer = null;
    let reason = '';
    live.add(ws);

    const send = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
    const fail = (code, message, wsCode = 1000) => {
      reason ||= code;
      send({ op: 'error', code, message });
      ws.close(wsCode, code);
      tcp?.destroy();
    };

    const handshakeTimer = setTimeout(() => fail('ETIMEDOUT', 'no request'), cfg.handshakeTimeoutMs);
    let idleTimer = null;
    const touch = () => {
      if (!cfg.idleTimeoutMs) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { reason = 'idle'; ws.close(4010, 'idle timeout'); tcp?.destroy(); }, cfg.idleTimeoutMs);
    };
    const lifeTimer = cfg.maxLifetimeMs ? setTimeout(() => { reason = 'lifetime'; ws.close(4011, 'lifetime limit'); tcp?.destroy(); }, cfg.maxLifetimeMs) : null;

    const updateFlow = () => {
      if (!tcp || phase !== 'open') return;
      const throttled = throttledUntil > Date.now();
      if (inflight > cfg.window || throttled) tcp.pause(); else tcp.resume();
      if (tcpWriteBlocked || throttled) ws.pause(); else ws.resume();
      if (throttled && !throttleTimer) {
        throttleTimer = setTimeout(() => { throttleTimer = null; updateFlow(); }, throttledUntil - Date.now());
      }
    };
    // Charge n bytes to the connection and the client IP; false = connection closed for a limit.
    const account = (n) => {
      refill(st);
      st.hourBytes += n;
      st.byteTokens -= n;
      if (up + down > cfg.maxBytesPerConn) { reason = 'byte cap'; fail('EDQUOT', 'per-connection byte limit', 4008); return false; }
      if (st.hourBytes > cfg.maxBytesPerIpPerHour) { reason = 'hourly cap'; fail('EDQUOT', 'hourly byte limit', 4008); return false; }
      if (st.byteTokens < 0) {
        throttledUntil = Date.now() + Math.ceil((-st.byteTokens / cfg.bytesPerSecPerIp) * 1000);
        updateFlow();
      }
      touch();
      return true;
    };

    async function start(req) {
      const host = String(req.host || '').replace(/^\[(.*)\]$/, '$1');
      const family = net.isIP(host);
      if (!family && !HOSTNAME_RE.test(host)) return fail('EINVAL', 'bad host');
      let addrs;
      try {
        addrs = family ? [{ address: host, family }] : await Promise.race([
          resolve(host),
          new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'EAI_AGAIN' })), cfg.connectTimeoutMs).unref?.()),
        ]);
      } catch (err) {
        return fail(err?.code === 'ENOTFOUND' || err?.code === 'ENODATA' ? 'ENOTFOUND' : 'EAI_AGAIN', 'lookup failed');
      }
      if (ws.readyState !== 1) return;
      const usable = addrs.filter((a) => !isBlockedAddress(a.address, { allow, deny }));
      if (req.op === 'resolve') {
        reason = 'resolve';
        log(`[tcp] #${id} ${ip} resolve ${host} → ${usable.length}/${addrs.length} usable`);
        if (!usable.length) return fail(addrs.length ? 'EACCES' : 'ENOTFOUND', addrs.length ? 'only blocked addresses' : 'no addresses');
        send({ op: 'resolved', addresses: usable.map((a) => ({ address: a.address, family: a.family })) });
        return ws.close(1000);
      }
      const port = Number(req.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return fail('EINVAL', 'bad port');
      if (!ports.has(port)) {
        log(`[tcp] #${id} ${ip} refused ${host}:${port}: port not allowed`);
        return fail('EACCES', `port ${port} not allowed by relay policy`);
      }
      if (!usable.length) {
        log(`[tcp] #${id} ${ip} refused ${host}:${port}: ${addrs.length ? 'blocked address' : 'no address'}`);
        return fail(addrs.length ? 'EACCES' : 'ENOTFOUND', addrs.length ? 'address blocked by relay policy' : 'no addresses');
      }
      const { address } = usable[0];
      target = `${host === address ? '' : host + '→'}${address}:${port}`;
      log(`[tcp] #${id} ${ip} connect ${target}`);
      phase = 'connecting';
      // Connect to the vetted IP literal: no second lookup, so no rebinding window.
      // allowHalfOpen: the peer's FIN must not end our side; the client decides with {"op":"shutdown"}
      tcp = net.connect({ host: address, port, timeout: cfg.connectTimeoutMs, allowHalfOpen: true });
      tcp.setNoDelay(true);
      tcp.once('timeout', () => { if (phase === 'connecting') fail('ETIMEDOUT', 'connect timeout'); });
      tcp.once('connect', () => {
        tcp.setTimeout(0);
        if (isBlockedAddress(tcp.remoteAddress, { allow, deny })) return fail('EACCES', 'address blocked by relay policy');
        phase = 'open';
        touch();
        send({ op: 'connected', remoteAddress: tcp.remoteAddress, remotePort: tcp.remotePort, family: net.isIP(tcp.remoteAddress) });
      });
      tcp.on('data', (chunk) => {
        down += chunk.length;
        inflight += chunk.length;
        if (!account(chunk.length)) return;
        ws.send(chunk, { binary: true });
        updateFlow();
      });
      tcp.on('drain', () => { tcpWriteBlocked = false; updateFlow(); });
      tcp.on('end', () => send({ op: 'eof' }));
      tcp.on('error', (err) => { reason ||= err.code || 'error'; send({ op: 'error', code: err.code || 'EIO', message: 'socket error' }); });
      tcp.on('close', () => { if (ws.readyState === 1) ws.close(1000); });
    }

    ws.on('message', (data, isBinary) => {
      if (phase === 'handshake') {
        clearTimeout(handshakeTimer);
        let req;
        try { req = !isBinary && data.length <= 1024 ? JSON.parse(data.toString()) : null; } catch { req = null; }
        if (!req || (req.op !== 'connect' && req.op !== 'resolve')) return fail('EPROTO', 'expected connect or resolve');
        phase = 'resolving';
        start(req).catch(() => fail('EIO', 'relay error'));
        return;
      }
      if (phase !== 'open') return fail('EPROTO', 'data before connected');
      if (isBinary) {
        up += data.length;
        if (!account(data.length)) return;
        if (!tcp.write(data)) { tcpWriteBlocked = true; updateFlow(); }
        return;
      }
      let ctl;
      try { ctl = data.length <= 256 ? JSON.parse(data.toString()) : null; } catch { ctl = null; }
      if (ctl?.op === 'ack' && Number.isFinite(ctl.n) && ctl.n > 0) { inflight = Math.max(0, inflight - ctl.n); updateFlow(); }
      else if (ctl?.op === 'shutdown') tcp.end();
      else fail('EPROTO', 'bad control frame');
    });

    ws.on('close', () => {
      phase = 'closed';
      clearTimeout(handshakeTimer); clearTimeout(idleTimer); clearTimeout(lifeTimer); clearTimeout(throttleTimer);
      tcp?.destroy();
      live.delete(ws);
      release();
      if (target) log(`[tcp] #${id} ${ip} closed ${target} up=${up} down=${down} ms=${Date.now() - started}${reason ? ` reason=${reason}` : ''}`);
    });
    ws.on('error', () => { reason ||= 'ws error'; tcp?.destroy(); });
  }

  return {
    handleUpgrade,
    handleToken,
    issueToken,
    stats: () => ({ connections: total, ips: perIp.size }),
    close() {
      clearInterval(sweep);
      for (const ws of live) ws.terminate();
      wss.close();
    },
  };
}

// --- HTTP server ---
const TCP_RELAY_CONFIG = tcpRelayConfigFromEnv();
const tcpRelay = TCP_RELAY_CONFIG.enabled ? createTcpRelay(TCP_RELAY_CONFIG) : null;

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;

  if (pathname === '/tcp/token' && tcpRelay) {
    return tcpRelay.handleToken(req, res);
  }

  if (pathname.startsWith('/api/')) {
    return handleProxy(req, res, pathname.slice(5));
  }
  // Git CORS proxy: /git-proxy/github.com/... or /git-proxy/https://github.com/...
  // isomorphic-git strips the protocol, sending just "github.com/..." as the path.
  // nginx merge_slashes may also collapse "https://" to "https:/".
  if (pathname.startsWith('/git-proxy/')) {
    let targetUrl = req.url.slice('/git-proxy/'.length);
    // Restore protocol if missing (isomorphic-git strips it)
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://') && !targetUrl.startsWith('https:/')) {
      targetUrl = 'https://' + targetUrl;
    }
    // Fix nginx merge_slashes: https:/ → https://
    targetUrl = targetUrl.replace(/^(https?:\/)([^/])/, '$1/$2');
    return handleGitProxy(req, res, targetUrl);
  }
  if (pathname === '/oauth/callback') {
    return handleOAuthCallback(req, res);
  }
  if (pathname.startsWith('/debian/mirror/')) {
    return handleDebianMirror(req, res, pathname.slice('/debian/mirror/'.length));
  }
  if (pathname === '/health') {
    res.writeHead(200);
    return res.end('ok');
  }
  if (pathname === '/show') {
    res.writeHead(301, { location: '/about' });
    return res.end();
  }
  if (pathname === '/offer' || pathname.startsWith('/offer/') || pathname.startsWith('/answer/')) {
    return handleSignaling(req, res, pathname);
  }
  // Seed sharing: POST /api/seed (upload), GET /api/seed/:id (download raw data)
  if (pathname === '/api/seed' && req.method === 'POST') {
    return handleSeedUpload(req, res);
  }
  const seedApiMatch = pathname.match(/^\/api\/seed\/([a-z0-9]{4,16})$/);
  if (seedApiMatch && req.method === 'GET') {
    return handleSeedDownload(req, res, seedApiMatch[1]);
  }
  // /s/:id falls through to handleStatic which SPA-fallbacks to index.html
  return handleStatic(req, res);
});

// --- WebSocket relay ---
// Upgrades are routed by path here. (ws's own `path` option only matches exact
// strings, so the old regex path rejected every channel handshake with 400.)
const CHANNEL_PATH = /^\/channel\/[a-f0-9]{1,64}$/;
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (CHANNEL_PATH.test(pathname)) {
    return wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }
  if (pathname === '/tcp' && tcpRelay) return tcpRelay.handleUpgrade(req, socket, head);
  rejectUpgrade(socket, 404, 'Not found');
});
const channels = new Map(); // channelId -> Set<WebSocket>
const rates = new WeakMap();

wss.on('connection', (ws, req) => {
  const channelId = new URL(req.url, 'http://localhost').pathname.slice(9); // "/channel/xxx" -> "xxx"
  if (!channels.has(channelId)) channels.set(channelId, new Set());
  const room = channels.get(channelId);
  room.add(ws);

  ws.on('message', (data) => {
    // Rate limit: 10 msgs/sec
    const now = Date.now();
    let r = rates.get(ws);
    if (!r || now > r.resetAt) { r = { count: 0, resetAt: now + 1000 }; rates.set(ws, r); }
    if (++r.count > 10) return;

    const msg = typeof data === 'string' ? data : data.toString();
    if (msg.length > 16384) return;

    for (const peer of room) {
      if (peer !== ws && peer.readyState === 1) {
        try { peer.send(msg); } catch { room.delete(peer); }
      }
    }
  });

  ws.on('close', () => {
    room.delete(ws);
    if (room.size === 0) channels.delete(channelId);
  });
});

const isDirectRun = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  server.listen(PORT, () => {
    console.log(`Shiro server listening on :${PORT}`);
    if (tcpRelay) console.log(`[tcp] relay enabled at /tcp, ports ${TCP_RELAY_CONFIG.ports.join(',')}, origins ${TCP_RELAY_CONFIG.allowedOrigins.join(',')}`);
  });
}
