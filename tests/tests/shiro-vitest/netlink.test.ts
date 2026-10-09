/**
 * AF_NETLINK (src/kernel/netlink.ts) through the kernel's socket syscalls:
 * the rtnetlink dumps `ip`, `ss` and getifaddrs() read, and netfilter's EPERM.
 */
import { describe, it, expect } from 'vitest';
import * as A from '@shiro/kernel/abi';
import { Kernel } from '@shiro/kernel/kernel';
import { installNet, NetStack, encodeSockaddr, decodeSockaddr } from '@shiro/kernel/net';
import { AF_NETLINK } from '@shiro/kernel/netlink';

const NLMSG_ERROR = 2, NLMSG_DONE = 3, NLM_F_REQUEST = 1, NLM_F_DUMP = 0x300;
const RTM_NEWLINK = 16, RTM_GETLINK = 18, RTM_NEWADDR = 20, RTM_GETADDR = 22, RTM_NEWROUTE = 24, RTM_GETROUTE = 26;
const SOCK_RAW = 3, NETLINK_ROUTE = 0, NETLINK_NETFILTER = 12;

function setup() {
  const kernel = new Kernel({ registerWithProcessTable: false });
  const stack = new NetStack();
  stack.configure({ relayUrl: null, tokenUrl: null, dohUrl: null, portHost: null });
  installNet(kernel, stack);
  const proc = kernel.spawn({ path: 'nl', fds: {}, run: () => new Promise<number>(() => {}) });
  const data = new Uint8Array(65536);
  const sys = (nr: number, args: number[]) => kernel.syscall(proc, nr, args, data);
  return { data, sys };
}

/** nlmsghdr + a family byte padded to the request's struct size. */
function request(type: number, flags: number, seq: number, body = new Uint8Array(16)): Uint8Array {
  const b = new Uint8Array(16 + body.length);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, b.length, true); dv.setUint16(4, type, true); dv.setUint16(6, flags, true); dv.setUint32(8, seq, true);
  b.set(body, 16);
  return b;
}

/** Split a datagram into messages: { type, seq, pid, attrs by type (first occurrence) }. */
function parse(buf: Uint8Array, bodyLen: number) {
  const out: { type: number; seq: number; pid: number; body: Uint8Array; attrs: Map<number, Uint8Array> }[] = [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let off = 0; off + 16 <= buf.length;) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint16(off + 4, true);
    const attrs = new Map<number, Uint8Array>();
    for (let a = off + 16 + bodyLen; a + 4 <= off + len;) {
      const al = dv.getUint16(a, true);
      if (al < 4) break;
      if (!attrs.has(dv.getUint16(a + 2, true))) attrs.set(dv.getUint16(a + 2, true), buf.subarray(a + 4, a + al));
      a += (al + 3) & ~3;
    }
    out.push({ type, seq: dv.getUint32(off + 8, true), pid: dv.getUint32(off + 12, true), body: buf.subarray(off + 16, off + len), attrs });
    off += (len + 3) & ~3;
  }
  return out;
}

const str = (b?: Uint8Array) => (b ? new TextDecoder().decode(b).replace(/\0.*$/s, '') : '');

describe('netlink sockets', () => {
  it('rtnetlink dumps list lo and eth0, their addresses and the routes', async () => {
    const { data, sys } = setup();
    const fd = await sys(A.SYS_socket, [AF_NETLINK, SOCK_RAW | A.SOCK_CLOEXEC, NETLINK_ROUTE]);
    expect(fd).toBeGreaterThanOrEqual(0);
    data.set(encodeSockaddr({ family: AF_NETLINK, address: '', port: 0 }));
    expect(await sys(A.SYS_bind, [fd, 12])).toBe(0);
    const nameLen = await sys(A.SYS_getsockname, [fd]);
    expect(nameLen).toBe(12);
    const me = decodeSockaddr(data.slice(0, 12));
    expect(typeof me !== 'number' && me.family === AF_NETLINK && me.port > 0).toBe(true);
    const pid = (me as { port: number }).port;

    // Read datagrams until NLMSG_DONE
    const dump = async (req: Uint8Array, bodyLen: number) => {
      data.set(req);
      expect(await sys(A.SYS_sendto, [fd, req.length, 0, 0])).toBe(req.length);
      const msgs: ReturnType<typeof parse> = [];
      for (let i = 0; i < 10; i++) {
        const n = await sys(A.SYS_recvfrom, [fd, 32768, 0]);
        expect(n).toBeGreaterThan(0);
        const got = parse(data.slice(0, n), bodyLen);
        msgs.push(...got);
        if (got.some((m) => m.type === NLMSG_DONE)) break;
      }
      expect(msgs.at(-1)!.type).toBe(NLMSG_DONE);
      for (const m of msgs) { expect(m.seq).toBe(new DataView(req.buffer).getUint32(8, true)); expect(m.pid).toBe(pid); }
      return msgs.slice(0, -1);
    };

    const links = await dump(request(RTM_GETLINK, NLM_F_REQUEST | NLM_F_DUMP, 1), 16);
    expect(links.every((m) => m.type === RTM_NEWLINK)).toBe(true);
    expect(links.map((m) => str(m.attrs.get(3)))).toEqual(['lo', 'eth0']);
    expect(new DataView(links[1].attrs.get(4)!.buffer, links[1].attrs.get(4)!.byteOffset).getUint32(0, true)).toBe(1500);

    const v4 = new Uint8Array(8); v4[0] = A.AF_INET;
    const addrs = await dump(request(RTM_GETADDR, NLM_F_REQUEST | NLM_F_DUMP, 2, v4), 8);
    expect(addrs.every((m) => m.type === RTM_NEWADDR && m.body[0] === A.AF_INET)).toBe(true);
    expect(addrs.map((m) => `${[...m.attrs.get(1)!].join('.')}/${m.body[1]}`)).toEqual(['127.0.0.1/8', '10.0.2.15/24']);

    const routes = await dump(request(RTM_GETROUTE, NLM_F_REQUEST | NLM_F_DUMP, 3, v4.slice(0, 12)), 12);
    expect(routes.every((m) => m.type === RTM_NEWROUTE)).toBe(true);
    expect(routes.map((m) => (m.attrs.get(5) ? `default via ${[...m.attrs.get(5)!].join('.')}` : `${[...m.attrs.get(1)!].join('.')}/${m.body[1]}`)))
      .toEqual(['default via 10.0.2.2', '10.0.2.0/24']);
  });

  it('changes and netfilter are EPERM; MSG_TRUNC peeks report the size', async () => {
    const { data, sys } = setup();
    const fd = await sys(A.SYS_socket, [AF_NETLINK, SOCK_RAW, NETLINK_NETFILTER]);
    expect(fd).toBeGreaterThanOrEqual(0);
    const req = request(0x0a00, NLM_F_REQUEST | 4, 7); // nft: NFNL_SUBSYS_NFTABLES batch, with ACK
    data.set(req);
    expect(await sys(A.SYS_sendto, [fd, req.length, 0, 0])).toBe(req.length);
    const peek = await sys(A.SYS_recvfrom, [fd, 0, A.MSG_PEEK | A.MSG_TRUNC]);
    expect(peek).toBe(36); // nlmsghdr + error + the request's header
    const n = await sys(A.SYS_recvfrom, [fd, 4096, 0]);
    const [m] = parse(data.slice(0, n), 0);
    expect(m.type).toBe(NLMSG_ERROR);
    expect(new DataView(m.body.buffer, m.body.byteOffset).getInt32(0, true)).toBe(-A.EPERM);
    // Nothing more queued: nonblocking read is EAGAIN
    expect(await sys(A.SYS_recvfrom, [fd, 4096, A.MSG_DONTWAIT])).toBe(-A.EAGAIN);
  });

  it('other socket families stay unsupported', async () => {
    const { sys } = setup();
    expect(await sys(A.SYS_socket, [17 /* AF_PACKET */, SOCK_RAW, 0])).toBe(-A.EAFNOSUPPORT);
    expect(await sys(A.SYS_socket, [AF_NETLINK, A.SOCK_STREAM, 0])).toBe(-94);
  });
});
