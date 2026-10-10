// Built-in git (isomorphic-git, over HTTP) vs the full git package (Blink,
// git:// over the TCP relay): clone of axios, then log/status, in Chromium.
// Needs a bare clone at bench/.cache/gitsrv/axios.git:
//   git clone --bare https://github.com/axios/axios bench/.cache/gitsrv/axios.git
// ONLY=builtin|full picks one side; HANDOFF=1 clones with the built-in git and
// runs the full git (status, fsck, commit) on the result; ROUTE=1 installs the
// full git first and clones over http (the built-in's route), then status, log,
// fetch and fsck with the full git.
import { join, resolve } from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { Harness } from './lib/harness.mjs';
import { NetCache } from './lib/netcache.mjs';
import { startShiroServer, hostAddress, freePort } from './lib/servers.mjs';
import { startGitDaemon } from './lib/gitserver.mjs';
const gitd = await startGitDaemon({ cacheDir: 'bench/.cache', log: console.log });
const hostAddr = hostAddress();
// smart-HTTP git server (git http-backend), CORS-open, used as GIT_CORS_PROXY: /<host>/<repo>/...
const root = resolve('bench/.cache/gitsrv');
const hp = await freePort();
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-expose-headers': '*', 'cross-origin-resource-policy': 'cross-origin' };
const hs = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const u = new URL(req.url, 'http://x');
  // through the built-in's CORS proxy setting: /<host>/<repo>/...; the full git asks for /<repo>/... itself
  const path = /^\/[^/]+\/[^/]+\.git\//.test(u.pathname) ? u.pathname.replace(/^\/[^/]+/, '') : u.pathname;
  const cgi = spawn('git', ['http-backend'], { env: { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: path, REQUEST_METHOD: req.method, QUERY_STRING: u.search.slice(1), CONTENT_TYPE: req.headers['content-type'] || '', HTTP_CONTENT_ENCODING: req.headers['content-encoding'] || '', REMOTE_ADDR: '127.0.0.1', GIT_PROTOCOL: req.headers['git-protocol'] || '' } });
  req.pipe(cgi.stdin);
  let head = Buffer.alloc(0), sent = false;
  cgi.stdout.on('data', (d) => {
    if (sent) return res.write(d);
    head = Buffer.concat([head, d]);
    const i = head.indexOf('\r\n\r\n');
    if (i < 0) return;
    const hdrs = { ...cors }; let status = 200;
    for (const l of head.subarray(0, i).toString().split('\r\n')) { const [k, ...v] = l.split(':'); if (k.toLowerCase() === 'status') status = parseInt(v.join(':')); else hdrs[k] = v.join(':').trim(); }
    res.writeHead(status, hdrs); sent = true; res.write(head.subarray(i + 4));
  });
  cgi.stdout.on('end', () => res.end());
});
await new Promise((r) => hs.listen(hp, '0.0.0.0', r));
const server = await startShiroServer({ staticDir: join(process.cwd(), 'dist'), isolated: true, tcpPorts: [gitd.port, hp], allowCidrs: hostAddr ? [hostAddr + '/32'] : [] });
const h = new Harness({ mode: 'isolated', origin: server.origin, netcache: new NetCache('bench/.cache/net', {}), runs: 1, log: console.log, results: [] });
await h.launch(); await h.boot({ path: '/?ui=terminal' });
await h.context.route((u) => u.port === String(hp), (r) => r.continue());
const MiB = (n) => (n / 1048576).toFixed(1);
async function step(label, cmd) {
  await h.cdp.send('HeapProfiler.collectGarbage').catch(() => {});
  const rss0 = await h.rendererRss();
  let peak = 0, stop = false;
  const sampler = (async () => { while (!stop) { peak = Math.max(peak, (await h.rendererRss()) - rss0); await new Promise((r) => setTimeout(r, 250)); } })();
  const t0 = Date.now();
  const r = await h.eval(([c]) => window.__bench.shLimit(c, 1800000), [`${cmd}; echo "exit=$?"`]);
  const tCmd = Date.now() - t0;
  await h.eval(() => new Promise((res) => { const fs = window.__tabcomputer.fs; const tick = () => (fs.pendingWrites === 0 ? res() : setTimeout(tick, 20)); tick(); }));
  const tDur = Date.now() - t0;
  stop = true; await sampler;
  console.log(`${label}: ${(tCmd / 1000).toFixed(1)} s, durable at ${(tDur / 1000).toFixed(1)} s, peak RSS +${MiB(peak)} MiB; ${r.out.trim().split('\n').slice(-3).join(' | ')}`);
}
const PROXY = `GIT_CORS_PROXY=http://${hostAddr}:${hp}`;
if (process.env.HANDOFF) {
  await step('built-in clone (full history)', `cd /tmp && ${PROXY} git clone --depth 1000000 http://x/axios.git h2 2>&1 | tail -1`);
  await step('built-in clone --depth 1', `cd /tmp && ${PROXY} git clone http://x/axios.git h1 2>&1 | tail -1`);
  console.log((await h.eval(() => window.__bench.shLimit('pkg install git > /tmp/pkg.out 2>&1; echo exit=$?', 600000))).out.trim());
  for (const d of ['h2', 'h1']) {
    await step(`full git status on ${d}`, `cd /tmp/${d} && git status --short | wc -l; git status | head -2 | tr '\\n' ' '`);
    await step(`full git fsck on ${d}`, `cd /tmp/${d} && git fsck 2>&1 | tail -2 | tr '\\n' ' '; git log --oneline | wc -l; git rev-parse --is-shallow-repository`);
    await step(`full git commit on ${d}`, `cd /tmp/${d} && echo x >> README.md && git -c user.name=a -c user.email=a@b commit -qam t && git log --oneline -1`);
  }
}
if (process.env.ROUTE) {
  console.log((await h.eval(() => window.__bench.shLimit('pkg install git > /tmp/pkg.out 2>&1; echo exit=$?', 600000))).out.trim());
  await step('git clone http (routed, full git installed)', `cd /tmp && ${PROXY} git clone http://${hostAddr}:${hp}/axios.git r 2>&1 | head -c 600 | tr '\\n' ' '`);
  if (process.env.ROUTE === 'clone') { await h.close(); await server.close(); await gitd?.close(); hs.close(); process.exit(0); }
  await step('full git status (1st)', `cd /tmp/r && git status --short | wc -l`);
  await step('full git status (2nd)', `cd /tmp/r && git status --short | wc -l`);
  await step('full git log', `cd /tmp/r && git log --oneline | wc -l; git branch -r | wc -l; git tag | wc -l`);
  await step('full git fetch', `cd /tmp/r && git fetch origin 2>&1 | tail -2 | tr '\\n' ' '; git remote -v | head -1`);
  await step('full git fsck', `cd /tmp/r && git fsck 2>&1 | tail -2 | tr '\\n' ' '`);
}
const only = (process.env.ONLY || 'builtin,full').split(',');
if (only.includes('builtin')) {
  await step('built-in clone --depth 1', `cd /tmp && ${PROXY} git clone http://x/axios.git b1 2>&1 | tail -1`);
  await step('built-in clone (full history)', `cd /tmp && ${PROXY} git clone --depth 1000000 http://x/axios.git b2 2>&1 | tail -1`);
  await step('built-in git log (2222 commits)', `cd /tmp/b2 && git log --oneline | wc -l`);
  await step('built-in git status', `cd /tmp/b2 && git status --short | wc -l`);
  await step('rm -rf', 'rm -rf /tmp/b1 /tmp/b2');
}
if (only.includes('full')) {
  console.log((await h.eval(() => window.__bench.shLimit('pkg install git > /tmp/pkg.out 2>&1; echo exit=$?', 600000))).out.trim());
  await step('full git clone --depth 1', `cd /tmp && git clone -q --depth 1 git://${hostAddr}:${gitd.port}/axios.git f1`);
  await step('full git clone (full history)', `cd /tmp && git clone -q git://${hostAddr}:${gitd.port}/axios.git f2`);
  await step('full git log (2222 commits)', `cd /tmp/f2 && git log --oneline | wc -l`);
  await step('full git status', `cd /tmp/f2 && git status --short | wc -l`);
}
await h.close(); await server.close(); await gitd?.close(); hs.close(); process.exit(0);
