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

import { networkCredential, requireNetworkSignIn, setNetworkStatus } from '../net-signin';
import type { KStat } from './abi';
import { retain, release, type FdTable, type OpenFile } from './fd';
import type { Kernel } from './kernel';
import { klog, LOG_WARNING } from './klog';
import { AF_NETLINK, KNetlinkSocket, netlinkSocket } from './netlink';
import {
  EPERM, EINTR, EIO, EBADF, EAGAIN, EACCES, EFAULT, EINVAL, ENOTTY, EPIPE, ETIMEDOUT, EPROTO, ENOTSOCK, EDESTADDRREQ,
  EMSGSIZE, ENOPROTOOPT, EPROTONOSUPPORT, EPROTOTYPE, EOPNOTSUPP, EAFNOSUPPORT, EADDRINUSE, EADDRNOTAVAIL, ENETDOWN,
  ENETUNREACH, ECONNABORTED, ECONNRESET, ENOBUFS, EISCONN, ENOTCONN, ECONNREFUSED, EHOSTUNREACH, EALREADY,
  EINPROGRESS, O_NONBLOCK, POLLIN, POLLPRI, POLLOUT, POLLERR, POLLHUP, POLLNVAL, POLLRDHUP, S_IFSOCK,
  AF_UNIX, AF_INET, AF_INET6, SOCK_STREAM, SOCK_DGRAM, SOCK_SEQPACKET, SOCK_NONBLOCK, SOCK_CLOEXEC, SHUT_RD, SHUT_WR,
  SHUT_RDWR, MSG_PEEK, MSG_WAITALL, MSG_DONTWAIT, MSG_NOSIGNAL, SOL_SOCKET, IPPROTO_IP, IPPROTO_TCP,
  IPPROTO_UDP, IPPROTO_UDPLITE, IPPROTO_IPV6, SO_REUSEADDR, SO_TYPE, SO_ERROR, SO_BROADCAST, SO_SNDBUF, SO_RCVBUF,
  SO_KEEPALIVE, SO_LINGER, SO_REUSEPORT, SO_RCVTIMEO, SO_SNDTIMEO, SO_ACCEPTCONN, SO_PROTOCOL, SO_DOMAIN,
  TCP_NODELAY, TCP_KEEPIDLE, TCP_KEEPINTVL, TCP_KEEPCNT, IPV6_V6ONLY, FIONREAD, FIONBIO, SYS_socket,
  SYS_connect, SYS_accept, SYS_sendto, SYS_recvfrom, SYS_shutdown, SYS_bind, SYS_listen, SYS_getsockname,
  SYS_getpeername, SYS_socketpair, SYS_setsockopt, SYS_getsockopt, SYS_accept4, SOCKET_SYSCALLS,
  SOCKADDR_ROOM, SIGPIPE, ENOENT, SO_PEERCRED, SCM_RIGHTS, MSG_CTRUNC, MSG_TRUNC, MSG_CMSG_CLOEXEC, SYS_sendmsg,
  SYS_recvmsg, SOCKADDR_UN_MAX, ENAMETOOLONG, decodeText,
} from './abi';

// Socket constants live in abi.ts (the shared ABI); re-exported for net.ts users.
export {
  EPERM, EINTR, EIO, EBADF, EAGAIN, EACCES, EFAULT, EINVAL, EPIPE, ETIMEDOUT, EPROTO, ENOTSOCK, EDESTADDRREQ,
  EMSGSIZE, ENOPROTOOPT, EPROTONOSUPPORT, EPROTOTYPE, EOPNOTSUPP, EAFNOSUPPORT, EADDRINUSE, EADDRNOTAVAIL, ENETDOWN,
  ENETUNREACH, ECONNABORTED, ECONNRESET, ENOBUFS, EISCONN, ENOTCONN, ECONNREFUSED, EHOSTUNREACH, EALREADY,
  EINPROGRESS, O_NONBLOCK, POLLIN, POLLPRI, POLLOUT, POLLERR, POLLHUP, POLLNVAL, POLLRDHUP, S_IFSOCK,
  AF_UNIX, AF_INET, AF_INET6, SOCK_STREAM, SOCK_DGRAM, SOCK_SEQPACKET, SOCK_NONBLOCK, SOCK_CLOEXEC, SHUT_RD, SHUT_WR,
  SHUT_RDWR, MSG_PEEK, MSG_WAITALL, MSG_DONTWAIT, MSG_NOSIGNAL, SOL_SOCKET, IPPROTO_IP, IPPROTO_TCP,
  IPPROTO_UDP, IPPROTO_IPV6, SO_REUSEADDR, SO_TYPE, SO_ERROR, SO_BROADCAST, SO_SNDBUF, SO_RCVBUF,
  SO_KEEPALIVE, SO_LINGER, SO_REUSEPORT, SO_RCVTIMEO, SO_SNDTIMEO, SO_ACCEPTCONN, SO_PROTOCOL, SO_DOMAIN,
  TCP_NODELAY, TCP_KEEPIDLE, TCP_KEEPINTVL, TCP_KEEPCNT, IPV6_V6ONLY, FIONREAD, FIONBIO, SYS_socket,
  SYS_connect, SYS_accept, SYS_sendto, SYS_recvfrom, SYS_shutdown, SYS_bind, SYS_listen, SYS_getsockname,
  SYS_getpeername, SYS_socketpair, SYS_setsockopt, SYS_getsockopt, SYS_accept4, SOCKET_SYSCALLS,
  SOCKADDR_ROOM,
} from './abi';

// Relay quota errors; not in abi.ts
export const EDQUOT = 122;
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

import type { ByteChannel } from '../byte-pipe';

// ── Types ──

export interface SockAddr {
  family: number;   // AF_INET | AF_INET6 | AF_UNIX
  /** dotted quad or IPv6 text (no brackets); AF_UNIX: the path, "\0name" when abstract, "" unnamed */
  address: string;
  port: number;
}

/** Where listening sockets get published so Shiro's preview/fetch path can reach them. */
export interface PortHost {
  serve(port: number, handler: (req: VirtualHttpRequest) => Promise<VirtualHttpResponse>, name?: string,
    opts?: { connect?: (conn: ByteChannel) => void }): () => void;
  isPortInUse?(port: number): boolean;
}
export interface VirtualHttpRequest {
  method: string; path: string; headers?: Record<string, string>; body?: string | Uint8Array | null; query?: Record<string, string>;
}
export interface VirtualHttpResponse {
  /** A ReadableStream is a body still coming (server-sent events, chunked, long-poll) */
  status?: number; statusText?: string; headers?: Record<string, string>; body?: string | Uint8Array | ReadableStream<Uint8Array>;
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
  /**
   * Send the saved sign-in (src/net-signin.ts) with token requests and ask for
   * one on 401. Only for this site's own relay: a relay the user chose
   * ("Use my own connection") must never receive their GitHub token.
   */
  credentials: boolean;
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
    credentials: true,
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

/**
 * The page's own address for talking to `remote`: loopback for loopback,
 * else 10.0.2.15, as IPv4-mapped (::ffff:10.0.2.15) toward an IPv4-mapped
 * peer and fd00::15 toward IPv6. glibc's getaddrinfo sorts its answers by
 * connect()ing a UDP socket to each and asserts that an IPv6 socket sent to
 * a mapped address reports a mapped source ("::" aborted every AF_UNSPEC
 * lookup with two families of answers).
 */
export function localAddressFor(remote: SockAddr): string {
  const a = remote.address;
  if (isLoopback(a) && a !== '0.0.0.0' && a !== '::') return /^::ffff:/i.test(a) ? '::ffff:127.0.0.1' : a.includes(':') ? '::1' : '127.0.0.1';
  if (remote.family !== AF_INET6) return '10.0.2.15';
  return /^::ffff:/i.test(a) ? '::ffff:10.0.2.15' : 'fd00::15';
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

/** Encode a sockaddr_in / sockaddr_in6 (Linux layout, network byte order port) / sockaddr_un. */
export function encodeSockaddr(sa: SockAddr): Uint8Array {
  if (sa.family === AF_NETLINK) {
    // sockaddr_nl: family, pad, nl_pid (port), nl_groups
    const b = new Uint8Array(12);
    const dv = new DataView(b.buffer);
    dv.setUint16(0, AF_NETLINK, true);
    dv.setUint32(4, sa.port, true);
    return b;
  }
  if (sa.family === AF_UNIX) {
    // sun_path NUL-terminated (an abstract name starts with its NUL)
    const path = new TextEncoder().encode(sa.address);
    const b = new Uint8Array(Math.min(SOCKADDR_UN_MAX, 2 + path.length + (path.length && path[0] !== 0 ? 1 : 0)));
    b[0] = AF_UNIX;
    b.set(path.subarray(0, b.length - 2), 2);
    return b;
  }
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
  // AF_UNSPEC: connect() with it disconnects a datagram socket
  if (family === 0) return { family, address: '', port: 0 };
  if (family === AF_NETLINK) {
    if (b.length < 12) return -EINVAL;
    return { family, address: '', port: dv.getUint32(4, true) };
  }
  if (family === AF_UNIX) {
    const path = b.subarray(2, Math.min(b.length, SOCKADDR_UN_MAX));
    if (!path.length) return { family, address: '', port: 0 };
    // abstract: every byte up to the length given; a path: up to its NUL
    const end = path[0] === 0 ? path.length : (path.indexOf(0) < 0 ? path.length : path.indexOf(0));
    if (path[0] !== 0 && end === path.length && b.length > SOCKADDR_UN_MAX) return -ENAMETOOLONG;
    // (decodeText: in a browser the syscall buffer is shared, which TextDecoder refuses)
    return { family, address: decodeText(path.subarray(0, end)), port: 0 };
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
  /** `fds` (AF_UNIX SCM_RIGHTS) arrive with the first byte of `data`; the peer owns one reference to each. */
  send(data: Uint8Array, fds?: OpenFile[]): void;
  shutdownWrite(): void;
  close(): void;
  /** The application consumed n received bytes. */
  consumed(n: number): void;
  /** Bytes accepted by send() and not yet handed to the network / peer reader. */
  buffered(): number;
}

class LoopbackPeer implements StreamPeer {
  constructor(private self: KSocket, private other: KSocket) {}
  send(data: Uint8Array, fds?: OpenFile[]) { this.other._deliver(data.slice(), fds); }
  shutdownWrite() { this.other._eof(); }
  close() { this.other._eof(); this.other._peerGone(); }
  consumed() { this.other._wake(); } // the writer on the other side may be waiting for room
  buffered() { return this.other._rxBytes(); }
}

/**
 * What each queued AF_UNIX datagram costs against the send buffer besides its
 * bytes (Linux charges an skb's truesize): a socket of tiny messages fills
 * after a few hundred, as on Linux, not after SO_SNDBUF of them.
 */
const MSG_OVERHEAD = 768;

/** A connected AF_UNIX SOCK_DGRAM socket's default destination: a bound datagram socket */
class DgramPeer implements StreamPeer {
  constructor(private target: KSocket, private self: KSocket) {}
  send(data: Uint8Array, fds?: OpenFile[]) { this.target._deliver(data.slice(), fds, this.self.local); }
  shutdownWrite() {}
  close() {}
  consumed() {}
  buffered() { return this.target._rxBytes(); }
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

  send(data: Uint8Array, fds?: OpenFile[]) {
    for (const f of fds ?? []) void release(f); // no fd passing over TCP
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
  flags: number;
  state: StreamState = 'unbound';
  local: SockAddr | null = null;
  remote: SockAddr | null = null;
  readonly ino: number;

  /** AF_UNIX: the registry key (resolved path, or "\0name") this socket is bound to. */
  unixKey: string | null = null;
  /** Pid of the process that made the socket (SO_PEERCRED of its peer), and of the peer's. */
  ownerPid = 0;
  peerPid = 0;

  private q = new WaitQueue();
  private rx: Uint8Array[] = [];
  /** Received chunks that carry passed descriptions (SCM_RIGHTS), each holding one reference. */
  private rxFds = new Map<Uint8Array, OpenFile[]>();
  /** AF_UNIX datagrams: who sent each one (a bound sender's address), and the last one read (recvfrom) */
  private rxFrom = new Map<Uint8Array, SockAddr>();
  lastFrom: SockAddr | null = null;
  /** DGRAM/SEQPACKET: the whole length of the last message read (MSG_TRUNC) */
  lastMsgLen = 0;
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

  /**
   * `type` SOCK_DGRAM/SOCK_SEQPACKET (AF_UNIX only): messages keep their
   * boundaries (each send is one chunk, a read takes at most one and drops
   * what doesn't fit, a send is never split).
   */
  constructor(private stack: NetStack, readonly domain: number, readonly protocol = 0, flags = 0, readonly type = SOCK_STREAM) {
    this.flags = flags;
    this.ino = stack.nextIno++;
  }

  private get nonblock() { return (this.flags & O_NONBLOCK) !== 0; }
  private get messages() { return this.type !== SOCK_STREAM; }

  // ── events from the peer ──
  /** @internal */ _deliver(data: Uint8Array, fds?: OpenFile[], from?: SockAddr | null) {
    if (this.rdShut || this.state === 'closed' || !data.length) { for (const f of fds ?? []) void release(f); return; }
    this.rx.push(data); this.rxLen += data.length;
    if (fds?.length) this.rxFds.set(data, fds);
    if (from) this.rxFrom.set(data, { ...from });
    this.q.notify();
  }
  /** @internal */ _eof() { if (!this.rxEof) { this.rxEof = true; this.q.notify(); } }
  /** @internal */ _error(errno: number) { this.soError = errno; this.q.notify(); }
  /** @internal */ _peerGone() { this.wrShut = true; this.q.notify(); }
  /** @internal */ _wake() { this.q.notify(); }
  /** @internal */ _rxBytes() { return this.rxLen + (this.messages ? this.rx.length * MSG_OVERHEAD : 0); }
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

  /** Receive into `buf`; passed descriptions (SCM_RIGHTS) go to `fdsOut`, or are closed without it. */
  async recv(buf: Uint8Array, msgFlags = 0, signal?: AbortSignal, fdsOut?: OpenFile[]): Promise<number> {
    const dontwait = this.nonblock || (msgFlags & MSG_DONTWAIT) !== 0;
    const timeout = this.opts.get(`${SOL_SOCKET}:${SO_RCVTIMEO}`) || 0;
    let got = 0;
    for (;;) {
      if (this.rxLen > 0 && got < buf.length) {
        const before = fdsOut?.length ?? 0;
        got += this.take(buf.subarray(got), (msgFlags & MSG_PEEK) !== 0, fdsOut);
        // One message per receive; MSG_TRUNC returns its whole length, as Linux does
        if (this.messages) return msgFlags & MSG_TRUNC ? this.lastMsgLen : got;
        if (!(msgFlags & MSG_WAITALL) || got === buf.length || (msgFlags & MSG_PEEK)) return got;
        if ((fdsOut?.length ?? 0) > before) return got; // descriptions end a message
        continue;
      }
      if (got > 0 && (this.rxEof || this.rdShut || this.soError)) return got;
      if (buf.length === 0) return 0;
      if (this.soError) return -this.takeError();
      if (this.rxEof || this.rdShut) return 0;
      if (this.state === 'closed') return -EBADF;
      // (an AF_UNIX stream socket's is EINVAL on Linux: unix_stream_read_generic)
      if (this.state !== 'connected' && this.state !== 'connecting' && !(this.type === SOCK_DGRAM && this.state === 'bound')) {
        return this.domain === AF_UNIX && this.type !== SOCK_DGRAM ? -EINVAL : -ENOTCONN;
      }
      if (dontwait) return got || -EAGAIN;
      if (signal?.aborted) return got || -EINTR;
      const t0 = Date.now();
      await this.q.wait(timeout, signal);
      if (timeout && Date.now() - t0 >= timeout && this.rxLen === 0) return got || -EAGAIN;
    }
  }

  private take(out: Uint8Array, peek: boolean, fdsOut?: OpenFile[]): number {
    if (this.messages) {
      // One message; the part that doesn't fit is dropped
      const chunk = this.rx[0];
      const k = Math.min(chunk.length, out.length);
      out.set(chunk.subarray(0, k));
      this.lastFrom = this.rxFrom.get(chunk) ?? null;
      this.lastMsgLen = chunk.length;
      if (peek) return k;
      this.rxFrom.delete(chunk);
      const fds = this.rxFds.get(chunk);
      if (fds) { this.rxFds.delete(chunk); if (fdsOut) fdsOut.push(...fds); else for (const f of fds) void release(f); }
      this.rx.shift();
      this.rxLen -= chunk.length;
      this.peer?.consumed(chunk.length);
      return k;
    }
    let n = 0;
    let i = 0;
    while (n < out.length && i < this.rx.length) {
      const chunk = this.rx[i];
      // Bytes that carry descriptions start a message of their own (as on Linux)
      const fds = this.rxFds.get(chunk);
      if (fds && n > 0) break;
      const k = Math.min(chunk.length, out.length - n);
      out.set(chunk.subarray(0, k), n);
      n += k;
      if (fds && !peek) {
        this.rxFds.delete(chunk);
        if (fdsOut) fdsOut.push(...fds); else for (const f of fds) void release(f);
      }
      if (peek) { i++; if (fds) break; continue; }
      if (k === chunk.length) this.rx.shift(); else this.rx[0] = chunk.subarray(k);
      if (fds) break;
    }
    if (!peek) { this.rxLen -= n; this.peer?.consumed(n); }
    return n;
  }

  private takeError(): number { const e = this.soError; this.soError = 0; return e; }

  /** Send `buf`; `fds` (AF_UNIX SCM_RIGHTS, one reference each owned by the call) go with it, or are released on failure. */
  async send(buf: Uint8Array, msgFlags = 0, signal?: AbortSignal, fds?: OpenFile[]): Promise<number> {
    const n = await this.sendSome(buf, msgFlags, signal, fds);
    if (n <= 0) for (const f of fds ?? []) void release(f);
    return n;
  }

  private async sendSome(buf: Uint8Array, msgFlags: number, signal?: AbortSignal, fds?: OpenFile[]): Promise<number> {
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
      if (this.messages && buf.length > this.stack.config.sndbuf) return -EMSGSIZE;
      // (a datagram waits only while the buffer is full, then may overshoot
      // it, as Linux checks before allocating: two messages of half
      // SO_SNDBUF fit, Open POSIX aio_cancel_5-1)
      const room = this.stack.config.sndbuf - this.peer.buffered();
      if (room <= 0) {
        if (dontwait) return -EAGAIN;
        if (signal?.aborted) return -EINTR;
        await this.q.wait(50, signal);
        continue;
      }
      // Blocking sockets take the whole buffer (like Linux); nonblocking take what fits.
      const n = dontwait && !this.messages ? Math.min(room, buf.length) : buf.length;
      this.peer.send(buf.subarray(0, n), fds);
      return n;
    }
  }

  poll(events: number): number {
    let r = 0;
    if (this.soError) r |= POLLERR;
    // A bound, unconnected datagram socket: readable when a message is queued
    if (this.type === SOCK_DGRAM && this.state === 'bound') return (r | (this.rxLen > 0 ? POLLIN : 0) | POLLOUT) & (events | POLLERR);
    switch (this.state) {
      case 'listening':
        if (this.backlog.length) r |= POLLIN;
        break;
      case 'connecting':
        break;
      case 'connected':
        if (this.rxLen > 0 || this.rxEof || this.rdShut) r |= POLLIN;
        if (this.rxEof || this.rdShut) r |= POLLRDHUP; // the peer's FIN, or our own shutdown(SHUT_RD)
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
    // O_NONBLOCK is set on the description by the kernel's ioctl; EINVAL here
    // failed CPython's socket.setblocking(False) (pip, urllib3 with a timeout)
    if (req === FIONBIO) return 0;
    return -ENOTTY;
  }

  async stat(): Promise<KStat> { return sockStat(this.ino); }

  async close(): Promise<void> {
    if (this.state === 'closed') return;
    const wasListening = this.state === 'listening';
    this.state = 'closed';
    if (wasListening) {
      this.unpublish?.(); this.unpublish = null;
      if (this.domain === AF_UNIX) {
        if (this.stack.unixListeners.get(this.unixKey!) === this) this.stack.unixListeners.delete(this.unixKey!);
      } else {
        const rest = (this.stack.listeners.get(this.local!.port) ?? []).filter((l) => l !== this);
        if (rest.length) this.stack.listeners.set(this.local!.port, rest); else this.stack.listeners.delete(this.local!.port);
      }
      for (const s of this.backlog.splice(0)) await s.close();
    }
    if (this.unixKey?.startsWith('\0') && this.stack.unixNames.get(this.unixKey) === this) this.stack.unixNames.delete(this.unixKey);
    if (this.unixKey && this.stack.unixDgram.get(this.unixKey) === this) this.stack.unixDgram.delete(this.unixKey);
    if (this.local && this.domain !== AF_UNIX) this.stack.releasePort(this.local.port, this);
    this.peer?.close();
    this.peer = null;
    for (const fds of this.rxFds.values()) for (const f of fds) void release(f);
    this.rxFds.clear();
    this.rxFrom.clear();
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
    const listener = isLoopback(host) ? stack.listenerFor(port, host) : undefined;
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
    if (!stack.config.relayUrl) {
      stack.relayLog({ op: 'connect', host, port }, 'no relay configured');
      return -ENETUNREACH;
    }
    this.state = 'connecting';
    const p = RelayPeer.open(stack, this, host, port).then(
      ({ peer, info }) => {
        if (this.state !== 'connecting') { peer.close(); return 0; }
        const remote = remoteOf(info);
        const local = this.local ?? { family: remote.family, address: localAddressFor(remote), port: stack.ephemeral() };
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
    else if (!this.stack.claimPort(port, this, this.getOpt(SOL_SOCKET, SO_REUSEADDR) !== 0, { family: addr.family, address: addr.address, v6only: this.v6only })) return -EADDRINUSE;
    this.local = { family: addr.family, address: addr.address, port };
    if (this.state === 'unbound') this.state = 'bound';
    return 0;
  }

  listen(backlog = 128): number {
    if (this.type === SOCK_DGRAM) return -EOPNOTSUPP;
    if (this.state === 'listening') { this.backlogMax = Math.max(1, Math.min(backlog, 4096)); return 0; }
    if (this.state !== 'unbound' && this.state !== 'bound') return -EINVAL;
    if (this.domain === AF_UNIX) {
      if (!this.unixKey) return -EINVAL; // (Linux would autobind an abstract name)
      this.backlogMax = Math.max(1, Math.min(backlog || 1, 4096));
      this.state = 'listening';
      this.stack.unixListeners.set(this.unixKey, this);
      return 0;
    }
    if (!this.local) {
      this.local = this.stack.autobindAddr(this.domain, this, this.domain === AF_INET6 ? '::' : '0.0.0.0');
    }
    const others = this.stack.listeners.get(this.local.port) ?? [];
    if (others.some((l) => portsOverlap(l.portUse(), this.portUse()))) return -EADDRINUSE;
    this.backlogMax = Math.max(1, Math.min(backlog || 1, 4096));
    this.state = 'listening';
    this.stack.listeners.set(this.local.port, [...others, this]);
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
    if (this.domain === AF_UNIX) return this.local ? { ...this.local } : { family: AF_UNIX, address: '', port: 0 };
    return this.local ? { ...this.local } : { family: this.domain, address: this.domain === AF_INET6 ? '::' : '0.0.0.0', port: 0 };
  }

  getpeername(): SockAddr | number {
    return this.state === 'connected' && this.remote ? { ...this.remote } : -ENOTCONN;
  }

  private getOpt(level: number, name: number) { return this.opts.get(`${level}:${name}`) ?? 0; }
  /** IPV6_V6ONLY: an AF_INET6 socket that takes no IPv4 */
  get v6only(): boolean { return this.domain === AF_INET6 && this.getOpt(IPPROTO_IPV6, IPV6_V6ONLY) !== 0; }
  /** @internal What this socket's port binding covers */
  portUse(): PortUse { return { family: this.local?.family ?? this.domain, address: this.local?.address ?? (this.domain === AF_INET6 ? '::' : '0.0.0.0'), v6only: this.v6only }; }

  getsockopt(level: number, name: number): number {
    if (level === SOL_SOCKET) {
      switch (name) {
        case SO_ERROR: return this.takeError();
        case SO_TYPE: return this.type;
        case SO_DOMAIN: return this.domain;
        case SO_PROTOCOL: return this.domain === AF_UNIX ? 0 : IPPROTO_TCP;
        // the peer's pid (the ucred's uid/gid are every process's: one user)
        case SO_PEERCRED: return this.domain === AF_UNIX && this.state === 'connected' ? this.peerPid : -ENOTCONN;
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
  private rxBytes = 0;
  private closed = false;
  private soError = 0;
  private opts = new Map<string, number>();

  constructor(private stack: NetStack, readonly domain: number, flags = 0, readonly protocol = IPPROTO_UDP) {
    this.flags = flags;
    this.ino = stack.nextIno++;
  }

  read(buf: Uint8Array, signal?: AbortSignal): Promise<number> { return this.recvfrom(buf, 0, signal).then((r) => (typeof r === 'number' ? r : r.n)); }
  write(buf: Uint8Array): Promise<number> {
    return this.remote ? this.sendto(buf, 0, this.remote) : Promise.resolve(-EDESTADDRREQ);
  }

  get v6only(): boolean { return this.domain === AF_INET6 && (this.opts.get(`${IPPROTO_IPV6}:${IPV6_V6ONLY}`) ?? 0) !== 0; }
  /** SO_REUSEADDR or SO_REUSEPORT: may share its port with another socket that has it too */
  get reusable(): boolean { return !!(this.opts.get(`${SOL_SOCKET}:${SO_REUSEADDR}`) || this.opts.get(`${SOL_SOCKET}:${SO_REUSEPORT}`)); }
  /** @internal What this socket's port binding covers */
  portUse(): PortUse {
    return { family: this.local?.family ?? this.domain, address: this.local?.address ?? (this.domain === AF_INET6 ? '::' : '0.0.0.0'), v6only: this.v6only };
  }

  /** Take an ephemeral port (connect, or a send from an unbound socket) */
  private autobind(address: string): void {
    for (let i = 0; i < 64; i++) {
      this.local = { family: this.domain, address, port: this.stack.ephemeral() };
      if (this.stack.claimUdp(this.local.port, this)) return;
    }
  }

  /** An IPv4 address given to an IPv6 socket is its IPv4-mapped form (::ffff:a.b.c.d), as in Linux */
  private mapped(addr: SockAddr): SockAddr {
    return this.domain === AF_INET6 && addr.family === AF_INET ? { family: AF_INET6, address: `::ffff:${addr.address}`, port: addr.port } : addr;
  }

  connect(addr: SockAddr): number {
    // glibc's getaddrinfo reuses an IPv6 socket for an IPv4 answer and
    // asserts the source address getsockname reports is v4-mapped
    addr = this.mapped(addr);
    this.remote = { ...addr };
    this.soError = 0;
    // A connected datagram socket has a source address (getsockname); after
    // mapped() an IPv4 peer on an IPv6 socket gives a v4-mapped one, as Linux's
    // ip6_datagram_connect does (Firefox and uv aborted in getaddrinfo without it)
    const src = localAddressFor({ ...addr, family: this.domain });
    if (!this.local) this.autobind(src);
    else if (this.local.address === '::' || this.local.address === '0.0.0.0') this.local = { ...this.local, address: src };
    return 0;
  }
  bind(addr: SockAddr): number {
    if (this.local) return -EINVAL;
    const want = { ...addr, port: addr.port };
    this.local = want;
    if (want.port === 0) {
      this.local = null;
      this.autobind(addr.address);
    } else if (!this.stack.claimUdp(want.port, this)) {
      this.local = null;
      return -EADDRINUSE;
    }
    this.boundAddr = addr.address !== '::' && addr.address !== '0.0.0.0';
    this.boundPort = addr.port !== 0;
    return 0;
  }

  /** bind() named the address / the port (a disconnect keeps them) */
  private boundAddr = false;
  private boundPort = false;

  /**
   * connect(AF_UNSPEC): no peer any more. A source address the route chose
   * goes back to the wildcard, and a port nobody bound is released, as in
   * Linux's __udp_disconnect.
   */
  disconnect(): number {
    this.remote = null;
    if (this.local && !this.boundAddr && !this.boundPort) { this.stack.releaseUdp(this.local.port, this); this.local = null; }
    else if (this.local && !this.boundAddr) this.local = { ...this.local, address: this.domain === AF_INET6 ? '::' : '0.0.0.0' };
    return 0;
  }

  /** @internal A datagram from another socket here (loopback): dropped when the receive buffer is full, like UDP */
  _deliver(data: Uint8Array, from: SockAddr): void {
    if (this.closed) return;
    const rcvbuf = this.opts.get(`${SOL_SOCKET}:${SO_RCVBUF}`) || 212992;
    if (this.rxBytes + data.length > rcvbuf) return;
    this.rx.push({ data, from }); this.rxBytes += data.length;
    this.q.notify();
  }

  /** The sender's address as the receiver (of `family`) sees it: v4 senders appear v4-mapped to IPv6 sockets */
  private static seenAs(from: SockAddr, family: number): SockAddr {
    if (family === AF_INET6 && from.family === AF_INET) return { family, address: `::ffff:${from.address}`, port: from.port };
    if (family === AF_INET && /^::ffff:/i.test(from.address)) return { family, address: from.address.slice(7), port: from.port };
    return { ...from, family };
  }

  private takeError(): number { const e = this.soError; this.soError = 0; return e; }

  async sendto(buf: Uint8Array, _flags: number, to: SockAddr | null): Promise<number> {
    const dest = to ? this.mapped(to) : this.remote;
    if (this.closed) return -EBADF;
    if (this.soError && !to) return -this.takeError();
    if (!dest) return -EDESTADDRREQ;
    if (buf.length > 65507) return -EMSGSIZE;
    const host = dest.address;
    const local = host === '0.0.0.0' || host === '::' || isLoopback(host) || /^(::ffff:)?10\.0\.2\.15$/i.test(host) || host.toLowerCase() === 'fd00::15';
    if (!local && dest.port !== 53) return -ENETUNREACH;
    const src = localAddressFor({ ...dest, family: this.domain });
    if (!this.local) this.autobind(this.domain === AF_INET6 ? '::' : '0.0.0.0');
    if (local) {
      // Loopback: straight to the socket bound to that port; a connected sender learns of nobody there (ICMP port unreachable)
      const addr = this.local!.address === '::' || this.local!.address === '0.0.0.0' ? src : this.local!.address;
      const from: SockAddr = { family: this.domain, address: addr, port: this.local!.port };
      const target = this.stack.udpReceiver(dest.port, host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host, from);
      if (target) { target._deliver(buf.slice(), KDatagramSocket.seenAs(from, target.domain)); return buf.length; }
      // (nobody serves DNS here: a resolver on 127.0.0.53 or ::1 answers over DoH, as before)
      if (dest.port !== 53) {
        if (this.remote) { this.soError = ECONNREFUSED; this.q.notify(); }
        return buf.length;
      }
    }
    const query = buf.slice();
    this.stack.dohQuery(query).then(
      (answer) => { if (!this.closed) { this.rx.push({ data: answer, from: { ...dest } }); this.rxBytes += answer.length; this.q.notify(); } },
      () => {
        // Answer SERVFAIL so the resolver fails fast instead of timing out
        if (this.closed || query.length < 12) return;
        const fail = query.slice(0, 12);
        fail[2] = 0x80 | (query[2] & 0x01); fail[3] = 0x02; // QR, RD copied; RCODE=2
        fail.fill(0, 4, 12);
        this.rx.push({ data: fail, from: { ...dest } }); this.rxBytes += fail.length; this.q.notify();
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
        if (!(flags & MSG_PEEK)) { this.rx.shift(); this.rxBytes -= d.data.length; }
        const n = Math.min(buf.length, d.data.length); // datagram truncation, like UDP
        buf.set(d.data.subarray(0, n));
        return { n, from: d.from };
      }
      // nobody listened where a connected socket sent (ICMP port unreachable)
      if (this.soError) return -this.takeError();
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
  getsockname(): SockAddr {
    // connect() set the source address the route would use (glibc's getaddrinfo
    // sorts its answers by these, RFC 3484, and asserts a v4-mapped source
    // for a v4-mapped destination)
    if (this.local) return { ...this.local };
    return { family: this.domain, address: this.domain === AF_INET6 ? '::' : '0.0.0.0', port: 0 };
  }
  getpeername(): SockAddr | number { return this.remote ? { ...this.remote } : -ENOTCONN; }
  getsockopt(level: number, name: number): number {
    if (level === SOL_SOCKET && name === SO_TYPE) return SOCK_DGRAM;
    if (level === SOL_SOCKET && name === SO_ERROR) { const e = this.soError; this.soError = 0; return e; }
    if (level === SOL_SOCKET && name === SO_DOMAIN) return this.domain;
    if (level === SOL_SOCKET && name === SO_PROTOCOL) return this.protocol;
    return this.opts.get(`${level}:${name}`) ?? 0;
  }
  setsockopt(level: number, name: number, value: number): number { this.opts.set(`${level}:${name}`, value); return 0; }
  shutdown(_how: number): number { return this.remote ? 0 : -ENOTCONN; }
  async ioctl(req: number, arg: Uint8Array): Promise<number> {
    if (req === FIONREAD && arg.length >= 4) {
      new DataView(arg.buffer, arg.byteOffset, 4).setInt32(0, this.rx[0]?.data.length ?? 0, true);
      return 0;
    }
    if (req === FIONBIO) return 0; // the kernel set O_NONBLOCK on the description
    return -ENOTTY;
  }
  async stat(): Promise<KStat> { return sockStat(this.ino); }
  async close(): Promise<void> {
    this.closed = true; this.rx = []; this.rxBytes = 0; this.q.notify();
    if (this.local) this.stack.releaseUdp(this.local.port, this);
  }
}

// ── HTTP bridge for listeners published on the virtual-server port table ──

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeHttpRequest(req: VirtualHttpRequest, port: number): Uint8Array {
  const qs = req.query && Object.keys(req.query).length ? '?' + new URLSearchParams(req.query).toString() : '';
  const body = !req.body ? new Uint8Array(0) : typeof req.body === 'string' ? enc.encode(req.body) : req.body; // a preview's fetch sends bytes
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

/** A raw HTTP/1.x response's head: status, headers, where the body starts; null until it's all there, or 'bad' */
function parseHttpHead(raw: Uint8Array): { status: number; statusText: string; headers: Record<string, string>; end: number } | null | 'bad' {
  const end = findHeaderEnd(raw);
  if (end < 0) return null;
  const lines = dec.decode(raw.subarray(0, end - 4)).split('\r\n');
  const m = /^HTTP\/\d\.\d\s+(\d{3})\s*(.*)$/.exec(lines[0]);
  if (!m) return 'bad';
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const c = line.indexOf(':');
    if (c > 0) {
      const k = line.slice(0, c).trim().toLowerCase();
      headers[k] = headers[k] ? `${headers[k]}, ${line.slice(c + 1).trim()}` : line.slice(c + 1).trim();
    }
  }
  return { status: Number(m[1]), statusText: m[2], headers, end };
}

/** Parse a raw HTTP/1.x response; `complete` = no more bytes are needed. */
export function parseHttpResponse(raw: Uint8Array, eof: boolean, method = 'GET'): { complete: boolean; response?: VirtualHttpResponse } {
  const head = parseHttpHead(raw);
  if (head === null) return { complete: eof, response: eof ? { status: 502, body: 'Bad gateway: incomplete response from guest' } : undefined };
  if (head === 'bad') return { complete: true, response: { status: 502, body: 'Bad gateway: malformed response from guest' } };
  const { status, headers, end } = head;
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
  return { complete: true, response: { status, statusText: head.statusText, headers, body: body.slice() } };
}

/**
 * Read an HTTP/1.x response from a connection: the head within
 * `headTimeoutMs`; a body that is all there soon after comes whole, one
 * still coming (server-sent events, chunked writes, a long poll) as a
 * ReadableStream of its bytes as they arrive (cancelling it closes the
 * connection). The connection is closed when the body is done.
 */
export async function readHttpResponse(client: { read(buf: Uint8Array): Promise<number>; close(): Promise<void> | void }, method: string, headTimeoutMs: number): Promise<VirtualHttpResponse> {
  let raw = new Uint8Array(0);
  const buf = new Uint8Array(64 * 1024);
  let eof = false;
  /** One read, or -ETIMEDOUT after `ms` (the read goes on; its bytes come with the next call) */
  let pending: Promise<number> | null = null;
  const readFor = async (ms: number): Promise<number> => {
    pending ??= client.read(buf);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const n = await Promise.race([pending, new Promise<number>((res) => { timer = setTimeout(() => res(-ETIMEDOUT), ms); })]);
    clearTimeout(timer);
    if (n === -ETIMEDOUT) return n;
    pending = null;
    if (n > 0) raw = concat([raw, buf.subarray(0, n)]); else eof = true;
    return n;
  };
  let streaming = false;
  try {
    // The head
    const deadline = Date.now() + headTimeoutMs;
    let head = parseHttpHead(raw);
    while (head === null && !eof) {
      const wait = deadline - Date.now();
      if (wait <= 0) return { status: 504, body: 'Gateway timeout: guest did not answer' };
      await readFor(wait);
      head = parseHttpHead(raw);
    }
    if (head === null || head === 'bad') return parseHttpResponse(raw, true, method).response!;
    // A body that is all there (or soon is) comes whole
    const graceUntil = Date.now() + 25;
    for (;;) {
      const p = parseHttpResponse(raw, eof, method);
      if (p.complete) return p.response!;
      const wait = graceUntil - Date.now();
      if (wait <= 0) break;
      await readFor(wait);
    }
    // Still coming: stream it
    const headers = { ...head.headers };
    const chunked = /chunked/i.test(headers['transfer-encoding'] || '');
    let left = !chunked && headers['content-length'] !== undefined ? Number(headers['content-length']) : Infinity;
    for (const h of ['transfer-encoding', 'connection', 'keep-alive', 'content-length']) delete headers[h];
    const dechunker = chunked ? new Dechunker() : null;
    let initial = raw.subarray(head.end);
    streaming = true;
    const body = new ReadableStream<Uint8Array>({
      pull: async (ctrl) => {
        for (;;) {
          let bytes: Uint8Array;
          if (initial.length) { bytes = initial; initial = new Uint8Array(0); }
          else {
            const n = pending ? await pending : await client.read(buf);
            pending = null;
            if (n <= 0) { ctrl.close(); void client.close(); return; }
            bytes = buf.slice(0, n);
          }
          let out: Uint8Array;
          let done = false;
          if (dechunker) { out = dechunker.push(bytes); done = dechunker.done; }
          else { out = bytes.subarray(0, Math.min(bytes.length, left)); left -= out.length; done = left <= 0; }
          if (out.length) ctrl.enqueue(out);
          if (done) { ctrl.close(); void client.close(); return; }
          if (out.length) return;
        }
      },
      cancel: () => { void client.close(); },
    });
    return { status: head.status, statusText: head.statusText, headers, body };
  } finally {
    if (!streaming) await client.close();
  }
}

/** Decodes a chunked body as its bytes arrive */
class Dechunker {
  private pending = new Uint8Array(0);
  /** Bytes of the current chunk still to come (0: a size line is next) */
  private left = 0;
  /** The CRLF after a chunk's data is still to come */
  private crlf = false;
  done = false;

  push(b: Uint8Array): Uint8Array {
    let data = concat([this.pending, b]);
    const out: Uint8Array[] = [];
    let i = 0;
    while (!this.done && i < data.length) {
      if (this.left > 0) {
        const n = Math.min(this.left, data.length - i);
        out.push(data.slice(i, i + n));
        i += n; this.left -= n;
        if (this.left === 0) this.crlf = true;
        continue;
      }
      if (this.crlf) {
        if (data.length - i < 2) break;
        i += 2; this.crlf = false;
        continue;
      }
      let j = i;
      while (j + 1 < data.length && !(data[j] === 13 && data[j + 1] === 10)) j++;
      if (j + 1 >= data.length) break; // the size line isn't all here
      const size = parseInt(dec.decode(data.subarray(i, j)).split(';')[0].trim(), 16);
      i = j + 2;
      if (!Number.isFinite(size) || size === 0) { this.done = true; break; }
      this.left = size;
    }
    this.pending = data.slice(i);
    data = new Uint8Array(0);
    return concat(out);
  }
}

// ── Stack ──

/** Who holds a TCP port: a v4 and a v6-only socket can share one */
interface PortUse { family: number; address: string; v6only: boolean }

/** The IPv4 addresses `u` takes: '*' for all of them, one address, or none (v6-only, or a non-mapped v6 address) */
function v4Part(u: PortUse): string | null {
  if (u.family === AF_INET) return u.address === '0.0.0.0' ? '*' : u.address;
  if (u.v6only) return null;
  if (u.address === '::') return '*';
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(u.address);
  return m ? (m[1] === '0.0.0.0' ? '*' : m[1]) : null;
}
function v6Part(u: PortUse): string | null {
  if (u.family !== AF_INET6 || /^::ffff:/i.test(u.address)) return null;
  return u.address === '::' ? '*' : u.address.toLowerCase();
}
/**
 * Do two bindings of one port overlap? As Linux with bindv6only=0: a v4
 * socket takes IPv4, a v6 socket IPv6 and (unless IPV6_V6ONLY) IPv4 too, a
 * wildcard all of its family. Redis binds 0.0.0.0:6379 then [::]:6379 v6-only.
 */
function portsOverlap(a: PortUse, b: PortUse): boolean {
  const meets = (x: string | null, y: string | null) => x !== null && y !== null && (x === '*' || y === '*' || x === y);
  return meets(v4Part(a), v4Part(b)) || meets(v6Part(a), v6Part(b));
}

export class NetStack {
  config: NetConfig = defaultConfig();
  /** port → listening sockets (a v4 and a v6-only one can share a port) */
  readonly listeners = new Map<number, KSocket[]>();
  /** AF_UNIX: resolved path (or "\0name") → listening socket */
  readonly unixListeners = new Map<string, KSocket>();
  /** AF_UNIX: bound abstract names (paths are files in the filesystem) */
  readonly unixNames = new Map<string, KSocket>();
  /** Bound AF_UNIX SOCK_DGRAM sockets, by the same keys */
  readonly unixDgram = new Map<string, KSocket>();
  /** AF_UNIX: resolved paths of socket files made by bind() (they stat as sockets) */
  readonly unixPaths = new Set<string>();
  private bound = new Map<number, { s: KSocket; use: PortUse }[]>();
  /** UDP port → the datagram sockets bound to it (loopback delivery, EADDRINUSE) */
  private udp = new Map<number, KDatagramSocket[]>();
  private nextEphemeral = 32768;
  nextIno = 1;
  private token: { token: string; expires: number } | null = null;
  private portHostPromise: Promise<PortHost | null> | null = null;

  configure(c: Partial<NetConfig>): void {
    this.config = { ...this.config, ...c };
    this.token = null;
    if ('portHost' in c) this.portHostPromise = null;
  }

  socket(domain: number, type: number, protocol = 0): KSocket | KDatagramSocket | KNetlinkSocket | number {
    const base = type & 0xf;
    const flags = type & SOCK_NONBLOCK ? O_NONBLOCK : 0;
    // A type outside SOCK_STREAM..SOCK_PACKET (or unknown flag bits) is EINVAL, like Linux
    if (base < 1 || base > 10 || (type & ~(0xf | SOCK_NONBLOCK | SOCK_CLOEXEC))) return -EINVAL;
    if (domain === AF_UNIX) {
      if (base !== SOCK_STREAM && base !== SOCK_DGRAM && base !== SOCK_SEQPACKET) return -EPROTONOSUPPORT;
      if (protocol !== 0) return -EPROTONOSUPPORT;
      return new KSocket(this, AF_UNIX, 0, flags, base);
    }
    if (domain === AF_NETLINK) return netlinkSocket(type, protocol, flags);
    if (domain !== AF_INET && domain !== AF_INET6) return -EAFNOSUPPORT;
    if (base === SOCK_STREAM) {
      if (protocol !== 0 && protocol !== IPPROTO_TCP) return -EPROTONOSUPPORT;
      return new KSocket(this, domain, protocol, flags);
    }
    if (base === SOCK_DGRAM) {
      if (protocol !== 0 && protocol !== IPPROTO_UDP && protocol !== IPPROTO_UDPLITE) return -EPROTONOSUPPORT;
      return new KDatagramSocket(this, domain, flags, protocol || IPPROTO_UDP);
    }
    return -EPROTONOSUPPORT;
  }

  /** socketpair(2): two connected stream sockets (AF_UNIX-like; they report AF_UNIX). */
  socketpair(type = SOCK_STREAM): [KSocket, KSocket] | number {
    // SOCK_SEQPACKET: Rust's std::process::Command makes one for every spawn
    // (cargo couldn't start rustc, nor rustc its linker: EOPNOTSUPP)
    const base = type & 0xf;
    if (base !== SOCK_STREAM && base !== SOCK_DGRAM && base !== SOCK_SEQPACKET) return -EOPNOTSUPP;
    const flags = type & SOCK_NONBLOCK ? O_NONBLOCK : 0;
    const a = new KSocket(this, AF_UNIX, 0, flags, base);
    const b = new KSocket(this, AF_UNIX, 0, flags, base);
    const addr = { family: AF_UNIX, address: '', port: 0 };
    a._attach(new LoopbackPeer(a, b), addr, addr);
    b._attach(new LoopbackPeer(b, a), addr, addr);
    return [a, b];
  }

  /** bind(2) of an AF_UNIX socket: a path makes a socket file; "\0name" is abstract. */
  async bindUnix(s: KSocket, addr: SockAddr, ops: UnixOps): Promise<number> {
    if (s.state === 'closed') return -EBADF;
    if (s.local || s.state !== 'unbound') return -EINVAL;
    let key: string;
    if (addr.address === '') {
      key = `\0${(this.nextIno++).toString(16).padStart(5, '0')}`; // autobind
      addr = { family: AF_UNIX, address: key, port: 0 };
    } else {
      key = addr.address;
    }
    if (key.startsWith('\0')) {
      if (this.unixNames.has(key)) return -EADDRINUSE;
      this.unixNames.set(key, s);
    } else {
      const p = ops.resolve(key);
      if (typeof p === 'number') return p;
      if (await ops.exists(p)) return -EADDRINUSE;
      const r = await ops.create(p);
      if (r < 0) return r;
      key = p;
      this.unixPaths.add(p);
    }
    s.unixKey = key;
    s.local = { family: AF_UNIX, address: addr.address, port: 0 };
    if (s.state === 'unbound') s.state = 'bound';
    if (s.type === SOCK_DGRAM) this.unixDgram.set(key, s);
    return 0;
  }

  /** The registry key `addr` names (a resolved socket file path, or "\0name"), or -errno */
  private async unixKeyOf(addr: SockAddr, ops: UnixOps): Promise<string | number> {
    if (addr.address === '') return -EINVAL;
    if (addr.address.startsWith('\0')) return addr.address;
    const p = ops.resolve(addr.address);
    if (typeof p === 'number') return p;
    if (!(await ops.exists(p))) return -ENOENT;
    const w = (await ops.mayWrite?.(p)) ?? 0;
    return w < 0 ? w : p;
  }

  /** sendto(2) of an AF_UNIX datagram to a bound datagram socket */
  async sendtoUnix(data: Uint8Array, addr: SockAddr, ops: UnixOps, from: SockAddr | null): Promise<number> {
    const key = await this.unixKeyOf(addr, ops);
    if (typeof key === 'number') return key;
    const target = this.unixDgram.get(key);
    if (!target) return this.unixListeners.has(key) ? -EPROTOTYPE : -ECONNREFUSED;
    if (data.length > this.config.sndbuf) return -EMSGSIZE;
    target._deliver(data.slice(), undefined, from);
    return data.length;
  }

  /** connect(2) of an AF_UNIX stream socket to a listener in this kernel. */
  async connectUnix(s: KSocket, addr: SockAddr, ops: UnixOps): Promise<number> {
    if (s.type === SOCK_DGRAM) {
      // A datagram socket's connect sets where its messages go
      if (s.state === 'closed') return -EBADF;
      const key = await this.unixKeyOf(addr, ops);
      if (typeof key === 'number') return key;
      const target = this.unixDgram.get(key);
      if (!target) return this.unixListeners.has(key) ? -EPROTOTYPE : -ECONNREFUSED;
      s._attach(new DgramPeer(target, s), s.local ?? { family: AF_UNIX, address: '', port: 0 }, { ...target.local! });
      return 0;
    }
    if (s.state === 'connected' || s.state === 'listening') return s.state === 'connected' ? -EISCONN : -EINVAL;
    if (s.state === 'closed') return -EBADF;
    if (addr.address === '') return -EINVAL;
    let key = addr.address;
    if (!key.startsWith('\0')) {
      const p = ops.resolve(key);
      if (typeof p === 'number') return p;
      if (!(await ops.exists(p))) return -ENOENT;
      const w = (await ops.mayWrite?.(p)) ?? 0;
      if (w < 0) return w;
      key = p;
    }
    const listener = this.unixListeners.get(key);
    if (!listener && this.unixDgram.has(key)) return -EPROTOTYPE;
    if (!listener || listener.state !== 'listening') return -ECONNREFUSED;
    if (listener.type !== s.type) return -EPROTOTYPE;
    const server = new KSocket(this, AF_UNIX, 0, 0, s.type);
    server.ownerPid = listener.ownerPid;
    server.unixKey = listener.unixKey;
    if (!listener._enqueue(server)) return -EAGAIN;
    const local = s.local ?? { family: AF_UNIX, address: '', port: 0 };
    server.peerPid = s.ownerPid;
    s.peerPid = listener.ownerPid;
    server._attach(new LoopbackPeer(server, s), { ...listener.local! }, { ...local });
    s._attach(new LoopbackPeer(s, server), local, { ...listener.local! });
    return 0;
  }

  /** A socket file was unlinked: it no longer stats as a socket. */
  forgetUnixPath(path: string): void {
    this.unixPaths.delete(path);
  }

  ephemeral(): number {
    for (let i = 0; i < 28232; i++) {
      const p = this.nextEphemeral;
      this.nextEphemeral = p >= 60999 ? 32768 : p + 1;
      if (!this.bound.has(p) && !this.listeners.has(p) && !this.udp.has(p)) return p;
    }
    return 0;
  }

  /** @internal */ autobindAddr(family: number, s: KSocket, address: string): SockAddr {
    const port = this.ephemeral();
    this.bound.set(port, [{ s, use: { family, address, v6only: s.v6only } }]);
    return { family, address, port };
  }

  /** @internal Take `port` for `s` bound to `use`; false if an overlapping binding holds it (EADDRINUSE). */
  claimPort(port: number, s: KSocket, reuse: boolean, use: PortUse): boolean {
    const holders = (this.bound.get(port) ?? []).filter((h) => h.s !== s);
    for (const h of holders) {
      if (portsOverlap(h.use, use) && !(reuse && h.s.state !== 'listening')) return false;
    }
    this.bound.set(port, [...holders, { s, use }]);
    return true;
  }

  /** @internal */ releasePort(port: number, s: KSocket): void {
    const rest = (this.bound.get(port) ?? []).filter((h) => h.s !== s);
    if (rest.length) this.bound.set(port, rest); else this.bound.delete(port);
  }

  /** @internal Bind UDP socket `s` to `port`: false when an overlapping binding holds it (unless both share it with SO_REUSEADDR/SO_REUSEPORT) */
  claimUdp(port: number, s: KDatagramSocket): boolean {
    const holders = (this.udp.get(port) ?? []).filter((h) => h !== s);
    if (holders.some((h) => portsOverlap(h.portUse(), s.portUse()) && !(h.reusable && s.reusable))) return false;
    this.udp.set(port, [...holders, s]);
    return true;
  }

  /** @internal */ releaseUdp(port: number, s: KDatagramSocket): void {
    const rest = (this.udp.get(port) ?? []).filter((h) => h !== s);
    if (rest.length) this.udp.set(port, rest); else this.udp.delete(port);
  }

  /** @internal The UDP socket a datagram to `host`:`port` from `from` reaches here (a connected one only from its peer) */
  udpReceiver(port: number, host: string, from: SockAddr): KDatagramSocket | undefined {
    const to: PortUse = { family: host.includes(':') ? AF_INET6 : AF_INET, address: host, v6only: false };
    const v4 = (a: string) => a.replace(/^::ffff:/i, '');
    const fromPeer = (h: KDatagramSocket) => !h.remote || (h.remote.port === from.port && v4(h.remote.address) === v4(from.address));
    const hs = (this.udp.get(port) ?? []).filter((h) => fromPeer(h) && portsOverlap(h.portUse(), to));
    // the most specific binding wins (an address over the wildcard), as Linux scores them
    return hs.find((h) => !/^(0\.0\.0\.0|::)$/.test(h.portUse().address)) ?? hs[0];
  }

  /** @internal The listener on `port` that takes a connection to `host` (one of the port's, if none binds that address) */
  listenerFor(port: number, host: string): KSocket | undefined {
    const ls = this.listeners.get(port);
    if (!ls?.length) return undefined;
    const to: PortUse = { family: host.includes(':') ? AF_INET6 : AF_INET, address: host, v6only: false };
    return ls.find((l) => portsOverlap(l.portUse(), to)) ?? ls.find((l) => !(l.v6only && to.family === AF_INET));
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
      try {
        undo = host.serve(port, (req) => this.bridgeHttp(listener, req), `socket:${port}`,
          { connect: (conn) => { void this.bridgeConnect(listener, conn); } });
      } catch { /* port taken */ }
    });
    return () => { cancelled = true; undo?.(); };
  }

  /**
   * A raw connection from the page (a preview's WebSocket) to `listener`:
   * an accepted loopback connection, bytes piped both ways until either side ends.
   */
  async bridgeConnect(listener: KSocket, conn: ByteChannel): Promise<void> {
    const client = new KSocket(this, AF_INET, 0, 0);
    const r = await client.connect({ family: AF_INET, address: '127.0.0.1', port: listener.local!.port });
    if (r < 0) { conn.close(); return; }
    const toGuest = (async () => {
      for (let d = await conn.read(); d; d = await conn.read()) {
        if (await client.write(d) < 0) break;
      }
    })();
    const toPage = (async () => {
      const buf = new Uint8Array(64 * 1024);
      for (;;) {
        const n = await client.read(buf);
        if (n <= 0) break;
        try { await conn.write(buf.slice(0, n)); } catch { break; }
      }
    })();
    await Promise.race([toGuest, toPage]).catch(() => {});
    conn.close();
    await client.close();
  }

  /** Turn one virtual HTTP request into an accepted connection on `listener`. */
  /**
   * A page request (a preview's fetch) to a kernel listener, as HTTP over a
   * loopback connection. The head has httpBridgeTimeoutMs to come; a body
   * that is all there soon after is returned whole, and one still coming
   * (server-sent events, chunked writes, a long poll) is a ReadableStream of
   * its bytes as they arrive (cancelling it closes the connection).
   */
  async bridgeHttp(listener: KSocket, req: VirtualHttpRequest): Promise<VirtualHttpResponse> {
    const client = new KSocket(this, AF_INET, 0, 0);
    const r = await client.connect({ family: AF_INET, address: '127.0.0.1', port: listener.local!.port });
    if (r < 0) return { status: 503, body: `connect: ${errnoName(-r)}` };
    await client.write(encodeHttpRequest(req, listener.local!.port));
    return readHttpResponse(client, req.method.toUpperCase(), this.config.httpBridgeTimeoutMs);
  }

  // ── relay plumbing ──

  /**
   * One kernel log line (dmesg) about the relay, rate-limited so a retry loop
   * can't flood the buffer. curl and git only say "Could not connect"; this
   * says why (no relay, token refused, handshake refused, relay error).
   */
  relayLog(request: object, why: string): void {
    const r = request as { op?: string; host?: string; port?: number };
    const target = r.host ? `${r.host}${r.port !== undefined ? ':' + r.port : ''}` : '';
    const what = `${r.op ?? 'request'}${target ? (r.op === 'resolve' ? ' of ' : ' to ') + target : ''}`;
    klog.logRatelimited(LOG_WARNING, `net: relay refused ${what}: ${why}`);
  }

  private async relayToken(): Promise<string | null> {
    const { tokenUrl } = this.config;
    if (!tokenUrl) return null;
    if (this.token && this.token.expires - 30_000 > Date.now()) return this.token.token;
    const f = this.config.fetch ?? fetch;
    // A saved sign-in goes along, so a relay that requires one connects silently
    const post = (cred: string | null) => f(tokenUrl, {
      method: 'POST', credentials: 'same-origin' as RequestCredentials,
      ...(cred ? { headers: { Authorization: `Bearer ${cred}` } } : {}),
    });
    const own = this.config.credentials;
    const fetchToken = async (cred: string | null) => {
      try { return await post(cred); } catch (e) {
        throw new Error(`token request failed: ${(e as Error)?.message ?? e}`);
      }
    };
    let res = await fetchToken(own ? networkCredential() : null);
    let signedIn = false;
    if (res.status === 401 && own) {
      // The relay wants a signed-in user: ask once (src/net-signin.ts), then retry
      const cred = await requireNetworkSignIn({ reason: 'A program wants to connect to the internet' });
      if (!cred) { setNetworkStatus('needs-sign-in'); throw new Error('sign-in required (token 401)'); }
      res = await fetchToken(cred);
      signedIn = true;
    }
    if (!res.ok) {
      const why = res.status === 401 ? (signedIn ? 'sign-in not accepted (token 401)' : 'sign-in required (token 401)')
        : res.status === 403 ? 'this page\'s origin is not allowed (token 403)'
        : res.status === 404 ? 'no relay at this server (token 404)'
        : `token request failed (${res.status})`;
      throw new Error(why);
    }
    setNetworkStatus(own && networkCredential() ? 'signed-in' : 'online');
    this.token = await res.json();
    return this.token!.token;
  }

  /**
   * Open a relay WebSocket, send `request`, and hand each text reply to `onMsg`
   * until it settles. Rejects with a positive errno.
   */
  openRelay<T>(request: object, onMsg: (ws: WebSocket, msg: Record<string, unknown>, settle: (v: T) => void) => boolean): Promise<T> {
    const { relayUrl } = this.config;
    if (!relayUrl) { this.relayLog(request, 'no relay configured'); return Promise.reject(ENETUNREACH); }
    const WS = this.config.WebSocket ?? (globalThis as any).WebSocket;
    if (!WS) { this.relayLog(request, 'no WebSocket in this context'); return Promise.reject(ENETUNREACH); }
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
          if (!settled) this.relayLog(request, `${String(msg.code ?? 'error')}${msg.message ? ` (${String(msg.message)})` : ''}`);
          done(() => reject(ERRNO_BY_NAME[String(msg.code)] ?? EIO));
          try { ws.close(); } catch { /* closing */ }
          return;
        }
        if (onMsg(ws, msg, (v) => done(() => resolve(v)))) settled = true;
      };
      const failed = (ev?: { code?: number; reason?: string }) => {
        if (settled) return;
        settled = true;
        // A refused handshake (expired token, relay off, limits) fails before open: refresh the token once
        if (!opened && retry && this.config.tokenUrl) { this.token = null; attempt(false).then(resolve, reject); return; }
        // Browsers don't expose the HTTP status of a refused handshake; give the close code when there is one
        const code = ev && typeof ev.code === 'number' ? ` (close ${ev.code}${ev.reason ? ` ${ev.reason}` : ''})` : '';
        if (opened) this.relayLog(request, `relay closed the connection before replying${code}`);
        else this.relayLog(request, `handshake refused${code}${this.config.tokenUrl ? ' after token refresh' : ''}`);
        reject(opened ? ECONNRESET : ENETUNREACH);
      };
      // Browsers fire error then close; Node's WebSocket only fires error for a refused handshake.
      // Let a close that follows the error at once supply its code.
      ws.onerror = () => { if (!opened) setTimeout(() => failed(), 0); };
      ws.onclose = (ev: CloseEvent) => failed(ev);
    }), (e) => {
      this.relayLog(request, (e as Error)?.message ?? String(e));
      return Promise.reject(ENETUNREACH);
    });
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

/** Filesystem access for AF_UNIX path sockets, in the calling process's view. */
export interface UnixOps {
  /** Absolute path for `path` (relative to the cwd), or -errno. */
  resolve(path: string): string | number;
  exists(path: string): Promise<boolean>;
  /** Make the socket file; 0 or -errno. */
  create(path: string): Promise<number>;
  /** connect/sendto need write permission on the socket file: 0 or -EACCES */
  mayWrite?(path: string): Promise<number>;
}

// ── Channel syscalls (docs/NETWORKING.md "Kernel syscalls") ──

type AnySocket = KSocket | KDatagramSocket | KNetlinkSocket;

/**
 * Socket syscalls in the SAB-channel form of docs/KERNEL_ABI.md. `kernel.syscall`
 * forwards SYS_socket..SYS_getsockopt and SYS_accept4 here; returns undefined
 * for numbers it doesn't own. `onSigpipe` runs when a send fails with EPIPE
 * without MSG_NOSIGNAL.
 */
export async function netSyscall(
  proc: { fds: FdTable; syscallSignal?: AbortSignal; pid?: number },
  nr: number,
  args: ArrayLike<number>,
  data: Uint8Array,
  onSigpipe?: () => void,
  stack: NetStack = netStack,
  unix?: UnixOps,
): Promise<number | undefined> {
  const sig = proc.syscallSignal;
  const sockOf = (fd: number): AnySocket | number => {
    const f = proc.fds.get(fd);
    if (!f) return -EBADF;
    return f instanceof KSocket || f instanceof KDatagramSocket || f instanceof KNetlinkSocket ? f : -ENOTSOCK;
  };
  const addrIn = (off: number, len: number) => decodeSockaddr(data.subarray(off, off + Math.min(len, SOCKADDR_UN_MAX)));
  /** Write `sa` at `off`; one that doesn't fit `room` (a long AF_UNIX path) goes out unnamed. */
  const addrOut = (sa: SockAddr, off = 0, room = data.length - off) => {
    let b = encodeSockaddr(sa);
    if (b.length > room) b = new Uint8Array([AF_UNIX, 0]);
    data.set(b, off);
    return b.length;
  };
  /**
   * A peer/sender address for accept, recvfrom and recvmsg. Callers that pass
   * an address room (`room` > 4; the call's last argument) get an area of that
   * size whose last 4 bytes hold the address's length (an abstract AF_UNIX
   * name keeps its trailing NULs, a long path fits); without it, the legacy
   * SOCKADDR_ROOM bytes and no length.
   */
  const roomOf = (v: number | undefined) => ((v ?? 0) | 0) > 4 ? Math.min((v ?? 0) | 0, 256) : 0;
  const peerOut = (sa: SockAddr, off: number, room: number) => {
    if (!room) { addrOut(sa, off, SOCKADDR_ROOM); return; }
    let b = encodeSockaddr(sa);
    if (b.length > room - 4) b = new Uint8Array([AF_UNIX, 0]);
    data.set(b, off);
    new DataView(data.buffer, data.byteOffset + off + room - 4, 4).setUint32(0, b.length, true);
  };
  const noUnix: UnixOps = { resolve: () => -EOPNOTSUPP, exists: async () => false, create: async () => -EOPNOTSUPP };
  const install = async (s: AnySocket, cloexec: boolean) => {
    const fd = proc.fds.alloc(s, 0, cloexec);
    if (fd < 0) await s.close();
    return fd;
  };

  switch (nr) {
    case SYS_socket: { // domain, type, protocol
      const s = stack.socket(args[0], args[1], args[2]);
      if (typeof s === 'number') return s;
      if (s instanceof KSocket) s.ownerPid = proc.pid ?? 0;
      return install(s, (args[1] & SOCK_CLOEXEC) !== 0);
    }
    case SYS_socketpair: { // domain, type → int32 sv[2]
      if (args[0] !== AF_UNIX) {
        // Linux creates the socket first (bad type, protocol or domain fail there), then the family says no
        const s = stack.socket(args[0], args[1], args[2]);
        if (typeof s === 'number') return s;
        await s.close();
        return -EOPNOTSUPP;
      }
      const base = args[1] & 0xf;
      if (base < 1 || base > 10 || (args[1] & ~(0xf | SOCK_NONBLOCK | SOCK_CLOEXEC))) return -EINVAL;
      const pair = stack.socketpair(args[1]);
      if (typeof pair === 'number') return pair;
      for (const p of pair) p.ownerPid = p.peerPid = proc.pid ?? 0;
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
      if (s instanceof KSocket && s.domain === AF_UNIX) {
        if (sa.family !== AF_UNIX) return -EINVAL;
        return nr === SYS_bind ? stack.bindUnix(s, sa, unix ?? noUnix) : stack.connectUnix(s, sa, unix ?? noUnix);
      }
      if (sa.family === AF_UNIX) return -EAFNOSUPPORT; // an AF_UNIX address on an inet socket
      if (nr === SYS_bind) return sa.family === 0 ? -EAFNOSUPPORT : s.bind(sa);
      if (sa.family === 0) return s instanceof KDatagramSocket ? s.disconnect() : -EAFNOSUPPORT;
      return s instanceof KSocket ? s.connect(sa, sig) : s.connect(sa);
    }
    case SYS_listen: { // fd, backlog
      const s = sockOf(args[0]);
      if (typeof s === 'number') return s;
      return s instanceof KSocket ? s.listen(args[1]) : -EOPNOTSUPP;
    }
    case SYS_accept:
    case SYS_accept4: { // fd, flags, room → data = peer sockaddr (see peerOut)
      const s = sockOf(args[0]);
      if (typeof s === 'number') return s;
      if (!(s instanceof KSocket) || s.type === SOCK_DGRAM) return -EOPNOTSUPP;
      const flags = nr === SYS_accept4 ? args[1] : 0;
      const c = await s.accept(flags, sig);
      if (typeof c === 'number') return c;
      const peer = c.getpeername();
      const room = roomOf(args[2]);
      if (room) data.fill(0, 0, room);
      if (typeof peer !== 'number') peerOut(peer, 0, room);
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
      if (s instanceof KDatagramSocket || s instanceof KNetlinkSocket) {
        let to: SockAddr | null = null;
        if (args[3] > 0) {
          const sa = addrIn(len, args[3]);
          if (typeof sa === 'number') return sa;
          to = sa;
        }
        n = await s.sendto(data.subarray(0, len), args[2], to);
      } else if (s.domain === AF_UNIX && s.type === SOCK_DGRAM && args[3] > 0 && s.state !== 'connected') {
        const sa = addrIn(len, args[3]);
        if (typeof sa === 'number') return sa;
        n = await stack.sendtoUnix(data.subarray(0, len), sa, unix ?? noUnix, s.local);
      } else {
        n = await s.send(data.subarray(0, len), args[2], sig);
      }
      if (n === -EPIPE && !(args[2] & MSG_NOSIGNAL)) onSigpipe?.();
      return n;
    }
    case SYS_recvfrom: { // fd, len, flags, room → data = bytes, sender sockaddr at offset len (SOCKADDR_ROOM bytes, or room: see peerOut)
      const s = sockOf(args[0]);
      if (typeof s === 'number') return s;
      const room = roomOf(args[3]);
      const area = room || SOCKADDR_ROOM;
      const len = Math.min(args[1] >>> 0, Math.max(0, data.length - area));
      if (s instanceof KDatagramSocket || s instanceof KNetlinkSocket) {
        const r = await s.recvfrom(data.subarray(0, len), args[2], sig);
        if (typeof r === 'number') return r;
        data.fill(0, len, len + area);
        peerOut(r.from, len, room);
        return r.n;
      }
      const n = await s.recv(data.subarray(0, len), args[2], sig);
      if (n >= 0) {
        data.fill(0, len, len + area);
        // An AF_UNIX datagram's sender (unnamed when it isn't bound)
        const peer = s.domain === AF_UNIX && s.type === SOCK_DGRAM ? s.lastFrom ?? { family: AF_UNIX, address: '', port: 0 } : s.getpeername();
        if (typeof peer !== 'number') peerOut(peer, len, room);
      }
      return n;
    }
    case SYS_sendmsg: { // fd, len, flags, addrLen, ctrlLen; data = bytes, sockaddr, control (Linux cmsg layout)
      const s = sockOf(args[0]);
      if (typeof s === 'number') return s;
      const len = Math.min(args[1] >>> 0, data.length);
      const alen = Math.max(0, args[3] | 0);
      const clen = Math.max(0, Math.min(args[4] | 0, data.length - len - alen));
      const ctrl = data.subarray(len + alen, len + alen + clen);
      // SCM_RIGHTS: take a reference to each description for the trip
      const files: OpenFile[] = [];
      const dv = new DataView(ctrl.buffer, ctrl.byteOffset, ctrl.byteLength);
      for (let off = 0; off + 16 <= ctrl.length;) {
        const cl = Number(dv.getBigUint64(off, true));
        if (cl < 16 || off + cl > ctrl.length) break;
        if (dv.getInt32(off + 8, true) === SOL_SOCKET && dv.getInt32(off + 12, true) === SCM_RIGHTS) {
          for (let p = off + 16; p + 4 <= off + cl; p += 4) {
            const f = proc.fds.get(dv.getInt32(p, true));
            if (!f) { for (const g of files) void release(g); return -EBADF; }
            files.push(retain(f));
          }
        }
        off += (cl + 7) & ~7;
      }
      if (files.length && !(s instanceof KSocket && s.domain === AF_UNIX)) { for (const g of files) void release(g); return -EOPNOTSUPP; }
      let n: number;
      if (s instanceof KDatagramSocket || s instanceof KNetlinkSocket) {
        let to: SockAddr | null = null;
        if (alen > 0) {
          const sa = addrIn(len, alen);
          if (typeof sa === 'number') return sa;
          to = sa;
        }
        n = await s.sendto(data.subarray(0, len), args[2], to);
      } else if (s.domain === AF_UNIX && s.type === SOCK_DGRAM && args[3] > 0 && s.state !== 'connected') {
        const sa = addrIn(len, args[3]);
        if (typeof sa === 'number') return sa;
        n = await stack.sendtoUnix(data.subarray(0, len), sa, unix ?? noUnix, s.local);
      } else {
        n = await s.send(data.subarray(0, len), args[2], sig, files.length ? files : undefined);
      }
      if (n === -EPIPE && !(args[2] & MSG_NOSIGNAL)) onSigpipe?.();
      return n;
    }
    case SYS_recvmsg: { // fd, len, flags, ctrlCap, room → data = bytes, sockaddr (SOCKADDR_ROOM, or room: see peerOut), u32 controllen, u32 msg_flags, control
      const s = sockOf(args[0]);
      if (typeof s === 'number') return s;
      const cap = Math.max(0, args[3] | 0);
      const room = roomOf(args[4]);
      const area = room || SOCKADDR_ROOM;
      const len = Math.min(args[1] >>> 0, Math.max(0, data.length - area - 8 - cap));
      const meta = len + area;
      data.fill(0, len, meta + 8);
      if (s instanceof KDatagramSocket || s instanceof KNetlinkSocket) {
        const r = await s.recvfrom(data.subarray(0, len), args[2], sig);
        if (typeof r === 'number') return r;
        peerOut(r.from, len, room);
        return r.n;
      }
      const fds: OpenFile[] = [];
      const n = await s.recv(data.subarray(0, len), args[2], sig, fds);
      if (n < 0) return n;
      const peer = s.domain === AF_UNIX && s.type === SOCK_DGRAM ? s.lastFrom ?? { family: AF_UNIX, address: '', port: 0 } : s.getpeername();
      if (typeof peer !== 'number') peerOut(peer, len, room);
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      // A message longer than the buffer: the rest was dropped (MSG_TRUNC in msg_flags)
      if (s.type !== SOCK_STREAM && s.lastMsgLen > Math.min(n, len)) dv.setUint32(meta + 4, MSG_TRUNC, true);
      if (fds.length) {
        // As many as fit the caller's control buffer; the rest are closed (MSG_CTRUNC)
        const fit = Math.max(0, Math.min(fds.length, Math.floor((cap - 16) / 4)));
        const ctrl = meta + 8;
        let k = 0;
        for (const f of fds.slice(0, fit)) {
          const fd = proc.fds.alloc(f, 0, (args[2] & MSG_CMSG_CLOEXEC) !== 0);
          if (fd < 0) break;
          dv.setInt32(ctrl + 16 + k * 4, fd, true);
          k++;
        }
        for (const f of fds) void release(f); // the trip's references (the table took its own)
        if (k) {
          dv.setBigUint64(ctrl, BigInt(16 + k * 4), true);
          dv.setInt32(ctrl + 8, SOL_SOCKET, true);
          dv.setInt32(ctrl + 12, SCM_RIGHTS, true);
          dv.setUint32(meta, Math.min(cap, (16 + k * 4 + 7) & ~7), true);
        }
        if (k < fds.length) dv.setUint32(meta + 4, dv.getUint32(meta + 4, true) | MSG_CTRUNC, true);
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

/** Route the kernel's socket syscalls to `stack`; EPIPE without MSG_NOSIGNAL raises SIGPIPE. Returns the unregister function. */
const installedStacks = new WeakMap<Kernel, NetStack>();

export function installNet(kernel: Kernel, stack: NetStack = netStack): () => void {
  installedStacks.set(kernel, stack);
  const off = kernel.registerSyscalls(SOCKET_SYSCALLS, (proc, nr, args, data, k) =>
    netSyscall(proc, nr, args, data, () => k.deliver(proc, SIGPIPE), stack, unixOpsFor(k, proc)));
  kernel.socketPaths = stack.unixPaths;
  return () => { off(); if (installedStacks.get(kernel) === stack) installedStacks.delete(kernel); };
}

/** AF_UNIX path sockets in `proc`'s view of the kernel's filesystem. */
function unixOpsFor(k: Kernel, proc: Parameters<Kernel['resolvePath']>[0]): UnixOps {
  return {
    resolve: (path) => k.resolvePath(proc, path),
    exists: async (path) => !!k.fs && (await k.fs.exists(path)),
    mayWrite: async (path) => {
      if (!k.fs || proc.uid === 0) return 0;
      const st = await k.fs.stat(path).catch(() => null);
      // (files have no owner of their own: they stat as the caller's, so the owner bits apply)
      return !st || st.mode & 0o200 ? 0 : -EACCES;
    },
    create: async (path) => {
      if (!k.fs) return -EOPNOTSUPP;
      try {
        await k.fs.writeFile(path, new Uint8Array(0));
        return 0;
      } catch (e) {
        const code = (e as { code?: string }).code;
        return code === 'ENOENT' ? -ENOENT : code === 'ENOTDIR' ? -20 : code === 'EACCES' ? -EACCES : -EIO;
      }
    },
  };
}

/** The NetStack `installNet` gave this kernel (name resolution for runtimes with their own resolver call, like WASIX). */
export function netStackOf(kernel: Kernel): NetStack | undefined {
  return installedStacks.get(kernel);
}

if (typeof window !== 'undefined') (window as any).__shiroNet = netStack;
