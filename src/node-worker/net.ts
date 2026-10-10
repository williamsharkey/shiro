/**
 * Networking for node as a kernel guest (TABCOMPUTER_NODE_WORKER=1): the
 * page's net stack and virtual-server table live in the page, so in the
 * guest's Worker both are rebuilt over socket syscalls.
 *
 * - GuestNetStack: what node-compat's `net` module calls a stack (socket(),
 *   and sockets with async connect/read/write/accept), over non-blocking
 *   socket fds that one poller waits on from timers, so the program's event
 *   loop keeps running. Host names resolve over UDP/53 (the kernel answers
 *   with DNS-over-HTTPS).
 * - installGuestPorts: the guest's `iframeServer` (http.createServer,
 *   express, fetch('http://localhost:N')) on kernel sockets. A server listens
 *   on a real kernel port, which the kernel publishes on the page's port
 *   table, so previews, curl and other processes reach it; localhost
 *   requests connect to whatever listens there.
 */
import * as A from '../kernel/abi';
import type { GuestSys } from '../kernel/channel';
import { decodeSockaddr, encodeSockaddr, encodeHttpRequest, readHttpResponse, ipFamily, type SockAddr } from '../kernel/net';
import type { ByteChannel } from '../byte-pipe';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Waits for fds to become ready: one poll(2) per tick for every waiter, backing off while nothing happens */
class Poller {
  private waiters: { fd: number; events: number; resolve: (revents: number) => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private idle = 0;
  constructor(private sys: GuestSys) {}

  wait(fd: number, events: number): Promise<number> {
    return new Promise((resolve) => {
      this.waiters.push({ fd, events, resolve });
      this.idle = 0;
      this.schedule();
    });
  }

  /** Wake an fd's waiters (it was closed): they see POLLNVAL */
  cancel(fd: number): void {
    const gone = this.waiters.filter((w) => w.fd === fd);
    this.waiters = this.waiters.filter((w) => w.fd !== fd);
    for (const w of gone) w.resolve(A.POLLNVAL);
  }

  private schedule(): void {
    if (this.timer || !this.waiters.length) return;
    this.timer = setTimeout(() => this.tick(), this.idle);
  }

  private tick(): void {
    this.timer = null;
    const ws = this.waiters;
    if (!ws.length) return;
    const { ready, revents } = this.sys.poll(ws.map((w) => ({ fd: w.fd, events: w.events })), 0);
    if (ready > 0) {
      this.idle = 0;
      this.waiters = ws.filter((w, i) => {
        if (!revents[i]) return true;
        w.resolve(revents[i]);
        return false;
      });
    } else this.idle = Math.min(16, this.idle + 1);
    this.schedule();
  }
}

/** A socket fd with the async surface node-compat's net module uses (kernel/net.ts KSocket's) */
export class GuestSocket {
  private closed = false;
  constructor(private stack: GuestNetStack, readonly fd: number, readonly family: number) {
    stack.open.add(this);
  }
  private get sys() { return this.stack.sys; }

  async connect(addr: SockAddr): Promise<number> {
    let r = this.sys.connect(this.fd, encodeSockaddr(addr));
    if (r === -A.EINPROGRESS || r === -A.EALREADY) {
      const ev = await this.stack.poller.wait(this.fd, A.POLLOUT);
      if (ev & A.POLLNVAL) return -A.EBADF;
      r = this.sys.getsockopt(this.fd, A.SOL_SOCKET, A.SO_ERROR);
      if (r > 0) r = -r;
    }
    return r;
  }

  async connectHost(host: string, port: number): Promise<number> {
    const addr = host === 'localhost' ? '127.0.0.1' : ipFamily(host) ? host : await this.stack.resolve(host);
    if (typeof addr === 'number') return addr;
    return this.connect({ family: ipFamily(addr) === 6 ? A.AF_INET6 : A.AF_INET, address: addr, port });
  }

  async read(buf: Uint8Array): Promise<number> {
    for (;;) {
      if (this.closed) return -A.EBADF;
      const n = this.sys.read(this.fd, buf);
      if (n !== -A.EAGAIN) return n;
      if ((await this.stack.poller.wait(this.fd, A.POLLIN)) & A.POLLNVAL) return -A.EBADF;
    }
  }

  async write(bytes: Uint8Array): Promise<number> {
    for (;;) {
      if (this.closed) return -A.EBADF;
      const n = this.sys.write(this.fd, bytes);
      if (n !== -A.EAGAIN) return n;
      if ((await this.stack.poller.wait(this.fd, A.POLLOUT)) & A.POLLNVAL) return -A.EBADF;
    }
  }

  bind(addr: SockAddr): number { return this.sys.bind(this.fd, encodeSockaddr(addr)); }
  listen(backlog = 511): number { return this.sys.listen(this.fd, backlog); }

  async accept(): Promise<GuestSocket | number> {
    for (;;) {
      if (this.closed) return -A.EBADF;
      const r = this.sys.accept(this.fd, A.SOCK_NONBLOCK | A.SOCK_CLOEXEC);
      if (typeof r !== 'number') return new GuestSocket(this.stack, r.fd, this.family);
      if (r !== -A.EAGAIN) return r;
      if ((await this.stack.poller.wait(this.fd, A.POLLIN)) & A.POLLNVAL) return -A.EBADF;
    }
  }

  shutdown(how: number): number { return this.closed ? -A.EBADF : this.sys.shutdown(this.fd, how); }
  setsockopt(level: number, name: number, value: number): number { return this.closed ? -A.EBADF : this.sys.setsockopt(this.fd, level, name, value); }
  getsockname(): SockAddr {
    const b = this.closed ? -A.EBADF : this.sys.getsockname(this.fd);
    const a = typeof b === 'number' ? b : decodeSockaddr(b);
    return typeof a === 'number' ? { family: this.family, address: this.family === A.AF_INET6 ? '::' : '0.0.0.0', port: 0 } : a;
  }
  getpeername(): SockAddr | number {
    const b = this.closed ? -A.EBADF : this.sys.getpeername(this.fd);
    return typeof b === 'number' ? b : decodeSockaddr(b);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stack.open.delete(this);
    this.sys.close(this.fd);
    this.stack.poller.cancel(this.fd);
  }
}

export class GuestNetStack {
  readonly poller: Poller;
  /** Sockets not yet closed: they keep the guest running, as open handles keep node */
  readonly open = new Set<GuestSocket>();
  private dns = new Map<string, string>();

  constructor(readonly sys: GuestSys) { this.poller = new Poller(sys); }

  socket(family: number, type: number): GuestSocket | number {
    const fd = this.sys.socket(family, type | A.SOCK_NONBLOCK | A.SOCK_CLOEXEC);
    return fd < 0 ? fd : new GuestSocket(this, fd, family);
  }

  /** Whether open sockets should keep the program running */
  get busy(): boolean { return this.open.size > 0; }

  /** A host's IPv4 address (one A query over UDP/53), or -errno */
  async resolve(host: string): Promise<string | number> {
    const hit = this.dns.get(host);
    if (hit) return hit;
    const fd = this.sys.socket(A.AF_INET, A.SOCK_DGRAM | A.SOCK_NONBLOCK | A.SOCK_CLOEXEC);
    if (fd < 0) return fd;
    try {
      const id = (Math.random() * 0xffff) | 0;
      const q = dnsQuery(id, host);
      const r = this.sys.sendto(fd, q, 0, encodeSockaddr({ family: A.AF_INET, address: '127.0.0.53', port: 53 }));
      if (r < 0) return r;
      const buf = new Uint8Array(1500);
      const deadline = Date.now() + 10_000;
      for (;;) {
        const got = this.sys.recvfrom(fd, buf);
        if (typeof got !== 'number') {
          const addr = dnsAnswer(buf.subarray(0, got.n), id);
          if (addr === null) return -A.EHOSTUNREACH;
          this.dns.set(host, addr);
          return addr;
        }
        if (got !== -A.EAGAIN) return got;
        if (Date.now() > deadline) return -A.ETIMEDOUT;
        const pending = this.poller.wait(fd, A.POLLIN);
        const timeout = new Promise<number>((r) => setTimeout(() => r(0), deadline - Date.now()));
        await Promise.race([pending, timeout]);
      }
    } finally {
      this.sys.close(fd);
      this.poller.cancel(fd);
    }
  }
}

function dnsQuery(id: number, host: string): Uint8Array {
  const labels = host.replace(/\.$/, '').split('.').map((l) => enc.encode(l));
  const q = new Uint8Array(12 + labels.reduce((n, l) => n + l.length + 1, 0) + 5);
  const dv = new DataView(q.buffer);
  dv.setUint16(0, id);
  dv.setUint16(2, 0x0100); // recursion desired
  dv.setUint16(4, 1); // one question
  let o = 12;
  for (const l of labels) { q[o++] = l.length; q.set(l, o); o += l.length; }
  q[o++] = 0;
  dv.setUint16(o, 1); // A
  dv.setUint16(o + 2, 1); // IN
  return q;
}

/** The first A record's address in a DNS answer, or null */
function dnsAnswer(b: Uint8Array, id: number): string | null {
  if (b.length < 12) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint16(0) !== id || (dv.getUint16(2) & 0xf) !== 0) return null;
  const qd = dv.getUint16(4), an = dv.getUint16(6);
  let o = 12;
  const skipName = () => {
    while (o < b.length) {
      const len = b[o];
      if (len === 0) { o++; return; }
      if ((len & 0xc0) === 0xc0) { o += 2; return; }
      o += len + 1;
    }
  };
  for (let i = 0; i < qd; i++) { skipName(); o += 4; }
  for (let i = 0; i < an && o + 10 <= b.length; i++) {
    skipName();
    const type = dv.getUint16(o), len = dv.getUint16(o + 8);
    o += 10;
    if (type === 1 && len === 4) return `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
    o += len;
  }
  return null;
}

/** A connected socket as a ByteChannel (what http-server's raw-connection handler takes) */
function channelOf(s: GuestSocket): ByteChannel {
  const buf = new Uint8Array(64 * 1024);
  return {
    async read() {
      const n = await s.read(buf);
      return n > 0 ? buf.slice(0, n) : undefined;
    },
    async write(data: Uint8Array) {
      let off = 0;
      while (off < data.length) {
        const n = await s.write(data.subarray(off));
        if (n <= 0) throw new Error('EPIPE: connection closed');
        off += n;
      }
    },
    close() { void s.close(); },
  };
}

type VirtualRequest = { method: string; path: string; headers?: Record<string, string>; body?: string | Uint8Array | null; query?: Record<string, string> };
type VirtualResponse = { status?: number; statusText?: string; headers?: Record<string, string>; body?: any; contentType?: string };
type Handler = (req: VirtualRequest) => Promise<VirtualResponse> | VirtualResponse;

const STATUS: Record<number, string> = { 200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 404: 'Not Found', 500: 'Internal Server Error' };

/** One request over `conn` to a handler that takes whole requests (express's), answered with connection: close */
async function serveOne(conn: ByteChannel, handler: Handler): Promise<void> {
  let raw = new Uint8Array(0);
  const more = async () => {
    const c = await conn.read();
    if (!c) return false;
    const n = new Uint8Array(raw.length + c.length);
    n.set(raw); n.set(c, raw.length);
    raw = n;
    return true;
  };
  let end = -1;
  while ((end = headEnd(raw)) < 0) if (!(await more())) { conn.close(); return; }
  const lines = dec.decode(raw.subarray(0, end - 4)).split('\r\n');
  const [method, target] = lines[0].split(' ');
  const headers: Record<string, string> = {};
  for (const l of lines.slice(1)) {
    const c = l.indexOf(':');
    if (c > 0) headers[l.slice(0, c).trim().toLowerCase()] = l.slice(c + 1).trim();
  }
  const len = Number(headers['content-length'] || 0);
  while (raw.length - end < len) if (!(await more())) break;
  const body = raw.subarray(end, end + len);
  const q = target.indexOf('?');
  const req: VirtualRequest = {
    method, path: q < 0 ? target : target.slice(0, q), headers,
    query: q < 0 ? {} : Object.fromEntries(new URLSearchParams(target.slice(q + 1))),
    body: body.length ? dec.decode(body) : null,
  };
  let res: VirtualResponse;
  try { res = await handler(req); } catch (e: any) { res = { status: 500, body: String(e?.message ?? e) }; }
  const status = res.status ?? 200;
  const h: Record<string, string> = { ...(res.headers || {}) };
  if (res.contentType && !Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['content-type'] = res.contentType;
  for (const k of Object.keys(h)) if (/^(content-length|transfer-encoding|connection)$/i.test(k)) delete h[k];
  h.connection = 'close';
  const head = (b: Uint8Array | null) =>
    enc.encode(`HTTP/1.1 ${status} ${res.statusText || STATUS[status] || ''}\r\n` +
      Object.entries({ ...h, ...(b ? { 'content-length': String(b.length) } : {}) }).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
  try {
    if (res.body && typeof (res.body as any).getReader === 'function') {
      await conn.write(head(null)); // close-delimited
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        await conn.write(typeof value === 'string' ? enc.encode(value) : value);
      }
    } else {
      const b = res.body === undefined || res.body === null ? new Uint8Array(0)
        : typeof res.body === 'string' ? enc.encode(res.body)
          : res.body instanceof Uint8Array ? res.body : enc.encode(JSON.stringify(res.body));
      await conn.write(concat(head(b), method === 'HEAD' ? new Uint8Array(0) : b));
    }
  } catch { /* the client went away */ }
  conn.close();
}

function headEnd(b: Uint8Array): number {
  for (let i = 3; i < b.length; i++) if (b[i] === 10 && b[i - 1] === 13 && b[i - 2] === 10 && b[i - 3] === 13) return i + 1;
  return -1;
}

const concat = (a: Uint8Array, b: Uint8Array) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };

/** What the guest's iframeServer needs to do over kernel sockets */
export interface PortHost {
  serve(port: number, handler: Handler, name?: string, opts?: { connect?: (c: ByteChannel) => void }): () => void;
  connect(port: number): ByteChannel;
  fetch(port: number, path?: string, options?: Partial<VirtualRequest>): Promise<VirtualResponse>;
  close(port: number): void;
  isPortInUse(port: number): boolean;
  list(): { port: number; name?: string; hasIframe: boolean }[];
}

/**
 * Point `host` (the guest's iframeServer) at kernel ports. `onListen` hears
 * of each port a server starts listening on (the page opens its preview).
 */
export function installGuestPorts(host: PortHost, stack: GuestNetStack, onListen?: (port: number) => void): void {
  const served = new Map<number, { sock: GuestSocket; name?: string }>();

  host.serve = (port, handler, name, opts) => {
    if (served.has(port)) throw new Error(`Port ${port} already in use`);
    const s = stack.socket(A.AF_INET, A.SOCK_STREAM);
    if (typeof s === 'number') throw new Error(`socket: errno ${-s}`);
    s.setsockopt(A.SOL_SOCKET, A.SO_REUSEADDR, 1);
    let r = s.bind({ family: A.AF_INET, address: '0.0.0.0', port });
    if (r === 0) r = s.listen(511);
    if (r < 0) { void s.close(); throw new Error(r === -A.EADDRINUSE ? `Port ${port} already in use` : `listen: errno ${-r}`); }
    served.set(port, { sock: s, name });
    onListen?.(port);
    void (async () => {
      for (;;) {
        const c = await s.accept();
        if (typeof c === 'number') return;
        const conn = channelOf(c);
        if (opts?.connect) opts.connect(conn);
        else void serveOne(conn, handler);
      }
    })();
    return () => host.close(port);
  };

  host.close = (port) => {
    const e = served.get(port);
    if (!e) return;
    served.delete(port);
    void e.sock.close();
  };

  host.list = () => [...served].map(([port, e]) => ({ port, name: e.name, hasIframe: false }));

  // Anything on a kernel port counts (another process's server too): fetch() finds out
  host.isPortInUse = (port) => served.has(port) || port > 0;

  host.connect = (port) => {
    // A ByteChannel now, connected in the background (reads and writes wait for it)
    const s = stack.socket(A.AF_INET, A.SOCK_STREAM);
    if (typeof s === 'number') throw new Error(`socket: errno ${-s}`);
    const ready = s.connect({ family: A.AF_INET, address: '127.0.0.1', port });
    const ch = channelOf(s);
    const ok = async () => { if ((await ready) < 0) throw new Error(`ECONNREFUSED: no server listening on port ${port}`); };
    return {
      async read() { try { await ok(); } catch { return undefined; } return ch.read(); },
      async write(d: Uint8Array) { await ok(); return ch.write(d); },
      close() { ch.close(); },
    };
  };

  host.fetch = async (port, path = '/', options = {}) => {
    const s = stack.socket(A.AF_INET, A.SOCK_STREAM);
    if (typeof s === 'number') throw new Error(`socket: errno ${-s}`);
    const r = await s.connect({ family: A.AF_INET, address: '127.0.0.1', port });
    if (r < 0) {
      void s.close();
      const err: any = new TypeError('fetch failed');
      err.cause = Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:${port}`), { code: 'ECONNREFUSED', errno: r, syscall: 'connect', address: '127.0.0.1', port });
      throw err;
    }
    const method = (options.method || 'GET').toUpperCase();
    const req = encodeHttpRequest({ method, path, headers: options.headers, body: options.body ?? null, query: options.query } as any, port);
    for (let off = 0; off < req.length;) {
      const n = await s.write(req.subarray(off));
      if (n <= 0) break;
      off += n;
    }
    // a body still coming (server-sent events, a long poll) is a stream; the socket closes with it
    return readHttpResponse(s, method, 30_000) as Promise<VirtualResponse>;
  };
}
