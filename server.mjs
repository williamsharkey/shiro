/**
 * Shiro unified server — static files + API proxy + OAuth callback + WebSocket relay.
 * Single Node.js process, no dependencies.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { WebSocketServer } from 'ws';

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
};

const SKIP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'accept-encoding',
  'origin', 'referer', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
  'sec-fetch-user', 'anthropic-dangerous-direct-browser-access',
]);

function corsHeaders(origin) {
  return {
    'access-control-allow-origin': origin || '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access, x-stainless-arch, x-stainless-lang, x-stainless-os, x-stainless-package-version, x-stainless-retry-count, x-stainless-runtime, x-stainless-runtime-version, mcp-session-id',
    'access-control-expose-headers': 'x-request-id, request-id, anthropic-ratelimit-requests-limit, anthropic-ratelimit-requests-remaining, anthropic-ratelimit-tokens-limit, anthropic-ratelimit-tokens-remaining, retry-after, mcp-session-id',
    'access-control-max-age': '86400',
  };
}

async function handleProxy(req, res, pathAfterApi) {
  const origin = req.headers['origin'];
  const cors = corsHeaders(origin);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }

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
    if (!SKIP_HEADERS.has(k.toLowerCase())) headers[k] = v;
  }
  headers['host'] = new URL(base).host;
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
      if (!SKIP_HEADERS.has(k.toLowerCase())) respHeaders[k] = v;
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
  let filePath = join(STATIC_DIR, new URL(req.url, 'http://localhost').pathname);

  try {
    const s = await stat(filePath);
    if (s.isDirectory()) filePath = join(filePath, 'index.html');
  } catch {
    // Fall through to index.html for SPA routing
    filePath = join(STATIC_DIR, 'index.html');
  }

  try {
    const data = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

// --- HTTP server ---
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;

  if (pathname.startsWith('/api/')) {
    return handleProxy(req, res, pathname.slice(5));
  }
  if (pathname === '/oauth/callback') {
    return handleOAuthCallback(req, res);
  }
  if (pathname === '/health') {
    res.writeHead(200);
    return res.end('ok');
  }
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

server.listen(PORT, () => {
  console.log(`Shiro server listening on :${PORT}`);
});
