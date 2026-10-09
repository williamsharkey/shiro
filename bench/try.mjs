// Debug helper (not committed): boot Shiro and run shell commands / JS.
import { Harness } from './lib/harness.mjs';
import { NetCache } from './lib/netcache.mjs';
import { startShiroServer, startTcpTestServer, hostAddress } from './lib/servers.mjs';
import { join } from 'node:path';
import { prepareFixtures } from './lib/fixtures.mjs';
prepareFixtures({ cacheDir: 'bench/.cache', publishDir: 'dist/__bench' });
const mode = process.env.MODE || 'isolated';
const tcp = await startTcpTestServer();
const server = await startShiroServer({ staticDir: join(process.cwd(), 'dist'), isolated: mode === 'isolated', tcpPorts: [...Object.values(tcp.ports), ...(process.env.EXTRA_PORTS || '').split(',').filter(Boolean)], allowCidrs: [hostAddress() + '/32'], log: process.env.SERVER_LOG ? (l) => console.log('[server]', l) : null });
const h = new Harness({ mode, origin: server.origin, netcache: new NetCache('bench/.cache/net', { log: console.log }), runs: 1, log: console.log, results: [] });
await h.launch();
await h.boot({ waitSettled: !!process.env.SETTLE });
await h.eval(async () => { await window.__bench.fetchInto('/__bench/kbench.wasm', '/home/user/b/kbench.wasm'); await window.__bench.fetchInto('/__bench/cat.wasm', '/home/user/b/cat.wasm'); for (const n of ['hello-musl','hello-go']) await window.__bench.fetchInto('/__bench/'+n, '/home/user/x/'+n); });
globalThis.tcp = tcp;
for (const c of process.argv.slice(2)) {
  if (c.startsWith('js:')) console.log(c, '→', JSON.stringify(await h.eval(new Function('return (async () => {' + c.slice(3) + '})()'))));
  else if (c === 'workers') console.log('workers →', h.page.workers().length);
  else console.log(c, '→', JSON.stringify(await h.sh(c)));
}
await h.close(); await server.close(); await tcp.close();
