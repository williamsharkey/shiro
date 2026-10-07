/**
 * Kernel sockets over server.mjs's WebSocket-to-TCP relay (src/kernel/net.ts).
 *
 * A harness process (fixtures/tcp-relay-harness.mjs) runs a TCP echo server,
 * relays built from server.mjs's createTcpRelay, and server.mjs itself with
 * SHIRO_TCP_RELAY=1. The kernel side runs here with Node's WebSocket/fetch.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  NetStack, KSocket, KDatagramSocket, AF_INET, AF_INET6, SOCK_STREAM, SOCK_DGRAM, SOCK_NONBLOCK,
  POLLIN, POLLOUT, SOL_SOCKET, SO_ERROR, SO_TYPE, SHUT_WR, EACCES, EAGAIN, EINPROGRESS, ENETUNREACH,
  ECONNREFUSED, EDQUOT, EHOSTUNREACH, ENOTCONN, EISCONN, decodeSockaddr, encodeSockaddr, parseHttpResponse,
  type PortHost, type VirtualHttpRequest, type VirtualHttpResponse,
} from '@shiro/kernel/net';

interface Ports { echoPort: number; firehosePort: number; relayA: number; relayB: number; relayC: number; mainPort: number; origin: string }

let harness: ChildProcess;
let P: Ports;

beforeAll(async () => {
  const path = new URL('./fixtures/tcp-relay-harness.mjs', import.meta.url).pathname;
  harness = spawn('node', [path], { stdio: ['pipe', 'pipe', 'inherit'] });
  P = await new Promise<Ports>((resolve, reject) => {
    let out = '';
    harness.stdout!.on('data', (d) => {
      out += d;
      const line = out.split('\n').find((l) => l.startsWith('{'));
      if (line) resolve(JSON.parse(line));
    });
    harness.once('exit', (c) => reject(new Error(`harness exited ${c}`)));
  });
}, 30_000);

afterAll(() => { harness?.kill(); });

/** A NetStack pointed at one relay, talking like a browser page on `origin`. */
function stackFor(port: number, origin = P.origin, extra: Record<string, unknown> = {}): NetStack {
  const s = new NetStack();
  class OriginWebSocket extends WebSocket {
    constructor(url: string | URL) { super(url, { headers: { origin } } as any); }
  }
  s.configure({
    relayUrl: `ws://127.0.0.1:${port}/tcp`,
    tokenUrl: `http://127.0.0.1:${port}/tcp/token`,
    fetch: ((u: any, init: any = {}) => fetch(u, { ...init, headers: { ...(init.headers || {}), origin } })) as typeof fetch,
    WebSocket: OriginWebSocket as unknown as typeof WebSocket,
    relayLoopback: true,
    portHost: null,
    dohUrl: null,
    ...extra,
  });
  return s;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const v4 = (address: string, port: number) => ({ family: AF_INET, address, port });

async function readAll(s: KSocket, max = 64 * 1024 * 1024): Promise<{ data: Uint8Array; end: number }> {
  const parts: Uint8Array[] = [];
  const buf = new Uint8Array(65536);
  let total = 0;
  for (;;) {
    const n = await s.read(buf);
    if (n <= 0) {
      const out = new Uint8Array(total);
      let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }
      return { data: out, end: n };
    }
    parts.push(buf.slice(0, n));
    total += n;
    if (total >= max) return { data: new Uint8Array(0), end: 1 };
  }
}

function stream(stack: NetStack): KSocket {
  const s = stack.socket(AF_INET, SOCK_STREAM);
  if (typeof s === 'number' || !(s instanceof KSocket)) throw new Error(`socket: ${s}`);
  return s;
}

describe('kernel sockets over the TCP relay', () => {
  it('round-trips a stream through the relay to a TCP echo server', async () => {
    const stack = stackFor(P.relayA);
    const s = stream(stack);
    expect(await s.connect(v4('127.0.0.1', P.echoPort))).toBe(0);
    expect(s.getpeername()).toEqual(v4('127.0.0.1', P.echoPort));
    expect(s.getsockname().port).toBeGreaterThan(0);
    expect(await s.connect(v4('127.0.0.1', P.echoPort))).toBe(-EISCONN);
    expect(await s.write(enc.encode('hello, relay\n'))).toBe(13);
    expect(s.shutdown(SHUT_WR)).toBe(0);
    const { data, end } = await readAll(s);
    expect(dec.decode(data)).toBe('hello, relay\n');
    expect(end).toBe(0);
    await s.close();
  });

  it('server.mjs itself (env-configured) relays 1 MiB both ways with flow control', async () => {
    const stack = stackFor(P.mainPort);
    const s = stream(stack);
    expect(await s.connect(v4('127.0.0.1', P.echoPort))).toBe(0);
    const payload = new Uint8Array(1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) & 0xff;
    const reader = readAll(s);
    expect(await s.write(payload)).toBe(payload.length);
    s.shutdown(SHUT_WR);
    const { data, end } = await reader;
    expect(end).toBe(0);
    expect(data.length).toBe(payload.length);
    expect(data.every((b, i) => b === payload[i])).toBe(true);
    await s.close();
  }, 30_000);

  it('nonblocking connect reports EINPROGRESS, then POLLOUT and SO_ERROR=0', async () => {
    const stack = stackFor(P.relayA);
    const s = stack.socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK) as KSocket;
    expect(await s.connect(v4('127.0.0.1', P.echoPort))).toBe(-EINPROGRESS);
    expect(s.poll(POLLOUT)).toBe(0);
    await new Promise<void>((r) => { const off = s.onReady(() => { if (s.poll(POLLOUT)) { off(); r(); } }); });
    expect(s.getsockopt(SOL_SOCKET, SO_ERROR)).toBe(0);
    expect(s.getsockopt(SOL_SOCKET, SO_TYPE)).toBe(SOCK_STREAM);
    const buf = new Uint8Array(16);
    expect(await s.read(buf)).toBe(-EAGAIN);
    await s.write(enc.encode('ping'));
    await new Promise<void>((r) => { const off = s.onReady(() => { if (s.poll(POLLIN)) { off(); r(); } }); if (s.poll(POLLIN)) r(); });
    expect(dec.decode(buf.subarray(0, await s.read(buf)))).toBe('ping');
    await s.close();
  });

  it('closes a connection that exceeds the per-connection byte cap', async () => {
    const s = stream(stackFor(P.relayA));
    expect(await s.connect(v4('127.0.0.1', P.firehosePort))).toBe(0);
    const { data, end } = await readAll(s);
    expect(end).toBe(-EDQUOT);
    expect(data.length).toBeLessThan(1024 * 1024);
    await s.close();
  });

  it('caps concurrent connections per client IP', async () => {
    const stack = stackFor(P.relayA);
    const open: KSocket[] = [];
    for (let i = 0; i < 3; i++) {
      const s = stream(stack);
      expect(await s.connect(v4('127.0.0.1', P.echoPort))).toBe(0);
      open.push(s);
    }
    const extra = stream(stack);
    expect(await extra.connect(v4('127.0.0.1', P.echoPort))).toBe(-ENETUNREACH);
    await open.pop()!.close();
    await new Promise((r) => setTimeout(r, 100));
    const again = stream(stack);
    expect(await again.connect(v4('127.0.0.1', P.echoPort))).toBe(0);
    for (const s of [...open, again]) await s.close();
  });

  it('rate-limits connection attempts per client IP', async () => {
    const stack = stackFor(P.relayC);
    const results: number[] = [];
    for (let i = 0; i < 3; i++) {
      const s = stream(stack);
      results.push(await s.connect(v4('127.0.0.1', P.echoPort)));
      await s.close();
    }
    expect(results).toEqual([0, 0, -ENETUNREACH]);
  });

  it('refuses private, loopback, link-local and metadata targets, including after DNS', async () => {
    const stack = stackFor(P.relayB);
    const tryAddr = async (address: string, port = 80, family = AF_INET) => {
      const s = stack.socket(family, SOCK_STREAM) as KSocket;
      const r = await s.connect({ family, address, port });
      await s.close();
      return r;
    };
    expect(await tryAddr('127.0.0.1', P.echoPort)).toBe(-EACCES);
    expect(await tryAddr('10.0.0.1')).toBe(-EACCES);
    expect(await tryAddr('172.16.5.4')).toBe(-EACCES);
    expect(await tryAddr('192.168.1.1')).toBe(-EACCES);
    expect(await tryAddr('169.254.169.254')).toBe(-EACCES);
    expect(await tryAddr('100.100.100.200')).toBe(-EACCES);
    expect(await tryAddr('0.0.0.0', P.echoPort)).toBe(-EACCES);
    expect(await tryAddr('::1', P.echoPort, AF_INET6)).toBe(-EACCES);
    expect(await tryAddr('fd00:ec2::254', 80, AF_INET6)).toBe(-EACCES);
    expect(await tryAddr('fe80::1', 80, AF_INET6)).toBe(-EACCES);
    expect(await tryAddr('::ffff:127.0.0.1', P.echoPort, AF_INET6)).toBe(-EACCES);
    // Port allowlist is checked before anything is dialed
    expect(await tryAddr('93.184.215.14', 25)).toBe(-EACCES);
    // Names that resolve into blocked ranges (the DNS-rebinding case)
    for (const host of ['rebind.test', 'metadata.test', 'v6local.test', 'mapped.test', 'localhost']) {
      const s = stream(stack);
      expect(await s.connectHost(host, 80), host).toBe(-EACCES);
      await s.close();
    }
    expect(await stack.resolve('rebind.test')).toBe(-EHOSTUNREACH);
    const logs: string[] = await (await fetch(`http://127.0.0.1:${P.relayB}/logs`)).json();
    expect(logs.some((l) => l.includes('refused') && l.includes('rebind.test'))).toBe(true);
    // Logs carry endpoints and byte counts, never payloads
    expect(logs.join('\n')).not.toContain('hello');
  });

  it('requires an allowed Origin and a valid token', async () => {
    const opened = (url: string, origin?: string) => new Promise<boolean>((resolve) => {
      const ws = new WebSocket(url, origin ? ({ headers: { origin } } as any) : undefined);
      ws.onopen = () => { ws.close(); resolve(true); };
      ws.onerror = () => resolve(false);
    });
    const base = `ws://127.0.0.1:${P.relayA}/tcp`;
    expect(await opened(base, P.origin)).toBe(false); // no token
    expect(await opened(`${base}?t=${Date.now() + 60000}.${'A'.repeat(43)}`, P.origin)).toBe(false); // forged
    const tokenRes = await fetch(`http://127.0.0.1:${P.relayA}/tcp/token`, { method: 'POST', headers: { origin: 'https://evil.example' } });
    expect(tokenRes.status).toBe(403);
    const { token } = await (await fetch(`http://127.0.0.1:${P.relayA}/tcp/token`, { method: 'POST', headers: { origin: P.origin } })).json();
    expect(await opened(`${base}?t=${token}`, 'https://evil.example')).toBe(false); // wrong origin
    // Token is bound to the client IP (trusted X-Forwarded-For from a loopback proxy)
    const otherIp = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`${base}?t=${token}`, { headers: { origin: P.origin, 'x-forwarded-for': '203.0.113.9' } } as any);
      ws.onopen = () => { ws.close(); resolve(true); };
      ws.onerror = () => resolve(false);
    });
    expect(otherIp).toBe(false);
    expect(await opened(`${base}?t=${token}`, P.origin)).toBe(true);
  });

  it('fails cleanly when no relay is configured', async () => {
    const stack = new NetStack();
    stack.configure({ relayUrl: null, tokenUrl: null, portHost: null, dohUrl: null });
    const s = stream(stack);
    expect(await s.connect(v4('93.184.215.14', 80))).toBe(-ENETUNREACH);
    expect(await s.connect(v4('127.0.0.1', 9))).toBe(-ECONNREFUSED);
    expect(await s.write(enc.encode('x'))).toBe(-ENOTCONN);
  });
});

describe('kernel loopback and listening sockets', () => {
  function localStack(portHost: PortHost | null = null) {
    const s = new NetStack();
    s.configure({ relayUrl: null, tokenUrl: null, dohUrl: null, portHost });
    return s;
  }

  /** Minimal guest HTTP server: accept, read the request head, answer with the path. */
  async function serveOnce(listener: KSocket) {
    const c = await listener.accept();
    if (typeof c === 'number') throw new Error(`accept ${c}`);
    const buf = new Uint8Array(4096);
    let req = '';
    while (!req.includes('\r\n\r\n')) {
      const n = await c.read(buf);
      if (n <= 0) break;
      req += dec.decode(buf.subarray(0, n));
    }
    const path = req.split(' ')[1];
    const body = `you asked for ${path}`;
    await c.write(enc.encode(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\nX-Guest: yes\r\n\r\n${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`));
    await c.close();
    return req;
  }

  it('connects to a listening socket over loopback and accepts', async () => {
    const stack = localStack();
    const l = stream(stack);
    expect(l.bind(v4('0.0.0.0', 7070))).toBe(0);
    expect(l.listen(8)).toBe(0);
    const c = stream(stack);
    expect(await c.connect(v4('127.0.0.1', 7070))).toBe(0);
    const a = await l.accept() as KSocket;
    expect(a.getsockname().port).toBe(7070);
    expect((a.getpeername() as any).port).toBe(c.getsockname().port);
    await c.write(enc.encode('over loopback'));
    const buf = new Uint8Array(64);
    expect(dec.decode(buf.subarray(0, await a.read(buf)))).toBe('over loopback');
    await c.close();
    expect(await a.read(buf)).toBe(0); // FIN
    const busy = stream(stack);
    expect(busy.bind(v4('0.0.0.0', 7070))).toBeLessThan(0);
    await l.close();
    expect(await stream(stack).connect(v4('127.0.0.1', 7070))).toBe(-ECONNREFUSED);
  });

  it('publishes a listener on the virtual-server port table as an HTTP server', async () => {
    let handler: ((r: VirtualHttpRequest) => Promise<VirtualHttpResponse>) | null = null;
    const host: PortHost = { serve: (_p, h) => { handler = h; return () => { handler = null; }; } };
    const stack = localStack(host);
    const l = stream(stack);
    l.bind(v4('0.0.0.0', 8088));
    l.listen(16);
    await new Promise((r) => setTimeout(r, 0));
    expect(handler).toBeTruthy();
    const served = serveOnce(l);
    const res = await handler!({ method: 'GET', path: '/hello', query: { a: '1' }, headers: { 'X-Test': 't' } });
    const req = await served;
    expect(req.startsWith('GET /hello?a=1 HTTP/1.1\r\n')).toBe(true);
    expect(req.toLowerCase()).toContain('x-test: t');
    expect(res.status).toBe(200);
    expect(res.headers!['x-guest']).toBe('yes');
    expect(dec.decode(res.body as Uint8Array)).toBe('you asked for /hello?a=1');
    await l.close();
    expect(handler).toBeNull();
  });

  it('is reachable through Shiro\'s iframeServer like http.createServer servers', async () => {
    const { iframeServer } = await import('@shiro/iframe-server');
    const stack = new NetStack();
    stack.configure({ relayUrl: null, tokenUrl: null, dohUrl: null }); // default portHost = iframeServer
    const l = stream(stack);
    l.bind(v4('0.0.0.0', 8099));
    l.listen(4);
    for (let i = 0; i < 50 && !iframeServer.isPortInUse(8099); i++) await new Promise((r) => setTimeout(r, 10));
    expect(iframeServer.isPortInUse(8099)).toBe(true);
    const served = serveOnce(l);
    const res = await iframeServer.fetch(8099, '/from-iframe');
    await served;
    expect(res.status).toBe(200);
    const body = res.body instanceof Uint8Array ? dec.decode(res.body) : String(res.body);
    expect(body).toBe('you asked for /from-iframe');
    await l.close();
    expect(iframeServer.isPortInUse(8099)).toBe(false);
  });

  it('parses Content-Length and close-delimited responses', () => {
    const r1 = parseHttpResponse(enc.encode('HTTP/1.1 404 Not Found\r\nContent-Length: 3\r\n\r\nabcEXTRA'), false);
    expect(r1.complete).toBe(true);
    expect(dec.decode(r1.response!.body as Uint8Array)).toBe('abc');
    expect(parseHttpResponse(enc.encode('HTTP/1.0 200 OK\r\n\r\npartial'), false).complete).toBe(false);
    expect(dec.decode(parseHttpResponse(enc.encode('HTTP/1.0 200 OK\r\n\r\nall'), true).response!.body as Uint8Array)).toBe('all');
  });

  it('socketpair gives two connected ends', async () => {
    const stack = localStack();
    const [a, b] = stack.socketpair() as [KSocket, KSocket];
    await a.write(enc.encode('x'));
    const buf = new Uint8Array(4);
    expect(await b.read(buf)).toBe(1);
  });

  it('round-trips sockaddr_in and sockaddr_in6', () => {
    expect(decodeSockaddr(encodeSockaddr(v4('93.184.215.14', 443)))).toEqual(v4('93.184.215.14', 443));
    const six = { family: AF_INET6, address: '2606:2800:220:1::1', port: 22 };
    expect(decodeSockaddr(encodeSockaddr(six))).toEqual(six);
  });

  it('answers UDP DNS queries over DoH', async () => {
    const stack = new NetStack();
    const answer = new Uint8Array([0x12, 0x34, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0]);
    let sent: Uint8Array | null = null;
    stack.configure({
      relayUrl: null, tokenUrl: null, portHost: null, dohUrl: 'https://doh.test/dns-query',
      fetch: (async (_u: any, init: any) => { sent = init.body; return new Response(answer); }) as typeof fetch,
    });
    const u = stack.socket(AF_INET, SOCK_DGRAM) as KDatagramSocket;
    const query = new Uint8Array([0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]);
    expect(await u.sendto(query, 0, v4('8.8.8.8', 53))).toBe(query.length);
    const buf = new Uint8Array(512);
    const r = await u.recvfrom(buf, 0);
    expect(typeof r).toBe('object');
    expect(Array.from(buf.subarray(0, (r as any).n))).toEqual(Array.from(answer));
    expect((r as any).from).toEqual(v4('8.8.8.8', 53));
    expect(Array.from(sent!)).toEqual(Array.from(query));
    expect(await u.sendto(query, 0, v4('8.8.8.8', 123))).toBe(-ENETUNREACH);
  });
});
