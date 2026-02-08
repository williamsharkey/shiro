/**
 * Wildcard subdomain proxy for shiro.computer
 *
 * Routes *.shiro.computer to the Pages deployment.
 * Each subdomain gets isolated IndexedDB/localStorage automatically
 * because the browser sees the original subdomain in window.location.
 *
 * Also handles /api/* and /oauth/* paths directly (API proxy + OAuth callback)
 * since Pages Functions don't execute when accessed through a different hostname.
 */

// Headers to skip when proxying API requests
const SKIP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection',
  'transfer-encoding', 'upgrade', 'cf-connecting-ip',
  'cf-ipcountry', 'cf-ray', 'cf-visitor', 'x-forwarded-proto',
  'x-real-ip', 'accept-encoding',
  'origin', 'referer',
  'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-user',
  'anthropic-dangerous-direct-browser-access',
]);

// API proxy targets
const PROXY_TARGETS: Record<string, string> = {
  'anthropic': 'https://api.anthropic.com',
  'platform': 'https://platform.claude.com',
  'mcp-proxy': 'https://mcp-proxy.anthropic.com',
};

function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access, x-stainless-arch, x-stainless-lang, x-stainless-os, x-stainless-package-version, x-stainless-retry-count, x-stainless-runtime, x-stainless-runtime-version',
    'Access-Control-Expose-Headers': 'x-request-id, request-id, anthropic-ratelimit-requests-limit, anthropic-ratelimit-requests-remaining, anthropic-ratelimit-tokens-limit, anthropic-ratelimit-tokens-remaining, retry-after',
    'Access-Control-Max-Age': '86400',
  };
}

async function handleApiProxy(request: Request, path: string): Promise<Response> {
  // path is everything after /api/ e.g. "anthropic/v1/messages"
  const parts = path.split('/');
  const target = parts[0];
  const targetBase = PROXY_TARGETS[target];

  if (!targetBase) {
    return new Response(`Unknown API target: ${target}`, { status: 404 });
  }

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: getCorsHeaders(request) });
  }

  // Build target URL
  const url = new URL(request.url);
  const targetPath = '/' + parts.slice(1).join('/');
  const targetUrl = new URL(targetPath, targetBase);
  targetUrl.search = url.search;

  // Filter and copy headers
  const headers = new Headers();
  for (const [key, value] of request.headers) {
    if (!SKIP_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }
  headers.set('host', new URL(targetBase).host);

  try {
    let body: string | undefined;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      body = await request.text();
      if (body) {
        headers.set('content-length', String(new TextEncoder().encode(body).length));
      }
    }

    const response = await fetch(targetUrl.toString(), {
      method: request.method,
      headers,
      body,
    });

    const responseHeaders = new Headers();
    for (const [key, value] of response.headers) {
      if (!SKIP_HEADERS.has(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    }
    for (const [key, value] of Object.entries(getCorsHeaders(request))) {
      responseHeaders.set(key, value);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...getCorsHeaders(request) },
    });
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle /api/* requests directly (API proxy)
    if (path.startsWith('/api/')) {
      return handleApiProxy(request, path.slice(5)); // strip "/api/"
    }

    // Handle /oauth/callback by proxying to the Pages deployment
    // (the HTML page with postMessage logic is a static asset there)

    // All other requests: proxy to Pages deployment for static assets
    url.hostname = 'shiro-3m3.pages.dev';

    const proxyRequest = new Request(url.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'manual',
    });

    const response = await fetch(proxyRequest);

    const headers = new Headers(response.headers);
    headers.delete('X-Frame-Options');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
