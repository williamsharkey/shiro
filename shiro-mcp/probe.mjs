// Shiro live-session probe: pairs with a `remote start` code over WebRTC (same
// protocol as shiro-mcp), installs instrumentation in the page, samples it every
// few seconds into a JSONL log, and serves ad-hoc evals on 127.0.0.1:7788.
//
//   cd shiro-mcp && npm install && node probe.mjs <code>   # run (keep in background)
//   curl -s localhost:7788/eval --data-binary @snippet.js
import ndc from 'node-datachannel';
import http from 'node:http';
import fs from 'node:fs';

const CODE = process.argv[2];
const SIGNAL = process.env.SHIRO_SIGNALING_URL || 'https://shiro.computer';
const LOG = process.env.PROBE_LOG || 'probe.jsonl';
const INTERVAL = +(process.env.PROBE_INTERVAL || 2000);
if (!CODE) { console.error('usage: node probe.mjs <remote-code>'); process.exit(1); }

const INSTALL = `(() => {
  if (window.__probe) return 'already installed';
  const P = window.__probe = { t0: Date.now(), longtasks: [], fs: {}, errors: [], lastSample: performance.now() };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        P.longtasks.push([Math.round(performance.timeOrigin + e.startTime), Math.round(e.duration)]);
        if (P.longtasks.length > 1000) P.longtasks.shift();
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch (e) { P.errors.push('no longtask observer: ' + e.message); }
  const proto = Object.getPrototypeOf(window.__shiro.fs);
  for (const m of ['readFile','writeFile','appendFile','readdir','stat','lstat','exists','unlink','mkdir','rename','rmdir','glob']) {
    const orig = proto[m];
    if (typeof orig !== 'function' || orig.__probed) continue;
    const wrapped = async function (...a) {
      const s = P.fs[m] ??= { n: 0, ms: 0, max: 0, bytes: 0, maxPath: '' };
      const t = performance.now();
      try {
        const r = await orig.apply(this, a);
        if (m === 'readFile' && r) s.bytes += r.length || 0;
        return r;
      } finally {
        const d = performance.now() - t;
        s.n++; s.ms += d;
        if (m === 'writeFile' && a[1]) s.bytes += a[1].length || 0;
        if (d > s.max) { s.max = d; s.maxPath = String(a[0]).slice(0, 120); }
      }
    };
    wrapped.__probed = true;
    proto[m] = wrapped;
  }
  // Console lines from Shiro's own tags, so nobody has to copy them out of DevTools
  P.console = [];
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      try {
        const text = args.map((x) => typeof x === 'string' ? x : (x && x.stack) || String(x)).join(' ');
        if (/\[(osc52|node|shiro|preload|init|wal|remote|fetch)\]|error|rejection/i.test(text) && !/\[(fs-debug|spawn-debug|xterm)\]/.test(text)) {
          P.console.push(level + ': ' + text.slice(0, 500));
          if (P.console.length > 500) P.console.shift();
        }
      } catch {}
      return orig(...args);
    };
  }
  // Every shell command with its duration; unfinished ones reveal hangs
  P.exec = [];
  const shellProto = Object.getPrototypeOf(window.__shiro.shell);
  if (!shellProto.__probeExec) {
    const origExecute = shellProto.execute;
    shellProto.execute = async function (line, ...rest) {
      const e = { t: Date.now(), line: String(line).slice(0, 400), ms: null };
      window.__probe.exec.push(e);
      if (window.__probe.exec.length > 1000) window.__probe.exec.shift();
      try { return await origExecute.call(this, line, ...rest); } finally { e.ms = Date.now() - e.t; }
    };
    shellProto.__probeExec = true;
  }
  addEventListener('error', (e) => P.errors.push('error: ' + String(e.message).slice(0, 400)));
  addEventListener('unhandledrejection', (e) => P.errors.push('rejection: ' + String(e.reason?.stack || e.reason?.message || e.reason).slice(0, 600)));
  return 'installed';
})()`;

const SAMPLE = `(async () => {
  const P = window.__probe;
  const m = performance.memory || {};
  const now = performance.now();
  const out = {
    heapMB: Math.round((m.usedJSHeapSize || 0) / 1048576),
    totalMB: Math.round((m.totalJSHeapSize || 0) / 1048576),
    limitMB: Math.round((m.jsHeapSizeLimit || 0) / 1048576),
    sinceLastMs: Math.round(now - P.lastSample),
    longtasks: P.longtasks.splice(0),
    errors: P.errors.splice(0),
    console: P.console.splice(0),
    running: P.exec.filter((e) => e.ms === null && Date.now() - e.t > 30000).map((e) => Math.round((Date.now() - e.t) / 1000) + 's ' + e.line.slice(0, 200)),
    slowDone: P.exec.filter((e) => e.ms !== null && e.ms > 10000 && !e.reported && (e.reported = true)).map((e) => e.ms + 'ms ' + e.line.slice(0, 200)),
    fs: Object.fromEntries(Object.entries(P.fs).map(([k, v]) => [k, [v.n, Math.round(v.ms), Math.round(v.max), v.bytes, v.maxPath]])),
    procs: window.__shiro.processTable.list().map((p) => p.pid + ':' + p.command.slice(0, 40) + ':' + p.status),
    scrollback: window.__shiro.terminal.term.buffer.normal.length,
    dom: document.getElementsByTagName('*').length,
  };
  P.lastSample = now;
  try { const e = await navigator.storage.estimate(); out.idbMB = Math.round(e.usage / 1048576); } catch {}
  return JSON.stringify(out);
})()`;

let dc = null, pending = new Map(), counter = 0, connected = false;

function log(obj) { fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n'); }

function request(payload, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (!dc || !connected) return reject(new Error('not connected'));
    const requestId = 'p' + (++counter);
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('timeout')); }, timeoutMs);
    pending.set(requestId, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    dc.sendMessage(JSON.stringify({ ...payload, requestId }));
  });
}
const evalJs = (code, timeoutMs) => request({ type: 'eval', code }, timeoutMs).then((r) => r.result);

async function connect() {
  const offerRes = await fetch(`${SIGNAL}/offer/${CODE}`);
  if (!offerRes.ok) throw new Error(`code not found (${offerRes.status})`);
  const { offer, candidates } = await offerRes.json();
  const pc = new ndc.PeerConnection('shiro-probe', { iceServers: ['stun:stun.l.google.com:19302'] });
  const ice = [];
  pc.onLocalCandidate((candidate, mid) => ice.push({ candidate, sdpMid: mid }));
  const opened = new Promise((resolve) => {
    pc.onDataChannel((channel) => {
      dc = channel;
      channel.onOpen(() => { connected = true; channel.sendMessage(JSON.stringify({ type: 'hello', name: 'shiro-probe' })); resolve(); });
      channel.onClosed(() => { connected = false; log({ event: 'disconnected' }); console.log('disconnected'); setTimeout(reconnectLoop, 3000); });
      channel.onMessage((msg) => {
        let data; try { data = JSON.parse(String(msg)); } catch { return; }
        if (data.type === 'console_error') { log({ event: 'console_error', message: data.message }); return; }
        const { requestId, ...rest } = data;
        const p = requestId && pending.get(requestId);
        if (!p) return;
        pending.delete(requestId);
        rest.type === 'error' ? p.reject(new Error(rest.error)) : p.resolve(rest);
      });
    });
  });
  pc.setRemoteDescription(offer.sdp, offer.type);
  for (const c of candidates) if (c.candidate) pc.addRemoteCandidate(c.candidate, c.sdpMid || '0');
  await new Promise((r) => { pc.onGatheringStateChange((s) => s === 'complete' && r()); setTimeout(r, 5000); });
  const desc = pc.localDescription();
  const ans = await fetch(`${SIGNAL}/answer/${CODE}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer: { type: desc.type, sdp: desc.sdp }, candidates: ice }) });
  if (!ans.ok) throw new Error('answer rejected');
  await Promise.race([opened, new Promise((_, rej) => setTimeout(() => rej(new Error('open timeout')), 30000))]);
  if (process.env.PROBE_LITE) {
    log({ event: 'connected', install: 'skipped (PROBE_LITE)' });
    console.log('connected (lite)');
    return;
  }
  // Never let a failing install block the connection; ad-hoc /eval still works
  const install = await evalJs(INSTALL, 15000).catch((e) => 'install failed: ' + e.message);
  log({ event: 'connected', install });
  console.log('connected + ' + install);
}

let reconnecting = false;
async function reconnectLoop() {
  if (reconnecting || connected) return;
  reconnecting = true;
  while (!connected) {
    try { await connect(); } catch (e) { await new Promise((r) => setTimeout(r, 4000)); }
  }
  reconnecting = false;
}

async function sampleLoop() {
  for (;;) {
    await new Promise((r) => setTimeout(r, INTERVAL));
    if (!connected) continue;
    const t = Date.now();
    if (process.env.PROBE_LITE) continue;
    try {
      const s = JSON.parse(await evalJs(SAMPLE, 120000));
      s.rttMs = Date.now() - t; // main-thread responsiveness
      log({ sample: s });
      const lt = s.longtasks.reduce((a, [, d]) => a + d, 0);
      console.log(`heap ${s.heapMB}/${s.limitMB}MB idb ${s.idbMB}MB rtt ${s.rttMs}ms longtask ${lt}ms procs ${s.procs.length}${s.errors.length ? ' ERR ' + s.errors.length : ''}${s.running.length ? ' RUNNING ' + s.running.length : ''}`);
      for (const line of s.console) console.log('  console ' + line.slice(0, 200));
    } catch (e) {
      log({ event: 'sample_failed', error: e.message, waitedMs: Date.now() - t });
    }
  }
}

http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    if (req.url === '/eval') res.end(String(await evalJs(body, 300000)));
    else if (req.url === '/exec') res.end(JSON.stringify(await request({ type: 'exec', command: body }, 300000)));
    else res.end(connected ? 'connected' : 'disconnected');
  } catch (e) { res.statusCode = 500; res.end('ERR ' + e.message); }
}).listen(+(process.env.PROBE_PORT || 7788), '127.0.0.1');

reconnectLoop();
sampleLoop();
