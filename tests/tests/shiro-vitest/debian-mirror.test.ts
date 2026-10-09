/**
 * server.mjs's Debian package mirror (docs/DEBIAN.md "Package mirror"): apt's
 * /debian/mirror/HOST/PATH and the GUI apps' /debian/pool/PATH, one handler,
 * against a local stand-in for deb.debian.org and snapshot.debian.org.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const PORT = 5394;
let upstream: Server;
let srv: ChildProcess;
const hits: string[] = [];

beforeAll(async () => {
  // The real http module (the test config polyfills node:http for the browser code)
  const { createServer } = (process as any).getBuiltinModule('http');
  upstream = createServer((req: any, res: any) => {
    hits.push(req.url!);
    if (req.url === '/debian/pool/main/h/hello/hello_1_amd64.deb') { res.writeHead(200, { 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' }); return res.end('current-deb'); }
    if (req.url === '/snap/pool/main/h/hello/hello_0_amd64.deb') { res.writeHead(200); return res.end('old-deb'); }
    if (req.url === '/debian/dists/trixie/InRelease') { res.writeHead(200); return res.end('release'); }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const up = `http://127.0.0.1:${(upstream.address() as any).port}`;
  srv = spawn('node', ['server.mjs'], {
    cwd: ROOT, stdio: 'ignore',
    env: {
      ...process.env, PORT: String(PORT), STATIC_DIR: resolve(ROOT, 'public'),
      TABCOMPUTER_DEBIAN_MIRRORS: `deb.debian.org=${up}`, TABCOMPUTER_DEBIAN_SNAPSHOT: `${up}/snap/`,
      TABCOMPUTER_DEBIAN_CACHE: mkdtempSync(join(tmpdir(), 'shiro-mirror-test-')),
    },
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
});
afterAll(() => { srv?.kill(); upstream?.close(); });

const get = (p: string) => fetch(`http://127.0.0.1:${PORT}${p}`);

describe('Debian package mirror', () => {
  it("serves apt's archive paths and caches pool files", async () => {
    const r = await get('/debian/mirror/deb.debian.org/debian/pool/main/h/hello/hello_1_amd64.deb');
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('current-deb');
    expect(r.headers.get('cache-control')).toContain('immutable');
    expect(r.headers.get('last-modified')).toBe('Mon, 01 Jan 2024 00:00:00 GMT');
    const before = hits.length;
    expect(await (await get('/debian/mirror/deb.debian.org/debian/pool/main/h/hello/hello_1_amd64.deb')).text()).toBe('current-deb');
    expect(hits.length).toBe(before); // from the disk cache
    expect(await (await get('/debian/mirror/deb.debian.org/debian/dists/trixie/InRelease')).text()).toBe('release');
  });

  it("serves the GUI apps' /debian/pool/ URL from the same mirror and cache", async () => {
    const before = hits.length;
    const r = await get('/debian/pool/main/h/hello/hello_1_amd64.deb');
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('current-deb');
    expect(hits.length).toBe(before);
  });

  it('falls back to snapshot.debian.org for pool files the mirror dropped', async () => {
    const r = await get('/debian/pool/main/h/hello/hello_0_amd64.deb');
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('old-deb');
  });

  it('is not an open proxy', async () => {
    expect((await get('/debian/mirror/evil.example/debian/pool/main/x/x.deb')).status).toBe(404);
    expect((await get('/debian/mirror/deb.debian.org/etc/passwd')).status).toBe(404);
    expect((await get('/debian/mirror/deb.debian.org/debian/pool/%2e%2e/x')).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${PORT}/debian/mirror/deb.debian.org/debian/dists/trixie/InRelease`, { method: 'POST' })).status).toBe(404);
  });
});
