/**
 * Shiro unified server — static files + API proxy + OAuth callback + WebSocket relay.
 * Single Node.js process, no dependencies.
 */

import { createServer } from 'node:http';
import { readFile, writeFile, stat, readdir, unlink, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { WebSocketServer } from 'ws';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const PORT = process.env.PORT || 3000;
const STATIC_DIR = process.env.STATIC_DIR || '/opt/shiro/public';

// --- MIME types ---
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.txt': 'text/plain',
  '.map': 'application/json',
};

// --- API proxy ---
const PROXY_TARGETS = {
  'anthropic': 'https://api.anthropic.com',
  'platform': 'https://platform.claude.com',
  'mcp-proxy': 'https://mcp-proxy.anthropic.com',
  'github': 'https://api.github.com',
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
    'access-control-expose-headers': 'x-request-id, request-id, anthropic-ratelimit-requests-limit, anthropic-ratelimit-requests-remaining, anthropic-ratelimit-tokens-limit, anthropic-ratelimit-tokens-remaining, retry-after, mcp-session-id',
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

    const upstream = await fetch(url.toString(), {
      method: req.method,
      headers,
      body: body.length ? body : undefined,
      duplex: 'half',
    });

    const respHeaders = { ...cors };
    for (const [k, v] of upstream.headers) {
      if (!SKIP_RESPONSE_HEADERS.has(k.toLowerCase())) respHeaders[k] = v;
    }

    console.log(`[proxy] ${req.method} /api/${pathAfterApi} → ${upstream.status}`);
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
    console.error(`Proxy error [${req.method} ${req.url}]:`, err.message || err);
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
  if (window.opener) {
    window.opener.postMessage({
      type: 'shiro-oauth-callback',
      code: params.code || '', state: params.state || '',
      port: params.port || '', params: params
    }, window.location.origin);
    document.body.innerHTML = '<p>Authentication complete. You can close this window.</p>';
    setTimeout(function() { window.close(); }, 1000);
  } else {
    document.body.innerHTML = '<p>Error: Could not communicate with Shiro.</p>';
  }
})();
</script></body></html>`;

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
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
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', ...staticHeaders });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...staticHeaders });
    res.end('Not found');
  }
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
}, 60_000);

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
      if (!SKIP_RESPONSE_HEADERS.has(k.toLowerCase())) respHeaders[k] = v;
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
}, 6 * 60 * 60 * 1000);

// --- HTTP server ---
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;

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
const wss = new WebSocketServer({ server, path: /^\/channel\/[a-f0-9]{1,64}$/ });
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
  });
}
