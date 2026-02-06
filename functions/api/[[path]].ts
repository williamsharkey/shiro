/**
 * Cloudflare Pages Function - API Proxy for Claude Code
 *
 * This function proxies requests to Anthropic APIs to bypass CORS restrictions.
 * Routes:
 *   /api/anthropic/*   -> https://api.anthropic.com/*
 *   /api/platform/*    -> https://platform.claude.com/*
 *   /api/mcp-proxy/*   -> https://mcp-proxy.anthropic.com/*
 */

interface Env {
  ALLOWED_ORIGINS?: string;
}

// Headers to skip when proxying
const SKIP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection',
  'transfer-encoding', 'upgrade', 'cf-connecting-ip',
  'cf-ipcountry', 'cf-ray', 'cf-visitor', 'x-forwarded-proto',
  'x-real-ip', 'accept-encoding'
]);

// Proxy targets
const PROXY_TARGETS: Record<string, string> = {
  'anthropic': 'https://api.anthropic.com',
  'platform': 'https://platform.claude.com',
  'mcp-proxy': 'https://mcp-proxy.anthropic.com',
};

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env, params } = context;
  const url = new URL(request.url);

  // Get the path segments after /api/
  const pathParts = (params.path as string[]) || [];
  if (pathParts.length === 0) {
    return new Response('Not found', { status: 404 });
  }

  const target = pathParts[0];
  const targetBase = PROXY_TARGETS[target];

  if (!targetBase) {
    return new Response(`Unknown API target: ${target}`, { status: 404 });
  }

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(request, env),
    });
  }

  // Build target URL
  const targetPath = '/' + pathParts.slice(1).join('/');
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
    // Get request body for non-GET requests
    let body: string | undefined;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      body = await request.text();
      // Update content-length for the actual body
      if (body) {
        headers.set('content-length', String(new TextEncoder().encode(body).length));
      }
    }

    // Forward the request
    const response = await fetch(targetUrl.toString(), {
      method: request.method,
      headers,
      body,
    });

    // Build response headers
    const responseHeaders = new Headers();
    for (const [key, value] of response.headers) {
      if (!SKIP_HEADERS.has(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    }

    // Add CORS headers
    for (const [key, value] of Object.entries(getCorsHeaders(request, env))) {
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
      headers: {
        'Content-Type': 'application/json',
        ...getCorsHeaders(request, env),
      },
    });
  }
};

function getCorsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') || '*';
  const allowedOrigins = env.ALLOWED_ORIGINS?.split(',') || [];

  // Check if origin is allowed (or use * for dev)
  const allowOrigin = allowedOrigins.includes(origin) || allowedOrigins.length === 0
    ? origin
    : allowedOrigins[0] || '*';

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access, x-stainless-arch, x-stainless-lang, x-stainless-os, x-stainless-package-version, x-stainless-retry-count, x-stainless-runtime, x-stainless-runtime-version',
    'Access-Control-Expose-Headers': 'x-request-id, request-id, anthropic-ratelimit-requests-limit, anthropic-ratelimit-requests-remaining, anthropic-ratelimit-tokens-limit, anthropic-ratelimit-tokens-remaining, retry-after',
    'Access-Control-Max-Age': '86400',
  };
}
