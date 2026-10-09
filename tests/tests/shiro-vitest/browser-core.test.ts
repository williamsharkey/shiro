/**
 * The Browser app's core (docs/BROWSER.md): browse-origin mapping, the
 * HTTP/1.1 client, TLS in the page (subtls) against a local TLS 1.3 server,
 * keep-alive pooling, the public suffix list and the cookie jar.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import type * as NetT from 'node:net';
import type * as HttpT from 'node:http';
// The real modules: the browser polyfill plugin would hand out stubs for these
const nodeRequire = createRequire(import.meta.url);
const net: typeof NetT = nodeRequire('node:net');
const tls = nodeRequire('node:tls');
const http: typeof HttpT = nodeRequire('node:http');
const zlib = nodeRequire('node:zlib');
const { execFileSync } = nodeRequire('node:child_process');
const { mkdtempSync, readFileSync, writeFileSync } = nodeRequire('node:fs');
const { tmpdir } = nodeRequire('node:os');
const path = nodeRequire('node:path');
import { OriginMap, decodeOriginKey, encodeOriginKey, appOriginFor } from '@shiro/browser/origin-map';
import { StreamReader, readResponse, serializeRequest, type ByteStream } from '@shiro/browser/http1';
import { NetFetcher, decodeBody } from '@shiro/browser/netfetch';
import { setTrustRoots } from '@shiro/browser/tls';
import { registrableDomain, isPublicSuffix, siteOf } from '@shiro/browser/psl';
import { CookieJar, parseSetCookie } from '@shiro/browser/cookies';

const te = new TextEncoder();
const td = new TextDecoder();

/** A ByteStream over node:net */
function nodeDial(host: string, port: number): Promise<ByteStream> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, host);
    const q: Uint8Array[] = [];
    let ended = false;
    let wake: (() => void) | null = null;
    s.on('data', (d) => { q.push(new Uint8Array(d)); wake?.(); });
    s.on('end', () => { ended = true; wake?.(); });
    s.on('close', () => { ended = true; wake?.(); });
    s.on('error', (e) => { ended = true; wake?.(); reject(e); });
    s.once('connect', () => resolve({
      async read() {
        while (!q.length && !ended) await new Promise<void>((r) => { wake = r; });
        wake = null;
        return q.shift();
      },
      write: (d) => new Promise((r) => s.write(d, () => r())),
      close: () => s.destroy(),
    }));
  });
}

function bytesStream(chunks: string[]): ByteStream {
  const q = chunks.map((c) => te.encode(c));
  return { async read() { return q.shift(); }, async write() {}, close() {} };
}

describe('origin map', () => {
  const m = new OriginMap('http://{key}.localhost:5299');
  it('round-trips hosts, schemes and ports', () => {
    for (const o of ['https://www.example.com', 'https://a-b.c-d.example.co.uk', 'http://example.com', 'http://example.com:8080',
      'https://example.com:8443', 'https://xn--bcher-kva.example', 'https://1.2.3.4', 'https://a--b.example.com']) {
      const key = encodeOriginKey(o)!;
      expect(key).toMatch(/^[a-z0-9-]+$/);
      const back = decodeOriginKey(key)!;
      expect(`${back.scheme}://${back.host}${[443, 80].includes(back.port) && (back.port === 443) === (back.scheme === 'https') ? '' : ':' + back.port}`).toBe(o);
    }
    expect(encodeOriginKey('https://www.example.com')).toBe('www-example-com');
    expect(encodeOriginKey('http://a-b.com:81')).toBe('a--b-com---h81');
  });
  it('refuses what one label cannot hold', () => {
    expect(encodeOriginKey('https://localhost')).toBeNull();
    expect(encodeOriginKey('https://[::1]')).toBeNull();
    expect(encodeOriginKey('ftp://example.com')).toBeNull();
    expect(encodeOriginKey('https://' + 'a'.repeat(60) + '.com')).toBeNull();
    expect(decodeOriginKey('a---b')).toBeNull();
    expect(decodeOriginKey('nodots')).toBeNull();
  });
  it('maps URLs both ways and knows its own origins', () => {
    expect(m.toBrowse('https://www.example.com/a/b?c=1#d')).toBe('http://www-example-com.localhost:5299/a/b?c=1#d');
    expect(m.toReal('http://www-example-com.localhost:5299/a/b?c=1#d')).toBe('https://www.example.com/a/b?c=1#d');
    expect(m.toReal('https://cdn.other.net/x.js')).toBe('https://cdn.other.net/x.js');
    expect(m.isBrowseOrigin('http://localhost:5299')).toBe(false);
    expect(m.isBrowseOrigin('http://evil.localhost:5299')).toBe(false); // no dot: not a key
    expect(m.isBrowseOrigin('http://www-example-com.localhost:5300')).toBe(false);
    expect(appOriginFor('https://{key}.tabcomputer.com')).toBe('https://tabcomputer.com');
  });
});

describe('http1', () => {
  it('serializes a request and refuses header injection', () => {
    const r = td.decode(serializeRequest('POST', new URL('https://a.example/p?q=1'), [['X-A', 'b']], 3));
    expect(r).toBe('POST /p?q=1 HTTP/1.1\r\nHost: a.example\r\nX-A: b\r\nContent-Length: 3\r\n\r\n');
    expect(() => serializeRequest('GET', new URL('https://a.example/'), [['X', 'a\r\nEvil: 1']], null)).toThrow();
  });
  it('parses content-length, chunked, close-delimited and 1xx', async () => {
    const read = async (chunks: string[], method = 'GET') => {
      const res = await readResponse(new StreamReader(bytesStream(chunks)), method);
      const body = td.decode(new Uint8Array(await new Response(res.body).arrayBuffer()));
      return { res, body, reusable: await res.reusable };
    };
    let r = await read(['HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhel', 'lo']);
    expect([r.res.status, r.body, r.reusable]).toEqual([200, 'hello', true]);
    r = await read(['HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 201 Created\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2;x=y\r\nde\r\n0\r\nT: 1\r\n\r\n']);
    expect([r.res.status, r.body, r.reusable]).toEqual([201, 'abcde', true]);
    r = await read(['HTTP/1.0 200 OK\r\nX: a\r\n  folded\r\n\r\nuntil close']);
    expect([r.body, r.reusable, r.res.headers[0][1]]).toEqual(['until close', false, 'a folded']);
    r = await read(['HTTP/1.1 304 Not Modified\r\nContent-Length: 10\r\n\r\n']);
    expect([r.body, r.reusable]).toEqual(['', true]);
    r = await read(['HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nabcd']);
    expect(r.reusable).toBe(false);
  });
  it('decodes gzip and deflate bodies', async () => {
    const gz = zlib.gzipSync(Buffer.from('compressed text'));
    const s = new Response(gz).body!;
    const { body, decoded } = decodeBody(s as ReadableStream<Uint8Array>, 'gzip');
    expect(decoded).toBe(true);
    expect(await new Response(body).text()).toBe('compressed text');
    expect(decodeBody(new Response('x').body as ReadableStream<Uint8Array>, 'zstd-unknown').decoded).toBe(false);
  });
});

describe('psl', () => {
  it('finds registrable domains', () => {
    expect(registrableDomain('www.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('a.b.example.com')).toBe('example.com');
    expect(registrableDomain('user.github.io')).toBe('user.github.io');
    expect(isPublicSuffix('github.io')).toBe(true);
    expect(isPublicSuffix('co.uk')).toBe(true);
    expect(isPublicSuffix('example.com')).toBe(false);
    expect(registrableDomain('1.2.3.4')).toBe('1.2.3.4');
    expect(siteOf('https://mail.google.com/x')).toBe('https://google.com');
  });
});

describe('cookie jar', () => {
  const url = new URL('https://www.example.com/app/page');
  const top = { partition: 'https://example.com', initiatorSite: 'https://example.com', topLevelNavigation: false, method: 'GET' };
  it('parses attributes and validates Domain', () => {
    const c = parseSetCookie('sid=1; Domain=.example.com; Path=/; Secure; HttpOnly; SameSite=None', url)!;
    expect(c).toMatchObject({ name: 'sid', value: '1', domain: 'example.com', hostOnly: false, secure: true, httpOnly: true, sameSite: 'none' });
    expect(parseSetCookie('a=1; Domain=other.com', url)).toBeNull();
    expect(parseSetCookie('a=1; Domain=com', url)).toBeNull();
    expect(parseSetCookie('a=1; Domain=github.io', new URL('https://user.github.io/'))).toBeNull();
    expect(parseSetCookie('a=1; SameSite=None', url)).toBeNull(); // None needs Secure
    expect(parseSetCookie('__Host-a=1; Secure; Path=/; Domain=example.com', url)).toBeNull();
    expect(parseSetCookie('a=1', url)!.path).toBe('/app');
    expect(parseSetCookie('a=1; HttpOnly', url, Date.now(), true)).toBeNull();
  });
  it('sends by domain, path and SameSite; keeps HttpOnly from script', () => {
    const jar = new CookieJar();
    jar.setFromResponse(url, ['h=1; Path=/; HttpOnly', 'd=2; Domain=example.com; Path=/', 'p=3; Path=/app', 'lax=4; Path=/; SameSite=Lax', 'none=5; Path=/; Secure; SameSite=None'], top);
    expect(jar.cookieHeader(new URL('https://www.example.com/app/x'), top)).toBe('p=3; h=1; d=2; lax=4; none=5');
    expect(jar.cookieHeader(new URL('https://api.example.com/'), top)).toBe('d=2');
    expect(jar.documentCookie(new URL('https://www.example.com/'), top.partition)).toBe('d=2; lax=4; none=5');
    // cross-site subresource from the same tab: only SameSite=None
    const cross = { ...top, initiatorSite: 'https://other.com' };
    expect(jar.cookieHeader(new URL('https://www.example.com/'), cross)).toBe('none=5');
    // cross-site top-level GET navigation: Lax too
    expect(jar.cookieHeader(new URL('https://www.example.com/'), { ...cross, topLevelNavigation: true })).toBe('h=1; d=2; lax=4; none=5');
    // another tab's partition sees nothing
    expect(jar.cookieHeader(new URL('https://www.example.com/'), { ...top, partition: 'https://evil.com' })).toBeNull();
    jar.setFromScript(new URL('https://www.example.com/'), 'h=evil; Path=/', top.partition);
    expect(jar.cookieHeader(new URL('https://www.example.com/'), top)).toContain('h=1');
    jar.setFromResponse(url, ['d=; Domain=example.com; Path=/; Max-Age=0'], top);
    expect(jar.cookieHeader(new URL('https://www.example.com/'), top)).not.toContain('d=');
  });
  it('persists only persistent cookies', () => {
    const jar = new CookieJar();
    jar.setFromResponse(url, ['s=1; Path=/', 'p=2; Path=/; Max-Age=3600'], top);
    const back = CookieJar.fromJSON(JSON.parse(JSON.stringify(jar.toJSON())));
    expect(back.cookieHeader(url, top)).toBe('p=2');
  });
});

describe('fetch over TLS 1.3 in JS (subtls) with keep-alive', () => {
  let server: { close(): void };
  let port = 0;
  let connections = 0;
  let caPem = '';
  let haveOpenssl = true;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tc-tls-'));
    try {
      const o = (...a: string[]) => execFileSync('openssl', a, { cwd: dir, stdio: 'pipe' });
      o('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'ca.key');
      o('req', '-x509', '-new', '-key', 'ca.key', '-sha256', '-days', '2', '-subj', '/CN=Test Root', '-out', 'ca.pem',
        '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
      o('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'leaf.key');
      o('req', '-new', '-key', 'leaf.key', '-subj', '/CN=tls.test', '-out', 'leaf.csr');
      writeFileSync(path.join(dir, 'ext.cnf'), 'subjectAltName=DNS:tls.test\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature\nbasicConstraints=CA:FALSE\n');
      o('x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '2', '-sha256', '-extfile', 'ext.cnf', '-out', 'leaf.pem');
    } catch { haveOpenssl = false; return; }
    caPem = readFileSync(path.join(dir, 'ca.pem'), 'utf8');
    const srv = tls.createServer({ key: readFileSync(path.join(dir, 'leaf.key')), cert: readFileSync(path.join(dir, 'leaf.pem')), minVersion: 'TLSv1.3' });
    const h = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        if (req.url === '/gzip') { res.writeHead(200, { 'content-encoding': 'gzip' }); res.end(zlib.gzipSync('zipped')); return; }
        if (req.url === '/chunked') { res.write('a'.repeat(70000)); res.end('end'); return; }
        res.end(`${req.method} ${req.url} ${body}`);
      });
    });
    srv.on('secureConnection', (s) => { connections++; h.emit('connection', s); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    port = (srv.address() as NetT.AddressInfo).port;
    server = srv as any;
    setTrustRoots(async () => '', caPem);
  });
  afterAll(() => server?.close());

  it('handshakes, verifies the chain and reuses the connection', async () => {
    if (!haveOpenssl) return;
    const f = new NetFetcher({ dial: (_h, p) => nodeDial('127.0.0.1', p) });
    const get = async (p: string, init: Partial<{ method: string; body: Uint8Array }> = {}) => {
      const r = await f.fetch({ url: `https://tls.test:${port}${p}`, method: init.method ?? 'GET', headers: [], body: init.body ?? null });
      const d = decodeBody(r.body, r.headers.find(([k]) => k.toLowerCase() === 'content-encoding')?.[1] ?? null);
      return [r.status, await new Response(d.body).text()] as const;
    };
    expect(await get('/a')).toEqual([200, 'GET /a ']);
    expect(await get('/b', { method: 'POST', body: te.encode('data') })).toEqual([200, 'POST /b data']);
    expect(await get('/gzip')).toEqual([200, 'zipped']);
    expect((await get('/chunked'))[1].length).toBe(70003);
    expect(connections).toBe(1);
    expect(f.stats.reused).toBe(3);
    f.closeAll();
  }, 20000);

  it('refuses a server whose certificate does not chain to a trusted root', async () => {
    if (!haveOpenssl) return;
    setTrustRoots(async () => '', '');
    const f = new NetFetcher({ dial: (_h, p) => nodeDial('127.0.0.1', p) });
    await expect(f.fetch({ url: `https://tls.test:${port}/`, method: 'GET', headers: [], body: null })).rejects.toThrow(/TLS/);
    setTrustRoots(async () => '', caPem);
  }, 20000);

  it('refuses a name mismatch', async () => {
    if (!haveOpenssl) return;
    const f = new NetFetcher({ dial: (_h, p) => nodeDial('127.0.0.1', p) });
    await expect(f.fetch({ url: `https://other.test:${port}/`, method: 'GET', headers: [], body: null })).rejects.toThrow(/TLS/);
  }, 20000);
});

describe('websocket', () => {
  it('computes the RFC 6455 accept key and masks client frames', async () => {
    const { acceptFor, encodeFrame } = await import('@shiro/browser/websocket');
    expect(await acceptFor('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    const f = encodeFrame(1, te.encode('Hello'));
    expect([f[0], f[1]]).toEqual([0x81, 0x85]);
    const mask = f.subarray(2, 6);
    expect(td.decode(f.subarray(6).map((b, i) => b ^ mask[i & 3]))).toBe('Hello');
    expect(encodeFrame(2, new Uint8Array(70000))[1]).toBe(0x80 | 127);
  });
});
