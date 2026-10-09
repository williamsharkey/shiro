import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

// Plain paths and a port from the server's log: the test config polyfills node:url/os/net
const serverPath = decodeURIComponent(new URL('../../../server.mjs', import.meta.url).pathname);

// Cross-origin isolation headers from server.mjs (see src/utils/isolation.ts).
// The server runs as a real `node server.mjs` child, once with the default
// (isolation on) and once with TABCOMPUTER_ISOLATION=0.
async function startServer(env: Record<string, string>): Promise<{ proc: ChildProcess; base: string }> {
  // PORT=0: the kernel picks a free port (a random one could be taken by another server test)
  const proc = spawn(process.execPath, [serverPath], {
    env: { ...process.env, ...env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    proc.once('exit', (code) => reject(new Error(`server exited (${code})`)));
    proc.stdout!.on('data', (d) => { const m = /listening on :(\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); });
  });
  return { proc, base: `http://127.0.0.1:${port}` };
}

describe('server cross-origin isolation headers', () => {
  let on: { proc: ChildProcess; base: string };
  let off: { proc: ChildProcess; base: string };

  beforeAll(async () => {
    const dir = mkdtempSync('/tmp/shiro-iso-');
    const pub = join(dir, 'public');
    mkdirSync(join(pub, 'assets'), { recursive: true });
    writeFileSync(join(pub, 'index.html'), '<!doctype html><title>shiro</title>');
    writeFileSync(join(pub, 'about.html'), '<!doctype html><title>about</title>');
    writeFileSync(join(pub, 'assets', 'chunk.js'), 'export {};');
    writeFileSync(join(pub, 'favicon.svg'), '<svg/>');
    const env = { STATIC_DIR: pub, SEED_DIR: join(dir, 'seeds') };
    [on, off] = await Promise.all([
      startServer({ ...env, TABCOMPUTER_ISOLATION: '' }),
      startServer({ ...env, TABCOMPUTER_ISOLATION: '0' }),
    ]);
  }, 20_000);

  afterAll(() => {
    on?.proc.kill();
    off?.proc.kill();
  });

  const headers = async (path: string, base = on.base) => (await fetch(base + path)).headers;

  it('isolates the app shell, including SPA fallbacks like /s/:id', async () => {
    for (const path of ['/', '/index.html', '/s/abcd1234']) {
      const h = await headers(path);
      expect(h.get('cross-origin-opener-policy'), path).toBe('same-origin');
      expect(h.get('cross-origin-embedder-policy'), path).toBe('credentialless');
    }
  });

  it('keeps CORP cross-origin so seed embeds and require-corp hosts can load the app', async () => {
    expect((await headers('/')).get('cross-origin-resource-policy')).toBe('cross-origin');
  });

  it('sends COEP on scripts so same-origin Workers start inside an isolated page', async () => {
    expect((await headers('/assets/chunk.js')).get('cross-origin-embedder-policy')).toBe('credentialless');
  });

  it('isolates the OAuth callback page and gives it a BroadcastChannel fallback', async () => {
    const res = await fetch(on.base + '/oauth/callback?code=x&state=port_3000_y');
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(await res.text()).toContain("new BroadcastChannel('shiro-oauth-callback')");
  });

  it('leaves the public docs pages and other assets unisolated', async () => {
    for (const path of ['/about', '/about.html', '/favicon.svg']) {
      const h = await headers(path);
      expect(h.get('cross-origin-opener-policy'), path).toBeNull();
      expect(h.get('cross-origin-embedder-policy'), path).toBeNull();
    }
  });

  it('TABCOMPUTER_ISOLATION=0 turns the headers off', async () => {
    for (const path of ['/', '/assets/chunk.js', '/oauth/callback']) {
      const h = await headers(path, off.base);
      expect(h.get('cross-origin-opener-policy'), path).toBeNull();
      expect(h.get('cross-origin-embedder-policy'), path).toBeNull();
    }
  });
});
