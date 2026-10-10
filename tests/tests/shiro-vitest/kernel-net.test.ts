/**
 * Kernel sockets over server.mjs's WebSocket-to-TCP relay (src/kernel/net.ts).
 *
 * A harness process (fixtures/tcp-relay-harness.mjs) runs a TCP echo server,
 * relays built from server.mjs's createTcpRelay, and server.mjs itself with
 * TABCOMPUTER_TCP_RELAY=1. The kernel side runs here with Node's WebSocket/fetch.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  NetStack, KSocket, KDatagramSocket, AF_INET, AF_INET6, SOCK_STREAM, SOCK_DGRAM, SOCK_NONBLOCK,
  POLLIN, POLLOUT, SOL_SOCKET, SO_ERROR, SO_TYPE, SHUT_WR, EACCES, EAGAIN, EINPROGRESS, ENETUNREACH,
  ECONNREFUSED, EDQUOT, EHOSTUNREACH, ENOTCONN, EISCONN, decodeSockaddr, encodeSockaddr, parseHttpResponse,
  type PortHost, type VirtualHttpRequest, type VirtualHttpResponse,
} from '@shiro/kernel/net';
import { MSG_PEEK, MSG_TRUNC } from '@shiro/kernel/abi';

interface Ports { echoPort: number; firehosePort: number; relayA: number; relayB: number; relayC: number; relayD: number; relayE: number; relayF: number; proxyLogPort: number; mainPort: number; origin: string }

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

  it('dials through an upstream CONNECT proxy, after the address policy', async () => {
    const s = stream(stackFor(P.relayF));
    expect(await s.connectHost('public.test', P.echoPort)).toBe(0);
    expect(await s.write(enc.encode('via proxy\n'))).toBe(10);
    s.shutdown(SHUT_WR);
    expect(dec.decode((await readAll(s)).data)).toBe('via proxy\n');
    await s.close();
    // a name resolving to a private address never reaches the proxy; a proxy refusal is a refusal
    expect(await stream(stackFor(P.relayF)).connectHost('rebind.test', P.echoPort)).toBeLessThan(0);
    expect(await stream(stackFor(P.relayF)).connectHost('denied.test', P.echoPort)).toBeLessThan(0);
    const seen: string[] = await (await fetch(`http://127.0.0.1:${P.proxyLogPort}/`)).json();
    expect(seen.some((l) => l.startsWith('CONNECT public.test:'))).toBe(true);
    expect(seen.some((l) => l.includes('rebind.test'))).toBe(false);
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

  it("a connected datagram socket has a source address in the peer's family (glibc's getaddrinfo sort)", async () => {
    const stack = stackFor(P.relayA);
    const src = (domain: number, to: { family: number; address: string; port: number }) => {
      const d = stack.socket(domain, SOCK_DGRAM) as KDatagramSocket;
      expect(d.connect(to)).toBe(0);
      const a = d.getsockname().address;
      void d.close();
      return a;
    };
    expect(src(AF_INET6, { family: AF_INET6, address: '::ffff:151.101.0.223', port: 0 })).toBe('::ffff:10.0.2.15');
    expect(src(AF_INET6, { family: AF_INET6, address: '2a04:4e42::223', port: 0 })).toBe('fd00::15');
    expect(src(AF_INET, v4('151.101.0.223', 0))).toBe('10.0.2.15');
    expect(src(AF_INET, v4('127.0.0.1', 53))).toBe('127.0.0.1');
    // the same socket connected again picks the source again (Firefox aborted in getaddrinfo
    // when an IPv6 answer came before a v4-mapped one); a bound address stays
    const d = stack.socket(AF_INET6, SOCK_DGRAM) as KDatagramSocket;
    d.connect({ family: AF_INET6, address: '2a04:4e42::223', port: 0 });
    const port = d.getsockname().port;
    d.connect({ family: AF_INET6, address: '::ffff:151.101.0.223', port: 0 });
    expect(d.getsockname()).toMatchObject({ address: '::ffff:10.0.2.15', port });
    void d.close();
    const b = stack.socket(AF_INET6, SOCK_DGRAM) as KDatagramSocket;
    b.bind({ family: AF_INET6, address: '::1', port: 0 });
    b.connect({ family: AF_INET6, address: '::ffff:151.101.0.223', port: 0 });
    expect(b.getsockname().address).toBe('::1');
    void b.close();
  });

  it('AF_UNIX SOCK_SEQPACKET socketpairs keep records whole (Rust std::process::Command)', async () => {
    const stack = stackFor(P.relayA);
    const pair = stack.socketpair(5) as [KSocket, KSocket];
    expect(Array.isArray(pair)).toBe(true);
    const [a, b] = pair;
    expect(a.getsockopt(SOL_SOCKET, SO_TYPE)).toBe(5);
    await a.write(enc.encode('abc')); await a.write(enc.encode('de')); await a.write(enc.encode('hello'));
    const buf = new Uint8Array(10);
    expect(dec.decode(buf.subarray(0, await b.read(buf)))).toBe('abc');
    expect(dec.decode(buf.subarray(0, await b.read(buf)))).toBe('de');
    const small = new Uint8Array(2);
    expect(dec.decode(small.subarray(0, await b.read(small)))).toBe('he'); // the rest of the record is dropped
    await a.close();
    expect(await b.read(buf)).toBe(0);
    await b.close();
  });

  it('AF_UNIX message sockets: MSG_TRUNC gives the whole length, MSG_PEEK keeps the message, SCM_RIGHTS stay with their message', async () => {
    const stack = stackFor(P.relayA);
    for (const type of [SOCK_DGRAM, 5]) {
      const [a, b] = stack.socketpair(type) as [KSocket, KSocket];
      expect(a.getsockopt(SOL_SOCKET, SO_TYPE)).toBe(type);
      await a.write(enc.encode('hello world'));
      const small = new Uint8Array(5);
      expect(await b.recv(small, MSG_PEEK)).toBe(5);
      expect(await b.recv(small, MSG_TRUNC)).toBe(11); // the rest is dropped, its length reported
      expect(dec.decode(small)).toBe('hello');
      // descriptions passed with a message arrive with that message, not the next
      const [x, y] = stack.socketpair(SOCK_STREAM) as [KSocket, KSocket];
      await a.send(enc.encode('m1'), 0, undefined, [x]);
      await a.send(enc.encode('m2'));
      const fds: unknown[] = [];
      const buf = new Uint8Array(8);
      expect(await b.recv(buf, 0, undefined, fds as never)).toBe(2);
      expect(fds.length).toBe(1);
      expect(await b.recv(buf, 0, undefined, fds as never)).toBe(2);
      expect(fds.length).toBe(1);
      for (const s of [a, b, y]) await s.close();
    }
  });

  it('FIONBIO is accepted on stream and datagram sockets (CPython setblocking(False))', async () => {
    const stack = stackFor(P.relayA);
    const on = new Uint8Array([1, 0, 0, 0]);
    const s = stack.socket(AF_INET, SOCK_STREAM) as KSocket;
    expect(await s.ioctl(0x5421, on)).toBe(0);
    const d = stack.socket(AF_INET, SOCK_DGRAM) as KDatagramSocket;
    expect(await d.ioctl(0x5421, on)).toBe(0);
    await s.close(); await d.close();
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

  it('with tokenBindIp off, a token works from another IP (rotating-IP clients); the origin check stays', async () => {
    const xff = (n: number) => `203.0.113.${n}`;
    const { token } = await (await fetch(`http://127.0.0.1:${P.relayE}/tcp/token`, { method: 'POST', headers: { origin: P.origin, 'x-forwarded-for': xff(1) } })).json();
    const open = (ip: string, origin = P.origin) => new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${P.relayE}/tcp?t=${token}`, { headers: { origin, 'x-forwarded-for': ip } } as any);
      ws.onopen = () => { ws.close(); resolve(true); };
      ws.onerror = () => resolve(false);
    });
    for (let i = 2; i < 5; i++) expect(await open(xff(i))).toBe(true); // one after another
    expect(await Promise.all([5, 6, 7].map((i) => open(xff(i))))).toEqual([true, true, true]); // in parallel
    expect(await open(xff(8), 'https://evil.example')).toBe(false);
    // The deployed default stays bound; TABCOMPUTER_TCP_TOKEN_BIND_IP=0 turns it off
    const server = new URL('../../../server.mjs', import.meta.url).href;
    const out = execFileSync('node', ['--input-type=module', '-e',
      `const m = await import(${JSON.stringify(server)}); console.log(JSON.stringify([m.tcpRelayConfigFromEnv({}).tokenBindIp, m.tcpRelayConfigFromEnv({ TABCOMPUTER_TCP_TOKEN_BIND_IP: '0' }).tokenBindIp])); process.exit(0);`,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    expect(JSON.parse(out.trim().split('\n').pop()!)).toEqual([true, false]);
  });

  it('blocks private ranges without blocking public IPv4 (BlockList matches IPv4 against ::ffff:0:0/96)', async () => {
    // Plain Node (vitest's polyfilled modules can't load server.mjs)
    const server = new URL('../../../server.mjs', import.meta.url).href;
    const addrs = ['8.8.8.8', '93.184.215.14', '172.66.147.243', '2606:4700::1111',
      '10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.5.4', '::ffff:8.8.8.8', '::ffff:127.0.0.1', '64:ff9b::808:808', 'fd00:ec2::254'];
    const out = execFileSync('node', ['--input-type=module', '-e',
      `const m = await import(${JSON.stringify(server)}); console.log(JSON.stringify(${JSON.stringify(addrs)}.map((a) => m.isBlockedAddress(a)))); process.exit(0);`,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const blocked = JSON.parse(out.trim().split('\n').pop()!);
    expect(Object.fromEntries(addrs.map((a, i) => [a, blocked[i]]))).toEqual(Object.fromEntries(addrs.map((a, i) => [a, i >= 4])));
  });

  it('a relay that requires sign-in answers 401 until a GitHub token comes along (net-signin)', async () => {
    const url = `http://127.0.0.1:${P.relayD}/tcp/token`;
    const bare = await fetch(url, { method: 'POST', headers: { origin: P.origin } });
    expect(bare.status).toBe(401);
    expect(await bare.json()).toEqual({ error: 'signin_required', provider: 'github' });
    expect((await fetch(url, { method: 'POST', headers: { origin: P.origin, authorization: 'Bearer nope' } })).status).toBe(401);
    const ok = await fetch(url, { method: 'POST', headers: { origin: P.origin, authorization: 'Bearer good-token' } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).token).toMatch(/^\d+\./);

    // The kernel side: no saved sign-in → asks the hook once; with it, connects
    const signin = await import('@shiro/net-signin');
    const asked: unknown[] = [];
    const stack = stackFor(P.relayD);
    const off = signin.setNetworkSignInHandler(async (need) => { asked.push(need); return null; });
    const s1 = stream(stack);
    expect(await s1.connect(v4('127.0.0.1', P.echoPort))).toBeLessThan(0);
    expect(asked.length).toBe(1);
    expect(signin.networkStatus()).toBe('needs-sign-in');
    off();
    const store = new Map<string, string>();
    (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
    try {
      store.set('tabcomputer_github_token', 'good-token');
      const s2 = stream(stackFor(P.relayD));
      expect(await s2.connect(v4('127.0.0.1', P.echoPort))).toBe(0);
      await s2.write(enc.encode('hi'));
      const buf = new Uint8Array(16);
      expect(dec.decode(buf.subarray(0, await s2.read(buf)))).toBe('hi');
      await s2.close();
      expect(signin.networkStatus()).toBe('signed-in');
      // A relay the user chose (credentials: false) never gets the GitHub token
      // and never opens the sign-in sheet, even when it answers 401
      const asked2: unknown[] = [];
      const off2 = signin.setNetworkSignInHandler(async (need) => { asked2.push(need); return 'good-token'; });
      const s3 = stream(stackFor(P.relayD, P.origin, { credentials: false }));
      expect(await s3.connect(v4('127.0.0.1', P.echoPort))).toBeLessThan(0);
      expect(asked2).toEqual([]);
      off2();
    } finally {
      delete (globalThis as any).localStorage;
    }
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
  it('accepts FIONBIO on stream and datagram sockets (Python settimeout), ENOTTY for unknown ioctls', async () => {
    const stack = stackFor(P.relayA);
    const on = new Uint8Array([1, 0, 0, 0]);
    const t = stream(stack);
    expect(await t.ioctl(0x5421, on)).toBe(0);
    expect(await t.ioctl(0x5401 /* TCGETS */, new Uint8Array(60))).toBe(-25);
    const u = stack.socket(AF_INET, SOCK_DGRAM) as KDatagramSocket;
    expect(await u.ioctl(0x5421, on)).toBe(0);
  });

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

describe('x86 emulator socket syscalls', () => {
  async function setup(stack: NetStack) {
    const { LinuxSyscalls } = await import('@shiro/x86/syscalls');
    const { CPU, RAX, RDI, RSI, RDX, R8, R9, R10 } = await import('@shiro/x86/cpu');
    const { VirtualMemory } = await import('@shiro/x86/memory');
    const { FileSystem } = await import('@shiro/filesystem');
    const cpu = new CPU();
    const mem = new VirtualMemory();
    const fs = new FileSystem();
    await fs.init();
    const sys = new LinuxSyscalls(cpu, mem, fs, '/home/user', () => {}, () => {});
    sys.net = stack;
    const base = 0x600000n;
    mem.allocatePages(base, 4);
    const sc = async (nr: number, ...args: bigint[]) => {
      cpu.setReg64(RAX, BigInt(nr));
      [RDI, RSI, RDX, R10, R8, R9].forEach((r, i) => cpu.setReg64(r, args[i] ?? 0n));
      await sys.handleSyscall();
      return Number(BigInt.asIntN(64, cpu.getReg64(RAX)));
    };
    return { sc, mem, base };
  }

  it('socket/connect/write/shutdown/read/getpeername/poll/close through the relay', async () => {
    const { sc, mem, base } = await setup(stackFor(P.relayA));
    const SA = base, BUF = base + 0x100n, LEN = base + 0x80n, PFD = base + 0x90n;
    const fd = await sc(41, 2n, 1n, 0n); // socket(AF_INET, SOCK_STREAM, 0)
    expect(fd).toBeGreaterThanOrEqual(3);
    mem.writeBytes(SA, encodeSockaddr(v4('127.0.0.1', P.echoPort)));
    expect(await sc(42, BigInt(fd), SA, 16n)).toBe(0); // connect
    mem.writeBytes(BUF, enc.encode('x86 says hi'));
    expect(await sc(1, BigInt(fd), BUF, 11n)).toBe(11); // write
    // poll(POLLIN) waits for the echo
    mem.write32(PFD, fd); mem.write16(PFD + 4n, POLLIN); mem.write16(PFD + 6n, 0);
    expect(await sc(7, PFD, 1n, 5000n)).toBe(1);
    expect(mem.read16(PFD + 6n) & POLLIN).toBe(POLLIN);
    expect(await sc(48, BigInt(fd), 1n)).toBe(0); // shutdown(SHUT_WR)
    let got = '';
    for (;;) {
      const n = await sc(0, BigInt(fd), BUF, 4096n); // read
      if (n <= 0) { expect(n).toBe(0); break; }
      got += dec.decode(mem.readBytes(BUF, n));
    }
    expect(got).toBe('x86 says hi');
    mem.write32(LEN, 128);
    expect(await sc(52, BigInt(fd), SA, LEN)).toBe(0); // getpeername
    expect(decodeSockaddr(mem.readBytes(SA, mem.read32(LEN)))).toEqual(v4('127.0.0.1', P.echoPort));
    expect(await sc(3, BigInt(fd))).toBe(0);
    expect(await sc(0, BigInt(fd), BUF, 1n)).toBe(-9); // EBADF
  });

  it('bind/listen/accept4 and socketpair work in-kernel', async () => {
    const stack = new NetStack();
    stack.configure({ relayUrl: null, tokenUrl: null, dohUrl: null, portHost: null });
    const { sc, mem, base } = await setup(stack);
    const SA = base, BUF = base + 0x100n, LEN = base + 0x80n, SV = base + 0x90n;
    const lfd = await sc(41, 2n, 1n, 0n);
    mem.writeBytes(SA, encodeSockaddr(v4('127.0.0.1', 9090)));
    expect(await sc(49, BigInt(lfd), SA, 16n)).toBe(0); // bind
    expect(await sc(50, BigInt(lfd), 16n)).toBe(0); // listen
    const cfd = await sc(41, 2n, 1n | BigInt(SOCK_NONBLOCK), 0n);
    expect(await sc(42, BigInt(cfd), SA, 16n)).toBe(0); // loopback connect completes at once
    mem.write32(LEN, 128);
    const afd = await sc(288, BigInt(lfd), SA, LEN, 0n); // accept4
    expect(afd).toBeGreaterThan(cfd);
    expect((decodeSockaddr(mem.readBytes(SA, 16)) as any).address).toBe('127.0.0.1');
    expect(await sc(0, BigInt(cfd), BUF, 16n)).toBe(-EAGAIN); // nonblocking, nothing yet
    mem.writeBytes(BUF, enc.encode('pong'));
    expect(await sc(44, BigInt(afd), BUF, 4n, 0n, 0n, 0n)).toBe(4); // sendto
    expect(await sc(45, BigInt(cfd), BUF, 16n, 0n, 0n, 0n)).toBe(4); // recvfrom
    expect(await sc(53, 1n, 1n, 0n, SV)).toBe(0); // socketpair(AF_UNIX, SOCK_STREAM)
    const [a, b] = [mem.read32(SV), mem.read32(SV + 4n)];
    mem.writeBytes(BUF, enc.encode('z'));
    expect(await sc(1, BigInt(a), BUF, 1n)).toBe(1);
    expect(await sc(0, BigInt(b), BUF + 8n, 1n)).toBe(1);
    mem.writeBytes(SA, encodeSockaddr(v4('127.0.0.1', 9090)));
    expect(await sc(42, BigInt(await sc(41, 2n, 1n, 0n)), SA, 16n)).toBe(0);
    mem.writeBytes(SA, encodeSockaddr(v4('127.0.0.1', 9091)));
    expect(await sc(42, BigInt(await sc(41, 2n, 1n, 0n)), SA, 16n)).toBe(-ECONNREFUSED);
  });
});

describe('node net module over kernel sockets', () => {
  it('net.connect streams through the relay', async () => {
    const { createNetModule } = await import('@shiro/node-compat/modules/net-tls');
    const net = createNetModule({ stack: stackFor(P.relayA) });
    const result = await new Promise<string>((resolve, reject) => {
      let got = '';
      const s = net.connect(P.echoPort, '127.0.0.1', () => s.end('from node net'));
      s.setEncoding('utf8');
      s.on('data', (d: string) => { got += d; });
      s.on('error', reject);
      s.on('close', () => resolve(got));
    });
    expect(result).toBe('from node net');
  });

  it('net.connect reports relay refusals as errors', async () => {
    const { createNetModule } = await import('@shiro/node-compat/modules/net-tls');
    const net = createNetModule({ stack: stackFor(P.relayB) });
    const err: any = await new Promise((resolve) => {
      const s = net.connect({ host: '10.0.0.1', port: 80 });
      s.on('error', resolve);
    });
    expect(err.code).toBe('EACCES');
    expect(err.syscall).toBe('connect');
  });

  it('net.createServer accepts loopback connections in the page', async () => {
    const { createNetModule } = await import('@shiro/node-compat/modules/net-tls');
    const stack = new NetStack();
    stack.configure({ relayUrl: null, tokenUrl: null, dohUrl: null, portHost: null });
    const net = createNetModule({ stack });
    const server = net.createServer((sock: any) => sock.pipe(sock));
    await new Promise<void>((r) => server.listen(5555, r));
    expect(server.address().port).toBe(5555);
    const chunks: string[] = [];
    const client = net.connect({ port: 5555 });
    for await (const c of (client.end('echo me'), client)) chunks.push(dec.decode(c as Uint8Array));
    expect(chunks.join('')).toBe('echo me');
    await new Promise<void>((r) => server.close(() => r()));
  });
});

describe('relay failures reach the kernel log (dmesg)', () => {
  const lines = async () => (await import('@shiro/kernel/klog')).klog.all().map((r) => r.text);
  const connectFails = async (stack: NetStack, address: string, port: number) => {
    const s = stream(stack);
    const r = await s.connect(v4(address, port));
    await s.close();
    return r;
  };

  it('a token refused for the page origin', async () => {
    expect(await connectFails(stackFor(P.relayA, 'https://evil.example'), '127.0.0.1', P.echoPort)).toBe(-ENETUNREACH);
    expect(await lines()).toContain(`net: relay refused connect to 127.0.0.1:${P.echoPort}: this page's origin is not allowed (token 403)`);
  });

  it('a relay that needs sign-in', async () => {
    expect(await connectFails(stackFor(P.relayD, P.origin, { credentials: false }), '127.0.0.1', P.echoPort)).toBe(-ENETUNREACH);
    expect(await lines()).toContain(`net: relay refused connect to 127.0.0.1:${P.echoPort}: sign-in required (token 401)`);
  });

  it('a refused WebSocket handshake, with and without a token refresh', async () => {
    // No token at all: the relay refuses the upgrade (401), which the WebSocket API can't show
    expect(await connectFails(stackFor(P.relayA, P.origin, { tokenUrl: null }), '127.0.0.1', P.echoPort)).toBe(-ENETUNREACH);
    expect((await lines()).some((l) => l.startsWith(`net: relay refused connect to 127.0.0.1:${P.echoPort}: handshake refused`) && !l.includes('refresh'))).toBe(true);
    // A token from another relay: refused, refreshed, refused again
    const cross = stackFor(P.relayA, P.origin, { relayUrl: `ws://127.0.0.1:${P.relayE}/tcp` });
    expect(await connectFails(cross, '127.0.0.1', P.echoPort + 0)).toBe(-ENETUNREACH);
    expect((await lines()).some((l) => /^net: relay refused connect to 127\.0\.0\.1:\d+: handshake refused( \(close \d+[^)]*\))? after token refresh$/.test(l))).toBe(true);
  });

  it("the relay's own op:error replies", async () => {
    expect(await connectFails(stackFor(P.relayB), '10.0.0.1', 80)).toBe(-EACCES);
    expect((await lines()).some((l) => l.startsWith('net: relay refused connect to 10.0.0.1:80: EACCES'))).toBe(true);
  });

  it('no relay configured', async () => {
    const stack = new NetStack();
    stack.configure({ relayUrl: null, tokenUrl: null, dohUrl: null, portHost: null });
    expect(await connectFails(stack, '93.184.215.14', 443)).toBe(-ENETUNREACH);
    expect(await lines()).toContain('net: relay refused connect to 93.184.215.14:443: no relay configured');
  });

  it('a retry loop does not flood the log', async () => {
    const stack = stackFor(P.relayA, 'https://evil.example');
    for (let i = 0; i < 20; i++) await connectFails(stack, '127.0.0.1', 9);
    expect((await lines()).filter((l) => l === "net: relay refused connect to 127.0.0.1:9: this page's origin is not allowed (token 403)").length).toBe(5);
  });

  it('dmesg shows the reason', async () => {
    const { createTestShell } = await import('./helpers');
    const { shell } = await createTestShell();
    let out = '';
    await shell.execute('dmesg', (t) => { out += t; });
    expect(out).toMatch(/\] net: relay refused connect to 127\.0\.0\.1:\d+: this page's origin is not allowed \(token 403\)/);
  });
});

describe('kernel channel syscalls (netSyscall)', () => {
  it('socket/bind/listen/connect/accept4/sendto/recvfrom/getsockname/socketpair with a real FdTable', async () => {
    const { FdTable } = await import('@shiro/kernel/fd');
    const { netSyscall, SYS_socket, SYS_bind, SYS_listen, SYS_connect, SYS_accept4, SYS_sendto, SYS_recvfrom,
      SYS_getsockname, SYS_socketpair, SYS_shutdown } = await import('@shiro/kernel/net');
    const stack = new NetStack();
    stack.configure({ relayUrl: null, tokenUrl: null, dohUrl: null, portHost: null });
    const ac = new AbortController();
    const proc = { fds: new FdTable(), syscallSignal: ac.signal };
    const data = new Uint8Array(4096);
    const call = (nr: number, args: number[]) => netSyscall(proc, nr, args, data, undefined, stack);

    const lfd = await call(SYS_socket, [AF_INET, SOCK_STREAM, 0]) as number;
    data.set(encodeSockaddr(v4('0.0.0.0', 4242)));
    expect(await call(SYS_bind, [lfd, 16])).toBe(0);
    expect(await call(SYS_listen, [lfd, 4])).toBe(0);
    const cfd = await call(SYS_socket, [AF_INET, SOCK_STREAM, 0]) as number;
    data.set(encodeSockaddr(v4('127.0.0.1', 4242)));
    expect(await call(SYS_connect, [cfd, 16])).toBe(0);
    const afd = await call(SYS_accept4, [lfd, 0]) as number;
    expect(afd).toBeGreaterThan(cfd);
    expect((decodeSockaddr(data.subarray(0, 16)) as any).address).toBe('127.0.0.1');
    data.set(enc.encode('chan'));
    expect(await call(SYS_sendto, [cfd, 4, 0, 0])).toBe(4);
    expect(await call(SYS_recvfrom, [afd, 100, 0])).toBe(4);
    expect(dec.decode(data.subarray(0, 4))).toBe('chan');
    expect((decodeSockaddr(data.subarray(100, 128)) as any).port).toBeGreaterThan(0);
    expect(await call(SYS_getsockname, [afd])).toBe(16);
    expect(decodeSockaddr(data.subarray(0, 16))).toEqual(v4('127.0.0.1', 4242)); // the address the client dialed
    expect(await call(SYS_shutdown, [cfd, SHUT_WR])).toBe(0);
    expect(await call(SYS_recvfrom, [afd, 100, 0])).toBe(0);
    // A blocked recv ends with -EINTR when the process's syscall signal aborts
    const blocked = call(SYS_recvfrom, [cfd, 100, 0]);
    ac.abort();
    expect(await blocked).toBe(-4);
    expect(await call(SYS_socketpair, [1, SOCK_STREAM, 0])).toBe(0);
    const dv = new DataView(data.buffer);
    expect(dv.getInt32(4, true)).toBe(dv.getInt32(0, true) + 1);
    expect(await call(SYS_recvfrom, [lfd + 100, 1, 0])).toBe(-9);
    expect(await call(9999, [])).toBeUndefined();
    // Closing the last fd closes the listener (port free again)
    expect(await proc.fds.close(lfd)).toBe(0);
    expect(stack.listeners.has(4242)).toBe(false);
  });
});

describe('sockets in the kernel: registerSyscalls, epoll, SIGPIPE', () => {
  it('kernel.syscall reaches net.ts through installNet, and epoll sees socket readiness', async () => {
    const A = await import('@shiro/kernel/abi');
    const { Kernel } = await import('@shiro/kernel/kernel');
    const { installNet } = await import('@shiro/kernel/net');
    const kernel = new Kernel({ registerWithProcessTable: false });
    const stack = new NetStack();
    stack.configure({ relayUrl: null, tokenUrl: null, dohUrl: null, portHost: null });
    const off = installNet(kernel, stack);
    const proc = kernel.spawn({ path: 'net', fds: {}, run: () => new Promise<number>(() => {}) });
    const data = new Uint8Array(4096);
    const sys = (nr: number, args: number[]) => kernel.syscall(proc, nr, args, data);

    const l = await sys(A.SYS_socket, [A.AF_INET, A.SOCK_STREAM, 0]);
    data.set(encodeSockaddr(v4('0.0.0.0', 6060)));
    expect(await sys(A.SYS_bind, [l, 16])).toBe(0);
    expect(await sys(A.SYS_listen, [l, 8])).toBe(0);
    const c = await sys(A.SYS_socket, [A.AF_INET, A.SOCK_STREAM | A.SOCK_NONBLOCK, 0]);
    data.set(encodeSockaddr(v4('127.0.0.1', 6060)));
    expect(await sys(A.SYS_connect, [c, 16])).toBe(0);
    const a = await sys(A.SYS_accept4, [l, 0]);
    expect(a).toBeGreaterThanOrEqual(0);

    // epoll: edge-triggered EPOLLIN on the client socket
    const ep = await sys(A.SYS_epoll_create1, [0]);
    expect(await sys(A.SYS_epoll_ctl, [ep, A.EPOLL_CTL_ADD, c, A.EPOLLIN | A.EPOLLET, 77, 0])).toBe(0);
    expect(await sys(A.SYS_epoll_wait, [ep, 8, 0])).toBe(0);
    const waiting = sys(A.SYS_epoll_wait, [ep, 8, 5000]);
    await new Promise((r) => setTimeout(r, 10));
    const wdata = new Uint8Array(64);
    wdata.set(enc.encode('wake'));
    expect(await kernel.syscall(proc, A.SYS_write, [a, 4], wdata)).toBe(4);
    expect(await waiting).toBe(1);
    const dv = new DataView(data.buffer);
    expect(dv.getUint32(0, true) & A.EPOLLIN).toBe(A.EPOLLIN);
    expect(dv.getUint32(4, true)).toBe(77);
    expect(await sys(A.SYS_epoll_wait, [ep, 8, 0])).toBe(0); // ET: no new edge
    expect(await sys(A.SYS_read, [c, 64])).toBe(4);
    expect(await sys(A.SYS_read, [c, 64])).toBe(-EAGAIN);

    // send after the peer is gone: EPIPE and SIGPIPE (unless MSG_NOSIGNAL)
    expect(await sys(A.SYS_close, [a])).toBe(0);
    const delivered: number[] = [];
    const realDeliver = kernel.deliver.bind(kernel);
    kernel.deliver = (p: any, sig: number) => { delivered.push(sig); if (sig !== A.SIGPIPE) realDeliver(p, sig); };
    expect(await sys(A.SYS_sendto, [c, 1, A.MSG_NOSIGNAL, 0])).toBe(-A.EPIPE);
    expect(delivered).toEqual([]);
    expect(await sys(A.SYS_sendto, [c, 1, 0, 0])).toBe(-A.EPIPE);
    expect(delivered).toEqual([A.SIGPIPE]);
    kernel.deliver = realDeliver;

    off();
    expect(await sys(A.SYS_socket, [A.AF_INET, A.SOCK_STREAM, 0])).toBe(-A.ENOSYS);
    kernel.kill(proc.pid, A.SIGKILL);
  });

  it('x86 epoll_create1/epoll_ctl/epoll_wait over socket fds', async () => {
    const { LinuxSyscalls } = await import('@shiro/x86/syscalls');
    const { CPU, RAX, RDI, RSI, RDX, R8, R9, R10 } = await import('@shiro/x86/cpu');
    const { VirtualMemory } = await import('@shiro/x86/memory');
    const { FileSystem } = await import('@shiro/filesystem');
    const cpu = new CPU();
    const mem = new VirtualMemory();
    const fs = new FileSystem();
    await fs.init();
    const sys = new LinuxSyscalls(cpu, mem, fs, '/home/user', () => {}, () => {});
    const stack = new NetStack();
    stack.configure({ relayUrl: null, tokenUrl: null, dohUrl: null, portHost: null });
    sys.net = stack;
    const base = 0x700000n;
    mem.allocatePages(base, 4);
    const sc = async (nr: number, ...args: bigint[]) => {
      cpu.setReg64(RAX, BigInt(nr));
      [RDI, RSI, RDX, R10, R8, R9].forEach((r, i) => cpu.setReg64(r, args[i] ?? 0n));
      await sys.handleSyscall();
      return Number(BigInt.asIntN(64, cpu.getReg64(RAX)));
    };
    const SV = base, EV = base + 0x40n, OUT = base + 0x100n, BUF = base + 0x400n;
    expect(await sc(53, 1n, 1n, 0n, SV)).toBe(0); // socketpair
    const [x, y] = [mem.read32(SV), mem.read32(SV + 4n)];
    const ep = await sc(291, 0n);
    expect(ep).toBeGreaterThan(y);
    mem.write32(EV, POLLIN); mem.write32(EV + 4n, 0xabc); mem.write32(EV + 8n, 0);
    expect(await sc(233, BigInt(ep), 1n, BigInt(x), EV)).toBe(0); // EPOLL_CTL_ADD
    expect(await sc(232, BigInt(ep), OUT, 4n, 0n)).toBe(0);
    mem.writeBytes(BUF, enc.encode('e'));
    expect(await sc(1, BigInt(y), BUF, 1n)).toBe(1);
    expect(await sc(232, BigInt(ep), OUT, 4n, 1000n)).toBe(1);
    expect(mem.read32(OUT) & POLLIN).toBe(POLLIN);
    expect(mem.read32(OUT + 4n)).toBe(0xabc);
    // A dup keeps the socket alive in the interest list; closing every fd drops it
    const d = await sc(32, BigInt(x));
    expect(await sc(3, BigInt(x))).toBe(0);
    expect(await sc(232, BigInt(ep), OUT, 4n, 0n)).toBe(1);
    expect(await sc(3, BigInt(d))).toBe(0);
    expect(await sc(232, BigInt(ep), OUT, 4n, 0n)).toBe(0);
    expect(await sc(233, BigInt(ep), 1n, 0n, EV)).toBe(-1); // stdin is not a kernel file: EPERM
  });
});

describe('AF_UNIX path sockets and SCM_RIGHTS (tmux, screen)', () => {
  it('decodes a socket path from a shared buffer (browsers refuse to TextDecoder.decode one)', async () => {
    const A = await import('@shiro/kernel/abi');
    const shared = new Uint8Array(new SharedArrayBuffer(128));
    shared.set(encodeSockaddr({ family: A.AF_UNIX, address: '/tmp/tmux-1000/default', port: 0 }));
    const decode = TextDecoder.prototype.decode;
    TextDecoder.prototype.decode = function (this: TextDecoder, input?: AllowSharedBufferSource, opts?: TextDecodeOptions) {
      if (input && ArrayBuffer.isView(input) && input.buffer instanceof SharedArrayBuffer) throw new TypeError('The provided ArrayBufferView value must not be shared.');
      return decode.call(this, input, opts);
    };
    try {
      expect(decodeSockaddr(shared.subarray(0, 110))).toEqual({ family: A.AF_UNIX, address: '/tmp/tmux-1000/default', port: 0 });
    } finally {
      TextDecoder.prototype.decode = decode;
    }
  });

  it('bind makes a socket file; connect/accept by path; fds pass with SCM_RIGHTS; SO_PEERCRED', async () => {
    const A = await import('@shiro/kernel/abi');
    const { Kernel } = await import('@shiro/kernel/kernel');
    const { installNet } = await import('@shiro/kernel/net');
    const { createTestShell } = await import('./helpers');
    const { fs, shell } = await createTestShell();
    await fs.mkdir('/tmp/tmux-1000', { recursive: true });
    const kernel = new Kernel({ fs, shell, registerWithProcessTable: false });
    const stack = new NetStack();
    stack.configure({ relayUrl: null, tokenUrl: null, dohUrl: null, portHost: null });
    const off = installNet(kernel, stack);
    const server = kernel.spawn({ path: 'srv', cwd: '/tmp', fds: {}, run: () => new Promise<number>(() => {}) });
    const client = kernel.spawn({ path: 'cli', cwd: '/tmp/tmux-1000', fds: {}, run: () => new Promise<number>(() => {}) });
    const data = new Uint8Array(4096);
    const dv = new DataView(data.buffer);
    const sys = (p: typeof server, nr: number, args: number[]) => kernel.syscall(p, nr, args, data);
    const un = (path: string) => encodeSockaddr({ family: A.AF_UNIX, address: path, port: 0 });

    const l = await sys(server, A.SYS_socket, [A.AF_UNIX, A.SOCK_STREAM | A.SOCK_CLOEXEC, 0]);
    expect(l).toBeGreaterThanOrEqual(0);
    let sa = un('tmux-1000/default'); // relative to the server's cwd
    data.set(sa);
    expect(await sys(server, A.SYS_bind, [l, sa.length])).toBe(0);
    expect(await sys(server, A.SYS_bind, [l, sa.length])).toBe(-A.EINVAL);
    const st = await kernel.statPath(server, '/tmp/tmux-1000/default');
    expect(typeof st !== 'number' && (st.mode & A.S_IFMT)).toBe(A.S_IFSOCK);

    // nobody listening yet: ECONNREFUSED; a missing path: ENOENT
    const c = await sys(client, A.SYS_socket, [A.AF_UNIX, A.SOCK_STREAM, 0]);
    sa = un('default');
    data.set(sa);
    expect(await sys(client, A.SYS_connect, [c, sa.length])).toBe(-A.ECONNREFUSED);
    expect(await sys(server, A.SYS_listen, [l, 8])).toBe(0);
    sa = un('/tmp/tmux-1000/nope');
    data.set(sa);
    expect(await sys(client, A.SYS_connect, [c, sa.length])).toBe(-A.ENOENT);
    sa = un('default');
    data.set(sa);
    expect(await sys(client, A.SYS_connect, [c, sa.length])).toBe(0);
    const a = await sys(server, A.SYS_accept4, [l, A.SOCK_CLOEXEC]);
    expect(a).toBeGreaterThanOrEqual(0);
    // a second bind of the path while the file exists
    const l2 = await sys(server, A.SYS_socket, [A.AF_UNIX, A.SOCK_STREAM, 0]);
    sa = un('/tmp/tmux-1000/default');
    data.set(sa);
    expect(await sys(server, A.SYS_bind, [l2, sa.length])).toBe(-A.EADDRINUSE);

    // getsockname / getpeername / SO_PEERCRED
    let n = await sys(server, A.SYS_getsockname, [l]);
    expect(dec.decode(data.subarray(2, n - 1))).toBe('tmux-1000/default');
    n = await sys(client, A.SYS_getpeername, [c]);
    expect(dec.decode(data.subarray(2, n - 1))).toBe('tmux-1000/default');
    expect(await sys(client, A.SYS_getsockopt, [c, A.SOL_SOCKET, A.SO_PEERCRED])).toBe(server.pid);
    expect(await sys(server, A.SYS_getsockopt, [a, A.SOL_SOCKET, A.SO_PEERCRED])).toBe(client.pid);

    // the client passes the write end of a pipe; the server writes into it
    expect(await sys(client, A.SYS_pipe2, [0])).toBe(0);
    const [pr, pw] = [dv.getInt32(0, true), dv.getInt32(4, true)];
    data.set(enc.encode('id'));
    const cmsg = 2;
    dv.setBigUint64(cmsg, 20n, true);
    dv.setInt32(cmsg + 8, A.SOL_SOCKET, true);
    dv.setInt32(cmsg + 12, A.SCM_RIGHTS, true);
    dv.setInt32(cmsg + 16, pw, true);
    expect(await sys(client, A.SYS_sendmsg, [c, 2, 0, 0, 24])).toBe(2);
    expect(await sys(client, A.SYS_close, [pw])).toBe(0); // the message holds its own reference
    data.set(enc.encode('more'));
    expect(await sys(client, A.SYS_sendto, [c, 4, 0, 0])).toBe(4);
    data.fill(0);
    // descriptions end a message: "id" comes alone, with the fd
    n = await sys(server, A.SYS_recvmsg, [a, 64, A.MSG_CMSG_CLOEXEC, 64]);
    expect(n).toBe(2);
    expect(dec.decode(data.subarray(0, 2))).toBe('id');
    const meta = 64 + A.SOCKADDR_ROOM;
    expect(dv.getUint32(meta, true)).toBe(24); // CMSG_SPACE(4)
    expect(dv.getUint32(meta + 4, true)).toBe(0);
    expect(Number(dv.getBigUint64(meta + 8, true))).toBe(20);
    expect(dv.getInt32(meta + 16, true)).toBe(A.SOL_SOCKET);
    expect(dv.getInt32(meta + 20, true)).toBe(A.SCM_RIGHTS);
    const got = dv.getInt32(meta + 24, true);
    expect(server.fds.getCloexec(got)).toBe(true);
    expect(await sys(server, A.SYS_recvfrom, [a, 64, 0])).toBe(4);
    data.set(enc.encode('hello through a passed fd'));
    expect(await sys(server, A.SYS_write, [got, 25])).toBe(25);
    expect(await sys(server, A.SYS_close, [got])).toBe(0);
    data.fill(0);
    expect(await sys(client, A.SYS_read, [pr, 64])).toBe(25);
    expect(dec.decode(data.subarray(0, 25))).toBe('hello through a passed fd');
    expect(await sys(client, A.SYS_read, [pr, 64])).toBe(0); // every write end closed

    // too small a control buffer: MSG_CTRUNC, the fd is closed
    expect(await sys(client, A.SYS_pipe2, [0])).toBe(0);
    const pw2 = dv.getInt32(4, true);
    data.set(enc.encode('x'));
    dv.setBigUint64(1, 20n, true); dv.setInt32(9, A.SOL_SOCKET, true); dv.setInt32(13, A.SCM_RIGHTS, true); dv.setInt32(17, pw2, true);
    expect(await sys(client, A.SYS_sendmsg, [c, 1, 0, 0, 24])).toBe(1);
    expect(await sys(server, A.SYS_recvmsg, [a, 64, 0, 0])).toBe(1);
    expect(dv.getUint32(meta + 4, true)).toBe(A.MSG_CTRUNC);
    expect(client.fds.has(pw2)).toBe(true); // the sender's own fd stays open

    // unlink: connect sees ENOENT; closing the listener: ECONNREFUSED on a new file
    expect(await sys(server, A.SYS_close, [l])).toBe(0);
    const c2 = await sys(client, A.SYS_socket, [A.AF_UNIX, A.SOCK_STREAM, 0]);
    sa = un('/tmp/tmux-1000/default');
    data.set(sa);
    expect(await sys(client, A.SYS_connect, [c2, sa.length])).toBe(-A.ECONNREFUSED);
    data.set(enc.encode('/tmp/tmux-1000/default\0'));
    expect(await sys(server, A.SYS_unlink, [22])).toBe(0);
    expect(await fs.exists('/tmp/tmux-1000/default')).toBe(false);
    data.set(sa);
    expect(await sys(client, A.SYS_connect, [c2, sa.length])).toBe(-A.ENOENT);

    // abstract names live outside the filesystem
    const l3 = await sys(server, A.SYS_socket, [A.AF_UNIX, A.SOCK_STREAM, 0]);
    sa = un('\0shiro-abstract');
    data.set(sa);
    expect(await sys(server, A.SYS_bind, [l3, sa.length])).toBe(0);
    expect(await sys(server, A.SYS_listen, [l3, 1])).toBe(0);
    expect(await sys(client, A.SYS_connect, [c2, sa.length])).toBe(0);
    off();
  });
});
