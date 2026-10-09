// Test harness for kernel-net.test.ts (runs in plain Node, outside vitest's transforms).
// Starts a TCP echo server, a "firehose" server that writes 1 MiB per connection,
// two relays built with server.mjs's createTcpRelay, and server.mjs itself with
// TABCOMPUTER_TCP_RELAY=1. Prints one JSON line with the ports, then runs until killed.
import { createServer } from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const serverPath = fileURLToPath(new URL('../../../../server.mjs', import.meta.url));
const { createTcpRelay } = await import(serverPath);
const ORIGIN = 'http://shiro.test';

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

const echoPort = await listen(net.createServer((s) => { s.on('error', () => {}); s.pipe(s); }));
const firehosePort = await listen(net.createServer((s) => {
  s.on('error', () => {});
  s.end(Buffer.alloc(1024 * 1024, 0x61));
}));

const logs = [];
const log = (line) => logs.push(line);

function mount(config, extra) {
  const relay = createTcpRelay({ allowedOrigins: [ORIGIN], ...config }, { log, ...extra });
  const srv = createServer((req, res) => {
    if (new URL(req.url, 'http://x').pathname === '/tcp/token') return relay.handleToken(req, res);
    if (req.url === '/logs') { res.end(JSON.stringify(logs)); return; }
    res.writeHead(404).end();
  });
  srv.on('upgrade', (req, socket, head) => relay.handleUpgrade(req, socket, head));
  return listen(srv);
}

// A: loopback explicitly allowed (so the echo server is reachable), small limits
const relayA = await mount({
  ports: [echoPort, firehosePort],
  allowCidrs: ['127.0.0.1/32'],
  maxConnsPerIp: 3,
  maxBytesPerConn: 256 * 1024,
  connectsPerMinute: 1000,
});
// B: default egress policy; a fake resolver for DNS-rebinding style names
const fakeDns = {
  'rebind.test': [{ address: '10.1.2.3', family: 4 }],
  'metadata.test': [{ address: '169.254.169.254', family: 4 }],
  'v6local.test': [{ address: 'fd00::1', family: 6 }],
  'mapped.test': [{ address: '::ffff:127.0.0.1', family: 6 }],
};
const relayB = await mount({ ports: [echoPort, 80, 443] }, {
  lookup: async (host) => {
    if (host === 'localhost') return [{ address: '127.0.0.1', family: 4 }];
    if (fakeDns[host]) return fakeDns[host];
    const e = new Error('nx'); e.code = 'ENOTFOUND'; throw e;
  },
});
// C: tight connect rate
const relayC = await mount({ ports: [echoPort], allowCidrs: ['127.0.0.1/32'], connectsPerMinute: 2 });

// D: requires a GitHub sign-in (TABCOMPUTER_TCP_REQUIRE_SIGNIN); the verifier accepts the token "good-token"
const relayD = await mount({ ports: [echoPort], allowCidrs: ['127.0.0.1/32'], requireSignin: true }, {
  verifySignin: async (t) => (t === 'good-token' ? 'octocat' : null),
});

// E: tokens not bound to the client IP (TABCOMPUTER_TCP_TOKEN_BIND_IP=0, tabcomputer.com)
const relayE = await mount({ ports: [echoPort], allowCidrs: ['127.0.0.1/32'], tokenBindIp: false });

// F: through an HTTP CONNECT proxy (TABCOMPUTER_TCP_UPSTREAM_PROXY) that dials the echo server
const proxyLog = [];
const proxyPort = await listen(net.createServer((c) => {
  c.on('error', () => {});
  c.once('data', (d) => {
    const line = d.toString('latin1').split('\r\n')[0];
    proxyLog.push(line);
    if (!line.startsWith(`CONNECT public.test:${echoPort} `)) { c.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const up = net.connect(echoPort, '127.0.0.1', () => { c.write('HTTP/1.1 200 Connection Established\r\n\r\n'); c.pipe(up); up.pipe(c); });
    up.on('error', () => c.destroy());
  });
}));
const relayF = await mount({ ports: [echoPort], upstreamProxy: `http://127.0.0.1:${proxyPort}` }, {
  lookup: async (host) => {
    if (host === 'public.test' || host === 'denied.test') return [{ address: '93.184.216.34', family: 4 }];
    if (host === 'rebind.test') return [{ address: '10.1.2.3', family: 4 }];
    const e = new Error('nx'); e.code = 'ENOTFOUND'; throw e;
  },
});
createServer((req, res) => res.end(JSON.stringify(proxyLog))).listen(0, '127.0.0.1', function () { globalThis.proxyLogPort = this.address().port; });
await new Promise((r) => setTimeout(r, 50));

// server.mjs as deployed, configured only through the environment
const mainPort = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const child = spawn(process.execPath, [serverPath], {
  env: {
    ...process.env,
    PORT: String(mainPort),
    STATIC_DIR: mkdtempSync(join(tmpdir(), 'shiro-static-')),
    SEED_DIR: mkdtempSync(join(tmpdir(), 'shiro-seeds-')),
    TABCOMPUTER_TCP_RELAY: '1',
    TABCOMPUTER_TCP_ORIGINS: ORIGIN,
    TABCOMPUTER_TCP_PORTS: String(echoPort),
    TABCOMPUTER_TCP_ALLOW_CIDRS: '127.0.0.1/32',
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  let out = '';
  child.stdout.on('data', (d) => { out += d; if (out.includes('[tcp] relay enabled')) resolve(); });
  child.once('exit', (code) => reject(new Error(`server.mjs exited ${code}`)));
});
child.stdout.resume();
const stop = () => { child.kill(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdin.on('end', stop); // parent went away
process.stdin.resume();

console.log(JSON.stringify({ echoPort, firehosePort, relayA, relayB, relayC, relayD, relayE, relayF, proxyLogPort: globalThis.proxyLogPort, mainPort, origin: ORIGIN }));
