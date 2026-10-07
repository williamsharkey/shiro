/**
 * Kernel sockets (docs/KERNEL_ABI.md `net.ts`, docs/NETWORKING.md).
 *
 * - AF_INET/AF_INET6 SOCK_STREAM sockets are OpenFiles (kind 'socket').
 *   Outbound connections go through the server's WebSocket-to-TCP relay
 *   (`/tcp` in server.mjs): one WebSocket per TCP connection.
 * - Connections to 127.0.0.1/::1/localhost never leave the page: they reach a
 *   socket listening in this kernel (a loopback pair).
 * - A listening socket is also published on Shiro's virtual-server port table
 *   (`iframeServer.serve`, the same table `http.createServer` uses), so a guest
 *   HTTP server on port N is reachable the way Shiro servers already are. Each
 *   virtual request becomes an accepted connection carrying a raw HTTP/1.1
 *   request; the guest's raw response is parsed back.
 * - SOCK_DGRAM supports DNS only: datagrams to port 53 are answered with
 *   DNS-over-HTTPS, so a guest's getaddrinfo() works without UDP.
 *
 * Errors are negative Linux errno values, as everywhere in the kernel ABI.
 */

import type { KStat } from './abi';
import type { FdTable, OpenFile } from './fd';
import {
  EPERM, EINTR, EIO, EBADF, EAGAIN, EACCES, EFAULT, EINVAL, EPIPE, ETIMEDOUT,
  O_NONBLOCK, POLLIN, POLLPRI, POLLOUT, POLLERR, POLLHUP, POLLNVAL, S_IFSOCK,
} from './abi';

export {
  EPERM, EINTR, EIO, EBADF, EAGAIN, EACCES, EFAULT, EINVAL, EPIPE, ETIMEDOUT,
  O_NONBLOCK, POLLIN, POLLPRI, POLLOUT, POLLERR, POLLHUP, POLLNVAL, S_IFSOCK,
};

// ── Socket ABI constants (Linux x86-64 values) not in abi.ts ──

export const AF_UNIX = 1, AF_INET = 2, AF_INET6 = 10;
export const SOCK_STREAM = 1, SOCK_DGRAM = 2, SOCK_NONBLOCK = 0o4000, SOCK_CLOEXEC = 0o2000000;
export const POLLRDHUP = 0x2000;
export const SHUT_RD = 0, SHUT_WR = 1, SHUT_RDWR = 2;
export const MSG_PEEK = 0x2, MSG_WAITALL = 0x100, MSG_DONTWAIT = 0x40, MSG_NOSIGNAL = 0x4000;
export const SOL_SOCKET = 1, IPPROTO_IP = 0, IPPROTO_TCP = 6, IPPROTO_UDP = 17, IPPROTO_IPV6 = 41;
export const SO_REUSEADDR = 2, SO_TYPE = 3, SO_ERROR = 4, SO_BROADCAST = 6, SO_SNDBUF = 7, SO_RCVBUF = 8,
  SO_KEEPALIVE = 9, SO_LINGER = 13, SO_REUSEPORT = 15, SO_RCVTIMEO = 20, SO_SNDTIMEO = 21,
  SO_ACCEPTCONN = 30, SO_PROTOCOL = 38, SO_DOMAIN = 39;
export const TCP_NODELAY = 1, TCP_KEEPIDLE = 4, TCP_KEEPINTVL = 5, TCP_KEEPCNT = 6;
export const IPV6_V6ONLY = 26;
export const FIONREAD = 0x541b, FIONBIO = 0x5421;

export const SYS_socket = 41, SYS_connect = 42, SYS_accept = 43, SYS_sendto = 44, SYS_recvfrom = 45,
  SYS_shutdown = 48, SYS_bind = 49, SYS_listen = 50, SYS_getsockname = 51, SYS_getpeername = 52,
  SYS_socketpair = 53, SYS_setsockopt = 54, SYS_getsockopt = 55, SYS_accept4 = 288;

export const EPROTO = 71, ENOTSOCK = 88, EDESTADDRREQ = 89, EMSGSIZE = 90, ENOPROTOOPT = 92, EPROTONOSUPPORT = 93,
  EOPNOTSUPP = 95, EAFNOSUPPORT = 97, EADDRINUSE = 98, EADDRNOTAVAIL = 99, ENETDOWN = 100, ENETUNREACH = 101,
  ECONNABORTED = 103, ECONNRESET = 104, ENOBUFS = 105, EISCONN = 106, ENOTCONN = 107,
  ECONNREFUSED = 111, EHOSTUNREACH = 113, EALREADY = 114, EINPROGRESS = 115, EDQUOT = 122;

/** errno names the relay sends → numbers (unknown names map to EIO). */
const ERRNO_BY_NAME: Record<string, number> = {
  EPERM, EIO, EACCES, EINVAL, EPIPE, EPROTO, ENETDOWN, ENETUNREACH, ECONNABORTED, ECONNRESET, ENOBUFS,
  ETIMEDOUT, ECONNREFUSED, EHOSTUNREACH, EDQUOT, EADDRNOTAVAIL,
  EBADF, EAGAIN, EADDRINUSE, EAFNOSUPPORT, EOPNOTSUPP, EMSGSIZE, EDESTADDRREQ, EISCONN, ENOTCONN,
  EALREADY, EINPROGRESS, ENOTSOCK,
  ENOTFOUND: EHOSTUNREACH, EAI_AGAIN: EHOSTUNREACH,
};
export const errnoName = (e: number): string =>
  Object.entries(ERRNO_BY_NAME).find(([k, v]) => v === e && !k.startsWith('EAI') && k !== 'ENOTFOUND')?.[0] ?? `E${e}`;

// ── Types ──

export interface SockAddr {
  family: number;   // AF_INET | AF_INET6
  address: string;  // dotted quad or IPv6 text (no brackets)
  port: number;
}

/** Where listening sockets get published so Shiro's preview/fetch path can reach them. */
export interface PortHost {
  serve(port: number, handler: (req: VirtualHttpRequest) => Promise<VirtualHttpResponse>, name?: string): () => void;
  isPortInUse?(port: number): boolean;
}
export interface VirtualHttpRequest {
  method: string; path: string; headers?: Record<string, string>; body?: string | null; query?: Record<string, string>;
}
export interface VirtualHttpResponse {
  status?: number; statusText?: string; headers?: Record<string, string>; body?: string | Uint8Array;
}

export interface NetConfig {
  /** ws(s) URL of the relay, e.g. wss://shiro.computer/tcp. null disables outbound TCP. */
  relayUrl: string | null;
  /** POST endpoint that returns {token, expires}; null = connect without a token. */
  tokenUrl: string | null;
  /** DNS-over-HTTPS endpoint (RFC 8484) used for UDP/53 and as a resolver fallback. */
  dohUrl: string | null;
  WebSocket?: typeof WebSocket;
  fetch?: typeof fetch;
  /** null: don't publish listeners. undefined: lazily use iframeServer. */
  portHost?: PortHost | null;
  /** Bytes queued for sending before write() blocks / POLLOUT clears. */
  sndbuf: number;
  /** Ack consumed bytes to the relay every this many bytes (its window is 512 KiB). */
  ackEvery: number;
  /** Timeout for one bridged HTTP request to a guest listener. */
  httpBridgeTimeoutMs: number;
  /** Send loopback connects with no kernel listener to the relay (tests, dev relays that allow 127.0.0.1). */
  relayLoopback: boolean;
}

function defaultConfig(): NetConfig {
  const loc = typeof location !== 'undefined' ? location : null;
  const web = !!loc && (loc.protocol === 'https:' || loc.protocol === 'http:') && !!loc.host;
  return {
    relayUrl: web ? `${loc!.protocol === 'https:' ? 'wss' : 'ws'}://${loc!.host}/tcp` : null,
    tokenUrl: web ? `${loc!.protocol}//${loc!.host}/tcp/token` : null,
    dohUrl: 'https://cloudflare-dns.com/dns-query',
    sndbuf: 256 * 1024,
    ackEvery: 64 * 1024,
    httpBridgeTimeoutMs: 30_000,
    relayLoopback: false,
  };
}

// ── Address helpers ──

export function ipFamily(addr: string): 0 | 4 | 6 {
  if (/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(addr)) return 4;
  if (addr.includes(':') && /^[0-9a-fA-F:.]+$/.test(addr) && (addr.match(/::/g) || []).length <= 1) return 6;
  return 0;
}

export function isLoopback(addr: string): boolean {
  return /^127\./.test(addr) || addr === '::1' || addr === '0.0.0.0' || addr === '::' || /^::ffff:127\./i.test(addr);
}

/** Expand an IPv6 address to 8 16-bit groups (handles :: and an embedded IPv4 tail). */
export function ipv6Groups(addr: string): number[] {
  let a = addr.toLowerCase();
  const v4 = a.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const p = v4[1].split('.').map(Number);
    a = a.slice(0, -v4[1].length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const [head, tail] = a.includes('::') ? a.split('::') : [a, null];
  const h = head ? head.split(':').filter(Boolean).map((x) => parseInt(x, 16)) : [];
  const t = tail ? tail.split(':').filter(Boolean).map((x) => parseInt(x, 16)) : [];
  const fill = tail === null ? [] : new Array(8 - h.length - t.length).fill(0);
  return [...h, ...fill, ...t].slice(0, 8);
}

export function formatIpv6(groups: number[]): string {
  // RFC 5952: compress the longest run of zero groups (length ≥ 2)
  let best = -1, bestLen = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) { i++; continue; }
    let j = i; while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) { best = i; bestLen = j - i; }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best < 0) return hex.join(':');
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`;
}

/** Encode a sockaddr_in / sockaddr_in6 (Linux layout, network byte order port). */
export function encodeSockaddr(sa: SockAddr): Uint8Array {
  if (sa.family === AF_INET6) {
    const b = new Uint8Array(28);
    const dv = new DataView(b.buffer);
    dv.setUint16(0, AF_INET6, true);
    dv.setUint16(2, sa.port, false);
    ipv6Groups(sa.address).forEach((g, i) => dv.setUint16(8 + i * 2, g, false));
    return b;
  }
  const b = new Uint8Array(16);
  const dv = new DataView(b.buffer);
  dv.setUint16(0, AF_INET, true);
  dv.setUint16(2, sa.port, false);
  sa.address.split('.').forEach((o, i) => { b[4 + i] = Number(o) & 0xff; });
  return b;
}

/** Decode a sockaddr; returns -errno on a bad family/length. */
export function decodeSockaddr(b: Uint8Array): SockAddr | number {
  if (b.length < 2) return -EINVAL;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const family = dv.getUint16(0, true);
  if (family === AF_INET) {
    if (b.length < 8) return -EINVAL;
    return { family, port: dv.getUint16(2, false), address: `${b[4]}.${b[5]}.${b[6]}.${b[7]}` };
  }
  if (family === AF_INET6) {
    if (b.length < 24) return -EINVAL;
    const g: number[] = [];
    for (let i = 0; i < 8; i++) g.push(dv.getUint16(8 + i * 2, false));
    // IPv4-mapped (::ffff:a.b.c.d) keeps its dotted form, like inet_ntop
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
      return { family, port: dv.getUint16(2, false), address: `::ffff:${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}` };
    }
    return { family, port: dv.getUint16(2, false), address: formatIpv6(g) };
  }
  return -EAFNOSUPPORT;
}

// ── Wait queue ──

class WaitQueue {
  private waiters = new Set<() => void>();
  private ready = new Set<() => void>();
  wait(timeoutMs = 0, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let t: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        this.waiters.delete(done);
        if (t) clearTimeout(t);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      this.waiters.add(done);
      if (timeoutMs > 0) t = setTimeout(done, timeoutMs);
      signal?.addEventListener('abort', done);
    });
  }
  onReady(cb: () => void): () => void {
    this.ready.add(cb);
    return () => { this.ready.delete(cb); };
  }
  notify(): void {
    for (const w of [...this.waiters]) w();
    for (const cb of [...this.ready]) { try { cb(); } catch { /* subscriber's problem */ } }
  }
}

// ── Stream transports ──

/** What a connected stream socket talks to: the relay, or the other end of a loopback pair. */
interface StreamPeer {
  send(data: Uint8Array): void;
  shutdownWrite(): void;
  close(): void;
  /** The application consumed n received bytes. */
  consumed(n: number): void;
  /** Bytes accepted by send() and not yet handed to the network / peer reader. */
  buffered(): number;
}

class LoopbackPeer implements StreamPeer {
  constructor(private self: KSocket, private other: KSocket) {}
  send(data: Uint8Array) { this.other._deliver(data.slice()); }
  shutdownWrite() { this.other._eof(); }
  close() { this.other._eof(); this.other._peerGone(); }
  consumed() { this.other._wake(); } // the writer on the other side may be waiting for room
  buffered() { return this.other._rxBytes(); }
}

interface RelayConnected { remoteAddress: string; remotePort: number; family: number }

class RelayPeer implements StreamPeer {
  private unacked = 0;
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  constructor(private ws: WebSocket, private sock: KSocket, private stack: NetStack) {}

  /** Open a relay connection; resolves once the TCP connection is up (or rejects with errno). */
  static open(stack: NetStack, sock: KSocket, host: string, port: number): Promise<{ peer: RelayPeer; info: RelayConnected }> {
    return stack.openRelay({ op: 'connect', host, port }, (ws, msg, settle) => {
      if (msg.op === 'connected') {
        const peer = new RelayPeer(ws, sock, stack);
        peer.attach();
        settle({ peer, info: msg as unknown as RelayConnected });
        return true;
      }
      return false;
    });
  }

  private attach() {
    const ws = this.ws;
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let msg: any;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.op === 'eof') this.sock._eof();
        else if (msg.op === 'error') this.sock._error(ERRNO_BY_NAME[msg.code] ?? EIO);
        return;
      }
      this.sock._deliver(new Uint8Array(ev.data as ArrayBuffer));
    };
    ws.onclose = () => { this.stopDrain(); this.sock._eof(); this.sock._peerGone(); };
    ws.onerror = () => { this.sock._error(ECONNRESET); };
  }

  send(data: Uint8Array) {
    if (this.ws.readyState !== 1) return;
    // The relay caps frames at 256 KiB
    for (let off = 0; off < data.length; off += 64 * 1024) this.ws.send(data.slice(off, off + 64 * 1024));
    this.startDrain();
  }
  shutdownWrite() { if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ op: 'shutdown' })); }
  close() { this.stopDrain(); try { this.ws.close(1000); } catch { /* already closed */ } }
  consumed(n: number) {
    this.unacked += n;
    if (this.unacked >= this.stack.config.ackEvery && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({ op: 'ack', n: this.unacked }));
      this.unacked = 0;
    }
  }
  buffered() { return this.ws.bufferedAmount; }
  // WebSocket has no drain event: watch bufferedAmount while data is queued so
  // writers blocked on SNDBUF and POLLOUT waiters wake up.
  private startDrain() {
    if (this.drainTimer || this.ws.bufferedAmount === 0) return;
    this.drainTimer = setInterval(() => {
      if (this.ws.bufferedAmount < this.stack.config.sndbuf) this.sock._wake();
      if (this.ws.bufferedAmount === 0 || this.ws.readyState !== 1) this.stopDrain();
    }, 10);
  }
  private stopDrain() { if (this.drainTimer) { clearInterval(this.drainTimer); this.drainTimer = null; } }
}

// ── Stream socket ──

type StreamState = 'unbound' | 'bound' | 'listening' | 'connecting' | 'connected' | 'closed';

const sockStat = (ino: number): KStat => {
  const now = Date.now();
  return { dev: 0, ino, mode: S_IFSOCK | 0o777, nlink: 1, uid: 0, gid: 0, rdev: 0, size: 0, blksize: 4096, blocks: 0, atimeMs: now, mtimeMs: now, ctimeMs: now };
};

export class KSocket implements OpenFile {
  readonly kind = 'socket' as const;
  readonly type = SOCK_STREAM;
  flags: number;
  state: StreamState = 'unbound';
  local: SockAddr | null = null;
  remote: SockAddr | null = null;
  readonly ino: number;

  private q = new WaitQueue();
  private rx: Uint8Array[] = [];
  private rxLen = 0;
  private rxEof = false;
  private rdShut = false;
  private wrShut = false;
  private everConnected = false;
  private soError = 0;
  private peer: StreamPeer | null = null;
  private backlog: KSocket[] = [];
  private backlogMax = 128;
  private unpublish: (() => void) | null = null;
  private opts = new Map<string, number>();

  constructor(private stack: NetStack, readonly domain: number, readonly protocol = 0, flags = 0) {
    this.flags = flags;
    this.ino = stack.nextIno++;
  }

  private get nonblock() { return (this.flags & O_NONBLOCK) !== 0; }

  // ── events from the peer ──
  /** @internal */ _deliver(data: Uint8Array) {
    if (this.rdShut || !data.length) return;
    this.rx.push(data); this.rxLen += data.length; this.q.notify();
  }
  /** @internal */ _eof() { if (!this.rxEof) { this.rxEof = true; this.q.notify(); } }
  /** @internal */ _error(errno: number) { this.soError = errno; this.q.notify(); }
  /** @internal */ _peerGone() { this.wrShut = true; this.q.notify(); }
  /** @internal */ _wake() { this.q.notify(); }
  /** @internal */ _rxBytes() { return this.rxLen; }
  /** @internal */ _attach(peer: StreamPeer, local: SockAddr, remote: SockAddr) {
    this.peer = peer; this.local = local; this.remote = remote;
    this.state = 'connected'; this.everConnected = true; this.q.notify();
  }
  /** @internal Queue an incoming connection; false if the backlog is full. */
  _enqueue(s: KSocket): boolean {
    if (this.state !== 'listening' || this.backlog.length >= this.backlogMax) return false;
    this.backlog.push(s); this.q.notify();
    return true;
  }

  // ── OpenFile ──

  read(buf: Uint8Array, signal?: AbortSignal): Promise<number> { return this.recv(buf, 0, signal); }
  write(buf: Uint8Array, signal?: AbortSignal): Promise<number> { return this.send(buf, 0, signal); }

  async recv(buf: Uint8Array, msgFlags = 0, signal?: AbortSignal): Promise<number> {
    const dontwait = this.nonblock || (msgFlags & MSG_DONTWAIT) !== 0;
    const timeout = this.opts.get(`${SOL_SOCKET}:${SO_RCVTIMEO}`) || 0;
    let got = 0;
    for (;;) {
      if (this.rxLen > 0 && got < buf.length) {
        got += this.take(buf.subarray(got), (msgFlags & MSG_PEEK) !== 0);
        if (!(msgFlags & MSG_WAITALL) || got === buf.length || (msgFlags & MSG_PEEK)) return got;
        continue;
      }
      if (got > 0 && (this.rxEof || this.rdShut || this.soError)) return got;
      if (buf.length === 0) return 0;
      if (this.soError) return -this.takeError();
      if (this.rxEof || this.rdShut) return 0;
      if (this.state === 'closed') return -EBADF;
      if (this.state !== 'connected' && this.state !== 'connecting') return -ENOTCONN;
      if (dontwait) return got || -EAGAIN;
      if (signal?.aborted) return got || -EINTR;
      const t0 = Date.now();
      await this.q.wait(timeout, signal);
      if (timeout && Date.now() - t0 >= timeout && this.rxLen === 0) return got || -EAGAIN;
    }
  }

  private take(out: Uint8Array, peek: boolean): number {
    let n = 0;
    let i = 0;
    while (n < out.length && i < this.rx.length) {
      const chunk = this.rx[i];
      const k = Math.min(chunk.length, out.length - n);
      out.set(chunk.subarray(0, k), n);
      n += k;
      if (peek) { i++; continue; }
      if (k === chunk.length) this.rx.shift(); else this.rx[0] = chunk.subarray(k);
    }
    if (!peek) { this.rxLen -= n; this.peer?.consumed(n); }
    return n;
  }

  private takeError(): number { const e = this.soError; this.soError = 0; return e; }

  async send(buf: Uint8Array, msgFlags = 0, signal?: AbortSignal): Promise<number> {
    const dontwait = this.nonblock || (msgFlags & MSG_DONTWAIT) !== 0;
    for (;;) {
      if (this.soError) return -this.takeError();
      if (this.state === 'connecting') {
        if (dontwait) return -EAGAIN;
        if (signal?.aborted) return -EINTR;
        await this.q.wait(0, signal);
        continue;
      }
      // EPIPE (the kernel raises SIGPIPE unless MSG_NOSIGNAL) once our side or the peer is gone
      if (this.wrShut) return -EPIPE;
      if (this.state !== 'connected' || !this.peer) return this.everConnected ? -EPIPE : -ENOTCONN;
      if (buf.length === 0) return 0;
      const room = this.stack.config.sndbuf - this.peer.buffered();
      if (room <= 0) {
        if (dontwait) return -EAGAIN;
        if (signal?.aborted) return -EINTR;
        await this.q.wait(50, signal);
        continue;
      }
      // Blocking sockets take the whole buffer (like Linux); nonblocking take what fits.
      const n = dontwait ? Math.min(room, buf.length) : buf.length;
      this.peer.send(buf.subarray(0, n));
      return n;
    }
  }

  poll(events: number): number {
    let r = 0;
    if (this.soError) r |= POLLERR;
    switch (this.state) {
      case 'listening':
        if (this.backlog.length) r |= POLLIN;
        break;
      case 'connecting':
        break;
      case 'connected':
        if (this.rxLen > 0 || this.rxEof || this.rdShut) r |= POLLIN;
        if (this.rxEof) r |= POLLRDHUP;
        if (!this.wrShut && this.peer && this.peer.buffered() < this.stack.config.sndbuf) r |= POLLOUT;
        if (this.rxEof && this.wrShut) r |= POLLHUP;
        break;
      case 'closed':
        r |= POLLNVAL;
        break;
      default:
        // Never-connected stream socket: Linux reports POLLOUT|POLLHUP
        r |= POLLOUT | POLLHUP;
    }
    return r & (events | POLLERR | POLLHUP | POLLNVAL);
  }

  onReady(cb: () => void): () => void { return this.q.onReady(cb); }

  async ioctl(req: number, arg: Uint8Array): Promise<number> {
    if (req === FIONREAD) {
      if (arg.length < 4) return -EINVAL;
      new DataView(arg.buffer, arg.byteOffset, 4).setInt32(0, this.rxLen, true);
      return 0;
    }
    return -EINVAL;
  }

  async stat(): Promise<KStat> { return sockStat(this.ino); }

  async close(): Promise<void> {
    if (this.state === 'closed') return;
    const wasListening = this.state === 'listening';
    this.state = 'closed';
    if (wasListening) {
      this.unpublish?.(); this.unpublish = null;
      this.stack.listeners.delete(this.local!.port);
      for (const s of this.backlog.splice(0)) await s.close();
    }
    if (this.local) this.stack.releasePort(this.local.port, this);
    this.peer?.close();
    this.peer = null;
    this.rx = []; this.rxLen = 0;
    this.q.notify();
  }

  // ── socket calls ──

  async connect(addr: SockAddr, signal?: AbortSignal): Promise<number> {
    if (addr.family !== this.domain && !(this.domain === AF_INET6 && addr.family === AF_INET)) return -EAFNOSUPPORT;
    const r = this.beginConnect();
    if (r) return r;
    return this.finishConnect(addr.address, addr.port, () => ({ ...addr }), signal);
  }

  /** Connect by host name (node-compat net.connect): the relay resolves it, so there's one lookup. */
  async connectHost(host: string, port: number): Promise<number> {
    const r = this.beginConnect();
    if (r) return r;
    if (host === 'localhost' || host === '') host = this.domain === AF_INET6 ? '::1' : '127.0.0.1';
    return this.finishConnect(host, port, (info) => ({ family: info?.family === 6 ? AF_INET6 : AF_INET, address: info?.remoteAddress ?? host, port }));
  }

  private beginConnect(): number {
    switch (this.state) {
      case 'connected': return -EISCONN;
      case 'connecting': return -EALREADY;
      case 'listening': return -EINVAL;
      case 'closed': return -EBADF;
    }
    if (this.everConnected) return -EISCONN;
    return 0;
  }

  private async finishConnect(host: string, port: number, remoteOf: (info?: RelayConnected) => SockAddr, signal?: AbortSignal): Promise<number> {
    const stack = this.stack;
    // Loopback: only sockets listening in this kernel
    const listener = isLoopback(host) ? stack.listeners.get(port) : undefined;
    if (isLoopback(host) && !listener && !stack.config.relayLoopback) return -ECONNREFUSED;
    if (listener) {
      const local = this.local ?? stack.autobindAddr(this.domain === AF_INET6 && host.includes(':') ? AF_INET6 : AF_INET, this, host);
      const server = new KSocket(stack, listener.domain, 0, 0);
      server.local = { ...listener.local!, address: host === '0.0.0.0' || host === '::' ? listener.local!.address : host };
      if (!listener._enqueue(server)) return -ECONNREFUSED;
      server._attach(new LoopbackPeer(server, this), server.local, { ...local });
      this._attach(new LoopbackPeer(this, server), local, remoteOf());
      return 0;
    }
    if (!stack.config.relayUrl) return -ENETUNREACH;
    this.state = 'connecting';
    const p = RelayPeer.open(stack, this, host, port).then(
      ({ peer, info }) => {
        if (this.state !== 'connecting') { peer.close(); return 0; }
        const remote = remoteOf(info);
        const local = this.local ?? { family: remote.family, address: remote.family === AF_INET6 ? 'fd00::15' : '10.0.2.15', port: stack.ephemeral() };
        this._attach(peer, local, remote);
        return 0;
      },
      (errno: number) => {
        if (this.state === 'connecting') this.state = this.local ? 'bound' : 'unbound';
        this.soError = errno; this.q.notify();
        return -errno;
      },
    );
    if (this.nonblock) return -EINPROGRESS;
    // A signal interrupts a blocking connect, which then completes in the background (Linux: EINTR)
    const r = signal
      ? await Promise.race([p, new Promise<number>((res) => {
          if (signal.aborted) res(-EINTR); else signal.addEventListener('abort', () => res(-EINTR), { once: true });
        })])
      : await p;
    if (r === -EINTR) return r;
    if (r < 0) this.soError = 0; // reported by connect() itself
    return r;
  }

  bind(addr: SockAddr): number {
    if (this.state === 'closed') return -EBADF;
    if (this.local) return -EINVAL;
    if (!isLoopback(addr.address) && addr.address !== '10.0.2.15') return -EADDRNOTAVAIL;
    let port = addr.port;
    if (port === 0) port = this.stack.ephemeral();
    else if (!this.stack.claimPort(port, this, this.getOpt(SOL_SOCKET, SO_REUSEADDR) !== 0)) return -EADDRINUSE;
    this.local = { family: addr.family, address: addr.address, port };
    if (this.state === 'unbound') this.state = 'bound';
    return 0;
  }

  listen(backlog = 128): number {
    if (this.state === 'listening') { this.backlogMax = Math.max(1, Math.min(backlog, 4096)); return 0; }
    if (this.state !== 'unbound' && this.state !== 'bound') return -EINVAL;
    if (!this.local) {
      this.local = this.stack.autobindAddr(this.domain, this, this.domain === AF_INET6 ? '::' : '0.0.0.0');
    }
    if (this.stack.listeners.has(this.local.port)) return -EADDRINUSE;
    this.backlogMax = Math.max(1, Math.min(backlog || 1, 4096));
    this.state = 'listening';
    this.stack.listeners.set(this.local.port, this);
    this.unpublish = this.stack.publish(this);
    return 0;
  }

  /** Accept a connection: the new socket (flags from accept4) or -errno. */
  async accept(flags = 0, signal?: AbortSignal): Promise<KSocket | number> {
    for (;;) {
      if (this.state !== 'listening') return -EINVAL;
      const s = this.backlog.shift();
      if (s) {
        if (flags & SOCK_NONBLOCK) s.flags |= O_NONBLOCK;
        return s;
      }
      if (this.nonblock) return -EAGAIN;
      if (signal?.aborted) return -EINTR;
      await this.q.wait(0, signal);
    }
  }

  shutdown(how: number): number {
    if (how !== SHUT_RD && how !== SHUT_WR && how !== SHUT_RDWR) return -EINVAL;
    if (this.state !== 'connected') return -ENOTCONN;
    if (how !== SHUT_WR) { this.rdShut = true; this.rx = []; this.rxLen = 0; }
    if (how !== SHUT_RD && !this.wrShut) { this.wrShut = true; this.peer?.shutdownWrite(); }
    this.q.notify();
    return 0;
  }

  getsockname(): SockAddr {
    return this.local ? { ...this.local } : { family: this.domain, address: this.domain === AF_INET6 ? '::' : '0.0.0.0', port: 0 };
  }

  getpeername(): SockAddr | number {
    return this.state === 'connected' && this.remote ? { ...this.remote } : -ENOTCONN;
  }

  private getOpt(level: number, name: number) { return this.opts.get(`${level}:${name}`) ?? 0; }

  getsockopt(level: number, name: number): number {
    if (level === SOL_SOCKET) {
      switch (name) {
        case SO_ERROR: return this.takeError();
        case SO_TYPE: return SOCK_STREAM;
        case SO_DOMAIN: return this.domain;
        case SO_PROTOCOL: return IPPROTO_TCP;
        case SO_ACCEPTCONN: return this.state === 'listening' ? 1 : 0;
        case SO_SNDBUF: return this.opts.get(`${level}:${name}`) ?? this.stack.config.sndbuf;
        case SO_RCVBUF: return this.opts.get(`${level}:${name}`) ?? 512 * 1024;
        case SO_REUSEADDR: case SO_REUSEPORT: case SO_KEEPALIVE: case SO_BROADCAST: case SO_LINGER:
        case SO_RCVTIMEO: case SO_SNDTIMEO:
          return this.getOpt(level, name);
      }
      return -ENOPROTOOPT;
    }
    if (level === IPPROTO_TCP) {
      if (name === TCP_NODELAY || name === TCP_KEEPIDLE || name === TCP_KEEPINTVL || name === TCP_KEEPCNT) return this.getOpt(level, name);
      return -ENOPROTOOPT;
    }
    if (level === IPPROTO_IPV6 && name === IPV6_V6ONLY) return this.getOpt(level, name);
    return -ENOPROTOOPT;
  }

  /** Store an int option (timeouts in ms). TCP tuning is accepted and recorded; the relay always sets TCP_NODELAY. */
  setsockopt(level: number, name: number, value: number): number {
    if (level === SOL_SOCKET && (name === SO_ERROR || name === SO_TYPE || name === SO_DOMAIN || name === SO_PROTOCOL || name === SO_ACCEPTCONN)) return -ENOPROTOOPT;
    if (level !== SOL_SOCKET && level !== IPPROTO_TCP && level !== IPPROTO_IPV6 && level !== IPPROTO_IP) return -ENOPROTOOPT;
    this.opts.set(`${level}:${name}`, value);
    return 0;
  }
}

// ── Datagram socket (DNS only) ──

export class KDatagramSocket implements OpenFile {
  readonly kind = 'socket' as const;
  readonly type = SOCK_DGRAM;
  flags: number;
  local: SockAddr | null = null;
  remote: SockAddr | null = null;
  readonly ino: number;
  private q = new WaitQueue();
  private rx: { data: Uint8Array; from: SockAddr }[] = [];
  private closed = false;
  private soError = 0;
  private opts = new Map<string, number>();

  constructor(private stack: NetStack, readonly domain: number, flags = 0) {
    this.flags = flags;
    this.ino = stack.nextIno++;
  }

  read(buf: Uint8Array, signal?: AbortSignal): Promise<number> { return this.recvfrom(buf, 0, signal).then((r) => (typeof r === 'number' ? r : r.n)); }
  write(buf: Uint8Array): Promise<number> {
    return this.remote ? this.sendto(buf, 0, this.remote) : Promise.resolve(-EDESTADDRREQ);
  }

  connect(addr: SockAddr): number { this.remote = { ...addr }; return 0; }
  bind(addr: SockAddr): number {
    if (this.local) return -EINVAL;
    this.local = { ...addr, port: addr.port || this.stack.ephemeral() };
    return 0;
  }

  async sendto(buf: Uint8Array, _flags: number, to: SockAddr | null): Promise<number> {
    const dest = to ?? this.remote;
    if (this.closed) return -EBADF;
    if (!dest) return -EDESTADDRREQ;
    if (dest.port !== 53) return -ENETUNREACH;
    if (buf.length > 65507) return -EMSGSIZE;
    if (!this.local) this.local = { family: this.domain, address: this.domain === AF_INET6 ? '::' : '0.0.0.0', port: this.stack.ephemeral() };
    const query = buf.slice();
    this.stack.dohQuery(query).then(
      (answer) => { if (!this.closed) { this.rx.push({ data: answer, from: { ...dest } }); this.q.notify(); } },
      () => {
        // Answer SERVFAIL so the resolver fails fast instead of timing out
        if (this.closed || query.length < 12) return;
        const fail = query.slice(0, 12);
        fail[2] = 0x80 | (query[2] & 0x01); fail[3] = 0x02; // QR, RD copied; RCODE=2
        fail.fill(0, 4, 12);
        this.rx.push({ data: fail, from: { ...dest } }); this.q.notify();
      },
    );
    return buf.length;
  }

  async recvfrom(buf: Uint8Array, flags: number, signal?: AbortSignal): Promise<{ n: number; from: SockAddr } | number> {
    const timeout = this.opts.get(`${SOL_SOCKET}:${SO_RCVTIMEO}`) || 0;
    for (;;) {
      if (this.closed) return -EBADF;
      const d = this.rx[0];
      if (d) {
        if (!(flags & MSG_PEEK)) this.rx.shift();
        const n = Math.min(buf.length, d.data.length); // datagram truncation, like UDP
        buf.set(d.data.subarray(0, n));
        return { n, from: d.from };
      }
      if ((this.flags & O_NONBLOCK) || (flags & MSG_DONTWAIT)) return -EAGAIN;
      if (signal?.aborted) return -EINTR;
      const t0 = Date.now();
      await this.q.wait(timeout, signal);
      if (timeout && Date.now() - t0 >= timeout && !this.rx.length) return -EAGAIN;
    }
  }

  poll(events: number): number {
    let r = POLLOUT;
    if (this.rx.length) r |= POLLIN;
    if (this.soError) r |= POLLERR;
    if (this.closed) r = POLLNVAL;
    return r & (events | POLLERR | POLLHUP | POLLNVAL);
  }
  onReady(cb: () => void) { return this.q.onReady(cb); }
  getsockname(): SockAddr { return this.local ? { ...this.local } : { family: this.domain, address: this.domain === AF_INET6 ? '::' : '0.0.0.0', port: 0 }; }
  getpeername(): SockAddr | number { return this.remote ? { ...this.remote } : -ENOTCONN; }
  getsockopt(level: number, name: number): number {
    if (level === SOL_SOCKET && name === SO_TYPE) return SOCK_DGRAM;
    if (level === SOL_SOCKET && name === SO_ERROR) { const e = this.soError; this.soError = 0; return e; }
    if (level === SOL_SOCKET && name === SO_DOMAIN) return this.domain;
    if (level === SOL_SOCKET && name === SO_PROTOCOL) return IPPROTO_UDP;
    return this.opts.get(`${level}:${name}`) ?? 0;
  }
  setsockopt(level: number, name: number, value: number): number { this.opts.set(`${level}:${name}`, value); return 0; }
  shutdown(_how: number): number { return this.remote ? 0 : -ENOTCONN; }
  async ioctl(req: number, arg: Uint8Array): Promise<number> {
    if (req === FIONREAD && arg.length >= 4) {
      new DataView(arg.buffer, arg.byteOffset, 4).setInt32(0, this.rx[0]?.data.length ?? 0, true);
      return 0;
    }
    return -EINVAL;
  }
  async stat(): Promise<KStat> { return sockStat(this.ino); }
  async close(): Promise<void> { this.closed = true; this.rx = []; this.q.notify(); }
}

// ── HTTP bridge for listeners published on the virtual-server port table ──

const enc = new TextEncoder();
const dec = new TextDecoder();

function encodeHttpRequest(req: VirtualHttpRequest, port: number): Uint8Array {
  const qs = req.query && Object.keys(req.query).length ? '?' + new URLSearchParams(req.query).toString() : '';
  const body = req.body ? enc.encode(req.body) : new Uint8Array(0);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers || {})) headers[k.toLowerCase()] = String(v);
  headers.host ??= `localhost:${port}`;
  headers.connection = 'close';
  delete headers['transfer-encoding'];
  if (body.length || !['GET', 'HEAD'].includes(req.method.toUpperCase())) headers['content-length'] = String(body.length);
  else delete headers['content-length'];
  const head = `${req.method.toUpperCase()} ${req.path || '/'}${qs} HTTP/1.1\r\n` +
    Object.entries(headers).map(([k, v]) => `${k}: ${v.replace(/[\r\n]/g, ' ')}`).join('\r\n') + '\r\n\r\n';
  const out = new Uint8Array(enc.encode(head).length + body.length);
  out.set(enc.encode(head));
  out.set(body, out.length - body.length);
  return out;
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

function findHeaderEnd(b: Uint8Array): number {
  for (let i = 3; i < b.length; i++) if (b[i] === 10 && b[i - 1] === 13 && b[i - 2] === 10 && b[i - 3] === 13) return i + 1;
  return -1;
}

/** Decode a chunked body; returns null until the terminating chunk has arrived. */
function dechunk(b: Uint8Array): Uint8Array | null {
  const parts: Uint8Array[] = [];
  let i = 0;
  for (;;) {
    let j = i;
    while (j + 1 < b.length && !(b[j] === 13 && b[j + 1] === 10)) j++;
    if (j + 1 >= b.length) return null;
    const size = parseInt(dec.decode(b.subarray(i, j)).split(';')[0].trim(), 16);
    if (!Number.isFinite(size)) return concat(parts); // malformed: stop here
    i = j + 2;
    if (size === 0) return concat(parts);
    if (i + size + 2 > b.length) return null;
    parts.push(b.subarray(i, i + size));
    i += size + 2;
  }
}

/** Parse a raw HTTP/1.x response; `complete` = no more bytes are needed. */
export function parseHttpResponse(raw: Uint8Array, eof: boolean, method = 'GET'): { complete: boolean; response?: VirtualHttpResponse } {
  const end = findHeaderEnd(raw);
  if (end < 0) return { complete: eof, response: eof ? { status: 502, body: 'Bad gateway: incomplete response from guest' } : undefined };
  const lines = dec.decode(raw.subarray(0, end - 4)).split('\r\n');
  const m = /^HTTP\/\d\.\d\s+(\d{3})\s*(.*)$/.exec(lines[0]);
  if (!m) return { complete: true, response: { status: 502, body: 'Bad gateway: malformed response from guest' } };
  const status = Number(m[1]);
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const c = line.indexOf(':');
    if (c > 0) {
      const k = line.slice(0, c).trim().toLowerCase();
      headers[k] = headers[k] ? `${headers[k]}, ${line.slice(c + 1).trim()}` : line.slice(c + 1).trim();
    }
  }
  const rest = raw.subarray(end);
  let body: Uint8Array | null;
  if (method === 'HEAD' || status === 204 || status === 304 || (status >= 100 && status < 200)) body = new Uint8Array(0);
  else if (/chunked/i.test(headers['transfer-encoding'] || '')) body = dechunk(rest) ?? (eof ? rest : null);
  else if (headers['content-length'] !== undefined) {
    const len = Number(headers['content-length']);
    body = rest.length >= len ? rest.subarray(0, len) : eof ? rest : null;
  } else body = eof ? rest : null;
  if (!body) return { complete: false };
  for (const h of ['transfer-encoding', 'connection', 'keep-alive', 'content-length']) delete headers[h];
  return { complete: true, response: { status, statusText: m[2], headers, body: body.slice() } };
}

// ── Stack ──

export class NetStack {
  config: NetConfig = defaultConfig();
  /** port → listening socket */
  readonly listeners = new Map<number, KSocket>();
  private bound = new Map<number, KSocket>();
  private nextEphemeral = 32768;
  nextIno = 1;
  private token: { token: string; expires: number } | null = null;
  private portHostPromise: Promise<PortHost | null> | null = null;

  configure(c: Partial<NetConfig>): void {
    this.config = { ...this.config, ...c };
    this.token = null;
    if ('portHost' in c) this.portHostPromise = null;
  }

  socket(domain: number, type: number, protocol = 0): KSocket | KDatagramSocket | number {
    if (domain !== AF_INET && domain !== AF_INET6) return -EAFNOSUPPORT;
    const base = type & 0xf;
    const flags = type & SOCK_NONBLOCK ? O_NONBLOCK : 0;
    if (base === SOCK_STREAM) {
      if (protocol !== 0 && protocol !== IPPROTO_TCP) return -EPROTONOSUPPORT;
      return new KSocket(this, domain, protocol, flags);
    }
    if (base === SOCK_DGRAM) {
      if (protocol !== 0 && protocol !== IPPROTO_UDP) return -EPROTONOSUPPORT;
      return new KDatagramSocket(this, domain, flags);
    }
    return -EPROTONOSUPPORT;
  }

  /** socketpair(2): two connected stream sockets (AF_UNIX-like; they report AF_UNIX). */
  socketpair(type = SOCK_STREAM): [KSocket, KSocket] | number {
    if ((type & 0xf) !== SOCK_STREAM) return -EOPNOTSUPP;
    const flags = type & SOCK_NONBLOCK ? O_NONBLOCK : 0;
    const a = new KSocket(this, AF_UNIX, 0, flags);
    const b = new KSocket(this, AF_UNIX, 0, flags);
    const addr = { family: AF_UNIX, address: '', port: 0 };
    a._attach(new LoopbackPeer(a, b), addr, addr);
    b._attach(new LoopbackPeer(b, a), addr, addr);
    return [a, b];
  }

  ephemeral(): number {
    for (let i = 0; i < 28232; i++) {
      const p = this.nextEphemeral;
      this.nextEphemeral = p >= 60999 ? 32768 : p + 1;
      if (!this.bound.has(p) && !this.listeners.has(p)) return p;
    }
    return 0;
  }

  /** @internal */ autobindAddr(family: number, s: KSocket, address: string): SockAddr {
    const port = this.ephemeral();
    this.bound.set(port, s);
    return { family, address, port };
  }

  /** @internal */ claimPort(port: number, s: KSocket, reuse: boolean): boolean {
    const holder = this.bound.get(port);
    if (holder && holder !== s && !(reuse && holder.state !== 'listening')) return false;
    this.bound.set(port, s);
    return true;
  }

  /** @internal */ releasePort(port: number, s: KSocket): void {
    if (this.bound.get(port) === s) this.bound.delete(port);
  }

  private async portHost(): Promise<PortHost | null> {
    if (this.config.portHost !== undefined) return this.config.portHost;
    this.portHostPromise ??= import('../iframe-server').then((m) => m.iframeServer as unknown as PortHost, () => null);
    return this.portHostPromise;
  }

  /** @internal Publish a listener on the virtual-server port table; returns the unpublish function. */
  publish(listener: KSocket): () => void {
    const port = listener.local!.port;
    let undo: (() => void) | null = null;
    let cancelled = false;
    this.portHost().then((host) => {
      if (!host || cancelled || listener.state !== 'listening') return;
      if (host.isPortInUse?.(port)) return; // an http.createServer already owns it; loopback still works
      try { undo = host.serve(port, (req) => this.bridgeHttp(listener, req), `socket:${port}`); } catch { /* port taken */ }
    });
    return () => { cancelled = true; undo?.(); };
  }

  /** Turn one virtual HTTP request into an accepted connection on `listener`. */
  async bridgeHttp(listener: KSocket, req: VirtualHttpRequest): Promise<VirtualHttpResponse> {
    const client = new KSocket(this, AF_INET, 0, 0);
    const r = await client.connect({ family: AF_INET, address: '127.0.0.1', port: listener.local!.port });
    if (r < 0) return { status: 503, body: `connect: ${errnoName(-r)}` };
    await client.write(encodeHttpRequest(req, listener.local!.port));
    const parts: Uint8Array[] = [];
    const buf = new Uint8Array(64 * 1024);
    const deadline = Date.now() + this.config.httpBridgeTimeoutMs;
    try {
      for (;;) {
        const wait = deadline - Date.now();
        if (wait <= 0) return { status: 504, body: 'Gateway timeout: guest did not answer' };
        let timer: ReturnType<typeof setTimeout> | undefined;
        const n = await Promise.race([
          client.read(buf),
          new Promise<number>((res) => { timer = setTimeout(() => res(-ETIMEDOUT), wait); }),
        ]);
        clearTimeout(timer);
        if (n === -ETIMEDOUT) continue;
        if (n > 0) parts.push(buf.slice(0, n));
        const parsed = parseHttpResponse(concat(parts), n <= 0, req.method.toUpperCase());
        if (parsed.complete) return parsed.response!;
      }
    } finally {
      await client.close();
    }
  }

  // ── relay plumbing ──

  private async relayToken(): Promise<string | null> {
    const { tokenUrl } = this.config;
    if (!tokenUrl) return null;
    if (this.token && this.token.expires - 30_000 > Date.now()) return this.token.token;
    const f = this.config.fetch ?? fetch;
    const res = await f(tokenUrl, { method: 'POST', credentials: 'same-origin' as RequestCredentials });
    if (!res.ok) throw new Error(`token ${res.status}`);
    this.token = await res.json();
    return this.token!.token;
  }

  /**
   * Open a relay WebSocket, send `request`, and hand each text reply to `onMsg`
   * until it settles. Rejects with a positive errno.
   */
  openRelay<T>(request: object, onMsg: (ws: WebSocket, msg: Record<string, unknown>, settle: (v: T) => void) => boolean): Promise<T> {
    const { relayUrl } = this.config;
    if (!relayUrl) return Promise.reject(ENETUNREACH);
    const WS = this.config.WebSocket ?? (globalThis as any).WebSocket;
    if (!WS) return Promise.reject(ENETUNREACH);
    const attempt = (retry: boolean): Promise<T> => this.relayToken().then((token) => new Promise<T>((resolve, reject) => {
      const url = token ? `${relayUrl}${relayUrl.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}` : relayUrl;
      const ws: WebSocket = new WS(url);
      ws.binaryType = 'arraybuffer';
      let opened = false;
      let settled = false;
      const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
      ws.onopen = () => { opened = true; ws.send(JSON.stringify(request)); };
      ws.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data !== 'string') return;
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.op === 'error') {
          done(() => reject(ERRNO_BY_NAME[String(msg.code)] ?? EIO));
          try { ws.close(); } catch { /* closing */ }
          return;
        }
        if (onMsg(ws, msg, (v) => done(() => resolve(v)))) settled = true;
      };
      const failed = () => {
        if (settled) return;
        settled = true;
        // A refused handshake (expired token, relay off, limits) fails before open: refresh the token once
        if (!opened && retry && this.config.tokenUrl) { this.token = null; attempt(false).then(resolve, reject); }
        else reject(opened ? ECONNRESET : ENETUNREACH);
      };
      // Browsers fire error then close; Node's WebSocket only fires error for a refused handshake
      ws.onerror = () => { if (!opened) failed(); };
      ws.onclose = failed;
    }), () => Promise.reject(ENETUNREACH));
    return attempt(true);
  }

  /** Resolve a host name: IP literals and localhost locally, then the relay, then DoH. */
  async resolve(host: string, family: 0 | 4 | 6 = 0): Promise<{ address: string; family: 4 | 6 }[] | number> {
    const fam = ipFamily(host);
    if (fam) return [{ address: host, family: fam }];
    if (host === 'localhost' || host.endsWith('.localhost')) {
      const all: { address: string; family: 4 | 6 }[] = [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }];
      return all.filter((a) => !family || a.family === family);
    }
    const pick = (list: { address: string; family: 4 | 6 }[]) => {
      const r = list.filter((a) => !family || a.family === family);
      return r.length ? r : -EHOSTUNREACH;
    };
    if (this.config.relayUrl) {
      try {
        const list = await this.openRelay<{ address: string; family: 4 | 6 }[]>({ op: 'resolve', host }, (_ws, msg, settle) => {
          if (msg.op !== 'resolved') return false;
          settle(msg.addresses as { address: string; family: 4 | 6 }[]);
          return true;
        });
        return pick(list);
      } catch (e) {
        if (e !== ENETUNREACH) return -EHOSTUNREACH;
      }
    }
    if (!this.config.dohUrl) return -EHOSTUNREACH;
    try {
      const f = this.config.fetch ?? fetch;
      const types = family === 4 ? ['A'] : family === 6 ? ['AAAA'] : ['A', 'AAAA'];
      const out: { address: string; family: 4 | 6 }[] = [];
      await Promise.all(types.map(async (t) => {
        const res = await f(`${this.config.dohUrl}?name=${encodeURIComponent(host)}&type=${t}`, { headers: { accept: 'application/dns-json' } });
        const j = await res.json();
        for (const a of j.Answer || []) {
          if (a.type === 1) out.push({ address: a.data, family: 4 });
          if (a.type === 28) out.push({ address: a.data, family: 6 });
        }
      }));
      return pick(out);
    } catch {
      return -EHOSTUNREACH;
    }
  }

  /** RFC 8484 DNS-over-HTTPS with a raw wire-format query. */
  async dohQuery(query: Uint8Array): Promise<Uint8Array> {
    if (!this.config.dohUrl) throw new Error('no DoH endpoint');
    const f = this.config.fetch ?? fetch;
    const res = await f(this.config.dohUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/dns-message', accept: 'application/dns-message' },
      body: query as BodyInit,
    });
    if (!res.ok) throw new Error(`DoH ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

/** The kernel's network stack. */
export const netStack = new NetStack();

// ── Channel syscalls (docs/NETWORKING.md "Kernel syscalls") ──

/** Room reserved after the payload for a sockaddr (sockaddr_in6 is 28 bytes). */
export const SOCKADDR_ROOM = 28;

type AnySocket = KSocket | KDatagramSocket;

/**
 * Socket syscalls in the SAB-channel form of docs/KERNEL_ABI.md. `kernel.syscall`
 * forwards SYS_socket..SYS_getsockopt and SYS_accept4 here; returns undefined
 * for numbers it doesn't own. `onSigpipe` runs when a send fails with EPIPE
 * without MSG_NOSIGNAL.
 */
export async function netSyscall(
  proc: { fds: FdTable; syscallSignal?: AbortSignal },
  nr: number,
  args: ArrayLike<number>,
  data: Uint8Array,
  onSigpipe?: () => void,
  stack: NetStack = netStack,
): Promise<number | undefined> {
  const sig = proc.syscallSignal;
  const sockOf = (fd: number): AnySocket | number => {
    const f = proc.fds.get(fd);
    if (!f) return -EBADF;
    return f instanceof KSocket || f instanceof KDatagramSocket ? f : -ENOTSOCK;
  };
  const addrIn = (off: number, len: number) => decodeSockaddr(data.subarray(off, off + Math.min(len, SOCKADDR_ROOM)));
  const addrOut = (sa: SockAddr, off = 0) => {
    const b = sa.family === AF_UNIX ? new Uint8Array([AF_UNIX, 0]) : encodeSockaddr(sa);
    data.set(b, off);
    return b.length;
  };
  const install = async (s: AnySocket, cloexec: boolean) => {
    const fd = proc.fds.alloc(s, 0, cloexec);
    if (fd < 0) await s.close();
    return fd;
  };

  switch (nr) {
    case SYS_socket: { // domain, type, protocol
      const s = stack.socket(args[0], args[1], args[2]);
      return typeof s === 'number' ? s : install(s, (args[1] & SOCK_CLOEXEC) !== 0);
    }
    case SYS_socketpair: { // domain, type → int32 sv[2]
      if (args[0] !== AF_UNIX) return args[0] === AF_INET || args[0] === AF_INET6 ? -EOPNOTSUPP : -EAFNOSUPPORT;
      const pair = stack.socketpair(args[1]);
      if (typeof pair === 'number') return pair;
      const a = await install(pair[0], (args[1] & SOCK_CLOEXEC) !== 0);
      if (a < 0) { await pair[1].close(); return a; }
      const b = await install(pair[1], (args[1] & SOCK_CLOEXEC) !== 0);
      if (b < 0) { await proc.fds.close(a); return b; }
      const dv = new DataView(data.buffer, data.byteOffset, 8);
      dv.setInt32(0, a, true); dv.setInt32(4, b, true);
      return 0;
    }
    case SYS_connect: // fd, addrLen; data = sockaddr
    case SYS_bind: {
      const s = sockOf(args[0]);
      if (typeof s === 'number') return s;
      const sa = addrIn(0, args[1]);
      if (typeof sa === 'number') return sa;
      if (nr === SYS_bind) return s.bind(sa);
      return s instanceof KSocket ? s.connect(sa, sig) : s.connect(sa);
    }
    case SYS_listen: { // fd, backlog
      const s = sockOf(args[0]);
      if (typeof s === 'number') return s;
      return s instanceof KSocket ? s.listen(args[1]) : -EOPNOTSUPP;
    }
    case SYS_accept:
    case SYS_accept4: { // fd, flags → data = peer sockaddr
      const s = sockOf(args[0]);
      if (typeof s === 'number') return s;
      if (!(s instanceof KSocket)) return -EOPNOTSUPP;
      const flags = nr === SYS_accept4 ? args[1] : 0;
      const c = await s.accept(flags, sig);
      if (typeof c === 'number') return c;
      const peer = c.getpeername();
      if (typeof peer !== 'number') addrOut(peer);
      return install(c, (flags & SOCK_CLOEXEC) !== 0);
    }
    case SYS_getsockname:
    case SYS_getpeername: { // fd → data = sockaddr; result = its length
      const s = sockOf(args[0]);
      if (typeof s === 'number') return s;
      const sa = nr === SYS_getsockname ? s.getsockname() : s.getpeername();
      return typeof sa === 'number' ? sa : addrOut(sa);
    }
    case SYS_sendto: { // fd, len, flags, addrLen; data = bytes, then sockaddr at offset len
      const s = sockOf(args[0]);
      if (typeof s === 'number') return s;
      const len = Math.min(args[1] >>> 0, data.length);
      let n: number;
      if (s instanceof KDatagramSocket) {
        let to: SockAddr | null = null;
        if (args[3] > 0) {
          const sa = addrIn(len, args[3]);
          if (typeof sa === 'number') return sa;
          to = sa;
        }
        n = await s.sendto(data.subarray(0, len), args[2], to);
      } else {
        n = await s.send(data.subarray(0, len), args[2], sig);
      }
      if (n === -EPIPE && !(args[2] & MSG_NOSIGNAL)) onSigpipe?.();
      return n;
    }
    case SYS_recvfrom: { // fd, len, flags → data = bytes, sender sockaddr at offset len (SOCKADDR_ROOM bytes)
      const s = sockOf(args[0]);
      if (typeof s === 'number') return s;
      const len = Math.min(args[1] >>> 0, Math.max(0, data.length - SOCKADDR_ROOM));
      if (s instanceof KDatagramSocket) {
        const r = await s.recvfrom(data.subarray(0, len), args[2], sig);
        if (typeof r === 'number') return r;
        data.fill(0, len, len + SOCKADDR_ROOM);
        addrOut(r.from, len);
        return r.n;
      }
      const n = await s.recv(data.subarray(0, len), args[2], sig);
      if (n >= 0) {
        data.fill(0, len, len + SOCKADDR_ROOM);
        const peer = s.getpeername();
        if (typeof peer !== 'number') addrOut(peer, len);
      }
      return n;
    }
    case SYS_shutdown: { // fd, how
      const s = sockOf(args[0]);
      return typeof s === 'number' ? s : s.shutdown(args[1]);
    }
    case SYS_setsockopt: { // fd, level, name, value (int; SO_RCVTIMEO/SO_SNDTIMEO in ms)
      const s = sockOf(args[0]);
      return typeof s === 'number' ? s : s.setsockopt(args[1], args[2], args[3]);
    }
    case SYS_getsockopt: { // fd, level, name → value (≥ 0) or -errno
      const s = sockOf(args[0]);
      return typeof s === 'number' ? s : s.getsockopt(args[1], args[2]);
    }
  }
  return undefined;
}

if (typeof window !== 'undefined') (window as any).__shiroNet = netStack;
