// Network: kernel sockets through server.mjs's WebSocket-to-TCP relay to a
// local TCP test server (bench/lib/servers.mjs) on this machine's non-loopback
// address (127/8 never leaves the page). Bandwidth limits are raised for the
// bench server, so these measure the stack, not the relay's abuse limits.
export const name = 'net';

export async function run(h) {
  const { host, ports } = h.testServer;
  if (!host) { h.skip('net.suite', '', 'no non-loopback IPv4 address for the test server'); return; }
  const n = h.runs;
  const env = { host, ports, n, quick: h.quick };

  // Helpers live in the page for the whole suite
  await h.eval(() => {
    const net = window.__shiroNet;
    const B = window.__bench;
    B.tcpConnect = async (host, port) => {
      const s = net.socket(2, 1);
      if (typeof s === 'number') throw new Error('socket ' + s);
      const r = await s.connect({ family: 2, address: host, port });
      if (r < 0) throw new Error('connect ' + r);
      return s;
    };
    B.writeAll = async (s, buf) => {
      let o = 0;
      while (o < buf.length) { const w = await s.write(buf.subarray(o)); if (w <= 0) throw new Error('write ' + w); o += w; }
    };
  });

  await h.try('net.relay_connect.first', 'ms', async () => {
    const ms = await h.eval(async ({ host, ports }) => {
      const t0 = performance.now();
      const s = await window.__bench.tcpConnect(host, ports.echo);
      const ms = performance.now() - t0;
      await s.close();
      return ms;
    }, env);
    h.sample('net.relay_connect.first', [ms], 'ms', { notes: 'first connect of the page: token POST + WebSocket + TCP connect (one sample)' });
  });

  await h.try('net.relay_connect', 'ms', async () => {
    const r = await h.eval(async ({ host, ports, n }) => {
      const out = [];
      for (let i = 0; i < n * 4; i++) {
        const t0 = performance.now();
        const s = await window.__bench.tcpConnect(host, ports.echo);
        out.push(performance.now() - t0);
        await s.close();
      }
      return out;
    }, env);
    h.sample('net.relay_connect', r, 'ms', { notes: 'socket() + blocking connect() to the test server via the relay (token cached)' });
  });

  await h.try('net.echo_rtt', 'ms', async () => {
    const r = await h.eval(async ({ host, ports, n }) => {
      const s = await window.__bench.tcpConnect(host, ports.echo);
      const one = new Uint8Array([7]), buf = new Uint8Array(16), out = [];
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        for (let j = 0; j < 100; j++) {
          await window.__bench.writeAll(s, one);
          const got = await s.read(buf);
          if (got !== 1) throw new Error('read ' + got);
        }
        out.push((performance.now() - t0) / 100);
      }
      await s.close();
      return out;
    }, env);
    h.sample('net.echo_rtt', r, 'ms', { notes: '1-byte write → echo → read through the relay, mean of 100' });
  });

  const mb = h.quick ? 16 : 64;
  await h.try('net.tcp_download', 'MB/s', async () => {
    const r = await h.eval(async ({ host, ports, n, mb }) => {
      const out = [];
      for (let i = 0; i < n; i++) {
        const s = await window.__bench.tcpConnect(host, ports.source);
        const size = mb * 1024 * 1024;
        const t0 = performance.now();
        await window.__bench.writeAll(s, new TextEncoder().encode(size + '\n'));
        const buf = new Uint8Array(256 * 1024);
        let total = 0;
        for (;;) { const k = await s.read(buf); if (k <= 0) break; total += k; }
        if (total !== size) throw new Error(`got ${total} of ${size}`);
        out.push(size / 1e6 / ((performance.now() - t0) / 1000));
        await s.close();
      }
      return out;
    }, { ...env, mb });
    h.sample('net.tcp_download', r, 'MB/s', { notes: `${mb} MiB server → page (kernel socket reads of 256 KiB)` });
  });

  await h.try('net.tcp_upload', 'MB/s', async () => {
    const r = await h.eval(async ({ host, ports, n, mb }) => {
      const out = [];
      const chunk = new Uint8Array(64 * 1024).fill(120);
      for (let i = 0; i < n; i++) {
        const s = await window.__bench.tcpConnect(host, ports.sink);
        const size = mb * 1024 * 1024;
        const t0 = performance.now();
        await window.__bench.writeAll(s, new TextEncoder().encode(size + '\n'));
        for (let o = 0; o < size; o += chunk.length) await window.__bench.writeAll(s, chunk);
        const buf = new Uint8Array(16);
        const k = await s.read(buf);
        if (k <= 0) throw new Error('no ack');
        out.push(size / 1e6 / ((performance.now() - t0) / 1000));
        await s.close();
      }
      return out;
    }, { ...env, mb });
    h.sample('net.tcp_upload', r, 'MB/s', { notes: `${mb} MiB page → server in 64 KiB writes, until the server acks` });
  });

  await h.try('net.dns_lookup', 'ms', async () => {
    const r = await h.eval(async ({ n }) => {
      const out = [];
      for (let i = 0; i < n * 2; i++) {
        const t0 = performance.now();
        const a = await window.__shiroNet.resolve('example.com');
        if (typeof a === 'number') throw new Error('resolve ' + a);
        out.push(performance.now() - t0);
      }
      return out;
    }, env);
    h.sample('net.dns_lookup', r, 'ms', { notes: 'netStack.resolve("example.com") via the relay\'s resolve op (server-side resolver; /etc/hosts here)' });
  });
}
