/**
 * AF_NETLINK sockets (net.ts hands them out from socket()): enough of the
 * kernel's netlink for programs that ask about the network configuration.
 *
 * - NETLINK_ROUTE: RTM_GETLINK, RTM_GETADDR and RTM_GETROUTE answer for two
 *   interfaces, lo and a virtual eth0 holding the address outbound TCP
 *   reports (10.0.2.15/24 via 10.0.2.2, fd00::15/64, as in net.ts). That is
 *   what `ip addr`, `ip route` and glibc's getifaddrs() read. Changes
 *   (RTM_NEWADDR, ...) are EPERM: the page's network can't be configured.
 * - NETLINK_SOCK_DIAG: dumps are empty (`ss` lists no sockets).
 * - NETLINK_NETFILTER and the other families: a socket that opens and binds
 *   (nft does that even for --version) and answers every request with EPERM.
 */
import type { KStat } from './abi';
import type { OpenFile } from './fd';
import {
  EBADF, EAGAIN, EINTR, EINVAL, EPERM, EOPNOTSUPP, ENOTCONN, ENOTTY, O_NONBLOCK, POLLIN, POLLOUT, POLLNVAL,
  POLLERR, POLLHUP, MSG_PEEK, MSG_DONTWAIT, MSG_TRUNC, SOL_SOCKET, SO_TYPE, SO_DOMAIN, SO_PROTOCOL, SO_ERROR,
  SO_RCVTIMEO, FIONREAD, FIONBIO, S_IFSOCK,
} from './abi';

export const AF_NETLINK = 16;
export const NETLINK_ROUTE = 0;
export const NETLINK_SOCK_DIAG = 4;

// nlmsghdr types and flags
const NLMSG_ERROR = 2, NLMSG_DONE = 3;
const NLM_F_REQUEST = 1, NLM_F_MULTI = 2, NLM_F_DUMP = 0x300;
// rtnetlink
const RTM_NEWLINK = 16, RTM_GETLINK = 18, RTM_NEWADDR = 20, RTM_GETADDR = 22, RTM_NEWROUTE = 24, RTM_GETROUTE = 26;
const AF_UNSPEC = 0, AF_INET = 2, AF_INET6 = 10;
const IFLA_ADDRESS = 1, IFLA_BROADCAST = 2, IFLA_IFNAME = 3, IFLA_MTU = 4, IFLA_QDISC = 6, IFLA_TXQLEN = 13,
  IFLA_OPERSTATE = 16, IFLA_LINKMODE = 17, IFLA_GROUP = 27;
const IFA_ADDRESS = 1, IFA_LOCAL = 2, IFA_LABEL = 3, IFA_BROADCAST = 4, IFA_FLAGS = 8;
const RTA_DST = 1, RTA_OIF = 4, RTA_GATEWAY = 5, RTA_PRIORITY = 6, RTA_PREFSRC = 7, RTA_TABLE = 15;
const IFF_UP = 0x1, IFF_BROADCAST = 0x2, IFF_LOOPBACK = 0x8, IFF_RUNNING = 0x40, IFF_MULTICAST = 0x1000, IFF_LOWER_UP = 0x10000;
const ARPHRD_ETHER = 1, ARPHRD_LOOPBACK = 772;
const IF_OPER_UNKNOWN = 0, IF_OPER_UP = 6;
const RT_SCOPE_UNIVERSE = 0, RT_SCOPE_LINK = 253, RT_SCOPE_HOST = 254;
const RT_TABLE_MAIN = 254, RTPROT_KERNEL = 2, RTPROT_STATIC = 4, RTN_UNICAST = 1;
const IFA_F_PERMANENT = 0x80;

interface Iface {
  index: number; name: string; type: number; flags: number; mtu: number; mac: number[]; brd: number[]; oper: number;
  addrs: { family: number; addr: number[]; prefix: number; scope: number; brd?: number[] }[];
}

const v4 = (s: string) => s.split('.').map(Number);
const v6 = (groups: number[]) => groups.flatMap((g) => [g >> 8, g & 0xff]);

/** lo, and eth0 with the addresses net.ts gives outbound sockets. */
export const IFACES: Iface[] = [
  {
    index: 1, name: 'lo', type: ARPHRD_LOOPBACK, flags: IFF_UP | IFF_LOOPBACK | IFF_RUNNING | IFF_LOWER_UP, mtu: 65536,
    mac: [0, 0, 0, 0, 0, 0], brd: [0, 0, 0, 0, 0, 0], oper: IF_OPER_UNKNOWN,
    addrs: [
      { family: AF_INET, addr: v4('127.0.0.1'), prefix: 8, scope: RT_SCOPE_HOST },
      { family: AF_INET6, addr: v6([0, 0, 0, 0, 0, 0, 0, 1]), prefix: 128, scope: RT_SCOPE_HOST },
    ],
  },
  {
    index: 2, name: 'eth0', type: ARPHRD_ETHER, flags: IFF_UP | IFF_BROADCAST | IFF_RUNNING | IFF_MULTICAST | IFF_LOWER_UP,
    mtu: 1500, mac: [0x52, 0x54, 0x00, 0x12, 0x34, 0x56], brd: [0xff, 0xff, 0xff, 0xff, 0xff, 0xff], oper: IF_OPER_UP,
    addrs: [
      { family: AF_INET, addr: v4('10.0.2.15'), prefix: 24, scope: RT_SCOPE_UNIVERSE, brd: v4('10.0.2.255') },
      { family: AF_INET6, addr: v6([0xfd00, 0, 0, 0, 0, 0, 0, 0x15]), prefix: 64, scope: RT_SCOPE_UNIVERSE },
    ],
  },
];

// ── Message building ──

class Msg {
  private parts: number[] = [];
  u8(v: number) { this.parts.push(v & 0xff); return this; }
  u16(v: number) { this.parts.push(v & 0xff, (v >> 8) & 0xff); return this; }
  u32(v: number) { for (let i = 0; i < 4; i++) this.parts.push((v >>> (8 * i)) & 0xff); return this; }
  bytes(b: ArrayLike<number>) { for (let i = 0; i < b.length; i++) this.parts.push(b[i]); return this; }
  pad() { while (this.parts.length % 4) this.parts.push(0); return this; }
  /** An rtattr: u16 len, u16 type, payload, padded to 4. */
  attr(type: number, payload: ArrayLike<number>) { return this.u16(4 + payload.length).u16(type).bytes(payload).pad(); }
  attrU32(type: number, v: number) { return this.attr(type, new Msg().u32(v).out()); }
  attrStr(type: number, s: string) { return this.attr(type, [...new TextEncoder().encode(s), 0]); }
  out(): Uint8Array { return Uint8Array.from(this.parts); }
}

/** One netlink message: nlmsghdr + body, padded. */
function nlmsg(type: number, flags: number, seq: number, pid: number, body: Uint8Array): Uint8Array {
  return new Msg().u32(16 + body.length).u16(type).u16(flags).u32(seq).u32(pid).bytes(body).pad().out();
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

function linkMsg(i: Iface): Uint8Array {
  return new Msg()
    .u8(AF_UNSPEC).u8(0).u16(i.type).u32(i.index).u32(i.flags).u32(0) // ifinfomsg
    .attrStr(IFLA_IFNAME, i.name).attrU32(IFLA_MTU, i.mtu).attrStr(IFLA_QDISC, i.index === 1 ? 'noqueue' : 'fq_codel')
    .attrU32(IFLA_TXQLEN, i.index === 1 ? 1000 : 1000).attr(IFLA_OPERSTATE, [i.oper]).attr(IFLA_LINKMODE, [0])
    .attrU32(IFLA_GROUP, 0).attr(IFLA_ADDRESS, i.mac).attr(IFLA_BROADCAST, i.brd).out();
}

function addrMsg(i: Iface, a: Iface['addrs'][number]): Uint8Array {
  const m = new Msg().u8(a.family).u8(a.prefix).u8(IFA_F_PERMANENT).u8(a.scope).u32(i.index) // ifaddrmsg
    .attr(IFA_ADDRESS, a.addr);
  if (a.family === AF_INET) m.attr(IFA_LOCAL, a.addr);
  if (a.brd) m.attr(IFA_BROADCAST, a.brd);
  if (a.family === AF_INET) m.attrStr(IFA_LABEL, i.name);
  return m.attrU32(IFA_FLAGS, IFA_F_PERMANENT).out();
}

function routeMsgs(family: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  const route = (fam: number, dst: number[] | null, dstLen: number, gw: number[] | null, scope: number, proto: number, src?: number[], prio?: number) => {
    const m = new Msg().u8(fam).u8(dstLen).u8(0).u8(0).u8(RT_TABLE_MAIN).u8(proto).u8(scope).u8(RTN_UNICAST).u32(0) // rtmsg
      .attrU32(RTA_TABLE, RT_TABLE_MAIN);
    if (dst) m.attr(RTA_DST, dst);
    if (gw) m.attr(RTA_GATEWAY, gw);
    if (src) m.attr(RTA_PREFSRC, src);
    if (prio !== undefined) m.attrU32(RTA_PRIORITY, prio);
    out.push(m.attrU32(RTA_OIF, 2).out());
  };
  if (family === AF_UNSPEC || family === AF_INET) {
    route(AF_INET, null, 0, v4('10.0.2.2'), RT_SCOPE_UNIVERSE, RTPROT_STATIC);
    route(AF_INET, v4('10.0.2.0'), 24, null, RT_SCOPE_LINK, RTPROT_KERNEL, v4('10.0.2.15'));
  }
  if (family === AF_UNSPEC || family === AF_INET6) {
    route(AF_INET6, v6([0xfd00, 0, 0, 0, 0, 0, 0, 0]), 64, null, RT_SCOPE_UNIVERSE, RTPROT_KERNEL, undefined, 256);
    route(AF_INET6, null, 0, v6([0xfd00, 0, 0, 0, 0, 0, 0, 2]), RT_SCOPE_UNIVERSE, RTPROT_STATIC, undefined, 1024);
  }
  return out;
}

/** The replies (datagrams) to one request message. */
export function answer(protocol: number, req: Uint8Array, portid: number): Uint8Array[] {
  if (req.length < 16) return [];
  const dv = new DataView(req.buffer, req.byteOffset, req.byteLength);
  const type = dv.getUint16(4, true), flags = dv.getUint16(6, true), seq = dv.getUint32(8, true);
  const err = (errno: number) => nlmsg(NLMSG_ERROR, 0, seq, portid, concat([new Msg().u32(-errno).out(), req.subarray(0, 16)]));
  const dump = (entries: Uint8Array[], rtype: number) => [
    ...(entries.length ? [concat(entries.map((e) => nlmsg(rtype, NLM_F_MULTI, seq, portid, e)))] : []),
    nlmsg(NLMSG_DONE, NLM_F_MULTI, seq, portid, new Msg().u32(0).out()),
  ];
  if (!(flags & NLM_F_REQUEST)) return [];
  const family = req.length > 16 ? req[16] : AF_UNSPEC;
  if (protocol === NETLINK_ROUTE && (flags & NLM_F_DUMP) === NLM_F_DUMP) {
    if (type === RTM_GETLINK) return dump(IFACES.map(linkMsg), RTM_NEWLINK);
    if (type === RTM_GETADDR) {
      return dump(IFACES.flatMap((i) => i.addrs.filter((a) => family === AF_UNSPEC || a.family === family).map((a) => addrMsg(i, a))), RTM_NEWADDR);
    }
    if (type === RTM_GETROUTE) return dump(routeMsgs(family), RTM_NEWROUTE);
    return [err(EOPNOTSUPP)];
  }
  if (protocol === NETLINK_ROUTE && type === RTM_GETLINK && req.length >= 32) {
    // One link by index (ifinfomsg.ifi_index) or name (IFLA_IFNAME)
    const index = dv.getInt32(20, true);
    let name = '';
    for (let off = 32; off + 4 <= req.length;) {
      const len = dv.getUint16(off, true), at = dv.getUint16(off + 2, true);
      if (len < 4) break;
      if (at === IFLA_IFNAME) name = new TextDecoder().decode(req.subarray(off + 4, off + len)).replace(/\0.*$/s, '');
      off += (len + 3) & ~3;
    }
    const i = IFACES.find((x) => (index && x.index === index) || (name && x.name === name));
    return i ? [nlmsg(RTM_NEWLINK, 0, seq, portid, linkMsg(i))] : [err(19 /* ENODEV */)];
  }
  if (protocol === NETLINK_SOCK_DIAG && (flags & NLM_F_DUMP) === NLM_F_DUMP) return dump([], 20);
  // Everything else (changes, other families): not permitted in a browser tab
  return [err(EPERM)];
}

// ── The socket ──

let nextPortid = 1 << 20;
let nextIno = 1 << 24;

export class KNetlinkSocket implements OpenFile {
  readonly kind = 'socket' as const;
  readonly domain = AF_NETLINK;
  flags: number;
  readonly ino = nextIno++;
  portid = 0;
  private rx: Uint8Array[] = [];
  private waiters = new Set<() => void>();
  private ready = new Set<() => void>();
  private closed = false;
  private opts = new Map<string, number>();

  constructor(readonly type: number, readonly protocol: number, flags = 0) { this.flags = flags; }

  private notify() {
    for (const w of [...this.waiters]) w();
    for (const cb of [...this.ready]) { try { cb(); } catch { /* subscriber's problem */ } }
  }

  bind(addr: { port: number }): number {
    // nl_pid 0: the kernel picks one (programs read it back with getsockname)
    this.portid = addr.port || this.portid || nextPortid++;
    return 0;
  }
  connect(_addr: unknown): number { return 0; }

  async sendto(buf: Uint8Array, _flags: number, _to: unknown): Promise<number> {
    if (this.closed) return -EBADF;
    if (!this.portid) this.portid = nextPortid++;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    // A datagram can carry several requests
    for (let off = 0; off + 16 <= buf.length;) {
      const len = dv.getUint32(off, true);
      if (len < 16 || off + len > buf.length) break;
      this.rx.push(...answer(this.protocol, buf.subarray(off, off + len), this.portid));
      off += (len + 3) & ~3;
    }
    this.notify();
    return buf.length;
  }
  write(buf: Uint8Array): Promise<number> { return this.sendto(buf, 0, null); }

  async recvfrom(buf: Uint8Array, flags: number, signal?: AbortSignal): Promise<{ n: number; from: { family: number; address: string; port: number } } | number> {
    const timeout = this.opts.get(`${SOL_SOCKET}:${SO_RCVTIMEO}`) || 0;
    for (;;) {
      if (this.closed) return -EBADF;
      const d = this.rx[0];
      if (d) {
        if (!(flags & MSG_PEEK)) this.rx.shift();
        buf.set(d.subarray(0, Math.min(buf.length, d.length)));
        // MSG_TRUNC: the datagram's real size (iproute2 peeks with it to size its buffer)
        return { n: flags & MSG_TRUNC ? d.length : Math.min(buf.length, d.length), from: { family: AF_NETLINK, address: '', port: 0 } };
      }
      if ((this.flags & O_NONBLOCK) || (flags & MSG_DONTWAIT)) return -EAGAIN;
      if (signal?.aborted) return -EINTR;
      const t0 = Date.now();
      await new Promise<void>((resolve) => {
        let t: ReturnType<typeof setTimeout> | undefined;
        const done = () => { this.waiters.delete(done); if (t) clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); };
        this.waiters.add(done);
        if (timeout > 0) t = setTimeout(done, timeout);
        signal?.addEventListener('abort', done);
      });
      if (timeout && Date.now() - t0 >= timeout && !this.rx.length) return -EAGAIN;
    }
  }
  read(buf: Uint8Array, signal?: AbortSignal): Promise<number> { return this.recvfrom(buf, 0, signal).then((r) => (typeof r === 'number' ? r : r.n)); }

  poll(events: number): number {
    let r = POLLOUT;
    if (this.rx.length) r |= POLLIN;
    if (this.closed) r = POLLNVAL;
    return r & (events | POLLERR | POLLHUP | POLLNVAL);
  }
  onReady(cb: () => void) { this.ready.add(cb); return () => { this.ready.delete(cb); }; }
  getsockname() { return { family: AF_NETLINK, address: '', port: this.portid }; }
  getpeername(): { family: number; address: string; port: number } | number { return { family: AF_NETLINK, address: '', port: 0 }; }
  getsockopt(level: number, name: number): number {
    if (level === SOL_SOCKET && name === SO_TYPE) return this.type;
    if (level === SOL_SOCKET && name === SO_DOMAIN) return AF_NETLINK;
    if (level === SOL_SOCKET && name === SO_PROTOCOL) return this.protocol;
    if (level === SOL_SOCKET && name === SO_ERROR) return 0;
    return this.opts.get(`${level}:${name}`) ?? 0;
  }
  // SOL_NETLINK options (NETLINK_EXT_ACK, NETLINK_GET_STRICT_CHK, ...) are accepted
  setsockopt(level: number, name: number, value: number): number { this.opts.set(`${level}:${name}`, value); return 0; }
  shutdown(_how: number): number { return -ENOTCONN; }
  async ioctl(req: number, arg: Uint8Array): Promise<number> {
    if (req === FIONREAD && arg.length >= 4) {
      new DataView(arg.buffer, arg.byteOffset, 4).setInt32(0, this.rx[0]?.length ?? 0, true);
      return 0;
    }
    if (req === FIONBIO) return 0;
    return -ENOTTY;
  }
  async stat(): Promise<KStat> {
    return {
      dev: 8, ino: this.ino, mode: S_IFSOCK | 0o777, nlink: 1, uid: 1000, gid: 1000, rdev: 0, size: 0, blksize: 4096, blocks: 0,
      atimeMs: 0, mtimeMs: 0, ctimeMs: 0,
    };
  }
  async close(): Promise<void> { this.closed = true; this.rx = []; this.notify(); }
}

/** socket(AF_NETLINK, type, protocol): SOCK_RAW or SOCK_DGRAM. */
export function netlinkSocket(type: number, protocol: number, flags: number): KNetlinkSocket | number {
  const base = type & 0xf;
  if (base !== 3 /* SOCK_RAW */ && base !== 2 /* SOCK_DGRAM */) return -94; // ESOCKTNOSUPPORT
  if (protocol < 0 || protocol > 31) return -EINVAL;
  return new KNetlinkSocket(base, protocol, flags);
}
