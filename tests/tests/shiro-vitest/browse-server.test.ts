/**
 * server.mjs on browse origins (docs/BROWSER.md): a browse host serves only
 * the bootstrap page and /__tc/{sw,boot,client}.js, never the app or its APIs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { spawn } = nodeRequire('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync } = nodeRequire('node:fs');
const { tmpdir } = nodeRequire('node:os');
const path = nodeRequire('node:path');
const http = nodeRequire('node:http');
const net = nodeRequire('node:net');

const serverPath = path.resolve(__dirname, '../../../server.mjs');
let proc: any;
let port = 0;

function get(p: string, host: string, method = 'GET'): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host } }, (res: any) => {
      let body = '';
      res.on('data', (d: Buffer) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'browse-static-'));
  mkdirSync(path.join(dir, 'browse'));
  for (const f of ['sw.js', 'boot.js', 'client.js']) writeFileSync(path.join(dir, 'browse', f), `// ${f}`);
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>x</title><body>APP SHELL</body>');
  port = await new Promise<number>((r) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
  proc = spawn(process.execPath, [serverPath], { env: { ...process.env, PORT: String(port), STATIC_DIR: dir, SHIRO_BROWSE_ORIGIN: '', SHIRO_TCP_RELAY: '' }, stdio: 'pipe' });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 10000);
    proc.stdout.on('data', (d: Buffer) => { if (String(d).includes('listening')) { clearTimeout(t); resolve(); } });
  });
}, 20000);
afterAll(() => proc?.kill());

describe('browse hosts', () => {
  const host = () => `www-example-com.localhost:${port}`;
  it('the app tells the Browser its template', async () => {
    const r = await get('/browse/config.json', `localhost:${port}`);
    expect(JSON.parse(r.body)).toEqual({ origin: `http://{key}.localhost:${port}`, app: `http://localhost:${port}` });
  });
  it('serves the bootstrap page for any path, with isolation and framing headers', async () => {
    for (const p of ['/', '/wiki/Main_Page', '/api/messages', '/tcp/token', '/index.html']) {
      const r = await get(p, host());
      expect(r.status).toBe(200);
      expect(r.body).toContain('/__tc/boot.js');
      expect(r.body).not.toContain('APP SHELL');
      expect(r.headers['cross-origin-embedder-policy']).toBe('credentialless');
      expect(r.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(r.headers['content-security-policy']).toContain(`frame-ancestors http://localhost:${port} http://*.localhost:${port}`);
    }
  });
  it('serves the three scripts, the SW with Service-Worker-Allowed', async () => {
    const sw = await get('/__tc/sw.js', host());
    expect([sw.status, sw.body, sw.headers['service-worker-allowed']]).toEqual([200, '// sw.js', '/']);
    expect((await get('/__tc/client.js', host())).body).toBe('// client.js');
    expect((await get('/__tc/../index.html', host())).body).not.toContain('APP SHELL');
    expect((await get('/__tc/other.js', host())).status).toBe(404);
  });
  it('treats keyless hosts as the app', async () => {
    expect((await get('/', `localhost:${port}`)).body).toContain('APP SHELL');
    expect((await get('/', `www.localhost:${port}`)).body).toContain('APP SHELL'); // no dash: not a key
  });
});
