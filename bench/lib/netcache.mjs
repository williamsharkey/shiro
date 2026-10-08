// Serve every non-local request the page makes from bench/.cache/net, so runs
// are repeatable and work offline once warmed. A miss is fetched with curl
// (which honours the environment's proxy and CA bundle; headless Chromium
// here does not) and kept.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const TYPES = { '.js': 'application/javascript', '.mjs': 'application/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.html': 'text/html' };

export class NetCache {
  constructor(dir, { offline = false, log } = {}) {
    this.dir = dir;
    this.offline = offline;
    this.log = log;
    this.stats = { hits: 0, misses: 0, failed: 0 };
    this.inflight = new Map();
    mkdirSync(dir, { recursive: true });
  }

  key(url) { return createHash('sha256').update(url).digest('hex').slice(0, 32); }

  async get(url, headers = {}) {
    const k = this.key(url);
    const body = join(this.dir, k), meta = join(this.dir, k + '.json');
    if (existsSync(body) && existsSync(meta)) {
      this.stats.hits++;
      return { ...JSON.parse(readFileSync(meta, 'utf8')), body: readFileSync(body) };
    }
    if (this.offline) { this.stats.failed++; return null; }
    if (!this.inflight.has(k)) {
      this.inflight.set(k, (async () => {
        this.stats.misses++;
        this.log?.(`[net] fetch ${url}`);
        const tmpHead = body + '.head';
        const args = ['-sSL', '--max-time', '300', '-o', body, '-D', tmpHead, '-w', '%{http_code} %{content_type}'];
        if (headers.accept) args.push('-H', `Accept: ${headers.accept}`);
        args.push(url);
        try {
          const { stdout } = await run('curl', args, { maxBuffer: 1 << 20 });
          const [code, ...ct] = stdout.trim().split(' ');
          const status = Number(code);
          const info = { url, status, contentType: ct.join(' ') || guessType(url) };
          if (status >= 200 && status < 400) writeFileSync(meta, JSON.stringify(info));
          return { ...info, body: readFileSync(body) };
        } catch (e) {
          this.stats.failed++;
          this.log?.(`[net] failed ${url}: ${e.message.split('\n')[0]}`);
          return null;
        }
      })().finally(() => this.inflight.delete(k)));
    }
    return this.inflight.get(k);
  }

  /** Install on a Playwright BrowserContext: everything not from `localOrigin` goes through the cache. */
  async install(context, localOrigin) {
    await context.route((url) => !url.href.startsWith(localOrigin) && /^https?:/.test(url.protocol), async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: corsHeaders() });
      }
      if (req.method() !== 'GET') return route.abort('failed');
      const r = await this.get(req.url(), req.headers());
      if (!r) return route.abort('internetdisconnected');
      await route.fulfill({ status: r.status, body: r.body, headers: { 'content-type': r.contentType, ...corsHeaders() } });
    });
  }
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    // Cross-origin isolated page with COEP credentialless: no-cors loads need CORP or go credentialless
    'cross-origin-resource-policy': 'cross-origin',
  };
}

function guessType(url) {
  const m = /\.[a-z0-9]+(?=$|\?)/i.exec(new URL(url).pathname);
  return (m && TYPES[m[0]]) || 'application/octet-stream';
}
