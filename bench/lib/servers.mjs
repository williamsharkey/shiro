// Processes the benchmark talks to: server.mjs (the app, plus the TCP relay)
// and a local TCP test server that the relay is allowed to reach.
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/**
 * An address of this machine that isn't loopback. Shiro's kernel keeps
 * 127/8 inside the page, so the relay path needs a real interface address.
 */
export function hostAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

/**
 * TCP test server:
 *   echo   — echoes bytes back
 *   source — on connect writes `size` bytes (first line from client: "<size>\n"), then closes
 *   sink   — reads "<size>\n", then counts bytes; replies "ok\n" once `size` arrived
 */
export async function startTcpTestServer(host = '0.0.0.0') {
  const servers = [];
  const sockets = new Set();
  const listen = (handler) => new Promise((resolve) => {
    const s = net.createServer((sock) => { sockets.add(sock); sock.on('close', () => sockets.delete(sock)); handler(sock); });
    s.listen(0, host, () => { servers.push(s); resolve(s.address().port); });
  });
  const lineThen = (sock, fn) => {
    let head = Buffer.alloc(0);
    const onData = (d) => {
      head = Buffer.concat([head, d]);
      const nl = head.indexOf(10);
      if (nl < 0) return;
      sock.off('data', onData);
      fn(Number(head.subarray(0, nl).toString()), head.subarray(nl + 1));
    };
    sock.on('data', onData);
  };
  const echo = await listen((sock) => { sock.on('error', () => {}); sock.pipe(sock); });
  const source = await listen((sock) => {
    sock.on('error', () => {});
    lineThen(sock, (size) => {
      const chunk = Buffer.alloc(64 * 1024, 120);
      let left = size;
      const pump = () => {
        while (left > 0) {
          const n = Math.min(left, chunk.length);
          left -= n;
          if (!sock.write(n === chunk.length ? chunk : chunk.subarray(0, n))) { sock.once('drain', pump); return; }
        }
        sock.end();
      };
      pump();
    });
  });
  const sink = await listen((sock) => {
    sock.on('error', () => {});
    lineThen(sock, (size, rest) => {
      let got = rest.length;
      const check = () => { if (got >= size) { sock.end('ok\n'); sock.removeAllListeners('data'); } };
      sock.on('data', (d) => { got += d.length; check(); });
      check();
    });
  });
  return {
    ports: { echo, source, sink },
    close: () => { for (const c of sockets) c.destroy(); return Promise.all(servers.map((s) => new Promise((r) => s.close(() => r())))); },
  };
}

/** server.mjs serving `staticDir`, with the relay on and allowed to reach `allowCidrs` on `tcpPorts`. */
export async function startShiroServer({ staticDir, isolated = true, tcpPorts = [], allowCidrs = [], log }) {
  const port = await freePort();
  const origin = `http://localhost:${port}`;
  const env = {
    ...process.env,
    PORT: String(port),
    STATIC_DIR: staticDir,
    SEED_DIR: join(staticDir, '..', '.bench-seeds'),
    TABCOMPUTER_ISOLATION: isolated ? '1' : '0',
    TABCOMPUTER_TCP_RELAY: '1',
    TABCOMPUTER_TCP_ORIGINS: origin,
    TABCOMPUTER_TCP_PORTS: ['80', '443', ...tcpPorts.map(String)].join(','),
    TABCOMPUTER_TCP_ALLOW_CIDRS: allowCidrs.join(','),
    // Measure the stack, not the abuse limits
    TABCOMPUTER_TCP_BYTES_PER_SEC: String(1024 ** 3),
    TABCOMPUTER_TCP_BYTE_BURST: String(1024 ** 3),
    TABCOMPUTER_TCP_CONNECTS_PER_MIN: '100000',
    TABCOMPUTER_TCP_MAX_CONNS_PER_IP: '512',
    // Debian package mirror (suites/debian.mjs): served from a disk cache after the first run
    TABCOMPUTER_DEBIAN_CACHE: process.env.TABCOMPUTER_DEBIAN_CACHE || join(ROOT, '.debian-build', 'mirror-cache'),
    TABCOMPUTER_DEBIAN_INDEX_TTL: process.env.TABCOMPUTER_DEBIAN_INDEX_TTL || String(30 * 24 * 3600),
  };
  const child = spawn(process.execPath, [join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  const onLine = (d) => { for (const l of d.toString().split('\n')) if (l.trim()) { lines.push(l); log?.(l); } };
  child.stdout.on('data', onLine);
  child.stderr.on('data', onLine);
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const r = await fetch(origin + '/', { method: 'HEAD' });
      if (r.status < 500) break;
    } catch { /* not up yet */ }
    if (child.exitCode != null) throw new Error('server.mjs exited: ' + lines.slice(-5).join('\n'));
    if (Date.now() > deadline) throw new Error('server.mjs did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    origin, port, lines,
    close: () => new Promise((r) => { child.once('exit', () => r()); child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 2000).unref(); }),
  };
}
