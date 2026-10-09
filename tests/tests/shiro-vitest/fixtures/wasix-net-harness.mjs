// Test harness for kernel-wasix.test.ts's network tests (plain Node, outside
// vitest's transforms): an HTTP and an HTTPS server (self-signed, made with
// the openssl CLI when it exists) on 127.0.0.1, and a relay from server.mjs's
// createTcpRelay that may reach them, with a resolver mapping web.test to
// 127.0.0.1. Prints one JSON line with the ports, then runs until killed.
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const serverPath = fileURLToPath(new URL('../../../../server.mjs', import.meta.url));
const { createTcpRelay } = await import(serverPath);
const ORIGIN = 'http://shiro.test';
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

const handler = (scheme) => (req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/plain', 'x-scheme': scheme });
    res.end(`hello over ${scheme}: ${req.method} ${req.url}${body ? ` body=${body}` : ''}\n`);
  });
};

const httpPort = await listen(createServer(handler('http')));
let httpsPort = 0;
let certFile = '';
try {
  const dir = mkdtempSync(join(tmpdir(), 'shiro-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=web.test',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  certFile = join(dir, 'cert.pem');
  httpsPort = await listen(createHttpsServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, handler('https')));
} catch { /* no openssl: HTTPS tests skip */ }

const relay = createTcpRelay({
  allowedOrigins: [ORIGIN], ports: [httpPort, httpsPort].filter(Boolean), allowCidrs: ['127.0.0.1/32'], connectsPerMinute: 1000,
}, {
  log: () => {},
  lookup: async (host) => {
    if (host === 'web.test') return [{ address: '127.0.0.1', family: 4 }];
    const e = new Error('nx'); e.code = 'ENOTFOUND'; throw e;
  },
});
const srv = createServer((req, res) => {
  if (new URL(req.url, 'http://x').pathname === '/tcp/token') return relay.handleToken(req, res);
  res.writeHead(404).end();
});
srv.on('upgrade', (req, socket, head) => relay.handleUpgrade(req, socket, head));
const relayPort = await listen(srv);
console.log(JSON.stringify({ httpPort, httpsPort, relayPort, origin: ORIGIN, certFile }));
